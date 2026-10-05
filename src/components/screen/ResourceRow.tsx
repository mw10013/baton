import * as React from "react";

import { Clamp } from "./Clamp";
import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout";

/**
 * What every button inside a row must do first.
 *
 * `s-clickable` renders an `<a href>` in its shadow root and slots the row
 * into it, the shape Polaris's own resource-list composition uses
 * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/resource-list.md`,
 * "Provide search, filtering, and row selection for a resource list"), so a
 * click on a button inside the row reaches that anchor. `preventDefault` is
 * what stops the anchor navigating and `stopPropagation` is what stops the
 * row's own handler: neither does the other's job, because `stopPropagation`
 * silences listeners rather than an ancestor's default action. Verified
 * against the CDN `polaris.js` for both mouse and Enter.
 *
 * `s-menu` is the one thing this cannot cover: the menu puts an item's
 * activation on the row whatever the item's own handler does, so a row's menu
 * is rendered beside its clickable rather than inside it.
 */
export const insideRow = (event: {
  preventDefault: () => void;
  stopPropagation: () => void;
}) => {
  event.preventDefault();
  event.stopPropagation();
};

/**
 * A row's line one: `lead` (the order number), then `title` (the piece),
 * then `trail` (`×n`, or null). See {@link ResourceRow}.
 */
export interface RowHead {
  readonly lead: string;
  readonly title: string;
  readonly trail: string | null;
}

/** A row's menu: the button's label, whether it is disabled, and the menu's buttons. */
export interface RowMenu {
  readonly label: string;
  readonly disabled: boolean;
  readonly items: React.ReactNode;
}

/**
 * The member's row (the resource-row row of the parts table on `ScreenPart`
 * in `src/lib/Screen.ts`), Shopify's resource-list composition: the whole
 * row one link, a rule above it, and one tertiary `menu-horizontal` button
 * for its verbs.
 *
 * **Line one: the lead, then the title, clamped to two lines; the trail
 * after the clamp.** `#1008 · Signet ring · Gold ×2`. The lead (the order
 * number) is subdued and first, where a clamp cannot reach it, because a
 * clamp cuts from the end; it is a token and wraps anywhere. The title (the
 * piece, Shopify text) is clamped ({@link Clamp}) and carries the row's
 * weight as an `s-heading`, as Shopify's resource-list composition heads a
 * row. The trail (`×n`, a fixed word) sits outside the clamp, so a clamped
 * title still shows the count, at the end of the first line.
 *
 * **The head and the menu side by side; the body below, the full width.**
 * The menu sits beside line one only, in a cell one line tall, so a one-line
 * head leaves no gap and every line after the first has the menu's width
 * back (293px against 259px of text at 375px). One fixed-size control per
 * row also stops the text column's edge moving row by row. `children` are
 * the row's lines after the head, one {@link RowLine} each, spaced by
 * {@link BETWEEN_LINES}.
 *
 * `href` is a real link, so middle-click and open-in-new-tab work;
 * `onNavigate` turns an ordinary tap into a client navigation. The menu's
 * button stops the row's navigation ({@link insideRow}) and the menu itself
 * renders beside the clickable, not inside it.
 */
export function ResourceRow({
  head,
  children,
  menu,
  href,
  onNavigate,
  accessibilityLabel,
}: {
  readonly head: RowHead;
  readonly children?: React.ReactNode;
  readonly menu: RowMenu | null;
  readonly href: string;
  readonly onNavigate: () => void;
  readonly accessibilityLabel: string;
}) {
  const menuId = `row-menu-${React.useId().replaceAll(":", "")}`;
  return (
    <s-box data-part="resource-row" borderWidth="base none none none">
      <s-clickable
        href={href}
        accessibilityLabel={accessibilityLabel}
        paddingBlock={BETWEEN_LINES}
        paddingInline={BETWEEN_THINGS}
        onClick={(event) => {
          event.preventDefault();
          onNavigate();
        }}
      >
        <s-grid
          gridTemplateColumns={
            menu === null ? "minmax(0, 1fr)" : "minmax(0, 1fr) auto"
          }
          gap={BETWEEN_LINES}
          alignItems="start"
        >
          <div data-part="row-head" className="row-head">
            <div className="row-head-title">
              <Clamp heading>
                <span className="token">
                  <s-text color="subdued">{`${head.lead} · `}</s-text>
                </span>
                {head.title}
              </Clamp>
            </div>
            {head.trail !== null && (
              <div className="row-head-trail">
                <s-heading>{` ${head.trail}`}</s-heading>
              </div>
            )}
          </div>
          {menu !== null && (
            <div className="resource-row-menu">
              <s-button
                icon="menu-horizontal"
                variant="tertiary"
                accessibilityLabel={menu.label}
                disabled={menu.disabled}
                commandFor={menuId}
                onClick={insideRow}
              />
            </div>
          )}
          {children !== undefined && (
            <s-grid-item gridColumn={menu === null ? "span 1" : "span 2"}>
              <s-stack gap={BETWEEN_LINES}>{children}</s-stack>
            </s-grid-item>
          )}
        </s-grid>
      </s-clickable>
      {menu !== null && (
        <s-menu id={menuId} accessibilityLabel={menu.label}>
          {menu.items}
        </s-menu>
      )}
    </s-box>
  );
}

/**
 * One line of a {@link ResourceRow}'s body: inline text that wraps (a task
 * line, the recipe line) or a {@link Clamp} (a block reason).
 */
export function RowLine({ children }: { readonly children: React.ReactNode }) {
  return <div data-part="row-line">{children}</div>;
}
