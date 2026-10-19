import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it } from "vite-plus/test";
import { ShopActorClient } from "../../../../src/web/client/shop-actor-client.ts";
import { shopTestRegistry } from "../../shop-actor.ts";

const RETENTION = Duration.minutes(5);
const A_KEY = "a";
const B_KEY = "b";

type Live = Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>;

interface Variant {
  readonly name: string;
  readonly live: (query: Live, keys: ReadonlyArray<string>) => Live;
  readonly show: (registry: AtomRegistry.AtomRegistry, live: Live) => () => void;
  readonly notice: (registry: AtomRegistry.AtomRegistry, keys: ReadonlyArray<string>) => void;
}

/**
 * (B) Atom's own laziness: the wrapper reads the query as a tracked dependency, so the query is
 * observed only while the wrapper is; a notice refreshes the query node itself, which refetches
 * an observed node at once and leaves an unobserved one stale until it is read again.
 */
const variantB = (): Variant => {
  const keysOf = new WeakMap<Atom.Atom<any>, ReadonlyArray<string>>();
  return {
    name: "B",
    live: (query, keys) => {
      keysOf.set(query, keys);
      return Atom.transform(query, (get) => get(query), { initialValueTarget: query }).pipe(
        Atom.setIdleTTL(RETENTION),
      );
    },
    show: (registry, live) => registry.mount(live),
    notice: (registry, keys) => {
      for (const node of registry.getNodes().values()) {
        const own = keysOf.get(node.atom);
        if (own !== undefined && own.some((key) => keys.includes(key))) registry.refresh(node.atom);
      }
    },
  };
};

let serial = 0;

/** A registry whose `MerchantGetOrderDetail` counts its calls and answers after `delay`. */
const setup = (variant: Variant, delay = Duration.millis(20)) => {
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
  const id = `spike-${variant.name}-${++serial}`;
  const query = ShopActorClient.query(
    "MerchantGetOrderDetail",
    { legacyId: id },
    { serializationKey: id, timeToLive: RETENTION },
  ) as Live;
  const live = variant.live(query, [A_KEY, B_KEY]);
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

for (const variant of [variantB()]) {
  describe(`spike S1, variant ${variant.name}`, () => {
    it("a mounted live query refetches on a notice", async () => {
      const t = setup(variant);
      t.seed();
      const hide = variant.show(t.registry, t.live);
      variant.notice(t.registry, [A_KEY]);
      await t.settled();
      expect(t.calls.count).toBe(1);
      hide();
    });

    it("a kept live query nobody shows does not refetch on a notice", async () => {
      const t = setup(variant);
      t.seed();
      variant.show(t.registry, t.live)();
      variant.notice(t.registry, [A_KEY]);
      await pause(100);
      expect(t.calls.count).toBe(0);
    });

    it("a kept live query refetches once when it is shown again after a notice", async () => {
      const t = setup(variant);
      t.seed();
      variant.show(t.registry, t.live)();
      variant.notice(t.registry, [A_KEY]);
      variant.notice(t.registry, [B_KEY]);
      await pause(50);
      const hide = variant.show(t.registry, t.live);
      await t.settled();
      await pause(50);
      expect(t.calls.count).toBe(1);
      hide();
    });

    it("a notice naming two keys refetches a query once", async () => {
      const t = setup(variant);
      t.seed();
      const hide = variant.show(t.registry, t.live);
      variant.notice(t.registry, [A_KEY, B_KEY]);
      await t.settled();
      expect(t.calls.count).toBe(1);
      expect(t.calls.done).toBe(1);
      hide();
    });

    it("an interrupted refetch is never left waiting with nothing in flight", async () => {
      const t = setup(variant, Duration.millis(100));
      t.seed();
      // Left mid-fetch, then a notice while nobody shows it.
      let hide = variant.show(t.registry, t.live);
      variant.notice(t.registry, [A_KEY]);
      await pause(20);
      hide();
      variant.notice(t.registry, [A_KEY]);
      await pause(200);
      hide = variant.show(t.registry, t.live);
      await t.settled();
      // A refresh superseding one in flight, while shown.
      variant.notice(t.registry, [A_KEY]);
      await pause(20);
      t.registry.refresh(t.live);
      await t.settled();
      hide();
      // Left mid-fetch, shown again before it ends.
      hide = variant.show(t.registry, t.live);
      variant.notice(t.registry, [A_KEY]);
      await pause(20);
      hide();
      await pause(20);
      hide = variant.show(t.registry, t.live);
      await t.settled();
      hide();
    });

    it("a seeded live query does not fetch on mount", async () => {
      const t = setup(variant);
      t.seed();
      const hide = variant.show(t.registry, t.live);
      await pause(100);
      expect(t.calls.count).toBe(0);
      expect(AsyncResult.isSuccess(t.registry.get(t.live))).toBe(true);
      hide();
    });
  });
}
