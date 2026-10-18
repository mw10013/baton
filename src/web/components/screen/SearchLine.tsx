import { formatNumber } from "../../../domain/platform.ts";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * What replaces the strip and the filters under a search: how many rows match, then Clear
 * search. `count` is the search's own count over every page, not the rows on screen. A search
 * that matched nothing is an `EmptyLine` with Clear search in the list's place instead.
 *
 * | part        | job                                                                     | component    | fixes                                      | used on | never                                |
 * | ----------- | ----------------------------------------------------------------------- | ------------ | ------------------------------------------ | ------- | ------------------------------------ |
 * | search line | how many rows a search matches, and Clear search, in the filters' place | `SearchLine` | the sentence's form; `base` to its button | index   | filters that look set but do nothing |
 */
export function SearchLine({
  count,
  noun,
  term,
  onClear,
}: {
  readonly count: number;
  /** The list's noun, singular and plural: `["member", "members"]`. */
  readonly noun: readonly [string, string];
  /** The search as the screen prints it. */
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
