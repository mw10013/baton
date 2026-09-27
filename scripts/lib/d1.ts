import { Data, Effect, FileSystem, Schema } from "effect";
import * as jsonc from "jsonc-parser";
import { glob } from "node:fs/promises";

import { runCommand } from "./command.ts";

export class D1Error extends Data.TaggedError("D1Error")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const WRANGLER_JSONC = "wrangler.jsonc";

export const readText = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(path)),
    Effect.mapError(
      (cause) => new D1Error({ message: `Failed to read ${path}`, cause }),
    ),
  );

export const writeText = (path: string, value: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(path, value)),
    Effect.mapError(
      (cause) => new D1Error({ message: `Failed to write ${path}`, cause }),
    ),
  );

const removePath = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(path, { recursive: true, force: true })),
    Effect.mapError(
      (cause) => new D1Error({ message: `Failed to remove ${path}`, cause }),
    ),
  );

const globPaths = (pattern: string) =>
  Effect.tryPromise({
    try: async () => {
      const paths: string[] = [];
      for await (const file of glob(pattern)) paths.push(file);
      return paths;
    },
    catch: (cause) =>
      new D1Error({ message: `Failed to glob ${pattern}`, cause }),
  });

export const readWranglerJsoncTree = (path: string) =>
  Effect.gen(function* () {
    const text = yield* readText(path);
    const tree = jsonc.parseTree(text);
    return tree
      ? { text, tree }
      : yield* new D1Error({ message: `Failed to parse jsonc: ${path}` });
  });

const databaseNamePath = (env: string) =>
  env === "local"
    ? ["d1_databases", 0, "database_name"]
    : ["env", env, "d1_databases", 0, "database_name"];

export const getDatabaseName = (env: string) =>
  Effect.gen(function* () {
    const { tree } = yield* readWranglerJsoncTree(WRANGLER_JSONC);
    const node = jsonc.findNodeAtLocation(tree, databaseNamePath(env));
    return typeof node?.value === "string"
      ? node.value
      : yield* new D1Error({
          message: `Failed to find database name in ${WRANGLER_JSONC} for env: ${env}`,
        });
  });

/**
 * Deletes `.wrangler` and applies the migrations to a fresh local D1.
 * `.wrangler` holds every local store, D1 under `state/v3/d1` and each
 * Durable Object's SQLite under `state/v3/do`, so this resets both. The dev
 * server must be stopped first: a running server keeps the deleted SQLite
 * files open and silently diverges from the new ones.
 *
 * Returns what it did rather than printing it, so a caller decides how loud
 * to be.
 */
export const resetLocal = (databaseName: string) =>
  Effect.gen(function* () {
    yield* removePath(".wrangler");
    yield* runCommand("pnpm", [
      "wrangler",
      "d1",
      "execute",
      databaseName,
      "--local",
      "--command",
      "pragma foreign_keys = ON;",
    ]);
    const migrationFiles = yield* globPaths("./migrations/*.sql");
    const migrationOutput =
      migrationFiles.length > 0
        ? yield* runCommand("pnpm", [
            "wrangler",
            "d1",
            "migrations",
            "apply",
            databaseName,
            "--local",
          ])
        : "";
    const sqliteFiles = (yield* globPaths(
      "./.wrangler/state/v3/d1/**/*.sqlite",
    )).filter((file) => !file.endsWith("/metadata.sqlite"));
    const [sqliteFile] = sqliteFiles;
    if (sqliteFiles.length !== 1 || sqliteFile === undefined)
      return yield* new D1Error({
        message: "Expected exactly one sqlite file under .wrangler",
      });
    const schema = yield* runCommand(
      "sqlite3",
      [sqliteFile],
      ".schema\npragma table_list\n",
    );
    return { migrationFiles, migrationOutput, sqliteFile, schema } as const;
  });

const ExecuteResult = Schema.fromJsonString(
  Schema.Tuple([Schema.Struct({ results: Schema.Array(Schema.Unknown) })]),
);

/**
 * Runs one read against local D1 through `wrangler d1 execute --local` and
 * returns the rows. Safe while the dev server runs: wrangler opens the same
 * SQLite files under `.wrangler`, and a read cannot conflict with the
 * server's writes. `wrangler d1 execute --command` takes no bound
 * parameters, so callers inline only values they control.
 */
export const queryLocal = (databaseName: string, sql: string) =>
  runCommand("pnpm", [
    "--silent",
    "wrangler",
    "d1",
    "execute",
    databaseName,
    "--local",
    "--json",
    "--command",
    sql,
  ]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ExecuteResult)),
    Effect.map(([result]) => result.results),
    Effect.mapError(
      (cause) =>
        new D1Error({ message: `Local D1 query failed: ${sql}`, cause }),
    ),
  );
