import type { ReactNode } from "react";
import type { LineItemProperty } from "../../domain/orders.ts";
import { type ConnectionRole, formatNumber } from "../../domain/platform.ts";
import {
  type ActorDisplay,
  actorLabel,
  closedReasonText,
  RUN_STATE_LABEL,
  type Run,
  runIsBlocked,
  runIsClosed,
  VERB_LABEL,
} from "../../domain/shop-work.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import { ClampedProse } from "./screen/ClampedProse.tsx";
import { Inline } from "./screen/Inline.tsx";
import { Lines } from "./screen/Lines.tsx";
import { Pairs } from "./screen/Pairs.tsx";
import { Prose } from "./screen/Prose.tsx";
import { Token } from "./screen/Token.tsx";

/**
 * One subdued line naming why and when a closed run ended ("Fulfilled in Shopify · 3h ago"), or
 * nothing on a run that is not closed. Every screen reads the reason from here, so the words
 * cannot drift: the workflows list's rows, the member's workflow page and the merchant's order
 * page describe one closed run alike.
 */
export function ClosedLine({
  run,
  viewer,
  prefix = false,
}: {
  readonly run: Pick<Run, "state" | "closedReason" | "closedAt">;
  readonly viewer: ConnectionRole;
  /** "Closed · " first, where no badge beside the line already says Closed. */
  readonly prefix?: boolean;
}) {
  if (!runIsClosed(run) || run.closedReason === null) return null;
  return (
    <s-text color="subdued">
      {`${prefix ? `${RUN_STATE_LABEL.closed} · ` : ""}${closedReasonText(run.closedReason, viewer)}`}
      {run.closedAt !== null && (
        <>
          {" · "}
          <LocalDateTime value={run.closedAt} format="relative" />
        </>
      )}
    </s-text>
  );
}

/** The person behind a block, as {@link BlockBanner}'s attribution line names them to `viewer` ("m2@m.com", "You"; {@link actorLabel}). */
export const blockedByLabel = (
  run: { readonly blockedBy: ActorDisplay | null },
  viewer: ConnectionRole,
) => (run.blockedBy === null ? null : actorLabel(run.blockedBy, viewer));

/**
 * An item's properties as label / value rows rather than one joined string: "Engraving: The
 * Millers · est. 2019" is the thing the worker will make and deserves a line of its own.
 * {@link Pairs} keeps labels aligned and lets a long key wrap rather than overflow.
 *
 * The key is subdued, so a key never reads as a label of Baton's own. A null value is drawn as an
 * em dash rather than hidden or left empty: an empty cell leaves the key standing alone, where it
 * reads as a heading, and hiding the row loses "the customer left the gift note blank", which the
 * maker needs when the product offers one.
 *
 * Every property is drawn, underscore-prefixed app keys included: Baton is a back-office tool and
 * the merchant sees the same keys in the admin, so there is nothing to hide from either screen.
 * The merchant's order page renders this too, under a Properties heading.
 */
export function LineItemProperties({
  properties,
}: {
  readonly properties: readonly LineItemProperty[];
}) {
  if (properties.length === 0) return null;
  return (
    <Pairs
      pairs={properties.map(({ key, value }, index) => ({
        // Shopify does not promise unique keys on one item.
        key: `${String(index)}:${key}`,
        label: key,
        value: value ?? "—",
      }))}
    />
  );
}

/**
 * An item run's own line under the member's workflow page heading: what this run makes, less the
 * title, which is the heading a stride above it: the variant and the units, "A5 · Quantity 2", or
 * "Quantity 2" for an item with no variant. Then the SKU and the properties.
 */
export function RunItem({
  run,
}: {
  readonly run: Pick<Run, "variantTitle" | "quantity" | "sku" | "lineItemProperties">;
}) {
  return (
    <Lines>
      {/* The semantic `<strong>` only: the line sits under the page heading, and weight here
          would compete with it. */}
      <s-text type="strong">
        {`${run.variantTitle === null ? "" : `${run.variantTitle} · `}Quantity ${formatNumber(run.quantity)}`}
      </s-text>
      {run.sku !== null && <Token color="subdued">{`SKU ${run.sku}`}</Token>}
      <LineItemProperties properties={run.lineItemProperties} />
    </Lines>
  );
}

/**
 * The one banner every screen shows for a blocked run ({@link runIsBlocked}): heading "Blocked",
 * body the reason as typed ({@link ClampedProse}), and under both a subdued line naming who and
 * when. Critical: the work has stopped and someone has to act. The reason is the blocker's words
 * and is not edited: a new reason is Unblock, then Block.
 *
 * `actions` are rendered as the banner's own children, and the caller sets
 * `slot="secondary-actions"` on them: Unblock belongs inside the thing that states the block,
 * not floating beneath it, and each screen offers a different set (`runActions`).
 */
export function BlockBanner({
  run,
  viewer,
  actions,
}: {
  readonly run: Pick<Run, "blockedAt" | "blockReason" | "blockedBy">;
  /** Who is looking, for the attribution line ({@link actorLabel}). */
  readonly viewer: ConnectionRole;
  readonly actions?: ReactNode;
}) {
  // The predicate is the gate; the null test only narrows for the time line.
  if (!runIsBlocked(run) || run.blockedAt === null) return null;
  const actor = blockedByLabel(run, viewer);
  return (
    <s-banner tone="critical" heading={RUN_STATE_LABEL.blocked}>
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
 * The run's note: the text as typed with an "Edit note" button under it, or the button alone when
 * blank. `canEdit` is `runActions`' `note`. One verb, Edit, because the note is a column that is
 * always there and may be blank (`null` clears); "Add" would promise a "Remove" that does not
 * exist. The button names its object because the blank note has no placeholder word to stand
 * beside: a subdued "Note" on its own reads as another heading with nothing under it. Where the
 * note is not editable a blank note draws nothing and a written one is read-only. Both run pages
 * render this so the verb cannot drift.
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
            {VERB_LABEL.note.member}
          </s-button>
        </Inline>
      )}
    </Lines>
  );
}
