import type { ShopifyError } from "@/lib/Shopify";

import { Context, Effect, Layer, Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";

/**
 * Substituted with the run's real filter before submission. A literal stands in
 * the document so `pnpm graphql-codegen` validates the nested bulk query too,
 * not only the mutation that carries it — the query Shopify executes
 * asynchronously is otherwise just an unchecked string variable.
 *
 * The operation must be **named**: codegen loads every tagged document in a
 * file together, and an anonymous operation is only valid when it is the sole
 * operation in its document.
 *
 * No `first` and no `pageInfo` — both are ignored inside a bulk query, and
 * Shopify flattens `lineItems` onto their own NDJSON lines carrying
 * `__parentId`. `__typename` is selected on both levels because the line
 * schemas in {@link ShopAgentOrdersStream} tag on it.
 */
const BULK_ORDERS_FILTER = "__ORDER_SYNC_FILTER__";

/** See {@link bulkOrdersQueryText}; first sync only. */
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
        closedAt
        displayFinancialStatus
        displayFulfillmentStatus
        fullyPaid
        tags
        note
        customAttributes { key value }
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
              unfulfilledQuantity
              nonFulfillableQuantity
              requiresShipping
              customAttributes { key value }
              variant { id }
              product { id tags }
            }
          }
        }
      }
    }
  }
}`;

/**
 * A maker's day-one working set is the orders still to be made, so the first
 * sync — the one keyed on `created_at`, see `orderSyncWindow` — asks Shopify
 * only for those: everything already shipped, closed, or cancelled inside the
 * window has no production value and would occupy the object's SQLite for
 * nothing. Later syncs are keyed on `updated_at` and deliberately carry no
 * such filter, so an order that fulfils after it was imported is *updated*
 * rather than left behind at its last open state.
 *
 * `status:open` is Shopify's "neither closed nor cancelled";
 * `-fulfillment_status:fulfilled` is the negation of fully fulfilled, which
 * keeps partially fulfilled orders — still work on the floor — in the set.
 * `unshipped` is deliberately not used: Shopify defines it as
 * `fulfillment_status` *null*, which drops exactly those partials. No
 * `financial_status` term either: an unpaid order is work the maker will see
 * as soon as payment lands, and `Domain.canStartRuns` already keeps runs off
 * it until then.
 *
 * `windowStart` is inclusive and formatted as ISO 8601, which the order search
 * syntax accepts for both `created_at` and `updated_at`.
 */
export const bulkOrdersQueryText = ({
  field,
  windowStart,
}: {
  readonly field: Domain.OrderSyncField;
  readonly windowStart: number;
}) =>
  BulkOrdersQuery.replace(
    BULK_ORDERS_FILTER,
    `${field}:>='${new Date(windowStart).toISOString()}'${
      field === "created_at" ? ` ${OPEN_WORK_FILTER}` : ""
    }`,
  );

const UserError = Schema.Struct({
  field: Schema.NullOr(Schema.Array(Schema.String)),
  message: Schema.String,
});

const RunBulkOrdersQueryResponse = Schema.Struct({
  bulkOperationRunQuery: Schema.Struct({
    bulkOperation: Schema.NullOr(Domain.BulkOperation),
    userErrors: Schema.Array(UserError),
  }),
});

const GetBulkOperationResponse = Schema.Struct({
  bulkOperation: Schema.NullOr(Domain.BulkOperation),
});

export class OrdersBulkRepositoryError extends Schema.TaggedError<OrdersBulkRepositoryError>()(
  "OrdersBulkRepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const failUserError = (
  operation: string,
  userErrors: readonly (typeof UserError.Type)[],
) =>
  Effect.fail(
    new OrdersBulkRepositoryError({
      message: `${operation} failed: ${userErrors.map(({ message }) => message).join("; ")}`,
      cause: userErrors,
    }),
  );

export class OrdersBulkRepository extends Context.Service<
  OrdersBulkRepository,
  {
    /**
     * `groupObjects: false` keeps the flat one-object-per-line JSONL the
     * streaming reader depends on; grouping would buffer whole orders server
     * side and defeat the constant-memory fold.
     */
    readonly submit: (
      queryText: string,
    ) => Effect.Effect<
      Domain.BulkOperation,
      ShopifyError | OrdersBulkRepositoryError
    >;
    readonly findById: (
      id: string,
    ) => Effect.Effect<Option.Option<Domain.BulkOperation>, ShopifyError>;
  }
>()("OrdersBulkRepository") {
  static readonly layerNoDeps: Layer.Layer<
    OrdersBulkRepository,
    never,
    ShopifyAdmin
  > = Layer.effect(
    OrdersBulkRepository,
    Effect.gen(function* () {
      const admin = yield* ShopifyAdmin;

      return OrdersBulkRepository.of({
        submit: Effect.fn("OrdersBulkRepository.submit")(function* (
          queryText: string,
        ) {
          const { bulkOperationRunQuery } = yield* admin.graphqlDecode(
            RunBulkOrdersQueryResponse,
            `#graphql
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
            }`,
            { variables: { query: queryText } },
          );
          if (bulkOperationRunQuery.userErrors.length > 0)
            return yield* failUserError(
              "Run bulk orders query",
              bulkOperationRunQuery.userErrors,
            );
          if (bulkOperationRunQuery.bulkOperation === null)
            return yield* Effect.fail(
              new OrdersBulkRepositoryError({
                message: "Run bulk orders query returned no bulk operation",
                cause: bulkOperationRunQuery,
              }),
            );
          return bulkOperationRunQuery.bulkOperation;
        }),

        findById: Effect.fn("OrdersBulkRepository.findById")(function* (
          id: string,
        ) {
          const { bulkOperation } = yield* admin.graphqlDecode(
            GetBulkOperationResponse,
            `#graphql
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
            }`,
            { variables: { id } },
          );
          return Option.fromNullOr(bulkOperation);
        }),
      });
    }),
  );
}
