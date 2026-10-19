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
 * Where the server runs; the first rule that applies wins:
 *
 * 1. A `shopify app dev` or `alchemy dev` already serving this checkout,
 *    wherever it runs, is adopted: `start` leaves it running, `stop` stops
 *    it, whoever started it. It is found by process, working directory and
 *    store (`--store <SHOPIFY_DEV_STORE>`), not by label; the e2e server,
 *    which runs in the same directory on the e2e store, is never adopted,
 *    reported or stopped.
 * 2. With herdr running, the server belongs to the checkout's workspace,
 *    which is opened if needed: labelled with the project name for the main
 *    checkout, `wt-NN` for a worktree (grouped under the main checkout's
 *    workspace, which is opened first). In it, a tab labelled `dev`:
 *    - typed by a person (a TTY) in the `dev` tab: the caller's terminal, in
 *      the foreground;
 *    - otherwise (an agent, or a person in another tab): an idle pane of the
 *      `dev` tab, a new split when none is idle, or a new `dev` tab. It never
 *      types into a busy pane.
 * 3. Without herdr, typed by a person: the caller's terminal, in the
 *    foreground.
 * 4. Otherwise: a detached background process.
 *
 * herdr is asked whether it runs (`herdr status`), never `HERDR_ENV`: T3 Code
 * agents run outside herdr but can still drive it over its socket.
 *
 * Alchemy's output always goes to `.logs/dev/current` (the `web:dev` script pipes it
 * through `s6-log`), and with the CLI's own output (tunnel, preview URL, status) to the pane or
 * terminal it runs in. `start` and `status` print the tunnel and the app's admin URL.
 *
 * `start` and `stop` hold `.logs/dev.lock` so parallel agents in one checkout
 * cannot start two servers.
 *
 * The server runs under this checkout's dev stage (`dev-<user>`, or `dev-<user>-wt-NN` in a
 * worktree), which `node scripts/stage.ts dev` prints.
 *
 * `db:reset` stops the server, removes this checkout's local data (`.alchemy/local`: D1,
 * simulated email, Durable Objects) and local state (`.alchemy/state`) for every stage, and
 * starts the server, which recreates, migrates and seeds the database. Then it opens the app in
 * the dev store and applies the dev fixture ({@link openAppAndApplyFixture}). Dev, test and e2e
 * keep everything in the checkout, so nothing in the cloud is touched; the fixture's store half
 * writes the dev store.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { CliError, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCommand } from "./lib/command.ts";
import { applyFixture } from "./lib/fixture.ts";
import * as Herdr from "./lib/herdr.ts";
import {
  answering,
  decodePid,
  findTunnelUrl,
  pidsFrom,
  portListeners,
  tunnelState,
} from "./lib/server.ts";
import { checkoutKind, currentBranch, stage } from "./lib/worktree.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const LOG = ".logs/dev/current";
const LOCK = ".logs/dev.lock";
const DEV_TAB = "dev";
/**
 * This checkout's dev stage, resolved on first use and kept. The `web:dev` script passes it
 * as `--stage`, so it is also the part of the server's command line that tells this checkout's
 * `alchemy dev` from another checkout's and from an e2e stage's (Playwright's web server, on
 * another port, sets its stage through `ALCHEMY_STAGE` and has no `--stage` to match). The
 * script's own shell holds the stage only as `$stage`, so the match is on Alchemy's CLI process,
 * which gets the expanded argument. `dev-mw` also matches `dev-mw-wt-01`; the working-directory
 * check that follows every match separates them.
 */
const devStage = Effect.runSync(
  Effect.cached(stage("dev").pipe(Effect.provide(NodeServices.layer))),
);
const serverProcess = devStage.pipe(Effect.map((name) => ` dev --stage ${name}`));
/**
 * Shopify CLI's `app dev` process, as `pgrep -f` matches it. Under Vite+'s tool manager the CLI's
 * command line is `node …/@shopify/cli/…/bin/run.js app dev …`, without the word `shopify app
 * dev`; a CLI installed elsewhere shows `shopify app dev`. Both are matched.
 */
const CLI_PROCESS = String.raw`shopify app dev|@shopify/cli/.*bin/run\.js app dev`;
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
/**
 * The pattern of this checkout's dev server CLI: {@link CLI_PROCESS} on `--store <store>`. The
 * e2e server is also a `shopify app dev` in this checkout's working directory, on the e2e store,
 * so the working-directory check that follows every match cannot tell the two apart; the store
 * does. A store name that is a prefix of another (`…-shop-0` and `…-shop-00`) must end the
 * argument.
 */
const cliPattern = (store: string) => `(${CLI_PROCESS}) .*--store ${escapeRegExp(store)}( |$)`;
const isCliCommand = (store: string) =>
  Schema.is(Schema.String.check(Schema.isPattern(new RegExp(cliPattern(store), "u"))));
const START_TIMEOUT_MS = 180_000;
const LOCAL_DATA = ".alchemy/local";
/**
 * The state of every local-state stage (dev, test and e2e). Their resources live in
 * {@link LOCAL_DATA}, so `db:reset` removes the two together: records left without their data
 * would say the database exists and the seed ran, and the next start would skip both.
 */
const LOCAL_STATE = ".alchemy/state";
const STOP_TIMEOUT_MS = 20_000;

class DevError extends Schema.TaggedError<DevError>()("DevError", {
  message: Schema.String,
}) {}

const fail = (message: string) => new DevError({ message });

/** This checkout's Shopify dev store from `.env`; see the module JSDoc. */
const loadStore = Config.NonEmptyString("SHOPIFY_DEV_STORE").pipe(
  Effect.mapError(() =>
    fail(
      "SHOPIFY_DEV_STORE is not set: add it to .env (mw10013-dev-shop-NN, NN the worktree index)",
    ),
  ),
);

const ClientId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const ClientIdLine = Schema.TemplateLiteralParser(['client_id = "', ClientId, '"']);
const decodeClientIdLine = Schema.decodeUnknownOption(ClientIdLine);

/** The app's client id, from the `client_id = "…"` line of `shopify.app.toml`. */
const loadClientId = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const toml = yield* fs
    .readFileString(path.join(ROOT, "shopify.app.toml"))
    .pipe(Effect.mapError(() => fail("shopify.app.toml is missing")));
  return yield* Effect.fromOption(
    Array.findFirst(toml.split("\n"), (line) =>
      Option.map(decodeClientIdLine(line.trim()), ([, id]) => id),
    ),
  ).pipe(Effect.mapError(() => fail('shopify.app.toml has no client_id = "<32 hex>" line')));
});

/** The app inside the store's admin, the URL a person opens to see the embedded App Home. */
const adminUrl = (store: string, clientId: string) =>
  `https://admin.shopify.com/store/${store}/apps/${clientId}`;

/** The port from `.env`, which the package scripts require with `--env-file`. */
const loadPort = Config.Port("WEBSITE_PORT").pipe(
  Effect.mapError(() =>
    fail("WEBSITE_PORT is not set to a port: run through the package scripts, which load .env"),
  ),
);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One line per step with its duration; a failing step says so before its error. */
const step = Effect.fn("step")(function* <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) {
  const started = Date.now();
  const result = yield* effect.pipe(
    Effect.tapError(() => Console.log(`fail  ${label} (${seconds(Date.now() - started)})`)),
  );
  yield* Console.log(`ok    ${label} (${seconds(Date.now() - started)})`);
  return result;
});

/** Polls `check` every `intervalMs` until it is true; false once `timeoutMs` passes first. */
const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeoutMs: number,
  intervalMs: number,
) =>
  check.pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(intervalMs) }),
    Effect.timeoutOption(timeoutMs),
    Effect.map(Option.isSome),
  );

const cwdOf = (pid: number) =>
  runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).pipe(
    Effect.map((output) =>
      Option.fromUndefinedOr(
        output
          .split("\n")
          .find((line) => line.startsWith("n"))
          ?.slice(1),
      ),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/** The processes `pgrep -f pattern` finds whose working directory is this checkout. */
const checkoutPids = (pattern: string) =>
  runCommand("pgrep", ["-f", pattern]).pipe(
    Effect.map(pidsFrom),
    Effect.orElseSucceed((): number[] => []),
    Effect.flatMap((pids) =>
      Effect.forEach(pids, (pid) =>
        cwdOf(pid).pipe(Effect.map((cwd) => (Option.contains(cwd, ROOT) ? [pid] : []))),
      ),
    ),
    Effect.map((pids) => pids.flat()),
  );

/**
 * This checkout's server processes: Shopify CLI's `app dev` on the dev store (see
 * {@link cliPattern}) and Alchemy's CLI process running `alchemy dev`, whose exit ends the
 * `web:dev` pipeline. Both are listed, because a SIGINT to the CLI alone leaves Alchemy's tree running on the port.
 */
const serverPids = Effect.all([
  loadStore.pipe(Effect.flatMap((store) => checkoutPids(cliPattern(store)))),
  serverProcess.pipe(Effect.flatMap(checkoutPids)),
]).pipe(Effect.map(([cli, alchemy]) => [...cli, ...alchemy]));

/**
 * `pids` and every process below them: Alchemy runs the Website's Vite and
 * the Backend's `workerd` as children, and the Backend listens on an
 * ephemeral port no port check finds.
 */
const withDescendants = (pids: readonly number[]) =>
  runCommand("ps", ["-A", "-o", "pid=,ppid="]).pipe(
    Effect.map((output) => {
      const children = new Map<number, number[]>();
      for (const line of output.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
        if (pid === undefined || ppid === undefined) continue;
        children.set(ppid, [...(children.get(ppid) ?? []), pid]);
      }
      const found = new Set<number>();
      const visit = (pid: number) => {
        if (found.has(pid)) return;
        found.add(pid);
        for (const child of children.get(pid) ?? []) visit(child);
      };
      for (const pid of pids) visit(pid);
      return [...found];
    }),
  );

/** The herdr pane whose foreground process is this checkout's `shopify app dev` or `alchemy dev`. */
const findServerPane = Effect.gen(function* () {
  if (!(yield* Herdr.running)) return Option.none<Herdr.Pane>();
  const panes = yield* Herdr.listPanes;
  const command = yield* serverProcess;
  const isDevCli = isCliCommand(yield* loadStore);
  const hosting = yield* Effect.forEach(
    panes,
    (pane) =>
      Herdr.processInfo(pane.pane_id).pipe(
        Effect.map(({ processes }) =>
          processes.some(
            (process) =>
              (isDevCli(process.argv.join(" ")) || process.argv.join(" ").includes(command)) &&
              (process.cwd === undefined || process.cwd === ROOT),
          )
            ? [pane]
            : [],
        ),
        Effect.orElseSucceed((): Herdr.Pane[] => []),
      ),
    { concurrency: 4 },
  );
  return Array.head(hosting.flat());
}).pipe(Effect.orElseSucceed(() => Option.none<Herdr.Pane>()));

/** This checkout's server: its processes and, in herdr, the pane it runs in. */
const findServer = Effect.all({ pids: serverPids, pane: findServerPane });

const describeServer = (server: Effect.Success<typeof findServer>) =>
  Option.match(server.pane, {
    onSome: (pane) => `herdr pane ${pane.pane_id}`,
    onNone: () =>
      server.pids.length > 0
        ? `pid ${server.pids.join(", ")} (background, or a terminal outside herdr)`
        : "not running",
  });

/** Sends `signal` to `pid`; a process that is already gone is not an error. */
const signal = (pid: number, signal: NodeJS.Signals | 0) =>
  Effect.try(() => process.kill(pid, signal)).pipe(Effect.option, Effect.map(Option.isSome));

const processAlive = (pid: number) => signal(pid, 0);

const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(ROOT, ".logs"), { recursive: true });
      const lock = path.join(ROOT, LOCK);
      const holder = yield* fs.readFileString(lock).pipe(
        Effect.map((text) =>
          Option.filter(Result.getSuccess(decodePid(text.trim())), (pid) => pid !== process.pid),
        ),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      if (Option.isSome(holder) && (yield* processAlive(holder.value)))
        return yield* fail(
          `another dev command (pid ${String(holder.value)}) holds ${LOCK}; wait for it to finish`,
        );
      yield* fs.writeFileString(lock, String(process.pid));
    }),
    () => effect,
    () =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(path.join(ROOT, LOCK), { force: true })),
        Effect.ignore,
      ),
  );

/**
 * Stops this checkout's server wherever it runs. In a pane it presses Ctrl-C,
 * as a person would: the whole foreground group exits and the pane is left
 * at its prompt. Otherwise, or when a pane ignores Ctrl-C for
 * {@link STOP_TIMEOUT_MS}, it sends SIGTERM to the server's processes (the CLI
 * and Alchemy's, {@link serverPids}), their descendants (the tunnel's
 * `cloudflared`, Vite, `workerd`) and whatever listens on the port, then waits
 * for all of them to be gone.
 */
const stopServer = Effect.fn("stopServer")(function* (port: number) {
  const server = yield* findServer;
  const listeners = yield* portListeners(port);
  if (server.pids.length === 0 && listeners.length === 0) {
    yield* Console.log("no dev server running");
    return;
  }
  const terminate = Effect.all([serverPids, portListeners(port)]).pipe(
    Effect.flatMap(([pids, ports]) => withDescendants([...pids, ...ports])),
    Effect.flatMap((pids) =>
      Effect.forEach(pids, (pid) => signal(pid, "SIGTERM"), { discard: true }),
    ),
  );
  const stopped = Effect.all([serverPids, portListeners(port)]).pipe(
    Effect.map(([pids, ports]) => pids.length === 0 && ports.length === 0),
  );
  if (Option.isSome(server.pane)) {
    yield* Herdr.sendKeys(server.pane.value.pane_id, "ctrl+c");
    if (!(yield* waitUntil(stopped, STOP_TIMEOUT_MS, 500))) yield* terminate;
  } else yield* terminate;
  if (!(yield* waitUntil(stopped, STOP_TIMEOUT_MS, 500)))
    return yield* fail(
      `port ${String(port)} is still held after SIGTERM; check with lsof -i :${String(port)}`,
    );
});

type Placement =
  | { readonly _tag: "Foreground" }
  | { readonly _tag: "Pane"; readonly paneId: string }
  | { readonly _tag: "Background" };
const Placement = {
  Foreground: { _tag: "Foreground" } as Placement,
  Background: { _tag: "Background" } as Placement,
  Pane: (paneId: string): Placement => ({ _tag: "Pane", paneId }),
};

const isTty = () => process.stdin.isTTY && process.stdout.isTTY;

/**
 * The workspace herdr has open on this checkout, opened if needed. A
 * worktree's workspace is grouped under the main checkout's, so that one is
 * opened first.
 */
const checkoutWorkspace = Effect.gen(function* () {
  const open = yield* Herdr.checkoutWorkspace(ROOT);
  if (Option.isSome(open)) return open.value;
  const { linked, mainCheckout } = yield* checkoutKind;
  const openMain = (checkout: string) =>
    Herdr.openMainCheckout(checkout, path.basename(checkout)).pipe(
      Effect.tap(() => Console.log(`ok    opened herdr workspace ${path.basename(checkout)}`)),
    );
  if (!linked) return yield* openMain(ROOT);
  const mainWorkspaceId = yield* Herdr.checkoutWorkspace(mainCheckout).pipe(
    Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => openMain(mainCheckout) })),
  );
  const label = yield* currentBranch;
  yield* Herdr.openLinkedWorktree({ mainWorkspaceId, path: ROOT, label });
  yield* Console.log(`ok    opened herdr workspace ${label}`);
  return yield* Herdr.checkoutWorkspace(ROOT).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.mapError(() => fail(`herdr opened no workspace on ${ROOT}`)),
  );
});

/** An idle pane of `tabId` in layout order, or a new split. */
const idlePaneIn = Effect.fn("idlePaneIn")(function* (tabId: string) {
  const first = yield* Effect.fromOption(
    Array.findFirst(yield* Herdr.listPanes, (pane) => pane.tab_id === tabId),
  ).pipe(Effect.mapError(() => fail(`the "${DEV_TAB}" tab has no panes`)));
  const ordered = yield* Herdr.panesInLayoutOrder(first.pane_id);
  const idle = yield* Effect.findFirst(ordered, (pane) =>
    Herdr.processInfo(pane).pipe(Effect.map(({ idle }) => idle)),
  );
  return yield* Option.match(idle, {
    onSome: Effect.succeed,
    onNone: () => Herdr.splitPane(ordered[0] ?? first.pane_id, ROOT),
  });
});

/** Where a new server runs: rules 2 to 4 of the module JSDoc (rule 1, adoption, is the caller's). */
const placeServer = Effect.gen(function* () {
  if (!(yield* Herdr.running)) return isTty() ? Placement.Foreground : Placement.Background;
  const workspaceId = yield* checkoutWorkspace;
  const devTab = Array.findFirst(
    yield* Herdr.listTabs(workspaceId),
    (tab) => tab.label === DEV_TAB,
  );
  if (isTty() && Option.isSome(devTab) && Option.contains(Herdr.callerTabId(), devTab.value.tab_id))
    return Placement.Foreground;
  const paneId = yield* Option.match(devTab, {
    onNone: () => Herdr.createTab({ workspaceId, cwd: ROOT, label: DEV_TAB }),
    onSome: (tab) => idlePaneIn(tab.tab_id),
  });
  return Placement.Pane(paneId);
});

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Three scripts, so starting does not recurse and the public entry point applies adoption and
 * the lock: `dev` is this launcher, `app:dev` the CLI it starts, `dev:alchemy` the server the
 * CLI runs as its web command (`shopify.web.toml`).
 */
const runDev = (options: ChildProcess.CommandOptions) =>
  ChildProcess.make("vp", ["run", "app:dev"], { cwd: ROOT, ...options });

/**
 * Starts the server where {@link placeServer} says. A foreground start returns
 * the handle of `vp run app:dev`, which owns the caller's terminal until it exits;
 * the other placements return once the server is launched and outlive the
 * command.
 */
const launchServer = Effect.fn("launchServer")(function* (placement: Placement) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Match.valueTags(placement, {
    Pane: ({ paneId }) =>
      Effect.gen(function* () {
        yield* waitUntil(
          Herdr.processInfo(paneId).pipe(Effect.map(({ idle }) => idle)),
          10_000,
          250,
        );
        yield* Herdr.runInPane(paneId, `cd ${shellQuote(ROOT)} && vp run app:dev`);
        yield* Console.log(`ok    started in herdr tab "${DEV_TAB}" (pane ${paneId})`);
        return Option.none<ChildProcessSpawner.ChildProcessHandle>();
      }),
    Background: () =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          runDev({ stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }),
        );
        // Unreferenced, the process survives this command's scope closing.
        yield* handle.unref;
        yield* Console.log(`ok    started in the background (pid ${String(handle.pid)})`);
        return Option.none<ChildProcessSpawner.ChildProcessHandle>();
      }),
    Foreground: () =>
      spawner
        .spawn(runDev({ stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: false }))
        .pipe(Effect.map(Option.some)),
  });
});

const waitAnswering = (port: number) =>
  step(
    "server answering",
    waitUntil(answering(port), START_TIMEOUT_MS, 1000).pipe(
      Effect.filterOrFail(
        (answered) => answered,
        () =>
          fail(
            `no answer on port ${String(port)} after ${String(START_TIMEOUT_MS / 1000)}s; see vp run dev:logs`,
          ),
      ),
    ),
  );

/** What `start` and `status` report about the app: its admin URL and the tunnel. */
const appReport = Effect.fn("appReport")(function* (port: number, store: Option.Option<string>) {
  const clientId = yield* loadClientId.pipe(Effect.option);
  return {
    app: Option.getOrNull(
      Option.flatMap(store, (name) => Option.map(clientId, (id) => adminUrl(name, id))),
    ),
    tunnel: Option.getOrNull(yield* findTunnelUrl(port)),
  };
});

const summarize = Effect.fn("summarize")(function* (port: number, store: string, where: string) {
  const { app, tunnel } = yield* appReport(port, Option.some(store));
  yield* Console.log(
    [
      "",
      `server: ${where}`,
      `dev:    http://localhost:${String(port)}`,
      `app:    ${app ?? "(no client_id in shopify.app.toml)"}`,
      `tunnel: ${tunnel ?? "(none: the server is not running under shopify app dev)"}`,
      `logs:   ${LOG}`,
    ].join("\n"),
  );
});

/** Every failure a command can raise carries a message for the person at the terminal. */
const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

/**
 * Starts the server, or adopts the one running; see the module JSDoc. `afterReady` runs once the
 * server answers and is summarized, also beside a foreground server, which holds the terminal
 * until it exits.
 */
const startServer = <E extends { readonly message: string }, R>(
  afterReady: Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const port = yield* loadPort;
    const store = yield* loadStore;
    const foreground = yield* withLock(
      Effect.gen(function* () {
        const server = yield* findServer;
        if (server.pids.length > 0) {
          yield* Console.log(`ok    adopted the running server: ${describeServer(server)}`);
          yield* waitAnswering(port);
          yield* summarize(port, store, describeServer(server));
          yield* afterReady;
          return Option.none();
        }
        if ((yield* portListeners(port)).length > 0)
          return yield* fail(
            `port ${String(port)} is held by another process: lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`,
          );
        const placement = yield* placeServer;
        const handle = yield* launchServer(placement);
        if (Option.isSome(handle)) return handle;
        yield* waitAnswering(port);
        yield* summarize(
          port,
          store,
          Match.valueTags(placement, {
            Pane: ({ paneId }) => `herdr tab "${DEV_TAB}" (pane ${paneId})`,
            Background: () => "background",
            Foreground: () => "this terminal",
          }),
        );
        yield* afterReady;
        return Option.none();
      }),
    );
    // The lock is released before waiting on a foreground server, so an agent can adopt it.
    if (Option.isSome(foreground)) {
      yield* waitAnswering(port).pipe(
        Effect.flatMap(() => summarize(port, store, "this terminal")),
        Effect.flatMap(() => afterReady),
        Effect.catch((error) => Console.error(`dev: ${error.message}`)),
        Effect.forkChild,
      );
      yield* foreground.value.exitCode;
    }
  }).pipe(Effect.scoped);

const startCommand = Command.make("start", {}, () =>
  startServer(Effect.void).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Start the dev server, or adopt the one already running."));

const stopCommand = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const port = yield* loadPort;
    yield* withLock(step("stop", stopServer(port)));
  }).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Stop the dev server wherever it runs."));

/**
 * What `db:reset` does once the server answers: a reset leaves the dev store without its
 * `ShopSession`, which only an embedded load writes, so it opens the app in the default browser,
 * where the person is already signed in to Shopify, then applies the dev fixture, waiting for that
 * load. Where `open` is missing, it prints the URL to open instead.
 */
const openAppAndApplyFixture = Effect.gen(function* () {
  const url = adminUrl(yield* loadStore, yield* loadClientId);
  yield* step(`open ${url}`, runCommand("open", [url])).pipe(
    Effect.catch(() => Console.log(`open   ${url} in a browser signed in to Shopify`)),
  );
  yield* applyFixture({ waitForInstall: true }).pipe(
    Effect.mapError((error) => fail(error.message)),
  );
});

const dbResetCommand = Command.make("db:reset", {}, () =>
  Effect.gen(function* () {
    const port = yield* loadPort;
    yield* withLock(step("stop", stopServer(port)));
    const fs = yield* FileSystem.FileSystem;
    for (const dir of [LOCAL_DATA, LOCAL_STATE])
      yield* step(
        `remove ${dir}`,
        fs.remove(path.join(ROOT, dir), { recursive: true, force: true }),
      );
    yield* startServer(openAppAndApplyFixture);
  }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Reset the dev database: stop, remove local data and local state, start, open the app in the dev store, and apply the dev fixture.",
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
      const port = yield* loadPort;
      const server = yield* findServer;
      const listening = (yield* portListeners(port)).length > 0;
      const serving = listening && (yield* answering(port));
      const healthy = server.pids.length > 0 && serving;
      const store = yield* Config.option(Config.NonEmptyString("SHOPIFY_DEV_STORE")).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      );
      const { app, tunnel } = yield* appReport(port, store);
      const tunnelSeen = tunnel === null ? null : yield* tunnelState(tunnel);
      const report = {
        healthy,
        server: describeServer(server),
        pids: server.pids,
        pane: Option.getOrNull(Option.map(server.pane, (pane) => pane.pane_id)),
        port,
        url: `http://localhost:${String(port)}`,
        listening,
        answering: serving,
        store: Option.getOrNull(store),
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
              `store:   ${report.store ?? "(SHOPIFY_DEV_STORE is not set in .env)"}`,
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
  ({ lines }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs
        .readFileString(path.join(ROOT, LOG))
        .pipe(Effect.orElseSucceed(() => `(no ${LOG})`));
      yield* Console.log(
        text
          .split("\n")
          .slice(-lines - 1)
          .join("\n"),
      );
    }),
).pipe(Command.withDescription(`Print the tail of ${LOG}.`));

Command.make("dev").pipe(
  Command.withDescription(
    [
      "Run this checkout's dev server (vp run app:dev: shopify app dev, which runs alchemy dev) for an agent or a person.",
      "Where it runs, first match wins:",
      "  1. a server already running for this checkout is adopted;",
      `  2. with herdr running: the checkout's workspace, tab "${DEV_TAB}" (opened if needed);`,
      `     typed by a person in that tab, this terminal; otherwise an idle pane there;`,
      "  3. without herdr, typed in a terminal: this terminal;",
      "  4. otherwise: in the background.",
      `Output always goes to ${LOG}.`,
    ].join("\n"),
  ),
  Command.withSubcommands([startCommand, stopCommand, dbResetCommand, statusCommand, logsCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
