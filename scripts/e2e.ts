#!/usr/bin/env node
/**
 * `vp run e2e:start | e2e:stop | e2e:status | e2e:restart | e2e:logs`: this checkout's
 * long-lived e2e server, which every e2e run reuses. The server is Shopify CLI on this checkout's
 * e2e store (`vp run e2e:serve`, `scripts/e2e-server.ts`) serving the e2e stage on the e2e port;
 * it is found, placed (herdr tab `e2e`), locked (`.logs/e2e.lock`) and stopped by the same rules
 * as the dev server ({@link startServer}), and the dev server's commands never see it.
 *
 * A run does not reset the server: the `install` setup project loads the e2e fixture, which
 * replaces the shop's members, teams, workflows and orders, each run. `restart` is the clean slate:
 * stop, destroy the e2e stage's local state and data, start.
 *
 * A running server serves `src/` edits by hot reload (never edit during a run). It needs `restart`
 * after a change to what it does not reload ({@link RESTART_FILES}): dependencies, `alchemy.run.ts`
 * or the stack, `patches/`, or the schema's `0001_init`. `status` says when one of them is newer
 * than the server.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { CliError, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import path from "node:path";
import process from "node:process";

import {
  answering,
  appReport,
  describeServer,
  findServer,
  loadServer,
  logTail,
  portListeners,
  processStart,
  ROOT,
  type Server,
  ServerError,
  serverParams,
  startServer,
  step,
  stopServer,
  tunnelState,
  withLock,
} from "./lib/server.ts";
import { checkStores } from "./lib/stores.ts";

const E2E = serverParams("e2e");
const loadE2e = loadServer("e2e");

/**
 * What a running e2e server does not reload, so a change to any of them needs `restart`: the
 * dependencies, the stack (`alchemy.run.ts`, `src/backend/stack.ts`), the dependency patches, and
 * the D1 schema, which is migrated only when the stage's database is created.
 */
const RESTART_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "alchemy.run.ts",
  "src/backend/stack.ts",
  "patches",
  "migrations/0001_init.sql",
];

const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

/** The dev and e2e stores exist and are on a plan: `install` fails late and vaguely otherwise. */
const checkStoresOf = (server: Server) =>
  Config.NonEmptyString("SHOPIFY_DEV_STORE").pipe(
    Effect.mapError(() => new ServerError({ message: "SHOPIFY_DEV_STORE is not set in .env" })),
    Effect.flatMap((dev) => step("stores", checkStores({ dev, e2e: server.store }))),
  );

const start = Effect.gen(function* () {
  const server = yield* loadE2e;
  yield* checkStoresOf(server);
  yield* startServer(server, Effect.void);
});

const startCommand = Command.make("start", {}, () => start.pipe(Effect.mapError(toUserError))).pipe(
  Command.withDescription(
    "Start the e2e server, or adopt the one already running. It keeps its data: each run's install loads the e2e fixture.",
  ),
);

const stopCommand = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const server = yield* loadE2e;
    yield* withLock(server, step("stop", stopServer(server)));
  }).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Stop the e2e server wherever it runs."));

/** `alchemy destroy` of the e2e stage: local state and data only, nothing in the cloud. */
const destroyStage = (server: Server) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make("alchemy", ["destroy", "--stage", server.stage, "--yes"], {
        cwd: ROOT,
        env: { WEBSITE_PORT: String(server.port) },
        extendEnv: true,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (exitCode !== ChildProcessSpawner.ExitCode(0))
      return yield* new ServerError({ message: `alchemy destroy exited ${String(exitCode)}` });
  });

const restartCommand = Command.make("restart", {}, () =>
  Effect.gen(function* () {
    const server = yield* loadE2e;
    yield* withLock(
      server,
      Effect.gen(function* () {
        yield* step("stop", stopServer(server));
        yield* step(`destroy stage ${server.stage}`, destroyStage(server));
      }),
    );
    yield* start;
  }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Stop the e2e server, destroy its stage's local data, and start it: the clean slate. Needed after a change to dependencies, alchemy.run.ts or the stack, patches/, or the schema's 0001_init; src/ edits hot-reload.",
  ),
);

/** The restart files newer than `since`, by modification time. */
const changedSince = (since: Date) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const newer = (file: string) =>
      fs.stat(path.join(ROOT, file)).pipe(
        Effect.map((info) => Option.exists(info.mtime, (mtime) => mtime > since)),
        Effect.orElseSucceed(() => false),
      );
    const files = yield* Effect.forEach(RESTART_FILES, (file) =>
      file === "patches"
        ? fs.readDirectory(path.join(ROOT, file)).pipe(
            Effect.map((names) => names.map((name) => path.join(file, name))),
            Effect.orElseSucceed((): string[] => []),
          )
        : Effect.succeed([file]),
    );
    return yield* Effect.filter(files.flat(), newer);
  });

const statusCommand = Command.make(
  "status",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the report as JSON"),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    Effect.gen(function* () {
      const server = yield* loadE2e;
      const { port } = server;
      const found = yield* findServer(server);
      const listening = (yield* portListeners(port)).length > 0;
      const serving = listening && (yield* answering(port));
      const { tunnel } = yield* appReport(server);
      const tunnelSeen = tunnel === null ? null : yield* tunnelState(tunnel);
      const healthy = found.pids.length > 0 && serving && tunnelSeen === "ready";
      const started = Option.getOrNull(
        yield* Effect.flatMap(Effect.forEach(found.pids, processStart), (starts) =>
          Effect.succeed(Array.head(Array.getSomes(starts))),
        ),
      );
      const stale = started === null ? [] : yield* changedSince(started);
      const report = {
        healthy,
        server: describeServer(found),
        pids: found.pids,
        pane: Option.getOrNull(Option.map(found.pane, (pane) => pane.pane_id)),
        port,
        url: `http://localhost:${String(port)}`,
        listening,
        answering: serving,
        stage: server.stage,
        store: server.store,
        tunnel,
        tunnelState: tunnelSeen,
        started: started?.toISOString() ?? null,
        changedSinceStart: stale,
      };
      const uptime =
        started === null
          ? "(not running)"
          : `${String(Math.round((Date.now() - started.getTime()) / 60_000))} min (since ${started.toISOString()})`;
      yield* Console.log(
        json
          ? JSON.stringify(report, null, 2)
          : [
              `healthy: ${healthy ? "yes" : "no"}`,
              `server:  ${report.server}`,
              `port:    ${String(port)} (${listening ? "listening" : "not listening"}, ${serving ? "answering" : "not answering"})`,
              `url:     ${report.url}`,
              `stage:   ${server.stage}`,
              `store:   ${server.store}`,
              `tunnel:  ${tunnel === null ? "(none)" : `${tunnel} (${tunnelSeen ?? "unknown"})`}`,
              `uptime:  ${uptime}`,
              ...(stale.length > 0
                ? [`restart: changed since start: ${stale.join(", ")}; run vp run e2e:restart`]
                : []),
              ...(found.pids.length === 0 ? ["start it: vp run e2e:start"] : []),
            ].join("\n"),
      );
      if (!healthy) yield* Effect.sync(() => (process.exitCode = 1));
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Report whether the e2e server runs, answers, and its tunnel serves. Read-only; exit code 1 when unhealthy.",
  ),
);

const logsCommand = Command.make(
  "logs",
  {
    lines: Flag.Int("lines").pipe(
      Flag.withDescription("Lines from the end of the log"),
      Flag.withDefault(80),
    ),
  },
  ({ lines }) => logTail(E2E, lines),
).pipe(Command.withDescription(`Print the tail of ${E2E.log}.`));

Command.make("e2e").pipe(
  Command.withDescription(
    [
      "Run this checkout's long-lived e2e server (vp run e2e:serve: shopify app dev on the e2e store) for every e2e run.",
      `It is placed like the dev server, in herdr tab "${E2E.tab}". Output always goes to ${E2E.log}.`,
    ].join("\n"),
  ),
  Command.withSubcommands([startCommand, stopCommand, statusCommand, restartCommand, logsCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
