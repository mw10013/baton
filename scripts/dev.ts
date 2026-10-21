#!/usr/bin/env node
/**
 * `vp run dev | dev:stop | dev:status | dev:logs`: one command that an
 * agent and a person both use to get this checkout's dev server running, and
 * to find it again. The server is Shopify CLI (`vp run app:dev`, which runs
 * `shopify app dev` on this checkout's dev store, `SHOPIFY_DEV_STORE` in
 * `.env`); the CLI opens a tunnel and runs `vp run dev:alchemy`, which runs
 * `alchemy dev`, with the app's key, secret and tunnel URL in its environment.
 * A missing `SHOPIFY_DEV_STORE` is an error: there is no plain `alchemy dev`
 * fallback. Every checkout, the main one and each `wt-NN` worktree, runs its
 * own server on its own `WEBSITE_PORT` and its own store.
 *
 * Where the server runs, how a running one is adopted, and the lock (`.logs/dev.lock`) are
 * {@link startServer}'s rules, shared with the e2e server; the herdr tab is `dev`. The e2e server
 * runs in the same directory and is never adopted, reported or stopped here.
 *
 * Alchemy's output always goes to `.logs/dev/current` (the `web:dev` script pipes it
 * through `s6-log`), and with the CLI's own output (tunnel, preview URL, status) to the pane or
 * terminal it runs in. `start` and `status` print the tunnel and the app's admin URL.
 *
 * The server runs under this checkout's dev stage (`dev-<user>`, or `dev-<user>-wt-NN` in a
 * worktree), which `node scripts/stage.ts dev` prints.
 *
 * `db:reset` stops the server, and this checkout's e2e server too, removes this checkout's local
 * data (`.alchemy/local`: D1, simulated email, Durable Objects) and local state
 * (`.alchemy/state`) for every stage, and starts the dev server, which recreates, migrates and
 * seeds the database. Then it opens the app in the dev store and applies the dev fixture
 * ({@link openAppAndApplyFixture}). The e2e server is left stopped: its data is gone from under it,
 * and the next e2e run's preflight says to start it. Dev, test and e2e keep everything in the
 * checkout, so nothing in the cloud is touched; the fixture's store half writes the dev store.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { CliError, Command, Flag } from "effect/cli";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./lib/command.ts";
import { fixture } from "../fixture.ts";
import { applyFixture } from "./lib/fixture.ts";
import {
  adminUrl,
  answering,
  appReport,
  describeServer,
  findServer,
  loadClientId,
  loadServer,
  logTail,
  portListeners,
  ROOT,
  ServerError,
  serverParams,
  startServer,
  step,
  stopServer,
  tunnelState,
  withLock,
} from "./lib/server.ts";

const DEV = serverParams("dev");
const LOCAL_DATA = ".alchemy/local";
/**
 * The state of every local-state stage (dev, test and e2e). Their resources live in
 * {@link LOCAL_DATA}, so `db:reset` removes the two together: records left without their data
 * would say the database exists and the seed ran, and the next start would skip both.
 */
const LOCAL_STATE = ".alchemy/state";

const loadDev = loadServer("dev");

/** Every failure a command can raise carries a message for the person at the terminal. */
const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const startCommand = Command.make("start", {}, () =>
  loadDev.pipe(
    Effect.flatMap((server) => startServer(server, Effect.void)),
    Effect.mapError(toUserError),
  ),
).pipe(Command.withDescription("Start the dev server, or adopt the one already running."));

const stopCommand = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const server = yield* loadDev;
    yield* withLock(server, step("stop", stopServer(server)));
  }).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Stop the dev server wherever it runs."));

/**
 * What `db:reset` does once the server answers: a reset leaves the dev store without its
 * `ShopSession`, which only an embedded load writes, so it opens the app in the default browser,
 * where the person is already signed in to Shopify, then applies the dev fixture, waiting for that
 * load. Where `open` is missing, it prints the URL to open instead.
 */
const openAppAndApplyFixture = Effect.gen(function* () {
  const url = adminUrl((yield* loadDev).store, yield* loadClientId);
  yield* step(`open ${url}`, runCommand("open", [url])).pipe(
    Effect.catch(() => Console.log(`open   ${url} in a browser signed in to Shopify`)),
  );
  yield* applyFixture({ fixture, waitForInstall: true }).pipe(
    Effect.mapError((error) => new ServerError({ message: error.message })),
  );
});

const dbResetCommand = Command.make("db:reset", {}, () =>
  Effect.gen(function* () {
    const server = yield* loadDev;
    const e2e = yield* loadServer("e2e");
    yield* withLock(server, step("stop", stopServer(server)));
    // Its database is about to go; it is not started again (the next e2e run's preflight says so).
    yield* withLock(e2e, step("stop the e2e server", stopServer(e2e)));
    const fs = yield* FileSystem.FileSystem;
    for (const dir of [LOCAL_DATA, LOCAL_STATE])
      yield* step(
        `remove ${dir}`,
        fs.remove(path.join(ROOT, dir), { recursive: true, force: true }),
      );
    yield* startServer(server, openAppAndApplyFixture);
  }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Reset the dev database: stop the dev and e2e servers, remove local data and local state, start the dev server, open the app in the dev store, and apply the dev fixture. The e2e server stays stopped.",
  ),
);

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
      const server = yield* loadDev;
      const { port } = server;
      const found = yield* findServer(server);
      const listening = (yield* portListeners(port)).length > 0;
      const serving = listening && (yield* answering(port));
      const healthy = found.pids.length > 0 && serving;
      const { app, tunnel } = yield* appReport(server);
      const tunnelSeen = tunnel === null ? null : yield* tunnelState(tunnel);
      const report = {
        healthy,
        server: describeServer(found),
        pids: found.pids,
        pane: Option.getOrNull(Option.map(found.pane, (pane) => pane.pane_id)),
        port,
        url: `http://localhost:${String(port)}`,
        listening,
        answering: serving,
        store: server.store,
        app,
        tunnel,
        tunnelState: tunnelSeen,
      };
      yield* Console.log(
        json
          ? JSON.stringify(report, null, 2)
          : [
              `healthy: ${healthy ? "yes" : "no"}`,
              `server:  ${report.server}`,
              `port:    ${String(port)} (${listening ? "listening" : "not listening"}, ${serving ? "answering" : "not answering"})`,
              `url:     ${report.url}`,
              `store:   ${report.store}`,
              `app:     ${app ?? "(unknown)"}`,
              `tunnel:  ${tunnel === null ? "(none)" : `${tunnel} (${tunnelSeen ?? "unknown"})`}`,
            ].join("\n"),
      );
      if (!healthy) yield* Effect.sync(() => (process.exitCode = 1));
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Report where the server runs and whether it answers. Read-only; exit code 1 when unhealthy.",
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
  ({ lines }) => logTail(DEV, lines),
).pipe(Command.withDescription(`Print the tail of ${DEV.log}.`));

Command.make("dev").pipe(
  Command.withDescription(
    [
      "Run this checkout's dev server (vp run app:dev: shopify app dev, which runs alchemy dev) for an agent or a person.",
      "Where it runs, first match wins:",
      "  1. a server already running for this checkout is adopted;",
      `  2. with herdr running: the checkout's workspace, tab "${DEV.tab}" (opened if needed);`,
      `     typed by a person in that tab, this terminal; otherwise an idle pane there;`,
      "  3. without herdr, typed in a terminal: this terminal;",
      "  4. otherwise: in the background.",
      `Output always goes to ${DEV.log}.`,
    ].join("\n"),
  ),
  Command.withSubcommands([startCommand, stopCommand, dbResetCommand, statusCommand, logsCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
