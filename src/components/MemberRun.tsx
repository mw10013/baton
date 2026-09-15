import * as React from "react";

import { Match } from "effect";

import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * Pieces the queue card and the work page both render, kept together so the
 * two screens describe one item, one flag, and one order in the same words.
 */

export const flagMessage = (run: Domain.WorkflowRun) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<string>(),
        // Also covers a full refund and a line shipped ahead: all three zero
        // the units to make, and the maker's response is the same.
        Match.when("item_removed", () =>
          Domain.isOrderRun(run)
            ? `No longer needed: ${run.flagDetail?.item ?? ""}`
            : "No longer needed: this item was removed, refunded, or shipped.",
        ),
        Match.when(
          "quantity_changed",
          () =>
            `Quantity changed from ${formatNumber(run.flagDetail?.from ?? 0)} to ${formatNumber(run.flagDetail?.to ?? run.quantity ?? 0)}.`,
        ),
        Match.when("item_added", () =>
          run.flagDetail?.item === undefined
            ? "A new item was added to this order after it was ready."
            : `New item: ${run.flagDetail.item}`,
        ),
        Match.when("order_cancelled", () => "The order was cancelled."),
        Match.when("order_deleted", () => "The order was deleted."),
        Match.when(
          "order_fulfilled",
          () => "This order was already shipped in Shopify.",
        ),
        Match.when("blocked", () =>
          run.flagDetail?.reason === undefined
            ? "Blocked."
            : `Blocked: ${run.flagDetail.reason}`,
        ),
        Match.exhaustive,
      );

/** The person behind a `blocked` flag, for "· by m2@m.com" or "· Merchant". Reconcile flags have nobody. */
export const flagActor = (run: Domain.WorkflowRun) => {
  const by = run.flagDetail?.by;
  return by === undefined ? null : Domain.actorLabel(by);
};

export const ITEM_STATUS = {
  pending: { label: "Not started", tone: "info" },
  active: { label: "In progress", tone: "success" },
  done: { label: "Made", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "critical" },
} as const satisfies Record<
  Domain.RunStatus,
  { readonly label: string; readonly tone: string }
>;

/**
 * Personalization as label / value rows rather than one joined string:
 * "Engraving: The Millers · est. 2019" is the thing the worker will make and
 * deserves a line of its own. A two-column `s-grid` keeps labels aligned; at
 * phone width the value column still wraps inside its cell.
 */
export function Personalization({
  attributes,
}: {
  readonly attributes: readonly Domain.OrderAttribute[];
}) {
  if (attributes.length === 0) return null;
  return (
    <s-grid gridTemplateColumns="max-content 1fr" gap="small-500 base">
      {attributes.map(({ key, value }) => (
        <React.Fragment key={key}>
          <s-text color="subdued">{key}</s-text>
          <s-text type="strong">{value ?? ""}</s-text>
        </React.Fragment>
      ))}
    </s-grid>
  );
}

/** Title, variant, and the units to make, e.g. "Leather journal — A5 ×2". */
export const itemLabel = ({
  title,
  variantTitle,
  quantity,
}: {
  readonly title: string;
  readonly variantTitle: string | null;
  readonly quantity: number;
}) =>
  `${title}${variantTitle === null ? "" : ` — ${variantTitle}`} ×${formatNumber(quantity)}`;

/** An item run's own line: what this run makes. */
export function RunItem({ run }: { readonly run: Domain.WorkflowRun }) {
  return (
    <s-stack gap="small-500">
      <s-text type="strong">
        {itemLabel({
          title: run.lineItemTitle ?? "",
          variantTitle: run.variantTitle,
          quantity: run.quantity ?? 0,
        })}
      </s-text>
      {run.sku !== null && <s-text color="subdued">{`SKU ${run.sku}`}</s-text>}
      <Personalization attributes={run.customAttributes ?? []} />
    </s-stack>
  );
}

/**
 * The order's live line items with each one's make status, as the packer
 * sees them on an order-run card and the maker under "Also on this order".
 * "No steps", not "No workflow": a worker never sees definitions, so an
 * absence stated in definition terms is nothing they can act on. What the
 * packer needs is that nothing was made for this item.
 */
export function OrderItems({
  items,
}: {
  readonly items: readonly Domain.QueueOrderItem[];
}) {
  return (
    <s-stack gap="small-300">
      {items.map((orderItem) => (
        <s-stack key={orderItem.lineItemId} gap="small-500">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text>{itemLabel(orderItem)}</s-text>
            {orderItem.runStatus === null ? (
              <s-badge>No steps</s-badge>
            ) : (
              <s-badge tone={ITEM_STATUS[orderItem.runStatus].tone}>
                {ITEM_STATUS[orderItem.runStatus].label}
              </s-badge>
            )}
          </s-stack>
          <Personalization attributes={orderItem.customAttributes} />
        </s-stack>
      ))}
    </s-stack>
  );
}

/** The one warning banner both screens show for a flagged run. */
export function FlagBanner({ run }: { readonly run: Domain.WorkflowRun }) {
  const message = flagMessage(run);
  if (message === null) return null;
  const actor = flagActor(run);
  return (
    <s-banner tone="warning" heading="Needs attention">
      {actor === null ? message : `${message} · ${actor}`}
    </s-banner>
  );
}
