import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/**
 * Runs a multi-statement body in one storage transaction. The actor's own, which must run the
 * body on its sync scheduler, so a repository never opens a transaction of its own.
 *
 * Never nest one: a repository method that takes `transaction` is called outside any other. The
 * SQL clients here would nest (a savepoint), so nothing refuses it; the rule is a convention, as
 * legacy's repositories kept it.
 */
export type Transaction = <A, E, R>(
  body: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | SqlError.SqlError, R>;

/**
 * {@link Transaction} over `sql`: `body` in one storage transaction (`storage.transaction`, rolled
 * back on failure). The transaction closes the object's input gate, behind which a timer never
 * fires, so a fiber yield scheduled on a timer inside it could wait forever; the body runs on a
 * `"sync"` scheduler instead, which yields through microtasks, as Alchemy's
 * `Drizzle.DurableObject` does. Build it once per activation.
 *
 * @see refs/alchemy/packages/alchemy/src/Drizzle/Cloudflare.ts (`DurableObject`)
 */
export const syncTransaction = (sql: SqlClient.SqlClient): Transaction => {
  const scheduler = new Scheduler.MixedScheduler("sync");
  return (body) =>
    sql.withTransaction(body).pipe(Effect.provideService(Scheduler.Scheduler, scheduler));
};
