/**
 * The showcase shop's products: one table, imported by the showcase fixture
 * (`e2e/showcaseFixture.ts`, whose seeded order items copy a product's title,
 * variant, SKU and tags) and by the store script (`scripts/showcase-store.ts`,
 * which writes the same products into the dev store). The two must agree,
 * because a merchant reading "put this tag on the products" goes to Shopify's
 * product page and the picture there should match the order's item and the
 * workflow's tag.
 *
 * A product's `handle` is its identity in the store, so the script can run
 * again and put a product back the way this table says. A variant's SKU is
 * `<stem>-<VALUE>` ({@link skuOf}), and a product with no `skuStem` has none.
 */

export interface ShowcaseVariant {
  readonly value: string;
  readonly price: string;
}

export interface ShowcaseProduct {
  readonly handle: string;
  readonly title: string;
  /** The name of the one product option; its values are the variants. */
  readonly option: string;
  readonly variants: readonly ShowcaseVariant[];
  /** Left out: the variants carry no SKU. */
  readonly skuStem?: string;
  /** Workflow tags, as the workflows match them; empty for a product no workflow follows. */
  readonly tags: readonly string[];
}

const variants = (
  price: string,
  ...values: readonly string[]
): readonly ShowcaseVariant[] => values.map((value) => ({ value, price }));

export const SHOWCASE_PRODUCTS: readonly ShowcaseProduct[] = [
  {
    handle: "engraved-cutting-board",
    title: "Engraved cutting board",
    option: "Wood",
    variants: variants("68.00", "Maple", "Walnut"),
    skuStem: "CB",
    tags: ["engraved-cutting-board"],
  },
  {
    handle: "leather-journal",
    title: "Leather journal",
    option: "Color",
    variants: variants("42.00", "Tan", "Black"),
    skuStem: "LJ",
    tags: ["leather-journal"],
  },
  {
    handle: "signet-ring",
    title: "Signet ring",
    option: "Metal",
    variants: [
      { value: "Silver", price: "180.00" },
      { value: "Gold", price: "420.00" },
    ],
    skuStem: "SR",
    tags: ["signet-ring"],
  },
  {
    handle: "embroidered-baby-blanket",
    title: "Embroidered baby blanket",
    option: "Color",
    variants: variants("56.00", "Cream", "Sage"),
    skuStem: "BB",
    tags: ["embroidered-blanket"],
  },
  {
    handle: "wall-clock",
    title: "Wall clock",
    option: "Wood",
    variants: variants("95.00", "Oak", "Walnut"),
    skuStem: "WC",
    tags: ["wall-clock"],
  },
  {
    handle: "photo-frame",
    title: "Photo frame",
    option: "Size",
    variants: [
      { value: "5×7", price: "28.00" },
      { value: "8×10", price: "36.00" },
    ],
    skuStem: "PF",
    tags: ["photo-frame"],
  },
  {
    handle: "journal-and-pen-gift-set",
    title: "Journal and pen gift set",
    option: "Color",
    variants: variants("74.00", "Tan", "Black"),
    skuStem: "GS",
    tags: ["leather-journal", "gift-set"],
  },
  {
    handle: "gift-card",
    title: "Gift card",
    option: "Amount",
    variants: [
      { value: "$25", price: "25.00" },
      { value: "$50", price: "50.00" },
    ],
    tags: [],
  },
];

/** `<stem>-<VALUE>`, the value upper-cased with `×` as `X` and anything else that is not a letter or digit dropped; `null` for a product with no SKU stem. */
export const skuOf = (
  product: ShowcaseProduct,
  value: string,
): string | null =>
  product.skuStem === undefined
    ? null
    : `${product.skuStem}-${value
        .toUpperCase()
        .replaceAll("×", "X")
        .replaceAll(/[^A-Z0-9]/gu, "")}`;
