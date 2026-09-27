#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import * as jsonc from "jsonc-parser";

import { runCommand } from "./lib/command.ts";
import {
  D1Error,
  getDatabaseName,
  readWranglerJsoncTree,
  resetLocal,
  WRANGLER_JSONC,
  writeText,
} from "./lib/d1.ts";

const printLocalReset = (databaseName: string) =>
  resetLocal(databaseName).pipe(
    Effect.flatMap(({ migrationFiles, migrationOutput, sqliteFile, schema }) =>
      Effect.all([
        Console.log({ migrationFiles }),
        Console.log(migrationOutput),
        Console.log({ sqliteFiles: [sqliteFile] }),
        Console.log(schema),
        Console.log(`sqlite3 ${sqliteFile}`),
      ]),
    ),
  );

const updateRemoteDatabaseIds = (env: string, databaseId: string) =>
  Effect.all(
    [WRANGLER_JSONC].map((path) =>
      Effect.gen(function* () {
        yield* Console.log({ wranglerJsoncPath: path });
        const { text, tree } = yield* readWranglerJsoncTree(path);
        const nodePath = ["env", env, "d1_databases", 0, "database_id"];
        if (!jsonc.findNodeAtLocation(tree, nodePath))
          yield* Effect.fail(
            new D1Error({
              message: `Failed to find database_id in jsonc: ${path}`,
            }),
          );
        const edits = jsonc.modify(text, nodePath, databaseId, {});
        if (edits.length === 0)
          yield* Effect.fail(
            new D1Error({ message: `Failed to modify jsonc: ${path}` }),
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
        new D1Error({
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
      ? printLocalReset(databaseName)
      : resetRemote(env, databaseName);
  }),
).pipe(Command.run({ version: "0.1.0" }), Effect.provide(NodeServices.layer));

NodeRuntime.runMain(command);
