import { Data, Effect, Schema } from "effect";

import {
  SHOWCASE_PRODUCTS,
  skuOf,
  type ShowcaseProduct,
} from "../../e2e/showcaseProducts.ts";
import { runCommand } from "./command.ts";

export class ShowcaseStoreError extends Data.TaggedError("ShowcaseStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The Admin API version the operations below were written against; `shopify.app.toml`'s `api_version`. */
const API_VERSION = "2026-10";

/** The tag that marks the open orders this script created, so a second run finds them. */
const SHOWCASE_ORDER_TAG = "showcase";

/**
 * The three real orders the script keeps open, each recognised by its own tag
 * beside {@link SHOWCASE_ORDER_TAG}. Real orders exist so that "Open in Baton
 * on Shopify's order page", Sync open orders and the first-order walk have an
 * order Shopify knows; every other order the help shows is seeded. Items name a
 * showcase product, a variant and the properties a customer would have typed.
 */
const SHOWCASE_ORDERS: readonly {
  readonly tag: string;
  readonly lines: readonly {
    readonly handle: string;
    readonly value: string;
    readonly quantity: number;
    readonly properties: Readonly<Record<string, string>>;
  }[];
}[] = [
  {
    tag: "showcase-board",
    lines: [
      {
        handle: "engraved-cutting-board",
        value: "Maple",
        quantity: 1,
        properties: { "Engraving text": "The Bakers" },
      },
    ],
  },
  {
    tag: "showcase-journal",
    lines: [
      {
        handle: "leather-journal",
        value: "Tan",
        quantity: 1,
        properties: { Initials: "E.M.R." },
      },
    ],
  },
  {
    tag: "showcase-clock-and-blanket",
    lines: [
      {
        handle: "wall-clock",
        value: "Oak",
        quantity: 1,
        properties: { Numerals: "Roman" },
      },
      {
        handle: "embroidered-baby-blanket",
        value: "Cream",
        quantity: 1,
        properties: { "Name to embroider": "Mia" },
      },
    ],
  },
];

const Money = Schema.String;
const StoredProduct = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  title: Schema.String,
  status: Schema.String,
  tags: Schema.Array(Schema.String),
  options: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      optionValues: Schema.Array(Schema.Struct({ name: Schema.String })),
    }),
  ),
  variants: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        sku: Schema.NullOr(Schema.String),
        price: Money,
        selectedOptions: Schema.Array(
          Schema.Struct({ name: Schema.String, value: Schema.String }),
        ),
      }),
    ),
  }),
});
type StoredProduct = typeof StoredProduct.Type;

const StoredOrder = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tags: Schema.Array(Schema.String),
  cancelledAt: Schema.NullOr(Schema.String),
});
type StoredOrder = typeof StoredOrder.Type;

const UserErrors = Schema.Array(Schema.Struct({ message: Schema.String }));

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((entry) => b.includes(entry));

/** True when the store's product already says what the table says; a price compares as a number, since the store writes `68.0` for `68.00`. */
const productMatches = (
  stored: StoredProduct,
  wanted: ShowcaseProduct,
): boolean => {
  const [option] = stored.options;
  return (
    stored.title === wanted.title &&
    stored.status === "ACTIVE" &&
    sameSet(stored.tags, wanted.tags) &&
    stored.options.length === 1 &&
    option?.name === wanted.option &&
    sameSet(
      option.optionValues.map(({ name }) => name),
      wanted.variants.map(({ value }) => value),
    ) &&
    stored.variants.nodes.length === wanted.variants.length &&
    wanted.variants.every((variant) =>
      stored.variants.nodes.some(
        (node) =>
          node.selectedOptions.some(
            ({ name, value }) =>
              name === wanted.option && value === variant.value,
          ) &&
          (node.sku ?? null) === skuOf(wanted, variant.value) &&
          Number(node.price) === Number(variant.price),
      ),
    )
  );
};

/** The `productSet` input for a table row. */
const productSetInput = (wanted: ShowcaseProduct) => ({
  title: wanted.title,
  handle: wanted.handle,
  status: "ACTIVE",
  tags: wanted.tags,
  productOptions: [
    {
      name: wanted.option,
      values: wanted.variants.map(({ value }) => ({ name: value })),
    },
  ],
  variants: wanted.variants.map(({ value, price }) => {
    const sku = skuOf(wanted, value);
    return {
      optionValues: [{ optionName: wanted.option, name: value }],
      price,
      ...(sku === null ? {} : { sku }),
    };
  }),
});

/** The showcase orders that have no open order carrying their tag. */
const missingOrders = (orders: readonly StoredOrder[]) =>
  SHOWCASE_ORDERS.filter(
    (wanted) =>
      !orders.some(
        (order) =>
          order.cancelledAt === null && order.tags.includes(wanted.tag),
      ),
  );

const PRODUCTS_QUERY = /* GraphQL */ `
  query ShowcaseProducts {
    products(first: 100) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        handle
        title
        status
        tags
        options {
          name
          optionValues {
            name
          }
        }
        variants(first: 50) {
          nodes {
            id
            sku
            price
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

const ORDERS_QUERY = /* GraphQL */ `
  query ShowcaseOrders {
    orders(first: 100) {
      pageInfo {
        hasNextPage
      }
      nodes {
        id
        name
        tags
        cancelledAt
      }
    }
  }
`;

const PRODUCT_SET = /* GraphQL */ `
  mutation ShowcaseProductSet(
    $input: ProductSetInput!
    $identifier: ProductSetIdentifiers
  ) {
    productSet(input: $input, identifier: $identifier, synchronous: true) {
      product {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const PRODUCT_ARCHIVE = /* GraphQL */ `
  mutation ShowcaseProductArchive($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const ORDER_CANCEL = /* GraphQL */ `
  mutation ShowcaseOrderCancel($orderId: ID!) {
    orderCancel(
      orderId: $orderId
      reason: OTHER
      restock: false
      notifyCustomer: false
      staffNote: "Closed by pnpm showcase:store"
    ) {
      orderCancelUserErrors {
        message
      }
    }
  }
`;

const DRAFT_ORDER_CREATE = /* GraphQL */ `
  mutation ShowcaseDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const DRAFT_ORDER_COMPLETE = /* GraphQL */ `
  mutation ShowcaseDraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        order {
          id
          name
        }
      }
      userErrors {
        message
      }
    }
  }
`;

const authHint =
  "If the store auth is missing or expired, run `shopify store auth` for this store with the scopes read_products,write_products,read_orders,write_orders,read_draft_orders,write_draft_orders.";

/**
 * Runs one operation through `shopify store execute` on the CLI's own store
 * auth (never Baton's, so Baton's access scopes do not grow) and decodes the
 * `data` it prints. Stdin is closed, so the CLI never waits on a prompt, and
 * the output is read from its first `{`, because the CLI prints progress lines
 * before the JSON.
 */
const execute = <A, I>(
  store: string,
  schema: Schema.Codec<A, I>,
  document: string,
  variables?: Record<string, unknown>,
  options: { readonly mutation?: boolean } = {},
) =>
  runCommand(
    "shopify",
    [
      "store",
      "execute",
      "--store",
      store,
      "--json",
      "--version",
      API_VERSION,
      "--query",
      document,
      ...(variables === undefined
        ? []
        : ["--variables", JSON.stringify(variables)]),
      ...(options.mutation === true ? ["--allow-mutations"] : []),
    ],
    "",
  ).pipe(
    Effect.mapError(
      (error) =>
        new ShowcaseStoreError({
          message: `${error.message}. ${authHint}`,
          cause: error,
        }),
    ),
    Effect.flatMap((stdout) =>
      Effect.try({
        try: () => JSON.parse(stdout.slice(stdout.indexOf("{"))) as unknown,
        catch: (cause) =>
          new ShowcaseStoreError({
            message: `shopify store execute printed no JSON: ${stdout}`,
            cause,
          }),
      }),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) =>
      error instanceof ShowcaseStoreError
        ? error
        : new ShowcaseStoreError({
            message: `unexpected shape from shopify store execute: ${String(error)}`,
            cause: error,
          }),
    ),
  );

const failOnErrors = (
  what: string,
  errors: typeof UserErrors.Type,
): Effect.Effect<void, ShowcaseStoreError> =>
  errors.length === 0
    ? Effect.void
    : new ShowcaseStoreError({
        message: `${what}: ${errors.map(({ message }) => message).join("; ")}`,
      });

const Page = <A, I>(node: Schema.Codec<A, I>) =>
  Schema.Struct({
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
    nodes: Schema.Array(node),
  });

const readProducts = (store: string) =>
  execute(
    store,
    Schema.Struct({ products: Page(StoredProduct) }),
    PRODUCTS_QUERY,
  ).pipe(
    Effect.flatMap(({ products }) =>
      products.pageInfo.hasNextPage
        ? new ShowcaseStoreError({
            message: "the store has more than 100 products; archive them first",
          })
        : Effect.succeed(products.nodes),
    ),
  );

const readOrders = (store: string) =>
  execute(
    store,
    Schema.Struct({ orders: Page(StoredOrder) }),
    ORDERS_QUERY,
  ).pipe(
    Effect.flatMap(({ orders }) =>
      orders.pageInfo.hasNextPage
        ? new ShowcaseStoreError({
            message: "the store has more than 100 orders",
          })
        : Effect.succeed(orders.nodes),
    ),
  );

/** Reads the orders until none of the {@link SHOWCASE_ORDERS} is missing from the list, and fails after about two minutes. */
const waitForOrders = (store: string, createdCount: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const orders = yield* readOrders(store);
      if (missingOrders(orders).length === 0) return true;
      yield* Effect.sleep("3 seconds");
    }
    return yield* new ShowcaseStoreError({
      message: `the store's order list did not show the ${String(createdCount)} created orders after two minutes`,
    });
  });

/**
 * Brings the dev store to the showcase shop (`pnpm showcase:store`), and says
 * what each step changed. Safe to run again: every step reads before it
 * writes, so a second run changes nothing.
 *
 * 1. `productSet` each product in {@link SHOWCASE_PRODUCTS} that is missing or
 *    differs, by id when it exists and by handle in the input when it does
 *    not. No images.
 * 2. Archive every product the table does not name. Archived, not deleted, so
 *    nothing is lost.
 * 3. Cancel order #1001 if it is open, with no refund, no restock and no
 *    notice. The leftover order would otherwise be the only real order and
 *    is not a showcase one.
 * 4. Create the {@link SHOWCASE_ORDERS} that have no open order tagged for
 *    them, with no customer and no notice, paid (an unpaid order gets no runs
 *    in Baton). Through a draft order that is completed, not `orderCreate`:
 *    `orderCreate` needs an offline token and the CLI's store auth is an
 *    online one, which Shopify refuses it with ACCESS_DENIED. A completed
 *    draft order is a real order, not a test order, and its line properties
 *    are the draft line's custom attributes.
 *
 * Mutations are the four above and nothing else. Orders reach Baton by the
 * ordinary webhooks, or by Sync open orders.
 */
export const showcaseStore = (store: string) =>
  Effect.gen(function* () {
    const lines: string[] = [];
    const say = (line: string) => {
      lines.push(line);
      return Effect.logInfo(`showcase:store: ${line}`);
    };

    const stored = yield* readProducts(store);
    let written = 0;
    for (const wanted of SHOWCASE_PRODUCTS) {
      const existing = stored.find(({ handle }) => handle === wanted.handle);
      if (existing !== undefined && productMatches(existing, wanted)) {
        yield* say(`product ${wanted.handle}: already as the table says`);
        // eslint-disable-next-line no-continue
        continue;
      }
      const result = yield* execute(
        store,
        Schema.Struct({
          productSet: Schema.Struct({ userErrors: UserErrors }),
        }),
        PRODUCT_SET,
        {
          input: productSetInput(wanted),
          identifier: existing === undefined ? null : { id: existing.id },
        },
        { mutation: true },
      );
      yield* failOnErrors(
        `productSet ${wanted.handle}`,
        result.productSet.userErrors,
      );
      written += 1;
      yield* say(
        `product ${wanted.handle}: ${existing === undefined ? "created" : "updated"}`,
      );
    }

    let archived = 0;
    const named = new Set(SHOWCASE_PRODUCTS.map(({ handle }) => handle));
    for (const other of stored.filter(
      ({ handle, status }) => !named.has(handle) && status !== "ARCHIVED",
    )) {
      const result = yield* execute(
        store,
        Schema.Struct({
          productUpdate: Schema.Struct({ userErrors: UserErrors }),
        }),
        PRODUCT_ARCHIVE,
        { product: { id: other.id, status: "ARCHIVED" } },
        { mutation: true },
      );
      yield* failOnErrors(
        `archive ${other.handle}`,
        result.productUpdate.userErrors,
      );
      archived += 1;
      yield* say(`product ${other.handle}: archived`);
    }

    const orders = yield* readOrders(store);
    const leftover = orders.find(
      ({ name, cancelledAt }) => name === "#1001" && cancelledAt === null,
    );
    if (leftover === undefined) yield* say("order #1001: not open");
    else {
      const result = yield* execute(
        store,
        Schema.Struct({
          orderCancel: Schema.Struct({ orderCancelUserErrors: UserErrors }),
        }),
        ORDER_CANCEL,
        { orderId: leftover.id },
        { mutation: true },
      );
      yield* failOnErrors(
        "cancel #1001",
        result.orderCancel.orderCancelUserErrors,
      );
      yield* say("order #1001: cancelled, no refund, no restock, no notice");
    }

    const missing = missingOrders(orders);
    let created = 0;
    if (missing.length > 0) {
      // Read again: the variant ids exist only after step 1.
      const products = yield* readProducts(store);
      const variantId = (
        handle: string,
        value: string,
      ): Effect.Effect<string, ShowcaseStoreError> => {
        const id = products
          .find((product) => product.handle === handle)
          ?.variants.nodes.find((node) =>
            node.selectedOptions.some((option) => option.value === value),
          )?.id;
        return id === undefined
          ? Effect.fail(
              new ShowcaseStoreError({
                message: `no variant ${value} on product ${handle}`,
              }),
            )
          : Effect.succeed(id);
      };
      for (const wanted of missing) {
        const lineItems = yield* Effect.all(
          wanted.lines.map((entry) =>
            variantId(entry.handle, entry.value).pipe(
              Effect.map((id) => ({
                variantId: id,
                quantity: entry.quantity,
                customAttributes: Object.entries(entry.properties).map(
                  ([key, value]) => ({ key, value }),
                ),
              })),
            ),
          ),
        );
        const draft = yield* execute(
          store,
          Schema.Struct({
            draftOrderCreate: Schema.Struct({
              draftOrder: Schema.NullOr(Schema.Struct({ id: Schema.String })),
              userErrors: UserErrors,
            }),
          }),
          DRAFT_ORDER_CREATE,
          {
            input: {
              lineItems,
              tags: [SHOWCASE_ORDER_TAG, wanted.tag],
            },
          },
          { mutation: true },
        );
        yield* failOnErrors(
          `draftOrderCreate ${wanted.tag}`,
          draft.draftOrderCreate.userErrors,
        );
        const draftId = draft.draftOrderCreate.draftOrder?.id;
        if (draftId === undefined)
          return yield* new ShowcaseStoreError({
            message: `draftOrderCreate ${wanted.tag}: no draft order`,
          });
        const completed = yield* execute(
          store,
          Schema.Struct({
            draftOrderComplete: Schema.Struct({
              draftOrder: Schema.NullOr(
                Schema.Struct({
                  order: Schema.NullOr(Schema.Struct({ name: Schema.String })),
                }),
              ),
              userErrors: UserErrors,
            }),
          }),
          DRAFT_ORDER_COMPLETE,
          { id: draftId },
          { mutation: true },
        );
        yield* failOnErrors(
          `draftOrderComplete ${wanted.tag}`,
          completed.draftOrderComplete.userErrors,
        );
        created += 1;
        yield* say(
          `order ${wanted.tag}: created as ${completed.draftOrderComplete.draftOrder?.order?.name ?? "?"}`,
        );
      }
      // The orders list lags a completed draft order by more than ten
      // seconds, and a rerun that read it too soon would create the three
      // again. Wait until the list shows them.
      yield* waitForOrders(store, missing.length).pipe(
        Effect.tap(() => say("orders: listed by the store")),
      );
    } else yield* say("orders: all three already open");

    return `showcase store ${store}: products written ${String(written)}, archived ${String(archived)}; orders created ${String(created)}, found ${String(SHOWCASE_ORDERS.length - created)}`;
  });
