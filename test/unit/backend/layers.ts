import { Memory } from "@alchemy.run/better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin, magicLink } from "better-auth/plugins";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import type { Email } from "../../../src/contract/auth.ts";
import type { ShopKey } from "../../../src/contract/shop.ts";
import { ShopifyAdmin, type ShopifyAdminError } from "../../../src/backend/shopify-admin.ts";
import type { OrdersSyncParams } from "../../../src/backend/orders-sync-workflow.ts";
import type { OrdersSyncWorkflows } from "../../../src/backend/shop-actor/orders.ts";
import { settleDestroy, ShopActors } from "../../../src/backend/shop-actors.ts";
import { migrations } from "../../../src/backend/shop-actor.ts";
import { syncTransaction } from "../../../src/backend/shop-actor/transaction.ts";
import { makeOrderRepository } from "../../../src/backend/shop-actor/order-repository.ts";
import { makeOrders } from "../../../src/backend/shop-actor/orders.ts";
import { Auth } from "../../../src/backend/auth.ts";
import { MagicLinkDelivery } from "../../../src/backend/magic-link-delivery.ts";
import { Mailer } from "../../../src/backend/mailer.ts";
import { MembershipRepository } from "../../../src/backend/membership-repository.ts";
import {
  ShopSessionRepository,
  type ShopSessionRow,
} from "../../../src/backend/shop-session-repository.ts";
import { SHOPIFY_API_KEY, SHOPIFY_API_SECRET_FAKE, Shopify } from "../../../src/backend/shopify.ts";
import type { PlanStatus } from "../../../src/domain/billing.ts";
import { ShopifyPartner } from "../../../src/backend/shopify-partner.ts";
import { SubscriptionPlan } from "../../../src/backend/subscription-plan.ts";

/**
 * A `reconciler` for `makeOrders` that reconciles nothing: what a test of the orders service
 * passes when runs are not what it is about.
 */
export const noReconciler = Effect.succeed(() =>
  Effect.succeed({ created: 0, resized: 0, closed: 0, multiMatch: 0 }),
);

/** The `AUTH_ORIGIN` the test Backend's Better Auth runs under, so links resolve against it. */
export const TEST_ORIGIN = "http://test.local";

/**
 * The test app's API key and secret, which {@link testShopify} verifies tokens against: the fake
 * app's, so `mintSessionToken`'s defaults sign for it.
 */
export const TEST_SHOPIFY_APP = {
  apiKey: SHOPIFY_API_KEY,
  apiSecret: SHOPIFY_API_SECRET_FAKE,
} as const;

/**
 * {@link Shopify} over {@link TEST_SHOPIFY_APP} and an in-memory {@link ShopSessionRepository} holding
 * `rows`, which stays in the context so a test can read what an exchange wrote.
 */
export const testShopify = (rows: ReadonlyArray<ShopSessionRow> = []) =>
  Shopify.layerWith({
    apiKey: TEST_SHOPIFY_APP.apiKey,
    apiSecret: Redacted.make(TEST_SHOPIFY_APP.apiSecret),
    appUrl: "http://localhost",
  }).pipe(Layer.provideMerge(ShopSessionRepository.layerTest(rows)));

/** A value as D1 binds it: `undefined` is null and a boolean 1 or 0, which `node:sqlite` refuses. */
const d1Value = (value: unknown) =>
  value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value;

const d1Meta = (changes = 0, lastRowId = 0): D1Meta & Record<string, unknown> => ({
  duration: 0,
  size_after: 0,
  rows_read: 0,
  rows_written: changes,
  last_row_id: lastRowId,
  changed_db: changes > 0,
  changes,
});

/**
 * One D1 prepared statement over `node:sqlite`. `bind` answers a new statement, as D1's does:
 * `D1Client` caches a prepared statement and binds it afresh per call.
 */
const d1Statement = (db: DatabaseSync, query: string, values: ReadonlyArray<unknown> = []) => {
  const prepared = () => db.prepare(query);
  const params = values.map(d1Value) as Array<SQLInputValue>;
  const rows = () =>
    prepared()
      .all(...params)
      .map((row) => ({ ...row }));
  const statement = {
    bind: (...next: Array<unknown>) => d1Statement(db, query, next),
    first: async (column?: string) => {
      const row = prepared().get(...params);
      if (row === undefined) return null;
      return column === undefined ? { ...row } : row[column];
    },
    run: async () => {
      const result = prepared().run(...params);
      return {
        success: true as const,
        meta: d1Meta(Number(result.changes), Number(result.lastInsertRowid)),
        results: [],
      };
    },
    all: async () => ({ success: true as const, meta: d1Meta(), results: rows() }),
    allSync: () => ({ success: true as const, meta: d1Meta(), results: rows() }),
    raw: async (options?: { columnNames?: boolean }) => {
      const sync = prepared();
      sync.setReturnArrays(true);
      const arrays = sync.all(...params) as unknown as Array<Array<unknown>>;
      return options?.columnNames === true
        ? [sync.columns().map((column) => column.name), ...arrays]
        : arrays;
    },
  };
  return statement;
};

type D1TestStatement = ReturnType<typeof d1Statement>;

/**
 * A `D1Database` over one `node:sqlite` database, as `D1Client` drives it: `prepare`, `bind`,
 * `all`, `raw`, `run`, `first`, and `batch` in one transaction that rolls back whole on a
 * failure, as D1's implicit batch transaction does.
 */
const d1Database = (db: DatabaseSync) => ({
  prepare: (query: string) => d1Statement(db, query),
  batch: async (statements: ReadonlyArray<D1TestStatement>) => {
    db.exec("begin");
    try {
      const results = statements.map((statement) => statement.allSync());
      db.exec("commit");
      return results;
    } catch (cause) {
      db.exec("rollback");
      throw cause;
    }
  },
  exec: async (query: string) => {
    db.exec(query);
    return { count: 0, duration: 0 };
  },
  withSession: () => {
    throw new Error("D1Test: sessions are not supported");
  },
  dump: () => {
    throw new Error("D1Test: dump is not supported");
  },
});

/**
 * Better Auth's options as far as its tables go: the plugins the Backend's `Auth` runs with,
 * which add columns (the admin plugin's role and ban fields) but no table.
 */
const betterAuthTableOptions = {
  plugins: [admin(), magicLink({ sendMagicLink: async () => {} })],
};

/**
 * Baton's D1 in memory, fresh per call: `node:sqlite` with foreign keys on (D1 has them on by
 * default), migrated by `migrations/0001_init.sql` and by Better Auth's own migration for its
 * tables, as `@alchemy.run/better-auth` creates them at deploy. `raw` is the `D1Database` the
 * Backend's D1 services take in their `layerWith`, so the real SQL runs over it; `db` is the same
 * database, for a test's raw SQL.
 */
export const makeD1Test = Effect.promise(async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(new URL("../../../migrations/0001_init.sql", import.meta.url), "utf8"));
  const migrations = await getMigrations({
    ...betterAuthTableOptions,
    database: db,
    secret: "d1-test-secret-d1-test-secret-d1-test",
    telemetry: { enabled: false },
  });
  await migrations.runMigrations();
  return { db, raw: d1Database(db) as unknown as D1Database };
});

/** A `Member` row as a test seeds it: plain ids, the shop as the Backend holds it. */
export interface MemberRow {
  readonly id: string;
  readonly shop: ShopKey;
  readonly email: Email;
  readonly createdAt: number;
}

/**
 * Inserts a `ShopSession` row for each of `shops` (a bare one: `Member.shop` and `Team.shop`
 * reference it) and the `members`, in {@link makeD1Test}'s database.
 */
export const seedD1 = (
  db: DatabaseSync,
  { shops, members = [] }: { shops: ReadonlyArray<ShopKey>; members?: ReadonlyArray<MemberRow> },
) => {
  const insertShop = db.prepare(
    "insert or ignore into ShopSession (shop, shopGid, shopActorId) values (?, ?, ?)",
  );
  for (const shop of new Set([...shops, ...members.map((member) => member.shop)]))
    insertShop.run(shop, "gid://shopify/Shop/1", shop);
  const insertMember = db.prepare(
    "insert into Member (id, shop, email, createdAt) values (?, ?, ?, ?)",
  );
  for (const member of members)
    insertMember.run(member.id, member.shop, member.email, member.createdAt);
};

/**
 * The real {@link MembershipRepository} over a fresh {@link makeD1Test} database seeded with `members` and a
 * `ShopSession` row for each of their shops and of `shops`.
 */
export const testMembershipRepository = (
  members: ReadonlyArray<MemberRow>,
  shops: ReadonlyArray<ShopKey> = [],
) =>
  Layer.unwrap(
    Effect.map(makeD1Test, ({ db, raw }) => {
      seedD1(db, { shops, members });
      return MembershipRepository.layerWith(raw);
    }),
  );

/** Drops `Info` and below, so only a warning or error reaches the test output. */
export const QuietLogs = Layer.succeed(References.MinimumLogLevel, "Warn");

/**
 * {@link Auth} over Better Auth on an in-memory database, fresh per test, with the services
 * every Backend test needs: {@link MembershipRepository}, the given {@link ShopActors} fake, and the stage's
 * {@link MagicLinkDelivery} over {@link Mailer.layerTest}. `extra` adds what only one test
 * needs, such as `ShopAccess`. Alchemy's runtime marker is left to the caller: a test that calls
 * Worker methods directly needs it in its context (`provideMerge`), the others only feed it.
 */
export const testAuth = <A, E, R>({
  members,
  membershipRepositoryLayer = testMembershipRepository(members),
  actors,
  delivery,
  extra,
}: {
  members: ReadonlyArray<MemberRow>;
  /** {@link MembershipRepository} itself, when a test wraps it; by default {@link testMembershipRepository} of `members`. */
  membershipRepositoryLayer?: Layer.Layer<MembershipRepository>;
  actors: Layer.Layer<ShopActors>;
  delivery: "inline" | "mailed";
  extra: Layer.Layer<A, E, R>;
}) =>
  Auth.layerWith({ secret: "test-secret-test-secret-test-secret" }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        membershipRepositoryLayer,
        actors,
        extra,
        (delivery === "inline"
          ? MagicLinkDelivery.layerInline
          : MagicLinkDelivery.layerMailed
        ).pipe(Layer.provideMerge(Mailer.layerTest)),
      ),
    ),
    Layer.provide(Memory()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTH_ORIGIN: TEST_ORIGIN }))),
  );

/**
 * The shop actor's SQLite in memory, migrated by the actor's own `migrations`, fresh per
 * provide: `node:sqlite` through `@effect/sql-sqlite-node`, which runs one statement per `sql`
 * call, as `migrations` is written for.
 */
export const ActorSqliteTest = Layer.effectDiscard(
  SqliteMigrator.run({ loader: migrations }).pipe(Effect.orDie),
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })), Layer.orDie);

/**
 * The actor's orders repository over {@link ActorSqliteTest}'s client and the actor's own
 * `syncTransaction`, which runs unchanged under Node.
 */
export const testOrderRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return makeOrderRepository(sql, syncTransaction(sql));
});

/** One Admin call {@link testShopifyAdmin} served. */
export interface AdminCall {
  readonly shop: ShopKey;
  readonly query: string;
  readonly variables: Record<string, unknown> | undefined;
}

/**
 * {@link ShopifyAdmin} answering each call with the next of `replies` (the GraphQL `data`, or a
 * failure), recording it in `calls`. A call past the last reply is a defect, so a test that
 * expects no Admin call passes none.
 */
export const testShopifyAdmin = (
  replies: Array<Effect.Effect<unknown, ShopifyAdminError>>,
  calls: Array<AdminCall>,
) => {
  const graphql = (
    shop: ShopKey,
    query: string,
    options?: { readonly variables?: Record<string, unknown> | undefined },
  ) =>
    Effect.suspend(() => {
      calls.push({ shop, query, variables: options?.variables });
      return replies.shift() ?? Effect.die(new Error("testShopifyAdmin: unscripted call"));
    });
  return Layer.succeed(ShopifyAdmin, {
    graphql: (shop, query, options) =>
      Effect.map(graphql(shop, query, options), (data) => ({ data })),
    graphqlDecode: (shop, schema, query, options) =>
      Effect.flatMap(graphql(shop, query, options), (data) =>
        Schema.decodeUnknownEffect(schema)(data).pipe(Effect.orDie),
      ),
  });
};

/** The calls {@link testOrderActors} recorded. */
export interface OrderActorCalls {
  readonly webhooks: Array<{
    readonly key: ShopKey;
    readonly orderId: string;
    readonly topic: string;
    readonly updatedAt: number | null;
  }>;
  /** Each notice the actor's orders sent, with its keys. */
  readonly notices: Array<ReadonlyArray<string>>;
  /** Each destroy, with whether the shop still had a `ShopSession` row when it ran. */
  readonly destroyed: Array<{ readonly key: ShopKey; readonly hadSession: boolean }>;
}

/**
 * `ShopActors.layerTest` whose `syncOrderWebhook` runs the actor's own `Orders` for the
 * shop, over the `SqlClient` in context (the actor's schema, {@link ActorSqliteTest}) and the
 * `ShopifyAdmin` in context, recording each delivery and each notice, and whose `destroy` reads
 * `stub` as the actor's answer through the real {@link settleDestroy}, each recorded in `calls`.
 */
export const testOrderActors = (calls: OrderActorCalls, stub: Effect.Effect<void> = Effect.void) =>
  Layer.effect(
    ShopActors,
    Effect.gen(function* () {
      const base = yield* ShopActors;
      const sessions = yield* ShopSessionRepository;
      const admin = yield* ShopifyAdmin;
      const sql = yield* SqlClient.SqlClient;
      const repository = makeOrderRepository(sql, syncTransaction(sql));
      const notify = (invalidated: ReadonlyArray<string>) =>
        Effect.sync(() => {
          calls.notices.push(invalidated);
        });
      return {
        ...base,
        syncOrderWebhook: (key, input) =>
          Effect.suspend(() => {
            calls.webhooks.push({ key, ...input });
            return makeOrders({
              repository,
              transaction: syncTransaction(sql),
              admin,
              ordersSync: testOrdersSyncWorkflows(),
              notify,
              reconciler: noReconciler,
              flushUsage: Effect.void,
              shop: key,
            })
              .syncOrderWebhook(input)
              .pipe(Effect.orDie);
          }),
        destroy: (key) =>
          Effect.gen(function* () {
            const hadSession = Option.isSome(yield* sessions.find(key));
            calls.destroyed.push({ key, hadSession });
            yield* settleDestroy(key, stub);
          }),
      };
    }),
  ).pipe(Layer.provide(ShopActors.layerTest([])));

/**
 * The actor's {@link OrdersSyncWorkflows} handle, recording each instance it is asked to create
 * in `created`, then answering `create`'s outcome (by default, created).
 */
export const testOrdersSyncWorkflows = (
  created: Array<{ readonly id: string; readonly params: OrdersSyncParams }> = [],
  create: Effect.Effect<void> = Effect.void,
): OrdersSyncWorkflows => ({
  create: (options) =>
    Effect.suspend(() => {
      created.push(options);
      return create;
    }),
});

/** The pricing page's URL {@link testPlan}'s Partner client names: Baton Dev's handle. */
export const testPlanSelectionUrl = (shop: ShopKey) =>
  `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/u, "")}/charges/baton-local/pricing_plans`;

/**
 * {@link SubscriptionPlan} answering every shop `status` (by default `baton-pro`, no boundary),
 * and a {@link ShopifyPartner} that names the pricing page and dies on a Partner call: for the
 * tests that do not exercise the plan itself.
 */
export const testPlan = (
  status: PlanStatus = { _tag: "Subscribed", handle: "baton-pro", plan: "pro", boundaryAt: null },
) =>
  Layer.mergeAll(
    SubscriptionPlan.layerTest(status),
    Layer.succeed(ShopifyPartner, {
      activeSubscription: () => Effect.die(new Error("testPlan: no Partner call")),
      planSelectionUrl: testPlanSelectionUrl,
    }),
  );
