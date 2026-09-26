import { Result } from "effect";
import { describe, expect, it } from "vitest";

import * as ActionTable from "../../scripts/lib/action-table.ts";

/**
 * `scripts/lib/action-table.ts` on inline sources. It is pure, so it runs in
 * the workers pool like everything else; there is no Node-pool project.
 */

const HEADER =
  "| order | run | blocked | task | downstream | start | done | putBack | reopen | assign |";
const SEPARATOR = "| - | - | - | - | - | - | - | - | - | - |";

const sourceOf = (...rows: readonly string[]) =>
  [
    "/** Not this one.",
    " *",
    " * | a | b |",
    " * | - | - |",
    " * | 1 | 2 |",
    " */",
    "export const other = 1;",
    "",
    "/**",
    " * Prose before the table.",
    " *",
    ` * ${HEADER}`,
    ` * ${SEPARATOR}`,
    ...rows.map((row) => ` * ${row}`),
    " *",
    " * | second | table |",
    " */",
    "export const taskActions = () => 0;",
  ].join("\n");

const parseError = (source: string) => {
  const parsed = ActionTable.parse(source, "taskActions");
  if (Result.isSuccess(parsed)) throw new Error("parsed");
  return parsed.failure.message;
};

const rowsOf = (source: string) =>
  Result.getOrThrow(ActionTable.parse(source, "taskActions"));

describe("action table parser", () => {
  it("the table is the first one in the JSDoc before the export", () => {
    const rows = rowsOf(
      sourceOf("| open | open | no | ready | - | m | M m | | | M |"),
    );
    expect(rows).toEqual([
      {
        line: 14,
        state: {
          order: "open",
          run: "open",
          blocked: "no",
          task: "ready",
          downstream: "-",
        },
        cells: {
          start: "m",
          done: "M m",
          putBack: "",
          reopen: "",
          assign: "M",
        },
      },
    ]);
  });

  it("the row after the header must be the separator", () => {
    const source = sourceOf(
      "| open | open | no | ready | - | m | M m | | | M |",
    )
      .split("\n")
      .filter((line) => line !== ` * ${SEPARATOR}`)
      .join("\n");
    expect(parseError(source)).toBe(
      "taskActions, line 13: expected the separator row after the header",
    );
  });

  it("an unknown state word fails and the error lists the vocabulary", () => {
    expect(
      parseError(sourceOf("| open | pending | no | ready | - | | | | | |")),
    ).toBe(
      'taskActions, line 14: unknown word "pending" under run; expected one of: open, done, closed, open or done',
    );
  });

  it("a cell outside M, m, M m, blank and blocker fails", () => {
    expect(
      parseError(sourceOf("| open | open | no | ready | - | Mm | | | | |")),
    ).toBe(
      'taskActions, line 14: cell "Mm" under start; expected one of: blank, M, m, M m, blocker',
    );
  });

  it("blocker is refused outside the reopen column", () => {
    expect(
      parseError(
        sourceOf("| open | open | no | ready | - | | blocker | | | |"),
      ),
    ).toBe(
      'taskActions, line 14: cell "blocker" under done; it is only a reopen cell',
    );
  });

  it("any and or words multiply fixtures", () => {
    const [row] = rowsOf(
      sourceOf("| closed | open or done | any | any | - | | | | | |"),
    );
    if (row === undefined) throw new Error("row");
    // 2 closed orders × 2 runs × 2 blocked × 4 tasks.
    expect(
      ActionTable.expand("taskActions", row, { teamId: "t", blocker: "b" }),
    ).toHaveLength(32);
  });

  it("two rows that share a fixture are an overlap", () => {
    const rows = rowsOf(
      sourceOf(
        "| open | open | yes | any | - | | | | | M |",
        "| open | open or done | any | done | none | | | | M m | |",
        "| open | closed | no | any | - | | | | | |",
      ),
    );
    expect(
      ActionTable.overlaps("taskActions", rows).map(([a, b]) => [
        a.line,
        b.line,
      ]),
    ).toEqual([[14, 15]]);
  });

  it("a glossary word absent from the rest of the file is reported", () => {
    const source = [
      "/**",
      " * Glossary.",
      " *",
      " * | word | symbol |",
      " * | run | `Run`, `RunTask` |",
      " * | open | `pending` |",
      " * | screen | `Closed · <reason>` |",
      " */",
      "export const Run = 1;",
      "export const RunTaskView = 2;",
    ].join("\n");
    expect(ActionTable.checkGlossary(source)).toEqual(["RunTask", "pending"]);
  });
});
