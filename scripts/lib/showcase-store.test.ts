import assert from "node:assert/strict";
import { test } from "node:test";

import { SHOWCASE_PRODUCTS } from "../../e2e/showcaseProducts.ts";
import {
  missingOrders,
  productMatches,
  productSetInput,
  SHOWCASE_ORDERS,
} from "./showcase-store.ts";

const board = SHOWCASE_PRODUCTS[0];
if (board === undefined) throw new Error("no showcase products");

/** What the store would print for `board` once `productSet` has written it, prices as the store formats them. */
const storedBoard = {
  id: "gid://shopify/Product/1",
  handle: board.handle,
  title: board.title,
  status: "ACTIVE",
  tags: board.tags,
  options: [
    {
      name: board.option,
      optionValues: board.variants.map(({ value }) => ({ name: value })),
    },
  ],
  variants: {
    nodes: board.variants.map(({ value }) => ({
      id: `gid://shopify/ProductVariant/${value}`,
      sku: `CB-${value.toUpperCase()}`,
      price: "68.0",
      selectedOptions: [{ name: board.option, value }],
    })),
  },
};

void test("a product that says what the table says is left alone, whatever the price format", () => {
  assert.equal(productMatches(storedBoard, board), true);
});

void test("a product whose tags, status, SKU or variants differ is written again", () => {
  assert.equal(productMatches({ ...storedBoard, tags: [] }, board), false);
  assert.equal(
    productMatches({ ...storedBoard, status: "ARCHIVED" }, board),
    false,
  );
  assert.equal(
    productMatches(
      {
        ...storedBoard,
        variants: {
          nodes: storedBoard.variants.nodes.map((node) => ({
            ...node,
            sku: null,
          })),
        },
      },
      board,
    ),
    false,
  );
  assert.equal(
    productMatches(
      {
        ...storedBoard,
        variants: { nodes: storedBoard.variants.nodes.slice(1) },
      },
      board,
    ),
    false,
  );
});

void test("a product with no SKU stem is written without a SKU on any variant", () => {
  const giftCard = SHOWCASE_PRODUCTS.find(
    ({ handle }) => handle === "gift-card",
  );
  assert.ok(giftCard);
  for (const variant of productSetInput(giftCard).variants)
    assert.equal("sku" in variant, false);
});

void test("only the showcase orders with no open tagged order are created", () => {
  assert.equal(missingOrders([]).length, SHOWCASE_ORDERS.length);
  const [first] = SHOWCASE_ORDERS;
  assert.ok(first);
  const open = {
    id: "1",
    name: "#1002",
    tags: ["showcase", first.tag],
    cancelledAt: null,
  };
  assert.equal(missingOrders([open]).length, SHOWCASE_ORDERS.length - 1);
  assert.equal(
    missingOrders([{ ...open, cancelledAt: "2026-10-07T00:00:00Z" }]).length,
    SHOWCASE_ORDERS.length,
  );
});
