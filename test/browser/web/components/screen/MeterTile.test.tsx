import { describe, expect, it } from "vite-plus/test";
import { MeterTile } from "../../../../../src/web/components/screen/MeterTile.tsx";
import { Tiles } from "../../../../../src/web/components/screen/Tiles.tsx";
import { QuotaBanners } from "../../../../../src/web/components/QuotaBanners.tsx";
import { renderInApp } from "../../../render.tsx";
import { shopTestRegistry } from "../../../shop-actor.ts";
import { NO_USAGE } from "../../../usage.ts";

const noop = () => {};

describe("MeterTile", () => {
  it("a meter past its allowance is a full bar, never an overflow, and says what passing it means", async () => {
    const screen = await renderInApp(
      <Tiles>
        <MeterTile
          heading="Members"
          href="/app/members"
          onClick={noop}
          headline="5 members, 3 included"
          count={5}
          limit={3}
          detail="2 over. Extra members are billed at your plan's rate."
        />
      </Tiles>,
      shopTestRegistry({}),
    );
    const bar = screen.getByRole("progressbar", { name: "Members" });
    await expect.element(bar).toBeVisible();
    await expect.element(bar).toHaveAttribute("max", "3");
    expect((bar.element() as HTMLProgressElement).value).toBe(3);
    expect((bar.element() as HTMLProgressElement).position).toBe(1);
    await expect.element(screen.getByText("5 members, 3 included")).toBeVisible();
    await expect
      .element(screen.getByText("2 over. Extra members are billed at your plan's rate."))
      .toBeVisible();
  });

  it("a meter under its allowance shows the ratio and no line", async () => {
    const screen = await renderInApp(
      <MeterTile
        heading="Orders this billing cycle"
        href="/app/orders"
        onClick={noop}
        headline="50 of 200 included"
        count={50}
        limit={200}
      />,
      shopTestRegistry({}),
    );
    const bar = screen.getByRole("progressbar", { name: "Orders this billing cycle" });
    expect((bar.element() as HTMLProgressElement).position).toBe(0.25);
    await expect.element(screen.getByText("50 of 200 included")).toBeVisible();
    expect(screen.container.querySelector("s-paragraph")).toBeNull();
  });
});

describe("QuotaBanners", () => {
  it("shows nothing until a new order was refused at the order ceiling, then names the remedy", async () => {
    const quiet = await renderInApp(<QuotaBanners usage={NO_USAGE} />, shopTestRegistry({}));
    expect(quiet.container.querySelector("s-banner")).toBeNull();
    await quiet.unmount();
    const limited = await renderInApp(
      <QuotaBanners usage={{ ...NO_USAGE, ordersLimitedAt: 1 }} />,
      shopTestRegistry({}),
    );
    await expect
      .element(
        limited.getByText(
          "New orders stopped syncing at 2,500 open orders. Fulfill or cancel orders in Shopify, then Sync open orders.",
        ),
      )
      .toBeVisible();
  });
});
