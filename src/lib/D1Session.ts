import { D1Client } from "@effect/sql-d1";
import { Context, Layer } from "effect";
import { Reactivity } from "effect/unstable/reactivity";

/**
 * The per-request read-replica session (Cloudflare D1 Sessions API,
 * `env.D1.withSession` in `src/worker.ts`): reads may be served by a replica
 * and can be stale relative to the primary; writes are forwarded to the
 * primary and advance the session bookmark, keeping all queries in one session
 * sequentially consistent. Use for latency-tolerant reads; paths where a stale
 * read causes wrong decisions go through `D1Primary` instead.
 *
 * App-owned tag: the library `SqlClient`/`D1Client` tags are deliberately not
 * provided anywhere in the Worker (the Durable Object's private SQLite still
 * provides `SqlClient` for its own migrations), so every D1 call site must
 * name which database path it runs on. `D1Client.make` wants a full
 * `D1Database`, but `withSession()` returns the narrower `D1DatabaseSession`
 * (no exec/dump/withSession) — safe cast: the driver only ever calls
 * `db.prepare()` and `db.batch()`, which `D1DatabaseSession` implements
 * identically. Tests and the Durable Object pass the raw `env.D1` binding, a
 * session in name only.
 *
 * `Reactivity.layer` only satisfies a mandatory `D1Client.make` dependency
 * (every `SqlClient` bundles reactive query invalidation); it is process-local
 * and inert in this per-request runtime, and is provided here so it stays out
 * of the app context.
 */
export class D1Session extends Context.Service<D1Session, D1Client.D1Client>()(
  "D1Session",
) {
  static readonly layer = (
    db: D1DatabaseSession | D1Database,
  ): Layer.Layer<D1Session> =>
    Layer.effect(D1Session, D1Client.make({ db: db as D1Database })).pipe(
      Layer.provide(Reactivity.layer),
    );
}
