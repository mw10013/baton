import type { ReactNode } from "react";

/**
 * A reference table in a help page: one row per word, its badge or button in the first column as
 * the screen prints it, what it means beside it. Built on `s-table` so a phone reads it as a
 * list: the first column is the row's title (`listSlot="primary"`) and the rest are labelled by
 * their column heading (`listSlot="labeled"`), which is how a four-column table stays readable at
 * 390px. No pagination, no loading state and no control in a cell: a reference table is read,
 * not worked. Rows carry no key of their own, so a row's first cell is its identity and must be
 * unique. `s-table-cell` sets `nowrap` inside its shadow root, which a slotted text inherits, so a
 * sentence in a cell ran off the card; `.help-table-cell` in `styles.css` lets it wrap.
 *
 * | part       | job                                  | component   | fixes                          | used on | never              |
 * | ---------- | ------------------------------------ | ----------- | ------------------------------ | ------- | ------------------ |
 * | help table | a reference table: a word, its sense | `HelpTable` | first column the row's title   | help    | a control in a cell |
 */
export function HelpTable({
  columns,
  rows,
}: {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ReactNode[])[];
}) {
  return (
    <s-table>
      <s-table-header-row>
        {columns.map((column, index) => (
          <s-table-header key={column} listSlot={index === 0 ? "primary" : "labeled"}>
            {column}
          </s-table-header>
        ))}
      </s-table-header-row>
      <s-table-body>
        {rows.map((row, index) => (
          <s-table-row key={index}>
            {row.map((cell, at) => (
              <s-table-cell key={at}>
                <span className="help-table-cell">{cell}</span>
              </s-table-cell>
            ))}
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}
