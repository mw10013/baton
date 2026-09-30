import type { OrderState, RunState } from "../../src/lib/Domain.ts";

/**
 * Reads the action matrices out of the JSDoc on `runActions` and
 * `taskActions` in `src/lib/domain/ShopWork.ts`, so the table a person edits is the
 * table the test asserts. Pure: it takes the source text as a parameter,
 * because the test runs inside workerd (no `node:fs`) and gets the text
 * through Vite's `?raw` import, while `scripts/spec.ts` reads the
 * file from disk. The same module checks the vocabulary and reads the two
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
const RUNS: Record<typeof RunWord.Type, readonly RunState[]> = {
  open: ["open"],
  done: ["done"],
  closed: ["closed"],
  "open or done": ["open", "done"],
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
    readonly state: RunState;
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
 * | run        | open         | state `open`                                                                         |
 * | run        | done         | state `done`                                                                         |
 * | run        | closed       | state `closed`                                                                       |
 * | run        | open or done | `open`; `done`                                                                       |
 * | blocked    | yes / no     | `blockedAt` 1 / null                                                                 |
 * | blocked    | any          | both on an open run; null on a done run                                              |
 * | units      | some / none  | `currentQuantity` 1 / 0 (runActions only)                                            |
 * | task       | ready        | `current: true, startedAt: null, doneAt: null`                                       |
 * | task       | started      | `current: true, startedAt: 1, doneAt: null`                                          |
 * | task       | waiting      | `current: false, startedAt: null, doneAt: null`                                      |
 * | task       | done         | `current: false, startedAt: 1, doneAt: 2`                                            |
 * | task       | any open     | ready; started; waiting                                                              |
 * | task       | any          | ready; started; waiting; done                                                        |
 * | downstream | none         | `reopenBlockedBy: null`                                                              |
 * | downstream | started      | `reopenBlockedBy: BLOCKER` (the caller's `blocker`)                                  |
 * | downstream | -            | not applicable; fixture `null`                                                       |
 *
 * The `ready` and `started` words are the vocabulary's narrow task states. The
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
    RUNS[word("run")].flatMap((state) =>
      BLOCKED[word("blocked")]
        .filter((blockedAt) => blockedAt === null || state === "open")
        .map((blockedAt) => ({
          order,
          run: { state, blockedAt },
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
          current: run.state === "open",
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
 * Where the vocabulary block starts: the JSDoc whose first line is
 * `Vocabulary.` (the map, in `Domain.ts`) or `Vocabulary, <context>.` (a
 * context file under `src/lib/domain/`). -1 when there is none.
 */
const vocabularyStart = (source: string): number =>
  /^\/\*\*\n \* Vocabulary[.,]/mu.exec(source)?.index ?? -1;

/** `word` occurs as a whole word in one of `texts`. */
const occurs = (word: string, texts: readonly string[]) => {
  const pattern = new RegExp(`\\b${word}\\b`, "u");
  return texts.some((text) => pattern.test(text));
};

/** The Shape families paragraph and its table, as the map's JSDoc spells them. */
const SHAPE_FAMILIES_BLOCK =
  / \* Shape families\.[\s\S]*?\n \*\n(?: \* \|.*\n)+/u;

const identifier = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(word);

/**
 * Every backticked identifier in the Vocabulary block occurs as a word
 * elsewhere in the source or in one of `others`. A rename that skipped the
 * vocabulary is the failure this catches; it does not prove the word is the
 * right kind of thing (a literal, an export). A context file is checked
 * against itself plus the barrel (`Domain.ts`), whose map names words of
 * every context; the barrel is checked against itself plus the four context
 * files. A word written as another context's (`` `Subscription` in
 * Platform ``, the form a `{@link}` across files takes) is checked against
 * that context's file in `contexts`, by name. Reports the missing words.
 */
export const checkVocabulary = (
  source: string,
  others: readonly string[] = [],
  contexts: Readonly<Record<string, string>> = {},
): readonly string[] => {
  const start = vocabularyStart(source);
  if (start === -1) return ["(no Vocabulary block)"];
  const end = source.indexOf("*/", start) + 2;
  // The Shape families table names suffixes, not words;
  // `checkShapeFamilies` checks its rule symbols.
  const block = source.slice(start, end).replace(SHAPE_FAMILIES_BLOCK, "");
  const rest = [source.slice(0, start) + source.slice(end), ...others];
  const qualified = [
    ...block.matchAll(/`(?<word>[^`]+)` in (?<context>[A-Z][A-Za-z]+)\b/gu),
  ]
    .map((match) => ({
      word: match.groups?.word ?? "",
      context: match.groups?.context ?? "",
    }))
    .filter(({ word, context }) => identifier(word) && context in contexts);
  const words = new Set(
    [
      ...block
        .replaceAll(
          /`[^`]+` in (?<context>[A-Z][A-Za-z]+)\b/gu,
          (text, context) => (context in contexts ? "" : text),
        )
        .matchAll(/`(?<word>[^`]+)`/gu),
    ]
      .map((match) => match.groups?.word ?? "")
      .filter(identifier),
  );
  return [
    ...[...words].filter((word) => !occurs(word, rest)),
    ...qualified
      .filter(({ word, context }) => !occurs(word, [contexts[context] ?? ""]))
      .map(({ word, context }) => `${word} in ${context}`),
  ];
};

/**
 * The label constants the vocabulary's screen columns are checked against,
 * passed in rather than imported so this module stays free of the app's
 * runtime: `scripts/spec.ts` and the test hand it `Domain`'s values.
 */
export interface ScreenLabels {
  readonly taskStates: Readonly<Record<string, string | null>>;
  readonly runStates: Readonly<Record<string, string>>;
  readonly workflowStates: Readonly<Record<string, string>>;
  readonly orderPositions: Readonly<Record<string, string>>;
  readonly orderIssues: Readonly<Record<string, string>>;
  readonly verbs: Readonly<
    Record<
      string,
      { readonly member: string | null; readonly merchant: string | null }
    >
  >;
}

/** A vocabulary table: the first line of the paragraph that introduces it, and its body rows as cells by header. */
export interface VocabularyTable {
  readonly intro: string;
  readonly rows: readonly Readonly<Record<string, string>>[];
}

export const vocabularyTables = (
  source: string,
): readonly VocabularyTable[] => {
  const start = vocabularyStart(source);
  if (start === -1) return [];
  const lines = source
    .slice(start, source.indexOf("*/", start))
    .split("\n")
    .map((text) => text.replace(/^\s*\/?\*+ ?/u, "").trim());
  const tables: VocabularyTable[] = [];
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
 * The constant key a vocabulary word names: `camel(word)` if the constants
 * have it, else the word snake-cased (`not started` → `not_started`). Verb
 * keys are camel case because they name action-struct fields
 * ({@link ScreenLabels} `verbs`); order-position and order-issue keys are the
 * stored literals, which are snake case.
 */
const keyOf = (word: string, constants: Readonly<Record<string, unknown>>) =>
  camel(word) in constants ? camel(word) : word.replaceAll(" ", "_");

/**
 * **The vocabulary's screen column is the label constant.** Each screen cell in
 * the Task states, Run states, Workflow states, Order positions, Order issues
 * and Verbs tables equals the
 * constant's value for its word ("(none)" for `null`), every constant key
 * has a row, and every row has a key. A run-state cell is compared up to its
 * first " (" or " ·", because the open row carries the merchant's second
 * word and the closed row its reason. Reports each mismatch.
 */
/** A constant's value as the vocabulary prints it: `null` is "(none)". */
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
  const tables = vocabularyTables(source);
  const compare = (
    name: string,
    intro: string,
    constants: Readonly<
      Record<string, Readonly<Record<string, string | null>>>
    >,
    cellOf: (cell: string) => string = (cell) => cell,
  ): readonly string[] => {
    const table = tables.find((each) => each.intro.startsWith(intro));
    if (table === undefined) return [`Vocabulary: no ${name} table`];
    const words = table.rows.map((row) => keyOf(row.word ?? "", constants));
    return [
      ...table.rows.flatMap((row) => {
        const word = row.word ?? "";
        const constant = constants[keyOf(word, constants)];
        if (constant === undefined)
          return [`Vocabulary: ${name} ${word}: no constant`];
        return Object.entries(constant).flatMap(([column, value]) => {
          const cell = cellOf(row[column] ?? "");
          return cell === shown(value)
            ? []
            : [
                `Vocabulary: ${name} ${word}: ${column} says "${cell}", constant says "${shown(value)}"`,
              ];
        });
      }),
      ...Object.keys(constants)
        .filter((key) => !words.includes(key))
        .map((key) => `Vocabulary: ${name}: no row for ${key}`),
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
      screen(labels.orderPositions),
    ),
    ...compare("Order issues", "Order issues", screen(labels.orderIssues)),
    ...compare("Verbs", "Verbs", labels.verbs),
  ];
};

/** One table of the object's DDL: its column names and the literals of its `check (<column> in (...))` constraints. */
export interface DdlTable {
  readonly columns: ReadonlySet<string>;
  readonly literals: ReadonlySet<string>;
}

/**
 * The object's tables, read from the SQL in `initializeSchema`
 * (`src/lib/ShopAgentSchema.ts`), by name. A regex over the text, because the
 * DDL is one hand-written template: a table's body runs from
 * `create table if not exists <name> (` to the first `);` at the start of a
 * line; a body line whose first word is followed by `text`, `integer` or
 * `real` is a column; `--` comment lines, table-level `check` and `unique`,
 * and index statements are not.
 */
export const ddlColumns = (source: string): ReadonlyMap<string, DdlTable> =>
  new Map(
    [
      ...source.matchAll(
        /create table if not exists (?<name>\w+) \((?<body>[\s\S]*?)\n\s*\);/gu,
      ),
    ].map((match) => {
      const body = match.groups?.body ?? "";
      const lines = body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => !line.startsWith("--"));
      const columns = lines.flatMap((line) => {
        const column = /^(?<column>[A-Za-z_]\w*) (?:text|integer|real)\b/u.exec(
          line,
        )?.groups?.column;
        return column === undefined ? [] : [column];
      });
      const literals = [
        ...body.matchAll(/check \(\w+ in \((?<list>[^)]*)\)\)/gu),
      ].flatMap((each) =>
        [...(each.groups?.list ?? "").matchAll(/'(?<literal>[^']*)'/gu)].map(
          (literal) => literal.groups?.literal ?? "",
        ),
      );
      return [
        match.groups?.name ?? "",
        { columns: new Set(columns), literals: new Set(literals) },
      ] as const;
    }),
  );

/** The trailing clause a task-state `stored` cell may carry: the `current` flag, which is computed, not a column. */
const CURRENT_CLAUSE = /^(?:not )?current$/u;

/**
 * **The vocabulary's stored column is a column or literal of
 * initializeSchema.** For every vocabulary table in `context` with a `stored`
 * header, each cell is a comma-separated list of the forms the map names
 * (the entry test in `Domain.ts`): a backticked literal, or a backticked
 * column followed by `set` or `null`, with an optional trailing
 * `; current` or `; not current`. A literal must be in some
 * `check (<column> in (...))` of `ddl`; a column must be in some table of
 * `ddl`. The column's table is not checked against the row's noun: the
 * vocabulary table names no table, and inferring one would be a guess.
 * Reports each bad form, unknown literal and unknown column.
 */
export const checkStoredCells = (
  context: string,
  ddl: string,
): readonly string[] => {
  const tables = [...ddlColumns(ddl).values()];
  const hasLiteral = (literal: string) =>
    tables.some((table) => table.literals.has(literal));
  const hasColumn = (column: string) =>
    tables.some((table) => table.columns.has(column));
  return vocabularyTables(context)
    .filter((table) => table.rows.some((row) => "stored" in row))
    .flatMap((table) => {
      const name = table.intro.split(/[,.:]/u)[0] ?? table.intro;
      return table.rows.flatMap((row) => {
        const word = row.word ?? "";
        const cell = row.stored ?? "";
        const where = `ShopWork.ts, ${name}, ${word}`;
        const clauses = cell.split(";").map((part) => part.trim());
        const last = clauses.at(-1) ?? "";
        const forms =
          clauses.length > 1 && CURRENT_CLAUSE.test(last)
            ? clauses.slice(0, -1)
            : clauses;
        if (forms.length !== 1)
          return [
            `${where}: stored cell "${cell}" is not a literal, \`<column>\` set or \`<column>\` null`,
          ];
        return (forms[0] ?? "").split(",").flatMap((part) => {
          const form = part.trim();
          const literal = /^`(?<literal>[^`]+)`$/u.exec(form)?.groups?.literal;
          if (literal !== undefined)
            return hasLiteral(literal)
              ? []
              : [
                  `${where}: stored literal \`${literal}\` is in no check constraint of initializeSchema`,
                ];
          const column = /^`(?<column>[^`]+)` (?:set|null)$/u.exec(form)?.groups
            ?.column;
          if (column !== undefined)
            return hasColumn(column)
              ? []
              : [
                  `${where}: stored column \`${column}\` is in no table of initializeSchema`,
                ];
          return [
            `${where}: stored cell "${cell}" is not a literal, \`<column>\` set or \`<column>\` null`,
          ];
        });
      });
    });
};

/**
 * **Each order issue has one remedy.** Parses the issue table on
 * `OrderIssue` (header `Issue | Rule | Remedy`) and reports: an Issue column
 * that is not `literals` in order, and a Remedy cell that says "or". A Remedy
 * that offers two fixes names neither: the old Needs a team label covered
 * both assigning a team and adding a member, and was shown for a team that
 * was assigned but had no members.
 */
export const checkOrderIssues = (
  source: string,
  literals: readonly string[],
): readonly string[] =>
  Result.match(firstTable(source, "OrderIssue", ["Issue", "Rule", "Remedy"]), {
    onFailure: (error) => [error.message],
    onSuccess: ({ body }) => {
      const rows = body.map(({ text }) => {
        const [issue = "", , remedy = ""] = cellsOf(text);
        return { issue: issue.replaceAll("`", ""), remedy };
      });
      const issues = rows.map(({ issue }) => issue);
      return [
        ...(issues.join(",") === literals.join(",")
          ? []
          : [
              `OrderIssue: the Issue column is ${issues.join(", ")}; the literals are ${literals.join(", ")}`,
            ]),
        ...rows.flatMap(({ issue, remedy }) =>
          /\bor\b/iu.test(remedy)
            ? [
                `OrderIssue \`${issue}\`: a remedy names one action; this one says or`,
              ]
            : [],
        ),
      ];
    },
  });

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
  const table = vocabularyTables(source).find((each) =>
    each.intro.startsWith("Screens."),
  );
  if (table === undefined) return ["Vocabulary: no Screens table"];
  const named = table.rows.map(
    (row) => `${(row["route file"] ?? "").replaceAll("`", "")}.tsx`,
  );
  return [
    ...named
      .filter((file) => !(file in routeFiles))
      .map((file) => `Vocabulary: Screens: no route file ${file}`),
    ...Object.entries(routeFiles)
      .filter(
        ([file, text]) =>
          /^(?:app|shop)\..*\.tsx$/u.test(file) &&
          text.includes("<s-page") &&
          !text.includes("<Outlet") &&
          !named.includes(file),
      )
      .map(([file]) => `Vocabulary: Screens: ${file} has no row`),
  ];
};

/**
 * **Every vocabulary table names its context.** The map (the table whose
 * paragraph starts `Contexts.`) lists the contexts and says what `kind` each
 * is; every other table names one or more of them, either in a `context`
 * column whose every cell is a context, or in its intro's first line up to
 * the first `.` or `:`, as `<Name>, <context>` ("Run states, shop work:") or
 * as the bare context ("Billing."). Several contexts, in a cell or an intro,
 * are joined with " and " ("shop work and orders"). The Shared words table
 * (paragraph `Shared words.`) names its contexts per row, in a `contexts`
 * cell joined with ", ". The Screens table is exempt: its rows name pages,
 * and a page's spec name is spoken in every context. The Shape families
 * table is exempt: its rows name the developer dialect's suffixes, which
 * name no context. `source` holds the map
 * (`Domain.ts`); the tables of `others` (the context files) are checked
 * against it too. Reports a map with no `kind` column, each table that names
 * none, and each unknown context.
 */
export const checkContexts = (
  source: string,
  others: readonly string[] = [],
): readonly string[] => {
  const tables = [source, ...others].flatMap(vocabularyTables);
  const contextTable = tables.find((each) =>
    each.intro.startsWith("Contexts."),
  );
  if (contextTable === undefined) return ["Vocabulary: no Contexts table"];
  const contexts = new Set(contextTable.rows.map((row) => row.context ?? ""));
  const sharedWords = tables.find((each) =>
    each.intro.startsWith("Shared words."),
  );
  return [
    ...(contextTable.rows.every((row) => "kind" in row)
      ? []
      : ["Vocabulary: Contexts: the map has no kind column"]),
    ...(sharedWords?.rows ?? []).flatMap((row) =>
      (row.contexts ?? "")
        .split(", ")
        .filter((each) => !contexts.has(each))
        .map(
          (each) =>
            `Vocabulary: Shared words ${row.word ?? ""}: context "${each}" is not in the Contexts table`,
        ),
    ),
    ...tables
      .filter(
        (each) =>
          each !== contextTable &&
          each !== sharedWords &&
          !each.intro.startsWith("Screens.") &&
          !each.intro.startsWith("Shape families."),
      )
      .flatMap(({ intro, rows }) => {
        const name = intro.split(/[.,:]/u)[0] ?? intro;
        if (rows.every((row) => "context" in row))
          return rows
            .filter(
              (row) =>
                !(row.context ?? "")
                  .split(" and ")
                  .every((each) => contexts.has(each)),
            )
            .map(
              (row) =>
                `Vocabulary: ${name} ${row.word ?? ""}: context "${row.context ?? ""}" is not in the Contexts table`,
            );
        const head = intro.split(/[.:]/u)[0] ?? "";
        const parts = head.split(", ");
        const named = (parts[1] ?? parts[0] ?? "").toLowerCase().split(" and ");
        return named.every((each) => contexts.has(each))
          ? []
          : [`Vocabulary: ${name}: its intro names no context`];
      }),
  ];
};

/** The backticked names in a table cell, in order. */
const backticked = (cell: string) =>
  [...cell.matchAll(/`(?<name>[^`]+)`/gu)].map(
    ({ groups }) => groups?.name ?? "",
  );

/** Each context file under `src/lib/domain/`, the files a `lives in` cell of `its context file` allows. */
const CONTEXT_FILES = [
  "Platform.ts",
  "Orders.ts",
  "Billing.ts",
  "ShopWork.ts",
] as const;

/**
 * **Every shape export lives where its family's row says, and every row's
 * rule symbol exists.** Reads the table whose paragraph starts `Shape
 * families.` in the map (`source`, `Domain.ts`). `sources` maps a path
 * (`src/lib/domain/Orders.ts`, `src/lib/ShopAgentClient.ts`,
 * `src/routes/app.index.tsx`) to its source. For each row, the `rule on`
 * symbol (its first backticked name) is an export of one of `sources`, or a
 * class in one. For each file under `src/lib/domain/` and each export whose
 * name ends in a row's suffix (the longest suffix that matches, so
 * `OrdersIndexData` is screen data), the file is what the row's `lives in`
 * cell allows: `its context file` allows any of the four, a backticked file
 * allows that one, and the route allows none under `domain/`. Reports each
 * miss.
 */
export const checkShapeFamilies = (
  source: string,
  sources: Readonly<Record<string, string>>,
): readonly string[] => {
  const table = vocabularyTables(source).find((each) =>
    each.intro.startsWith("Shape families."),
  );
  if (table === undefined) return ["Vocabulary: no Shape families table"];
  const exports = Object.entries(sources).map(([path, text]) => ({
    path,
    names: new Set(
      [
        ...text.matchAll(
          /^export (?:declare )?(?:abstract )?(?:const|let|async function\*?|function\*?|class|type|interface|enum) (?<name>[A-Za-z_$][A-Za-z0-9_$]*)/gmu,
        ),
      ].map(({ groups }) => groups?.name ?? ""),
    ),
  }));
  const suffixes = table.rows
    .flatMap((row) =>
      backticked(row.suffix ?? "").map((suffix) => ({ suffix, row })),
    )
    .toSorted((a, b) => b.suffix.length - a.suffix.length);
  const allows = (livesIn: string, file: string) => {
    if (livesIn === "its context file")
      return (CONTEXT_FILES as readonly string[]).includes(file);
    const named = backticked(livesIn)[0] ?? "";
    return named.endsWith(".ts") && named === file;
  };
  return [
    ...table.rows.flatMap((row) => {
      const symbol = backticked(row["rule on"] ?? "")[0] ?? "";
      return exports.some(({ names }) => names.has(symbol))
        ? []
        : [
            `Shape families ${row.family ?? ""}: rule symbol ${symbol} not found`,
          ];
    }),
    ...exports
      .filter(({ path }) => path.includes("src/lib/domain/"))
      .flatMap(({ path, names }) => {
        const file = path.slice(path.lastIndexOf("/") + 1);
        return [...names].flatMap((name) => {
          const family = suffixes.find(({ suffix }) => name.endsWith(suffix));
          if (family === undefined) return [];
          const livesIn = family.row["lives in"] ?? "";
          return allows(livesIn, file)
            ? []
            : [
                `Shape families ${family.row.family ?? ""}: ${name} is in ${file}, the row says ${livesIn}`,
              ];
        });
      }),
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

/** The vocabulary nouns a data-model row may be about; a table name is the other kind of `about`. */
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
 * | rule | holds by | pinned by`. `about` is a vocabulary noun ({@link
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

/** The order-count cells a triggers-table row may hold: unchanged, one more, or recounted from the rows. */
export const ORDER_COUNT_WORDS = ["—", "+1", "recounted"] as const;

/** The seat-mark cells a triggers-table row may hold. */
export const SEAT_MARK_WORDS = [
  "—",
  "→ 0",
  "→ member count",
  "→ member count if above",
] as const;

/** One parsed row of the triggers table on `ShopUsage` in `src/lib/domain/Billing.ts`. */
export interface TriggerRow {
  readonly line: number;
  readonly trigger: string;
  readonly orderCount: (typeof ORDER_COUNT_WORDS)[number];
  readonly seatMark: (typeof SEAT_MARK_WORDS)[number];
  readonly queue: string;
  readonly pinnedBy: string;
}

/**
 * Read the triggers table out of the JSDoc on `ShopUsage` in `source`
 * (`src/lib/domain/Billing.ts`). The header is `trigger | order count | seat mark |
 * queue | pinned by`. `trigger` and `queue` are non-empty free text; `order
 * count` is one of {@link ORDER_COUNT_WORDS} and `seat mark` one of {@link
 * SEAT_MARK_WORDS}, so a row cannot say what the counts do in words the
 * reader has to interpret; `pinned by` is a test title or {@link NONE_YET}.
 * Fails with a message naming the line and the offending cell.
 */
export const parseTriggerTable = (
  source: string,
): Result.Result<readonly TriggerRow[], ParseError> =>
  Result.flatMap(
    firstTable(source, "ShopUsage", [
      "trigger",
      "order count",
      "seat mark",
      "queue",
      "pinned by",
    ]),
    ({ body }) =>
      Result.all(
        body.map(({ line, text }): Result.Result<TriggerRow, ParseError> => {
          const fail = (message: string) =>
            Result.fail(
              new ParseError({
                message: `ShopUsage, line ${String(line)}: ${message}`,
              }),
            );
          const values = cellsOf(text);
          if (values.length !== 5)
            return fail(`${String(values.length)} cells, expected 5: ${text}`);
          const [
            trigger = "",
            orderCount = "",
            seatMark = "",
            queue = "",
            pinnedBy = "",
          ] = values;
          if (trigger === "") return fail("empty trigger");
          const count = ORDER_COUNT_WORDS.find((word) => word === orderCount);
          if (count === undefined)
            return fail(
              `unknown order count "${orderCount}"; expected one of: ${ORDER_COUNT_WORDS.join(", ")}`,
            );
          const mark = SEAT_MARK_WORDS.find((word) => word === seatMark);
          if (mark === undefined)
            return fail(
              `unknown seat mark "${seatMark}"; expected one of: ${SEAT_MARK_WORDS.join(", ")}`,
            );
          if (queue === "") return fail("empty queue");
          if (pinnedBy === "") return fail("empty pinned by");
          return Result.succeed({
            line,
            trigger,
            orderCount: count,
            seatMark: mark,
            queue,
            pinnedBy,
          });
        }),
      ),
  );

/**
 * **Every `pinned by` title is carried by a test.** A row whose cell is not
 * {@link NONE_YET} needs an `it(`, `it.effect(`, `it.live(` or any other
 * `it.<name>(` in some test source followed, after optional whitespace, by
 * the title as a whole quoted string. A string search, not a TypeScript
 * parse: the titles are plain strings. The rows are any table's with a
 * `pinned by` column: the data-model tables and the triggers table.
 * `testSources` maps each test file to its text; `symbol` names the table in
 * the messages. Reports each missing title.
 */
export const checkPinned = (
  rows: readonly { readonly line: number; readonly pinnedBy: string }[],
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

/** One parsed row of the copy table on `CopySlot` in `src/lib/Screen.ts`. */
export interface CopyRow {
  readonly line: number;
  readonly slot: string;
  readonly example: string;
}

/**
 * Read the copy table out of the JSDoc on `CopySlot` in `src/lib/Screen.ts`.
 * The header is `slot | job | form | empty when | example | never`; `slot`
 * is one of `slots`, each exactly once; every cell is non-empty. Fails with
 * a message naming the line and the offending cell.
 */
export const parseCopyTable = (
  source: string,
  slots: readonly string[],
): Result.Result<readonly CopyRow[], ParseError> =>
  Result.flatMap(
    firstTable(source, "CopySlot", [
      "slot",
      "job",
      "form",
      "empty when",
      "example",
      "never",
    ]),
    ({ body }) =>
      Result.flatMap(
        Result.all(
          body.map(({ line, text }): Result.Result<CopyRow, ParseError> => {
            const fail = (message: string) =>
              Result.fail(
                new ParseError({
                  message: `CopySlot, line ${String(line)}: ${message}`,
                }),
              );
            const values = cellsOf(text);
            if (values.length !== 6)
              return fail(
                `${String(values.length)} cells, expected 6: ${text}`,
              );
            const slot = values[0] ?? "";
            const example = values[4] ?? "";
            if (!slots.includes(slot))
              return fail(
                `unknown slot "${slot}"; expected one of: ${slots.join(", ")}`,
              );
            if (values.some((cell) => cell === "")) return fail("empty cell");
            return Result.succeed({ line, slot, example });
          }),
        ),
        (rows) => {
          const seen = rows.map((row) => row.slot);
          const missing = slots.filter((slot) => !seen.includes(slot));
          const doubled = seen.filter((slot, i) => seen.indexOf(slot) !== i);
          return missing.length > 0 || doubled.length > 0
            ? Result.fail(
                new ParseError({
                  message: `CopySlot: ${[
                    ...missing.map((slot) => `no row for ${slot}`),
                    ...doubled.map((slot) => `two rows for ${slot}`),
                  ].join("; ")}`,
                }),
              )
            : Result.succeed(rows);
        },
      ),
  );

/**
 * **Every copy-table example is on a screen.** Each row's `example` occurs
 * verbatim in one of `screenSources` (the files `scripts/lib/copy-files.ts`
 * lists), so the table cannot cite copy that was since rewritten. Reports
 * each example nothing shows.
 */
export const checkCopyExamples = (
  rows: readonly CopyRow[],
  screenSources: Readonly<Record<string, string>>,
): readonly string[] => {
  const texts = Object.values(screenSources);
  return rows
    .filter((row) => !texts.some((text) => text.includes(row.example)))
    .map(
      (row) =>
        `CopySlot, line ${String(row.line)}: no screen shows "${row.example}"`,
    );
};

/**
 * Read the controls table out of the JSDoc on `Control` in
 * `src/lib/Screen.ts`: `job | control | never`, every cell non-empty.
 */
export const parseControls = (
  source: string,
): Result.Result<
  readonly { readonly line: number; readonly job: string }[],
  ParseError
> =>
  Result.flatMap(
    firstTable(source, "Control", ["job", "control", "never"]),
    ({ body }) =>
      Result.all(
        body.map(({ line, text }) => {
          const values = cellsOf(text);
          return values.length !== 3 || values.some((cell) => cell === "")
            ? Result.fail(
                new ParseError({
                  message: `Control, line ${String(line)}: 3 non-empty cells expected: ${text}`,
                }),
              )
            : Result.succeed({ line, job: values[0] ?? "" });
        }),
      ),
  );
