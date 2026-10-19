import { createIsomorphicFn } from "@tanstack/react-start";
import * as Duration from "effect/Duration";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { authenticateApp, getShopifyApp } from "../server/shopify.ts";
import { LIVE_RETENTION } from "./query.ts";

/** `getShopifyApp`'s answer: deploy-time constants. */
export type ShopifyApp = Awaited<ReturnType<typeof getShopifyApp>>;

/** `authenticateApp`'s answer. */
export type AppAdmin = Awaited<ReturnType<typeof authenticateApp>>;

/** An answer the `/app` guard may reuse. */
export type SubscribedAdmin = Extract<AppAdmin, { readonly _tag: "Subscribed" }>;

/**
 * How long a client-side navigation under `/app` reuses the last `authenticateApp` answer
 * instead of asking again: {@link LIVE_RETENTION}. Within it, the checks it skips are covered
 * elsewhere: every loader's server function verifies the session token and the installation, and
 * a plan change the Backend learns of closes the socket, whose refusal reruns the guards
 * (`usePaymentRequired`). The window bounds what is left: a lapse only a fresh plan read would
 * find, or a socket that cannot connect, is seen within it.
 */
export const GUARD_MAX_AGE: Duration.Duration = LIVE_RETENTION;

/**
 * The `/app` guard's remembered answers, in the router's registry, so one router (one document
 * in the browser, one request on the server) never sees another's: `getShopifyApp`'s, for the
 * document's life, and the last `Subscribed` answer with the URL's `shop` it was for and when it
 * was read.
 */
const appGuardMemo = Atom.make(
  (): {
    app: Promise<ShopifyApp> | undefined;
    admin:
      | { readonly shop: string; readonly answer: SubscribedAdmin; readonly at: number }
      | undefined;
  } => ({ app: undefined, admin: undefined }),
).pipe(Atom.keepAlive);

/** Whether this runs in the browser: the server always asks. */
const inBrowser = createIsomorphicFn()
  .client(() => true)
  .server(() => false);

/** `getShopifyApp`, read once per document in the browser and once per request on the server. */
export const shopifyAppOnce = (
  registry: AtomRegistry.AtomRegistry,
  read: () => Promise<ShopifyApp>,
): Promise<ShopifyApp> => {
  if (!inBrowser()) return read();
  const memo = registry.get(appGuardMemo);
  memo.app ??= read().catch((error: unknown) => {
    memo.app = undefined;
    throw error;
  });
  return memo.app;
};

/**
 * `authenticateApp`, or in the browser the last `Subscribed` answer for the same `shop` while it
 * is under {@link GUARD_MAX_AGE} old. `fresh` (Shopify's billing redirect, which is a full page
 * load) always asks, as does the server. An `Unsubscribed` answer is never kept.
 */
export const authenticateAppWithin = async (
  registry: AtomRegistry.AtomRegistry,
  input: { readonly shop: string; readonly fresh: boolean; readonly now: number },
  read: () => Promise<AppAdmin>,
): Promise<AppAdmin> => {
  if (!inBrowser()) return read();
  const memo = registry.get(appGuardMemo);
  const last = memo.admin;
  if (
    !input.fresh &&
    last !== undefined &&
    last.shop === input.shop &&
    input.now - last.at < Duration.toMillis(GUARD_MAX_AGE)
  )
    return last.answer;
  const answer = await read();
  memo.admin =
    answer._tag === "Subscribed" ? { shop: input.shop, answer, at: input.now } : undefined;
  return answer;
};

/**
 * Takes the server's guard answer for the document the browser hydrated as the last one, read
 * at the `/app` match's `updatedAt`, so the first client-side navigation reuses it. Only when
 * nothing is remembered yet: a render may run it twice.
 */
export const rememberHydratedAppGuard = (
  registry: AtomRegistry.AtomRegistry,
  input: {
    readonly app: ShopifyApp;
    readonly shop: string;
    readonly answer: SubscribedAdmin;
    readonly at: number;
  },
) => {
  if (!inBrowser()) return;
  const memo = registry.get(appGuardMemo);
  memo.app ??= Promise.resolve(input.app);
  memo.admin ??= { shop: input.shop, answer: input.answer, at: input.at };
};

/**
 * Forgets the remembered `authenticateApp` answer, so the next `/app` guard asks again. Run it
 * before a `router.invalidate()` made for an auth reason.
 */
export const forgetAppGuard = (registry: AtomRegistry.AtomRegistry) => {
  registry.get(appGuardMemo).admin = undefined;
};
