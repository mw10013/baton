import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it } from "vite-plus/test";
import { LIVE_RETENTION } from "../../../../src/web/client/query.ts";
import {
  liveQuery,
  refreshLive,
  ShopActorClient,
} from "../../../../src/web/client/shop-actor-client.ts";
import { shopTestRegistry } from "../../shop-actor.ts";

const A_KEY = "a";
const B_KEY = "b";

type Live = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;

const show = (registry: AtomRegistry.AtomRegistry, live: Live) => registry.mount(live);
const notice = refreshLive;

let serial = 0;

/** A registry whose `MerchantGetOrderDetail` counts its calls and answers after `delay`. */
const setup = (delay = Duration.millis(20)) => {
  const calls = { count: 0, done: 0 };
  const registry = shopTestRegistry({
    MerchantGetOrderDetail: () =>
      Effect.sync(() => {
        calls.count++;
      }).pipe(
        Effect.andThen(Effect.sleep(delay)),
        Effect.andThen(
          Effect.sync(() => {
            calls.done++;
            return null;
          }),
        ),
      ),
  });
  const id = `live-query-${++serial}`;
  const query = ShopActorClient.query(
    "MerchantGetOrderDetail",
    { legacyId: id },
    { serializationKey: id, timeToLive: LIVE_RETENTION },
  ) as Live;
  const live = liveQuery(query, [A_KEY, B_KEY]);
  const seed = () => {
    if (!Atom.isSerializable(query)) throw new Error("not serializable");
    const { key, encode } = query[Atom.SerializableTypeId];
    registry.setSerializable(key, encode(AsyncResult.success(null)));
  };
  const settled = () =>
    expect
      .poll(() => {
        const result = registry.get(live);
        return AsyncResult.isSuccess(result) && !result.waiting;
      })
      .toBe(true);
  return { registry, calls, live, seed, settled };
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("liveQuery", () => {
  it("a mounted live query refetches on a notice", async () => {
    const t = setup();
    t.seed();
    const hide = show(t.registry, t.live);
    notice(t.registry, [A_KEY]);
    await t.settled();
    expect(t.calls.count).toBe(1);
    hide();
  });

  it("a kept live query nobody shows does not refetch on a notice", async () => {
    const t = setup();
    t.seed();
    show(t.registry, t.live)();
    notice(t.registry, [A_KEY]);
    await pause(100);
    expect(t.calls.count).toBe(0);
  });

  it("a kept live query refetches once when it is shown again after a notice", async () => {
    const t = setup();
    t.seed();
    show(t.registry, t.live)();
    notice(t.registry, [A_KEY]);
    notice(t.registry, [B_KEY]);
    await pause(50);
    const hide = show(t.registry, t.live);
    await t.settled();
    await pause(50);
    expect(t.calls.count).toBe(1);
    hide();
  });

  it("a notice naming two keys refetches a query once", async () => {
    const t = setup();
    t.seed();
    const hide = show(t.registry, t.live);
    notice(t.registry, [A_KEY, B_KEY]);
    await t.settled();
    expect(t.calls.count).toBe(1);
    expect(t.calls.done).toBe(1);
    hide();
  });

  it("an interrupted refetch is never left waiting with nothing in flight", async () => {
    const t = setup(Duration.millis(100));
    t.seed();
    // Left mid-fetch, then a notice while nobody shows it.
    let hide = show(t.registry, t.live);
    notice(t.registry, [A_KEY]);
    await pause(20);
    hide();
    notice(t.registry, [A_KEY]);
    await pause(200);
    hide = show(t.registry, t.live);
    await t.settled();
    // A refresh superseding one in flight, while shown.
    notice(t.registry, [A_KEY]);
    await pause(20);
    t.registry.refresh(t.live);
    await t.settled();
    hide();
    // Left mid-fetch, shown again before it ends.
    hide = show(t.registry, t.live);
    notice(t.registry, [A_KEY]);
    await pause(20);
    hide();
    await pause(20);
    hide = show(t.registry, t.live);
    await t.settled();
    hide();
  });

  it("a seeded live query does not fetch on mount", async () => {
    const t = setup();
    t.seed();
    const hide = show(t.registry, t.live);
    await pause(100);
    expect(t.calls.count).toBe(0);
    expect(AsyncResult.isSuccess(t.registry.get(t.live))).toBe(true);
    hide();
  });
});
