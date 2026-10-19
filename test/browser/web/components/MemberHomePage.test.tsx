import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import type { ShopKey } from "../../../../src/domain/platform.ts";
import MemberHomePage from "../../../../src/web/components/MemberHomePage.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { OTHER_SHOP, SEED_SHOP } from "../../../seed-shops.ts";

/**
 * {@link MemberHomePage} on `/shop` in a memory router, beside a `/shop/$key` page that shows its
 * path, so a click on a shop shows where the router went.
 */
const render = async (shops: ReadonlyArray<ShopKey>) => {
  const root = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/shop",
        component: () => <MemberHomePage shops={shops} />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/shop/$key",
        component: function Opened() {
          return <p>Opened {useLocation().pathname}</p>;
        },
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/shop"] }),
  });
  return renderInApp(<RouterProvider router={router} />, shopTestRegistry({}));
};

describe("MemberHomePage", () => {
  it("lists every shop of a member of two, and a click opens that shop", async () => {
    const screen = await render([OTHER_SHOP, SEED_SHOP]);

    await expect.element(screen.getByRole("link", { name: OTHER_SHOP })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: SEED_SHOP })).toBeVisible();

    await screen.getByRole("link", { name: OTHER_SHOP }).click();

    await expect.element(screen.getByText(`Opened /shop/${OTHER_SHOP}`)).toBeVisible();
  });

  it("says so when the member has no shop", async () => {
    const screen = await render([]);

    await expect
      .element(
        screen.getByText(
          /^You don’t have access to any shops yet\. Ask the merchant to add your email on their Members page\.$/u,
        ),
      )
      .toBeVisible();
  });
});
