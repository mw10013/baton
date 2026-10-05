import { SqliteClient } from "@effect/sql-sqlite-do";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { OrderRepository } from "@/lib/OrderRepository";
import { RunRepository } from "@/lib/RunRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

import { withMaxOpenOrders } from "./open-order-ceiling.ts";

/** One statement the object's SQLite ran: its text, its parameters and its cursor. */
export interface Executed {
  readonly query: string;
  readonly params: readonly unknown[];
  readonly cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
}

/** `target[key]`, a method bound to `target` so a native getter or method keeps its receiver. */
const bound = (target: object, key: PropertyKey): unknown => {
  const value: unknown = Reflect.get(target, key);
  return typeof value === "function" ? (value.bind(target) as unknown) : value;
};

/**
 * `storage` with `sql.exec` wrapped so every statement is recorded. The
 * cursor is kept, not its count at the time of the call: `rowsRead` grows as
 * the cursor is consumed, and the client consumes it whole before the effect
 * returns, so a read summed after the effect is the billed number
 * (`SqlStorageCursor.rowsRead`, which Cloudflare bills SQL reads by:
 * `refs/cloudflare-docs/src/content/docs/durable-objects/api/sqlite-storage-api.mdx`).
 */
export const countingStorage = (storage: DurableObjectStorage) => {
  const captured: Executed[] = [];
  const sql = new Proxy(storage.sql, {
    get: (target, key) =>
      key === "exec"
        ? (query: string, ...params: unknown[]): unknown => {
            const cursor = target.exec(query, ...params);
            captured.push({ query, params, cursor });
            return cursor;
          }
        : bound(target, key),
  });
  return {
    storage: new Proxy(storage, {
      get: (target, key) => (key === "sql" ? sql : bound(target, key)),
    }),
    captured: captured as readonly Executed[],
  };
};

/** Rows read by every statement recorded at or after index `from`. */
export const rowsReadSince = (captured: readonly Executed[], from: number) =>
  captured.slice(from).reduce((rows, { cursor }) => rows + cursor.rowsRead, 0);

/**
 * `explain query plan` of a recorded statement with its recorded parameters,
 * as the plan's `detail` lines. Run without `analyze`, as the object never
 * runs it (the rule above the table on `initializeSchema`).
 */
export const planOf = ({ query, params }: Executed) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ readonly detail: string }>(
      `explain query plan ${query}`,
      params,
    );
    return rows.map((row) => row.detail);
  });

type Services =
  | OrderRepository
  | WorkflowRepository
  | RunRepository
  | SqlClient.SqlClient;

/**
 * A fresh object with the three repositories over {@link countingStorage},
 * handing `program` the recorded statements. The order ceiling is lifted so a
 * seed can store more orders than the ceiling allows.
 */
export const runInRepositoryCountingRows = <A, E>(
  program: (captured: readonly Executed[]) => Effect.Effect<A, E, Services>,
): Promise<A> =>
  withMaxOpenOrders(1_000_000, () =>
    runInDurableObject(
      env.TEST_SQL_DO.get(env.TEST_SQL_DO.idFromName(crypto.randomUUID())),
      (_instance, state) => {
        const { storage, captured } = countingStorage(state.storage);
        return Effect.runPromise(
          Effect.gen(function* () {
            yield* runShopAgentMigrations;
            return yield* program(captured);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                WorkflowRepository.layer,
                RunRepository.layer,
              ).pipe(
                Layer.provideMerge(OrderRepository.layer),
                Layer.provideMerge(SqliteClient.layer({ storage })),
              ),
            ),
          ),
        );
      },
    ),
  );
