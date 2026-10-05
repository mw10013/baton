import * as React from "react";

import { Match } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { ClampedProse } from "@/components/screen/ClampedProse";
import { Inline } from "@/components/screen/Inline";
import { Lines } from "@/components/screen/Lines";
import { Pairs } from "@/components/screen/Pairs";
import { Prose } from "@/components/screen/Prose";
import { Token } from "@/components/screen/Token";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * Pieces the workflows list's rows, the member's workflow page and the
 * merchant's order page render, kept together so the screens describe one item, one block and one
 * closed run in the same words.
 *
 * One fact, once. The chosen state on the workflows list says which state a row is in,
 * so nothing inside the card repeats it. {@link BlockBanner} takes the buttons
 * that act on the block through its `actions` slot rather than rendering them
 * itself: each screen offers a different set, but all belong inside the
 * banner that states the block rather than floating beneath it.
 */

/**
 * The reason a run closed, as a sentence ({@link Domain.ClosedReason}, whose
 * table this is). Only `merchant_cancelled` depends on who reads it: the
 * merchant did it, so their page says "you"; a member reads who did.
 */
export const closedReasonText = (
  reason: Domain.ClosedReason,
  viewer: Domain.ConnectionRole,
) =>
  Match.value(reason).pipe(
    Match.withReturnType<string>(),
    Match.when("fulfilled", () => "Fulfilled in Shopify"),
    Match.when("order_cancelled", () => "Order cancelled in Shopify"),
    Match.when("item_removed", () => "Item removed or refunded in Shopify"),
    Match.when("merchant_cancelled", () =>
      viewer === "merchant" ? "Cancelled by you" : "Cancelled by the merchant",
    ),
    Match.exhaustive,
  );

/**
 * One subdued line naming why and when a closed run ended ("Fulfilled in
 * Shopify · 3h ago"), or nothing on a run that is not closed. The one place
 * every screen reads the reason from, so the words cannot drift.
 */
export function ClosedLine({
  run,
  viewer,
  prefix = false,
}: {
  readonly run: Domain.Run;
  readonly viewer: Domain.ConnectionRole;
  /** "Closed · " first, where no badge beside the line already says Closed. */
  readonly prefix?: boolean;
}) {
  if (!Domain.runIsClosed(run) || run.closedReason === null) return null;
  return (
    <s-text color="subdued">
      {`${prefix ? "Closed · " : ""}${closedReasonText(run.closedReason, viewer)}`}
      {run.closedAt !== null && (
        <>
          {" · "}
          <LocalDateTime value={run.closedAt} format="relative" />
        </>
      )}
    </s-text>
  );
}

/** The person behind a block, as the banner's attribution line names them ("m2@m.com · 3m ago", "Merchant · 3m ago"). */
export const blockedByLabel = (run: {
  readonly blockedBy: Domain.ActorDisplay | null;
}) => (run.blockedBy === null ? null : Domain.actorLabel(run.blockedBy));

/**
 * An item's properties as label / value rows rather than one joined string:
 * "Engraving: The Millers · est. 2019" is the thing the worker will make and
 * deserves a line of its own. {@link Pairs} keeps labels aligned; at phone
 * width the value column still wraps inside its cell, and a long key wraps
 * rather than overflow.
 *
 * The key is subdued, so a key never reads as a label of Baton's own. A null value is drawn as an em dash rather than hidden or left
 * empty: an empty cell leaves the key standing alone, where it reads as a
 * heading, and hiding the row loses "the customer left the gift note blank",
 * which the maker needs when the product offers one.
 *
 * Every property is drawn, underscore-prefixed app keys included: Baton is a
 * back-office tool and the merchant sees the same keys in the admin, so there
 * is nothing to hide from either screen. The merchant's order page renders
 * this too under a Properties heading, so both screens show an item's
 * properties alike.
 */
export function LineItemProperties({
  properties,
}: {
  readonly properties: readonly Domain.LineItemProperty[];
}) {
  if (properties.length === 0) return null;
  return (
    <Pairs
      pairs={properties.map(({ key, value }) => ({
        key,
        label: key,
        value: value ?? "\u2014",
      }))}
    />
  );
}

/**
 * An item run's own line under the member's workflow page heading: what this
 * run makes, less the title, which is the heading a stride above it: the
 * variant and the units, "A5 · Quantity 2", or "Quantity 2" for an item with
 * no variant.
 */
export function RunItem({ run }: { readonly run: Domain.Run }) {
  return (
    <Lines>
      {/* The semantic `<strong>` only: the line sits under the page heading,
          and weight here would compete with it. */}
      <s-text type="strong">
        {`${run.variantTitle === null ? "" : `${run.variantTitle} · `}Quantity ${formatNumber(run.quantity)}`}
      </s-text>
      {run.sku !== null && <Token color="subdued">{`SKU ${run.sku}`}</Token>}
      <LineItemProperties properties={run.lineItemProperties} />
    </Lines>
  );
}

/**
 * The one banner every screen shows for a blocked run
 * ({@link Domain.runIsBlocked}): heading "Blocked", body the reason as typed
 * ({@link ClampedProse}), and under both a subdued line naming
 * who and when. Critical: the work has stopped and someone has to act. The
 * reason is the blocker's words and is not edited: a new reason is Unblock,
 * then Block.
 *
 * `actions` are rendered as the banner's own children and the caller sets
 * `slot="secondary-actions"` on them; Unblock belongs inside the thing that
 * states the block. Each screen reads them from
 * {@link Domain.runActions}.
 */
export function BlockBanner({
  run,
  actions,
}: {
  readonly run: {
    readonly blockedAt: number | null;
    readonly blockReason: string | null;
    readonly blockedBy: Domain.ActorDisplay | null;
  };
  readonly actions?: React.ReactNode;
}) {
  // The predicate is the gate; the null test only narrows for the time line.
  if (!Domain.runIsBlocked(run) || run.blockedAt === null) return null;
  const actor = blockedByLabel(run);
  return (
    <s-banner tone="critical" heading={Domain.RUN_STATE_LABEL.blocked}>
      <Lines>
        {run.blockReason !== null && (
          <ClampedProse key={run.blockReason}>{run.blockReason}</ClampedProse>
        )}
        <s-text color="subdued">
          {actor === null ? "" : `${actor} · `}
          <LocalDateTime value={run.blockedAt} format="relative" />
        </s-text>
      </Lines>
      {actions}
    </s-banner>
  );
}

/**
 * The run's note: the text as typed with an "Edit note" button under it, or
 * the button alone when blank. `canEdit` is {@link Domain.runActions}' `note`. One verb,
 * Edit, because the note is a column that is always there and may be blank
 * ({@link Domain.SetRunNoteCommand}: `null` clears); "Add" would promise a
 * "Remove" that does not exist. The button names its object because the
 * blank note has no placeholder word to stand beside: a subdued "Note" on its
 * own read as another heading with nothing under it. Where the note is not
 * editable a blank note draws nothing and a written one is read-only. Both
 * run pages render this so the verb cannot drift.
 */
export function RunNote({
  note,
  canEdit,
  pending,
  onEdit,
}: {
  readonly note: string | null;
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly onEdit: () => void;
}) {
  const hasNote = note !== null && note.length > 0;
  if (!hasNote && !canEdit) return null;
  return (
    <Lines>
      {hasNote && <Prose>{note}</Prose>}
      {canEdit && (
        <Inline>
          <s-button variant="secondary" disabled={pending} onClick={onEdit}>
            {Domain.VERB_LABEL.note.member}
          </s-button>
        </Inline>
      )}
    </Lines>
  );
}
