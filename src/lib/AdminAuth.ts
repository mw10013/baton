import { redirect } from "@tanstack/react-router";
import { useSession } from "@tanstack/react-start/server";
import { Clock, Config, Context, Effect, Layer, Redacted } from "effect";

import { ResponseError } from "@/lib/Shopify";

const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  return diff === 0;
};

const SESSION_MAX_AGE_SECONDS = 60 * 60;
const SLIDE_THROTTLE_MS = 60_000;

/**
 * Password-based session auth for the /admin area.
 *
 * Two passwords (`ADMIN_PASSWORD`, `ADMIN_PASSWORD1`) are accepted as valid
 * credentials. This enables zero-downtime rotation: change one env var, the
 * other keeps working so operators are never locked out mid-rotation. Both
 * compares always run (no short-circuit) to avoid leaking which slot matched
 * via timing.
 *
 * The session cookie stores `pwVersion` — `sha256(p|p1).slice(0,16)` — and
 * `lastSeen`, not the passwords themselves. Rotating either env var changes
 * `pwVersion`, which `requireSession` checks on every guarded request and uses
 * to force re-login for sessions issued under the old credential pair.
 *
 * Sessions use a sliding 1h idle window (no absolute cap): `requireSession`
 * re-issues the cookie on activity, so 1h of inactivity expires the session.
 */
export class AdminAuth extends Context.Service<
  AdminAuth,
  {
    readonly requireSession: () => Effect.Effect<void, ResponseError>;
    readonly attemptLogin: (
      submitted: string,
    ) => Effect.Effect<{ readonly ok: false } | { readonly ok: true }>;
    readonly logout: () => Effect.Effect<void>;
  }
>()("AdminAuth") {
  static readonly layer: Layer.Layer<AdminAuth, Config.ConfigError> =
    Layer.effect(
      AdminAuth,
      Effect.gen(function* () {
        const authSecret = yield* Config.nonEmptyString(
          "ADMIN_AUTH_SECRET",
        ).pipe(Config.map(Redacted.make));
        const password = yield* Config.nonEmptyString("ADMIN_PASSWORD").pipe(
          Config.map(Redacted.make),
        );
        const password1 = yield* Config.nonEmptyString("ADMIN_PASSWORD1").pipe(
          Config.map(Redacted.make),
        );

        const getSession = Effect.promise(() =>
          // oxlint-disable-next-line react-hooks/rules-of-hooks -- useSession is a TanStack server helper, not a React hook
          useSession<{ pwVersion: string; lastSeen: number }>({
            name: "admin-session",
            password: Redacted.value(authSecret),
            maxAge: SESSION_MAX_AGE_SECONDS,
            // path: "/" so the cookie is sent on TanStack Start's /_serverFn/... requests
            // (e.g. /admin's beforeLoad via authenticateAdminRoute), not just /admin/*.
            cookie: {
              httpOnly: true,
              secure: true,
              sameSite: "strict",
              path: "/",
            },
          }),
        );

        const computePwVersion = Effect.gen(function* () {
          const digest = yield* Effect.promise(() =>
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(
                `${Redacted.value(password)}|${Redacted.value(password1)}`,
              ),
            ),
          );
          return [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
            .slice(0, 16);
        });

        /**
         * Guard for the /admin area, run on every guarded request via
         * `admin.tsx`'s `beforeLoad` and `adminServerFnMiddleware`.
         *
         * - Forces re-login (redirect to /admin/login) when no valid session is
         *   present or when the session's `pwVersion` no longer matches the
         *   current password pair, i.e. a password was rotated.
         * - Slides the 1h idle window forward by re-issuing the session cookie
         *   on activity, throttled to at most once per minute. After 1h of
         *   inactivity the cookie expires and the next request is redirected.
         */
        const requireSession = Effect.fn("AdminAuth.requireSession")(
          function* () {
            const session = yield* getSession;
            const expected = yield* computePwVersion;
            if (session.data.pwVersion !== expected)
              yield* new ResponseError({
                response: redirect({ href: "/admin/login" }),
              });
            const now = yield* Clock.currentTimeMillis;
            if (now - (session.data.lastSeen ?? 0) > SLIDE_THROTTLE_MS)
              yield* Effect.promise(() =>
                session.update({ pwVersion: expected, lastSeen: now }),
              );
          },
        );

        const attemptLogin = Effect.fn("AdminAuth.attemptLogin")(function* (
          submitted: string,
        ) {
          const matchA = constantTimeEqual(submitted, Redacted.value(password));
          const matchB = constantTimeEqual(
            submitted,
            Redacted.value(password1),
          );
          if (!matchA && !matchB) return { ok: false } as const;
          const session = yield* getSession;
          const pwVersion = yield* computePwVersion;
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.promise(() =>
            session.update({ pwVersion, lastSeen: now }),
          );
          return { ok: true } as const;
        });

        const logout = Effect.fn("AdminAuth.logout")(function* () {
          const session = yield* getSession;
          yield* Effect.promise(() => session.clear());
        });

        return AdminAuth.of({ requireSession, attemptLogin, logout });
      }),
    );
}
