/**
 * The orders index's Show counts as facts per open order, stored in the actor's SQLite and held
 * in memory for the activation. The actor hibernates after seconds idle and loses its memory,
 * so the facts and the record of which orders changed since they were gathered are both stored:
 * a fresh activation loads one row per open order and re-gathers only the changed ones.
 *
 * Triggers on every table the gather reads mark what a write moved, in the writer's own
 * statement, so no writer can forget to and an eviction between a write and the next read loses
 * nothing.
 *
 * @module
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";
import { ShopOrder } from "../../domain/orders.ts";
import type { ShopKey } from "../../domain/platform.ts";
import {
  type OrderCounts,
  type OrderIssue,
  type OrderPosition,
  type OrdersPage,
  orderIssues,
  orderPosition,
  type OrderStanding,
  type RunCounts,
  TeamId,
  type TeamIdName,
} from "../../domain/shop-work.ts";
import { ITEM_MATCHES, openAs, RUN_FOR_ITEM } from "./order-repository.ts";
import type { Transaction } from "./transaction.ts";

/** Failure to decode the stored facts, kept distinct from `SqlError.SqlError`. */
export class OrderFactsError extends Schema.TaggedError<OrderFactsError>()("OrderFactsError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * One open order as the Show counts need it, as the gather stores it: what `orderPosition` and
 * `orderIssues` read, and the two team sets the team filter and `unassigned` test. Nothing here
 * is bound to the D1 teams, so a team created, renamed or deleted in D1 stales no row, and
 * nothing here is derived in TypeScript, so a deploy that changes a rule stales no row either.
 */
export interface OrderFactRow {
  readonly order: OrderStanding;
  readonly runs: RunCounts;
  readonly multiMatchItems: number;
  /**
   * The distinct `teamId`s of the open tasks of the order's open runs, blocked or not, null
   * included: what `OrderRow.unassigned` tests against the live teams.
   */
  readonly taskTeams: ReadonlyArray<TeamId | null>;
  /**
   * The distinct teams of the current tasks of the order's open, unblocked runs: the teams the
   * order waits on, the rule on `ListOrdersInput.team`.
   */
  readonly currentTeams: ReadonlyArray<TeamId>;
}

/** An open order's position: only open orders have facts. */
type OpenPosition = Exclude<OrderPosition, "fulfilled" | "cancelled">;

/**
 * One open order, reduced to what {@link countsOf} reads. Everything that depends on neither the
 * team asked for nor the live teams is decided here, once, through `orderPosition` and
 * `orderIssues`, so no count restates either rule.
 */
export interface OrderFact {
  readonly position: OpenPosition;
  /** `orderIssues` with `unassigned` false: the issues that do not depend on the live teams. */
  readonly issues: ReadonlyArray<Exclude<OrderIssue, "unassigned">>;
  readonly taskTeams: ReadonlyArray<TeamId | null>;
  readonly currentTeams: ReadonlyArray<TeamId>;
}

const isOpenPosition = (position: OrderPosition): position is OpenPosition =>
  position !== "fulfilled" && position !== "cancelled";

/** Reduces a row to its {@link OrderFact}. A row of a closed order is a store defect. */
export const orderFactOf = (orderId: string, row: OrderFactRow): OrderFact => {
  const position = orderPosition(row);
  if (!isOpenPosition(position))
    throw new Error(`OrderFacts.orderFactOf: orderId=${orderId}: a ${position} order`);
  return {
    position,
    issues: orderIssues({ ...row, unassigned: false }).filter(
      (issue): issue is Exclude<OrderIssue, "unassigned"> => issue !== "unassigned",
    ),
    taskTeams: row.taskTeams,
    currentTeams: row.currentTeams,
  };
};

/**
 * `OrdersPage`'s `counts` and `openOrders` for `team` over the open orders' facts, against the
 * live team ids: the orders `team` leaves (`ListOrdersInput.team`), one count per position
 * (`OrderCounts`), and Issues for an order with any `orderIssues` element, `unassigned` being a
 * task team that is null or not live (`OrderRow.unassigned`). Linear in open orders, which
 * `ShopLimits.maxOpenOrders` bounds, so it runs on every read and needs no memo per team.
 */
export const countsOf = (
  facts: Iterable<OrderFact>,
  team: TeamId | null,
  liveTeamIds: ReadonlySet<TeamId>,
): Pick<OrdersPage, "counts" | "openOrders"> => {
  const counts: { -readonly [K in keyof OrderCounts]: number } = {
    no_workflow: 0,
    not_started: 0,
    making: 0,
    made: 0,
    issues: 0,
  };
  let openOrders = 0;
  for (const fact of facts) {
    if (team !== null && !fact.currentTeams.includes(team)) continue;
    openOrders += 1;
    // Unpaid has no strip cell (`OrderCounts`).
    if (fact.position !== "unpaid") counts[fact.position] += 1;
    const unassigned = fact.taskTeams.some((id) => id === null || !liveTeamIds.has(id));
    if (fact.issues.length > 0 || unassigned) counts.issues += 1;
  }
  return { counts, openOrders };
};

/**
 * One open order's {@link OrderFactRow} as one JSON value, over `ShopOrder o`. Every fact is a
 * probe by the order's id, each the rule the page's own reads restate: `runs` is `listOrders`'
 * `runRows`, through `Run_orderId_state_idx`, in `RunCounts` order; `teams` holds the tasks
 * `unassignedRunOf` tests, and the current ones as `teamFilterOf` finds them, by the run's
 * `currentStep`, reading tasks by `runId`; `multiMatchItems` is `multiMatchRows` with the run
 * test first, the same predicate, which spares the workflow probe for every item that already
 * has a run.
 *
 * Correlated scalars rather than grouped joins: on the Durable Object a `group by` over every
 * open order's runs or tasks bills each row it sorts, and a join of grouped results bills the
 * automatic index it builds, which together cost more than the probes. A subquery's JSON loses
 * its JSON type on the way out, so each is wrapped in `json(…)` to nest as an array.
 */
const GATHER = `json_object(
  'order', json_object(
    'cancelledAt', o.cancelledAt,
    'fulfillmentStatus', o.fulfillmentStatus,
    'fullyPaid', o.fullyPaid
  ),
  'runs', json((
    select json_array(
      coalesce(sum(r.state = 'open'), 0),
      coalesce(sum(r.state = 'done'), 0),
      coalesce(sum(r.state = 'open' and r.blockedAt is not null), 0),
      coalesce(sum(r.state = 'open' and r.startedAt is not null), 0)
    )
    from Run r
    where r.orderId = o.id
  )),
  'teams', json((
    select json_array(
      json_group_array(distinct s.teamId),
      json_group_array(distinct s.teamId) filter (
        where r.blockedAt is null and s.teamId is not null and s.step = r.currentStep
      )
    )
    from Run r
    cross join RunTask s on s.runId = r.id
    where r.orderId = o.id and r.state = 'open' and s.doneAt is null
  )),
  'multiMatchItems', (
    select count(*)
    from OrderLineItem li
    where li.orderId = o.id and li.currentQuantity > 0
      and not exists (${RUN_FOR_ITEM})
      and ${ITEM_MATCHES} >= 2
  )
)`;

/**
 * The gather into `OrderFact` from `source`, which names `ShopOrder o`: one statement for a
 * rebuild and a patch, differing only in the drive, so the two cannot disagree on any fact. A
 * row whose facts did not move is not written, which the Durable Object bills as no row.
 */
const gatherFrom = (source: string) => `
  insert into OrderFact (orderId, facts)
  select o.id, ${GATHER}
  from ${source}
  where ${openAs("o")}
  on conflict (orderId) do update set facts = excluded.facts
  where facts is not excluded.facts`;

/** Every open order's facts, walking `ShopOrder_open_idx`. */
export const GATHER_ALL = gatherFrom("ShopOrder o");

/**
 * The marked orders' facts, driven from the marks: `cross join` keeps `OrderFactDirty` outer,
 * so each mark probes `ShopOrder`'s primary key once and no open order is walked.
 */
export const GATHER_MARKED = gatherFrom(
  "OrderFactDirty d cross join ShopOrder o on o.id = d.orderId",
);

/** A stored fact whose order is not open: closed, swept or removed since it was gathered. */
const NOT_OPEN = `not exists (
  select 1 from ShopOrder o where o.id = OrderFact.orderId and ${openAs("o")}
)`;

/**
 * Whether no whole-shop rebuild is owed: while one is, a mark would be retired unread, so the
 * triggers skip it.
 */
const NOT_STALE = `(select shopStale from OrderFactState where id = 1) = 0`;

/** Marks the order `orderId` (an SQL expression), stored facts or not: a new or reopened order has none. */
const markOrder = (orderId: string) => `
  insert into OrderFactDirty (orderId)
  select ${orderId} where ${NOT_STALE}
  on conflict (orderId) do nothing;`;

/**
 * Marks the order `orderId` (an SQL expression) only if it has stored facts: a closed order has
 * none, so the churn of its items and runs (the sweep, reconcile's closes) marks nothing.
 */
const markFacts = (orderId: string) => `
  insert into OrderFactDirty (orderId)
  select f.orderId from OrderFact f where f.orderId = ${orderId} and ${NOT_STALE}
  on conflict (orderId) do nothing;`;

/** Owes a whole-shop rebuild; once owed, writes nothing more. */
const OWE_REBUILD = `update OrderFactState set shopStale = 1 where id = 1 and shopStale = 0;`;

type Row = "new" | "old";

/**
 * A table {@link GATHER} reads, as its triggers mark it. `columns` is every column the gather
 * reads but the primary key, which no writer updates; an update marks only when one of them
 * moved, because SQLite fires `update of` for a column the statement sets, moved or not, and
 * `upsertOrder` and reconcile rewrite rows unchanged. `reads` is whether a row is one the gather
 * can see at all; `mark` is the statement that marks it.
 */
interface FactSource {
  readonly table: "ShopOrder" | "OrderLineItem" | "Run" | "RunTask" | "Workflow";
  readonly columns: ReadonlyArray<string>;
  readonly reads?: (row: Row) => string;
  readonly mark: (row: Row) => string;
}

/**
 * Every table and column {@link GATHER} reads. A column added to the gather without one here
 * goes stale silently, which the runs service's test "patched facts count what a fresh
 * activation and a rebuild count" exists to catch.
 *
 * A `RunTask` deleted by its run's cascade finds no `Run` row to name its order, and marks
 * nothing, which is right: the run's own delete marked it. A workflow edit can move any order's
 * `multiMatchItems`, so it owes a rebuild rather than a mark per order.
 */
const FACT_SOURCES: ReadonlyArray<FactSource> = [
  {
    table: "ShopOrder",
    columns: ["fulfillmentStatus", "cancelledAt", "fullyPaid"],
    reads: openAs,
    mark: (row) => markOrder(`${row}.id`),
  },
  {
    table: "OrderLineItem",
    columns: ["orderId", "currentQuantity", "productTags"],
    mark: (row) => markFacts(`${row}.orderId`),
  },
  {
    table: "Run",
    columns: ["orderId", "lineItemId", "state", "startedAt", "blockedAt", "currentStep"],
    mark: (row) => markFacts(`${row}.orderId`),
  },
  {
    table: "RunTask",
    columns: ["runId", "step", "teamId", "doneAt"],
    mark: (row) => markFacts(`(select r.orderId from Run r where r.id = ${row}.runId)`),
  },
  {
    table: "Workflow",
    columns: ["state", "tag", "tasks"],
    reads: (row) => `${row}.state = 'active'`,
    mark: () => OWE_REBUILD,
  },
];

/** A source's three triggers: insert, delete, and an update that moved a column it reads. */
const triggersOf = ({ table, columns, reads, mark }: FactSource) => {
  const when = (row: Row) => (reads === undefined ? "" : `when ${reads(row)}`);
  const moved = columns.map((column) => `old.${column} is not new.${column}`).join(" or ");
  const seen = reads === undefined ? "" : `(${reads("old")} or ${reads("new")}) and `;
  const marks = mark("old") === mark("new") ? mark("new") : mark("old") + mark("new");
  return [
    `create trigger OrderFact_${table}_insert after insert on ${table} ${when("new")}
      begin ${mark("new")} end`,
    `create trigger OrderFact_${table}_delete after delete on ${table} ${when("old")}
      begin ${mark("old")} end`,
    `create trigger OrderFact_${table}_update after update of ${columns.join(", ")} on ${table}
      when ${seen}(${moved})
      begin ${marks} end`,
  ];
};

/** The marking triggers' DDL, one statement each. */
const TRIGGERS = FACT_SOURCES.flatMap(triggersOf);

/**
 * What the stored facts were gathered and marked by: the gather statements' text and the
 * triggers' DDL. A deploy that changes either changes it, and the next activation recreates the
 * triggers and rebuilds; a deploy that changes only TypeScript rules changes nothing stored,
 * because {@link orderFactOf} reduces each row on load. No number to bump, so none to forget.
 */
const VERSION = [GATHER_ALL, GATHER_MARKED, ...TRIGGERS].join(";\n");

/**
 * The marked orders past which one rebuild reads fewer rows than the patch: a warm rebuild's
 * rows over one marked order's, from the rows-read probe (`vp run probe:rows-read`), where 2,452
 * open orders rebuilt in 62,070 rows and a patch of 50 read 1,502. Both write only the facts
 * that moved, so rows read decide. Below `ShopLimits.maxOpenOrders`, so it can fire.
 */
const PATCH_LIMIT = 2066;

/** What a settle reads; also the log line's `read=`. */
export type SettlePlan =
  | { readonly _tag: "Hit" }
  | { readonly _tag: "Load" }
  | { readonly _tag: "Patch"; readonly marked: number }
  | { readonly _tag: "Rebuild"; readonly reason: "stale" | "many" };

/** A stored order's facts, by its id. */
interface StoredFact {
  readonly orderId: string;
  readonly fact: OrderFactRow;
}

/** What a settle hands the in-memory copy: every stored row, or each marked order's row or none. */
type Installed =
  | { readonly _tag: "All"; readonly rows: ReadonlyArray<StoredFact> }
  | {
      readonly _tag: "Marked";
      readonly rows: ReadonlyArray<{
        readonly orderId: string;
        readonly fact: OrderFactRow | null;
      }>;
    };

/** `OrderFact.facts` as {@link GATHER} writes it: `runs` and `teams` positional, as the SQL builds them. */
const FactsColumn = Schema.fromJsonString(
  Schema.Struct({
    order: Schema.Struct({
      cancelledAt: ShopOrder.fields.cancelledAt,
      fulfillmentStatus: ShopOrder.fields.fulfillmentStatus,
      fullyPaid: ShopOrder.fields.fullyPaid,
    }),
    runs: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number, Schema.Number]),
    teams: Schema.Tuple([Schema.Array(Schema.NullOr(TeamId)), Schema.Array(TeamId)]),
    multiMatchItems: Schema.Number,
  }),
);

const rowOf = ({
  order,
  runs: [open, done, blocked, started],
  teams: [taskTeams, currentTeams],
  multiMatchItems,
}: typeof FactsColumn.Type): OrderFactRow => ({
  order,
  runs: { open, done, blocked, started },
  multiMatchItems,
  taskTeams,
  currentTeams,
});

const decodeAll = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ orderId: Schema.String, facts: FactsColumn })),
);
const decodeMarked = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ orderId: Schema.String, facts: Schema.NullOr(FactsColumn) })),
);
const decodeState = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ shopStale: Schema.Number, marked: Schema.Number })]),
);
const decodeVersion = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ version: Schema.NullOr(Schema.String) })]),
);
const decodeNames = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String })),
);

const factsError = (message: string) => (cause: unknown) => new OrderFactsError({ message, cause });

/**
 * The stored facts over the actor's `sql`, built once per activation: `OrderFact` (one row per
 * open order), `OrderFactDirty` (the orders marked since) and `OrderFactState` (whether a
 * whole-shop rebuild is owed, and the {@link VERSION} the triggers were made by), all in the
 * actor's `migrations`. The triggers are not: they follow the code, so `install` makes them.
 */
export const makeOrderFactStore = (sql: SqlClient.SqlClient, transaction: Transaction) => {
  const loadAll = Effect.gen(function* () {
    const rows = yield* sql`select orderId, facts from OrderFact`.pipe(
      Effect.flatMap(decodeAll),
      Effect.mapError(factsError("Invalid OrderFact row")),
    );
    return {
      _tag: "All",
      rows: rows.map(({ orderId, facts }) => ({ orderId, fact: rowOf(facts) })),
    } satisfies Installed;
  });

  /** Each marked order's stored row, null for one that is no longer open. */
  const loadMarked = Effect.gen(function* () {
    const rows = yield* sql`
      select d.orderId, f.facts
      from OrderFactDirty d
      left join OrderFact f on f.orderId = d.orderId
    `.pipe(Effect.flatMap(decodeMarked), Effect.mapError(factsError("Invalid OrderFact row")));
    return {
      _tag: "Marked",
      rows: rows.map(({ orderId, facts }) => ({
        orderId,
        fact: facts === null ? null : rowOf(facts),
      })),
    } satisfies Installed;
  });

  /**
   * Makes the triggers this code marks with, once per activation: when the stored version is not
   * {@link VERSION}, drops every `OrderFact_` trigger, creates {@link TRIGGERS} and owes a
   * rebuild, which covers whatever the old triggers missed. Answers whether it did.
   */
  const install = transaction(
    Effect.gen(function* () {
      const [{ version }] = yield* sql`select version from OrderFactState where id = 1`.pipe(
        Effect.flatMap(decodeVersion),
        Effect.mapError(factsError("OrderFactState row is missing")),
      );
      if (version === VERSION) return false;
      const made = yield* sql`
        select name from sqlite_master where type = 'trigger' and name glob 'OrderFact_*'
      `.pipe(Effect.flatMap(decodeNames), Effect.mapError(factsError("Invalid trigger row")));
      for (const { name } of made) yield* sql`drop trigger ${sql(name)}`;
      for (const ddl of TRIGGERS) yield* sql.unsafe(ddl);
      yield* sql`update OrderFactState set version = ${VERSION}, shopStale = 1 where id = 1`;
      return true;
    }),
  );

  /**
   * Brings `OrderFact` up to every mark and answers what the in-memory copy installs: all rows
   * when `warm` is false or after a rebuild, the marked orders' rows on a warm patch, nothing on
   * a hit. One transaction, so no statement of another fiber lands between reading the marks and
   * retiring them: the `@effect/sql-sqlite-do` client runs a transaction and every statement
   * outside one under the same one-permit semaphore (`makeStorageBackedWithTransaction` in its
   * `SqliteClient`). A failure retires nothing.
   */
  const settle = (warm: boolean) =>
    transaction(
      Effect.gen(function* () {
        const [state] = yield* sql`
          select shopStale, (select count(*) from OrderFactDirty) as marked
          from OrderFactState where id = 1
        `.pipe(
          Effect.flatMap(decodeState),
          Effect.mapError(factsError("OrderFactState row is missing")),
        );
        const plan: SettlePlan =
          state.shopStale === 1
            ? { _tag: "Rebuild", reason: "stale" }
            : state.marked > PATCH_LIMIT
              ? { _tag: "Rebuild", reason: "many" }
              : state.marked > 0
                ? { _tag: "Patch", marked: state.marked }
                : warm
                  ? { _tag: "Hit" }
                  : { _tag: "Load" };
        const installed: Installed | null = yield* Match.valueTags(plan, {
          Hit: () => Effect.succeed(null),
          Load: () => loadAll,
          Rebuild: () =>
            Effect.gen(function* () {
              yield* sql.unsafe(GATHER_ALL);
              yield* sql`delete from OrderFact where ${sql.literal(NOT_OPEN)}`;
              yield* sql`delete from OrderFactDirty`;
              yield* sql`update OrderFactState set shopStale = 0 where id = 1`;
              return yield* loadAll;
            }),
          Patch: () =>
            Effect.gen(function* () {
              yield* sql.unsafe(GATHER_MARKED);
              yield* sql`
                delete from OrderFact
                where orderId in (select orderId from OrderFactDirty)
                  and ${sql.literal(NOT_OPEN)}
              `;
              const rows = warm ? yield* loadMarked : yield* loadAll;
              yield* sql`delete from OrderFactDirty`;
              return rows;
            }),
        });
        return { plan, installed };
      }),
    );

  /**
   * Owes a whole-shop rebuild, for a writer about to replace more orders than a patch is worth
   * (`loadFixture`): the triggers mark either way, and once a rebuild is owed they write nothing.
   */
  const oweRebuild = sql.unsafe(OWE_REBUILD);

  return { install, settle, oweRebuild };
};

/** The actor's stored facts; see {@link makeOrderFactStore}. */
export type OrderFactStore = ReturnType<typeof makeOrderFactStore>;

/**
 * Whether each counts read logs at info rather than debug: the `ORDER_FACTS_LOG` binding is
 * present, which only staging binds. How often a read loads the stored facts in a fresh
 * activation against how often it patches or hits a warm one is what the stored facts trade on.
 */
const settleLogOn = Config.option(Config.String("ORDER_FACTS_LOG")).pipe(
  Effect.map(Option.isSome),
  Effect.orDie,
);

/**
 * The orders index's Show counts for the activation, shared by every tab and every team: the
 * stored facts ({@link makeOrderFactStore}), with the triggers installed first, and their
 * in-memory copy, so a warm read with nothing marked reads only the marks' count. Built once
 * per activation by the runs service (`makeRuns`).
 *
 * Never inside a `transaction(…)`: `counts` opens its own.
 */
export const makeOrderFacts = Effect.fnUntraced(function* ({
  store,
  shop,
}: {
  readonly store: OrderFactStore;
  readonly shop: ShopKey;
}) {
  if (yield* store.install.pipe(Effect.orDie))
    yield* Effect.logInfo(`OrderFacts.install: shop=${shop}: triggers made, rebuild owed`).pipe(
      Effect.annotateLogs({ shop }),
    );
  /** The stored facts as of this activation's last settle; null until the first. */
  let facts: Map<string, OrderFact> | null = null;
  /**
   * One settle and its install at a time: a second reader waits for the first's install, so it
   * never answers a hit from a copy the first has not patched yet.
   */
  const settling = yield* Semaphore.make(1);
  const logSettle = (yield* settleLogOn) ? Effect.logInfo : Effect.logDebug;

  const settle = Effect.gen(function* () {
    const { plan, installed } = yield* store.settle(facts !== null);
    // No yield from here to the return: the install is one step.
    if (installed !== null)
      Match.valueTags(installed, {
        All: ({ rows }) => {
          facts = new Map(rows.map(({ orderId, fact }) => [orderId, orderFactOf(orderId, fact)]));
        },
        Marked: ({ rows }) => {
          const next = facts ?? new Map<string, OrderFact>();
          for (const { orderId, fact } of rows)
            if (fact === null) next.delete(orderId);
            else next.set(orderId, orderFactOf(orderId, fact));
          facts = next;
        },
      });
    return plan;
  }).pipe(Semaphore.withPermit(settling));

  /**
   * The Show counts for `team`, against `teams`, the live D1 teams the caller read for the same
   * request. Settles first, then derives ({@link countsOf}).
   */
  const counts = Effect.fn("OrderFacts.counts")(function* ({
    team,
    teams,
  }: {
    readonly team: TeamId | null;
    readonly teams: ReadonlyArray<TeamIdName>;
  }) {
    const plan = yield* settle;
    const read = Match.valueTags(plan, {
      Hit: () => "read=hit",
      Load: () => "read=load",
      Patch: ({ marked }) => `read=patch orders=${String(marked)}`,
      Rebuild: ({ reason }) => `read=rebuild reason=${reason}`,
    });
    yield* logSettle(`OrderFacts.counts: shop=${shop} ${read}`).pipe(
      Effect.annotateLogs({ shop, read: plan._tag }),
    );
    return countsOf(facts?.values() ?? [], team, new Set(teams.map(({ id }) => id)));
  });

  return { counts };
});

/** The runs service's order facts; see {@link makeOrderFacts}. */
export type OrderFacts = Effect.Success<ReturnType<typeof makeOrderFacts>>;
