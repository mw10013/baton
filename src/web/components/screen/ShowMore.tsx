import { formatNumber } from "../../../domain/platform.ts";
import { BETWEEN_LINES, BETWEEN_THINGS } from "./layout.ts";

/**
 * The deeper read at a list's foot: "Show 25 more of N". It asks for a deeper read rather than
 * revealing rows the page already holds, so the count it names is the reader's count of what is
 * past the cut, and `page` is how many one press adds.
 *
 * `end` is for the deepest read, where there is nothing more to ask for: one sentence takes the
 * button's place, saying how many show and what narrows the list. A disabled "Show 25 more"
 * offers rows it cannot fetch and says nothing about why.
 *
 * | part      | job                              | component  | fixes                                         | used on | never                                         |
 * | --------- | -------------------------------- | ---------- | --------------------------------------------- | ------- | --------------------------------------------- |
 * | show more | the deeper read at a list's foot | `ShowMore` | padding; the rule above; "Show n more of N"   | index   | revealing rows the page already holds         |
 */
export function ShowMore({
  hidden,
  page,
  end,
  onShowMore,
}: {
  readonly hidden: number;
  readonly page: number;
  readonly end: string | null;
  readonly onShowMore: () => void;
}) {
  return (
    <s-box
      paddingBlock={BETWEEN_LINES}
      paddingInline={BETWEEN_THINGS}
      borderWidth="base none none none"
    >
      {end === null ? (
        <s-button variant="tertiary" inlineSize="fill" onClick={onShowMore}>
          {`Show ${formatNumber(Math.min(page, hidden))} more of ${formatNumber(hidden)}`}
        </s-button>
      ) : (
        <s-paragraph color="subdued">{end}</s-paragraph>
      )}
    </s-box>
  );
}
