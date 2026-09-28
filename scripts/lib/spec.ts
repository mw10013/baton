import type { OrderState, RunStatus } from "../../src/lib/Domain.ts";

/**
 * Reads the action matrices out of the JSDoc on `runActions` and
 * `taskActions` in `src/lib/Domain.ts`, so the table a person edits is the
 * table the test asserts. Pure: it takes the source text as a parameter,
 * because the test runs inside workerd (no `node:fs`) and gets the text
 * through Vite's `?raw` import, while `scripts/spec.ts` reads the
 * file from disk. The same module checks the glossary and reads the two
 * data-model tables, on `initializeSchema` (`src/lib/ShopAgentSchema.ts`)
 * and on `D1_TABLES` (`src/lib/D1Schema.ts`).
 */
import { Data, Result, Schema } from "effect";

/** An action cell: blank is never, `blocker` is Reopen offered with the downstream blocker. */
export const Cell = Schema.Literals(["", "M", "m", "M m", "blocker"]);
export type Cell = typeof Cell.Type;

/** One parsed row: the state words by column, the cell by action, and the source line it came from. */
export interface Row {
  readonly line: number;
  readonly state: Readonly<Record<string, string>>;
  readonly cells: Readonly<Record<string, Cell>>;
}

/** Which columns are state and which are actions, per table. */
export const TABLES = {
  runActions: {
    state: ["order", "run", "blocked", "units"],
    actions: [
      "note",
      "block",
      "editReason",
      "unblock",
      "cancel",
      "changeWorkflow",
    ],
  },
  taskActions: {
    state: ["order", "run", "blocked", "task", "downstream"],
    actions: ["start", "done", "putBack", "reopen", "assign"],
  },
} as const;
export type TableName = keyof typeof TABLES;

export class ParseError extends Data.TaggedError("ParseError")<{
  readonly message: string;
}> {}

const OrderWord = Schema.Literals(["open", "closed"]);
const RunWord = Schema.Literals(["open", "done", "closed", "open or done"]);
const BlockedWord = Schema.Literals(["yes", "no", "any"]);
const UnitsWord = Schema.Literals(["some", "none"]);
const TaskWord = Schema.Literals([
  "ready",
  "started",
  "waiting",
  "done",
  "any open",
  "any",
]);
const DownstreamWord = Schema.Literals(["none", "started", "-"]);

/** The words each state column accepts. */
const WORDS = {
  order: OrderWord,
  run: RunWord,
  blocked: BlockedWord,
  units: UnitsWord,
  task: TaskWord,
  downstream: DownstreamWord,
} as const;

interface TaskState {
  readonly current: boolean;
  readonly startedAt: number | null;
  readonly doneAt: number | null;
}

const READY: TaskState = { current: true, startedAt: null, doneAt: null };
const STARTED: TaskState = { current: true, startedAt: 1, doneAt: null };
const WAITING: TaskState = { current: false, startedAt: null, doneAt: null };
const DONE: TaskState = { current: false, startedAt: 1, doneAt: 2 };

const ORDERS: Record<typeof OrderWord.Type, readonly OrderState[]> = {
  open: [{ cancelledAt: null, fulfillmentStatus: "UNFULFILLED" }],
  closed: [
    { cancelledAt: 1, fulfillmentStatus: "UNFULFILLED" },
    { cancelledAt: null, fulfillmentStatus: "FULFILLED" },
  ],
};
const RUNS: Record<typeof RunWord.Type, readonly RunStatus[]> = {
  open: ["active"],
  done: ["done"],
  closed: ["closed"],
  "open or done": ["active", "done"],
};
const BLOCKED: Record<typeof BlockedWord.Type, readonly (number | null)[]> = {
  yes: [1],
  no: [null],
  any: [null, 1],
};
const UNITS: Record<typeof UnitsWord.Type, readonly number[]> = {
  some: [1],
  none: [0],
};
const TASKS: Record<typeof TaskWord.Type, readonly TaskState[]> = {
  ready: [READY],
  started: [STARTED],
  waiting: [WAITING],
  done: [DONE],
  "any open": [READY, STARTED, WAITING],
  any: [READY, STARTED, WAITING, DONE],
};

/**
 * One concrete input to `runActions` or `taskActions`. `task` is the task
 * under test for `taskActions`; for `runActions` it is the run's one task,
 * on the member's team and current exactly when the run is open, which is who
 * "m" is. `item` is present on `runActions` fixtures only.
 */
export interface Fixture<TeamId, Blocker> {
  readonly order: OrderState;
  readonly run: {
    readonly status: RunStatus;
    readonly blockedAt: number | null;
  };
  readonly task: TaskState & {
    readonly teamId: TeamId;
    readonly reopenBlockedBy: Blocker | null;
  };
  readonly item?: { readonly currentQuantity: number };
}

/**
 * Expand one row's state words into every concrete fixture it names. A word
 * that names several states ("closed" under `order`, "any", "or") multiplies
 * the fixtures, so one row covers every combination it claims.
 *
 * | column     | word         | fixture                                                                              |
 * | ---------- | ------------ | ------------------------------------------------------------------------------------ |
 * | order      | open         | `{ cancelledAt: null, fulfillmentStatus: "UNFULFILLED" }`                            |
 * | order      | closed       | cancelled `{ cancelledAt: 1, ... "UNFULFILLED" }`; fulfilled `{ null, "FULFILLED" }` |
 * | run        | open         | status `active`                                                                      |
 * | run        | done         | status `done`                                                                        |
 * | run        | closed       | status `closed`                                                                      |
 * | run        | open or done | `active`; `done`                                                                     |
 * | blocked    | yes / no     | `blockedAt` 1 / null                                                                 |
 * | blocked    | any          | both on an open run; null on a done run                                              |
 * | units      | some / none  | `currentQuantity` 1 / 0 (runActions only)                                            |
 * | task       | ready        | `current: true, startedAt: null, doneAt: null`                                       |
 * | task       | started      | `current: true, startedAt: 1, doneAt: null`                                          |
 * | task       | waiting      | `current: false, startedAt: null, doneAt: null`                                      |
 * | task       | done         | `current: false, startedAt: 1, doneAt: 2`                                            |
 * | task       | any open     | ready; started; waiting                                                              |
 * | task       | any          | ready; started; waiting; done                                                        |
 * | downstream | none         | `reopenBlockedBy: null`                                                                |
 * | downstream | started      | `reopenBlockedBy: BLOCKER` (the caller's `blocker`)                                    |
 * | downstream | -            | not applicable; fixture `null`                                                       |
 *
 * The `ready` and `started` words are the glossary's narrow task states. The
 * `current` flag they set is the broad one (`Domain.currentTasks`: the
 * task's step is current, started or not), so both set it.
 *
 * **A done run is never blocked.** Only an open run can carry a block (the
 * data model on `initializeSchema`, `ShopAgentSchema.ts`), so "any" under
 * `blocked` on an "open or done" row expands to a block on the open run
 * only; a blocked done run is not a state and is not a fixture.
 */
export const expand = <TeamId, Blocker>(
  name: TableName,
  row: Row,
  context: { readonly teamId: TeamId; readonly blocker: Blocker },
): readonly Fixture<TeamId, Blocker>[] => {
  const word = <K extends keyof typeof WORDS>(column: K) =>
    Schema.decodeUnknownSync(WORDS[column])(row.state[column]);
  const states = ORDERS[word("order")].flatMap((order) =>
    RUNS[word("run")].flatMap((status) =>
      BLOCKED[word("blocked")]
        .filter((blockedAt) => blockedAt === null || status === "active")
        .map((blockedAt) => ({
          order,
          run: { status, blockedAt },
        })),
    ),
  );
  if (name === "runActions")
    return states.flatMap(({ order, run }) =>
      UNITS[word("units")].map((currentQuantity) => ({
        order,
        run,
        task: {
          teamId: context.teamId,
          // `Domain.runIsOpen`, spelled out: this module imports `Domain`
          // for types only, so the CLI runs without the app's runtime.
          current: run.status === "active",
          startedAt: null,
          doneAt: null,
          reopenBlockedBy: null,
        },
        item: { currentQuantity },
      })),
    );
  const reopenBlockedBy =
    word("downstream") === "started" ? context.blocker : null;
  return states.flatMap(({ order, run }) =>
    TASKS[word("task")].map((task) => ({
      order,
      run,
      task: { ...task, teamId: context.teamId, reopenBlockedBy },
    })),
  );
};

/** Where the JSDoc before `export const <name> =` starts and ends, or a message saying why there is none. */
const jsdocBefore = (
  source: string,
  name: string,
): Result.Result<
  { readonly start: number; readonly end: number },
  ParseError
> => {
  const at = source.indexOf(`\nexport const ${name} =`);
  if (at === -1)
    return Result.fail(
      new ParseError({ message: `${name}: no \`export const ${name} =\`` }),
    );
  const end = source.slice(0, at).trimEnd().length;
  const start = source.lastIndexOf("/**", end);
  if (!source.slice(0, end).endsWith("*/") || start === -1)
    return Result.fail(
      new ParseError({ message: `${name}: no JSDoc before the export` }),
    );
  return Result.succeed({ start, end });
};

const cellsOf = (line: string) =>
  line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());

const decodeRow = (
  name: TableName,
  header: readonly string[],
  line: number,
  text: string,
): Result.Result<Row, ParseError> => {
  const { state, actions } = TABLES[name];
  const fail = (message: string) =>
    Result.fail(
      new ParseError({ message: `${name}, line ${String(line)}: ${message}` }),
    );
  const values = cellsOf(text);
  if (values.length !== header.length)
    return fail(
      `${String(values.length)} cells, expected ${String(header.length)}: ${text}`,
    );
  const words: Record<string, string> = {};
  for (const [index, column] of state.entries()) {
    const value = values[index] ?? "";
    const schema = WORDS[column];
    if (!Schema.is(schema)(value))
      return fail(
        `unknown word "${value}" under ${column}; expected one of: ${schema.literals.join(", ")}`,
      );
    words[column] = value;
  }
  const cells: Record<string, Cell> = {};
  for (const [index, column] of actions.entries()) {
    const value = values[state.length + index] ?? "";
    if (!Schema.is(Cell)(value))
      return fail(
        `cell "${value}" under ${column}; expected one of: ${Cell.literals.map((cell) => (cell === "" ? "blank" : cell)).join(", ")}`,
      );
    if (value === "blocker" && column !== "reopen")
      return fail(`cell "blocker" under ${column}; it is only a reopen cell`);
    cells[column] = value;
  }
  return Result.succeed({ line, state: words, cells });
};

/** A table's lines with their source line numbers, markdown cell padding and JSDoc gutter removed. */
interface TableLines {
  readonly head: readonly string[];
  readonly body: readonly { readonly line: number; readonly text: string }[];
}

/**
 * Find the JSDoc immediately preceding `export const <name> =` in `source`
 * and take its first markdown table. The header must equal `expected`, and
 * the line after it must be the separator. Shared by the action matrices and
 * the data-model table, so both locate and frame their table the same way.
 */
const firstTable = (
  source: string,
  name: string,
  expected: readonly string[],
): Result.Result<TableLines, ParseError> =>
  Result.flatMap(jsdocBefore(source, name), ({ start, end }) => {
    const firstLine = source.slice(0, start).split("\n").length;
    const lines = source
      .slice(start, end)
      .split("\n")
      .map((text, index) => ({
        line: firstLine + index,
        text: text.replace(/^\s*\*? ?/u, "").trim(),
      }));
    const from = lines.findIndex(({ text }) => text.startsWith("|"));
    if (from === -1)
      return Result.fail(
        new ParseError({ message: `${name}: no table in its JSDoc` }),
      );
    const to = lines.findIndex(
      ({ text }, index) => index > from && !text.startsWith("|"),
    );
    const [head, separator, ...body] = lines.slice(
      from,
      to === -1 ? undefined : to,
    );
    const header = cellsOf(head?.text ?? "");
    if (header.join("|") !== expected.join("|"))
      return Result.fail(
        new ParseError({
          message: `${name}, line ${String(head?.line)}: header is ${header.join(", ")}; expected ${expected.join(", ")}`,
        }),
      );
    // The second line is skipped as the separator, so it must be one: a
    // table without it would lose its first row silently.
    if (!cellsOf(separator?.text ?? "").every((cell) => /^:?-+:?$/u.test(cell)))
      return Result.fail(
        new ParseError({
          message: `${name}, line ${String(separator?.line)}: expected the separator row after the header`,
        }),
      );
    return Result.succeed({ head: header, body });
  });

/**
 * Find the JSDoc immediately preceding `export const <name> =` in `source`,
 * take its first markdown table, and decode it. The header must be the
 * table's state columns then its action columns, in {@link TABLES}' order.
 * Fails with a message that names the line and the offending word or cell.
 */
export const parse = (
  source: string,
  name: TableName,
): Result.Result<readonly Row[], ParseError> =>
  Result.flatMap(
    firstTable(source, name, [...TABLES[name].state, ...TABLES[name].actions]),
    ({ head, body }) =>
      Result.all(
        body.map(({ line, text }) => decodeRow(name, head, line, text)),
      ),
  );

/** The row rendered back as one line, for `it` titles and `print`. Blank cells are left out. */
export const renderRow = (name: TableName, row: Row): string => {
  const { state, actions } = TABLES[name];
  const offered = actions
    .filter((action) => row.cells[action] !== "")
    .map((action) => `${action} ${row.cells[action]}`);
  return `${state.map((column) => `${column} ${row.state[column]}`).join(", ")} → ${offered.length === 0 ? "nothing" : offered.join(", ")}`;
};

/**
 * No two rows of a table expand to a common fixture. Independence is what
 * makes a row safe to edit alone: a fixture claimed by two rows would pass
 * or fail by whichever the test read last.
 */
export const overlaps = (
  name: TableName,
  rows: readonly Row[],
): readonly (readonly [Row, Row])[] => {
  const keys = rows.map(
    (row) =>
      new Set(
        expand(name, row, { teamId: "t", blocker: "b" }).map((fixture) =>
          JSON.stringify(fixture),
        ),
      ),
  );
  return rows.flatMap((row, i) =>
    rows
      .slice(i + 1)
      .filter((_, offset) =>
        [...(keys[i] ?? [])].some((key) => keys[i + 1 + offset]?.has(key)),
      )
      .map((other) => [row, other] as const),
  );
};

/**
 * Every backticked identifier in the Glossary block occurs as a word
 * elsewhere in the source. A rename that skipped the glossary is the
 * failure this catches; it does not prove the word is the right kind of
 * thing (a literal, an export). Reports the missing words.
 */
export const checkGlossary = (source: string): readonly string[] => {
  const start = source.indexOf("/**\n * Glossary.");
  if (start === -1) return ["(no Glossary block)"];
  const end = source.indexOf("*/", start) + 2;
  const rest = source.slice(0, start) + source.slice(end);
  const words = new Set(
    [...source.slice(start, end).matchAll(/`(?<word>[^`]+)`/gu)]
      .map((match) => match.groups?.word ?? "")
      .filter((word) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(word)),
  );
  return [...words].filter(
    (word) => !new RegExp(`\\b${word}\\b`, "u").test(rest),
  );
};

/**
 * The label constants the glossary's screen columns are checked against,
 * passed in rather than imported so this module stays free of the app's
 * runtime: `scripts/spec.ts` and the test hand it `Domain`'s values.
 */
export interface ScreenLabels {
  readonly taskStates: Readonly<Record<string, string | null>>;
  readonly runStates: Readonly<Record<string, string>>;
  readonly workflowStates: Readonly<Record<string, string>>;
  readonly productionStates: Readonly<Record<string, string>>;
  readonly orderIssues: Readonly<Record<string, string>>;
  readonly verbs: Readonly<
    Record<
      string,
      { readonly member: string | null; readonly merchant: string | null }
    >
  >;
}

/** A glossary table: the first line of the paragraph that introduces it, and its body rows as cells by header. */
interface GlossaryTable {
  readonly intro: string;
  readonly rows: readonly Readonly<Record<string, string>>[];
}

const glossaryTables = (source: string): readonly GlossaryTable[] => {
  const start = source.indexOf("/**\n * Glossary.");
  if (start === -1) return [];
  const lines = source
    .slice(start, source.indexOf("*/", start))
    .split("\n")
    .map((text) => text.replace(/^\s*\/?\*+ ?/u, "").trim());
  const tables: GlossaryTable[] = [];
  // The first line of the paragraph before a table names it ("Task
  // states. `current` is the flag: ..."), so a paragraph's later lines do
  // not replace it.
  let intro = "";
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index] ?? "";
    if (text.startsWith("|")) {
      const header = cellsOf(text);
      const rows: Record<string, string>[] = [];
      // Skip the separator, then read body rows until the table ends.
      index += 2;
      for (; (lines[index] ?? "").startsWith("|"); index++) {
        const values = cellsOf(lines[index] ?? "");
        rows.push(
          Object.fromEntries(
            header.map((column, at) => [column, values[at] ?? ""]),
          ),
        );
      }
      tables.push({ intro, rows });
    } else if (text !== "" && (lines[index - 1] ?? "") === "") {
      intro = text;
    }
  }
  return tables;
};

/** `put back` → `putBack`. */
const camel = (word: string) =>
  word.replaceAll(/ (?<letter>[a-z])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );

/**
 * The constant key a glossary word names: `camel(word)` if the constants
 * have it, else the word snake-cased (`not started` → `not_started`). Verb
 * keys are camel case because they name action-struct fields
 * ({@link ScreenLabels} `verbs`); order-position and order-issue keys are the
 * stored literals, which are snake case.
 */
const keyOf = (word: string, constants: Readonly<Record<string, unknown>>) =>
  camel(word) in constants ? camel(word) : word.replaceAll(" ", "_");

/**
 * **The glossary's screen column is the label constant.** Each screen cell in
 * the Task states, Run states, Workflow states, Order positions, Order issues
 * and Verbs tables equals the
 * constant's value for its word ("(none)" for `null`), every constant key
 * has a row, and every row has a key. A run-state cell is compared up to its
 * first " (" or " ·", because the open row carries the merchant's second
 * word and the closed row its reason. Reports each mismatch.
 */
/** A constant's value as the glossary prints it: `null` is "(none)". */
const shown = (value: string | null) => value ?? "(none)";

/** A word → label map as a one-column (`screen`) constant table for `compare`. */
const screen = (values: Readonly<Record<string, string | null>>) =>
  Object.fromEntries(
    Object.entries(values).map(([word, value]) => [word, { screen: value }]),
  );

export const checkScreenColumns = (
  source: string,
  labels: ScreenLabels,
): readonly string[] => {
  const tables = glossaryTables(source);
  const compare = (
    name: string,
    intro: string,
    constants: Readonly<
      Record<string, Readonly<Record<string, string | null>>>
    >,
    cellOf: (cell: string) => string = (cell) => cell,
  ): readonly string[] => {
    const table = tables.find((each) => each.intro.startsWith(intro));
    if (table === undefined) return [`Glossary: no ${name} table`];
    const words = table.rows.map((row) => keyOf(row.word ?? "", constants));
    return [
      ...table.rows.flatMap((row) => {
        const word = row.word ?? "";
        const constant = constants[keyOf(word, constants)];
        if (constant === undefined)
          return [`Glossary: ${name} ${word}: no constant`];
        return Object.entries(constant).flatMap(([column, value]) => {
          const cell = cellOf(row[column] ?? "");
          return cell === shown(value)
            ? []
            : [
                `Glossary: ${name} ${word}: ${column} says "${cell}", constant says "${shown(value)}"`,
              ];
        });
      }),
      ...Object.keys(constants)
        .filter((key) => !words.includes(key))
        .map((key) => `Glossary: ${name}: no row for ${key}`),
    ];
  };
  return [
    ...compare("Task states", "Task states", screen(labels.taskStates)),
    ...compare(
      "Run states",
      "Run states",
      screen(labels.runStates),
      (cell) => cell.split(" (")[0]?.split(" ·")[0] ?? cell,
    ),
    ...compare(
      "Workflow states",
      "Workflow states",
      screen(labels.workflowStates),
    ),
    ...compare(
      "Order positions",
      "Order positions",
      screen(labels.productionStates),
    ),
    ...compare("Order issues", "Order issues", screen(labels.orderIssues)),
    ...compare("Verbs", "Verbs", labels.verbs),
  ];
};

/**
 * **Each order issue has one remedy**, and the issue table on `OrderIssue` is
 * the spec for tone. Parses that table (header `Issue | Rule | Tone |
 * Remedy`) and reports: an Issue column that is not `literals` in order; a
 * Tone cell other than critical or warning, or one that disagrees with
 * `critical`; and a Remedy cell that says "or". A Remedy that offers two
 * fixes names neither: the old Needs a team label covered both assigning a
 * team and adding a member, and was shown for a team that was assigned but
 * had no members.
 */
export const checkOrderIssues = <Issue extends string>(
  source: string,
  literals: readonly Issue[],
  critical: (issue: Issue) => boolean,
): readonly string[] =>
  Result.match(
    firstTable(source, "OrderIssue", ["Issue", "Rule", "Tone", "Remedy"]),
    {
      onFailure: (error) => [error.message],
      onSuccess: ({ body }) => {
        const rows = body.map(({ text }) => {
          const [issue = "", , tone = "", remedy = ""] = cellsOf(text);
          return { issue: issue.replaceAll("`", ""), tone, remedy };
        });
        const issues = rows.map(({ issue }) => issue);
        const isLiteral = (issue: string): issue is Issue =>
          (literals as readonly string[]).includes(issue);
        const toneProblems = (issue: string, tone: string) => {
          if (tone !== "critical" && tone !== "warning")
            return [
              `OrderIssue \`${issue}\`: Tone "${tone}"; expected critical or warning`,
            ];
          if (!isLiteral(issue) || critical(issue) === (tone === "critical"))
            return [];
          return [
            `OrderIssue \`${issue}\`: Tone says ${tone}; orderIssueIsCritical says ${critical(issue) ? "critical" : "warning"}`,
          ];
        };
        return [
          ...(issues.join(",") === literals.join(",")
            ? []
            : [
                `OrderIssue: the Issue column is ${issues.join(", ")}; the literals are ${literals.join(", ")}`,
              ]),
          ...rows.flatMap(({ issue, tone, remedy }) => [
            ...toneProblems(issue, tone),
            ...(/\bor\b/iu.test(remedy)
              ? [
                  `OrderIssue \`${issue}\`: a remedy names one action; this one says or`,
                ]
              : []),
          ]),
        ];
      },
    },
  );

/**
 * **Every screen a merchant or member uses has a Screens row, and every
 * row's route file exists.** `routeFiles` maps each file under `src/routes/`
 * to its source, passed in for the same reason as {@link ScreenLabels}. A
 * screen is an `app.*` or `shop.*` route file that renders an `s-page` and
 * no `Outlet`: a layout renders its children (the `/shop/$shop` layout's
 * not-found `s-page` is the layout's, not a screen), and a redirect renders
 * nothing. Other route files (`admin.*`, `auth.*`, `webhooks.*`, `login*`,
 * `privacy`, `index`) are not merchant or member screens. Headings are not
 * checked: several are the record's own name. Reports each miss.
 */
export const checkScreens = (
  source: string,
  routeFiles: Readonly<Record<string, string>>,
): readonly string[] => {
  const table = glossaryTables(source).find((each) =>
    each.intro.startsWith("Screens."),
  );
  if (table === undefined) return ["Glossary: no Screens table"];
  const named = table.rows.map(
    (row) => `${(row["route file"] ?? "").replaceAll("`", "")}.tsx`,
  );
  return [
    ...named
      .filter((file) => !(file in routeFiles))
      .map((file) => `Glossary: Screens: no route file ${file}`),
    ...Object.entries(routeFiles)
      .filter(
        ([file, text]) =>
          /^(?:app|shop)\..*\.tsx$/u.test(file) &&
          text.includes("<s-page") &&
          !text.includes("<Outlet") &&
          !named.includes(file),
      )
      .map(([file]) => `Glossary: Screens: ${file} has no row`),
  ];
};

/** One parsed row of a data-model table (`initializeSchema`, `D1_TABLES`). */
export interface DataModelRow {
  readonly line: number;
  readonly about: string;
  readonly rule: string;
  readonly holdsBy: HoldsBy;
  readonly pinnedBy: string;
}

/** Who guarantees a data-model rule: the database, a write path, or both. */
export const HoldsBy = Schema.Literals(["schema", "app", "schema+app"]);
export type HoldsBy = typeof HoldsBy.Type;

/** The glossary nouns a data-model row may be about; a table name is the other kind of `about`. */
export const DATA_MODEL_NOUNS = [
  "order",
  "item",
  "workflow",
  "draft",
  "step",
  "task",
  "run",
  "shop",
  "member",
  "team",
] as const;

/** The `pinned by` cell of a rule no test asserts by name yet. */
export const NONE_YET = "(none yet)";

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** Where a data-model table is and which table names its `about` may use. */
export interface DataModelOptions {
  /** The exported symbol whose JSDoc carries the table. */
  readonly symbol: string;
  /** The table names a backticked `about` may name. */
  readonly tables: ReadonlySet<string>;
}

/** The names every `create table if not exists <name>` in `source` declares: the object's tables, read from `ShopAgentSchema.ts`. */
export const tablesDeclared = (source: string): ReadonlySet<string> =>
  new Set(
    [...source.matchAll(/create table if not exists (?<name>\w+)/gu)].map(
      (match) => match.groups?.name ?? "",
    ),
  );

/**
 * The string literals of the arrays assigned at `export const <symbol> =`
 * in `source`, for each of `symbols`: D1's tables, read from `D1Schema.ts`,
 * whose DDL is in `migrations/` where no symbol owns it. A regex over the
 * array literal, because its elements are plain identifiers.
 */
export const tablesNamed = (
  source: string,
  symbols: readonly string[],
): ReadonlySet<string> =>
  new Set(
    symbols.flatMap((symbol) => {
      const literal = new RegExp(
        `\\nexport const ${escapeRegExp(symbol)} = \\[(?<body>[^\\]]*)\\]`,
        "u",
      ).exec(source)?.groups?.body;
      return [...(literal ?? "").matchAll(/"(?<name>\w+)"/gu)].map(
        (match) => match.groups?.name ?? "",
      );
    }),
  );

/**
 * Read the data-model table out of the JSDoc on `options.symbol` in
 * `source`: `initializeSchema` in `src/lib/ShopAgentSchema.ts` for the
 * object, `D1_TABLES` in `src/lib/D1Schema.ts` for D1. The header is `about
 * | rule | holds by | pinned by`. `about` is a glossary noun ({@link
 * DATA_MODEL_NOUNS}) or a backticked name in `options.tables`; `rule` is
 * non-empty; `holds by` is a {@link HoldsBy}; `pinned by` is a test title or
 * {@link NONE_YET}. Fails with a message naming the symbol, the line and the
 * offending cell.
 */
export const parseDataModel = (
  source: string,
  options: DataModelOptions,
): Result.Result<readonly DataModelRow[], ParseError> =>
  Result.flatMap(
    firstTable(source, options.symbol, [
      "about",
      "rule",
      "holds by",
      "pinned by",
    ]),
    ({ body }) =>
      Result.all(
        body.map(({ line, text }): Result.Result<DataModelRow, ParseError> => {
          const fail = (message: string) =>
            Result.fail(
              new ParseError({
                message: `${options.symbol}, line ${String(line)}: ${message}`,
              }),
            );
          const values = cellsOf(text);
          if (values.length !== 4)
            return fail(`${String(values.length)} cells, expected 4: ${text}`);
          const [about = "", rule = "", holdsBy = "", pinnedBy = ""] = values;
          const table = /^`(?<name>\w+)`$/u.exec(about)?.groups?.name;
          if (
            !(DATA_MODEL_NOUNS as readonly string[]).includes(about) &&
            (table === undefined || !options.tables.has(table))
          )
            return fail(
              `unknown about "${about}"; expected one of: ${DATA_MODEL_NOUNS.join(", ")}, or a backticked table name`,
            );
          if (rule === "") return fail("empty rule");
          if (!Schema.is(HoldsBy)(holdsBy))
            return fail(
              `unknown holds by "${holdsBy}"; expected one of: ${HoldsBy.literals.join(", ")}`,
            );
          if (pinnedBy === "") return fail("empty pinned by");
          return Result.succeed({ line, about, rule, holdsBy, pinnedBy });
        }),
      ),
  );

/**
 * **Every `pinned by` title is carried by a test.** A row whose cell is not
 * {@link NONE_YET} needs an `it(`, `it.effect(`, `it.live(` or any other
 * `it.<name>(` in some test source followed, after optional whitespace, by
 * the title as a whole quoted string. A string search, not a TypeScript
 * parse: the titles are plain strings. `testSources` maps each test file to
 * its text; `symbol` names the table in the messages. Reports each missing
 * title.
 */
export const checkPinned = (
  rows: readonly DataModelRow[],
  testSources: Readonly<Record<string, string>>,
  symbol: string,
): readonly string[] => {
  const texts = Object.values(testSources);
  return rows
    .filter((row) => row.pinnedBy !== NONE_YET)
    .filter((row) => {
      const title = new RegExp(
        `\\bit(?:\\.\\w+)?\\(\\s*(["'\`])${escapeRegExp(row.pinnedBy)}\\1`,
        "u",
      );
      return !texts.some((text) => title.test(text));
    })
    .map(
      (row) =>
        `${symbol}, line ${String(row.line)}: no test titled "${row.pinnedBy}"`,
    );
};
