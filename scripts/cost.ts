#!/usr/bin/env node
/**
 * `pnpm cost`: the per-shop infrastructure cost model, at marginal Cloudflare
 * rates. The model is `scripts/lib/cost.ts`; this file is the flags and the
 * tables.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  cost,
  DEFAULT_SHOP,
  EventCost,
  LIMITS,
  PRESETS,
  RATES,
  shopOfPreset,
  type CostReport,
  type Shop,
} from "./lib/cost.ts";

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const num = (n: number) =>
  n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toPrecision(3);

const shopFlags = {
  members: Flag.integer("members").pipe(
    Flag.withDescription("members with a sign-in"),
    Flag.optional,
  ),
  merchants: Flag.integer("merchants").pipe(
    Flag.withDescription("Shopify staff with the app open"),
    Flag.optional,
  ),
  openOrders: Flag.integer("open-orders").pipe(
    Flag.withDescription("open orders stored at one moment"),
    Flag.optional,
  ),
  newOrders: Flag.integer("orders").pipe(
    Flag.withDescription("new orders synced per month"),
    Flag.optional,
  ),
  items: Flag.float("items").pipe(
    Flag.withDescription("line items per order that match a workflow"),
    Flag.optional,
  ),
  tasks: Flag.float("tasks").pipe(
    Flag.withDescription("tasks per run"),
    Flag.optional,
  ),
  webhooks: Flag.float("webhooks").pipe(
    Flag.withDescription("webhook deliveries per order over its life"),
    Flag.optional,
  ),
  liveScreens: Flag.float("live-screens").pipe(
    Flag.withDescription(
      "share of members and merchants with a visible live screen at any moment (1 = everyone, always)",
    ),
    Flag.optional,
  ),
  teamSets: Flag.integer("team-sets").pipe(
    Flag.withDescription("distinct team sets among the members"),
    Flag.optional,
  ),
  merchantFilters: Flag.integer("merchant-filters").pipe(
    Flag.withDescription(
      "distinct orders-index filters the merchants hold open",
    ),
    Flag.optional,
  ),
  teamShare: Flag.float("team-share").pipe(
    Flag.withDescription("share of open runs a member's teams can see"),
    Flag.optional,
  ),
  pageviews: Flag.integer("pageviews").pipe(
    Flag.withDescription("navigations per live screen per working day"),
    Flag.optional,
  ),
  peak: Flag.float("peak").pipe(
    Flag.withDescription(
      "how much busier the busiest hour is than the average working hour",
    ),
    Flag.optional,
  ),
  preset: Flag.choice("preset", Object.keys(PRESETS)).pipe(
    Flag.withDescription("start from a named shop; flags override it"),
    Flag.optional,
  ),
  json: Flag.boolean("json").pipe(Flag.withDefault(false)),
};

type ShopFlags = {
  readonly [
    K in keyof typeof shopFlags
  ]: (typeof shopFlags)[K] extends Flag.Flag<infer A> ? A : never;
};

const pick = <A>(
  o: { readonly _tag: "Some"; readonly value: A } | { readonly _tag: "None" },
  d: A,
): A => (o._tag === "Some" ? o.value : d);

const resolveShop = (f: ShopFlags): Shop => {
  const base =
    f.preset._tag === "Some" ? shopOfPreset(f.preset.value) : DEFAULT_SHOP;
  return {
    ...base,
    members: pick(f.members, base.members),
    merchants: pick(f.merchants, base.merchants),
    openOrders: pick(f.openOrders, base.openOrders),
    newOrdersPerMonth: pick(f.newOrders, base.newOrdersPerMonth),
    itemsPerOrder: pick(f.items, base.itemsPerOrder),
    tasksPerRun: pick(f.tasks, base.tasksPerRun),
    webhooksPerOrder: pick(f.webhooks, base.webhooksPerOrder),
    liveScreens: pick(f.liveScreens, base.liveScreens),
    teamSets: pick(f.teamSets, base.teamSets),
    merchantFilters: pick(f.merchantFilters, base.merchantFilters),
    teamShare: pick(f.teamShare, base.teamShare),
    pageviewsPerScreenPerDay: pick(f.pageviews, base.pageviewsPerScreenPerDay),
    peakFactor: pick(f.peak, base.peakFactor),
  };
};

const renderReport = (r: CostReport): string => {
  const s = r.shop;
  const head = [
    `shop: members=${String(s.members)} merchants=${String(s.merchants)} openOrders=${String(s.openOrders)} orders/month=${String(s.newOrdersPerMonth)} items=${String(s.itemsPerOrder)} tasks=${String(s.tasksPerRun)} webhooks=${String(s.webhooksPerOrder)} liveScreens=${String(s.liveScreens)} teamSets=${String(s.teamSets)} merchantFilters=${String(s.merchantFilters)}`,
    "",
    "| item                | quantity        | unit     | rate        | USD / month |",
    "| ------------------- | --------------- | -------- | ----------- | ----------- |",
  ];
  const rows = r.lines.map(
    (l) =>
      `| ${l.item.padEnd(19)} | ${num(l.quantity).padStart(15)} | ${l.unit.padEnd(8)} | ${l.rateLabel.padStart(11)} | ${usd(l.usd).padStart(11)} |`,
  );
  const tail = [
    `| ${"total".padEnd(19)} | ${"".padStart(15)} | ${"".padEnd(8)} | ${"".padStart(11)} | ${usd(r.totalUsd).padStart(11)} |`,
    "",
    `marginal: member=${usd(r.marginalMemberUsd)}/month order=${usd(r.marginalOrderUsd)}`,
    `storage: ${(r.storageBytes / 1e6).toFixed(0)} MB (${pct(r.storageShare)} of ${String(LIMITS.objectStorageBytes / 1e9)} GB)`,
    `publishes: ${num(r.publishesPerMonth)}/month to ${num(r.connectionsPerPublish)} connections each`,
    `peak hour: ${r.peakRequestsPerSecond.toFixed(1)} object requests/s (soft limit ${String(LIMITS.objectRequestsPerSecondSoft)}, moderate work ${String(LIMITS.objectRequestsPerSecondModerate)}); object busy ${pct(r.peakObjectBusyShare)} of the hour`,
  ];
  return [...head, ...rows, ...tail].join("\n");
};

const shopCommand = Command.make(
  "shop",
  shopFlags,
  Effect.fn(function* (f) {
    const report = cost(resolveShop(f));
    yield* Console.log(
      f.json ? JSON.stringify(report, null, 2) : renderReport(report),
    );
  }),
).pipe(
  Command.withDescription(
    "Cost one shop a month at the given shop (flags override the preset, the preset overrides the defaults)",
  ),
);

const ladderCommand = Command.make(
  "ladder",
  { json: Flag.boolean("json").pipe(Flag.withDefault(false)) },
  Effect.fn(function* ({ json }) {
    const reports = Object.keys(PRESETS).map((name) => ({
      name,
      report: cost(shopOfPreset(name)),
    }));
    if (json) {
      yield* Console.log(JSON.stringify(reports, null, 2));
      return;
    }
    const lines = [
      "| preset  | members | merchants | open | orders/mo | USD/month | /member | /order | storage | peak req/s | object busy |",
      "| ------- | ------- | --------- | ---- | --------- | --------- | ------- | ------ | ------- | ---------- | ----------- |",
      ...reports.map(({ name, report: r }) => {
        const s = r.shop;
        return `| ${name.padEnd(7)} | ${String(s.members).padStart(7)} | ${String(s.merchants).padStart(9)} | ${String(s.openOrders).padStart(4)} | ${String(s.newOrdersPerMonth).padStart(9)} | ${usd(r.totalUsd).padStart(9)} | ${usd(r.marginalMemberUsd).padStart(7)} | ${`$${r.marginalOrderUsd.toFixed(3)}`.padStart(6)} | ${`${(r.storageBytes / 1e6).toFixed(0)} MB`.padStart(7)} | ${r.peakRequestsPerSecond.toFixed(1).padStart(10)} | ${pct(r.peakObjectBusyShare).padStart(11)} |`;
      }),
    ];
    yield* Console.log(lines.join("\n"));
  }),
).pipe(Command.withDescription("Cost every preset shop in one table"));

const ratesCommand = Command.make(
  "rates",
  {},
  Effect.fn(function* () {
    yield* Console.log(
      JSON.stringify({ RATES, LIMITS, EventCost, DEFAULT_SHOP }, null, 2),
    );
  }),
).pipe(
  Command.withDescription(
    "Print the marginal rates, the limits and the per-event assumptions the model uses",
  ),
);

const root = Command.make("cost").pipe(
  Command.withDescription(
    "Infrastructure cost of one shop a month at marginal Workers Paid rates, and how hard it drives its object",
  ),
  Command.withSubcommands([shopCommand, ladderCommand, ratesCommand]),
  Command.withExamples([
    { command: "pnpm cost ladder", description: "every preset, one row each" },
    {
      command: "pnpm cost shop --preset large --members 40",
      description: "the large preset with 40 members",
    },
    {
      command:
        "pnpm cost shop --members 25 --merchants 2 --open-orders 2000 --orders 2000",
      description: "the shop the 2026-10-03 performance research targeted",
    },
  ]),
);

NodeRuntime.runMain(
  root.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer),
  ),
);
