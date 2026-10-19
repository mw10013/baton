import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../domain/platform.ts";
import { BulkOperation } from "../domain/orders.ts";
import { ORDER_SYNC_WINDOW_DAYS } from "../contract/orders.ts";
import { ShopifyAdmin } from "./shopify-admin.ts";

/**
 * Substituted with the run's real filter before submission. A literal stands in
 * the document so a GraphQL validator checks the nested bulk query too,
 * not only the mutation that carries it — the query Shopify executes
 * asynchronously is otherwise just an unchecked string variable.
 *
 * The operation must be **named**: a validator that loads every document in a
 * file together accepts an anonymous operation only when it is the sole
 * operation in its document.
 *
 * No `first` and no `pageInfo` — both are ignored inside a bulk query, and
 * Shopify flattens `lineItems` onto their own NDJSON lines carrying
 * `__parentId`. `__typename` is selected on both levels because the line
 * schemas in `runOrdersStream` tag on it.
 */
const BULK_ORDERS_FILTER = "__ORDER_SYNC_FILTER__";

/**
 * `status:open` is Shopify's "neither closed nor cancelled";
 * `-fulfillment_status:fulfilled` is the negation of fully fulfilled, which
 * keeps partially fulfilled orders — still work on the floor — in the set.
 * `unshipped` is deliberately not used: Shopify defines it as
 * `fulfillment_status` *null*, which drops exactly those partials. No
 * `financial_status` term either: an unpaid order is work the maker will see
 * as soon as payment lands, and `orderCanCreateRuns` already keeps runs off
 * it until then.
 */
const OPEN_WORK_FILTER = "status:open -fulfillment_status:fulfilled";

const BulkOrdersQuery = `#graphql
query BulkOrdersQuery {
  orders(query: "__ORDER_SYNC_FILTER__") {
    edges {
      node {
        __typename
        id
        legacyResourceId
        name
        processedAt
        updatedAt
        cancelledAt
        displayFulfillmentStatus
        fullyPaid
        note
        lineItems {
          edges {
            node {
              __typename
              id
              title
              variantTitle
              sku
              quantity
              currentQuantity
              customAttributes { key value }
              product { tags }
            }
          }
        }
      }
    }
  }
}`;

/**
 * The open-orders sync query, which is the same on every click: the open, unfulfilled
 * orders created in the last {@link ORDER_SYNC_WINDOW_DAYS} days. A maker's
 * working set is the orders still to be made, and everything already fulfilled,
 * closed, or cancelled would occupy the object's SQLite for nothing.
 *
 * Fixed on purpose, with no last-sync marker and no delta window. A
 * parameterised query needs a rule for what the merchant's click means *this*
 * time, and the button then behaves differently on its second press than on
 * its first; ongoing intake is the webhooks' job, not this one's. Because it
 * is fixed, re-running it is always safe: the upsert arbitrates by Shopify's
 * `updatedAt`, so a repeat sync is a few redundant writes and never a
 * regression.
 *
 * The window start is computed at call time, inclusive, and formatted as ISO
 * 8601, which the order search syntax accepts for `created_at`.
 */
export const bulkOrdersQueryText = (now: number) =>
  BulkOrdersQuery.replace(
    BULK_ORDERS_FILTER,
    `created_at:>='${new Date(now - ORDER_SYNC_WINDOW_DAYS * 86_400_000).toISOString()}' ${OPEN_WORK_FILTER}`,
  );

/**
 * `groupObjects: false` keeps the flat one-object-per-line JSONL the
 * streaming reader depends on; grouping would buffer whole orders server
 * side and defeat the constant-memory fold.
 */
const OrdersBulkSync = `#graphql
mutation OrdersBulkSync($query: String!) {
  bulkOperationRunQuery(query: $query, groupObjects: false) {
    bulkOperation {
      id
      status
      errorCode
      createdAt
      completedAt
      objectCount
      fileSize
      url
      partialDataUrl
    }
    userErrors { field message }
  }
}`;

const BulkOperationStatusQuery = `#graphql
query BulkOperationStatus($id: ID!) {
  bulkOperation(id: $id) {
    id
    status
    errorCode
    createdAt
    completedAt
    objectCount
    fileSize
    url
    partialDataUrl
  }
}`;

const OrdersBulkCancel = `#graphql
mutation OrdersBulkCancel($id: ID!) {
  bulkOperationCancel(id: $id) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

const UserError = Schema.Struct({
  field: Schema.NullOr(Schema.Array(Schema.String)),
  message: Schema.String,
});

const RunBulkOrdersQueryResponse = Schema.Struct({
  bulkOperationRunQuery: Schema.Struct({
    bulkOperation: Schema.NullOr(BulkOperation),
    userErrors: Schema.Array(UserError),
  }),
});

const GetBulkOperationResponse = Schema.Struct({
  bulkOperation: Schema.NullOr(BulkOperation),
});

/**
 * The cancel mutation selects `id` and `status` only: the operation is being
 * abandoned, so the counters and the file URL on {@link BulkOperation}
 * are not asked for and the response is decoded against its own shape.
 */
const CancelBulkOperationResponse = Schema.Struct({
  bulkOperationCancel: Schema.Struct({
    bulkOperation: Schema.NullOr(Schema.Struct({ id: Schema.String, status: Schema.String })),
    userErrors: Schema.Array(UserError),
  }),
});

/** Shopify refused a bulk mutation (`userErrors`) or answered no operation. Retrying is pointless. */
export class OrdersBulkOperationError extends Schema.TaggedError<OrdersBulkOperationError>()(
  "OrdersBulkOperationError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const failUserError = (operation: string, userErrors: readonly (typeof UserError.Type)[]) =>
  Effect.fail(
    new OrdersBulkOperationError({
      message: `${operation} failed: ${userErrors.map(({ message }) => message).join("; ")}`,
      cause: userErrors,
    }),
  );

const make = Effect.gen(function* () {
  const admin = yield* ShopifyAdmin;

  /** Submits the bulk query; see {@link OrdersBulkSync} for `groupObjects`. */
  const submit = Effect.fn("OrdersBulkOperation.submit")(function* (
    shop: ShopKey,
    queryText: string,
  ) {
    const { bulkOperationRunQuery } = yield* admin.graphqlDecode(
      shop,
      RunBulkOrdersQueryResponse,
      OrdersBulkSync,
      { variables: { query: queryText } },
    );
    if (bulkOperationRunQuery.userErrors.length > 0)
      return yield* failUserError("Run bulk orders query", bulkOperationRunQuery.userErrors);
    if (bulkOperationRunQuery.bulkOperation === null)
      return yield* Effect.fail(
        new OrdersBulkOperationError({
          message: "Run bulk orders query returned no bulk operation",
          cause: bulkOperationRunQuery,
        }),
      );
    return bulkOperationRunQuery.bulkOperation;
  });

  const findById = Effect.fn("OrdersBulkOperation.findById")(function* (shop: ShopKey, id: string) {
    const { bulkOperation } = yield* admin.graphqlDecode(
      shop,
      GetBulkOperationResponse,
      BulkOperationStatusQuery,
      { variables: { id } },
    );
    return Option.fromNullOr(bulkOperation);
  });

  /**
   * Stops an operation Baton has given up waiting for. A bulk operation
   * outlives the workflow that submitted it — Shopify only fails one after
   * 10 days — and a shop may run at most five concurrent bulk queries of a
   * type, so abandoning one would spend that slot until Shopify reclaimed
   * it. `CANCELING` is not terminal, which is why nothing waits for the
   * result of this call.
   */
  const cancel = Effect.fn("OrdersBulkOperation.cancel")(function* (shop: ShopKey, id: string) {
    const { bulkOperationCancel } = yield* admin.graphqlDecode(
      shop,
      CancelBulkOperationResponse,
      OrdersBulkCancel,
      { variables: { id } },
    );
    if (bulkOperationCancel.userErrors.length > 0)
      return yield* failUserError("Cancel bulk operation", bulkOperationCancel.userErrors);
    return bulkOperationCancel.bulkOperation;
  });

  return { submit, findById, cancel };
});

/**
 * A shop's bulk operations over {@link ShopifyAdmin}: a call takes a shop, never a session.
 * Failures are `ShopifyAdminError` and {@link OrdersBulkOperationError}.
 */
export class OrdersBulkOperation extends Context.Service<
  OrdersBulkOperation,
  Effect.Success<typeof make>
>()("app/OrdersBulkOperation") {
  static readonly layer = Layer.effect(OrdersBulkOperation, make);
}
