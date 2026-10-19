import type { HelpPage } from "../help/pages.ts";
import { useNavigateOnClick } from "../navigate.ts";

/**
 * A list of help pages: the hub's "In this section" and a page's foot list. Each entry is the
 * page's title as a link and its one-line description under it, a plain list rather than a card
 * per entry, so a section of ten pages reads as one list. The description follows a line break
 * rather than a stack gap: at the list's own line height it sits closer to its title than to the
 * next entry, so the pair reads as one entry. `current` is printed unlinked and strong, so the
 * foot list on a page shows where the reader is among its siblings; the hub passes none.
 *
 * | part      | job                                         | component  | fixes                                    | used on | never              |
 * | --------- | ------------------------------------------- | ---------- | ---------------------------------------- | ------- | ------------------ |
 * | help list | help pages, each a link and its one line    | `HelpList` | title over description; current unlinked | help    | a card per entry   |
 */
export function HelpList({
  entries,
  hrefOf,
  current,
}: {
  readonly entries: readonly HelpPage[];
  readonly hrefOf: (entry: HelpPage) => string;
  readonly current?: string;
}) {
  const navigate = useNavigateOnClick();
  return (
    <s-unordered-list>
      {entries.map((entry) => (
        <s-list-item key={entry.slug}>
          {entry.slug === current ? (
            <s-text type="strong">{entry.title}</s-text>
          ) : (
            <s-link {...navigate(hrefOf(entry))}>{entry.title}</s-link>
          )}
          <br />
          <s-text color="subdued">{entry.description}</s-text>
        </s-list-item>
      ))}
    </s-unordered-list>
  );
}
