import { describe, expect, it, vi } from "vite-plus/test";
import {
  ManagePlanButton,
  PREPARE_MANAGE_PLAN_WAIT_MS,
} from "../../../../src/web/components/ManagePlanButton.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";

const URL = "https://admin.shopify.com/store/shop/charges/baton-local/pricing_plans";

/** The button with `prepare`, recording each page it opens. */
const press = async (prepare: () => Promise<unknown>) => {
  const opened: Array<string> = [];
  const screen = await renderInApp(
    <ManagePlanButton url={URL} prepare={prepare} open={(href) => opened.push(href)} />,
    shopTestRegistry({}),
  );
  await screen.getByRole("button", { name: "Manage plan" }).click();
  return opened;
};

describe("ManagePlanButton", () => {
  it("opens the pricing page once, after the answer", async () => {
    let answer: () => void = () => {};
    const opened = await press(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    expect(opened).toEqual([]);
    answer();
    await expect.poll(() => opened).toEqual([URL]);
    await new Promise((resolve) => setTimeout(resolve, PREPARE_MANAGE_PLAN_WAIT_MS + 200));
    expect(opened).toEqual([URL]);
  });

  it("opens the pricing page at 1.5 s when the answer is slow, and not again when it comes", async () => {
    let answer: () => void = () => {};
    const started = Date.now();
    const opened = await press(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    await expect.poll(() => opened, { timeout: PREPARE_MANAGE_PLAN_WAIT_MS + 1000 }).toEqual([URL]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(PREPARE_MANAGE_PLAN_WAIT_MS - 50);
    answer();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened).toEqual([URL]);
  });

  it("opens the pricing page when the call fails", async () => {
    const prepare = vi.fn(() => Promise.reject(new Error("unavailable")));
    const opened = await press(prepare);
    await expect.poll(() => opened).toEqual([URL]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
