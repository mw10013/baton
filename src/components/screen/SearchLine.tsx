import { formatNumber } from "@/lib/format";

import { BETWEEN_THINGS } from "./layout";

/**
 * What replaces the strip and the filters under a search (the search-line
 * row of the parts table on `ScreenPart` in `src/lib/Screen.ts`, and the
 * controls table's "a search is on" row on `Control`): how many rows match,
 * then Clear search. `count` is the search's own count over every page, not
 * the rows on screen. A search that matched nothing is an
 * {@link EmptyLine} with Clear search in the list's place instead.
 */
export function SearchLine({
  count,
  noun,
  term,
  onClear,
}: {
  readonly count: number;
  /** The list's noun, singular and plural: `["order", "orders"]`. */
  readonly noun: readonly [string, string];
  /** The search as the screen prints it (`Domain.searchTermText`). */
  readonly term: string;
  readonly onClear: () => void;
}) {
  return (
    <s-stack direction="inline" gap={BETWEEN_THINGS} alignItems="center">
      <s-text>
        {count === 1
          ? `1 ${noun[0]} matches ${term}`
          : `${formatNumber(count)} ${noun[1]} match ${term}`}
      </s-text>
      <s-button onClick={onClear}>Clear search</s-button>
    </s-stack>
  );
}
