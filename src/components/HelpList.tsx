import type { HelpPage } from "@/lib/helpPages";

/**
 * A list of help pages: the hub's "In this section" and a page's foot list.
 * Each entry is the page's title as a link and its one-line description
 * (`HELP_SECTIONS` in `src/lib/helpPages.ts`). `current` is printed unlinked,
 * so the foot list on a page shows where the reader is among its siblings;
 * the hub passes none. A plain Polaris list for the skeleton; the parts
 * table gets a help-list row when the content phase settles its shape
 * (`docs/help-research.md`).
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
  return (
    <s-unordered-list>
      {entries.map((entry) => (
        <s-list-item key={entry.slug}>
          {entry.slug === current ? (
            <s-text type="strong">{entry.title}</s-text>
          ) : (
            <s-link href={hrefOf(entry)}>{entry.title}</s-link>
          )}{" "}
          <s-text color="subdued">{entry.description}</s-text>
        </s-list-item>
      ))}
    </s-unordered-list>
  );
}
