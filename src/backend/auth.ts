import { BetterAuth } from "@alchemy.run/better-auth";
import { RuntimeContext } from "alchemy";
import { admin, magicLink } from "better-auth/plugins";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Email, Me, Unauthorized } from "../contract/auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { ShopActors } from "./shop-actors.ts";
import { ShopLimits } from "../domain/platform.ts";
import { Members } from "./members.ts";

const MAGIC_LINK_TTL_SECONDS = 300;

const decodeEmail = Schema.decodeUnknownOption(Email);
const decodeMe = Schema.decodeUnknownEffect(Me);

export interface AuthOptions {
  /**
   * The Better Auth signing secret. Omitted, it is an `Alchemy.Random` resource held in state,
   * which needs a stack; a test passes a literal.
   */
  readonly secret?: string | Redacted.Redacted<string>;
}

/**
 * Builds {@link Auth}. This is the only Promise seam with Better Auth: its callbacks run
 * inside Better Auth's promise machinery, so they run Effects with a snapshot of the
 * construction context. The collaborators ({@link Members}, {@link MagicLinkDelivery},
 * {@link ShopActors}) are services, so the same code runs in the Worker and in a test with no
 * Cloudflare binding behind it.
 */
export const makeAuth = (options: AuthOptions = {}) =>
  Effect.gen(function* () {
    // The Website's URL, bound onto this Worker by the stack. It is absent while the stack is
    // planned, which needs no origin; a running Worker without it is broken.
    const authOrigin = yield* Config.option(Config.String("AUTH_ORIGIN"));
    if (globalThis.__ALCHEMY_RUNTIME__ && Option.isNone(authOrigin))
      return yield* Effect.die(new Error("AUTH_ORIGIN is not bound to the Backend"));
    const members = yield* Members;
    const delivery = yield* MagicLinkDelivery;
    const actors = yield* ShopActors;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

    // A callback runs outside any request, so `Effect.scoped` gives the query its own scope:
    // `SQL.D1` builds its client per scope and releases it with the scope.
    const isMember = (address: unknown) =>
      Option.match(decodeEmail(address), {
        onNone: () => Effect.succeed(false),
        onSome: (address) =>
          members.listShopsOf(address).pipe(
            Effect.map((shops) => shops.length > 0),
            Effect.scoped,
          ),
      }).pipe(Effect.provide(RuntimeContext.phantom));

    /** Closes one session's sockets on every shop the address is a member of. */
    const revokeSession = Effect.fn("Auth.revokeSession")(function* (
      address: unknown,
      sessionId: string,
    ) {
      const email = decodeEmail(address);
      if (Option.isNone(email)) return;
      for (const shop of yield* members.listShopsOf(email.value))
        yield* actors.revoke(shop, "session", sessionId);
    });

    /** Closes the member's sockets on every shop the address is a member of. */
    const revokeUser = Effect.fn("Auth.revokeUser")(function* (address: unknown) {
      const email = decodeEmail(address);
      if (Option.isNone(email)) return;
      for (const shop of yield* members.listShopsOf(email.value)) {
        const member = yield* members.findMember({ shop, email: email.value });
        if (Option.isSome(member)) yield* actors.revoke(shop, "member", member.value.id);
      }
    });

    /**
     * Runs a revocation from a Better Auth hook: its own scope for D1, and every failure logged
     * and swallowed, because Better Auth must never see a throw from a hook that runs after
     * its write.
     */
    const revocation =
      (hook: string) =>
      <E, R>(effect: Effect.Effect<void, E, R>) =>
        effect.pipe(
          Effect.scoped,
          Effect.catchCause((cause) => Effect.logError(`Auth ${hook}: revoke failed`, cause)),
          Effect.provide(RuntimeContext.phantom),
        );

    const auth = yield* BetterAuth({
      ...(options.secret === undefined ? {} : { secret: options.secret }),
      basePath: "/api/auth",
      baseURL: Option.getOrUndefined(authOrigin),
      user: {
        // Runs before a user is created: a non-member's verify lands on ?error=not_invited.
        validateUserInfo: ({ user }) =>
          runPromise(
            isMember(user.email).pipe(
              Effect.map((member) => (member ? undefined : { error: "not_invited" })),
            ),
          ),
      },
      databaseHooks: {
        user: {
          create: {
            // The backstop behind `validateUserInfo`: no user is created for a non-member.
            before: (user) =>
              runPromise(
                isMember(user.email).pipe(Effect.map((member) => (member ? undefined : false))),
              ),
          },
          update: {
            after: (user) =>
              runPromise(
                Effect.gen(function* () {
                  // Every update fires this (a first sign-in's `emailVerified` too); only a
                  // user who can no longer open a shop as a member loses its sockets.
                  if (user.banned !== true && user.role !== "admin") return;
                  yield* revokeUser(user.email);
                }).pipe(revocation("user.update.after")),
              ),
          },
        },
        session: {
          create: {
            /**
             * Holds `ShopLimits.maxSessionsPerMember`, which states the rule and its reasoning:
             * keeps the session just created and the user's newest others up to the cap, deletes
             * the rest ({@link Members}' `keepNewestSessions`), and closes each deleted session's
             * sockets on every shop the email belongs to, so the signed-out device's socket goes
             * back through the gate and is refused there.
             *
             * Best-effort, logged and swallowed like the expired-auth sweep: the session row is
             * already written when this runs, and a failure here must never be the reason a
             * person cannot sign in.
             */
            after: (session) =>
              runPromise(
                Effect.gen(function* () {
                  const { deletedIds, email } = yield* members.keepNewestSessions({
                    userId: session.userId,
                    sessionId: session.id,
                    keep: ShopLimits.maxSessionsPerMember,
                  });
                  if (deletedIds.length === 0 || email === null) return;
                  yield* Effect.logInfo(
                    `Auth.sessionCreate: email=${email} revoked=${String(deletedIds.length)}`,
                  ).pipe(Effect.annotateLogs({ email, revoked: deletedIds.length }));
                  for (const id of deletedIds) yield* revokeSession(email, id);
                }).pipe(
                  Effect.scoped,
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `Auth.sessionCreate: userId=${session.userId}: session cap failed`,
                      cause,
                    ).pipe(Effect.annotateLogs({ userId: session.userId })),
                  ),
                  Effect.provide(RuntimeContext.phantom),
                ),
              ),
          },
          delete: {
            // Sign-out, revoke, ban, password change and account deletion all delete sessions.
            after: (session, endpoint) =>
              runPromise(
                Effect.gen(function* () {
                  // Every session delete Better Auth makes runs inside one of its endpoints.
                  if (endpoint === null)
                    return yield* Effect.logWarning("session deleted outside an endpoint");
                  const user = yield* Effect.promise(() =>
                    endpoint.context.internalAdapter.findUserById(session.userId),
                  );
                  if (user === null) return;
                  yield* revokeSession(user.email, session.id);
                }).pipe(revocation("session.delete.after")),
              ),
          },
        },
      },
      plugins: [
        magicLink({
          expiresIn: MAGIC_LINK_TTL_SECONDS,
          storeToken: "hashed",
          sendMagicLink: ({ email: to, url }) =>
            runPromise(
              Effect.gen(function* () {
                // The one request that creates a `verification` row pays to trim the expired ones,
                // and the `session` rows those sign-ins left behind. Logged and swallowed on
                // failure: storage housekeeping must never be the reason someone cannot sign in.
                yield* members.sweepExpiredAuth().pipe(
                  Effect.scoped,
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `Auth.sendMagicLink: email=${to}: expired-auth sweep failed`,
                      cause,
                    ).pipe(Effect.annotateLogs({ email: to })),
                  ),
                  Effect.provide(RuntimeContext.phantom),
                );
                return yield* delivery.deliver(to, url);
              }),
            ),
        }),
        admin(),
      ],
      advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
      // Sign-in requests are limited per IP by the SignInLimit binding instead.
      rateLimit: { enabled: false },
    });

    /**
     * Whether Better Auth has a user for the address. An existing user signs in by magic link
     * without the member check, which is how the admin (a user row with no `Member` row)
     * gets in.
     */
    const userExists = Effect.fn("Auth.userExists")(function* (email: Email) {
      const instance = yield* auth.auth;
      const context = yield* Effect.promise(() => instance.$context);
      const found = yield* Effect.promise(() => context.internalAdapter.findUserByEmail(email));
      return found !== null;
    });

    /**
     * Whether a magic link for the address could sign anyone in: a user exists, or a `Member`
     * row would let one be created. Asked before a link is sent, so a link is never minted for
     * an address the verify would refuse.
     */
    const maySignIn = Effect.fn("Auth.maySignIn")(function* (email: Email) {
      return (yield* userExists(email)) || (yield* isMember(email));
    });

    return { auth, userExists, maySignIn };
  });

/**
 * Better Auth with magic links, invite-only as Baton is: a new user is created only for an
 * address with a `Member` row in some shop, and always with the role `user`. An admin is a
 * user row whose role is `admin`, put there by the stage's auth seed, never by sign-in. Magic links
 * go through {@link MagicLinkDelivery}, which decides whether a caller gets one back.
 *
 * Its database hooks are the revocation triggers: a deleted session closes that session's
 * sockets, and a user who becomes banned or an admin loses its member sockets, on every
 * shop the user is a member of.
 */
export class Auth extends Context.Service<Auth, Effect.Success<ReturnType<typeof makeAuth>>>()(
  "app/Auth",
) {
  static readonly layerWith = (options: AuthOptions) => Layer.effect(Auth, makeAuth(options));
  static readonly layer = Auth.layerWith({});
}

/**
 * Resolves the Better Auth session from a `cookie` header value: the signed-in user as
 * {@link Me}, the session's id, and its expiry in epoch ms. No session, or one that does not
 * decode, is {@link Unauthorized}. The actor gate needs the session itself, to scope a revoke to
 * it and to stop serving a socket past its expiry.
 */
export const sessionFromCookie = Effect.fn("sessionFromCookie")(function* (
  cookie: string | undefined,
) {
  const { auth } = yield* Auth;
  const session = yield* auth.getSession(new Headers({ cookie: cookie ?? "" })).pipe(
    Effect.mapError(() => new Unauthorized()),
    Effect.catchDefect(() => Effect.fail(new Unauthorized())),
  );
  if (session === null) return yield* new Unauthorized();
  const me = yield* decodeMe({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  }).pipe(Effect.mapError(() => new Unauthorized()));
  return {
    me,
    sessionId: session.session.id,
    sessionExpiresAt: session.session.expiresAt.getTime(),
  };
});
