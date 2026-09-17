import * as React from "react";

import { Match } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * Pieces the queue card and the work page both render, kept together so the
 * two screens describe one item, one flag, and one order in the same words.
 *
 * One fact, once. The tier heading on the queue says which tier a card is in,
 * so nothing inside the card repeats it; the flag kind is said by the banner
 * *heading* and by nothing else, which is why {@link flagBody} carries only
 * the detail and is allowed to be null. {@link FlagBanner} takes the buttons
 * that act on the flag through its `actions` slot rather than rendering them
 * itself: Unblock and Dismiss mean different things (lift a hold, acknowledge
 * a reconcile) and each screen offers a different set, but both belong inside
 * the banner that states the flag rather than floating beneath it.
 */

/** The banner heading: the flag kind, and the only place it is named. */
export const flagHeading = (run: Domain.WorkflowRun) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<string>(),
        Match.when("item_removed", () => "No longer needed"),
        Match.when("quantity_changed", () => "Quantity changed"),
        Match.when("order_cancelled", () => "Order cancelled"),
        Match.when("order_deleted", () => "Order deleted"),
        Match.when("order_fulfilled", () => "Already shipped"),
        Match.when("blocked", () => "Blocked"),
        Match.exhaustive,
      );

/**
 * The banner body: the detail under the heading, or `null` when the heading
 * already says everything. A `blocked` run's body is the reason **as typed**,
 * with no prefix — the heading is the prefix.
 */
export const flagBody = (run: Domain.WorkflowRun) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<string | null>(),
        // Also covers a full refund and a line shipped ahead: all three zero
        // the units to make, and the maker's response is the same.
        Match.when(
          "item_removed",
          () => "Removed, refunded, or shipped in Shopify.",
        ),
        Match.when(
          "quantity_changed",
          () =>
            `From ${formatNumber(run.flagDetail?.from ?? 0)} to ${formatNumber(run.flagDetail?.to ?? run.quantity)}.`,
        ),
        Match.when("order_cancelled", () => null),
        Match.when("order_deleted", () => null),
        Match.when("order_fulfilled", () => "Fulfilled in Shopify."),
        Match.when("blocked", () => run.flagDetail?.reason ?? null),
        Match.exhaustive,
      );

/**
 * `critical` where the work must stop and someone outside the bench has to
 * act (a hold, a cancelled or deleted order); `warning` where the work has
 * merely changed under the maker and the response is to read and acknowledge.
 */
export const flagTone = (run: Domain.WorkflowRun) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<"critical" | "warning">(),
        Match.when("blocked", () => "critical" as const),
        Match.when("order_cancelled", () => "critical" as const),
        Match.when("order_deleted", () => "critical" as const),
        Match.when("item_removed", () => "warning" as const),
        Match.when("quantity_changed", () => "warning" as const),
        Match.when("order_fulfilled", () => "warning" as const),
        Match.exhaustive,
      );

/**
 * Free text exactly as a member typed it: `.member-prose` in `styles.css`
 * keeps the line breaks and says why. A wrapper rather than a class on the
 * Polaris element because `class` is not in these components' JSX props;
 * `white-space` inherits, so the text inside is governed either way.
 */
export function Prose({
  children,
  color,
}: {
  readonly children: React.ReactNode;
  readonly color?: "subdued";
}) {
  return (
    <div className="member-prose">
      {color === undefined ? (
        <s-paragraph>{children}</s-paragraph>
      ) : (
        <s-text color={color}>{children}</s-text>
      )}
    </div>
  );
}

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
          title: run.lineItemTitle,
          variantTitle: run.variantTitle,
          quantity: run.quantity,
        })}
      </s-text>
      {run.sku !== null && <s-text color="subdued">{`SKU ${run.sku}`}</s-text>}
      <Personalization attributes={run.customAttributes} />
    </s-stack>
  );
}

/**
 * The order's live line items with each one's make status, as the maker
 * sees them under "Also on this order" on the work page. "No steps", not
 * "No workflow": a worker never sees definitions, so an absence stated in
 * definition terms is nothing they can act on. What the maker needs is that
 * nothing was made for this item.
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

/**
 * The one banner both screens show for a flagged run: heading is the flag
 * kind, body is the detail, and under both a subdued line naming who and
 * when. `children` replaces the body outright, which is how the work page
 * swaps in its reason editor without a second banner.
 *
 * `actions` are rendered as the banner's own children and the caller sets
 * `slot="secondary-actions"` on them; a button that lifts or acknowledges the
 * flag belongs inside the thing that states it.
 */
export function FlagBanner({
  run,
  actions,
  children,
}: {
  readonly run: Domain.WorkflowRun;
  readonly actions?: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  const heading = flagHeading(run);
  const tone = flagTone(run);
  if (heading === null || tone === null) return null;
  const body = flagBody(run);
  const actor = flagActor(run);
  return (
    <s-banner tone={tone} heading={heading}>
      <s-stack gap="small-500">
        {children ?? (
          <>
            {body !== null && <Prose>{body}</Prose>}
            {run.flagAt !== null && (
              <s-text color="subdued">
                {actor === null ? "" : `${actor} · `}
                <LocalDateTime value={run.flagAt} format="relative" />
              </s-text>
            )}
          </>
        )}
      </s-stack>
      {actions}
    </s-banner>
  );
}
