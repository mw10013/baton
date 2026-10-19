import { redirect } from "@tanstack/react-router";
import * as Option from "effect/Option";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import {
  type AppAdmin,
  authenticateAppWithin,
  type ShopifyApp,
  shopifyAppOnce,
} from "../client/app-guard.ts";
import { embeddedAppUrl, sessionTokenBounce } from "../server/shopify-urls.ts";
import { appSearch } from "./-app-search.ts";

/** The server functions the guard reads, passed in so a test can stand in for them. */
export interface AppGuardReads {
  readonly getShopifyApp: () => Promise<ShopifyApp>;
  readonly authenticateApp: (input: {
    readonly data: { readonly idToken: string; readonly billingRedirect: boolean };
  }) => Promise<AppAdmin>;
  readonly now?: () => number;
}

/**
 * The embedded App Home's document guards, `/app`'s `beforeLoad`; first match wins, each a
 * redirect. The search checks run on every navigation, because they cost nothing: no `shop` or
 * `host` goes to the App Bridge-only page, which re-embeds; `embedded !== "1"` goes to the app
 * inside the Shopify admin; no `id_token` goes to the session-token bounce. Then the token is
 * authenticated (`authenticateApp`), and a shop with no app subscription goes, out of the frame,
 * to plan selection. Shopify's billing redirect back (its search carries `plan_handle`) re-reads
 * the plan first. `getShopifyApp` is read once per document ({@link shopifyAppOnce}), and a
 * client-side navigation reuses a recent answer ({@link authenticateAppWithin}).
 */
export const appGuard =
  (reads: AppGuardReads) =>
  async ({
    location,
    context: { registry },
  }: {
    readonly location: { readonly pathname: string; readonly searchStr: string };
    readonly context: { readonly registry: AtomRegistry.AtomRegistry };
  }) => {
    const search = appSearch(location.searchStr);
    const reEmbed = `/auth/session-token${location.searchStr}`;
    if (search.shop === undefined || search.host === undefined) throw redirect({ href: reEmbed });
    const { apiKey, appUrl } = await shopifyAppOnce(registry, reads.getShopifyApp);
    if (search.embedded !== "1")
      throw redirect({
        href: Option.getOrElse(embeddedAppUrl(search.host, apiKey), () => reEmbed),
      });
    const idToken = search.id_token;
    if (idToken === undefined)
      throw redirect({ href: sessionTokenBounce(appUrl, location.pathname, location.searchStr) });
    const billingRedirect = location.searchStr.includes("plan_handle");
    const admin = await authenticateAppWithin(
      registry,
      { shop: search.shop, fresh: billingRedirect, now: (reads.now ?? Date.now)() },
      () => reads.authenticateApp({ data: { idToken, billingRedirect } }),
    );
    if (admin._tag === "Unsubscribed") throw redirect({ href: admin.href });
    return { shop: admin.shop, apiKey: admin.apiKey, appUrl, managePlanUrl: admin.managePlanUrl };
  };
