import { Schema } from "effect";

import * as Domain from "@/lib/Domain";

/** The orders index's page size: one page of an index table, the controls table's 25 rows (`Control` in `Screen.ts`). */
export const ORDERS_PAGE_SIZE = 25;

/**
 * The orders index's `listOrders` input for its URL: the page size, then
 * the page, the search and the filters as the URL has them, `null` for each
 * key the URL leaves out.
 */
export const ordersIndexInput = ({
  after,
  q,
  show,
  team,
}: {
  readonly after: typeof Domain.OrdersCursor.Type | null;
  readonly q: Domain.ListSearch | null;
  readonly show: Domain.OrdersShow | null;
  readonly team: Domain.TeamId | null;
}): Domain.ListOrdersInput => ({
  limit: ORDERS_PAGE_SIZE,
  cursor: after,
  q,
  show,
  team,
});

/**
 * **The orders index on arrival and the home page read the same
 * `listOrders` input**: {@link ordersIndexInput} with every key left out,
 * one page of {@link ORDERS_PAGE_SIZE}, no cursor, no search, no Show value
 * (Making, the default) and no team. So the two share one entry of the
 * object's orders memo (`ordersMemo`, keyed by the input and cleared on
 * every publish, the rule on `ShopAgent.publish`) and one React Query cache
 * entry ({@link ordersQueryKey}). After a publish the first of them to
 * refetch pays the read and the other gets the entry. A second input (a
 * counts-only read, a different page size) is a second memo key and so a
 * second read per publish. The home page takes only `page.counts` from the
 * answer; the page rows it discards were read for the memo entry anyway.
 */
export const ORDERS_ARRIVAL_INPUT: Domain.ListOrdersInput = ordersIndexInput({
  after: null,
  q: null,
  show: null,
  team: null,
});

/**
 * The orders strip, left to right, on the orders index and the home page:
 * the four positions No workflow, Not started, Making and Made in the order
 * an order moves, then Issues, which cuts across them. These are the five
 * values `Domain.OrderCounts` counts; each cell is the value's name over its
 * count. On the orders index choosing a cell sets the Show filter; on the
 * home page a cell links to the orders index with that value chosen. Making
 * is the default, `?show=` left out. Open, Unpaid, Fulfilled, Cancelled and
 * All carry no count and live in the Show select. Labels are
 * `Domain.ORDERS_SHOW_LABEL`.
 */
export const ORDERS_STRIP: readonly (keyof Domain.OrderCounts)[] = [
  "no_workflow",
  "not_started",
  "making",
  "made",
  "issues",
];

/**
 * Keyed by every filter, the search and the page as well as the shop: each
 * combination is a different read, and the order page's invalidation of
 * `["orders", shop]` is a prefix match so it still reaches every one of them.
 * Built from the read's own input, so two screens that read one input share
 * one cache entry ({@link ORDERS_ARRIVAL_INPUT}).
 */
export const ordersQueryKey = (
  shop: string,
  { q, show, team, cursor }: Domain.ListOrdersInput,
) => ["orders", shop, q, show, team, cursor] as const;

/**
 * `Schema.toType`, not the schema itself. A Durable Object RPC result has
 * already been through the repository's decoder, so what arrives is the
 * **decoded** shape — `fullyPaid` a boolean, `properties` an array. Decoding it again
 * against `Domain.OrdersIndexData` would demand the *encoded* row shape (`0`/`1`,
 * a JSON string) and fail on the first order. `toType` derives a validator over
 * the decoded side, so the wire value is checked without re-running transforms
 * that already ran. Same reasoning as the better-auth boundary in `Auth.ts`.
 */
export const decodeOrdersIndexData = Schema.decodeUnknownPromise(
  Schema.toType(Domain.OrdersIndexData),
);
