/**
 * Rows read and written, as Cloudflare bills them, tallied per database and per statement for a
 * measuring probe. Installed only with the `ROW_COUNTS` binding, which only the integ stack
 * binds; without it {@link countActorStorage} and {@link countD1} are never called, so production
 * carries no wrapper.
 *
 * The tallies live in module scope, one per isolate. Locally the Backend and its Durable Objects
 * share one isolate, so one {@link takeRowCounts} on the Backend sees the actor's statements too.
 *
 * @see refs/cloudflare-docs/src/content/docs/durable-objects/api/sqlite-storage-api.mdx `rowsRead`
 * @see refs/cloudflare-docs/src/content/docs/d1/worker-api/return-object.mdx `rows_read`
 * @module
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** One statement's tally: its SQL with whitespace collapsed, and what its runs cost. */
export interface StatementCounts {
  readonly sql: string;
  readonly runs: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsReturned: number;
}

/**
 * One database's tally, in total and by statement. `unmetered` counts the statements whose result
 * carries no counts (D1's `first`, `raw` and `exec`), so a tally that missed work says so.
 */
export interface RowCounts {
  readonly runs: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsReturned: number;
  readonly unmetered: number;
  readonly statements: ReadonlyArray<StatementCounts>;
}

/** The tallies {@link takeRowCounts} answers: the shop actors' SQLite, and D1. */
export interface RowCountsByDatabase {
  readonly actor: RowCounts;
  readonly d1: RowCounts;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

class Tally {
  readonly statements = new Map<string, Mutable<StatementCounts>>();
  unmetered = 0;

  add(query: string, counts: Omit<StatementCounts, "sql" | "runs">) {
    const sql = query.replace(/\s+/gu, " ").trim();
    const entry = this.statements.get(sql) ?? {
      sql,
      runs: 0,
      rowsRead: 0,
      rowsWritten: 0,
      rowsReturned: 0,
    };
    entry.runs++;
    entry.rowsRead += counts.rowsRead;
    entry.rowsWritten += counts.rowsWritten;
    entry.rowsReturned += counts.rowsReturned;
    this.statements.set(sql, entry);
  }

  counts(): RowCounts {
    const statements = [...this.statements.values()].toSorted((a, b) => b.rowsRead - a.rowsRead);
    const sum = (key: "runs" | "rowsRead" | "rowsWritten" | "rowsReturned") =>
      statements.reduce((total, statement) => total + statement[key], 0);
    return {
      runs: sum("runs"),
      rowsRead: sum("rowsRead"),
      rowsWritten: sum("rowsWritten"),
      rowsReturned: sum("rowsReturned"),
      unmetered: this.unmetered,
      statements,
    };
  }
}

let tallies = { actor: new Tally(), d1: new Tally() };

/** Answers the tallies since the last take, and starts new ones. */
export const takeRowCounts = (): RowCountsByDatabase => {
  const taken = tallies;
  tallies = { actor: new Tally(), d1: new Tally() };
  return { actor: taken.actor.counts(), d1: taken.d1.counts() };
};

/** Whether this Worker counts rows: the `ROW_COUNTS` binding is present. */
export const rowCountsOn = Config.option(Config.String("ROW_COUNTS")).pipe(
  Effect.map(Option.isSome),
  Effect.orDie,
);

/** `target[prop]`, a method bound to `target`: workerd's native objects refuse a proxy as `this`. */
const own = (target: object, prop: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, prop, target);
  return typeof value === "function" ? value.bind(target) : value;
};

/**
 * A cursor whose `raw()` tallies `query` as it is iterated. A cursor's `rowsRead` and
 * `rowsWritten` are final only once it is fully iterated, so they are added when the iteration
 * ends; the `@effect/sql-sqlite-do` client always iterates `raw()` to the end.
 */
const countCursor = <T extends Record<string, SqlStorageValue>>(
  query: string,
  cursor: SqlStorageCursor<T>,
) =>
  new Proxy(cursor, {
    get: (target, prop) =>
      prop === "raw"
        ? function* () {
            let rowsReturned = 0;
            try {
              for (const row of target.raw()) {
                rowsReturned++;
                yield row;
              }
            } finally {
              tallies.actor.add(query, {
                rowsRead: target.rowsRead,
                rowsWritten: target.rowsWritten,
                rowsReturned,
              });
            }
          }
        : own(target, prop),
  });

/** `storage` with every `sql.exec` tallied under `actor`; see {@link countCursor}. */
export const countActorStorage = (storage: DurableObjectStorage): DurableObjectStorage => {
  const sql = new Proxy(storage.sql, {
    get: (target, prop) =>
      prop === "exec"
        ? (query: string, ...bindings: Array<unknown>) =>
            countCursor(query, target.exec(query, ...bindings))
        : own(target, prop),
  });
  return new Proxy(storage, {
    get: (target, prop) => (prop === "sql" ? sql : own(target, prop)),
  });
};

const tallyD1 = (query: string, result: D1Result<unknown>) =>
  tallies.d1.add(query, {
    rowsRead: result.meta.rows_read,
    rowsWritten: result.meta.rows_written,
    rowsReturned: result.results?.length ?? 0,
  });

/** Each counting statement's SQL and the binding's own statement, which `batch` requires. */
const originals = new WeakMap<
  D1PreparedStatement,
  { readonly query: string; readonly statement: D1PreparedStatement }
>();

const countStatement = (query: string, statement: D1PreparedStatement): D1PreparedStatement => {
  const counting = new Proxy(statement, {
    get: (target, prop) => {
      if (prop === "bind")
        return (...values: Array<unknown>) => countStatement(query, target.bind(...values));
      if (prop === "all" || prop === "run")
        return () =>
          target[prop]().then((result) => {
            tallyD1(query, result);
            return result;
          });
      if (prop === "first" || prop === "raw") tallies.d1.unmetered++;
      return own(target, prop);
    },
  });
  originals.set(counting, { query, statement });
  return counting;
};

/** `database` with every statement's `meta` tallied under `d1`. */
export const countD1 = (database: D1Database): D1Database =>
  new Proxy(database, {
    get: (target, prop) => {
      if (prop === "prepare")
        return (query: string) => countStatement(query, target.prepare(query));
      if (prop === "batch")
        return (statements: Array<D1PreparedStatement>) => {
          const known = statements.map(
            (statement) => originals.get(statement) ?? { query: "<uncounted>", statement },
          );
          return target.batch(known.map(({ statement }) => statement)).then((results) => {
            results.forEach((result, index) => tallyD1(known[index]?.query ?? "", result));
            return results;
          });
        };
      if (prop === "exec") tallies.d1.unmetered++;
      return own(target, prop);
    },
  });

/**
 * A D1 source, counted when this Worker counts rows ({@link rowCountsOn}): the source a
 * repository's `make` takes.
 */
export const countedD1 = <E, R>(raw: Effect.Effect<D1Database, E, R>) =>
  Effect.map(rowCountsOn, (on) => (on ? Effect.map(raw, countD1) : raw));
