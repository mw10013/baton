import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Socket from "effect/socket/Socket";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_PAYMENT_REQUIRED,
  CONNECTION_CLOSE_REVOKED,
  CONNECTION_CLOSE_UNINSTALLED,
} from "../../../../src/contract/shop-actor.ts";
import {
  applyCloseOutcome,
  closeOutcome,
  connectionStateAtom,
  isTerminal,
  reconnectAtom,
  shopKeyAtom,
} from "../../../../src/web/client/actor-connection.ts";
import type { OrdersIndexData } from "../../../../src/domain/shop-work.ts";
import OrdersIndexPage from "../../../../src/web/components/OrdersIndexPage.tsx";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";
import { NO_USAGE } from "../../usage.ts";

/** The socket closing with `code`, as the browser protocol's retry policy reports it. */
const closeWith = (registry: ReturnType<typeof shopTestRegistry>, code: number, merchant = false) =>
  Effect.runPromise(
    applyCloseOutcome(
      registry,
      closeOutcome(
        new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) }),
        merchant,
      ),
    ),
  );

/** A member's socket holder around a line of page text. */
const memberHolder = (
  <ShopSocket shop={SEED_SHOP} merchantToken={Option.none()}>
    <p>The page</p>
  </ShopSocket>
);

const LOST =
  "Baton lost its connection. This page won't update, and you can't make changes until it reconnects.";

describe("SocketBanner", () => {
  it("shows nothing while the socket is connected, and names the shop", async () => {
    const registry = shopTestRegistry({});
    const screen = await renderInApp(memberHolder, registry);
    await expect.element(screen.getByText("The page")).toBeVisible();
    registry.set(connectionStateAtom, "open");
    expect(Option.getOrNull(registry.get(shopKeyAtom))).toBe(SEED_SHOP);
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  });

  it("a displaced socket (4409) shows Signed in elsewhere, and Reconnect asks again", async () => {
    const registry = shopTestRegistry({});
    const screen = await renderInApp(memberHolder, registry);
    await closeWith(registry, CONNECTION_CLOSE_DISPLACED);
    await expect
      .element(screen.getByText("Signed in elsewhere. Reconnect to keep working here."))
      .toBeVisible();

    const before = registry.get(reconnectAtom);
    await screen.getByRole("button", { name: "Reconnect" }).click();
    expect(registry.get(reconnectAtom)).toBe(before + 1);
  });

  it("a lost socket says so only after the grace", async () => {
    const registry = shopTestRegistry({});
    const screen = await renderInApp(memberHolder, registry);
    await closeWith(registry, 1006);
    expect(registry.get(connectionStateAtom)).toBe("lost");
    await expect.element(screen.getByText(LOST)).not.toBeInTheDocument();
    await expect.element(screen.getByText(LOST), { timeout: 6_000 }).toBeVisible();
  });

  it("a merchant's socket ended by an uninstall says so; a member's leaves it to the page", async () => {
    const merchantRegistry = shopTestRegistry({});
    const merchant = await renderInApp(
      <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
        <p>The page</p>
      </ShopSocket>,
      merchantRegistry,
    );
    await closeWith(merchantRegistry, CONNECTION_CLOSE_UNINSTALLED, true);
    await expect.element(merchant.getByText("Baton was uninstalled from this shop.")).toBeVisible();
    await merchant.unmount();

    const memberRegistry = shopTestRegistry({});
    const member = await renderInApp(memberHolder, memberRegistry);
    await closeWith(memberRegistry, CONNECTION_CLOSE_UNINSTALLED);
    await expect
      .element(member.getByText("Baton was uninstalled from this shop."))
      .not.toBeInTheDocument();
  });
});

describe("ShopSocket", () => {
  /**
   * The test registry's client is in memory, so "no socket" is read as nothing named and no
   * list read: the socket stays unnamed, and the seeded page shows with nothing refetching it
   * (no holder mounts the notices). The in-memory actor has no `MerchantListOrders`, so a read
   * would fail and the page would say it could not load the orders.
   */
  it("a page that seeds without a holder shows its seeded data and opens no socket", async () => {
    const data: OrdersIndexData = {
      page: {
        orders: [],
        limit: 25,
        nextCursor: null,
        counts: { no_workflow: 0, not_started: 0, making: 0, made: 0, issues: 0 },
        openOrders: 0,
        matches: null,
      },
      syncState: { inFlight: false, lastError: null },
      teams: [],
    };
    const registry = shopTestRegistry({
      MerchantSyncStatus: () => Effect.succeed({ inFlight: false, lastError: null }),
    });
    const screen = await renderInApp(
      <OrdersIndexPage
        usage={NO_USAGE}
        data={data}
        q={null}
        show={null}
        team={null}
        after={null}
        orderLink={() => ({ href: "/app/orders", onClick: () => {} })}
        onFilter={() => {}}
        onNextPage={() => {}}
        onPreviousPage={() => {}}
      />,
      registry,
    );
    await expect.element(screen.getByText("No open orders")).toBeVisible();
    expect(Option.isNone(registry.get(shopKeyAtom))).toBe(true);
    await expect.element(screen.getByText("Couldn't load orders.")).not.toBeInTheDocument();
  });
});

/** The socket error a close with `code` is, as the retry policy sees it. */
const closeError = (code: number) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });

/** `holder` under a one-route memory router, whose `invalidate` the test watches. */
const inRouter = (holder: React.ReactNode) => {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => holder }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { router, invalidate: vi.spyOn(router, "invalidate") };
};

describe("ShopSocket close codes", () => {
  it("the tab reconnects on 3401 and not on 4403", async () => {
    expect(isTerminal(closeError(CONNECTION_CLOSE_REVOKED))).toBe(false);
    expect(isTerminal(closeError(CONNECTION_CLOSE_FORBIDDEN))).toBe(true);
    const registry = shopTestRegistry({});
    await renderInApp(memberHolder, registry);
    await closeWith(registry, CONNECTION_CLOSE_REVOKED);
    expect(registry.get(connectionStateAtom)).toBe("lost");
    await closeWith(registry, CONNECTION_CLOSE_FORBIDDEN);
    expect(registry.get(connectionStateAtom)).toBe("forbidden");
  });

  it("a 4402 stops the socket and reruns the route's guards, merchant and member alike", async () => {
    expect(isTerminal(closeError(CONNECTION_CLOSE_PAYMENT_REQUIRED))).toBe(true);
    for (const merchant of [true, false]) {
      const registry = shopTestRegistry({});
      const { router, invalidate } = inRouter(
        <ShopSocket
          shop={SEED_SHOP}
          merchantToken={merchant ? Option.some(Effect.succeed("token")) : Option.none()}
        >
          <p>The page</p>
        </ShopSocket>,
      );
      const screen = await renderInApp(<RouterProvider router={router} />, registry);
      await expect.element(screen.getByText("The page")).toBeVisible();
      invalidate.mockClear();
      await closeWith(registry, CONNECTION_CLOSE_PAYMENT_REQUIRED, merchant);
      expect(registry.get(connectionStateAtom)).toBe("forbidden");
      await expect.poll(() => invalidate.mock.calls.length).toBe(1);
      await screen.unmount();
    }
  });
});
