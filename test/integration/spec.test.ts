import { Result } from "effect";
import { describe, expect, it } from "vitest";

import hostSource from "@/lib/agent/Host.ts?raw";
import d1Source from "@/lib/D1Schema.ts?raw";
import * as Domain from "@/lib/Domain";
import source from "@/lib/Domain.ts?raw";
import billingSource from "@/lib/domain/Billing.ts?raw";
import ordersSource from "@/lib/domain/Orders.ts?raw";
import platformSource from "@/lib/domain/Platform.ts?raw";
import shopWorkSource from "@/lib/domain/ShopWork.ts?raw";
import * as Screen from "@/lib/Screen";
import screenSource from "@/lib/Screen.ts?raw";
import clientSource from "@/lib/ShopAgentClient.ts?raw";
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

/** The context files, which the barrel's map (`source`) names. */
const CONTEXT_SOURCES = [
  platformSource,
  ordersSource,
  billingSource,
  shopWorkSource,
];

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
  ActionTable.checkOrderIssues(doctored, Domain.OrderIssue.literals);

const checkStored = (doctored: string) =>
  ActionTable.checkStoredCells(doctored, schemaSource);

/** ShopWork.ts with one string replaced; fails if the string is not there. */
const doctorShopWork = (from: string, to: string) => {
  const doctored = shopWorkSource.replace(from, to);
  expect(doctored).not.toBe(shopWorkSource);
  return doctored;
};

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
      { state: "open", blockedAt: null },
      { state: "open", blockedAt: 1 },
      { state: "done", blockedAt: null },
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

  it("a vocabulary word absent from the rest of the file is reported", () => {
    const source = [
      "/**",
      " * Vocabulary.",
      " *",
      " * | word | symbol |",
      " * | run | `Run`, `RunTask` |",
      " * | open | `pending` |",
      " * | screen | `Closed · <reason>` |",
      " */",
      "export const Run = 1;",
      "export const RunTaskRow = 2;",
    ].join("\n");
    expect(ActionTable.checkVocabulary(source)).toEqual(["RunTask", "pending"]);
  });

  it("a word written as another context's is checked against that context's file", () => {
    const source = [
      "/**",
      " * Vocabulary, billing.",
      " *",
      " * | word | symbol |",
      " * | plan | `Plan`, `Subscription` in Platform, `Shop` in Platform |",
      " */",
      "export const Plan = 1;",
    ].join("\n");
    expect(
      ActionTable.checkVocabulary(source, [], {
        Platform: "export const Subscription = 1;",
      }),
    ).toEqual(["Shop in Platform"]);
  });

  it("a qualified word may name a context spelled with two capitals", () => {
    const source = [
      "/**",
      " * Vocabulary, orders.",
      " *",
      " * | word | symbol |",
      " * | item | `OrderLineItem`, `lineItemId` in ShopWork |",
      " */",
      "export const OrderLineItem = 1;",
    ].join("\n");
    expect(
      ActionTable.checkVocabulary(source, [], {
        ShopWork: "export const lineItemId = 1;",
      }),
    ).toEqual([]);
    expect(ActionTable.checkVocabulary(source, [], { ShopWork: "" })).toEqual([
      "lineItemId in ShopWork",
    ]);
  });

  it("Domain.ts and every context file name only words that exist", () => {
    const contexts = {
      Platform: platformSource,
      Orders: ordersSource,
      Billing: billingSource,
      ShopWork: shopWorkSource,
    };
    expect(
      [
        ActionTable.checkVocabulary(source, CONTEXT_SOURCES, contexts),
        ...CONTEXT_SOURCES.map((each) =>
          ActionTable.checkVocabulary(each, [source], contexts),
        ),
      ].flat(),
    ).toEqual([]);
  });

  describe("the vocabulary's screen column is the label constant", () => {
    const labels: ActionTable.ScreenLabels = {
      taskStates: Domain.TASK_STATE_LABEL,
      runStates: Domain.RUN_STATE_LABEL,
      workflowStates: Domain.WORKFLOW_STATE_LABEL,
      orderPositions: Domain.ORDER_POSITION_LABEL,
      orderIssues: Domain.ORDER_ISSUE_LABEL,
      verbs: Domain.VERB_LABEL,
    };

    it("ShopWork.ts passes", () => {
      expect(ActionTable.checkScreenColumns(shopWorkSource, labels)).toEqual(
        [],
      );
    });

    it("a doctored cell is reported", () => {
      const doctored = shopWorkSource.replace(
        "| put back        | task     | started → ready                          | Put back    | Put back        |",
        "| put back        | task     | started → ready                          | Put back    | Take back       |",
      );
      expect(doctored).not.toBe(shopWorkSource);
      expect(ActionTable.checkScreenColumns(doctored, labels)).toEqual([
        'Vocabulary: Verbs put back: merchant says "Take back", constant says "Put back"',
      ]);
    });

    it("a spaced word finds its snake-case literal key", () => {
      const doctored = shopWorkSource.replace(
        "| not started | open, no open run and no done run | Not started |",
        "| not started | open, no open run and no done run | To make     |",
      );
      expect(doctored).not.toBe(shopWorkSource);
      expect(ActionTable.checkScreenColumns(doctored, labels)).toEqual([
        'Vocabulary: Order positions not started: screen says "To make", constant says "Not started"',
      ]);
    });

    it("a hyphenated word finds its snake-case literal key", () => {
      const doctored = shopWorkSource.replace(
        "on an order that can create runs | Multiple workflows match |",
        "on an order that can create runs | Two workflows match      |",
      );
      expect(doctored).not.toBe(shopWorkSource);
      expect(ActionTable.checkScreenColumns(doctored, labels)).toEqual([
        'Vocabulary: Order issues multi-match: screen says "Two workflows match", constant says "Multiple workflows match"',
      ]);
    });

    it("a constant with no row, and a row with no constant, are reported", () => {
      const doctored = shopWorkSource.replace(
        "| waiting | its step is not current            |",
        "| idle    | its step is not current            |",
      );
      expect(doctored).not.toBe(shopWorkSource);
      expect(ActionTable.checkScreenColumns(doctored, labels)).toEqual([
        "Vocabulary: Task states idle: no constant",
        "Vocabulary: Task states: no row for waiting",
      ]);
    });
  });

  describe("the vocabulary's stored column is a column or literal of initializeSchema", () => {
    it("ShopWork.ts passes", () => {
      expect(checkStored(shopWorkSource)).toEqual([]);
    });

    it("a doctored cell form is reported", () => {
      expect(
        checkStored(
          doctorShopWork(
            "| work can be recorded                              | `open`          |",
            "| work can be recorded                              | `open` sometimes |",
          ),
        ),
      ).toEqual([
        'ShopWork.ts, Run states, open: stored cell "`open` sometimes" is not a literal, `<column>` set or `<column>` null',
      ]);
    });

    it("a literal in no check constraint is reported", () => {
      expect(
        checkStored(
          doctorShopWork(
            "| work can be recorded                              | `open`          |",
            "| work can be recorded                              | `opened`        |",
          ),
        ),
      ).toEqual([
        "ShopWork.ts, Run states, open: stored literal `opened` is in no check constraint of initializeSchema",
      ]);
    });

    it("a column in no table is reported", () => {
      expect(
        checkStored(
          doctorShopWork(
            "| open, and a person holds it                       | `blockedAt` set |",
            "| open, and a person holds it                       | `blockedOn` set |",
          ),
        ),
      ).toEqual([
        "ShopWork.ts, Run states, blocked: stored column `blockedOn` is in no table of initializeSchema",
      ]);
    });

    it("a trailing current clause is accepted", () => {
      const task = ActionTable.vocabularyTables(shopWorkSource).find((table) =>
        table.intro.startsWith("Task states"),
      );
      expect(task?.rows.map((row) => row.stored)).toEqual([
        "`startedAt` null, `doneAt` null; not current",
        "`startedAt` null, `doneAt` null; current",
        "`startedAt` set",
        "`doneAt` set",
      ]);
      expect(checkStored(shopWorkSource)).toEqual([]);
    });
  });

  describe("every vocabulary table names its context", () => {
    it("Domain.ts and the context files pass", () => {
      expect(ActionTable.checkContexts(source, CONTEXT_SOURCES)).toEqual([]);
    });

    it("an intro with no context, and a context cell outside the Contexts table, are reported", () => {
      const doctored = shopWorkSource.replace(
        " * Run states, shop work:",
        " * Run states:",
      );
      expect(doctored).not.toBe(shopWorkSource);
      const byCell = [
        "/**",
        " * Vocabulary, platform.",
        " *",
        " * Nouns, by cell:",
        " *",
        " * | word | context |",
        " * | ---- | ------- |",
        " * | shop | tenancy |",
        " */",
      ].join("\n");
      expect(ActionTable.checkContexts(source, [doctored, byCell])).toEqual([
        "Vocabulary: Run states: its intro names no context",
        'Vocabulary: Nouns shop: context "tenancy" is not in the Contexts table',
      ]);
    });

    it("a map with no kind column, and a shared word in a context outside the map, are reported", () => {
      const doctored = source
        .replace("| context   | kind       |", "| context   | sort       |")
        .replace(
          "| cancel | orders, shop work |",
          "| cancel | orders, shipping   |",
        );
      expect(doctored).not.toBe(source);
      expect(ActionTable.checkContexts(doctored)).toEqual([
        "Vocabulary: Contexts: the map has no kind column",
        'Vocabulary: Shared words cancel: context "shipping" is not in the Contexts table',
      ]);
    });
  });

  describe("the order issue table", () => {
    const TEAM_ROW =
      "| `unassigned`  | {@link OrderRow} `unassigned`                                                    | Assign team on the order page       |";
    const EMPTY_TEAM_ROW =
      "| `empty_team`  | {@link OrderRow} `emptyTeam`                                                     | add a member on the team page       |";

    it("ShopWork.ts passes", () => {
      expect(shopWorkSource).toContain(TEAM_ROW);
      expect(shopWorkSource).toContain(EMPTY_TEAM_ROW);
      expect(checkOrderIssues(shopWorkSource)).toEqual([]);
    });

    it("each order issue has one remedy", () => {
      const doctored = shopWorkSource.replace(
        EMPTY_TEAM_ROW,
        "| `empty_team`  | {@link OrderRow} `emptyTeam`                                                     | assign a team, or add a member      |",
      );
      expect(doctored).not.toBe(shopWorkSource);
      expect(checkOrderIssues(doctored)).toEqual([
        "OrderIssue `empty_team`: a remedy names one action; this one says or",
      ]);
    });

    it("the Issue column is the OrderIssue literals, in order", () => {
      const doctored = shopWorkSource.replace(
        `${TEAM_ROW}\n * ${EMPTY_TEAM_ROW}`,
        `${EMPTY_TEAM_ROW}\n * ${TEAM_ROW}`,
      );
      expect(doctored).not.toBe(shopWorkSource);
      expect(checkOrderIssues(doctored)).toEqual([
        "OrderIssue: the Issue column is multi_match, empty_team, unassigned, blocked; the literals are multi_match, unassigned, empty_team, blocked",
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
        "Vocabulary: Screens: no route file app.people.tsx",
        "Vocabulary: Screens: app.members.tsx has no row",
      ]);
    });
  });

  describe("the shape families table", () => {
    const shapeSources = {
      "src/lib/domain/Platform.ts": platformSource,
      "src/lib/domain/Orders.ts": ordersSource,
      "src/lib/domain/Billing.ts": billingSource,
      "src/lib/domain/ShopWork.ts": shopWorkSource,
      "src/lib/ShopAgentClient.ts": clientSource,
    };

    it("the real table parses and every rule symbol exists", () => {
      expect(ActionTable.checkShapeFamilies(source, shapeSources)).toEqual([]);
    });

    it("a row whose rule symbol is doctored is reported", () => {
      const doctored = source.replace(
        "| `StartTaskCommand`                            |",
        "| `BeginTaskCommand`                            |",
      );
      expect(doctored).not.toBe(source);
      expect(ActionTable.checkShapeFamilies(doctored, shapeSources)).toEqual([
        "Shape families command: rule symbol BeginTaskCommand not found",
      ]);
    });

    it("a Command export placed in Orders.ts is reported", () => {
      expect(
        ActionTable.checkShapeFamilies(source, {
          ...shapeSources,
          "src/lib/domain/Orders.ts": `${ordersSource}\nexport interface SyncOrderCommand {}\n`,
        }),
      ).toEqual([
        "Shape families command: SyncOrderCommand is in Orders.ts, the row says `ShopWork.ts`",
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

    it("an about word that is neither a vocabulary noun nor a table is refused", () => {
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

const triggerError = (doctored: string) => {
  expect(doctored).not.toBe(billingSource);
  const parsed = ActionTable.parseTriggerTable(doctored);
  if (Result.isSuccess(parsed)) throw new Error("parsed");
  return parsed.failure.message;
};

describe("triggers table parser", () => {
  it("the real table parses and every pinned title is carried by a test", () => {
    const testSources = import.meta.glob<string>(
      "/test/integration/*.test.ts",
      { query: "?raw", import: "default", eager: true },
    );
    const rows = Result.getOrThrow(
      ActionTable.parseTriggerTable(billingSource),
    );
    expect(rows.map((row) => row.trigger)).toContain("first run on an order");
    expect(ActionTable.checkPinned(rows, testSources, "ShopUsage")).toEqual([]);
  });

  it("a word outside the list in a count column is refused", () => {
    expect(
      triggerError(
        billingSource.replace(
          "| first run on an order                           | +1          |",
          "| first run on an order                           | plus one    |",
        ),
      ),
    ).toMatch(/unknown order count "plus one"/u);
    expect(
      triggerError(
        billingSource.replace(
          "| first count past the cycle end                  | recounted   | → 0                     |",
          "| first count past the cycle end                  | recounted   | reset                   |",
        ),
      ),
    ).toMatch(/unknown seat mark "reset"/u);
  });

  it("an empty pinned by is refused", () => {
    expect(
      triggerError(
        billingSource.replace(
          "| a seeded order is never counted                                                                                                           |",
          "|                                                                                                                                           |",
        ),
      ),
    ).toMatch(/empty pinned by/u);
  });
});

/** A `reconcileItem` JSDoc holding one triggers row and one actions row. */
const reconcileTablesOf = (trigger: string, action: string) =>
  [
    "/**",
    " * | trigger | shape | skipped when | pinned by |",
    " * | - | - | - | - |",
    ` * ${trigger}`,
    " *",
    " * | order | paid | units | run on item | matches | action |",
    " * | - | - | - | - | - | - |",
    ` * ${action}`,
    " */",
    "export const reconcileItem = 0;",
  ].join("\n");

const TRIGGER_ROW = "| Turn on | reconcile all | never | (none yet) |";
const ACTION_ROW = "| open | yes | some | none | 1 | create |";

const reconcileError = (
  parse: (source: string) => Result.Result<unknown, { message: string }>,
  doctored: string,
) => {
  const parsed = parse(doctored);
  if (Result.isSuccess(parsed)) throw new Error("parsed");
  return parsed.failure.message;
};

describe("reconcile triggers table parser", () => {
  it("the real table parses and every pinned title is carried by a test", () => {
    const testSources = import.meta.glob<string>(
      "/test/integration/*.test.ts",
      { query: "?raw", import: "default", eager: true },
    );
    const rows = Result.getOrThrow(
      ActionTable.parseReconcileTriggers(shopWorkSource),
    );
    expect(rows.map((row) => row.trigger)).toContain("Turn on");
    expect(ActionTable.checkPinned(rows, testSources, "reconcileItem")).toEqual(
      [],
    );
  });

  it("a shape outside the list is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcileTriggers,
        reconcileTablesOf(
          "| Turn on | every order | never | (none yet) |",
          ACTION_ROW,
        ),
      ),
    ).toMatch(/unknown shape "every order"/u);
  });

  it("an empty pinned by is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcileTriggers,
        reconcileTablesOf("| Turn on | reconcile all | never | |", ACTION_ROW),
      ),
    ).toMatch(/empty pinned by/u);
  });
});

describe("reconcile actions table parser", () => {
  it("the real table parses, after the triggers table", () => {
    const rows = Result.getOrThrow(
      ActionTable.parseReconcileActions(shopWorkSource),
    );
    expect(rows.map((row) => row.action.tag)).toEqual(
      expect.arrayContaining(["create", "close", "resize", "nothing"]),
    );
  });

  it("reads the close reason and the text after the colon", () => {
    const [row] = Result.getOrThrow(
      ActionTable.parseReconcileActions(
        reconcileTablesOf(
          TRIGGER_ROW,
          "| cancelled | any | any | open | any | close `order_cancelled`: Shopify ended it |",
        ),
      ),
    );
    expect(row?.action).toEqual({
      tag: "close",
      reason: "order_cancelled",
      note: "Shopify ended it",
    });
    expect(row && ActionTable.expandReconcileAction(row)).toHaveLength(
      2 * 3 * 2 * 3,
    );
  });

  it("a word outside its list is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcileActions,
        reconcileTablesOf(
          TRIGGER_ROW,
          "| open | maybe | some | none | 1 | create |",
        ),
      ),
    ).toMatch(/unknown word "maybe" under paid/u);
    expect(
      reconcileError(
        ActionTable.parseReconcileActions,
        reconcileTablesOf(
          TRIGGER_ROW,
          "| open | yes | some | none | 1 | start |",
        ),
      ),
    ).toMatch(/action "start"/u);
  });
});

/** `shopWorkSource` with its first line matching `pattern` passed through `edit`. */
const shopWorkWith = (pattern: RegExp, edit: (line: string) => string) =>
  shopWorkSource.replace(pattern, edit);

const pinnedTestSources = () =>
  import.meta.glob<string>("/test/integration/*.test.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  });

describe("reconcile effects table parser", () => {
  it("the real table parses, one row per action, and every pinned title is carried by a test", () => {
    const rows = Result.getOrThrow(
      ActionTable.parseReconcileEffects(shopWorkSource),
    );
    expect(rows.map((row) => row.action)).toEqual(
      ActionTable.RECONCILE_EFFECT_WORDS.action,
    );
    expect(
      ActionTable.checkPinned(rows, pinnedTestSources(), "reconcileItem"),
    ).toEqual([]);
  });

  it("a word outside its list is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcileEffects,
        shopWorkWith(/^ \* \| resize +\|.*$/mu, (line) =>
          line.replace("quantity rewritten", "rewritten"),
        ),
      ),
    ).toMatch(/unknown word "rewritten" under run row/u);
  });

  it("a header other than the effects header is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcileEffects,
        shopWorkWith(/^ \* \| action +\| run row .*$/mu, (line) =>
          line.replace("ceiling flag", "flag        "),
        ),
      ),
    ).toMatch(/header is action, run row, counted order, queue, flag/u);
  });

  it("an action that is not a row exactly once is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcileEffects,
        shopWorkWith(/^ \* \| resize +\|.*$/mu, (line) =>
          line.replace("resize", "create"),
        ),
      ),
    ).toMatch(/not once: create, resize/u);
  });
});

describe("reconcile pass rules table parser", () => {
  it("the real table parses and every pinned title is carried by a test", () => {
    const rows = Result.getOrThrow(
      ActionTable.parseReconcilePassRules(shopWorkSource),
    );
    expect(rows[0]?.where).toEqual(["RunRepository.reconcileOrder"]);
    expect(
      ActionTable.checkPinned(rows, pinnedTestSources(), "reconcileItem"),
    ).toEqual([]);
  });

  it("an empty rule is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcilePassRules,
        shopWorkWith(/^ \* \| 9\. a pass is idempotent: [^|]*/mu, (cell) =>
          " * | ".padEnd(cell.length),
        ),
      ),
    ).toMatch(/empty rule/u);
  });

  it("a where that is not backticked symbols is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcilePassRules,
        shopWorkWith(/^ \* \| 9\. a pass is idempotent: .*$/mu, (line) =>
          line.replace("`reconcileItem`", "the planner  "),
        ),
      ),
    ).toMatch(/where "the planner" is not one or more backticked symbols/u);
  });

  it("a header other than the pass rules header is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseReconcilePassRules,
        shopWorkWith(/^ \* \| rule +\| where +\|.*$/mu, (line) =>
          line.replace("where", "who  "),
        ),
      ),
    ).toMatch(/header is rule, who, pinned by/u);
  });
});

describe("sync pipeline table parser", () => {
  it("the real table parses, after the services table", () => {
    const rows = Result.getOrThrow(ActionTable.parseSyncPipeline(hostSource));
    expect(rows.map((row) => row.reconcile)).toContain("reconcile all");
  });

  it("a reconcile cell that names no shape is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseSyncPipeline,
        hostSource.replace(/^ \* \| seed \(dev\) .*$/mu, (line) =>
          line.replace("reconcile each, then reconcile all", "every order"),
        ),
      ),
    ).toMatch(/reconcile "every order" is not —/u);
  });

  it("an empty cell is refused", () => {
    expect(
      reconcileError(
        ActionTable.parseSyncPipeline,
        hostSource.replace(/^ \* \| seed \(dev\) +\|[^|]*\|/mu, (cells) =>
          cells.replace("upsert each", "           "),
        ),
      ),
    ).toMatch(/empty store/u);
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
