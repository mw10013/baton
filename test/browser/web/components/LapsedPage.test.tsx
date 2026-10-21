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

const render = async (yourStores: boolean) => {
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/",
        component: () => <LapsedPage shop="lapsed.myshopify.com" yourStores={yourStores} />,
      }),
      createRoute({ getParentRoute: () => root, path: "/shop" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderInApp(<RouterProvider router={router} />, shopTestRegistry({}));
};

describe("LapsedPage", () => {
  it("says the store's subscription is not active, who renews it, and links to Your stores", async () => {
    const screen = await render(true);
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

  it("has no Your stores link for a member of this shop alone", async () => {
    const screen = await render(false);
    await expect.element(screen.getByText(/subscription is not active/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Your stores" }).elements()).toHaveLength(0);
  });
});
