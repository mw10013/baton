import * as React from "react";

import { Match } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * Pieces the run list's rows and the work page both render, kept together so the
 * two screens describe one item and one flag in the same words.
 *
 * One fact, once. The pressed tab on the run list says which tier a row is in,
 * so nothing inside the card repeats it; the flag kind is said by the banner
 * *heading* and by nothing else, which is why {@link flagBody} carries only
 * the detail and is allowed to be null. {@link FlagBanner} takes the buttons
 * that act on the flag through its `actions` slot rather than rendering them
 * itself: Unblock and Dismiss mean different things (lift a hold, acknowledge
 * a reconcile) and each screen offers a different set, but both belong inside
 * the banner that states the flag rather than floating beneath it.
 */

/** The banner heading: the flag kind, and the only place it is named. */
export const flagHeading = (run: { readonly flag: Domain.RunFlag | null }) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<string>(),
        Match.when("item_removed", () => "No longer needed"),
        Match.when("quantity_changed", () => "Quantity changed"),
        Match.when("order_cancelled", () => "Order cancelled"),
        Match.when("order_fulfilled", () => "Already shipped"),
        Match.when("blocked", () => "Blocked"),
        Match.exhaustive,
      );

/**
 * The banner body: the detail under the heading, or `null` when the heading
 * already says everything. A `blocked` run's body is the reason **as typed**,
 * with no prefix — the heading is the prefix.
 */
export const flagBody = (run: {
  readonly flag: Domain.RunFlag | null;
  readonly flagDetail: Domain.RunFlagDetail | null;
  readonly quantity: number;
}) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<string | null>(),
        // An edit that dropped the line or a full refund: both zero the units
        // to make ({@link Domain.unitsToMake}), and the maker's response is
        // the same. Shipping never sets this.
        Match.when("item_removed", () => "Removed or refunded in Shopify."),
        Match.when(
          "quantity_changed",
          () =>
            `From ${formatNumber(run.flagDetail?.from ?? 0)} to ${formatNumber(run.flagDetail?.to ?? run.quantity)}.`,
        ),
        Match.when("order_cancelled", () => null),
        Match.when("order_fulfilled", () => "Fulfilled in Shopify."),
        Match.when("blocked", () => run.flagDetail?.reason ?? null),
        Match.exhaustive,
      );

/**
 * `critical` where the work must stop and someone outside the bench has to
 * act (a hold, a cancelled order); `warning` where the work has merely changed
 * under the maker and the response is to read and acknowledge.
 */
export const flagTone = (run: { readonly flag: Domain.RunFlag | null }) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<"critical" | "warning">(),
        Match.when("blocked", () => "critical" as const),
        Match.when("order_cancelled", () => "critical" as const),
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

/** The person behind a `blocked` flag, as the banner's attribution line names them ("m2@m.com · 3m ago", "Merchant · 3m ago"). Reconcile flags have nobody. */
export const flagActor = (run: Domain.WorkflowRun) => {
  const by = run.flagDetail?.by;
  return by === undefined ? null : Domain.actorLabel(by);
};

/**
 * Personalization as label / value rows rather than one joined string:
 * "Engraving: The Millers · est. 2019" is the thing the worker will make and
 * deserves a line of its own. A two-column `s-grid` keeps labels aligned; at
 * phone width the value column still wraps inside its cell.
 *
 * The key is subdued and the value strong, so a key never reads as a label of
 * Baton's own. A null value is drawn as an em dash rather than hidden or left
 * empty: an empty cell leaves the key standing alone, where it reads as a
 * heading, and hiding the row loses "the customer left the gift note blank",
 * which the maker needs when the product offers one. The merchant's order
 * page renders this too, so both screens show a line item's properties alike.
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
          <s-text type="strong">{value ?? "\u2014"}</s-text>
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
 * The one banner both screens show for a flagged run: heading is the flag
 * kind, body is the detail ({@link ClampedProse}, three lines), and under both
 * a subdued line naming who and when. The reason is never edited in here: the
 * work page opens `BlockModal` for that, so the banner has one shape. The
 * button that does open it reads "Edit reason" on both screens, because the
 * run note's own button sits a few lines below and a bare "Edit" does not say
 * which of the two it opens.
 *
 * `actions` are rendered as the banner's own children and the caller sets
 * `slot="secondary-actions"` on them; a button that lifts, acknowledges or
 * rewrites the flag belongs inside the thing that states it.
 *
 * The merchant's order page renders it too, for `blocked` only, with Edit and
 * Unblock as `actions`, so the merchant sees the banner the worker sees. The
 * reconcile flags there stay a badge on the run line: the order page says
 * them in its own merchant vocabulary.
 */
export function FlagBanner({
  run,
  actions,
}: {
  readonly run: Domain.WorkflowRun;
  readonly actions?: React.ReactNode;
}) {
  const heading = flagHeading(run);
  const tone = flagTone(run);
  if (heading === null || tone === null) return null;
  const body = flagBody(run);
  const actor = flagActor(run);
  return (
    <s-banner tone={tone} heading={heading}>
      <s-stack gap="small-500">
        {body !== null && (
          <ClampedProse key={body} lines={3}>
            {body}
          </ClampedProse>
        )}
        {run.flagAt !== null && (
          <s-text color="subdued">
            {actor === null ? "" : `${actor} · `}
            <LocalDateTime value={run.flagAt} format="relative" />
          </s-text>
        )}
      </s-stack>
      {actions}
    </s-banner>
  );
}

/**
 * The one button a flag allows, by who set it: Unblock lifts a person's hold
 * ({@link Domain.runIsBlocked}); Dismiss acknowledges a reconcile flag, which
 * is not a hold anybody set. Both screens read it from here so the word
 * cannot differ between the run list and the work page.
 */
export const liftFlagLabel = (run: { readonly flag: Domain.RunFlag | null }) =>
  Domain.runIsBlocked(run) ? "Unblock" : "Dismiss";

/**
 * The run's note, always drawn while the run is live: the text as typed with
 * an "Edit note" button under it, or the button alone when blank. One verb,
 * Edit, because the note is a column that is always there and may be blank
 * ({@link Domain.SetRunNoteCommand}: `null` clears); "Add" would promise a
 * "Remove" that does not exist. The button names its object because the
 * blocked banner's "Edit reason" sits a few lines above it, and because the
 * blank note has no placeholder word to stand beside: a subdued "Note" on its
 * own read as another heading with nothing under it. On a run that is not
 * live a blank note draws nothing and a written one is read-only. Both run
 * pages render this so the verb cannot drift.
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
            Edit note
          </s-button>
        </s-stack>
      )}
    </s-stack>
  );
}
