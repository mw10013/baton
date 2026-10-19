import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "vite-plus/test";
import { liveLoad, reloadFromServer, seed } from "../../../../src/web/client/live-load.ts";
import { merchantUsageQuery } from "../../../../src/web/client/shop-actor-client.ts";
import { shopTestRegistry } from "../../shop-actor.ts";
import { NO_USAGE } from "../../usage.ts";

/** A registry whose socket counts its usage reads, and a loader fetch that counts its own. */
const setup = () => {
  const calls = { socket: 0, http: 0 };
  const registry = shopTestRegistry({
    MerchantGetUsage: () =>
      Effect.sync(() => {
        calls.socket++;
        return NO_USAGE;
      }),
  });
  const fetch = () => {
    calls.http++;
    return Promise.resolve({ ...NO_USAGE, ordersThisCycle: 7 });
  };
  return { registry, calls, fetch };
};

describe("liveLoad in the browser", () => {
  it("a kept read answers the loader with no request", async () => {
    const t = setup();
    seed(t.registry, merchantUsageQuery, { ...NO_USAGE, ordersThisCycle: 3 }, 1_000);
    const answer = await liveLoad({
      registry: t.registry,
      query: merchantUsageQuery,
      fetch: t.fetch,
    });
    expect(answer.ordersThisCycle).toBe(3);
    expect(t.calls).toEqual({ socket: 0, http: 0 });
  });

  it("an absent read is fetched and seeded", async () => {
    const t = setup();
    const before = Date.now();
    const answer = await liveLoad({
      registry: t.registry,
      query: merchantUsageQuery,
      fetch: t.fetch,
    });
    expect(answer.ordersThisCycle).toBe(7);
    const result = t.registry.get(merchantUsageQuery);
    expect(AsyncResult.isSuccess(result) && result.value.ordersThisCycle).toBe(7);
    expect(AsyncResult.isSuccess(result) && result.timestamp >= before).toBe(true);
    expect(t.calls).toEqual({ socket: 0, http: 1 });
  });

  it("a reload from the server reads over HTTP even when the read is kept", async () => {
    const t = setup();
    seed(t.registry, merchantUsageQuery, NO_USAGE, 1_000);
    let answer: { readonly ordersThisCycle: number } | undefined;
    await reloadFromServer(t.registry, {
      invalidate: async () => {
        answer = await liveLoad({
          registry: t.registry,
          query: merchantUsageQuery,
          fetch: t.fetch,
        });
      },
    });
    expect(answer?.ordersThisCycle).toBe(7);
    const result = t.registry.get(merchantUsageQuery);
    expect(AsyncResult.isSuccess(result) && result.value.ordersThisCycle).toBe(7);
    expect(t.calls).toEqual({ socket: 0, http: 1 });
    const after = await liveLoad({
      registry: t.registry,
      query: merchantUsageQuery,
      fetch: t.fetch,
    });
    expect(after.ordersThisCycle).toBe(7);
    expect(t.calls).toEqual({ socket: 0, http: 1 });
  });
});
