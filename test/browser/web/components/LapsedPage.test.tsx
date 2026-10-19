import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { LapsedPage } from "../../../../src/web/components/LapsedPage.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";

describe("LapsedPage", () => {
  it("says the store's subscription is not active, who renews it, and links to Your stores", async () => {
    const root = createRootRoute();
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: "/",
          component: () => <LapsedPage shop="lapsed.myshopify.com" />,
        }),
        createRoute({ getParentRoute: () => root, path: "/shop" }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const screen = await renderInApp(<RouterProvider router={router} />, shopTestRegistry({}));
    expect(
      screen.container.querySelector('s-section[heading="Subscription inactive"]'),
    ).not.toBeNull();
    expect(screen.container.querySelector('s-page[heading="lapsed.myshopify.com"]')).not.toBeNull();
    await expect
      .element(
        screen.getByText(
          "This store’s Baton subscription is not active, so its workflows are unavailable. Ask the merchant to renew the subscription from the Baton app in their Shopify admin.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Your stores" }))
      .toHaveAttribute("href", "/shop");
  });
});
