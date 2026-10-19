import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/socket/Socket";
import { ReturnPath } from "../../contract/auth.ts";
import type { ShopKey } from "../../contract/shop.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_PAYMENT_REQUIRED,
  CONNECTION_CLOSE_REVOKED,
  CONNECTION_CLOSE_UNAUTHENTICATED,
  CONNECTION_CLOSE_UNINSTALLED,
} from "../../contract/shop-actor.ts";

/**
 * The shop whose actor this registry's client talks to; None until the socket holder names it (`nameSocket`), which it
 * does before the page reads any socket atom. There is no default shop: a member may belong to
 * any number. This and the other plain state atoms here are kept alive: they are set while
 * nothing on the page reads them yet, and an unread atom would drop the value.
 */
export const shopKeyAtom = Atom.make<Option.Option<ShopKey>>(Option.none()).pipe(Atom.keepAlive);

/**
 * How the merchant's browser gets a Shopify session token, run once per connect, so every
 * reconnect carries a token minted for it; None on the member page. Its presence is what makes
 * this browser a merchant.
 */
export const merchantTokenAtom = Atom.make<Option.Option<Effect.Effect<string>>>(
  Option.none(),
).pipe(Atom.keepAlive);

/**
 * Bumped when the socket learns that this browser's membership changed: the actor's revoke
 * (3401, a member's teams or membership changed while connected, or the session ended), the
 * gate's 4404 (no longer a member) or the actor's 4410 (uninstalled, its members gone). The socket comes back on its own after a 3401, through the
 * gate, with the new membership; what it cannot refresh is the page's loader data, resolved from
 * the old one, so the member shop layout reruns its loaders on each bump, and the loader is where
 * a removed member finds out they are gone.
 */
export const membershipChangedAtom = Atom.make(0).pipe(Atom.keepAlive);

/** Set when the gate no longer accepts the merchant's Shopify session token. */
export const merchantExpiredAtom = Atom.make(false).pipe(Atom.keepAlive);

/** Set when the actor closed the socket because the shop uninstalled Baton. */
export const uninstalledAtom = Atom.make(false).pipe(Atom.keepAlive);

/**
 * Bumped when the gate refuses the socket because the shop has no app subscription (4402). The
 * socket holder reruns the router's guards and loaders on each bump: `/app`'s sends the merchant
 * to plan selection, the member shop layout's sends a member to Subscription inactive.
 */
export const paymentRequiredAtom = Atom.make(0).pipe(Atom.keepAlive);

/**
 * The actor socket as the page shows it. `displaced` and `forbidden` are terminal: the socket
 * stays closed until the person asks again ({@link reconnectAtom}).
 */
export type ConnectionState = "connecting" | "open" | "lost" | "displaced" | "forbidden";
export const connectionStateAtom = Atom.make<ConnectionState>("connecting").pipe(Atom.keepAlive);

/** Bumped by the displaced banner's Reconnect; the protocol reads it, so a bump rebuilds it. */
export const reconnectAtom = Atom.make(0).pipe(Atom.keepAlive);

/** How long a lost socket stays quiet before the page says so; most reconnects are faster. */
const LOST_GRACE = 4_000;

/** True once {@link connectionStateAtom} has been `lost` for {@link LOST_GRACE}. */
export const lostAtom = Atom.make((get) => {
  if (get(connectionStateAtom) !== "lost") return false;
  const timer = setTimeout(() => get.setSelf(true), LOST_GRACE);
  get.addFinalizer(() => clearTimeout(timer));
  return false;
});

/**
 * The close codes a browser does not reconnect after: the gate's answers that will not change
 * by asking again, the actor's refusal of an unidentified socket, its teardown on uninstall,
 * and displacement, so two windows never displace each other in turn. Every other close (a revoke's 3401, the gate's
 * 1013, a dropped connection) reconnects, and the reconnect goes back through the gate, which
 * gives the current answer.
 */
const TERMINAL_CODES: ReadonlySet<number> = new Set([
  CONNECTION_CLOSE_UNAUTHENTICATED,
  CONNECTION_CLOSE_PAYMENT_REQUIRED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_UNINSTALLED,
]);

const closeCode = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError" ? Option.some(error.reason.code) : Option.none();

/** Whether a socket error ends the retries; see {@link TERMINAL_CODES}. */
export const isTerminal = (error: Socket.SocketError) =>
  Option.exists(closeCode(error), (code) => TERMINAL_CODES.has(code));

/**
 * The socket's retry policy: exponential from 250 ms, capped at 4 s, forever, except after a
 * terminal close ({@link isTerminal}). Every error the policy sees goes to `onError` first,
 * which is how the page learns the close code.
 */
export const retryPolicy = (onError: (error: Socket.SocketError) => Effect.Effect<void>) =>
  Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("4 seconds")]).pipe(
    Schedule.setInputType<Socket.SocketError>(),
    Schedule.tap(({ input }) => onError(input)),
    Schedule.while(({ input }) => !isTerminal(input)),
  );

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/** A full page load to sign-in, back here afterwards; the same shape as the `/shop` route guard. */
export const goToSignIn = Effect.sync(() => {
  const url = new URL("/sign-in", window.location.origin);
  const back = decodeReturnPath(window.location.pathname + window.location.search);
  if (Option.isSome(back)) url.searchParams.set("redirect", back.value);
  window.location.assign(url);
});

/**
 * What a socket error means for the page. Each terminal code ({@link isTerminal}) says why the
 * browser stops: 4401 sends a member to sign-in and marks a merchant's token expired, 4402 is
 * "payment required", 4404 is "not a member", 4409 is displaced, 4410 is uninstalled, 4403 is
 * forbidden. 3401 is `revoked` and anything else `lost`, and both are retried.
 */
export type CloseOutcome =
  | "lost"
  | "revoked"
  | "sign-in"
  | "expired"
  | "payment-required"
  | "not-a-member"
  | "displaced"
  | "uninstalled"
  | "forbidden";

export const closeOutcome = (error: Socket.SocketError, merchant: boolean): CloseOutcome =>
  Option.match(closeCode(error), {
    onNone: (): CloseOutcome => "lost",
    onSome: (code) =>
      Match.value(code).pipe(
        Match.when(CONNECTION_CLOSE_REVOKED, (): CloseOutcome => "revoked"),
        Match.when(CONNECTION_CLOSE_UNAUTHENTICATED, (): CloseOutcome =>
          merchant ? "expired" : "sign-in",
        ),
        Match.when(CONNECTION_CLOSE_PAYMENT_REQUIRED, (): CloseOutcome => "payment-required"),
        Match.when(CONNECTION_CLOSE_NOT_A_MEMBER, (): CloseOutcome => "not-a-member"),
        Match.when(CONNECTION_CLOSE_DISPLACED, (): CloseOutcome => "displaced"),
        Match.when(CONNECTION_CLOSE_UNINSTALLED, (): CloseOutcome => "uninstalled"),
        Match.when(CONNECTION_CLOSE_FORBIDDEN, (): CloseOutcome => "forbidden"),
        Match.orElse((): CloseOutcome => "lost"),
      ),
  });

/**
 * Applies a {@link CloseOutcome} to the page's atoms. A refusal that has its own copy
 * (`expired`, `uninstalled`) also leaves the socket `forbidden`, so nothing reconnects; so does
 * `not-a-member`, which with `revoked` bumps {@link membershipChangedAtom}, and so does
 * `payment-required`, which bumps {@link paymentRequiredAtom}.
 */
export const applyCloseOutcome = (
  registry: AtomRegistry.AtomRegistry,
  outcome: CloseOutcome,
): Effect.Effect<void> => {
  const set = (state: ConnectionState, flag?: Atom.Writable<boolean>) =>
    Effect.sync(() => {
      if (flag !== undefined) registry.set(flag, true);
      registry.set(connectionStateAtom, state);
    });
  const membershipChanged = Effect.sync(() => registry.update(membershipChangedAtom, (n) => n + 1));
  return Match.value(outcome).pipe(
    Match.when("sign-in", () => Effect.andThen(set("forbidden"), goToSignIn)),
    Match.when("expired", () => set("forbidden", merchantExpiredAtom)),
    Match.when("not-a-member", () => Effect.andThen(set("forbidden"), membershipChanged)),
    Match.when("payment-required", () =>
      Effect.andThen(
        set("forbidden"),
        Effect.sync(() => registry.update(paymentRequiredAtom, (n) => n + 1)),
      ),
    ),
    Match.when("revoked", () => Effect.andThen(set("lost"), membershipChanged)),
    Match.when("uninstalled", () =>
      Effect.andThen(set("forbidden", uninstalledAtom), membershipChanged),
    ),
    Match.orElse((state) => set(state)),
  );
};
