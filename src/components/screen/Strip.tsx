import { formatNumber } from "@/lib/format";

import { BETWEEN_LINES, sideBySide } from "./layout";

/**
 * One cell of a {@link Strip}: a value of the main filter and its count,
 * then what pressing it does. On an index the cell is a filter press: it
 * may be the chosen value, and pressing it chooses it. On the home page it
 * is a link to the index with that value chosen, and nothing on the home
 * page is chosen. A strip's cells are all one kind or all the other.
 */
export type StripCell = {
  readonly key: string;
  readonly label: string;
  readonly count: number;
} & (
  | { readonly chosen: boolean; readonly onSelect: () => void }
  | { readonly href: string }
);

/** The cells of one strip: every one a filter press, or every one a link (the strip row's "never both"). */
type StripCells =
  | readonly Extract<StripCell, { readonly onSelect: () => void }>[]
  | readonly Extract<StripCell, { readonly href: string }>[];

/**
 * The metrics strip (the strip row of the parts table on `ScreenPart` in
 * `src/lib/Screen.ts`): counts that are also the main filter, the
 * metrics-card composition
 * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/metrics-card.md`).
 * Each cell is the value's name over its count, the whole cell a one-click
 * filter; the chosen cell is filled (`background="subdued"`). On the home
 * page each cell is instead a link to the index with its value chosen
 * (`href` on the `s-clickable`), and no cell is filled, since the home page
 * has no filter to choose.
 *
 * Not `aria-current`: `s-clickable` leaves it on the host, and the native
 * button in its shadow root, which is what a screen reader reads, never gets
 * it; the accessibility label says "selected" instead, since that label does
 * reach the button. A link cell's label is the name and the count alone. A
 * count always renders, at zero if need be, so nothing
 * on the strip appears or disappears with the data. No cell is red.
 *
 * **Columns: one per cell when the strip's container is wider than the
 * breakpoint ({@link sideBySide}), three below.** Every strip has five
 * cells (the orders index, the home page and the workflows list), so it is one line of
 * five on a wide card and two lines (three, then two) on a phone or in a
 * narrow page. A label that wraps in a narrow track ("Started by others",
 * "Done or closed") does not stagger the counts: each cell fills its track
 * and sits its count at the cell's foot, so the counts on a line share a
 * baseline and a chosen cell's fill is the line's full height. A grid rather
 * than a scroller or a wrapping row, so a count crossing a digit changes a
 * cell and never the layout. Not sticky: it scrolls away with the page.
 */
export function Strip({ cells }: { readonly cells: StripCells }) {
  return (
    <s-query-container>
      <s-grid
        gridTemplateColumns={sideBySide(
          cells.map(() => "1fr").join(" "),
          "1fr 1fr 1fr",
        )}
        gap={BETWEEN_LINES}
      >
        {cells.map((cell: StripCell) => (
          <s-clickable
            key={cell.key}
            padding={BETWEEN_LINES}
            borderRadius="base"
            blockSize="100%"
            {...("href" in cell
              ? {
                  href: cell.href,
                  background: "transparent" as const,
                  accessibilityLabel: `${cell.label}, ${formatNumber(cell.count)}`,
                }
              : {
                  background: cell.chosen
                    ? ("subdued" as const)
                    : ("transparent" as const),
                  accessibilityLabel: `${cell.label}, ${formatNumber(cell.count)}${cell.chosen ? ", selected" : ""}`,
                  onClick: () => {
                    cell.onSelect();
                  },
                })}
          >
            <s-grid
              gap={BETWEEN_LINES}
              blockSize="100%"
              alignContent="space-between"
            >
              <s-heading>{cell.label}</s-heading>
              <s-text>{formatNumber(cell.count)}</s-text>
            </s-grid>
          </s-clickable>
        ))}
      </s-grid>
    </s-query-container>
  );
}
