import * as React from "react";

import { Match } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * Pieces the workflows list's rows, the member's workflow page and the
 * merchant's order page render, kept together so the screens describe one item, one block and one
 * closed run in the same words.
 *
 * One fact, once. The pressed tab on the workflows list says which tier a row is in,
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

/**
 * The quantity badge ({@link Domain.Run} `quantityChangedFrom`, which
 * states the rule): warning-toned, and the whole change, "Quantity changed ·
 * 3 → 2", because a small "was 3" is easy to miss for the one person it
 * matters to. It has no button: the next done task clears it.
 */
export function QuantityBadge({
  run,
}: {
  readonly run: {
    readonly quantity: number;
    readonly quantityChangedFrom: number | null;
  };
}) {
  if (run.quantityChangedFrom === null) return null;
  return (
    <s-badge tone="warning">
      {`Quantity changed · ${formatNumber(run.quantityChangedFrom)} → ${formatNumber(run.quantity)}`}
    </s-badge>
  );
}

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

/** The person behind a block, as the banner's attribution line names them ("m2@m.com · 3m ago", "Merchant · 3m ago"). */
export const blockedByLabel = (run: {
  readonly blockedBy: Domain.ActorDisplay | null;
}) => (run.blockedBy === null ? null : Domain.actorLabel(run.blockedBy));

/**
 * An item's properties as label / value rows rather than one joined string:
 * "Engraving: The Millers · est. 2019" is the thing the worker will make and
 * deserves a line of its own. A two-column `s-grid` keeps labels aligned; at
 * phone width the value column still wraps inside its cell.
 *
 * The key is subdued and the value strong, so a key never reads as a label of
 * Baton's own. A null value is drawn as an em dash rather than hidden or left
 * empty: an empty cell leaves the key standing alone, where it reads as a
 * heading, and hiding the row loses "the customer left the gift note blank",
 * which the maker needs when the product offers one.
 *
 * Every property is drawn, underscore-prefixed app keys included: Baton is a
 * back-office view and the merchant sees the same keys in the admin, so there
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
    <s-grid gridTemplateColumns="max-content 1fr" gap="small-500 base">
      {properties.map(({ key, value }) => (
        <React.Fragment key={key}>
          <s-text color="subdued">{key}</s-text>
          <s-text type="strong">{value ?? "\u2014"}</s-text>
        </React.Fragment>
      ))}
    </s-grid>
  );
}

/**
 * An item run's own line under the member's workflow page heading: what this
 * run makes, less the title, which is the heading a stride above it: the
 * variant and the units, "A5 · Quantity 2", or "Quantity 2" for an item with
 * no variant. "Quantity" is the word the quantity badge beside it uses.
 */
export function RunItem({ run }: { readonly run: Domain.Run }) {
  return (
    <s-stack gap="small-500">
      <s-text type="strong">
        {`${run.variantTitle === null ? "" : `${run.variantTitle} · `}Quantity ${formatNumber(run.quantity)}`}
      </s-text>
      {run.sku !== null && <s-text color="subdued">{`SKU ${run.sku}`}</s-text>}
      <LineItemProperties properties={run.lineItemProperties} />
    </s-stack>
  );
}

/**
 * Prose cut to `lines` lines, with a Show more / Show less toggle only when
 * the cut hides something. A block reason may run to
 * {@link Domain.BLOCK_REASON_MAX_LENGTH} characters, and at full length the
 * banner holding it is taller than the rest of the card; typical reasons fit
 * in one or two lines and never see the toggle.
 *
 * Whether the cut hides anything depends on the width, so it is measured, not
 * guessed from the character count: a count threshold either clamps a reason
 * that fits (a Show more that reveals nothing) or leaves one uncut that does
 * not. `s-paragraph`'s `lineClamp` clamps an element inside its open shadow
 * root, rendered synchronously on connect, and that element's `scrollHeight`
 * exceeding its `clientHeight` is the overflow. If the element is not there
 * (Polaris changed its markup) the text renders in full rather than clipped
 * with no way to expand it.
 *
 * The caller keys it on the text, so an edited reason starts collapsed and is
 * measured afresh: a text that goes from three lines to four keeps the same
 * clamped height, and no resize would fire to say it now overflows.
 */
export function ClampedProse({
  lines,
  children,
}: {
  readonly lines: number;
  readonly children: string;
}) {
  const ref = React.useRef<React.ComponentRef<"s-paragraph">>(null);
  const [expanded, setExpanded] = React.useState(false);
  const [overflow, setOverflow] = React.useState<
    "unknown" | "none" | "clipped" | "unmeasurable"
  >("unknown");
  React.useLayoutEffect(() => {
    const inner = ref.current?.shadowRoot?.firstElementChild;
    const observer = new ResizeObserver(() => {
      if (inner instanceof HTMLElement && !expanded)
        setOverflow(
          inner.scrollHeight > inner.clientHeight + 1 ? "clipped" : "none",
        );
    });
    if (inner instanceof HTMLElement) observer.observe(inner);
    else setOverflow("unmeasurable");
    return () => {
      observer.disconnect();
    };
  }, [expanded]);
  const clamp = !expanded && overflow !== "unmeasurable";
  return (
    <s-stack gap="small-500">
      <div className="member-prose">
        <s-paragraph ref={ref} lineClamp={clamp ? lines : undefined}>
          {children}
        </s-paragraph>
      </div>
      {/* A link, not a tertiary button: the button's inline padding sets
          it off from the text's left edge, where a link lines up. */}
      {(expanded || overflow === "clipped") && (
        <s-text>
          <s-link
            onClick={() => {
              setExpanded((current) => !current);
            }}
          >
            {expanded ? "Show less" : "Show more"}
          </s-link>
        </s-text>
      )}
    </s-stack>
  );
}

/**
 * The one banner every screen shows for a blocked run
 * ({@link Domain.runIsBlocked}): heading "Blocked", body the reason as typed
 * ({@link ClampedProse}, three lines), and under both a subdued line naming
 * who and when. Critical: the work has stopped and someone has to act. The
 * reason is never edited in here: the screens open `BlockModal` for that, so
 * the banner has one shape. The button that does open it reads "Edit reason"
 * on every screen, because the run note's own button sits a few lines below
 * and a bare "Edit" does not say which of the two it opens.
 *
 * `actions` are rendered as the banner's own children and the caller sets
 * `slot="secondary-actions"` on them; Unblock and Edit reason belong inside
 * the thing that states the block. Each screen reads them from
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
      <s-stack gap="small-500">
        {run.blockReason !== null && (
          <ClampedProse key={run.blockReason} lines={3}>
            {run.blockReason}
          </ClampedProse>
        )}
        <s-text color="subdued">
          {actor === null ? "" : `${actor} · `}
          <LocalDateTime value={run.blockedAt} format="relative" />
        </s-text>
      </s-stack>
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
 * blocked banner's "Edit reason" sits a few lines above it, and because the
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
    <s-stack gap="small-300">
      {hasNote && <Prose>{note}</Prose>}
      {canEdit && (
        <s-stack direction="inline">
          <s-button variant="secondary" disabled={pending} onClick={onEdit}>
            {Domain.VERB_LABEL.note.member}
          </s-button>
        </s-stack>
      )}
    </s-stack>
  );
}
