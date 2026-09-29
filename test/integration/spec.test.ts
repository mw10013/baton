import { Result } from "effect";
import { describe, expect, it } from "vitest";

import d1Source from "@/lib/D1Schema.ts?raw";
import * as Domain from "@/lib/Domain";
import source from "@/lib/Domain.ts?raw";
import * as Screen from "@/lib/Screen";
import screenSource from "@/lib/Screen.ts?raw";
import schemaSource from "@/lib/ShopAgentSchema.ts?raw";

import * as ActionTable from "../../scripts/lib/spec.ts";

/**
 * `scripts/lib/spec.ts` on inline sources. It is pure, so it runs in
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

const OBJECT: ActionTable.DataModelOptions = {
  symbol: "initializeSchema",
  tables: ActionTable.tablesDeclared(schemaSource),
};

const D1: ActionTable.DataModelOptions = {
  symbol: "D1_TABLES",
  tables: ActionTable.tablesNamed(d1Source, [
    "D1_TABLES",
    "BETTER_AUTH_TABLES",
  ]),
};

const dataModelError = (doctored: string) => {
  expect(doctored).not.toBe(schemaSource);
  const parsed = ActionTable.parseDataModel(doctored, OBJECT);
  if (Result.isSuccess(parsed)) throw new Error("parsed");
  return parsed.failure.message;
};

const rowsOf = (source: string) =>
  Result.getOrThrow(ActionTable.parse(source, "taskActions"));

const checkOrderIssues = (doctored: string) =>
  ActionTable.checkOrderIssues(
    doctored,
    Domain.OrderIssue.literals,
    Domain.orderIssueIsCritical,
  );

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
    // 2 closed orders × (open run × 2 blocked + done run × 1) × 4 tasks.
    expect(
      ActionTable.expand("taskActions", row, { teamId: "t", blocker: "b" }),
    ).toHaveLength(24);
  });

  it("a done run is never blocked", () => {
    const [row] = rowsOf(
      sourceOf("| open | open or done | any | done | none | | | | M m | |"),
    );
    if (row === undefined) throw new Error("row");
    const fixtures = ActionTable.expand("taskActions", row, {
      teamId: "t",
      blocker: "b",
    });
    expect(fixtures.map((fixture) => fixture.run)).toEqual([
      { status: "active", blockedAt: null },
      { status: "active", blockedAt: 1 },
      { status: "done", blockedAt: null },
    ]);
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
      "export const RunTaskRow = 2;",
    ].join("\n");
    expect(ActionTable.checkGlossary(source)).toEqual(["RunTask", "pending"]);
  });

  describe("the glossary's screen column is the label constant", () => {
    const labels: ActionTable.ScreenLabels = {
      taskStates: Domain.TASK_STATE_LABEL,
      runStates: Domain.RUN_STATE_LABEL,
      workflowStates: Domain.WORKFLOW_STATE_LABEL,
      productionStates: Domain.PRODUCTION_STATE_LABEL,
      orderIssues: Domain.ORDER_ISSUE_LABEL,
      verbs: Domain.VERB_LABEL,
    };

    it("Domain.ts passes", () => {
      expect(ActionTable.checkScreenColumns(source, labels)).toEqual([]);
    });

    it("a doctored cell is reported", () => {
      const doctored = source.replace(
        "| put back        | task | started → ready                     | Put back    | Put back        |",
        "| put back        | task | started → ready                     | Put back    | Take back       |",
      );
      expect(doctored).not.toBe(source);
      expect(ActionTable.checkScreenColumns(doctored, labels)).toEqual([
        'Glossary: Verbs put back: merchant says "Take back", constant says "Put back"',
      ]);
    });

    it("a spaced word finds its snake-case literal key", () => {
      const doctored = source.replace(
        "| not started | open, no open run and no done run | Not started |",
        "| not started | open, no open run and no done run | To make     |",
      );
      expect(doctored).not.toBe(source);
      expect(ActionTable.checkScreenColumns(doctored, labels)).toEqual([
        'Glossary: Order positions not started: screen says "To make", constant says "Not started"',
      ]);
    });

    it("a constant with no row, and a row with no constant, are reported", () => {
      const doctored = source.replace(
        "| waiting | its step is not current            |",
        "| idle    | its step is not current            |",
      );
      expect(doctored).not.toBe(source);
      expect(ActionTable.checkScreenColumns(doctored, labels)).toEqual([
        "Glossary: Task states idle: no constant",
        "Glossary: Task states: no row for waiting",
      ]);
    });
  });

  describe("the order issue table", () => {
    const TEAM_ROW =
      "| `team`            | {@link OrderRow} `unassigned`                                            | critical | Assign team on the order page       |";
    const EMPTY_TEAM_ROW =
      "| `empty_team`      | {@link OrderRow} `emptyTeam`                                             | warning  | add a member on the team page       |";

    it("Domain.ts passes", () => {
      expect(source).toContain(TEAM_ROW);
      expect(source).toContain(EMPTY_TEAM_ROW);
      expect(checkOrderIssues(source)).toEqual([]);
    });

    it("each order issue has one remedy", () => {
      const doctored = source.replace(
        EMPTY_TEAM_ROW,
        "| `empty_team`      | {@link OrderRow} `emptyTeam`                                             | warning  | assign a team, or add a member      |",
      );
      expect(doctored).not.toBe(source);
      expect(checkOrderIssues(doctored)).toEqual([
        "OrderIssue `empty_team`: a remedy names one action; this one says or",
      ]);
    });

    it("the Tone column is orderIssueIsCritical", () => {
      const doctored = source.replace(
        EMPTY_TEAM_ROW,
        EMPTY_TEAM_ROW.replace("| warning  |", "| critical |"),
      );
      expect(doctored).not.toBe(source);
      expect(checkOrderIssues(doctored)).toEqual([
        "OrderIssue `empty_team`: Tone says critical; orderIssueIsCritical says warning",
      ]);
    });

    it("the Issue column is the OrderIssue literals, in order", () => {
      const doctored = source.replace(
        `${TEAM_ROW}\n * ${EMPTY_TEAM_ROW}`,
        `${EMPTY_TEAM_ROW}\n * ${TEAM_ROW}`,
      );
      expect(doctored).not.toBe(source);
      expect(checkOrderIssues(doctored)).toEqual([
        "OrderIssue: the Issue column is choose_workflow, empty_team, team, blocked; the literals are choose_workflow, team, empty_team, blocked",
      ]);
    });
  });

  describe("every screen a merchant or member uses has a Screens row, and every row's route file exists", () => {
    /** Every route file's source, keyed by file name as `readdirSync` lists it. */
    const routeFiles = Object.fromEntries(
      Object.entries(
        import.meta.glob<string>("/src/routes/*", {
          query: "?raw",
          import: "default",
          eager: true,
        }),
      ).map(([path, text]) => [path.slice("/src/routes/".length), text]),
    );

    it("Domain.ts passes", () => {
      expect(ActionTable.checkScreens(source, routeFiles)).toEqual([]);
    });

    it("a row with no route file, and a screen with no row, are reported", () => {
      const doctored = source.replace(
        "| merchant | `app.members`                     |",
        "| merchant | `app.people`                      |",
      );
      expect(doctored).not.toBe(source);
      expect(ActionTable.checkScreens(doctored, routeFiles)).toEqual([
        "Glossary: Screens: no route file app.people.tsx",
        "Glossary: Screens: app.members.tsx has no row",
      ]);
    });
  });

  describe("data model table", () => {
    /** Every integration test's source, where the pinned titles live. */
    const testSources = import.meta.glob<string>(
      "/test/integration/*.test.ts",
      {
        query: "?raw",
        import: "default",
        eager: true,
      },
    );

    it("the real table parses", () => {
      const rows = Result.getOrThrow(
        ActionTable.parseDataModel(schemaSource, OBJECT),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.about)).toContain("`SyncState`");
    });

    it("a doctored header is refused", () => {
      expect(
        dataModelError(
          schemaSource.replace("| holds by   |", "| held by    |"),
        ),
      ).toMatch(/header is about, rule, held by, pinned by/u);
    });

    it("an about word that is neither a glossary noun nor a table is refused", () => {
      expect(
        dataModelError(
          schemaSource.replace(
            "| `SyncState`       |",
            "| singleton         |",
          ),
        ),
      ).toMatch(/unknown about "singleton"/u);
    });

    it("an unknown holds by is refused", () => {
      expect(
        dataModelError(
          schemaSource.replace(
            "| schema     | an item has exactly one order",
            "| database   | an item has exactly one order",
          ),
        ),
      ).toMatch(/unknown holds by "database"/u);
    });

    it("every pinned title is carried by a test, and a doctored one is reported", () => {
      const rows = Result.getOrThrow(
        ActionTable.parseDataModel(schemaSource, OBJECT),
      );
      expect(ActionTable.checkPinned(rows, testSources, OBJECT.symbol)).toEqual(
        [],
      );
      const doctored = rows.map((row) =>
        row.pinnedBy === "deleteWorkflow cascades its draft and tasks"
          ? { ...row, pinnedBy: "deleteWorkflow cascades nothing" }
          : row,
      );
      expect(
        ActionTable.checkPinned(doctored, testSources, OBJECT.symbol),
      ).toEqual([
        expect.stringMatching(
          /^initializeSchema, line \d+: no test titled "deleteWorkflow cascades nothing"/u,
        ),
      ]);
    });

    it("a pinned title written with it.effect or it.live is found", () => {
      const row = {
        line: 1,
        about: "member",
        rule: "a rule",
        holdsBy: "app",
      } as const;
      const sources = {
        "a.test.ts": `it.effect("pinned by effect", () => Effect.void);`,
        "b.test.ts": `it.live(\n  "pinned by live",\n  () => Effect.void,\n);`,
      };
      expect(
        ActionTable.checkPinned(
          [
            { ...row, pinnedBy: "pinned by effect" },
            { ...row, pinnedBy: "pinned by live" },
            { ...row, pinnedBy: "pinned by nothing" },
          ],
          sources,
          "D1_TABLES",
        ),
      ).toEqual([`D1_TABLES, line 1: no test titled "pinned by nothing"`]);
    });

    it("the D1 table parses and every pinned title is carried by a test", () => {
      const rows = Result.getOrThrow(ActionTable.parseDataModel(d1Source, D1));
      expect(rows.map((row) => row.about)).toEqual(
        expect.arrayContaining(["shop", "member", "team", "`User`"]),
      );
      expect(ActionTable.checkPinned(rows, testSources, D1.symbol)).toEqual([]);
    });
  });
});

const copyTableOf = (row: string) =>
  [
    "/**",
    " * | slot | job | form | empty when | example | never |",
    " * | - | - | - | - | - | - |",
    ` * ${row}`,
    " */",
    "export const CopySlot = 0;",
  ].join("\n");

describe("the copy table on CopySlot", () => {
  it("has one row per slot, each with an example", () => {
    const rows = Result.getOrThrow(
      ActionTable.parseCopyTable(screenSource, Screen.CopySlot.literals),
    );
    expect(rows.map((row) => row.slot)).toEqual([...Screen.CopySlot.literals]);
  });

  it("refuses an unknown slot, a missing slot and an empty cell", () => {
    const message = (row: string, slots: readonly string[]) => {
      const parsed = ActionTable.parseCopyTable(copyTableOf(row), slots);
      if (Result.isSuccess(parsed)) throw new Error("parsed");
      return parsed.failure.message;
    };
    expect(message("| toast | a | b | c | d | e |", ["heading"])).toContain(
      'unknown slot "toast"',
    );
    expect(
      message("| heading | a | b | c | d | e |", ["heading", "toast"]),
    ).toContain("no row for toast");
    expect(message("| heading | a | b | c |  | e |", ["heading"])).toContain(
      "empty cell",
    );
  });

  it("every copy-table example is on a screen", () => {
    const rows = [
      { line: 1, slot: "toast", example: "Note saved" },
      { line: 2, slot: "toast", example: "Saved successfully!" },
    ];
    expect(
      ActionTable.checkCopyExamples(rows, { a: 'toast: "Note saved",' }),
    ).toEqual(['CopySlot, line 2: no screen shows "Saved successfully!"']);
  });

  it("the controls table on Control parses with three non-empty cells per row", () => {
    expect(
      Result.getOrThrow(ActionTable.parseControls(screenSource)).length,
    ).toBeGreaterThan(5);
  });
});
