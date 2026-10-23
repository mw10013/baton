import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";
import type { AdminShopData } from "../../../../src/contract/admin.ts";
import type { AdminShopPlanCache, ShopUsage } from "../../../../src/domain/billing.ts";
import { ShopGid, type ShopSessionRedacted } from "../../../../src/domain/platform.ts";
import AdminShopPage, {
  REFRESH_PLAN_FAILED,
} from "../../../../src/web/components/AdminShopPage.tsx";
import { PlanCache } from "../../../../src/web/components/PlanCache.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

/** `ui` as the only page of a memory router: the admin pages' Sign out needs one. */
const inRouter = (ui: () => ReactNode) => {
  const router = createRouter({
    routeTree: createRootRoute({ component: ui }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderInApp(<RouterProvider router={router} />, shopTestRegistry({}));
};

const link = { href: "/admin/shops", onClick: () => {} };

const shopSession: ShopSessionRedacted = {
  shop: SEED_SHOP,
  shopGid: Schema.decodeUnknownSync(ShopGid)("gid://shopify/Shop/1"),
  shopActorId: SEED_SHOP,
  scope: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
  hasAccessToken: true,
  hasRefreshToken: false,
};

const usage: ShopUsage = {
  cycleStartAt: null,
  cycleEndAt: null,
  ordersThisCycle: 12,
  ordersLimitedAt: null,
  databaseSize: 40_000,
  openOrders: 3,
  lastSweepAt: null,
  pendingUsageEvents: 0,
  seatsThisCycle: 2,
};

/** A shop whose cached plan was never fetched, so it grants nothing. */
const neverFetched: AdminShopData = {
  _tag: "Found",
  shopSession,
  plan: { _tag: "NeverFetched" },
  entitlements: null,
  usage,
  memberCount: 2,
};

const shopPage = (
  data: AdminShopData,
  onRefresh: () => Promise<string | null> = async () => null,
) =>
  inRouter(() => (
    <AdminShopPage shop={SEED_SHOP} data={data} shopsLink={link} onRefresh={onRefresh} />
  ));

describe("PlanCache", () => {
  it("PlanCache shows each cache state's badge and the stored handle", async () => {
    const states: ReadonlyArray<readonly [AdminShopPlanCache, string]> = [
      [{ _tag: "Subscribed", handle: "baton-pro", plan: "pro" }, "probaton-pro"],
      [{ _tag: "Unsubscribed" }, "Unsubscribed"],
      [{ _tag: "Stale", handle: "baton-basic" }, "Stalebaton-basic"],
      [{ _tag: "NeverFetched" }, "Never fetched"],
      [{ _tag: "Unrecognized", handle: "baton-retired" }, "Unrecognizedbaton-retired"],
    ];
    const screen = await renderInApp(
      <ul>
        {states.map(([plan, expected]) => (
          <li key={expected} data-testid={expected}>
            <PlanCache plan={plan} />
          </li>
        ))}
      </ul>,
      shopTestRegistry({}),
    );
    // The badge's text runs straight into the handle's: they are separate elements.
    for (const [, expected] of states)
      await expect.element(screen.getByTestId(expected)).toHaveTextContent(expected);
  });
});

describe("AdminShopPage", () => {
  it("the shop page shows No session for a shop with no row", async () => {
    const screen = await shopPage({ _tag: "NotFound" });
    await expect
      .element(screen.getByText("No stored session for this shop.", { exact: false }))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh plan" }).query()).toBeNull();
  });

  it("the shop page shows a dash for an empty field and of — when the cache grants nothing", async () => {
    const screen = await shopPage(neverFetched);
    await expect.element(screen.getByText("12 of —")).toBeVisible();
    await expect.element(screen.getByText("2 of —")).toBeVisible();
    await expect.element(screen.getByText("Never fetched")).toBeVisible();
    await expect.element(screen.getByText("3 of 2,500")).toBeVisible();
    await expect.element(screen.getByText("0.0 MB")).toBeVisible();
    expect(screen.getByText("—", { exact: true }).elements().length).toBeGreaterThanOrEqual(7);
    await expect.element(screen.getByText("Present")).toBeVisible();
    await expect.element(screen.getByText("Missing")).toBeVisible();
  });

  it("Refresh plan holds its loading state and shows the failure", async () => {
    let answer: (value: string | null) => void = () => {};
    const screen = await shopPage(
      neverFetched,
      () =>
        new Promise<string | null>((resolve) => {
          answer = resolve;
        }),
    );
    const button = screen.getByRole("button", { name: "Refresh plan" });
    await button.click();
    /**
     * The `s-button` host's `loading` property, which React sets (not an attribute); the role
     * query finds the button inside its shadow root.
     */
    const loading = () => {
      const root = button.element().getRootNode();
      const host: unknown = root instanceof ShadowRoot ? root.host : button.element();
      return host instanceof HTMLElement && Reflect.get(host, "loading") === true;
    };
    await expect.poll(loading).toBe(true);
    answer("Partner API down");
    await expect.element(screen.getByText("Partner API down")).toBeVisible();
    expect(loading()).toBe(false);
  });

  it("Refresh plan's failure without a message reads the fallback", async () => {
    const screen = await shopPage(neverFetched, () => Promise.reject(new Error("network")));
    await screen.getByRole("button", { name: "Refresh plan" }).click();
    await expect.element(screen.getByText(REFRESH_PLAN_FAILED)).toBeVisible();
  });
});
