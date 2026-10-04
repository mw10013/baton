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

/** The letters a cell may list, in the order it must list them; `v` is a `runActions` letter only. */
const LETTERS: readonly string[] = ["M", "m", "v"];

/**
 * An action cell: blank is never, and otherwise a space-separated list of
 * letters from {@link LETTERS}, in that order, with no repeats (`M`, `m v`,
 * `M m v`, ...).
 */
export const Cell = Schema.String.check(
  Schema.makeFilter(
    // A list is well formed when it equals {@link LETTERS} cut to the
    // letters it names: that refuses an unknown letter, a repeat and a
    // letter out of order alike, and lets blank through.
    (cell) =>
      LETTERS.filter((letter) => cell.split(" ").includes(letter)).join(" ") ===
        cell || "letters M m v in order, or blank",
  ),
);
export type Cell = typeof Cell.Type;

/**
 * {@link Cell}'s check as a plain boolean. `Schema.is` is a type guard, and
 * since `Cell` is a string its negation would narrow the value to `never`
 * where the parser's message names it.
 */
const isCell: (cell: string) => boolean = Schema.is(Cell);

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
    actions: ["note", "block", "unblock", "cancel", "changeWorkflow"],
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
const UnitsWord = Schema.Literals(["some", "none", "any"]);
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
  any: [1, 0],
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
 * "m" is. `tasks` and `item` are present on `runActions` fixtures only:
 * `tasks` is the list `runActions` is called with for "M" and "m", `[task]`.
 * The "v" list is the test's to build, because an actor is not a state.
 */
export interface Fixture<TeamId> {
  readonly order: OrderState;
  readonly run: {
    readonly state: RunState;
    readonly blockedAt: number | null;
  };
  readonly task: TaskState & {
    readonly teamId: TeamId;
    readonly laterStepStarted: boolean;
  };
  readonly tasks?: readonly {
    readonly teamId: TeamId;
    readonly current: boolean;
  }[];
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
 * | units      | any          | 1; 0                                                                                 |
 * | task       | ready        | `current: true, startedAt: null, doneAt: null`                                       |
 * | task       | started      | `current: true, startedAt: 1, doneAt: null`                                          |
 * | task       | waiting      | `current: false, startedAt: null, doneAt: null`                                      |
 * | task       | done         | `current: false, startedAt: 1, doneAt: 2`                                            |
 * | task       | any open     | ready; started; waiting                                                              |
 * | task       | any          | ready; started; waiting; done                                                        |
 * | downstream | none         | `laterStepStarted: false`                                                            |
 * | downstream | started      | `laterStepStarted: true`                                                             |
 * | downstream | -            | not applicable; fixture `false`                                                      |
 * | cell letter | M / m       | `tasks: [task]` (runActions)                                                         |
 * | cell letter | v           | `tasks` built by the test: the row's task, not current, plus a current one elsewhere |
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
export const expand = <TeamId>(
  name: TableName,
  row: Row,
  context: { readonly teamId: TeamId },
): readonly Fixture<TeamId>[] => {
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
      UNITS[word("units")].map((currentQuantity) => {
        const task = {
          teamId: context.teamId,
          // `Domain.runIsOpen`, spelled out: this module imports `Domain`
          // for types only, so the CLI runs without the app's runtime.
          current: run.state === "open",
          startedAt: null,
          doneAt: null,
          laterStepStarted: false,
        };
        return { order, run, task, tasks: [task], item: { currentQuantity } };
      }),
    );
  const laterStepStarted = word("downstream") === "started";
  return states.flatMap(({ order, run }) =>
    TASKS[word("task")].map((task) => ({
      order,
      run,
      task: { ...task, teamId: context.teamId, laterStepStarted },
    })),
  );
};

/**
 * Where the JSDoc before `export const <name> =` or `export class <name>`
 * starts and ends, or a message saying why there is none. A table on a
 * declaration of neither form (a class method, such as `private publish(`
 * on `ShopAgent`) passes `anchor`, the declaration's text from its line
 * start, which must occur exactly once in `source`: two matches fail rather
 * than take the first.
 */
const jsdocBefore = (
  source: string,
  name: string,
  anchor?: string,
): Result.Result<
  { readonly start: number; readonly end: number },
  ParseError
> => {
  if (anchor !== undefined) {
    const first = source.indexOf(anchor);
    if (first === -1 || source.includes(anchor, first + 1))
      return Result.fail(
        new ParseError({
          message: `${name}: \`${anchor.trim()}\` occurs ${first === -1 ? "nowhere" : "more than once"}; expected exactly once`,
        }),
      );
  }
  const at =
    anchor === undefined
      ? [`\nexport const ${name} =`, `\nexport class ${name} `]
          .map((declaration) => source.indexOf(declaration))
          .find((index) => index !== -1)
      : source.indexOf(anchor);
  if (at === undefined)
    return Result.fail(
      new ParseError({
        message: `${name}: no \`export const ${name} =\` or \`export class ${name}\``,
      }),
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
    if (!isCell(value))
      return fail(
        `cell "${value}" under ${column}; expected letters M m v in order, or blank`,
      );
    if (name !== "runActions" && value.split(" ").includes("v"))
      return fail(
        `cell "${value}" under ${column}; v is only a runActions letter`,
      );
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
 * (or `anchor`, {@link jsdocBefore}) and take its markdown table number
 * `nth` (0 is the first). The header must equal `expected`, and the line
 * after it must be the separator. Shared by every parsed table, so all
 * locate and frame their table the same way.
 */
const nthTable = (
  source: string,
  name: string,
  expected: readonly string[],
  nth: number,
  anchor?: string,
): Result.Result<TableLines, ParseError> =>
  Result.flatMap(jsdocBefore(source, name, anchor), ({ start, end }) => {
    const firstLine = source.slice(0, start).split("\n").length;
    const lines = source
      .slice(start, end)
      .split("\n")
      .map((text, index) => ({
        line: firstLine + index,
        text: text.replace(/^\s*\*? ?/u, "").trim(),
      }));
    const starts = lines.flatMap(({ text }, index) =>
      text.startsWith("|") && !(lines[index - 1]?.text ?? "").startsWith("|")
        ? [index]
        : [],
    );
    const from = starts[nth] ?? -1;
    if (from === -1)
      return Result.fail(
        new ParseError({
          message: `${name}: no table number ${String(nth + 1)} in its JSDoc`,
        }),
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

/** {@link nthTable}'s first table. */
const firstTable = (
  source: string,
  name: string,
  expected: readonly string[],
): Result.Result<TableLines, ParseError> => nthTable(source, name, expected, 0);

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
        expand(name, row, { teamId: "t" }).map((fixture) =>
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
 * Whether a fixture is a state the object can hold. Two `taskActions`
 * combinations are not: a `done` run whose task is not done (a run is done
 * when its last task is), and a started later step on a task Reopen cannot
 * be offered on. `-` under `downstream` is the second: Reopen is asked only
 * of a done task on an open order's open or done run, so everywhere else
 * the column is not read and the fixture holds `false`.
 */
const reachable = (fixture: Fixture<string>): boolean => {
  const { order, run, task } = fixture;
  const done = task.doneAt !== null;
  const orderOpen =
    order.cancelledAt === null && order.fulfillmentStatus !== "FULFILLED";
  return (
    (run.state !== "done" || done) &&
    (!task.laterStepStarted || (done && orderOpen && run.state !== "closed"))
  );
};

/**
 * Every fixture a table's state columns can name: the cross product of each
 * column's words, each expanded by {@link expand}, kept to the states the
 * object can hold ({@link reachable}). Deduplicated, so a word that is the
 * union of others (`any`, `any open`) adds nothing.
 */
export const universe = (name: TableName): readonly Fixture<string>[] => {
  const columns = TABLES[name].state;
  const states = columns.reduce<readonly Readonly<Record<string, string>>[]>(
    (acc, column) =>
      acc.flatMap((state) =>
        WORDS[column].literals.map((word) => ({ ...state, [column]: word })),
      ),
    [{}],
  );
  const fixtures = new Map(
    states.flatMap((state) =>
      expand(name, { line: 0, state, cells: {} }, { teamId: "t" })
        .filter(reachable)
        .map((fixture) => [JSON.stringify(fixture), fixture] as const),
    ),
  );
  return [...fixtures.values()];
};

/**
 * The fixtures of {@link universe} no row expands to. With {@link overlaps}
 * it holds a table total: every state is a row exactly once, so a reader
 * never meets a state the table is silent on.
 */
export const gaps = (
  name: TableName,
  rows: readonly Row[],
): readonly Fixture<string>[] => {
  const covered = new Set(
    rows.flatMap((row) =>
      expand(name, row, { teamId: "t" }).map((fixture) =>
        JSON.stringify(fixture),
      ),
    ),
  );
  return universe(name).filter(
    (fixture) => !covered.has(JSON.stringify(fixture)),
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
  readonly workflowFaults: Readonly<Record<string, string>>;
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
 * have it, else the word snake-cased, a space or a hyphen becoming `_`
 * (`not started` → `not_started`, `multi-match` → `multi_match`). Verb
 * keys are camel case because they name action-struct fields
 * ({@link ScreenLabels} `verbs`); order-position and order-issue keys are the
 * stored literals, which are snake case.
 */
const keyOf = (word: string, constants: Readonly<Record<string, unknown>>) =>
  camel(word) in constants ? camel(word) : word.replaceAll(/[ -]/gu, "_");

/**
 * **The vocabulary's screen column is the label constant.** Each screen cell in
 * the Task states, Run states, Workflow states, Order positions, Order issues,
 * Workflow faults and Verbs tables equals the
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
    ...compare(
      "Workflow faults",
      "Workflow faults",
      screen(labels.workflowFaults),
    ),
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

/** The `shape` cells a reconcile triggers row may hold. */
export const RECONCILE_SHAPE_WORDS = [
  "reconcile",
  "reconcile all",
  "none",
] as const;

/** One parsed row of the triggers table on `reconcileItem` in `src/lib/domain/ShopWork.ts`. */
export interface ReconcileTriggerRow {
  readonly line: number;
  readonly trigger: string;
  readonly shape: (typeof RECONCILE_SHAPE_WORDS)[number];
  readonly skippedWhen: string;
  readonly pinnedBy: string;
}

/**
 * Read the triggers table, the first table in the JSDoc on `reconcileItem`
 * in `source` (`src/lib/domain/ShopWork.ts`). The header is `trigger | shape
 * | skipped when | pinned by`. `trigger` and `skipped when` are non-empty
 * free text; `shape` is one of {@link RECONCILE_SHAPE_WORDS}, so a row cannot
 * say what runs in words the reader has to interpret; `pinned by` is a test
 * title or {@link NONE_YET}. Fails with a message naming the line and the
 * offending cell.
 */
export const parseReconcileTriggers = (
  source: string,
): Result.Result<readonly ReconcileTriggerRow[], ParseError> =>
  Result.flatMap(
    firstTable(source, "reconcileItem", [
      "trigger",
      "shape",
      "skipped when",
      "pinned by",
    ]),
    ({ body }) =>
      Result.all(
        body.map(
          ({ line, text }): Result.Result<ReconcileTriggerRow, ParseError> => {
            const fail = (message: string) =>
              Result.fail(
                new ParseError({
                  message: `reconcileItem triggers, line ${String(line)}: ${message}`,
                }),
              );
            const values = cellsOf(text);
            if (values.length !== 4)
              return fail(
                `${String(values.length)} cells, expected 4: ${text}`,
              );
            const [
              trigger = "",
              shapeCell = "",
              skippedWhen = "",
              pinnedBy = "",
            ] = values;
            if (trigger === "") return fail("empty trigger");
            const shape = RECONCILE_SHAPE_WORDS.find(
              (word) => word === shapeCell,
            );
            if (shape === undefined)
              return fail(
                `unknown shape "${shapeCell}"; expected one of: ${RECONCILE_SHAPE_WORDS.join(", ")}`,
              );
            if (skippedWhen === "") return fail("empty skipped when");
            if (pinnedBy === "") return fail("empty pinned by");
            return Result.succeed({
              line,
              trigger,
              shape,
              skippedWhen,
              pinnedBy,
            });
          },
        ),
      ),
  );

/** The word lists of the actions table on `reconcileItem`, one per input column. */
export const RECONCILE_ACTION_WORDS = {
  order: ["cancelled", "fulfilled", "closed", "open"],
  paid: ["yes", "no", "any"],
  units: ["0", "changed", "same", "some", "any"],
  run: ["open", "done or closed", "none"],
  matches: ["0", "1", "2+", "any"],
} as const;

/** The action a row names: its tag, the close reason for `close`, and the free text after the colon. */
export type ReconcileActionCell =
  | { readonly tag: "create" | "resize" | "nothing"; readonly note: string }
  | { readonly tag: "close"; readonly reason: string; readonly note: string };

/** One parsed row of the actions table on `reconcileItem`. */
export interface ReconcileActionRow {
  readonly line: number;
  readonly order: (typeof RECONCILE_ACTION_WORDS.order)[number];
  readonly paid: (typeof RECONCILE_ACTION_WORDS.paid)[number];
  readonly units: (typeof RECONCILE_ACTION_WORDS.units)[number];
  readonly run: (typeof RECONCILE_ACTION_WORDS.run)[number];
  readonly matches: (typeof RECONCILE_ACTION_WORDS.matches)[number];
  readonly action: ReconcileActionCell;
  /** The row as written, for a test title. */
  readonly text: string;
}

const ACTION =
  /^(?<tag>create|resize|nothing|close `(?<reason>[a-z_]+)`)(?:: (?<note>.+))?$/u;

/**
 * Read the actions table, the second table in the JSDoc on `reconcileItem`
 * in `source`. The header is `order | paid | units | run on item | matches |
 * action`; each input cell is one of its list in
 * {@link RECONCILE_ACTION_WORDS}; `action` is `create`, `resize`,
 * `nothing` or ``close `<reason>` ``, optionally followed by a colon and free
 * text. Fails with a message naming the line and the offending cell.
 */
export const parseReconcileActions = (
  source: string,
): Result.Result<readonly ReconcileActionRow[], ParseError> =>
  Result.flatMap(
    nthTable(
      source,
      "reconcileItem",
      ["order", "paid", "units", "run on item", "matches", "action"],
      1,
    ),
    ({ body }) =>
      Result.all(
        body.map(
          ({ line, text }): Result.Result<ReconcileActionRow, ParseError> => {
            const fail = (message: string) =>
              Result.fail(
                new ParseError({
                  message: `reconcileItem actions, line ${String(line)}: ${message}`,
                }),
              );
            const values = cellsOf(text);
            if (values.length !== 6)
              return fail(
                `${String(values.length)} cells, expected 6: ${text}`,
              );
            const [order, paid, units, run, matches, actionCell = ""] = values;
            const pick = <W extends string>(
              column: string,
              words: readonly W[],
              value: string | undefined,
            ): Result.Result<W, ParseError> => {
              const word = words.find((candidate) => candidate === value);
              return word === undefined
                ? fail(
                    `unknown word "${value ?? ""}" under ${column}; expected one of: ${words.join(", ")}`,
                  )
                : Result.succeed(word);
            };
            const groups = ACTION.exec(actionCell)?.groups;
            if (groups === undefined)
              return fail(
                `action "${actionCell}" is not create, resize, nothing or close \`<reason>\`, with optional text after a colon`,
              );
            const note = groups.note ?? "";
            const tag = (["create", "resize", "nothing"] as const).find(
              (word) => word === groups.tag,
            );
            const action: ReconcileActionCell =
              groups.reason === undefined
                ? { tag: tag ?? "nothing", note }
                : { tag: "close", reason: groups.reason, note };
            return Result.map(
              Result.all({
                order: pick("order", RECONCILE_ACTION_WORDS.order, order),
                paid: pick("paid", RECONCILE_ACTION_WORDS.paid, paid),
                units: pick("units", RECONCILE_ACTION_WORDS.units, units),
                run: pick("run on item", RECONCILE_ACTION_WORDS.run, run),
                matches: pick(
                  "matches",
                  RECONCILE_ACTION_WORDS.matches,
                  matches,
                ),
              }),
              (words) => ({
                line,
                ...words,
                action,
                text: values.join(" | "),
              }),
            );
          },
        ),
      ),
  );

/** The run a reconcile fixture puts on its item: its state and its quantity. */
export interface ReconcileFixtureRun {
  readonly state: RunState;
  readonly quantity: number;
}

/** One input to `reconcileItem`, in plain values: what a row of the actions table expands to. */
export interface ReconcileFixture {
  readonly order: {
    readonly cancelledAt: number | null;
    readonly fulfillmentStatus: string;
    readonly fullyPaid: boolean;
  };
  readonly units: number;
  readonly run: ReconcileFixtureRun | null;
  readonly matched: number;
}

/** The quantity every fixture run carries; `changed` units are one more, `same` are equal, `some` are both. */
const RUN_QUANTITY = 2;

/**
 * Every fixture a row of the actions table stands for: the cross product of
 * its cells, each word read as the values it covers. `any` covers every
 * value of its column; `closed` under `order` is cancelled or fulfilled;
 * `done or closed` under `run on item` is either state.
 */
export const expandReconcileAction = (
  row: ReconcileActionRow,
): readonly ReconcileFixture[] => {
  const OPEN = { cancelledAt: null, fulfillmentStatus: "UNFULFILLED" };
  const CANCELLED = { cancelledAt: 1, fulfillmentStatus: "UNFULFILLED" };
  const FULFILLED = { cancelledAt: null, fulfillmentStatus: "FULFILLED" };
  const orders = {
    cancelled: [CANCELLED],
    fulfilled: [FULFILLED],
    closed: [CANCELLED, FULFILLED],
    open: [OPEN],
  }[row.order];
  const paid = { yes: [true], no: [false], any: [true, false] }[row.paid];
  const units = {
    "0": [0],
    changed: [RUN_QUANTITY + 1],
    same: [RUN_QUANTITY],
    // Above zero: with no run there is no quantity to equal, so `some`
    // covers both values `any` reaches above zero.
    some: [RUN_QUANTITY, RUN_QUANTITY + 1],
    any: [0, RUN_QUANTITY, RUN_QUANTITY + 1],
  }[row.units];
  const run = (state: RunState): ReconcileFixtureRun => ({
    state,
    quantity: RUN_QUANTITY,
  });
  const runs = {
    open: [run("open")],
    "done or closed": [run("done"), run("closed")],
    none: [null],
  }[row.run];
  const matches = {
    "0": [{ matched: 0 }],
    "1": [{ matched: 1 }],
    "2+": [{ matched: 2 }],
    any: [0, 1, 2].map((matched) => ({ matched })),
  }[row.matches];
  return orders.flatMap((order) =>
    paid.flatMap((fullyPaid) =>
      units.flatMap((unit) =>
        runs.flatMap((fixtureRun) =>
          matches.map((match) => ({
            order: { ...order, fullyPaid },
            units: unit,
            run: fixtureRun,
            ...match,
          })),
        ),
      ),
    ),
  );
};

/**
 * Every fixture the actions table on `reconcileItem` can name: the cross
 * product of each column's words, each expanded by
 * {@link expandReconcileAction}, deduplicated.
 */
export const reconcileActionUniverse = (): readonly ReconcileFixture[] => {
  const words = RECONCILE_ACTION_WORDS;
  const rows = words.order.flatMap((order) =>
    words.paid.flatMap((paid) =>
      words.units.flatMap((units) =>
        words.run.flatMap((run) =>
          words.matches.map((matches): ReconcileActionRow => ({
            line: 0,
            order,
            paid,
            units,
            run,
            matches,
            action: { tag: "nothing", note: "" },
            text: "",
          })),
        ),
      ),
    ),
  );
  return [
    ...new Map(
      rows
        .flatMap(expandReconcileAction)
        .map((fixture) => [JSON.stringify(fixture), fixture] as const),
    ).values(),
  ];
};

/** The fixtures of {@link reconcileActionUniverse} no row of the actions table on `reconcileItem` expands to. */
export const reconcileActionGaps = (
  rows: readonly ReconcileActionRow[],
): readonly ReconcileFixture[] => {
  const covered = new Set(
    rows
      .flatMap(expandReconcileAction)
      .map((fixture) => JSON.stringify(fixture)),
  );
  return reconcileActionUniverse().filter(
    (fixture) => !covered.has(JSON.stringify(fixture)),
  );
};

/** {@link overlaps} for the actions table on `reconcileItem`: no two rows expand to a common fixture. */
export const reconcileActionOverlaps = (
  rows: readonly ReconcileActionRow[],
): readonly (readonly [ReconcileActionRow, ReconcileActionRow])[] => {
  const keys = rows.map(
    (row) =>
      new Set(
        expandReconcileAction(row).map((fixture) => JSON.stringify(fixture)),
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

/** The word lists of the actions table on `syncOrder`, one per input column. */
export const SYNC_ACTION_WORDS = {
  stored: ["none", "stored"],
  version: ["older", "same or newer", "any"],
  age: ["expired", "kept", "any"],
  ceiling: ["at", "under", "any"],
} as const;

/** One parsed row of the actions table on `syncOrder`. */
export interface SyncActionRow {
  readonly line: number;
  readonly stored: (typeof SYNC_ACTION_WORDS.stored)[number];
  readonly version: (typeof SYNC_ACTION_WORDS.version)[number];
  readonly age: (typeof SYNC_ACTION_WORDS.age)[number];
  readonly ceiling: (typeof SYNC_ACTION_WORDS.ceiling)[number];
  readonly action: {
    readonly tag: "write" | "skip" | "refuse";
    readonly note: string;
  };
  /** The row as written, for a test title. */
  readonly text: string;
}

const SYNC_ACTION = /^(?<tag>write|skip|refuse)(?:: (?<note>.+))?$/u;

/**
 * Read the actions table, the first table in the JSDoc on `syncOrder` in
 * `source`. The header is `stored | version | age | ceiling | action`; each
 * input cell is one of its list in {@link SYNC_ACTION_WORDS}; `action` is
 * `write`, `skip` or `refuse`, optionally followed by a colon and free text.
 * Fails with a message naming the line and the offending cell.
 */
export const parseSyncActions = (
  source: string,
): Result.Result<readonly SyncActionRow[], ParseError> =>
  Result.flatMap(
    nthTable(
      source,
      "syncOrder",
      ["stored", "version", "age", "ceiling", "action"],
      0,
    ),
    ({ body }) =>
      Result.all(
        body.map(({ line, text }): Result.Result<SyncActionRow, ParseError> => {
          const fail = (message: string) =>
            Result.fail(
              new ParseError({
                message: `syncOrder actions, line ${String(line)}: ${message}`,
              }),
            );
          const values = cellsOf(text);
          if (values.length !== 5)
            return fail(`${String(values.length)} cells, expected 5: ${text}`);
          const [stored, version, age, ceiling, actionCell = ""] = values;
          const pick = <W extends string>(
            column: string,
            words: readonly W[],
            value: string | undefined,
          ): Result.Result<W, ParseError> => {
            const word = words.find((candidate) => candidate === value);
            return word === undefined
              ? fail(
                  `unknown word "${value ?? ""}" under ${column}; expected one of: ${words.join(", ")}`,
                )
              : Result.succeed(word);
          };
          const groups = SYNC_ACTION.exec(actionCell)?.groups;
          const tag = (["write", "skip", "refuse"] as const).find(
            (word) => word === groups?.tag,
          );
          if (groups === undefined || tag === undefined)
            return fail(
              `action "${actionCell}" is not write, skip or refuse, with optional text after a colon`,
            );
          return Result.map(
            Result.all({
              stored: pick("stored", SYNC_ACTION_WORDS.stored, stored),
              version: pick("version", SYNC_ACTION_WORDS.version, version),
              age: pick("age", SYNC_ACTION_WORDS.age, age),
              ceiling: pick("ceiling", SYNC_ACTION_WORDS.ceiling, ceiling),
            }),
            (words) => ({
              line,
              ...words,
              action: { tag, note: groups.note ?? "" },
              text: values.join(" | "),
            }),
          );
        }),
      ),
  );

/** One input to `syncOrder`, in the table's words: what a row of the actions table expands to. */
export interface SyncFixture {
  readonly stored: (typeof SYNC_ACTION_WORDS.stored)[number];
  readonly version: "older" | "same or newer";
  readonly age: "expired" | "kept";
  readonly ceiling: "at" | "under";
}

/**
 * Every fixture a row of the actions table on `syncOrder` stands for: the
 * cross product of its cells, each `any` read as every other word of its
 * column. `version` on a `none` row still expands, and the function must
 * ignore it.
 */
export const expandSyncAction = (
  row: SyncActionRow,
): readonly SyncFixture[] => {
  const versions =
    row.version === "any"
      ? (["older", "same or newer"] as const)
      : [row.version];
  const ages = row.age === "any" ? (["expired", "kept"] as const) : [row.age];
  const ceilings =
    row.ceiling === "any" ? (["at", "under"] as const) : [row.ceiling];
  return versions.flatMap((version) =>
    ages.flatMap((age) =>
      ceilings.map((ceiling) => ({
        stored: row.stored,
        version,
        age,
        ceiling,
      })),
    ),
  );
};

/** {@link overlaps} for the actions table on `syncOrder`: no two rows expand to a common fixture. */
export const syncActionOverlaps = (
  rows: readonly SyncActionRow[],
): readonly (readonly [SyncActionRow, SyncActionRow])[] => {
  const keys = rows.map(
    (row) =>
      new Set(expandSyncAction(row).map((fixture) => JSON.stringify(fixture))),
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

/** The rows and the fixed words of each effect column of the effects table on `reconcileItem`. */
export const RECONCILE_EFFECT_WORDS = {
  action: ["create", "close (any reason)", "resize", "nothing"],
  runRow: [
    "inserted with its tasks",
    "closed",
    "quantity rewritten",
    "untouched",
  ],
  countedOrder: ["counted if not yet", "—"],
  queue: ["+1 order event", "—"],
} as const;

/** One parsed row of the effects table on `reconcileItem`. */
export interface ReconcileEffectRow {
  readonly line: number;
  readonly action: (typeof RECONCILE_EFFECT_WORDS.action)[number];
  readonly runRow: (typeof RECONCILE_EFFECT_WORDS.runRow)[number];
  readonly countedOrder: (typeof RECONCILE_EFFECT_WORDS.countedOrder)[number];
  readonly queue: (typeof RECONCILE_EFFECT_WORDS.queue)[number];
  readonly pinnedBy: string;
}

/**
 * Read the effects table, the third table in the JSDoc on `reconcileItem`
 * in `source`. The header is `action | run row | counted order | queue |
 * pinned by`; every cell but `pinned by` is one of its list in
 * {@link RECONCILE_EFFECT_WORDS}, and each action is a row exactly once;
 * `pinned by` is one or more test titles separated by `; `
 * ({@link pinnedTitles}), or {@link NONE_YET}, and a row is yielded per
 * title. Fails with a message naming the line and the offending cell.
 */
export const parseReconcileEffects = (
  source: string,
): Result.Result<readonly ReconcileEffectRow[], ParseError> =>
  Result.flatMap(
    nthTable(
      source,
      "reconcileItem",
      ["action", "run row", "counted order", "queue", "pinned by"],
      2,
    ),
    ({ body }) =>
      Result.flatMap(
        Result.all(
          body.map(
            ({
              line,
              text,
            }): Result.Result<readonly ReconcileEffectRow[], ParseError> => {
              const fail = (message: string) =>
                Result.fail(
                  new ParseError({
                    message: `reconcileItem effects, line ${String(line)}: ${message}`,
                  }),
                );
              const values = cellsOf(text);
              if (values.length !== 5)
                return fail(
                  `${String(values.length)} cells, expected 5: ${text}`,
                );
              const [action, runRow, countedOrder, queue, pinnedBy = ""] =
                values;
              const pick = <W extends string>(
                column: string,
                words: readonly W[],
                value: string | undefined,
              ): Result.Result<W, ParseError> => {
                const word = words.find((candidate) => candidate === value);
                return word === undefined
                  ? fail(
                      `unknown word "${value ?? ""}" under ${column}; expected one of: ${words.join(", ")}`,
                    )
                  : Result.succeed(word);
              };
              if (pinnedBy === "") return fail("empty pinned by");
              return Result.map(
                Result.all({
                  action: pick("action", RECONCILE_EFFECT_WORDS.action, action),
                  runRow: pick(
                    "run row",
                    RECONCILE_EFFECT_WORDS.runRow,
                    runRow,
                  ),
                  countedOrder: pick(
                    "counted order",
                    RECONCILE_EFFECT_WORDS.countedOrder,
                    countedOrder,
                  ),
                  queue: pick("queue", RECONCILE_EFFECT_WORDS.queue, queue),
                }),
                (words) =>
                  pinnedTitles(pinnedBy).map((title) => ({
                    line,
                    ...words,
                    pinnedBy: title,
                  })),
              );
            },
          ),
        ),
        (perLine) => {
          const rows = perLine.flat();
          const missing = RECONCILE_EFFECT_WORDS.action.filter(
            (action) =>
              new Set(
                rows.filter((row) => row.action === action).map((r) => r.line),
              ).size !== 1,
          );
          return missing.length === 0
            ? Result.succeed(rows)
            : Result.fail(
                new ParseError({
                  message: `reconcileItem effects: each action is one row; not once: ${missing.join(", ")}`,
                }),
              );
        },
      ),
  );

/** One parsed row of the pass rules table on `reconcileItem`, per title of its `pinned by`. */
export interface ReconcilePassRuleRow {
  readonly line: number;
  readonly rule: string;
  /** The symbols the `where` cell names, without their backticks. */
  readonly where: readonly string[];
  readonly pinnedBy: string;
}

const SYMBOLS = /^`[\w.]+`(?:, `[\w.]+`)*$/u;

/**
 * Read the pass rules table, the fourth table in the JSDoc on
 * `reconcileItem` in `source`. The header is `rule | where | pinned by`;
 * `rule` is non-empty; `where` is one or more backticked symbols, comma
 * separated; `pinned by` is one or more test titles separated by `; `
 * ({@link pinnedTitles}), or {@link NONE_YET}, and a row is yielded per
 * title. Fails with a message naming the line and the offending cell.
 */
export const parseReconcilePassRules = (
  source: string,
): Result.Result<readonly ReconcilePassRuleRow[], ParseError> =>
  Result.flatMap(
    nthTable(source, "reconcileItem", ["rule", "where", "pinned by"], 3),
    ({ body }) =>
      Result.map(
        Result.all(
          body.map(
            ({
              line,
              text,
            }): Result.Result<readonly ReconcilePassRuleRow[], ParseError> => {
              const fail = (message: string) =>
                Result.fail(
                  new ParseError({
                    message: `reconcileItem pass rules, line ${String(line)}: ${message}`,
                  }),
                );
              const values = cellsOf(text);
              if (values.length !== 3)
                return fail(
                  `${String(values.length)} cells, expected 3: ${text}`,
                );
              const [rule = "", where = "", pinnedBy = ""] = values;
              if (rule === "") return fail("empty rule");
              if (!SYMBOLS.test(where))
                return fail(
                  `where "${where}" is not one or more backticked symbols`,
                );
              if (pinnedBy === "") return fail("empty pinned by");
              return Result.succeed(
                pinnedTitles(pinnedBy).map((title) => ({
                  line,
                  rule,
                  where: where.split(", ").map((symbol) => symbol.slice(1, -1)),
                  pinnedBy: title,
                })),
              );
            },
          ),
        ),
        (rows) => rows.flat(),
      ),
  );

/**
 * A `pinned by` cell of a sync table or of the effects or pass rules
 * tables on `reconcileItem`: one or more test titles separated by `; `, or
 * {@link NONE_YET}. No such title may itself contain `; `.
 */
const pinnedTitles = (cell: string): readonly string[] =>
  cell === NONE_YET ? [NONE_YET] : cell.split("; ");

/** One parsed row of the sources table on `syncOrder`, per title of its `pinned by`. */
export interface SyncSourceRow {
  readonly line: number;
  readonly source: string;
  readonly who: string;
  readonly asks: string;
  readonly skippedWhen: string;
  readonly pinnedBy: string;
}

/**
 * Read the sources table, the second table in the JSDoc on `syncOrder` in
 * `source`. The header is `source | who | asks Shopify for | skipped when |
 * pinned by`; every cell is non-empty; `pinned by` is one or more titles
 * split on `; `, or {@link NONE_YET}. One row per title, each with the
 * table line, for {@link checkPinned}. Fails with a message naming the line
 * and the offending cell.
 */
export const parseSyncSources = (
  source: string,
): Result.Result<readonly SyncSourceRow[], ParseError> =>
  Result.flatMap(
    nthTable(
      source,
      "syncOrder",
      ["source", "who", "asks Shopify for", "skipped when", "pinned by"],
      1,
    ),
    ({ body }) =>
      Result.map(
        Result.all(
          body.map(
            ({
              line,
              text,
            }): Result.Result<readonly SyncSourceRow[], ParseError> => {
              const fail = (message: string) =>
                Result.fail(
                  new ParseError({
                    message: `syncOrder sources, line ${String(line)}: ${message}`,
                  }),
                );
              const values = cellsOf(text);
              if (values.length !== 5)
                return fail(
                  `${String(values.length)} cells, expected 5: ${text}`,
                );
              const [
                rowSource = "",
                who = "",
                asks = "",
                skippedWhen = "",
                pinnedBy = "",
              ] = values;
              const empty = Object.entries({
                source: rowSource,
                who,
                "asks Shopify for": asks,
                "skipped when": skippedWhen,
                "pinned by": pinnedBy,
              }).find(([, cell]) => cell === "");
              if (empty !== undefined) return fail(`empty ${empty[0]}`);
              return Result.succeed(
                pinnedTitles(pinnedBy).map((title) => ({
                  line,
                  source: rowSource,
                  who,
                  asks,
                  skippedWhen,
                  pinnedBy: title,
                })),
              );
            },
          ),
        ),
        (rows) => rows.flat(),
      ),
  );

/** The fixed words of the endings table on `syncOrder`, one list per effect column. */
export const SYNC_ENDING_WORDS = {
  trackingRow: ["inserted", "deleted", "none", "—"],
  lastError: ["set", "cleared", "—"],
} as const;

/** One parsed row of the endings table on `syncOrder`, per title of its `pinned by`. */
export interface SyncEndingRow {
  readonly line: number;
  readonly ending: string;
  readonly trackingRow: (typeof SYNC_ENDING_WORDS.trackingRow)[number];
  readonly lastError: (typeof SYNC_ENDING_WORDS.lastError)[number];
  readonly pinnedBy: string;
}

/**
 * Read the endings table, the third table in the JSDoc on `syncOrder` in
 * `source`. The header is `ending | tracking row | lastError | pinned by`;
 * `ending` is non-empty and names each ending exactly once; the effect cells
 * are words of {@link SYNC_ENDING_WORDS}; `pinned by` as on
 * {@link parseSyncSources}. Fails with a message naming the line and the
 * offending cell.
 */
export const parseSyncEndings = (
  source: string,
): Result.Result<readonly SyncEndingRow[], ParseError> =>
  Result.flatMap(
    nthTable(
      source,
      "syncOrder",
      ["ending", "tracking row", "lastError", "pinned by"],
      2,
    ),
    ({ body }) =>
      Result.flatMap(
        Result.all(
          body.map(
            ({
              line,
              text,
            }): Result.Result<readonly SyncEndingRow[], ParseError> => {
              const fail = (message: string) =>
                Result.fail(
                  new ParseError({
                    message: `syncOrder endings, line ${String(line)}: ${message}`,
                  }),
                );
              const values = cellsOf(text);
              if (values.length !== 4)
                return fail(
                  `${String(values.length)} cells, expected 4: ${text}`,
                );
              const [ending = "", trackingRow, lastError, pinnedBy = ""] =
                values;
              if (ending === "") return fail("empty ending");
              if (pinnedBy === "") return fail("empty pinned by");
              const tracking = SYNC_ENDING_WORDS.trackingRow.find(
                (word) => word === trackingRow,
              );
              if (tracking === undefined)
                return fail(
                  `unknown word "${trackingRow ?? ""}" under tracking row; expected one of: ${SYNC_ENDING_WORDS.trackingRow.join(", ")}`,
                );
              const error = SYNC_ENDING_WORDS.lastError.find(
                (word) => word === lastError,
              );
              if (error === undefined)
                return fail(
                  `unknown word "${lastError ?? ""}" under lastError; expected one of: ${SYNC_ENDING_WORDS.lastError.join(", ")}`,
                );
              return Result.succeed(
                pinnedTitles(pinnedBy).map((title) => ({
                  line,
                  ending,
                  trackingRow: tracking,
                  lastError: error,
                  pinnedBy: title,
                })),
              );
            },
          ),
        ),
        (perRow): Result.Result<readonly SyncEndingRow[], ParseError> => {
          const endings = perRow.map((rows) => rows[0]?.ending ?? "");
          const repeated = endings.filter(
            (ending, index) => endings.indexOf(ending) !== index,
          );
          return repeated.length === 0
            ? Result.succeed(perRow.flat())
            : Result.fail(
                new ParseError({
                  message: `syncOrder endings: each ending is one row; not once: ${[...new Set(repeated)].join(", ")}`,
                }),
              );
        },
      ),
  );

/** One parsed row of the rules table on `syncOrder`, per title of its `pinned by`. */
export interface SyncRuleRow {
  readonly line: number;
  /** The rule's number, from its `<n>. ` prefix. */
  readonly number: number;
  readonly rule: string;
  /** The symbols the `where` cell names, without their backticks. */
  readonly where: readonly string[];
  readonly pinnedBy: string;
}

/**
 * Read the rules table, the fourth table in the JSDoc on `syncOrder` in
 * `source`. The header is `rule | where | pinned by`; `rule` starts with
 * `<n>. `, and the numbers run from 1 upward with no gap; `where` is one or
 * more backticked symbols, comma separated; `pinned by` as on
 * {@link parseSyncSources}. Fails with a message naming the line and the
 * offending cell.
 */
export const parseSyncRules = (
  source: string,
): Result.Result<readonly SyncRuleRow[], ParseError> =>
  Result.flatMap(
    nthTable(source, "syncOrder", ["rule", "where", "pinned by"], 3),
    ({ body }) =>
      Result.map(
        Result.all(
          body.map(
            (
              { line, text },
              index,
            ): Result.Result<readonly SyncRuleRow[], ParseError> => {
              const fail = (message: string) =>
                Result.fail(
                  new ParseError({
                    message: `syncOrder rules, line ${String(line)}: ${message}`,
                  }),
                );
              const values = cellsOf(text);
              if (values.length !== 3)
                return fail(
                  `${String(values.length)} cells, expected 3: ${text}`,
                );
              const [rule = "", where = "", pinnedBy = ""] = values;
              const number = /^(?<n>\d+)\. ./u.exec(rule)?.groups?.n;
              if (number === undefined)
                return fail(`rule "${rule}" does not start with "<n>. "`);
              if (Number(number) !== index + 1)
                return fail(
                  `rule ${number} is out of sequence; expected ${String(index + 1)}`,
                );
              if (!SYMBOLS.test(where))
                return fail(
                  `where "${where}" is not one or more backticked symbols`,
                );
              if (pinnedBy === "") return fail("empty pinned by");
              return Result.succeed(
                pinnedTitles(pinnedBy).map((title) => ({
                  line,
                  number: Number(number),
                  rule,
                  where: where.split(", ").map((symbol) => symbol.slice(1, -1)),
                  pinnedBy: title,
                })),
              );
            },
          ),
        ),
        (rows) => rows.flat(),
      ),
  );

/** One parsed row of the sync pipeline table on `ShopAgentHost` in `src/lib/agent/Host.ts`. */
export interface SyncPipelineRow {
  readonly line: number;
  readonly source: string;
  readonly store: string;
  readonly reconcile: string;
  readonly flush: string;
  readonly publish: string;
}

/**
 * Read the sync pipeline table, the second table in the JSDoc on
 * `ShopAgentHost` in `source` (the services table is the first). The header
 * is `source | store | reconcile | flush | publish`; every cell is
 * non-empty, and `reconcile` is `—` or begins with `reconcile` or
 * `reconcile all` ({@link RECONCILE_SHAPE_WORDS}), so the shape is the
 * triggers table's word. No `pinned by`: the rows are wiring. Fails with a
 * message naming the line and the offending cell.
 */
export const parseSyncPipeline = (
  source: string,
): Result.Result<readonly SyncPipelineRow[], ParseError> =>
  Result.flatMap(
    nthTable(
      source,
      "ShopAgentHost",
      ["source", "store", "reconcile", "flush", "publish"],
      1,
    ),
    ({ body }) =>
      Result.all(
        body.map(
          ({ line, text }): Result.Result<SyncPipelineRow, ParseError> => {
            const fail = (message: string) =>
              Result.fail(
                new ParseError({
                  message: `ShopAgentHost sync pipeline, line ${String(line)}: ${message}`,
                }),
              );
            const values = cellsOf(text);
            if (values.length !== 5)
              return fail(
                `${String(values.length)} cells, expected 5: ${text}`,
              );
            const [
              rowSource = "",
              store = "",
              reconcile = "",
              flush = "",
              publish = "",
            ] = values;
            const empty = Object.entries({
              source: rowSource,
              store,
              flush,
              publish,
            }).find(([, cell]) => cell === "");
            if (empty !== undefined) return fail(`empty ${empty[0]}`);
            const shapes = RECONCILE_SHAPE_WORDS.filter(
              (word) => word !== "none",
            );
            if (
              reconcile !== "—" &&
              !shapes.some(
                (word) =>
                  reconcile === word ||
                  reconcile.startsWith(`${word} `) ||
                  reconcile.startsWith(`${word},`),
              )
            )
              return fail(
                `reconcile "${reconcile}" is not — and does not begin with ${shapes.join(" or ")}`,
              );
            return Result.succeed({
              line,
              source: rowSource,
              store,
              reconcile,
              flush,
              publish,
            });
          },
        ),
      ),
  );

/**
 * **Every `pinned by` title is carried by a test.** A row whose cell is not
 * {@link NONE_YET} needs an `it(`, `it.effect(`, `it.live(` or any other
 * `it.<name>(` in some test source followed, after optional whitespace, by
 * the title as a whole quoted string. A string search, not a TypeScript
 * parse: the titles are plain strings. The rows are any table's with a
 * `pinned by` column: the data-model tables and the triggers table. A
 * data-model cell may join several titles with `; `, and a title may itself
 * contain `; `, so the cell holds when its `; `-separated parts group, in
 * order, into titles a test carries. `testSources` maps each test file to
 * its text; `symbol` names the table in the messages. Reports each cell
 * that does not hold.
 */
export const checkPinned = (
  rows: readonly { readonly line: number; readonly pinnedBy: string }[],
  testSources: Readonly<Record<string, string>>,
  symbol: string,
): readonly string[] => {
  const texts = Object.values(testSources);
  const carried = (title: string) => {
    const pattern = new RegExp(
      `\\bit(?:\\.\\w+)?\\(\\s*(["'\`])${escapeRegExp(title)}\\1`,
      "u",
    );
    return texts.some((text) => pattern.test(text));
  };
  /** Whether the parts group, in order, into carried titles. */
  const holds = (cell: string) => {
    const parts = cell.split("; ");
    const reachable = [true];
    for (let end = 1; end <= parts.length; end++)
      reachable[end] = parts
        .slice(0, end)
        .some(
          (_, start) =>
            reachable[start] && carried(parts.slice(start, end).join("; ")),
        );
    return reachable[parts.length];
  };
  return rows
    .filter((row) => row.pinnedBy !== NONE_YET)
    .filter((row) => !holds(row.pinnedBy))
    .map(
      (row) =>
        `${symbol}, line ${String(row.line)}: no test titled "${row.pinnedBy}"`,
    );
};

/**
 * How many data-model rows may say {@link NONE_YET}: none. Every row of the
 * tables on `initializeSchema` and `D1_TABLES` is a rule some test holds, so
 * a new row arrives with its test. The reconcile, sync and triggers tables
 * keep their own rule.
 */
export const DATA_MODEL_NONE_YET_MAX = 0;

/** The rows of one data-model table pinned by {@link NONE_YET}, past {@link DATA_MODEL_NONE_YET_MAX}. */
export const checkDataModelUnpinned = (
  rows: readonly { readonly line: number; readonly pinnedBy: string }[],
  symbol: string,
): readonly string[] =>
  rows
    .filter((row) => row.pinnedBy.split("; ").includes(NONE_YET))
    .slice(DATA_MODEL_NONE_YET_MAX)
    .map(
      (row) =>
        `${symbol}, line ${String(row.line)}: pinned by ${NONE_YET}; a data-model row is pinned by a test`,
    );

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

/** One parsed row of a {@link parsePinnedTable} table, per title of its `pinned by`. */
export interface PinnedTableRow {
  readonly line: number;
  /** Every cell but `pinned by`, by column. */
  readonly cells: Readonly<Record<string, string>>;
  readonly pinnedBy: string;
}

/** Where a {@link parsePinnedTable} table is and what its cells may hold. */
interface PinnedTable {
  /** The symbol whose JSDoc holds the table, and the messages' prefix. */
  readonly name: string;
  /** The table in the messages, after `name`. */
  readonly label: string;
  /** The header, `pinned by` excluded; it is always the last column. */
  readonly columns: readonly string[];
  /** The columns held to a closed list, and the list. */
  readonly words: Readonly<Record<string, readonly string[]>>;
  readonly nth: number;
  readonly anchor?: string;
}

/**
 * The shape the publish and subscribe tables share: free-text columns that
 * must be non-empty, some columns held to a closed word list, and a last
 * `pinned by` column of one or more titles separated by `; `
 * ({@link pinnedTitles}), with a row yielded per title. Fails with a message
 * naming the line and the offending cell.
 */
const parsePinnedTable =
  ({ name, label, columns, words, nth, anchor }: PinnedTable) =>
  (source: string): Result.Result<readonly PinnedTableRow[], ParseError> =>
    Result.flatMap(
      nthTable(source, name, [...columns, "pinned by"], nth, anchor),
      ({ body }) =>
        Result.map(
          Result.all(
            body.map(
              ({
                line,
                text,
              }): Result.Result<readonly PinnedTableRow[], ParseError> => {
                const fail = (message: string) =>
                  Result.fail(
                    new ParseError({
                      message: `${name} ${label}, line ${String(line)}: ${message}`,
                    }),
                  );
                const values = cellsOf(text);
                if (values.length !== columns.length + 1)
                  return fail(
                    `${String(values.length)} cells, expected ${String(columns.length + 1)}: ${text}`,
                  );
                const cells = Object.fromEntries(
                  columns.map((column, index) => [column, values[index] ?? ""]),
                );
                const empty = columns.find((column) => cells[column] === "");
                if (empty !== undefined) return fail(`empty ${empty}`);
                const unknown = Object.entries(words).find(
                  ([column, list]) => !list.includes(cells[column] ?? ""),
                );
                if (unknown !== undefined)
                  return fail(
                    `unknown ${unknown[0]} "${cells[unknown[0]] ?? ""}"; expected one of: ${unknown[1].join(", ")}`,
                  );
                const pinnedBy = values[columns.length] ?? "";
                if (pinnedBy === "") return fail("empty pinned by");
                return Result.succeed(
                  pinnedTitles(pinnedBy).map((title) => ({
                    line,
                    cells,
                    pinnedBy: title,
                  })),
                );
              },
            ),
          ),
          (rows) => rows.flat(),
        ),
    );

/** The `side` cells of the cycle table on `Subscription` in Platform: where a step runs. */
export const CYCLE_SIDE_WORDS = ["object", "tab", "both", "Worker"] as const;

/**
 * Read the cycle table, the first table in the JSDoc on `Subscription` in
 * `source` (`src/lib/domain/Platform.ts`). The header is `step | side |
 * symbol | rule | pinned by`; `side` is one of {@link CYCLE_SIDE_WORDS}.
 */
export const parseSubscriptionCycle = parsePinnedTable({
  name: "Subscription",
  label: "cycle",
  columns: ["step", "side", "symbol", "rule"],
  words: { side: CYCLE_SIDE_WORDS },
  nth: 0,
});

/** The `role` cells of the delivery table on `Subscription`. */
export const DELIVERY_ROLE_WORDS = ["either", "merchant", "member"] as const;

/** The `receives` cells of the delivery table on `Subscription`. */
export const RECEIVES_WORDS = ["yes", "no"] as const;

/**
 * Read the delivery table, the second table in the JSDoc on `Subscription`
 * in `source`. The header is `role | subscription | scope | receives |
 * pinned by`; `role` is one of {@link DELIVERY_ROLE_WORDS} and `receives`
 * one of {@link RECEIVES_WORDS}.
 */
export const parseSubscriptionDelivery = parsePinnedTable({
  name: "Subscription",
  label: "delivery",
  columns: ["role", "subscription", "scope", "receives"],
  words: { role: DELIVERY_ROLE_WORDS, receives: RECEIVES_WORDS },
  nth: 1,
});

/** The `orders` cells of the sites table on `ShopAgent.publish`: the orders half of the scope. */
export const SITE_ORDERS_WORDS = ["all", "the order"] as const;

/** The `teams` cells of the sites table on `ShopAgent.publish`: the teams half of the scope. */
export const SITE_TEAMS_WORDS = [
  "all",
  "the order's teams",
  "before ∪ after",
  "the order's teams, read before the write",
  "(none)",
] as const;

/** The `when` cells of the sites table on `ShopAgent.publish`. */
export const SITE_WHEN_WORDS = [
  "changed",
  "written",
  "always",
  "swept",
] as const;

/**
 * Read the sites table out of the JSDoc on `ShopAgent.publish` in `source`
 * (`src/lib/ShopAgent.ts`), a private method, so the JSDoc is found by its
 * declaration (`private publish(`, {@link jsdocBefore}). The header is
 * `trigger | orders | teams | when | pinned by`; `orders`, `teams` and
 * `when` are held to {@link SITE_ORDERS_WORDS}, {@link SITE_TEAMS_WORDS}
 * and {@link SITE_WHEN_WORDS}.
 */
export const parsePublishSites = parsePinnedTable({
  name: "publish",
  label: "sites",
  columns: ["trigger", "orders", "teams", "when"],
  words: {
    orders: SITE_ORDERS_WORDS,
    teams: SITE_TEAMS_WORDS,
    when: SITE_WHEN_WORDS,
  },
  nth: 0,
  anchor: "\n  private publish(",
});

/** The `visible` cells of the events table on `useSubscribedQuery`: the tab's visibility when the event arrives. */
export const VISIBLE_WORDS = ["yes", "no", "either"] as const;

/**
 * Read the events table out of the JSDoc on `useSubscribedQuery` in `source`
 * (`src/lib/useSubscribedQuery.ts`). The header is `event | visible | the
 * hook | pinned by`; `visible` is one of {@link VISIBLE_WORDS}. Its titles
 * are the browser project's, which is why the test sources include
 * `test/browser/`.
 */
export const parseClientEvents = parsePinnedTable({
  name: "useSubscribedQuery",
  label: "events",
  columns: ["event", "visible", "the hook"],
  words: { visible: VISIBLE_WORDS },
  nth: 0,
});

/** The `side` cells of the connection table on `ConnectionRole` in Platform. */
export const CONNECTION_SIDE_WORDS = ["Worker", "object", "tab"] as const;

/**
 * Read the connection table out of the JSDoc on `ConnectionRole` in
 * `source` (`src/lib/domain/Platform.ts`). The header is `event | side |
 * answer | pinned by`; `side` is one of {@link CONNECTION_SIDE_WORDS}.
 */
export const parseConnectionEvents = parsePinnedTable({
  name: "ConnectionRole",
  label: "connection",
  columns: ["event", "side", "answer"],
  words: { side: CONNECTION_SIDE_WORDS },
  nth: 0,
});
