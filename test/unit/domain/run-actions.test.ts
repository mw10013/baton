import { describe, expect, it } from "@effect/vitest";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Orders from "../../../src/domain/orders.ts";
import { Email } from "../../../src/domain/platform.ts";
import * as ShopWork from "../../../src/domain/shop-work.ts";

/**
 * The action matrices on `runActions` and `taskActions` and the actions
 * table on `reconcileItem`, one test per row. Each row is written here as
 * data: its title (the row rendered back, so a failing test names the cell),
 * its state words and its cells. A word→value map expands the words into
 * every concrete fixture the row stands for, as the tables' JSDoc reads them.
 */

const T = Schema.decodeUnknownSync(ShopWork.TeamId)("t");
/** A team the member is not on, holding the run's current task in a "v" fixture. */
const OTHER = Schema.decodeUnknownSync(ShopWork.TeamId)("other");
const MERCHANT: ShopWork.Actor = { role: "merchant" };
const MEMBER: ShopWork.Actor = {
  role: "member",
  memberId: Schema.decodeUnknownSync(ShopWork.MemberId)("m"),
  email: Schema.decodeUnknownSync(Email)("m@example.com"),
  teamIds: [T],
};

const OPEN_ORDER: Orders.OrderState = { cancelledAt: null, fulfillmentStatus: "UNFULFILLED" };

const run = (state: ShopWork.RunState, blocked = false) => ({
  state,
  blockedAt: blocked ? 1 : null,
});

interface TaskState {
  readonly current: boolean;
  readonly startedAt: number | null;
  readonly doneAt: number | null;
}

const READY: TaskState = { current: true, startedAt: null, doneAt: null };
const STARTED: TaskState = { current: true, startedAt: 1, doneAt: null };
const WAITING: TaskState = { current: false, startedAt: null, doneAt: null };
const DONE: TaskState = { current: false, startedAt: 1, doneAt: 2 };

/** What each state word of the two action matrices stands for. */
const WORDS = {
  order: {
    open: [OPEN_ORDER],
    closed: [
      { cancelledAt: 1, fulfillmentStatus: "UNFULFILLED" },
      { cancelledAt: null, fulfillmentStatus: "FULFILLED" },
    ],
  },
  run: {
    open: ["open"],
    done: ["done"],
    closed: ["closed"],
    "open or done": ["open", "done"],
  },
  blocked: { yes: [1], no: [null], any: [null, 1] },
  units: { some: [1], none: [0], any: [1, 0] },
  task: {
    ready: [READY],
    started: [STARTED],
    waiting: [WAITING],
    done: [DONE],
    "any open": [READY, STARTED, WAITING],
    any: [READY, STARTED, WAITING, DONE],
  },
} as const satisfies {
  readonly order: Record<string, readonly Orders.OrderState[]>;
  readonly run: Record<string, readonly ShopWork.RunState[]>;
  readonly blocked: Record<string, readonly (number | null)[]>;
  readonly units: Record<string, readonly number[]>;
  readonly task: Record<string, readonly TaskState[]>;
};

type Who = "M" | "m" | "v";

interface RunRow {
  readonly title: string;
  readonly order: keyof typeof WORDS.order;
  readonly run: keyof typeof WORDS.run;
  readonly blocked: keyof typeof WORDS.blocked;
  readonly units: keyof typeof WORDS.units;
  readonly cells: Readonly<Record<keyof ShopWork.RunActions, string>>;
}

/** The `runActions` matrix, row by row. */
const RUN_ROWS: readonly RunRow[] = [
  {
    title:
      "order open, run open, blocked no, units some → note M m v, block M m, cancel M, changeWorkflow M",
    order: "open",
    run: "open",
    blocked: "no",
    units: "some",
    cells: { note: "M m v", block: "M m", unblock: "", cancel: "M", changeWorkflow: "M" },
  },
  {
    title:
      "order open, run open, blocked yes, units some → note M m v, unblock M m, cancel M, changeWorkflow M",
    order: "open",
    run: "open",
    blocked: "yes",
    units: "some",
    cells: { note: "M m v", block: "", unblock: "M m", cancel: "M", changeWorkflow: "M" },
  },
  {
    title: "order open, run open, blocked no, units none → note M m v, block M m, cancel M",
    order: "open",
    run: "open",
    blocked: "no",
    units: "none",
    cells: { note: "M m v", block: "M m", unblock: "", cancel: "M", changeWorkflow: "" },
  },
  {
    title: "order open, run open, blocked yes, units none → note M m v, unblock M m, cancel M",
    order: "open",
    run: "open",
    blocked: "yes",
    units: "none",
    cells: { note: "M m v", block: "", unblock: "M m", cancel: "M", changeWorkflow: "" },
  },
  {
    title: "order open, run done, blocked no, units some → note M m v, changeWorkflow M",
    order: "open",
    run: "done",
    blocked: "no",
    units: "some",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "M" },
  },
  {
    title: "order open, run done, blocked no, units none → note M m v",
    order: "open",
    run: "done",
    blocked: "no",
    units: "none",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "" },
  },
  {
    title: "order open, run closed, blocked no, units some → note M m v, changeWorkflow M",
    order: "open",
    run: "closed",
    blocked: "no",
    units: "some",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "M" },
  },
  {
    title: "order open, run closed, blocked no, units none → note M m v",
    order: "open",
    run: "closed",
    blocked: "no",
    units: "none",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "" },
  },
  {
    title: "order closed, run open or done, blocked any, units any → note M m v",
    order: "closed",
    run: "open or done",
    blocked: "any",
    units: "any",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "" },
  },
  {
    title: "order closed, run closed, blocked no, units any → note M m v",
    order: "closed",
    run: "closed",
    blocked: "no",
    units: "any",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "" },
  },
];

interface TaskRow {
  readonly title: string;
  readonly order: keyof typeof WORDS.order;
  readonly run: keyof typeof WORDS.run;
  readonly blocked: keyof typeof WORDS.blocked;
  readonly task: keyof typeof WORDS.task;
  readonly downstream: "none" | "started" | "-";
  readonly cells: Readonly<Record<keyof ShopWork.TaskActions, string>>;
}

/** The `taskActions` matrix, row by row. */
const TASK_ROWS: readonly TaskRow[] = [
  {
    title:
      "order open, run open, blocked no, task ready, downstream - → start m, done M m, assign M",
    order: "open",
    run: "open",
    blocked: "no",
    task: "ready",
    downstream: "-",
    cells: { start: "m", done: "M m", putBack: "", reopen: "", assign: "M" },
  },
  {
    title:
      "order open, run open, blocked no, task started, downstream - → done M m, putBack M m, assign M",
    order: "open",
    run: "open",
    blocked: "no",
    task: "started",
    downstream: "-",
    cells: { start: "", done: "M m", putBack: "M m", reopen: "", assign: "M" },
  },
  {
    title: "order open, run open, blocked no, task waiting, downstream - → assign M",
    order: "open",
    run: "open",
    blocked: "no",
    task: "waiting",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "M" },
  },
  {
    title: "order open, run open, blocked yes, task any open, downstream - → assign M",
    order: "open",
    run: "open",
    blocked: "yes",
    task: "any open",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "M" },
  },
  {
    title: "order open, run open or done, blocked any, task done, downstream none → reopen M m",
    order: "open",
    run: "open or done",
    blocked: "any",
    task: "done",
    downstream: "none",
    cells: { start: "", done: "", putBack: "", reopen: "M m", assign: "" },
  },
  {
    title: "order open, run open or done, blocked any, task done, downstream started → nothing",
    order: "open",
    run: "open or done",
    blocked: "any",
    task: "done",
    downstream: "started",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "" },
  },
  {
    title: "order open, run closed, blocked no, task any, downstream - → nothing",
    order: "open",
    run: "closed",
    blocked: "no",
    task: "any",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "" },
  },
  {
    title: "order closed, run open or done, blocked any, task any, downstream - → nothing",
    order: "closed",
    run: "open or done",
    blocked: "any",
    task: "any",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "" },
  },
  {
    title: "order closed, run closed, blocked no, task any, downstream - → nothing",
    order: "closed",
    run: "closed",
    blocked: "no",
    task: "any",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "" },
  },
];

/**
 * Every order and run state a row's words name. A done run is never
 * blocked, so "any" under `blocked` puts a block on the open run only.
 */
const statesOf = (row: Pick<RunRow, "order" | "run" | "blocked">) =>
  WORDS.order[row.order].flatMap((order) =>
    WORDS.run[row.run].flatMap((state) =>
      WORDS.blocked[row.blocked]
        .filter((blockedAt) => blockedAt === null || state === "open")
        .map((blockedAt) => ({ order, run: { state, blockedAt } })),
    ),
  );

/** Whether a cell offers the action to "M", "m" or "v". */
const offered = (cell: string, who: Who) => cell.split(" ").includes(who);

/** The result object a row's cells say `who` gets. */
const expectedOf = <K extends string>(cells: Readonly<Record<K, string>>, who: Who) =>
  Object.fromEntries(
    Object.entries<string>(cells).map(([field, cell]) => [field, offered(cell, who)]),
  );

describe("Domain.runActions matrix", () => {
  for (const row of RUN_ROWS)
    it(row.title, () => {
      for (const { order, run: state } of statesOf(row))
        for (const currentQuantity of WORDS.units[row.units]) {
          const item = { currentQuantity };
          // "M" and "m": the run's one task, on the member's team, current
          // exactly when the run is open.
          const tasks = [{ teamId: T, current: ShopWork.runIsOpen(state) }];
          deepStrictEqual(
            ShopWork.runActions(MERCHANT, order, state, tasks, item),
            expectedOf(row.cells, "M"),
          );
          deepStrictEqual(
            ShopWork.runActions(MEMBER, order, state, tasks, item),
            expectedOf(row.cells, "m"),
          );
          // "v": the member's task is not current; on an open run another
          // team's is. On a done or closed run neither is, and "v" and "m"
          // coincide there, as the cells do.
          const visibleTasks = [
            { teamId: T, current: false },
            { teamId: OTHER, current: ShopWork.runIsOpen(state) },
          ];
          deepStrictEqual(
            ShopWork.runActions(MEMBER, order, state, visibleTasks, item),
            expectedOf(row.cells, "v"),
          );
        }
    });

  it("without the item, Change workflow is not offered", () => {
    strictEqual(
      ShopWork.runActions(MERCHANT, OPEN_ORDER, run("open"), [{ teamId: T, current: true }])
        .changeWorkflow,
      false,
    );
  });
});

/** The task set that offers nothing. */
const NOTHING: ShopWork.TaskActions = {
  start: false,
  done: false,
  putBack: false,
  reopen: false,
  assign: false,
};

const task = (overrides: Partial<TaskState & { readonly laterStepStarted: boolean }> = {}) => ({
  teamId: T,
  ...READY,
  laterStepStarted: false,
  ...overrides,
});

describe("Domain.taskActions matrix", () => {
  for (const row of TASK_ROWS)
    it(row.title, () => {
      for (const { order, run: state } of statesOf(row))
        for (const taskState of WORDS.task[row.task]) {
          const view = task({ ...taskState, laterStepStarted: row.downstream === "started" });
          deepStrictEqual(
            ShopWork.taskActions(MERCHANT, order, state, view),
            expectedOf(row.cells, "M"),
          );
          deepStrictEqual(
            ShopWork.taskActions(MEMBER, order, state, view),
            expectedOf(row.cells, "m"),
          );
        }
    });

  it("a task on no team is nobody's: every member cell is blank and every merchant cell holds", () => {
    const ready = TASK_ROWS.find(
      (row) =>
        row.order === "open" && row.run === "open" && row.blocked === "no" && row.task === "ready",
    );
    if (ready === undefined) throw new Error("no ready row");
    // No team, and a team that no longer exists: one answer for both.
    for (const teamId of [null, Schema.decodeUnknownSync(ShopWork.TeamId)("gone")]) {
      const view = { ...task(), teamId };
      deepStrictEqual(ShopWork.taskActions(MEMBER, OPEN_ORDER, run("open"), view), NOTHING);
      deepStrictEqual(
        ShopWork.taskActions(MERCHANT, OPEN_ORDER, run("open"), view),
        expectedOf(ready.cells, "M"),
      );
    }
  });
});

/** What each word of the actions table on `reconcileItem` stands for. */
const RECONCILE_WORDS = {
  order: ["cancelled", "fulfilled", "closed", "open"],
  paid: ["yes", "no", "any"],
  units: ["0", "changed", "same", "some", "any"],
  run: ["open", "done or closed", "none"],
  matches: ["0", "1", "2+", "any"],
} as const;

type ReconcileWord<K extends keyof typeof RECONCILE_WORDS> = (typeof RECONCILE_WORDS)[K][number];

interface ReconcileRow {
  readonly title: string;
  readonly order: ReconcileWord<"order">;
  readonly paid: ReconcileWord<"paid">;
  readonly units: ReconcileWord<"units">;
  readonly run: ReconcileWord<"run">;
  readonly matches: ReconcileWord<"matches">;
  readonly action:
    | { readonly tag: "create" | "resize" | "nothing" }
    | { readonly tag: "close"; readonly reason: ShopWork.ClosedReason };
}

/** The actions table on `reconcileItem`, row by row; the title is the row's cells joined with ` | `. */
const RECONCILE_ROWS: readonly ReconcileRow[] = [
  {
    title: "cancelled | any | any | open | any | close `order_cancelled`",
    order: "cancelled",
    paid: "any",
    units: "any",
    run: "open",
    matches: "any",
    action: { tag: "close", reason: "order_cancelled" },
  },
  {
    title: "fulfilled | any | any | open | any | close `fulfilled`",
    order: "fulfilled",
    paid: "any",
    units: "any",
    run: "open",
    matches: "any",
    action: { tag: "close", reason: "fulfilled" },
  },
  {
    title: "closed | any | any | done or closed | any | nothing",
    order: "closed",
    paid: "any",
    units: "any",
    run: "done or closed",
    matches: "any",
    action: { tag: "nothing" },
  },
  {
    title: "closed | any | any | none | any | nothing: the order is over, nothing to create",
    order: "closed",
    paid: "any",
    units: "any",
    run: "none",
    matches: "any",
    action: { tag: "nothing" },
  },
  {
    title: "open | any | 0 | open | any | close `item_removed`",
    order: "open",
    paid: "any",
    units: "0",
    run: "open",
    matches: "any",
    action: { tag: "close", reason: "item_removed" },
  },
  {
    title: "open | any | changed | open | any | resize",
    order: "open",
    paid: "any",
    units: "changed",
    run: "open",
    matches: "any",
    action: { tag: "resize" },
  },
  {
    title: "open | any | same | open | any | nothing",
    order: "open",
    paid: "any",
    units: "same",
    run: "open",
    matches: "any",
    action: { tag: "nothing" },
  },
  {
    title: "open | any | any | done or closed | any | nothing: the run holds its item",
    order: "open",
    paid: "any",
    units: "any",
    run: "done or closed",
    matches: "any",
    action: { tag: "nothing" },
  },
  {
    title: "open | any | 0 | none | any | nothing: no units to make",
    order: "open",
    paid: "any",
    units: "0",
    run: "none",
    matches: "any",
    action: { tag: "nothing" },
  },
  {
    title: "open | yes | some | none | 1 | create",
    order: "open",
    paid: "yes",
    units: "some",
    run: "none",
    matches: "1",
    action: { tag: "create" },
  },
  {
    title: "open | any | some | none | 0 | nothing",
    order: "open",
    paid: "any",
    units: "some",
    run: "none",
    matches: "0",
    action: { tag: "nothing" },
  },
  {
    title: "open | no | some | none | 1 | nothing: created when it pays",
    order: "open",
    paid: "no",
    units: "some",
    run: "none",
    matches: "1",
    action: { tag: "nothing" },
  },
  {
    title: "open | any | some | none | 2+ | nothing: multi-match",
    order: "open",
    paid: "any",
    units: "some",
    run: "none",
    matches: "2+",
    action: { tag: "nothing" },
  },
];

interface FixtureRun {
  readonly state: ShopWork.RunState;
  readonly quantity: number;
}

interface ReconcileFixture {
  readonly order: Orders.OrderState & { readonly fullyPaid: boolean };
  readonly units: number;
  readonly run: FixtureRun | null;
  readonly matched: number;
}

/** The quantity every fixture run carries; `changed` units are one more, `same` are equal, `some` are both. */
const RUN_QUANTITY = 2;

const OPEN = { cancelledAt: null, fulfillmentStatus: "UNFULFILLED" };
const CANCELLED = { cancelledAt: 1, fulfillmentStatus: "UNFULFILLED" };
const FULFILLED = { cancelledAt: null, fulfillmentStatus: "FULFILLED" };

/**
 * Every fixture a row stands for: the cross product of its cells, each word
 * read as the values it covers. `any` covers every value of its column;
 * `closed` under `order` is cancelled or fulfilled; `done or closed` under
 * `run on item` is either state.
 */
const expandReconcile = (
  row: Omit<ReconcileRow, "title" | "action">,
): readonly ReconcileFixture[] => {
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
  const fixtureRun = (state: ShopWork.RunState): FixtureRun => ({ state, quantity: RUN_QUANTITY });
  const runs = {
    open: [fixtureRun("open")],
    "done or closed": [fixtureRun("done"), fixtureRun("closed")],
    none: [null],
  }[row.run];
  const matches = { "0": [0], "1": [1], "2+": [2], any: [0, 1, 2] }[row.matches];
  return orders.flatMap((order) =>
    paid.flatMap((fullyPaid) =>
      units.flatMap((unit) =>
        runs.flatMap((run) =>
          matches.map((matched) => ({
            order: { ...order, fullyPaid },
            units: unit,
            run,
            matched,
          })),
        ),
      ),
    ),
  );
};

const MATCHED = ["w1", "w2"].map((id) => Schema.decodeUnknownSync(ShopWork.WorkflowId)(id));

const plan = (fixture: ReconcileFixture, run: FixtureRun | null, units: number) =>
  ShopWork.reconcileItem({
    order: fixture.order,
    item: { currentQuantity: units },
    run: run === null ? null : { run: { state: run.state, quantity: run.quantity } },
    matched: MATCHED.slice(0, fixture.matched),
  });

describe("Domain.reconcileItem actions", () => {
  for (const row of RECONCILE_ROWS)
    it(row.title, () => {
      for (const fixture of expandReconcile(row)) {
        const action = plan(fixture, fixture.run, fixture.units);
        const where = JSON.stringify(fixture);
        strictEqual(action._tag, row.action.tag, where);
        if (action._tag === "close" && row.action.tag === "close")
          strictEqual(action.reason, row.action.reason, where);
        if (action._tag === "resize") strictEqual(action.units, fixture.units, where);
        if (action._tag === "create") strictEqual(action.workflowId, MATCHED[0], where);
      }
    });
});

/** The run an action leaves on the item; `units` is what a create copies. */
const apply = (
  run: FixtureRun | null,
  action: ShopWork.ReconcileAction,
  units: number,
): FixtureRun | null =>
  Match.valueTags(action, {
    create: (): FixtureRun | null => ({ state: "open", quantity: units }),
    close: (): FixtureRun | null => (run === null ? null : { ...run, state: "closed" }),
    resize: ({ units: resized }): FixtureRun | null =>
      run === null ? null : { ...run, quantity: resized },
    nothing: (): FixtureRun | null => run,
  });

const stopped = (fixture: ReconcileFixture) =>
  Orders.orderIsCancelled(fixture.order) || Orders.orderIsFulfilled(fixture.order);

const same = (a: FixtureRun | null, b: FixtureRun | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** The clauses of the post-condition, each over the fixture (before) and the run a pass left. */
const CLAUSES = {
  stop: (fixture: ReconcileFixture, after: FixtureRun | null) =>
    !stopped(fixture) || after === null || after.state !== "open",
  fit: (fixture: ReconcileFixture, after: FixtureRun | null) =>
    stopped(fixture) ||
    fixture.run?.state !== "open" ||
    (fixture.units === 0
      ? after?.state === "closed"
      : after?.state === "open" && after.quantity === fixture.units),
  record: (fixture: ReconcileFixture, after: FixtureRun | null) =>
    fixture.run === null || fixture.run.state === "open" || same(after, fixture.run),
  create: (fixture: ReconcileFixture, after: FixtureRun | null) =>
    stopped(fixture) ||
    fixture.run !== null ||
    (after !== null) ===
      (Orders.orderCanCreateRuns(fixture.order) && fixture.units > 0 && fixture.matched === 1),
};

/**
 * A pass over a stored run whose item is not stored: read as an item at
 * zero units with no match (the run repository's `reconcileOrder`).
 */
const orphanPass = (fixture: ReconcileFixture, run: FixtureRun | null) =>
  plan({ ...fixture, matched: 0 }, run, 0);

const orphan = (before: FixtureRun | null, after: FixtureRun | null) =>
  before?.state !== "open" || after?.state === "closed";

/** Every fixture the actions table can name: the cross product of each column's words, expanded and deduplicated. */
const reconcileUniverse = (): readonly ReconcileFixture[] => {
  const words = RECONCILE_WORDS;
  const fixtures = words.order.flatMap((order) =>
    words.paid.flatMap((paid) =>
      words.units.flatMap((units) =>
        words.run.flatMap((run) =>
          words.matches.flatMap((matches) => expandReconcile({ order, paid, units, run, matches })),
        ),
      ),
    ),
  );
  return [
    ...new Map(fixtures.map((fixture) => [JSON.stringify(fixture), fixture] as const)).values(),
  ];
};

/**
 * The post-condition on `reconcileItem` ("What a pass guarantees"), checked
 * on every fixture the actions table can name rather than on the rows: each
 * clause is a predicate over the state before and after one pass, so a
 * failure names the clause, and a second pass over the state the first left
 * must write nothing.
 */
describe("Domain.reconcileItem post-condition", () => {
  it("a pass guarantees stop, fit, record, create and orphan, and a second pass writes nothing", () => {
    const universe = reconcileUniverse();
    expect(universe.length).toBe(216);
    for (const fixture of universe) {
      const where = JSON.stringify(fixture);
      const first = plan(fixture, fixture.run, fixture.units);
      const after = apply(fixture.run, first, fixture.units);
      for (const [clause, holds] of Object.entries(CLAUSES))
        strictEqual(holds(fixture, after), true, `${clause}: ${where}`);
      deepStrictEqual(
        plan(fixture, after, fixture.units),
        { _tag: "nothing" },
        `second pass: ${where}`,
      );
      if (fixture.run !== null) {
        const left = apply(fixture.run, orphanPass(fixture, fixture.run), 0);
        strictEqual(orphan(fixture.run, left), true, `orphan: ${where}`);
        deepStrictEqual(
          orphanPass(fixture, left),
          { _tag: "nothing" },
          `orphan second pass: ${where}`,
        );
      }
    }
  });
});

const workflowOf = (id: string, name: string): ShopWork.Workflow => ({
  id: Schema.decodeUnknownSync(ShopWork.WorkflowId)(id),
  name: Schema.decodeUnknownSync(ShopWork.WorkflowName)(name),
  tag: Schema.decodeUnknownSync(ShopWork.WorkflowTag)(name.toLowerCase()),
  state: "active",
  updatedAt: 0,
});

const lineItemOf = (overrides: Partial<Orders.OrderLineItem> = {}): Orders.OrderLineItem => ({
  id: "li",
  orderId: "o",
  title: "Ring",
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  productTags: [],
  properties: [],
  ...overrides,
});

const detailOf = (state: ShopWork.RunState, lineItemId = "li"): ShopWork.RunDetail => ({
  run: {
    id: Schema.decodeUnknownSync(ShopWork.RunId)("r"),
    workflowId: Schema.decodeUnknownSync(ShopWork.WorkflowId)("w1"),
    workflowName: Schema.decodeUnknownSync(ShopWork.WorkflowName)("Engrave"),
    orderId: "o",
    orderName: "#1",
    orderProcessedAt: 0,
    lineItemId,
    lineItemTitle: "Ring",
    variantTitle: null,
    sku: null,
    quantity: 1,
    lineItemProperties: [],
    state,
    startedAt: state === "done" ? 1 : null,
    blockedAt: null,
    blockReason: null,
    blockedBy: null,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    closedAt: state === "closed" ? 1 : null,
    closedReason: state === "closed" ? "merchant_cancelled" : null,
  },
  tasks: [],
});

const TEAMS = [{ id: T }];

/** `workflow` with one task on team `t`: eligible when on. */
const withTask = (workflow: ShopWork.Workflow): ShopWork.WorkflowDetail => ({
  workflow,
  tasks: [
    {
      id: Schema.decodeUnknownSync(ShopWork.WorkflowTaskId)(`${workflow.id}-t`),
      position: 1,
      step: 1,
      name: Schema.decodeUnknownSync(ShopWork.TaskName)("Task"),
      teamId: T,
      instructions: null,
    },
  ],
});

const stateOf = (
  item: Orders.OrderLineItem,
  runs: readonly ShopWork.RunDetail[],
  offeredWorkflows: readonly ShopWork.Workflow[],
) => ShopWork.lineItemState(item, runs, offeredWorkflows.map(withTask), [], TEAMS);

describe("Domain.lineItemState", () => {
  it("lineItemState has one kind per layout", () => {
    const engrave = workflowOf("w1", "Engrave");
    const polish = workflowOf("w2", "Polish");
    const workflows = [polish, engrave];
    const kind = (
      item: Orders.OrderLineItem,
      runs: readonly ShopWork.RunDetail[],
      offeredWorkflows: readonly ShopWork.Workflow[] = workflows,
    ) => stateOf(item, runs, offeredWorkflows).kind;
    strictEqual(kind(lineItemOf(), [detailOf("open")]), "open");
    strictEqual(kind(lineItemOf(), [detailOf("done")]), "ended");
    strictEqual(kind(lineItemOf(), [detailOf("closed")]), "ended");
    // A run is the news even when the line went to zero under it.
    strictEqual(kind(lineItemOf({ currentQuantity: 0 }), [detailOf("open")]), "open");
    strictEqual(kind(lineItemOf({ currentQuantity: 0 }), []), "removed");
    strictEqual(kind(lineItemOf(), [], []), "unmatched");
    strictEqual(kind(lineItemOf(), [detailOf("open", "other")]), "attachable");

    const attachable = stateOf(
      lineItemOf({ productTags: ["engrave", "polish"] }),
      [],
      [polish, engrave, workflowOf("w3", "Rush")],
    );
    if (attachable.kind !== "attachable") throw new Error(attachable.kind);
    strictEqual(attachable.multiMatch, true);
    // Matched first, in the teams' order, then the rest.
    deepStrictEqual(
      attachable.options.map((workflow) => workflow.name),
      ["Polish", "Engrave", "Rush"],
    );

    // A done or closed item keeps its run's tasks as the record and offers
    // every workflow, its own included.
    for (const state of ["done", "closed"] as const) {
      const detail = detailOf(state);
      const ended = stateOf(lineItemOf(), [detail], workflows);
      if (ended.kind !== "ended") throw new Error(ended.kind);
      strictEqual(ended.run.id, detail.run.id);
      deepStrictEqual(ended.tasks, []);
      deepStrictEqual(
        ended.options.map((workflow) => workflow.id),
        [polish.id, engrave.id],
      );
      strictEqual(ended.attachable, true);
      // Nothing left to make: the run stands, and no workflow starts.
      const emptied = stateOf(lineItemOf({ currentQuantity: 0 }), [detailOf(state)], workflows);
      if (emptied.kind !== "ended") throw new Error(emptied.kind);
      strictEqual(emptied.attachable, false);
    }
  });
});
