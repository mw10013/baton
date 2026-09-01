import { betterAuth } from "better-auth";
import { admin, magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import * as Domain from "@/lib/Domain";
import { Email } from "@/lib/Email";
import { KV } from "@/lib/KV";
import { makeRunPromise } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const magicLinkKvKey = (email: string) => `demo:magicLink:${email}`;

const MAGIC_LINK_EXPIRES_IN_SECONDS = 300;

const tryAuth = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new AuthError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

/**
 * `Domain.User`/`Domain.AuthSession` decode D1 rows (ISO text dates, 0/1
 * booleans), but better-auth's `getSession` returns the decoded side already —
 * its adapter coerced the rows. `Schema.toType(S)` derives a validator whose
 * `Encoded === Type === S["Type"]`, enforcing that better-auth's output
 * actually matches the branded domain shape without re-running the D1
 * transforms.
 */
const SessionContextFromAuthOutput = Schema.toType(
  Schema.Struct({ user: Domain.User, session: Domain.AuthSession }),
);

const make = Effect.gen(function* () {
  const runPromise = yield* makeRunPromise<KV | Repository | Email>();
  const env = yield* CloudflareEnv;
  const config = yield* Config.all({
    baseURL: Config.nonEmptyString("BETTER_AUTH_URL"),
    secret: Config.redacted("BETTER_AUTH_SECRET"),
    demoMode: Config.boolean("DEMO_MODE").pipe(Config.withDefault(false)),
  });

  /**
   * `database` is the raw `env.D1` binding, NOT the per-request `d1Session`:
   * `D1DatabaseSession` lacks `exec`, so better-auth's D1 duck-typing would
   * not recognize it — and sessionless queries route to the primary, which is
   * exactly what auth wants (a stale-replica session lookup right after
   * sign-in would be a bug, not a latency win).
   */
  const auth = betterAuth({
    baseURL: config.baseURL,
    secret: Redacted.value(config.secret),
    database: env.D1,
    telemetry: { enabled: false },
    // Better-auth's default rate-limit storage is in-memory — meaningless
    // across Workers isolates. The /login server fn rate-limits sends via the
    // LOGIN_LIMITER binding instead.
    rateLimit: { enabled: false },
    user: { modelName: "User" },
    session: { modelName: "Session" },
    account: { modelName: "Account" },
    verification: { modelName: "Verification" },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    databaseHooks: {
      user: {
        create: {
          /**
           * The invite-only gate's authoritative backstop: sign-up is only
           * ever a side effect of a first magic-link verify, and a person with
           * no `Member` row has no business getting a `User` row — the /login
           * server fn already refuses to send them a link, but this hook
           * covers every path (returning `false` aborts the create,
           * concepts/database.mdx). Reads through `D1Primary` inside
           * `listMemberShops`, so a just-added member is never blocked by
           * replica lag.
           */
          before: (user) =>
            runPromise(
              Effect.gen(function* () {
                const repository = yield* Repository;
                const email = yield* Schema.decodeUnknownEffect(Domain.Email)(
                  user.email,
                );
                const shops = yield* repository.listMemberShops(email);
                if (shops.length > 0) return { data: user };
                yield* Effect.logWarning(
                  `Auth.userCreate: email=${email}: no membership, sign-up blocked`,
                ).pipe(Effect.annotateLogs({ email }));
                return false;
              }),
            ),
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
        storeToken: "hashed",
        /**
         * Demo mode: the magic-link URL is cached in KV (TTL aligned with the
         * token's `expiresIn`) and the login server fn reads it back for the
         * UI — the KV copy is the full clickable URL, an accepted demo
         * tradeoff bounded by the TTL. Real mode sends via Email Sending and
         * deliberately skips the KV write so the clickable URL is never
         * persisted. Better-auth awaits this callback, so an `EmailError`
         * rejects `signInMagicLink` loudly instead of silently claiming
         * "check your email" — which is also why `advanced.backgroundTasks`
         * stays off: deferring the send past the response would let the
         * demo-mode KV read-back race the write.
         */
        sendMagicLink: ({ email, url }) =>
          runPromise(
            Effect.gen(function* () {
              if (config.demoMode) {
                const kv = yield* KV;
                yield* kv.put(magicLinkKvKey(email), url, {
                  expirationTtl: MAGIC_LINK_EXPIRES_IN_SECONDS,
                });
                yield* Effect.logInfo(
                  `Auth.sendMagicLink: email=${email}: demo mode, url cached in KV`,
                ).pipe(Effect.annotateLogs({ email, url }));
                return;
              }
              const emailService = yield* Email;
              const expiresInMinutes = String(
                MAGIC_LINK_EXPIRES_IN_SECONDS / 60,
              );
              yield* emailService.send({
                to: email,
                subject: "Your Baton login link",
                html: `<p><a href="${url}">Sign in</a> — this link expires in ${expiresInMinutes} minutes.</p>`,
                text: `Sign in: ${url}\n\nThis link expires in ${expiresInMinutes} minutes.`,
              });
            }),
          ),
      }),
      admin(),
      // Must be last: forwards set-cookie headers from direct `auth.api.*`
      // calls in server fns through TanStack's request storage (no-op for
      // `auth.handler`-routed requests, whose cookies ride the Response).
      tanstackStartCookies(),
    ],
  });

  const handler = Effect.fn("Auth.handler")(function* (request: Request) {
    return yield* tryAuth(() => auth.handler(request));
  });

  const getSession = Effect.fn("Auth.getSession")(function* (headers: Headers) {
    const result = yield* tryAuth(() => auth.api.getSession({ headers }));
    if (!result) return Option.none<Domain.SessionContext>();
    return Option.some(
      yield* Schema.decodeUnknownEffect(SessionContextFromAuthOutput)(
        result,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Better-auth session output failed domain validation",
              cause,
            }),
        ),
      ),
    );
  });

  const signInMagicLink = Effect.fn("Auth.signInMagicLink")(function* (input: {
    readonly headers: Headers;
    readonly email: string;
    readonly callbackURL: string;
  }) {
    return yield* tryAuth(() =>
      auth.api.signInMagicLink({
        headers: input.headers,
        body: { email: input.email, callbackURL: input.callbackURL },
      }),
    );
  });

  const signOut = Effect.fn("Auth.signOut")(function* (headers: Headers) {
    return yield* tryAuth(() => auth.api.signOut({ headers }));
  });

  return {
    /** Runtime options, exposed for the schema drift test (`getSchema`). */
    options: auth.options,
    handler,
    getSession,
    signInMagicLink,
    signOut,
  };
});

export class Auth extends Context.Service<Auth, Effect.Success<typeof make>>()(
  "Auth",
) {
  static readonly layerNoDeps = Layer.effect(Auth, make);
}
