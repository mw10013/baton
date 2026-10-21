import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import type { ShopKey } from "../../../../src/domain/platform.ts";
import MemberBar from "../../../../src/web/components/MemberBar.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { OTHER_SHOP, SEED_SHOP } from "../../../seed-shops.ts";

/** {@link MemberBar} on a `/shop/$key` page of {@link SEED_SHOP}, for a member of `shops`. */
const render = async (shops: ReadonlyArray<ShopKey>) => {
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/shop" }),
      createRoute({
        getParentRoute: () => root,
        path: "/shop/$key",
        component: () => <MemberBar email="m1@m.com" shops={shops} />,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [`/shop/${SEED_SHOP}`] }),
  });
  return renderInApp(<RouterProvider router={router} />, shopTestRegistry({}));
};

describe("MemberBar", () => {
  it("links to Your stores inside a shop for a member of several", async () => {
    const screen = await render([OTHER_SHOP, SEED_SHOP]);

    await expect
      .element(screen.getByRole("link", { name: "Your stores" }))
      .toHaveAttribute("href", "/shop");
  });

  it("has no Your stores link for a member of one shop", async () => {
    const screen = await render([SEED_SHOP]);

    await expect.element(screen.getByRole("link", { name: "Help" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Your stores" }).elements()).toHaveLength(0);
  });
});
