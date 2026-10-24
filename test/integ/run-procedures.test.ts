import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import { SetTeamMemberInput } from "../../src/contract/members.ts";
import {
  CONNECTION_CLOSE_REVOKED,
  type MemberCaller,
  ORDERS_KEY,
} from "../../src/contract/shop-actor.ts";
import * as Orders from "../../src/domain/orders.ts";
import { Email } from "../../src/domain/platform.ts";
import * as ShopWork from "../../src/domain/shop-work.ts";
import { SEED_SHOP } from "../seed-shops.ts";
import {
  addToFixture,
  connectAs,
  dev,
  editingAt,
  email,
  nextCloseCode,
  openAs,
  signIn,
  storeByWebhook,
} from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The run procedures over forged sockets, against the action sets: every `procedures:` row of
 * `runActions` and `taskActions`, driven into each state the row names, as the merchant ("M")
 * and as a member on the run's team ("m"), answers as its cells say; and the workflows list's
 * socket reads and the notices the run writes send. Each case gets an order of its own, added by
 * `AddToFixture` and brought into its state through the procedures themselves and, for the
 * order's own state, a webhook, as production reaches it: no state is written straight to the
 * actor's SQLite. "v" is driven by one case of its own (a Relay run whose current task is on
 * another team), beside the unit matrix that proves the formula for every row.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("runcallables"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const decodeFixture = Schema.decodeUnknownSync(ShopFixtureData);
const runIdInput = Schema.decodeUnknownSync(ShopWork.RunIdInput);
const taskInput = Schema.decodeUnknownSync(ShopWork.MarkTaskDoneInput);
const noteInput = Schema.decodeUnknownSync(ShopWork.SetRunNoteInput);
const blockInput = Schema.decodeUnknownSync(ShopWork.BlockRunInput);
const attachInput = Schema.decodeUnknownSync(ShopWork.AttachWorkflowInput);
const assignInput = Schema.decodeUnknownSync(ShopWork.AssignRunTaskTeamInput);
const runQuery = Schema.decodeUnknownSync(ShopWork.RunQuery);

const ALICE = "alice@run-procedures.test";
const BOB = "bob@run-procedures.test";
const CAROL = "carol@run-procedures.test";

/** A slow case: every one adds and arranges orders over the wire. */
const SLOW = { timeout: 600_000 };

/**
 * The shop every test starts from, after an empty load: Alice and Bob on Bench, Carol on Idle;
 * Engrave and Rush (tags `engrave`, `rush`), each Cut then Polish on Bench; Solo (tag `solo`), one
 * task on Bench; Relay (tag `relay`), Cut on Bench then Polish on Idle.
 */
const WORLD = decodeFixture({
  members: [ALICE, BOB, CAROL],
  teams: [
    { name: "Bench", members: [ALICE, BOB] },
    { name: "Idle", members: [CAROL] },
  ],
  workflows: [
    {
      name: "Engrave",
      tag: "engrave",
      tasks: [
        { name: "Cut", team: "Bench" },
        { name: "Polish", team: "Bench" },
      ],
    },
    {
      name: "Rush",
      tag: "rush",
      tasks: [
        { name: "Cut", team: "Bench" },
        { name: "Polish", team: "Bench" },
      ],
    },
    { name: "Solo", tag: "solo", tasks: [{ name: "Engrave", team: "Bench" }] },
    {
      name: "Relay",
      tag: "relay",
      tasks: [
        { name: "Cut", team: "Bench" },
        { name: "Polish", team: "Idle" },
      ],
    },
  ],
  orders: [],
});

/** Each fixture order's number, unique in the file, so no two cases share an order. */
let nextOrder = 100;

const legacyIdOf = (n: number) => `fixture-${String(n)}`;
const orderIdOf = (n: number) => `gid://shopify/Order/${legacyIdOf(n)}`;
const lineItemIdOf = (n: number) => `${orderIdOf(n)}/line-1`;

/** A member's forged caller on `teamIds`. */
const memberOf = (address: string, teamIds: ReadonlyArray<string>): MemberCaller => ({
  role: "member",
  memberId: address.split("@")[0] ?? address,
  memberEmail: email(address),
  teamIds: [...teamIds],
  userId: `user-${address}`,
  sessionId: `session-${address}`,
  sessionExpiresAt: Date.now() + 3_600_000,
});

/**
 * The shop reset to {@link WORLD}, and the sockets a case acts through: the merchant, Alice and
 * Bob on Bench, Carol on Idle. Every socket has answered once, so it is open. Lives in the
 * caller's scope.
 */
const world = Effect.gen(function* () {
  const { backendUrl } = yield* stack;
  yield* dev(backendUrl, (c) =>
    c.LoadFixture({
      shop: SEED_SHOP,
      fixture: { members: [], teams: [], workflows: [], orders: [] },
    }),
  );
  yield* addToFixture(backendUrl, SEED_SHOP, WORLD);
  const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
  const { teams } = yield* merchant.client.MerchantListOrders({
    limit: 25,
    cursor: null,
    q: null,
    show: "all",
    team: null,
  });
  const teamId = (name: string) => {
    const found = teams.find((team) => team.name === name);
    if (found === undefined) throw new Error(`no team ${name}`);
    return found.id;
  };
  const bench = teamId("Bench");
  const idle = teamId("Idle");
  const alice = yield* openAs(backendUrl, SEED_SHOP, memberOf(ALICE, [bench]));
  const bob = yield* openAs(backendUrl, SEED_SHOP, memberOf(BOB, [bench]));
  const carol = yield* openAs(backendUrl, SEED_SHOP, memberOf(CAROL, [idle]));
  for (const member of [alice, bob, carol]) yield* member.client.MemberWhoAmI();
  return { backendUrl, merchant, alice, bob, carol, bench, idle };
});

type World = Effect.Success<typeof world>;

/** Adds one fixture order per `tags` entry, each with one item carrying those tags; their numbers. */
const addOrders = (backendUrl: string, tags: ReadonlyArray<ReadonlyArray<string>>) =>
  Effect.gen(function* () {
    const numbers = tags.map(() => (nextOrder += 1));
    yield* addToFixture(
      backendUrl,
      SEED_SHOP,
      decodeFixture({
        members: [],
        teams: [],
        workflows: [],
        orders: numbers.map((n, index) => ({
          n,
          lineItems: [{ title: `Item ${String(n)}`, quantity: 1, tags: tags[index] ?? [] }],
        })),
      }),
    );
    return numbers;
  });

/** The order page's data for fixture order `n`, failing the case when it is not stored. */
const orderPage = (w: World, n: number) =>
  Effect.flatMap(w.merchant.client.MerchantGetOrderDetail({ legacyId: legacyIdOf(n) }), (page) =>
    page === null ? Effect.die(new Error(`no order ${String(n)}`)) : Effect.succeed(page),
  );

/** The order's one run with its tasks, failing the case when there is none. */
const runOf = (w: World, n: number) =>
  Effect.flatMap(orderPage(w, n), ({ runs }) => {
    const [detail] = runs;
    return detail === undefined
      ? Effect.die(new Error(`no run on ${String(n)}`))
      : Effect.succeed(detail);
  });

/**
 * Shopify's copy of fixture order `n` after a change, delivered by webhook: cancelled, fulfilled,
 * or its one line at `units`. The fake answers with the order's own ids, so the stored item is the
 * one rewritten.
 */
const changeOrder = (
  w: World,
  n: number,
  { order, units }: { readonly order: "open" | "cancelled" | "fulfilled"; readonly units: number },
  tags: ReadonlyArray<string>,
) => {
  const node: OrderNode = {
    id: orderIdOf(n),
    legacyResourceId: legacyIdOf(n),
    name: `#${String(n)}`,
    processedAt: Date.now() - 86_400_000,
    updatedAt: Date.now() + 1000,
    cancelledAt: order === "cancelled" ? Date.now() : null,
    displayFulfillmentStatus: order === "fulfilled" ? "FULFILLED" : "UNFULFILLED",
    fullyPaid: true,
    note: null,
  };
  const item: LineItemNode = {
    id: lineItemIdOf(n),
    title: `Item ${String(n)}`,
    variantTitle: null,
    sku: null,
    quantity: 1,
    currentQuantity: units,
    customAttributes: [],
    product: { tags: [...tags] },
  };
  return storeByWebhook(w.backendUrl, SEED_SHOP, node, [item]);
};

/** One task's progress as a case arranges it. */
interface Progress {
  readonly started: boolean;
  readonly done: boolean;
}
const IDLE: Progress = { started: false, done: false };
const DONE: Progress = { started: true, done: true };

/**
 * The state a case puts its order's run into: Cut's and Polish's progress (both done is a done
 * run), a block, a cancel, and then the order's own state and units. Reachable only as the
 * product reaches it: an open run never sits on a closed order or a line at zero units, because
 * that write closes it.
 */
interface Arrangement {
  readonly order: "open" | "cancelled" | "fulfilled";
  readonly closed: boolean;
  readonly blocked: boolean;
  readonly units: number;
  readonly cut: Progress;
  readonly polish: Progress;
}

const ok = (label: string) => (result: { readonly _tag: string }) =>
  result._tag === "Ok" ? Effect.void : Effect.die(new Error(`${label}: ${result._tag}`));

/** Puts fixture order `n`'s Engrave run into `state`: Alice works the tasks, the merchant blocks and cancels. */
const arrange = (w: World, n: number, state: Arrangement) =>
  Effect.gen(function* () {
    const { run, tasks } = yield* runOf(w, n);
    for (const [index, progress] of [state.cut, state.polish].entries()) {
      const task = tasks[index];
      if (task === undefined) return yield* Effect.die(new Error("task"));
      const runTaskId = task.id;
      if (progress.started)
        yield* w.alice.client
          .MemberStartTask(taskInput({ runTaskId }))
          .pipe(Effect.flatMap(ok("start")));
      if (progress.done)
        yield* w.alice.client
          .MemberMarkTaskDone(taskInput({ runTaskId }))
          .pipe(Effect.flatMap(ok("done")));
    }
    if (state.blocked)
      yield* w.merchant.client
        .MerchantBlockRun(blockInput({ runId: run.id, reason: null }))
        .pipe(Effect.flatMap(ok("block")));
    if (state.closed)
      yield* w.merchant.client
        .MerchantCancelRun(runIdInput({ runId: run.id }))
        .pipe(Effect.flatMap(ok("cancel")));
    if (state.order !== "open" || state.units !== 1) yield* changeOrder(w, n, state, ["engrave"]);
    return yield* runOf(w, n);
  });

type Who = "M" | "m";

/** Whether a cell offers the action to `who`. */
const offered = (cell: string, who: Who) => cell.split(" ").includes(who);

const ORDER_WORDS = { open: ["open"], closed: ["cancelled", "fulfilled"] } as const;
const RUN_WORDS = {
  open: ["open"],
  done: ["done"],
  closed: ["closed"],
  "open or done": ["open", "done"],
} as const;
const BLOCKED_WORDS = { yes: [true], no: [false], any: [false, true] } as const;
const UNITS_WORDS = { some: [1], none: [0], any: [1, 0] } as const;

/** One task state of the `taskActions` table's `task` column. */
interface TaskState {
  readonly current: boolean;
  readonly started: boolean;
  readonly done: boolean;
}
const READY: TaskState = { current: true, started: false, done: false };
const STARTED: TaskState = { current: true, started: true, done: false };
const WAITING: TaskState = { current: false, started: false, done: false };
const DONE_TASK: TaskState = { current: false, started: true, done: true };
const TASK_WORDS = {
  ready: [READY],
  started: [STARTED],
  waiting: [WAITING],
  done: [DONE_TASK],
  "any open": [READY, STARTED, WAITING],
  any: [READY, STARTED, WAITING, DONE_TASK],
} as const;

interface RunRow {
  readonly title: string;
  readonly order: keyof typeof ORDER_WORDS;
  readonly run: keyof typeof RUN_WORDS;
  readonly blocked: keyof typeof BLOCKED_WORDS;
  readonly units: keyof typeof UNITS_WORDS;
  readonly cells: Readonly<Record<keyof ShopWork.RunActions, string>>;
}

/** The `runActions` table, each row's title rendered back with the `procedures:` prefix. */
const RUN_ROWS: ReadonlyArray<RunRow> = [
  {
    title:
      "procedures: order open, run open, blocked no, units some → note M m v, block M m, cancel M, changeWorkflow M",
    order: "open",
    run: "open",
    blocked: "no",
    units: "some",
    cells: { note: "M m v", block: "M m", unblock: "", cancel: "M", changeWorkflow: "M" },
  },
  {
    title:
      "procedures: order open, run open, blocked yes, units some → note M m v, unblock M m, cancel M, changeWorkflow M",
    order: "open",
    run: "open",
    blocked: "yes",
    units: "some",
    cells: { note: "M m v", block: "", unblock: "M m", cancel: "M", changeWorkflow: "M" },
  },
  {
    title:
      "procedures: order open, run open, blocked no, units none → note M m v, block M m, cancel M",
    order: "open",
    run: "open",
    blocked: "no",
    units: "none",
    cells: { note: "M m v", block: "M m", unblock: "", cancel: "M", changeWorkflow: "" },
  },
  {
    title:
      "procedures: order open, run open, blocked yes, units none → note M m v, unblock M m, cancel M",
    order: "open",
    run: "open",
    blocked: "yes",
    units: "none",
    cells: { note: "M m v", block: "", unblock: "M m", cancel: "M", changeWorkflow: "" },
  },
  {
    title:
      "procedures: order open, run done, blocked no, units some → note M m v, changeWorkflow M",
    order: "open",
    run: "done",
    blocked: "no",
    units: "some",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "M" },
  },
  {
    title: "procedures: order open, run done, blocked no, units none → note M m v",
    order: "open",
    run: "done",
    blocked: "no",
    units: "none",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "" },
  },
  {
    title:
      "procedures: order open, run closed, blocked no, units some → note M m v, changeWorkflow M",
    order: "open",
    run: "closed",
    blocked: "no",
    units: "some",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "M" },
  },
  {
    title: "procedures: order open, run closed, blocked no, units none → note M m v",
    order: "open",
    run: "closed",
    blocked: "no",
    units: "none",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "" },
  },
  {
    title: "procedures: order closed, run open or done, blocked any, units any → note M m v",
    order: "closed",
    run: "open or done",
    blocked: "any",
    units: "any",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "" },
  },
  {
    title: "procedures: order closed, run closed, blocked no, units any → note M m v",
    order: "closed",
    run: "closed",
    blocked: "no",
    units: "any",
    cells: { note: "M m v", block: "", unblock: "", cancel: "", changeWorkflow: "" },
  },
];

interface TaskRow {
  readonly title: string;
  readonly order: keyof typeof ORDER_WORDS;
  readonly run: keyof typeof RUN_WORDS;
  readonly blocked: keyof typeof BLOCKED_WORDS;
  readonly task: keyof typeof TASK_WORDS;
  readonly downstream: "none" | "started" | "-";
  readonly cells: Readonly<Record<keyof ShopWork.TaskActions, string>>;
}

/** The `taskActions` table, each row's title rendered back with the `procedures:` prefix. */
const TASK_ROWS: ReadonlyArray<TaskRow> = [
  {
    title:
      "procedures: order open, run open, blocked no, task ready, downstream - → start m, done M m, assign M",
    order: "open",
    run: "open",
    blocked: "no",
    task: "ready",
    downstream: "-",
    cells: { start: "m", done: "M m", putBack: "", reopen: "", assign: "M" },
  },
  {
    title:
      "procedures: order open, run open, blocked no, task started, downstream - → done M m, putBack M m, assign M",
    order: "open",
    run: "open",
    blocked: "no",
    task: "started",
    downstream: "-",
    cells: { start: "", done: "M m", putBack: "M m", reopen: "", assign: "M" },
  },
  {
    title: "procedures: order open, run open, blocked no, task waiting, downstream - → assign M",
    order: "open",
    run: "open",
    blocked: "no",
    task: "waiting",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "M" },
  },
  {
    title: "procedures: order open, run open, blocked yes, task any open, downstream - → assign M",
    order: "open",
    run: "open",
    blocked: "yes",
    task: "any open",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "M" },
  },
  {
    title:
      "procedures: order open, run open or done, blocked any, task done, downstream none → reopen M m",
    order: "open",
    run: "open or done",
    blocked: "any",
    task: "done",
    downstream: "none",
    cells: { start: "", done: "", putBack: "", reopen: "M m", assign: "" },
  },
  {
    title:
      "procedures: order open, run open or done, blocked any, task done, downstream started → nothing",
    order: "open",
    run: "open or done",
    blocked: "any",
    task: "done",
    downstream: "started",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "" },
  },
  {
    title: "procedures: order open, run closed, blocked no, task any, downstream - → nothing",
    order: "open",
    run: "closed",
    blocked: "no",
    task: "any",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "" },
  },
  {
    title:
      "procedures: order closed, run open or done, blocked any, task any, downstream - → nothing",
    order: "closed",
    run: "open or done",
    blocked: "any",
    task: "any",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "" },
  },
  {
    title: "procedures: order closed, run closed, blocked no, task any, downstream - → nothing",
    order: "closed",
    run: "closed",
    blocked: "no",
    task: "any",
    downstream: "-",
    cells: { start: "", done: "", putBack: "", reopen: "", assign: "" },
  },
];

/** Every order, run and block state a row's words name; a block only on an open run. */
const statesOf = (row: Pick<RunRow, "order" | "run" | "blocked">) =>
  ORDER_WORDS[row.order].flatMap((order) =>
    RUN_WORDS[row.run].flatMap((run) =>
      BLOCKED_WORDS[row.blocked]
        .filter((blocked) => !blocked || run === "open")
        .map((blocked) => ({ order, run, blocked })),
    ),
  );

/** The arrangements a `runActions` row stands for that the product can reach. */
const runArrangements = (row: RunRow): ReadonlyArray<Arrangement> =>
  statesOf(row).flatMap(({ order, run, blocked }) =>
    UNITS_WORDS[row.units].flatMap((units): ReadonlyArray<Arrangement> => {
      if (run === "open" && (order !== "open" || units === 0)) return [];
      const done = run === "done";
      return [
        {
          order,
          closed: run === "closed",
          blocked,
          units,
          cut: done ? DONE : IDLE,
          polish: done ? DONE : IDLE,
        },
      ];
    }),
  );

/**
 * The arrangements a `taskActions` row stands for that the product can reach, with the task under
 * test: Cut is step 1 and Polish step 2, so Polish waits while Cut is open, and Cut's downstream
 * is Polish. A done task with no downstream start on a done run is Polish. A done run has every
 * task done, so a row's open task on a done run is no state.
 */
const taskArrangements = (
  row: TaskRow,
): ReadonlyArray<{ readonly target: "cut" | "polish"; readonly arrangement: Arrangement }> =>
  statesOf(row).flatMap(({ order, run, blocked }) =>
    TASK_WORDS[row.task].flatMap((task) => {
      if (run === "open" && order !== "open") return [];
      const runDone = run === "done";
      const later = row.downstream === "started";
      const base = { order, closed: run === "closed", blocked, units: 1 };
      const of = (target: "cut" | "polish", cut: Progress, polish: Progress) => {
        if (runDone && !(cut.done && polish.done)) return [];
        return [{ target, arrangement: { ...base, cut, polish } }];
      };
      if (!task.done)
        return task.current
          ? of("cut", { started: task.started, done: false }, IDLE)
          : of("polish", IDLE, IDLE);
      if (later) return of("cut", DONE, { started: true, done: runDone });
      return runDone ? of("polish", DONE, DONE) : of("cut", DONE, IDLE);
    }),
  );

type Answer = { readonly _tag: string };

/** One procedure a cell covers, by who calls it, on a case's run. */
type RunCall = (w: World, run: ShopWork.RunDetail) => Effect.Effect<Answer, unknown>;

const RUN_CALLS: ReadonlyArray<{
  readonly cell: keyof ShopWork.RunActions;
  readonly who: Who;
  readonly call: RunCall;
}> = [
  {
    cell: "note",
    who: "M",
    call: (w, { run }) =>
      w.merchant.client.MerchantSetRunNote(noteInput({ runId: run.id, note: "x" })),
  },
  {
    cell: "note",
    who: "m",
    call: (w, { run }) => w.alice.client.MemberSetRunNote(noteInput({ runId: run.id, note: "x" })),
  },
  {
    cell: "block",
    who: "M",
    call: (w, { run }) =>
      w.merchant.client.MerchantBlockRun(blockInput({ runId: run.id, reason: null })),
  },
  {
    cell: "block",
    who: "m",
    call: (w, { run }) =>
      w.alice.client.MemberBlockRun(blockInput({ runId: run.id, reason: null })),
  },
  {
    cell: "unblock",
    who: "M",
    call: (w, { run }) => w.merchant.client.MerchantUnblockRun(runIdInput({ runId: run.id })),
  },
  {
    cell: "unblock",
    who: "m",
    call: (w, { run }) => w.alice.client.MemberUnblockRun(runIdInput({ runId: run.id })),
  },
  {
    cell: "cancel",
    who: "M",
    call: (w, { run }) => w.merchant.client.MerchantCancelRun(runIdInput({ runId: run.id })),
  },
];

/** The fresh orders a row's cases need: one per arrangement and procedure, Change workflow included. */
const runCases = (row: RunRow) =>
  runArrangements(row).flatMap((arrangement) => [
    ...RUN_CALLS.map((call) => ({ arrangement, call })),
    { arrangement, call: null },
  ]);

/** The order page's other workflow for a Change workflow: Rush, by name. */
const rushOf = (page: ShopWork.OrderPageData) => {
  const rush = [
    ...page.otherWorkflows,
    ...page.matchedWorkflows.map(({ workflow }) => workflow),
  ].find((workflow) => workflow.name === "Rush");
  if (rush === undefined) throw new Error("no Rush");
  return rush.id;
};

/**
 * One `runActions` row: each case on its own order, arranged, then its one procedure, answering
 * `Ok` on a filled cell and `NotAllowed` on a blank one. Change workflow answers with the attach
 * result: `Ok` on a filled cell, replacing the run (reported unless it was closed), and
 * `OrderClosed` or `NothingToMake` on a blank one.
 */
const checkRunRow = (row: RunRow) =>
  Effect.gen(function* () {
    const w = yield* world;
    const cases = runCases(row);
    const numbers = yield* addOrders(
      w.backendUrl,
      cases.map(() => ["engrave"]),
    );
    for (const [index, { arrangement, call }] of cases.entries()) {
      const n = numbers[index] ?? 0;
      const detail = yield* arrange(w, n, arrangement);
      const label = `${call === null ? "changeWorkflow by M" : `${call.cell} by ${call.who}`} on ${JSON.stringify(arrangement)}`;
      if (call === null) {
        const page = yield* orderPage(w, n);
        const attached = yield* w.merchant.client.MerchantAttachWorkflow(
          attachInput({ lineItemId: lineItemIdOf(n), workflowId: rushOf(page) }),
        );
        if (!offered(row.cells.changeWorkflow, "M")) {
          assert.include(["OrderClosed", "NothingToMake"], attached._tag, label);
          continue;
        }
        assert.strictEqual(attached._tag, "Ok", label);
        assert.strictEqual(
          attached._tag === "Ok" && attached.replaced !== null,
          !arrangement.closed,
          label,
        );
        continue;
      }
      const answer = yield* call.call(w, detail);
      assert.strictEqual(
        answer._tag,
        offered(row.cells[call.cell], call.who) ? "Ok" : "NotAllowed",
        label,
      );
    }
    return cases.length;
  }).pipe(Effect.scoped);

/**
 * A row no reachable state stands for: an open run on a line at zero units. The product never
 * leaves one: the write that zeroes the line closes the open run as `item_removed`, so the row's
 * cells are pinned by the unit matrix alone. This proves the state cannot be reached.
 */
const assertUnreachable = (row: RunRow) =>
  Effect.gen(function* () {
    const w = yield* world;
    const [n = 0] = yield* addOrders(w.backendUrl, [["engrave"]]);
    yield* arrange(w, n, {
      order: "open",
      closed: false,
      blocked: row.blocked === "yes",
      units: 1,
      cut: IDLE,
      polish: IDLE,
    });
    yield* changeOrder(w, n, { order: "open", units: 0 }, ["engrave"]);
    const { run } = yield* runOf(w, n);
    assert.deepStrictEqual([run.state, run.closedReason], ["closed", "item_removed"]);
  }).pipe(Effect.scoped);

for (const row of RUN_ROWS)
  test(
    row.title,
    Effect.gen(function* () {
      if (runCases(row).length === 0) return yield* assertUnreachable(row);
      assert.isAbove(yield* checkRunRow(row), 0);
    }),
    SLOW,
  );

/** One procedure a task cell covers, by who calls it, on a task. */
type TaskCall = (w: World, runTaskId: string) => Effect.Effect<Answer, unknown>;

const TASK_CALLS: ReadonlyArray<{
  readonly cell: keyof ShopWork.TaskActions;
  readonly who: Who;
  readonly call: TaskCall;
}> = [
  {
    cell: "start",
    who: "m",
    call: (w, runTaskId) => w.alice.client.MemberStartTask(taskInput({ runTaskId })),
  },
  {
    cell: "done",
    who: "M",
    call: (w, runTaskId) => w.merchant.client.MerchantMarkTaskDone(taskInput({ runTaskId })),
  },
  {
    cell: "done",
    who: "m",
    call: (w, runTaskId) => w.alice.client.MemberMarkTaskDone(taskInput({ runTaskId })),
  },
  {
    cell: "putBack",
    who: "M",
    call: (w, runTaskId) => w.merchant.client.MerchantPutBackTask(taskInput({ runTaskId })),
  },
  {
    cell: "putBack",
    who: "m",
    call: (w, runTaskId) => w.alice.client.MemberPutBackTask(taskInput({ runTaskId })),
  },
  {
    cell: "reopen",
    who: "M",
    call: (w, runTaskId) => w.merchant.client.MerchantReopenTask(taskInput({ runTaskId })),
  },
  {
    cell: "reopen",
    who: "m",
    call: (w, runTaskId) => w.alice.client.MemberReopenTask(taskInput({ runTaskId })),
  },
  {
    cell: "assign",
    who: "M",
    call: (w, runTaskId) =>
      w.merchant.client.MerchantAssignRunTaskTeam(assignInput({ runTaskId, teamId: w.bench })),
  },
];

/**
 * One `taskActions` row: each case on its own order, arranged, then its one procedure on the
 * task under test, answering `Ok` (`Assigned` for Assign team) on a filled cell and `NotAllowed`
 * on a blank one.
 */
const checkTaskRow = (row: TaskRow) =>
  Effect.gen(function* () {
    const w = yield* world;
    const cases = taskArrangements(row).flatMap((arranged) =>
      TASK_CALLS.map((call) => ({ ...arranged, call })),
    );
    const numbers = yield* addOrders(
      w.backendUrl,
      cases.map(() => ["engrave"]),
    );
    for (const [index, { target, arrangement, call }] of cases.entries()) {
      const n = numbers[index] ?? 0;
      const { tasks } = yield* arrange(w, n, arrangement);
      const task = tasks[target === "cut" ? 0 : 1];
      if (task === undefined) return yield* Effect.die(new Error("task"));
      const answer = yield* call.call(w, task.id);
      const filled = call.cell === "assign" ? "Assigned" : "Ok";
      assert.strictEqual(
        answer._tag,
        offered(row.cells[call.cell], call.who) ? filled : "NotAllowed",
        `${call.cell} by ${call.who} on ${target} in ${JSON.stringify(arrangement)}`,
      );
    }
    return cases.length;
  }).pipe(Effect.scoped);

for (const row of TASK_ROWS)
  test(
    row.title,
    Effect.gen(function* () {
      assert.isAbove(yield* checkTaskRow(row), 0);
    }),
    SLOW,
  );

const T = Schema.decodeUnknownSync(ShopWork.TeamId)("t");
const OUTSIDER: ShopWork.Actor = {
  role: "member",
  memberId: Schema.decodeUnknownSync(ShopWork.MemberId)("outsider"),
  email: Schema.decodeUnknownSync(Email)("outsider@run-procedures.test"),
  teamIds: [],
};
const OPEN_ORDER: Orders.OrderState = { cancelledAt: null, fulfillmentStatus: "UNFULFILLED" };

test(
  "a member whose teams hold no task of the run gets nothing, the note included",
  Effect.gen(function* () {
    assert.deepStrictEqual(
      ShopWork.runActions(OUTSIDER, OPEN_ORDER, { state: "open", blockedAt: null }, [
        { teamId: T, current: true },
      ]),
      { note: false, block: false, unblock: false, cancel: false, changeWorkflow: false },
    );
    assert.deepStrictEqual(
      ShopWork.taskActions(
        OUTSIDER,
        OPEN_ORDER,
        { state: "open", blockedAt: null },
        { teamId: T, current: true, startedAt: null, doneAt: null, laterStepStarted: false },
      ),
      { start: false, done: false, putBack: false, reopen: false, assign: false },
    );
    yield* Effect.gen(function* () {
      const w = yield* world;
      const [n = 0] = yield* addOrders(w.backendUrl, [["engrave"]]);
      const { run } = yield* runOf(w, n);
      // Carol is on Idle, which holds no task of the run.
      assert.isNull(yield* w.carol.client.MemberGetRun(runIdInput({ runId: run.id })));
      const noted = yield* w.carol.client.MemberSetRunNote(noteInput({ runId: run.id, note: "x" }));
      assert.strictEqual(noted._tag, "NotAllowed");
      const nobody = yield* openAs(
        w.backendUrl,
        SEED_SHOP,
        memberOf("nobody@run-procedures.test", []),
      );
      assert.isNull(yield* nobody.client.MemberGetRun(runIdInput({ runId: run.id })));
      const unseen = yield* nobody.client.MemberSetRunNote(noteInput({ runId: run.id, note: "x" }));
      assert.strictEqual(unseen._tag, "NotAllowed");
    }).pipe(Effect.scoped);
  }),
);

/**
 * The "v" of `runActions`' table over a socket: Carol is on Idle, which holds Polish, step 2 of a
 * Relay run, while Cut on Bench is current. She sees the run and writes its note, and every other
 * run and task write refuses her, Polish's included while it waits.
 */
test(
  "procedures: a member whose teams hold a task of the run but no current one writes the note and nothing else",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const w = yield* world;
      const [n = 0] = yield* addOrders(w.backendUrl, [["relay"]]);
      const { run, tasks } = yield* runOf(w, n);
      const polish = tasks[1];
      if (polish === undefined) return yield* Effect.die(new Error("task"));
      assert.isNotNull(yield* w.carol.client.MemberGetRun(runIdInput({ runId: run.id })));
      const noted = yield* w.carol.client.MemberSetRunNote(noteInput({ runId: run.id, note: "x" }));
      assert.strictEqual(noted._tag, "Ok");
      const refused = [
        yield* w.carol.client.MemberBlockRun(blockInput({ runId: run.id, reason: null })),
        yield* w.carol.client.MemberStartTask(taskInput({ runTaskId: polish.id })),
        yield* w.carol.client.MemberMarkTaskDone(taskInput({ runTaskId: polish.id })),
      ];
      yield* w.merchant.client
        .MerchantBlockRun(blockInput({ runId: run.id, reason: null }))
        .pipe(Effect.flatMap(ok("block")));
      refused.push(yield* w.carol.client.MemberUnblockRun(runIdInput({ runId: run.id })));
      for (const answer of refused) assert.strictEqual(answer._tag, "NotAllowed");
    }).pipe(Effect.scoped);
  }),
);

test(
  "procedures: a task on no team refuses the member's Done and takes the merchant's",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const w = yield* world;
      const created = yield* w.merchant.client.MerchantCreateTeam({
        name: Schema.decodeUnknownSync(ShopWork.TeamName)("Temp"),
      });
      const temp = yield* addToFixture(w.backendUrl, SEED_SHOP, {
        members: [],
        teams: [],
        workflows: [],
        orders: [],
      }).pipe(Effect.as(created.id));
      const workflow = yield* w.merchant.client.MerchantCreateWorkflow(
        Schema.decodeUnknownSync(ShopWork.CreateWorkflowInput)({ name: "Gone", tag: "gone" }),
      );
      if (workflow._tag !== "Ok") return yield* Effect.die(new Error(workflow._tag));
      const workflowId = workflow.workflow.id;
      yield* w.merchant.client.MerchantAddStep(
        Schema.decodeUnknownSync(ShopWork.AddStepInput)({
          ...(yield* editingAt(w.backendUrl, SEED_SHOP, workflowId)),
          name: "Hold",
          teamId: temp,
        }),
      );
      const on = yield* w.merchant.client.MerchantApplyAndTurnOn(
        yield* editingAt(w.backendUrl, SEED_SHOP, workflowId),
      );
      assert.strictEqual(on._tag, "Ok");
      const [n = 0] = yield* addOrders(w.backendUrl, [["gone"]]);
      const deleted = yield* w.merchant.client.MerchantDeleteTeam({ teamId: temp });
      assert.strictEqual(deleted._tag, "Deleted");
      const { tasks } = yield* runOf(w, n);
      const [task] = tasks;
      if (task === undefined) return yield* Effect.die(new Error("task"));
      assert.isNull(task.teamId);
      // A member with every team id, the deleted one included: still nobody's task.
      const everyTeam = yield* openAs(
        w.backendUrl,
        SEED_SHOP,
        memberOf(ALICE, [w.bench, w.idle, temp]),
      );
      const byMember = yield* everyTeam.client.MemberMarkTaskDone(
        taskInput({ runTaskId: task.id }),
      );
      assert.strictEqual(byMember._tag, "NotAllowed");
      const byMerchant = yield* w.merchant.client.MerchantMarkTaskDone(
        taskInput({ runTaskId: task.id }),
      );
      assert.strictEqual(byMerchant._tag, "Ok");
    }).pipe(Effect.scoped);
  }),
);

test(
  "Undo is offered to the task's whole team, not only to who pressed Done",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const w = yield* world;
      const [n = 0] = yield* addOrders(w.backendUrl, [["engrave"]]);
      // Alice presses Done; Bob, her teammate, undoes it.
      const { tasks } = yield* arrange(w, n, {
        order: "open",
        closed: false,
        blocked: false,
        units: 1,
        cut: DONE,
        polish: IDLE,
      });
      const [cut] = tasks;
      if (cut === undefined) return yield* Effect.die(new Error("task"));
      assert.strictEqual(cut.doneByEmail, ALICE);
      const undone = yield* w.bob.client.MemberReopenTask(taskInput({ runTaskId: cut.id }));
      assert.strictEqual(undone._tag, "Ok");
    }).pipe(Effect.scoped);
  }),
);

/** One page of Ready, every team. */
const READY_LIST = runQuery({ team: null, state: "ready", limit: ShopWork.RUN_PAGE, q: null });

type Received = World["merchant"]["received"];

/** `count` notices on `received`, each naming `ORDERS_KEY`. */
const noticed = (received: Received, count: number) =>
  Effect.gen(function* () {
    for (let n = 0; n < count; n += 1) {
      const notice = yield* PubSub.take(received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual<unknown>(notice.invalidated, [ORDERS_KEY]);
    }
  });

/** Nothing more queued on `received` after a pause long enough for a stray notice to land. */
const nothingMore = (received: Received) =>
  Effect.gen(function* () {
    yield* Effect.sleep("500 millis");
    assert.strictEqual(yield* PubSub.remaining(received), 0, "no more notices");
  });

/** The world with one Solo order: one run, one task on Bench, Ready for Alice and Bob. */
const soloWork = Effect.gen(function* () {
  const w = yield* world;
  const [n = 0] = yield* addOrders(w.backendUrl, [["solo"]]);
  const { run, tasks } = yield* runOf(w, n);
  const [task] = tasks;
  if (task === undefined) return yield* Effect.die(new Error("task"));
  return { w, n, runId: run.id, runTaskId: task.id };
});

test(
  "reads the workflows list for the connection's teams",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w } = yield* soloWork;
      const { items } = yield* w.alice.client.MemberListRuns({ query: READY_LIST });
      assert.lengthOf(items, 1);
      assert.strictEqual(items[0]?.tasks[0]?.teamId, w.bench);
      // The teams come off the connection: Carol's team has no work.
      assert.lengthOf((yield* w.carol.client.MemberListRuns({ query: READY_LIST })).items, 0);
    }).pipe(Effect.scoped);
  }),
);

test(
  "a second read with a different query returns that query's rows",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w } = yield* soloWork;
      const ready = yield* w.alice.client.MemberListRuns({
        query: runQuery({ ...READY_LIST, limit: 1 }),
      });
      assert.lengthOf(ready.items, 1);
      assert.strictEqual(ready.counts.ready, 1);
      const done = yield* w.alice.client.MemberListRuns({
        query: runQuery({ ...READY_LIST, state: "done" }),
      });
      assert.lengthOf(done.items, 0);
      assert.lengthOf(done.recent, 0);
      assert.strictEqual(done.counts.ready, 1);
    }).pipe(Effect.scoped);
  }),
);

test(
  "every connection receives every publish",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w, runTaskId } = yield* soloWork;
      const [other = 0] = yield* addOrders(w.backendUrl, [[]]);
      const index = yield* openAs(w.backendUrl, SEED_SHOP, { role: "merchant" });
      yield* index.client.MerchantListOrders({
        limit: 50,
        cursor: null,
        q: null,
        show: "open",
        team: null,
      });
      const otherOrder = yield* openAs(w.backendUrl, SEED_SHOP, { role: "merchant" });
      yield* otherOrder.client.MerchantGetOrderDetail({ legacyId: legacyIdOf(other) });
      yield* w.bob.client.MemberListRuns({ query: READY_LIST });
      yield* w.carol.client.MemberListRuns({ query: READY_LIST });
      const acting = yield* openAs(w.backendUrl, SEED_SHOP, memberOf(ALICE, [w.bench]));
      yield* acting.client.MemberWhoAmI();
      const screens = [index, otherOrder, acting, w.bob, w.carol];
      // Drain what arranging sent before the screens were watched.
      yield* Effect.sleep("500 millis");
      for (const screen of screens)
        yield* PubSub.takeUpTo(screen.received, Number.MAX_SAFE_INTEGER);

      const done = yield* acting.client.MemberMarkTaskDone(taskInput({ runTaskId }));
      assert.deepStrictEqual(done, { _tag: "Ok" });
      for (const screen of screens) {
        yield* noticed(screen.received, 1);
        yield* nothingMore(screen.received);
      }
    }).pipe(Effect.scoped);
  }),
);

test(
  "completes a member's task over a merchant socket and publishes",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w, runTaskId } = yield* soloWork;
      yield* w.alice.client.MemberListRuns({ query: READY_LIST });
      yield* PubSub.takeUpTo(w.alice.received, Number.MAX_SAFE_INTEGER);
      const done = yield* w.merchant.client.MerchantMarkTaskDone(taskInput({ runTaskId }));
      assert.deepStrictEqual(done, { _tag: "Ok" });
      yield* noticed(w.alice.received, 1);
      assert.lengthOf((yield* w.alice.client.MemberListRuns({ query: READY_LIST })).items, 0);
    }).pipe(Effect.scoped);
  }),
);

test(
  "completes a task over a socket opened with a real member cookie",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w, runTaskId } = yield* soloWork;
      const cookie = yield* signIn(w.backendUrl, email(ALICE));
      // Nothing here names Alice, her team or her id: the gate puts all three on the socket.
      const socket = yield* connectAs(w.backendUrl, SEED_SHOP, { cookie });
      const done = yield* socket.client.MemberMarkTaskDone(taskInput({ runTaskId }));
      assert.deepStrictEqual(done, { _tag: "Ok" });
    }).pipe(Effect.scoped);
  }),
);

/**
 * An integ test, not an e2e spec, because the member's browser project has no merchant socket: the
 * merchant takes Alice off Bench while her socket is open, the actor closes it with 3401, it
 * reconnects through the gate with her new teams, and her open list is empty.
 */
test(
  "removing a member from a team empties their open workflows list",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w } = yield* soloWork;
      const cookie = yield* signIn(w.backendUrl, email(ALICE));
      const socket = yield* connectAs(w.backendUrl, SEED_SHOP, { cookie });
      assert.lengthOf((yield* socket.client.MemberListRuns({ query: READY_LIST })).items, 1);
      const me = yield* socket.client.MemberWhoAmI();
      if (me.role !== "member") return yield* Effect.die(new Error("not a member"));
      yield* w.merchant.client.MerchantSetTeamMember(
        Schema.decodeUnknownSync(SetTeamMemberInput)({
          teamId: w.bench,
          memberId: me.memberId,
          inTeam: false,
        }),
      );
      assert.strictEqual(yield* nextCloseCode(socket.closes), CONNECTION_CLOSE_REVOKED);
      // A read sent while the socket is down fails with the close; the next goes over the
      // reconnect.
      const after = yield* socket.client
        .MemberListRuns({ query: READY_LIST })
        .pipe(Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 25 }));
      assert.lengthOf(after.items, 0);
      assert.strictEqual(after.counts.ready, 0);
    }).pipe(Effect.scoped);
  }),
);

/** Two open screens, drained of notices: the merchant's orders index, and Carol, on a team with no work. */
const twoScreens = (w: World) =>
  Effect.gen(function* () {
    yield* w.merchant.client.MerchantListOrders({
      limit: 50,
      cursor: null,
      q: null,
      show: "open",
      team: null,
    });
    yield* w.carol.client.MemberListRuns({ query: READY_LIST });
    yield* Effect.sleep("500 millis");
    yield* PubSub.takeUpTo(w.merchant.received, Number.MAX_SAFE_INTEGER);
    yield* PubSub.takeUpTo(w.carol.received, Number.MAX_SAFE_INTEGER);
    return [w.merchant.received, w.carol.received] as const;
  });

test(
  "assigning a task's team publishes to every screen",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w, runTaskId } = yield* soloWork;
      const screens = yield* twoScreens(w);
      const assigned = yield* w.merchant.client.MerchantAssignRunTaskTeam(
        assignInput({ runTaskId, teamId: w.idle }),
      );
      assert.deepStrictEqual(assigned, { _tag: "Assigned" });
      for (const received of screens) yield* noticed(received, 1);
    }).pipe(Effect.scoped);
  }),
);

test(
  "Attach workflow publishes to every screen",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w, n } = yield* soloWork;
      const [bare = 0] = yield* addOrders(w.backendUrl, [[]]);
      const page = yield* orderPage(w, n);
      const solo = page.matchedWorkflows.find(({ workflow }) => workflow.name === "Solo");
      if (solo === undefined) return yield* Effect.die(new Error("no Solo"));
      const screens = yield* twoScreens(w);
      const attached = yield* w.merchant.client.MerchantAttachWorkflow(
        attachInput({ lineItemId: lineItemIdOf(bare), workflowId: solo.workflow.id }),
      );
      assert.strictEqual(attached._tag, "Ok");
      for (const received of screens) yield* noticed(received, 1);
    }).pipe(Effect.scoped);
  }),
);

test(
  "Cancel workflow publishes to every screen",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w, runId } = yield* soloWork;
      const screens = yield* twoScreens(w);
      const cancelled = yield* w.merchant.client.MerchantCancelRun(runIdInput({ runId }));
      assert.deepStrictEqual(cancelled, { _tag: "Ok" });
      for (const received of screens) yield* noticed(received, 1);
    }).pipe(Effect.scoped);
  }),
);

/**
 * The run verbs' refusals: a member's and the merchant's Done on a task already done.
 * The positive half first, so a notice that never ran cannot pass; a later write's notice is then
 * the first one queued, because the refusals sent none.
 */
test(
  "a refused call publishes nothing",
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const { w, runId, runTaskId } = yield* soloWork;
      const screens = yield* twoScreens(w);
      const done = yield* w.alice.client.MemberMarkTaskDone(taskInput({ runTaskId }));
      assert.deepStrictEqual(done, { _tag: "Ok" });
      for (const received of screens) yield* noticed(received, 1);

      const again = yield* w.alice.client.MemberMarkTaskDone(taskInput({ runTaskId }));
      assert.deepStrictEqual(again, { _tag: "NotAllowed" });
      const byMerchant = yield* w.merchant.client.MerchantMarkTaskDone(taskInput({ runTaskId }));
      assert.deepStrictEqual(byMerchant, { _tag: "NotAllowed" });
      const noted = yield* w.merchant.client.MerchantSetRunNote(
        noteInput({ runId, note: "later" }),
      );
      assert.deepStrictEqual(noted, { _tag: "Ok" });
      for (const received of screens) {
        yield* noticed(received, 1);
        yield* nothingMore(received);
      }
    }).pipe(Effect.scoped);
  }),
);
