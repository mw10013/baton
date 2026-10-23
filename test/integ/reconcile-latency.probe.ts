import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { mkdirSync, writeFileSync } from "node:fs";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import { SEED_SHOP } from "../seed-shops.ts";
import { mintSessionToken } from "../shopify-session-token.ts";
import { dev, integ, openAs } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The reconcile-latency probe: how long the switch's `reconcileAll` takes on a shop at the
 * open-order ceiling, and how long another caller of the same actor waits while it runs. Not a
 * test: `vp run probe:reconcile` runs it, and only with `RECONCILE_PROBE` does the integ project
 * include it. Each run is written to `.logs/probe/reconcile/`.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("reconcile"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const TEAMS = ["Cutting", "Finishing", "Packing", "Sewing"] as const;
const ACTIVE_WORKFLOWS = 6;
const OPEN_ORDERS = Number(process.env.RECONCILE_PROBE_ORDERS ?? 2400);
const TRIALS = 6;
const PROBED_TAG = "embroidered";

const fixture = Schema.decodeUnknownSync(ShopFixtureData)({
  members: [],
  teams: TEAMS.map((name) => ({ name, members: [] })),
  workflows: [
    ...Array.from({ length: ACTIVE_WORKFLOWS }, (_, j) => ({
      name: `Line ${String(j + 1)}`,
      tag: `line-${String(j + 1)}`,
      tasks: [
        { name: "Make", team: TEAMS[j % 3] },
        { name: "Pack", team: "Packing", step: 2 },
      ],
    })),
    {
      name: "Embroider",
      state: "inactive",
      tag: PROBED_TAG,
      tasks: [{ name: "Stitch", team: "Sewing" }],
    },
  ],
  orders: Array.from({ length: OPEN_ORDERS }, (_, i) => ({
    n: 1001 + i,
    placedDaysAgo: i % 60,
    lineItems: [
      { title: "Board", quantity: 1, tags: [`line-${String((i % ACTIVE_WORKFLOWS) + 1)}`] },
      {
        title: "Coasters",
        quantity: 2,
        tags: [`line-${String(((i + 1) % ACTIVE_WORKFLOWS) + 1)}`],
      },
      { title: "Towel", quantity: 1, tags: i % 10 === 0 ? [PROBED_TAG] : [] },
    ],
  })),
});

const median = (xs: ReadonlyArray<number>) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

test(
  "reconcileAll latency and the wait it imposes",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) => c.LoadFixture({ shop: SEED_SHOP, fixture }));
    const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP });
    const workflows = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsPage({ sessionToken, state: null, q: null, after: null }),
    );
    const probed = workflows.workflows.find((workflow) => workflow.tag === PROBED_TAG);
    assert.isDefined(probed, "the probed workflow is listed");
    const workflowId = probed?.id ?? "";

    const trials = yield* Effect.gen(function* () {
      const writer = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      const pinger = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      const ping = Effect.gen(function* () {
        const start = performance.now();
        yield* pinger.client.MerchantWhoAmI();
        return performance.now() - start;
      });
      for (let i = 0; i < 50; i++) yield* ping;
      const idle: Array<number> = [];
      for (let i = 0; i < 200; i++) idle.push(yield* ping);

      const results: Array<{
        readonly state: "active" | "inactive";
        readonly switchMs: number;
        readonly pings: number;
        readonly maxPingMs: number;
        readonly medianPingMs: number;
      }> = [];
      for (let t = 0; t < TRIALS; t++) {
        const state = t % 2 === 0 ? "active" : "inactive";
        const latencies: Array<number> = [];
        let running = process.env.RECONCILE_PROBE_PING !== "0";
        const pings = yield* Effect.forkChild(
          Effect.gen(function* () {
            while (running) latencies.push(yield* ping);
          }),
        );
        const start = performance.now();
        const answer = yield* writer.client.MerchantSetWorkflowState({ workflowId, state });
        const switchMs = performance.now() - start;
        running = false;
        yield* Fiber.join(pings);
        assert.strictEqual(answer._tag, "Ok", `trial ${String(t)}: the switch answered Ok`);
        results.push({
          state,
          switchMs,
          pings: latencies.length,
          maxPingMs: Math.max(...latencies),
          medianPingMs: median(latencies),
        });
      }
      return { idleMedianMs: median(idle), idleMaxMs: Math.max(...idle), results };
    }).pipe(Effect.scoped);

    const runs = yield* integ(backendUrl, (c) =>
      c.ApiWorkflowsPage({ sessionToken, state: null, q: null, after: null }),
    );
    const report = { openOrders: OPEN_ORDERS, ...trials, workflows: runs.workflows.length };
    console.info(JSON.stringify(report, null, 2));
    mkdirSync(".logs/probe/reconcile", { recursive: true });
    writeFileSync(
      `.logs/probe/reconcile/${new Date().toISOString().replaceAll(":", "-")}.json`,
      JSON.stringify(report, null, 2),
    );
  }),
  900_000,
);
