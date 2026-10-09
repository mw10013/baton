/**
 * The infrastructure cost model behind `pnpm cost`: what one shop costs
 * Baton per month in Cloudflare charges, at the marginal rates past the
 * Workers Paid plan's included usage, and how hard it drives its Durable
 * Object.
 *
 * Marginal rates only. The plan's included usage (10M Worker requests, 1M
 * object requests, 400k GB-s, 25B rows read, 50M rows written, 5 GB) is
 * already spoken for by the fleet, so every shop is costed as if it were the
 * one past the allowance. Nothing here nets out an allowance.
 *
 * Rates are the published Workers Paid rates, from
 * `refs/cloudflare-docs/src/content/docs/workers/platform/pricing.mdx` and
 * `refs/cloudflare-docs/src/content/partials/durable-objects/durable-objects-pricing.mdx`
 * (SQLite-backed objects) and `refs/cloudflare-docs/src/content/partials/workers/d1-pricing.mdx`.
 *
 * The per-event shops (what a webhook, a verb and a refetch cost the object)
 * are stated once on {@link EventCost}; the figures measured in the repo are
 * cited there. Everything else is arithmetic over a {@link Shop}.
 */

/** Published marginal rates, USD, Workers Paid. */
export const RATES = {
  /** Workers: per million requests past 10M. */
  workerRequestPerMillion: 0.3,
  /** Workers: per million CPU-ms past 30M. */
  workerCpuMsPerMillion: 0.02,
  /** Durable Objects: per million requests past 1M (HTTP, RPC, WebSocket messages at 20:1, alarms). */
  objectRequestPerMillion: 0.15,
  /** Durable Objects: per million GB-s of duration past 400k, at 128 MB per active object. */
  objectGbsPerMillion: 12.5,
  /** Object SQLite and D1 alike: per million rows read past 25B. */
  rowsReadPerMillion: 0.001,
  /** Object SQLite and D1 alike: per million rows written past 50M. Deletes count. */
  rowsWrittenPerMillion: 1,
  /** Object SQLite stored data: per GB-month past 5 GB. */
  objectStorageGbMonth: 0.2,
  /** D1 stored data: per GB-month past 5 GB. */
  d1StorageGbMonth: 0.75,
  /** A ratio Cloudflare applies to incoming WebSocket messages when billing object requests. */
  webSocketMessagesPerRequest: 20,
  /** Memory an active object is billed for, in GB. */
  objectMemoryGb: 0.128,
} as const;

/** Published limits that bound a shop; the model reports distance from them. */
export const LIMITS = {
  /** SQLite storage per Durable Object, bytes (GB = 1e9). */
  objectStorageBytes: 10e9,
  /** The soft limit on requests per second to one object. */
  objectRequestsPerSecondSoft: 1000,
  /** Cloudflare's own figure for moderate work (JSON parsing, validation) per object. */
  objectRequestsPerSecondModerate: 500,
  /** WebSocket connections per object under the hibernation API. */
  webSocketsPerObject: 32_768,
} as const;

/**
 * What the object does per event, as the model assumes it. These are the
 * figures a measurement replaces; each says where it came from.
 */
export const EventCost = {
  /**
   * An order webhook: the Worker verifies the HMAC (one Worker request),
   * calls the object once, and the object fetches the order from Shopify
   * inside the call. Wall time is billed while the fetch waits, so the fetch
   * is most of the duration.
   */
  webhook: {
    workerRequests: 1,
    objectRequests: 1,
    /** Shopify Admin GraphQL round trip from the object, plus the write. Unmeasured; a typical Admin API latency. */
    objectMs: 350,
    /** The order row, its line items, the runs reconcile creates and the usage event: roughly one row per item plus three. */
    rowsWrittenPerItem: 2,
    rowsWrittenFixed: 3,
    /** Workflows by tag, the order's runs, the usage row. */
    rowsRead: 60,
    workerCpuMs: 3,
  },
  /**
   * A member or merchant verb (Start, Done, Block, Cancel) over the screen's
   * socket: an incoming WebSocket message, billed at 20:1, one short write.
   */
  verb: {
    workerRequests: 0,
    objectRequests: 1 / RATES.webSocketMessagesPerRequest,
    objectMs: 15,
    rowsWritten: 4,
    rowsRead: 20,
    workerCpuMs: 0,
  },
  /**
   * One screen's re-read after a publish, or a navigation that runs a loader:
   * a server function (one Worker request) that checks the session in D1
   * and calls the object once (one RPC request). The list is memoized in
   * the object until the next publish (`ShopWorkAgent`'s two caches), so a
   * read after the first for the same key is a hit.
   */
  refetch: {
    workerRequests: 1,
    objectRequests: 1,
    /** Session and member rows the middleware reads in D1 per server function. */
    d1RowsRead: 5,
    workerCpuMs: 4,
    /** A memo hit: decode, serialize, return. */
    hitMs: 3,
    /** Measured 2026-10-03 after the `Run (orderId, state)` index: about 42 rows per open order on the orders index. */
    ordersRowsPerOpenOrder: 42,
    /** Measured 2026-10-03: about 18 rows per open run the member's teams can see, on the workflows list. */
    runsRowsPerOpenRun: 18,
    /** SQLite row-read cost in the object, wall ms per row read, as the 586 ms at 9M rows measured 2026-10-03 suggests. */
    msPerRowRead: 0.00007,
  },
  /** The retention sweep: rides the webhook path, at most every 6 hours, 200 deletes a pass. */
  sweep: {
    passesPerMonth: 120,
    rowsReadPerPass: 300,
  },
} as const;

/** Bytes a stored order costs, from the DDL on `initializeSchema`. Unmeasured estimates per row. */
export const StorageRows = {
  orderRow: 400,
  lineItemRow: 600,
  runRow: 700,
  runTaskRow: 350,
  /** Index overhead on top of the rows. */
  indexFactor: 1.4,
  /** Orders are kept this long, open or closed. */
  retentionDays: 365,
} as const;

/** A shop, as the model sees it: who is on it, what moves, and how it moves. */
export interface Shop {
  /** Members with a sign-in. */
  readonly members: number;
  /** Shopify staff with the app open; two is a typical medium shop. */
  readonly merchants: number;
  /** Open orders stored at one moment: the quantity every list read is linear in. */
  readonly openOrders: number;
  /** New orders synced per month. */
  readonly newOrdersPerMonth: number;
  /** Line items per order that match a workflow: one run each. */
  readonly itemsPerOrder: number;
  /** Tasks per run; each is a Start and a Done. */
  readonly tasksPerRun: number;
  /** Webhook deliveries per order over its life (create, paid, edits, fulfil). */
  readonly webhooksPerOrder: number;
  /** The share of members and merchants with a visible live screen at any moment; 1 is everyone, always. */
  readonly liveScreens: number;
  /** Distinct team sets among the members: distinct workflows-list memo keys per publish. */
  readonly teamSets: number;
  /** Distinct orders-index filter keys the merchants hold open: distinct orders memo keys per publish. */
  readonly merchantFilters: number;
  /** The share of open runs a member's teams can see. */
  readonly teamShare: number;
  /** Navigations per live screen per working day that run a loader read. */
  readonly pageviewsPerScreenPerDay: number;
  /** Working days a month, for the peak-hour figures. */
  readonly workingDays: number;
  /** Working hours a day, for the peak-hour figures. */
  readonly workingHours: number;
  /** How much busier the busiest hour is than the average working hour. */
  readonly peakFactor: number;
}

export const DEFAULT_SHOP: Shop = {
  members: 12,
  merchants: 2,
  openOrders: 500,
  newOrdersPerMonth: 1000,
  itemsPerOrder: 2,
  tasksPerRun: 4,
  webhooksPerOrder: 6,
  liveScreens: 1,
  teamSets: 4,
  merchantFilters: 2,
  teamShare: 0.5,
  pageviewsPerScreenPerDay: 40,
  workingDays: 22,
  workingHours: 8,
  peakFactor: 3,
};

/** One billed quantity. */
export interface CostLine {
  readonly item: string;
  readonly quantity: number;
  readonly unit: string;
  /** The published rate, per million units unless `rateLabel` says otherwise. */
  readonly ratePerMillion: number;
  /** The rate as the pricing page states it. */
  readonly rateLabel: string;
  readonly usd: number;
}

export interface CostReport {
  readonly shop: Shop;
  readonly lines: readonly CostLine[];
  readonly totalUsd: number;
  /** Bytes the object stores for this shop. */
  readonly storageBytes: number;
  /** The share of the 10 GB object limit used. */
  readonly storageShare: number;
  /** Publishes per month: every write that invalidates. */
  readonly publishesPerMonth: number;
  /** Live connections one publish reaches. */
  readonly connectionsPerPublish: number;
  /** Object requests per second in the busiest hour. */
  readonly peakRequestsPerSecond: number;
  /** The share of the busiest hour the single-threaded object spends busy. */
  readonly peakObjectBusyShare: number;
  /** Cost of one more member a month, everything else fixed. */
  readonly marginalMemberUsd: number;
  /** Cost of one more new order a month (with its share of open orders), everything else fixed. */
  readonly marginalOrderUsd: number;
}

const line = (
  item: string,
  quantity: number,
  unit: string,
  ratePerMillion: number,
  rateLabel = `$${String(ratePerMillion)} / M`,
): CostLine => ({
  item,
  quantity,
  unit,
  ratePerMillion,
  rateLabel,
  usd: (quantity / 1e6) * ratePerMillion,
});

interface Totals {
  workerRequests: number;
  workerCpuMs: number;
  objectRequests: number;
  objectMs: number;
  rowsRead: number;
  rowsWritten: number;
  d1RowsRead: number;
}

/** The month's quantities, before pricing. */
export const quantities = (shop: Shop): Totals => {
  const t: Totals = {
    workerRequests: 0,
    workerCpuMs: 0,
    objectRequests: 0,
    objectMs: 0,
    rowsRead: 0,
    rowsWritten: 0,
    d1RowsRead: 0,
  };
  const connections = (shop.members + shop.merchants) * shop.liveScreens;
  const runsPerMonth = shop.newOrdersPerMonth * shop.itemsPerOrder;

  // Webhooks.
  const webhooks = shop.newOrdersPerMonth * shop.webhooksPerOrder;
  const w = EventCost.webhook;
  t.workerRequests += webhooks * w.workerRequests;
  t.workerCpuMs += webhooks * w.workerCpuMs;
  t.objectRequests += webhooks * w.objectRequests;
  t.objectMs += webhooks * w.objectMs;
  t.rowsRead += webhooks * w.rowsRead;
  t.rowsWritten +=
    webhooks * (w.rowsWrittenFixed + w.rowsWrittenPerItem * shop.itemsPerOrder);

  // Verbs: a Start and a Done per task, plus one run-level verb per run.
  const verbs = runsPerMonth * (shop.tasksPerRun * 2 + 1);
  const v = EventCost.verb;
  t.objectRequests += verbs * v.objectRequests;
  t.objectMs += verbs * v.objectMs;
  t.rowsRead += verbs * v.rowsRead;
  t.rowsWritten += verbs * v.rowsWritten;

  // Publishes: every webhook and every verb. Each live screen re-reads once.
  const publishes = webhooks + verbs;
  const r = EventCost.refetch;
  const refetches = publishes * connections;
  const ordersMissRows = r.ordersRowsPerOpenOrder * shop.openOrders;
  const runsMissRows =
    r.runsRowsPerOpenRun *
    shop.openOrders *
    shop.itemsPerOrder *
    shop.teamShare;
  const missRowsPerPublish =
    Math.min(shop.merchantFilters, shop.merchants * shop.liveScreens) *
      ordersMissRows +
    Math.min(shop.teamSets, shop.members * shop.liveScreens) * runsMissRows;
  t.workerRequests += refetches * r.workerRequests;
  t.workerCpuMs += refetches * r.workerCpuMs;
  t.objectRequests += refetches * r.objectRequests;
  t.d1RowsRead += refetches * r.d1RowsRead;
  t.objectMs +=
    refetches * r.hitMs + publishes * missRowsPerPublish * r.msPerRowRead;
  t.rowsRead += publishes * missRowsPerPublish;

  // Pageviews: loader reads between publishes, memo hits.
  const pageviews =
    connections * shop.pageviewsPerScreenPerDay * shop.workingDays;
  t.workerRequests += pageviews * r.workerRequests;
  t.workerCpuMs += pageviews * r.workerCpuMs;
  t.objectRequests += pageviews * r.objectRequests;
  t.objectMs += pageviews * r.hitMs;
  t.d1RowsRead += pageviews * r.d1RowsRead;

  // Retention sweep: a year on, every row an order brought is deleted, and a delete is a write.
  const s = EventCost.sweep;
  t.rowsRead += s.passesPerMonth * s.rowsReadPerPass;
  t.rowsWritten +=
    shop.newOrdersPerMonth * (1 + shop.itemsPerOrder * (2 + shop.tasksPerRun));

  return t;
};

/** Bytes the object holds for a shop: a year of orders, every one with its items, runs and tasks. */
export const storageBytes = (shop: Shop): number => {
  const stored = Math.max(
    shop.openOrders,
    (shop.newOrdersPerMonth * StorageRows.retentionDays) / 30,
  );
  const perOrder =
    StorageRows.orderRow +
    shop.itemsPerOrder *
      (StorageRows.lineItemRow +
        StorageRows.runRow +
        shop.tasksPerRun * StorageRows.runTaskRow);
  return stored * perOrder * StorageRows.indexFactor;
};

const priceTotals = (shop: Shop, t: Totals): readonly CostLine[] => {
  const gbs = (t.objectMs / 1000) * RATES.objectMemoryGb;
  const bytes = storageBytes(shop);
  return [
    line(
      "Worker requests",
      t.workerRequests,
      "requests",
      RATES.workerRequestPerMillion,
    ),
    line("Worker CPU", t.workerCpuMs, "CPU-ms", RATES.workerCpuMsPerMillion),
    line(
      "Object requests",
      t.objectRequests,
      "requests",
      RATES.objectRequestPerMillion,
    ),
    line("Object duration", gbs, "GB-s", RATES.objectGbsPerMillion),
    line("Object rows read", t.rowsRead, "rows", RATES.rowsReadPerMillion),
    line(
      "Object rows written",
      t.rowsWritten,
      "rows",
      RATES.rowsWrittenPerMillion,
    ),
    line(
      "Object storage",
      bytes / 1e9,
      "GB-month",
      RATES.objectStorageGbMonth * 1e6,
      `$${String(RATES.objectStorageGbMonth)} / GB`,
    ),
    line("D1 rows read", t.d1RowsRead, "rows", RATES.rowsReadPerMillion),
  ];
};

const totalUsd = (shop: Shop): number =>
  priceTotals(shop, quantities(shop)).reduce((sum, l) => sum + l.usd, 0);

/** The whole report for one shop. */
export const cost = (shop: Shop): CostReport => {
  const t = quantities(shop);
  const lines = priceTotals(shop, t);
  const total = lines.reduce((sum, l) => sum + l.usd, 0);
  const bytes = storageBytes(shop);
  const connections = (shop.members + shop.merchants) * shop.liveScreens;
  const webhooks = shop.newOrdersPerMonth * shop.webhooksPerOrder;
  const verbs =
    shop.newOrdersPerMonth * shop.itemsPerOrder * (shop.tasksPerRun * 2 + 1);
  const publishes = webhooks + verbs;
  const workingSeconds = shop.workingDays * shop.workingHours * 3600;
  const peakRequestsPerSecond =
    ((t.objectRequests + verbs * (1 - EventCost.verb.objectRequests)) /
      workingSeconds) *
    shop.peakFactor;
  const peakObjectBusyShare =
    (t.objectMs / 1000 / workingSeconds) * shop.peakFactor;
  const marginalMemberUsd =
    totalUsd({ ...shop, members: shop.members + 1 }) - total;
  const marginalOrderUsd =
    totalUsd({
      ...shop,
      newOrdersPerMonth: shop.newOrdersPerMonth + 100,
      openOrders:
        shop.openOrders + (100 * shop.openOrders) / shop.newOrdersPerMonth,
    }) /
      100 -
    total / 100;
  return {
    shop,
    lines,
    totalUsd: total,
    storageBytes: bytes,
    storageShare: bytes / LIMITS.objectStorageBytes,
    publishesPerMonth: publishes,
    connectionsPerPublish: connections,
    peakRequestsPerSecond,
    peakObjectBusyShare,
    marginalMemberUsd,
    marginalOrderUsd,
  };
};

/**
 * Named shops the ladder prints: a small-to-medium ladder and the fences past
 * it. `ceiling` is the members ceiling, `ShopLimits.maxMembers` (50) at the
 * open-order ceiling, `ShopLimits.maxOpenOrders` (2,500); `stress` is past
 * it, the shop the ceiling refuses, kept to show where queueing starts.
 */
export const PRESETS: Record<string, Partial<Shop>> = {
  solo: {
    members: 1,
    merchants: 1,
    openOrders: 40,
    newOrdersPerMonth: 60,
    teamSets: 1,
    merchantFilters: 1,
  },
  small: {
    members: 5,
    merchants: 2,
    openOrders: 150,
    newOrdersPerMonth: 250,
    teamSets: 3,
  },
  medium: {
    members: 12,
    merchants: 2,
    openOrders: 500,
    newOrdersPerMonth: 1000,
    teamSets: 4,
  },
  large: {
    members: 25,
    merchants: 2,
    openOrders: 1500,
    newOrdersPerMonth: 2500,
    teamSets: 6,
  },
  ceiling: {
    members: 50,
    merchants: 3,
    openOrders: 2500,
    newOrdersPerMonth: 5000,
    teamSets: 8,
  },
  stress: {
    members: 100,
    merchants: 3,
    openOrders: 2500,
    newOrdersPerMonth: 10_000,
    teamSets: 12,
  },
};

export const shopOfPreset = (name: string): Shop => ({
  ...DEFAULT_SHOP,
  ...PRESETS[name],
});
