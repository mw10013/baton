import { isRedirect } from "@tanstack/react-router";
import * as Duration from "effect/Duration";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { type AppAdmin, GUARD_MAX_AGE } from "../../../../src/web/client/app-guard.ts";
import { appGuard } from "../../../../src/web/routes/-app-guard.ts";

const SHOP = "guard-shop.myshopify.com";
const SEARCH = `?embedded=1&host=aG9zdA&shop=${SHOP}&id_token=token`;

const subscribed = (shop: string): AppAdmin => ({
  _tag: "Subscribed",
  shop,
  apiKey: "key",
  managePlanUrl: "https://admin.shopify.com/plans",
});

/** The guard over counting stand-ins for its server functions, on its own registry and clock. */
const setup = (answer: (shop: string) => AppAdmin = subscribed) => {
  const registry = AtomRegistry.make();
  onTestFinished(() => registry.dispose());
  const calls = { app: 0, authenticate: 0 };
  const clock = { now: 1_000_000 };
  const guard = appGuard({
    getShopifyApp: () => {
      calls.app++;
      return Promise.resolve({ apiKey: "key", appUrl: "https://app.example" });
    },
    authenticateApp: () => {
      calls.authenticate++;
      return Promise.resolve(answer(SHOP));
    },
    now: () => clock.now,
  });
  const navigate = (searchStr = SEARCH, pathname = "/app/orders") =>
    guard({ location: { pathname, searchStr }, context: { registry } });
  return { registry, calls, clock, navigate };
};

describe("/app guard", () => {
  it("a navigation inside the window reuses the guard answer", async () => {
    const t = setup();
    await t.navigate();
    t.clock.now += Duration.toMillis(GUARD_MAX_AGE) - 1;
    const context = await t.navigate(SEARCH, "/app");
    expect(context.shop).toBe(SHOP);
    expect(t.calls).toEqual({ app: 1, authenticate: 1 });
  });

  it("a navigation after the window authenticates again", async () => {
    const t = setup();
    await t.navigate();
    t.clock.now += Duration.toMillis(GUARD_MAX_AGE);
    await t.navigate();
    expect(t.calls).toEqual({ app: 1, authenticate: 2 });
  });

  it("another shop, Shopify's billing redirect and an unsubscribed shop always authenticate", async () => {
    const t = setup();
    await t.navigate();
    await t.navigate(SEARCH.replace(SHOP, "other-shop.myshopify.com"));
    await t.navigate(`${SEARCH}&plan_handle=basic`);
    expect(t.calls.authenticate).toBe(3);
    const lapsed = setup(() => ({ _tag: "Unsubscribed", href: "https://plans.example" }));
    await expect(lapsed.navigate()).rejects.toSatisfy(isRedirect);
    await expect(lapsed.navigate()).rejects.toSatisfy(isRedirect);
    expect(lapsed.calls.authenticate).toBe(2);
  });

  it("the search checks run on every navigation", async () => {
    const t = setup();
    await t.navigate();
    for (const search of [
      SEARCH.replace("&id_token=token", ""),
      SEARCH.replace("embedded=1", "embedded=0"),
      SEARCH.replace(`&shop=${SHOP}`, ""),
      SEARCH.replace("host=aG9zdA&", ""),
    ])
      await expect(t.navigate(search)).rejects.toSatisfy(isRedirect);
    expect(t.calls).toEqual({ app: 1, authenticate: 1 });
  });
});
