#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Data, Effect, FileSystem, Stream } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as jsonc from "jsonc-parser";
import { glob } from "node:fs/promises";

class ResetError extends Data.TaggedError("ResetError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const wranglerJsoncPaths = ["wrangler.jsonc"] as const;

const runCommand = (command: string, args: readonly string[], input?: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        command,
        [...args],
        input === undefined
          ? undefined
          : { stdin: Stream.make(new TextEncoder().encode(input)) },
      ),
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
      ],
      { concurrency: "unbounded" },
    );
    const exitCode = yield* handle.exitCode;
    return exitCode === ChildProcessSpawner.ExitCode(0)
      ? stdout
      : yield* Effect.fail(
          new ResetError({
            message: `${command} ${args.join(" ")} exited ${String(exitCode)}${stderr ? `: ${stderr}` : ""}`,
          }),
        );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      cause instanceof ResetError
        ? cause
        : new ResetError({
            message: `Failed to run ${command} ${args.join(" ")}`,
            cause,
          }),
    ),
  );

const readText = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(path)),
    Effect.mapError(
      (cause) => new ResetError({ message: `Failed to read ${path}`, cause }),
    ),
  );

const writeText = (path: string, value: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(path, value)),
    Effect.mapError(
      (cause) => new ResetError({ message: `Failed to write ${path}`, cause }),
    ),
  );

const removePath = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(path, { recursive: true, force: true })),
    Effect.mapError(
      (cause) => new ResetError({ message: `Failed to remove ${path}`, cause }),
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
      new ResetError({ message: `Failed to glob ${pattern}`, cause }),
  });

const parseJsoncTree = (path: string, text: string) =>
  Effect.sync(() => jsonc.parseTree(text)).pipe(
    Effect.flatMap((tree) =>
      tree
        ? Effect.succeed(tree)
        : Effect.fail(
            new ResetError({ message: `Failed to parse jsonc: ${path}` }),
          ),
    ),
  );

const readWranglerJsoncTree = (path: string) =>
  Effect.gen(function* () {
    const text = yield* readText(path);
    const tree = yield* parseJsoncTree(path, text);
    return { text, tree };
  });

const databaseNamePath = (env: string) =>
  env === "local"
    ? ["d1_databases", 0, "database_name"]
    : ["env", env, "d1_databases", 0, "database_name"];

const getDatabaseName = (env: string) =>
  Effect.gen(function* () {
    const path = wranglerJsoncPaths[0];
    const { tree } = yield* readWranglerJsoncTree(path);
    const node = jsonc.findNodeAtLocation(tree, databaseNamePath(env));
    return typeof node?.value === "string"
      ? node.value
      : yield* Effect.fail(
          new ResetError({
            message: `Failed to find database name in wrangler.jsonc: ${path} for env: ${env}`,
          }),
        );
  });

const resetLocal = (databaseName: string) =>
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
    yield* Console.log({ migrationFiles });
    if (migrationFiles.length > 0)
      yield* Console.log(
        yield* runCommand("pnpm", [
          "wrangler",
          "d1",
          "migrations",
          "apply",
          databaseName,
          "--local",
        ]),
      );
    const sqliteFiles = (yield* globPaths(
      "./.wrangler/state/v3/d1/**/*.sqlite",
    )).filter((file) => !file.endsWith("/metadata.sqlite"));
    yield* Console.log({ sqliteFiles });
    if (sqliteFiles.length !== 1)
      yield* Effect.fail(
        new ResetError({
          message: "Expected exactly one sqlite file under .wrangler",
        }),
      );
    yield* Console.log(
      yield* runCommand(
        "sqlite3",
        [sqliteFiles[0]],
        ".schema\npragma table_list\n",
      ),
    );
    yield* Console.log(`sqlite3 ${sqliteFiles[0]}`);
  });

const updateRemoteDatabaseIds = (env: string, databaseId: string) =>
  Effect.all(
    wranglerJsoncPaths.map((path) =>
      Effect.gen(function* () {
        yield* Console.log({ wranglerJsoncPath: path });
        const { text, tree } = yield* readWranglerJsoncTree(path);
        const nodePath = ["env", env, "d1_databases", 0, "database_id"];
        if (!jsonc.findNodeAtLocation(tree, nodePath))
          yield* Effect.fail(
            new ResetError({
              message: `Failed to find database_id in jsonc: ${path}`,
            }),
          );
        const edits = jsonc.modify(text, nodePath, databaseId, {});
        if (edits.length === 0)
          yield* Effect.fail(
            new ResetError({ message: `Failed to modify jsonc: ${path}` }),
          );
        yield* writeText(path, jsonc.applyEdits(text, edits));
      }),
    ),
  );

const resetRemote = (env: string, databaseName: string) =>
  Effect.gen(function* () {
    yield* runCommand("pnpm", [
      "wrangler",
      "d1",
      "delete",
      databaseName,
      "--skip-confirmation",
    ]).pipe(
      Effect.catchIf(
        (error) =>
          /not found|does not exist|could(?: not|n't) find/iu.test(
            error.message,
          ),
        (error) => Console.error(`Ignoring exception: ${error.message}`),
      ),
    );
    const output = yield* runCommand("pnpm", [
      "wrangler",
      "d1",
      "create",
      databaseName,
    ]);
    const databaseId = /"database_id":\s*"(?<databaseId>[a-f0-9-]+)"/u.exec(
      output,
    )?.groups?.databaseId;
    if (databaseId === undefined) {
      yield* Effect.fail(
        new ResetError({
          message: `database_id not matched in output of create database command: ${output}`,
        }),
      );
    } else {
      yield* Console.log({ databaseId });
      yield* updateRemoteDatabaseIds(env, databaseId);
      yield* runCommand("pnpm", [
        env === "production"
          ? "d1:migrate:apply:PRODUCTION"
          : `d1:migrate:apply:${env}`,
      ]);
    }
  });

const command = Command.make(
  "d1-reset",
  {
    env: Flag.choice("env", ["local", "staging", "production"]).pipe(
      Flag.withDescription("Target environment to reset"),
      Flag.withDefault("local"),
    ),
  },
  Effect.fnUntraced(function* ({ env }) {
    const databaseName = yield* getDatabaseName(env);
    yield* Console.log({ env, databaseName });
    yield* env === "local"
      ? resetLocal(databaseName)
      : resetRemote(env, databaseName);
  }),
).pipe(Command.run({ version: "0.1.0" }), Effect.provide(NodeServices.layer));

NodeRuntime.runMain(command);
