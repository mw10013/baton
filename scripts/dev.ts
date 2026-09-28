#!/usr/bin/env node
/**
 * `pnpm dev:start | dev:stop | dev:status | dev:reset | dev:logs`: one command
 * that an agent and a person both use to get the local dev server running,
 * optionally from wiped state, and to find it again.
 *
 * The server is `pnpm app:dev` (the Shopify CLI, which runs `pnpm dev`), never
 * `pnpm dev` alone: `automatically_update_urls_on_dev` points the app at this
 * session's tunnel, and the admin cannot load the embedded app without it.
 * Its `--config` is read from the `app:dev` script, so that script stays the
 * one definition of how the server starts; the store is `SHOPIFY_DEV_STORE`
 * in `.env`, which `app:dev` passes as `--store`, so each checkout (git
 * worktree) serves its own store.
 *
 * Where the server runs, decided by {@link placeServer}; the first rule that
 * applies wins:
 *
 * 1. A `shopify app dev` already serving this checkout, wherever it runs, is
 *    adopted: `start` leaves it running, `stop` and `reset` stop it, whoever
 *    started it. It is found by process and working directory, not by label.
 * Inside Herdr, the server belongs to the checkout's workspace: the one Herdr
 * has open on this checkout (`herdr worktree list`), which for a linked
 * worktree is not the caller's when the command is run from another
 * checkout's workspace. With none open, the caller's workspace.
 *
 * 2. Inside Herdr, typed by a person (a TTY) in the checkout's workspace with
 *    no tab labelled `server`: the caller's tab becomes the `server` tab and
 *    the server runs in the caller's pane, in the foreground.
 * 3. Inside Herdr, typed by a person in the `server` tab: the caller's pane,
 *    in the foreground.
 * 4. Inside Herdr otherwise (an agent, a person typing in another tab, or a
 *    caller in another workspace): an idle pane of the checkout workspace's
 *    `server` tab, preferring the pane a `reset` just stopped, then layout
 *    order; a new split when none is idle; a new tab labelled `server` when
 *    there is none. It never types into a busy pane, and never renames an
 *    agent's tab.
 * 5. Outside Herdr, typed by a person: the caller's terminal, in the
 *    foreground.
 * 6. Otherwise: a detached background process logging to `logs/local-cli.log`.
 *
 * Install: after a wipe, the dev shop has no `ShopSession` row until the
 * embedded app loads in a logged-in admin and its token exchange writes one.
 * The command opens the app's admin URL in the default browser, exactly what
 * the CLI's `p` key does, and waits for the row in local D1.
 *
 * `start`, `stop` and `reset` hold `logs/dev.lock` so parallel agents in one
 * checkout cannot start two servers.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Data, Effect, FileSystem, Option, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCommand } from "./lib/command.ts";
import { getDatabaseName, queryLocal, readText, resetLocal } from "./lib/d1.ts";
import * as Herdr from "./lib/herdr.ts";
import { seed } from "./lib/seed.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const CLI_LOG = "logs/local-cli.log";
const WORKER_LOG = "logs/local-worker.log";
const LOCK = "logs/dev.lock";
const SERVER_TAB = "server";
const CLI_PROCESS = "shopify app dev";
const START_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 20_000;

class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
}> {}
class LockHeld extends Data.TaggedError("LockHeld")<{
  readonly message: string;
}> {}
class StopFailed extends Data.TaggedError("StopFailed")<{
  readonly message: string;
}> {}
class StartTimedOut extends Data.TaggedError("StartTimedOut")<{
  readonly message: string;
}> {}
class InstallTimedOut extends Data.TaggedError("InstallTimedOut")<{
  readonly message: string;
}> {}

const PackageJson = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Struct({ "app:dev": Schema.String }) }),
);

/** Everything the command derives from `.env`, `package.json`, the app config and `wrangler.jsonc`. */
const loadConfig = Effect.gen(function* () {
  const port = process.env.PORT;
  if (port === undefined)
    return yield* new ConfigError({
      message:
        "PORT is missing: run through the package scripts, which load .env",
    });
  const appDev = (yield* Schema.decodeUnknownEffect(PackageJson)(
    yield* readText("package.json"),
  )).scripts["app:dev"];
  const appConfig = /--config\s+(?<config>\S+)/u.exec(appDev)?.groups?.config;
  if (appConfig === undefined)
    return yield* new ConfigError({
      message: `the app:dev script must pass --config: ${appDev}`,
    });
  const store = process.env.SHOPIFY_DEV_STORE;
  if (store === undefined || store === "")
    return yield* new ConfigError({
      message: "SHOPIFY_DEV_STORE is missing from .env",
    });
  const clientId = /^client_id\s*=\s*"(?<clientId>[^"]+)"/mu.exec(
    yield* readText(appConfig),
  )?.groups?.clientId;
  if (clientId === undefined)
    return yield* new ConfigError({
      message: `no client_id in ${appConfig}`,
    });
  return {
    port,
    shop: `${store}.myshopify.com`,
    appUrl: `https://admin.shopify.com/store/${store}/apps/${clientId}`,
    databaseName: yield* getDatabaseName("local"),
  } as const;
});
type Config = Effect.Success<typeof loadConfig>;

const elapsed = (started: number) =>
  `${((Date.now() - started) / 1000).toFixed(1)}s`;

/** One line per step with its duration; a failing step says so before its error. */
const step = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = Date.now();
    const result = yield* effect.pipe(
      Effect.tapError(() =>
        Console.log(`fail  ${label} (${elapsed(started)})`),
      ),
    );
    yield* Console.log(`ok    ${label} (${elapsed(started)})`);
    return result;
  });

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeoutMs: number,
  intervalMs: number,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!(yield* check)) {
      if (Date.now() > deadline) return false;
      yield* Effect.sleep(intervalMs);
    }
    return true;
  });

const pidsFrom = (output: string) =>
  output
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

const cwdOf = (pid: number) =>
  runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .find((line) => line.startsWith("n"))
        ?.slice(1),
    ),
    Effect.option,
    Effect.map(Option.flatMap(Option.fromUndefinedOr)),
  );

/** Processes of a `shopify app dev` serving this checkout (the CLI and the shell pnpm ran it in). */
const serverPids = runCommand("pgrep", ["-f", CLI_PROCESS]).pipe(
  Effect.map(pidsFrom),
  Effect.orElseSucceed((): number[] => []),
  Effect.flatMap((pids) =>
    Effect.all(
      pids.map((pid) =>
        cwdOf(pid).pipe(
          Effect.map((cwd) =>
            Option.getOrUndefined(cwd) === ROOT ? [pid] : [],
          ),
        ),
      ),
    ),
  ),
  Effect.map((pids) => pids.flat()),
);

const portListeners = (port: string) =>
  runCommand("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN", "-nP"]).pipe(
    Effect.map(pidsFrom),
    Effect.orElseSucceed((): number[] => []),
  );

/** Any HTTP answer counts: the first request after a start waits on Vite's compile. */
const answering = (url: string, timeoutMs: number) =>
  Effect.tryPromise(() =>
    fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }),
  ).pipe(Effect.option);

const serverAnswering = (config: Config) =>
  answering(`http://127.0.0.1:${config.port}/`, 10_000).pipe(
    Effect.map(Option.isSome),
  );

const hasShopSession = (config: Config) =>
  queryLocal(
    config.databaseName,
    `select 1 from ShopSession where shop = '${config.shop}'`,
  ).pipe(
    Effect.map((rows) => rows.length > 0),
    // Before migrations have run there is no table, which means no session.
    Effect.orElseSucceed(() => false),
  );

/** The Herdr pane whose foreground process is this checkout's `shopify app dev`. */
const findServerPane = Effect.gen(function* () {
  if (!Herdr.inHerdr()) return Option.none<Herdr.Pane>();
  const panes = yield* Herdr.listPanes;
  const hosting = yield* Effect.forEach(
    panes,
    (pane) =>
      Herdr.processInfo(pane.pane_id).pipe(
        Effect.map(({ processes }) =>
          processes.some(
            (process) =>
              process.argv.join(" ").includes(CLI_PROCESS) &&
              (process.cwd === undefined || process.cwd === ROOT),
          )
            ? [pane]
            : [],
        ),
        Effect.orElseSucceed((): Herdr.Pane[] => []),
      ),
    { concurrency: 4 },
  );
  return Option.fromUndefinedOr(hosting.flat()[0]);
});

/**
 * This checkout's server: its processes and, inside Herdr, the pane it runs in
 * and that pane's tab label. The pane ID is stable while the pane lives,
 * wherever its tab is moved; the label is what a person looks for.
 */
const findServer = Effect.gen(function* () {
  const pids = yield* serverPids;
  const hostPane = yield* findServerPane;
  const tab = yield* hostPane.pipe(
    Option.match({
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (pane) =>
        Herdr.listTabs(pane.workspace_id).pipe(
          Effect.map((tabs) =>
            Option.fromUndefinedOr(
              tabs.find((tab) => tab.tab_id === pane.tab_id)?.label,
            ),
          ),
          Effect.orElseSucceed(() => Option.none<string>()),
        ),
    }),
  );
  return {
    pids,
    pane: hostPane.pipe(Option.map((pane) => pane.pane_id)),
    tab,
  } as const;
});

const describePane = (paneId: string, tab: Option.Option<string>) =>
  Option.match(tab, {
    onSome: (label) => `tab "${label}" (pane ${paneId})`,
    onNone: () => `Herdr pane ${paneId}`,
  });

const describeServer = (server: Effect.Success<typeof findServer>) =>
  Option.match(server.pane, {
    onSome: (pane) => describePane(pane, server.tab),
    onNone: () =>
      server.pids.length > 0
        ? `pid ${server.pids.join(", ")} (background, or a terminal outside Herdr; background output goes to ${CLI_LOG})`
        : "not running",
  });

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const acquireLock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory("logs", { recursive: true });
  const holder = yield* fs.readFileString(LOCK).pipe(
    Effect.map((text) => Number(text.trim())),
    Effect.orElseSucceed(() => 0),
  );
  if (holder > 0 && holder !== process.pid && processAlive(holder))
    return yield* new LockHeld({
      message: `another dev command (pid ${String(holder)}) holds ${LOCK}; wait for it to finish`,
    });
  return yield* fs.writeFileString(LOCK, String(process.pid));
});

const releaseLock = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.remove(LOCK, { force: true })),
  Effect.ignore,
);

const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    acquireLock,
    () => effect,
    () => releaseLock,
  );

/**
 * Stops this checkout's server wherever it runs and returns the Herdr pane it
 * ran in, if any, so a restart can reuse it. In a pane it presses Ctrl-C, as a
 * person would: the whole foreground group, the CLI and its `vite dev`,
 * exits and the pane is left at its prompt. Otherwise it sends SIGTERM to the
 * CLI and to whatever listens on the port, because a CLI terminated by signal
 * leaves its `vite dev` child holding the port (seen 2026-09-27), and a bare
 * `pnpm dev` holds it too. A pane that ignores Ctrl-C gets the same signals
 * after {@link STOP_TIMEOUT_MS}.
 */
const stopServer = (config: Config) =>
  Effect.gen(function* () {
    const server = yield* findServer;
    const listeners = yield* portListeners(config.port);
    if (server.pids.length === 0 && listeners.length === 0) {
      yield* Console.log("no dev server running");
      return Option.none<string>();
    }
    const terminate = Effect.all([serverPids, portListeners(config.port)]).pipe(
      Effect.flatMap(([pids, ports]) =>
        Effect.sync(() => {
          for (const pid of [...pids, ...ports])
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              // Already gone.
            }
        }),
      ),
    );
    const stopped = Effect.all([serverPids, portListeners(config.port)]).pipe(
      Effect.map(([pids, ports]) => pids.length === 0 && ports.length === 0),
    );
    if (Option.isSome(server.pane)) {
      yield* Herdr.sendKeys(server.pane.value, "ctrl+c");
      if (!(yield* waitUntil(stopped, STOP_TIMEOUT_MS, 500))) yield* terminate;
    } else yield* terminate;
    if (!(yield* waitUntil(stopped, STOP_TIMEOUT_MS, 500)))
      return yield* new StopFailed({
        message: `port ${config.port} is still held after SIGTERM; check with lsof -i :${config.port}`,
      });
    return server.pane;
  });

type Placement =
  | { readonly _tag: "Foreground" }
  | { readonly _tag: "Pane"; readonly paneId: string }
  | { readonly _tag: "Background" };

const isTty = () => process.stdin.isTTY && process.stdout.isTTY;

/** An idle pane of `tabId` (the preferred one first, then layout order), or a new split. */
const idlePaneIn = (tabId: string, preferred: Option.Option<string>) =>
  Effect.gen(function* () {
    const panes = (yield* Herdr.listPanes).filter(
      (pane) => pane.tab_id === tabId,
    );
    const [first] = panes;
    if (first === undefined)
      return yield* new ConfigError({
        message: `the "${SERVER_TAB}" tab has no panes`,
      });
    const ordered = yield* Herdr.panesInLayoutOrder(first.pane_id);
    const candidates = Option.match(preferred, {
      onSome: (pane) =>
        ordered.includes(pane)
          ? [pane, ...ordered.filter((id) => id !== pane)]
          : ordered,
      onNone: () => ordered,
    });
    for (const pane of candidates)
      if ((yield* Herdr.processInfo(pane)).idle) return pane;
    return yield* Herdr.splitPane(ordered[0] ?? first.pane_id, ROOT);
  });

/** Where a new server runs: rules 2 to 6 of the module JSDoc (rule 1, adoption, is the caller's). */
const placeServer = (preferred: Option.Option<string>) =>
  Effect.gen(function* () {
    const callerWorkspaceId = process.env.HERDR_WORKSPACE_ID;
    const tabId = process.env.HERDR_TAB_ID;
    if (
      !Herdr.inHerdr() ||
      callerWorkspaceId === undefined ||
      tabId === undefined
    )
      return isTty()
        ? ({ _tag: "Foreground" } as const)
        : ({ _tag: "Background" } as const);
    const workspaceId = Option.getOrElse(
      yield* Herdr.checkoutWorkspace(ROOT).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
      () => callerWorkspaceId,
    );
    const inCallerWorkspace = workspaceId === callerWorkspaceId;
    const serverTab = (yield* Herdr.listTabs(workspaceId)).find(
      (tab) => tab.label === SERVER_TAB,
    );
    if (inCallerWorkspace && isTty() && serverTab === undefined) {
      yield* Herdr.renameTab(tabId, SERVER_TAB);
      yield* Console.log(`this tab is now the "${SERVER_TAB}" tab`);
      return { _tag: "Foreground" } as const;
    }
    if (isTty() && serverTab?.tab_id === tabId)
      return { _tag: "Foreground" } as const;
    const paneId =
      serverTab === undefined
        ? yield* Herdr.createTab({ workspaceId, cwd: ROOT, label: SERVER_TAB })
        : yield* idlePaneIn(serverTab.tab_id, preferred);
    return { _tag: "Pane", paneId } as const;
  });

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Starts the server where {@link placeServer} says. A foreground start returns
 * the handle of the CLI, which owns the caller's terminal until it exits; the
 * other placements return once the server is launched and outlive the
 * command. `detached: false` in the foreground keeps the CLI in the
 * terminal's foreground process group, so it can read keys (`p`, `q`) and
 * receives Ctrl-C.
 */
const launchServer = (placement: Placement) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    switch (placement._tag) {
      case "Foreground": {
        break;
      }
      case "Pane": {
        yield* waitUntil(
          Herdr.processInfo(placement.paneId).pipe(
            Effect.map(({ idle }) => idle),
          ),
          10_000,
          250,
        );
        yield* Herdr.runInPane(
          placement.paneId,
          `cd ${shellQuote(ROOT)} && pnpm app:dev`,
        );
        yield* Console.log(
          `ok    started in ${describePane(placement.paneId, Option.some(SERVER_TAB))}`,
        );
        return Option.none();
      }
      case "Background": {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory("logs", { recursive: true });
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            "sh",
            ["-c", `exec pnpm app:dev > ${CLI_LOG} 2>&1`],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          ),
        );
        // Unreferenced, the process survives this command's scope closing.
        yield* handle.unref;
        yield* Console.log(
          `ok    started in the background (pid ${String(handle.pid)}), logging to ${CLI_LOG}`,
        );
        return Option.none();
      }
    }
    const handle = yield* spawner.spawn(
      ChildProcess.make("pnpm", ["app:dev"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false,
      }),
    );
    return Option.some(handle);
  });

/**
 * What every start ends with: wait for the server to answer, install the app
 * on the dev shop when it has no `ShopSession`, and seed when asked.
 */
const finishStart = (config: Config, options: { readonly seed: boolean }) =>
  Effect.gen(function* () {
    yield* step(
      "server answering",
      waitUntil(serverAnswering(config), START_TIMEOUT_MS, 1000).pipe(
        Effect.filterOrFail(
          (answered) => answered,
          () =>
            new StartTimedOut({
              message: `no answer on port ${config.port} after ${String(START_TIMEOUT_MS / 1000)}s; see pnpm dev:logs`,
            }),
        ),
      ),
    );
    const installed = !(yield* hasShopSession(config));
    if (installed)
      yield* step(
        "install: opened the app in your default browser",
        runCommand("open", [config.appUrl]).pipe(
          Effect.andThen(
            waitUntil(hasShopSession(config), INSTALL_TIMEOUT_MS, 3000),
          ),
          Effect.filterOrFail(
            (installed) => installed,
            () =>
              new InstallTimedOut({
                message: `no ShopSession for ${config.shop} after ${String(INSTALL_TIMEOUT_MS / 1000)}s: log into the store's admin in your default browser, then run pnpm dev:start`,
              }),
          ),
        ),
      );
    const seeded = options.seed
      ? yield* step(
          "seed",
          seed({ port: config.port, shop: config.shop }),
        ).pipe(Effect.as(true))
      : false;
    return { installed, seeded } as const;
  });

const summarize = (
  config: Config,
  where: string,
  result: Effect.Success<ReturnType<typeof finishStart>>,
) =>
  Console.log(
    [
      "",
      `server: ${where}`,
      `local:  http://localhost:${config.port}`,
      `shop:   ${config.shop} (${result.installed ? "installed now" : "already installed"})`,
      `seeded: ${result.seeded ? "yes" : "no"}`,
    ].join("\n"),
  );

/**
 * Launches a server and finishes the start. In the foreground the finishing
 * steps run beside the CLI, their lines interleaving with its panel, and a
 * failure there is reported without stopping the server.
 */
const launchAndFinish = (
  config: Config,
  options: {
    readonly seed: boolean;
    readonly preferred: Option.Option<string>;
  },
) =>
  Effect.gen(function* () {
    const placement = yield* placeServer(options.preferred);
    const foreground = yield* launchServer(placement);
    if (Option.isSome(foreground)) {
      yield* finishStart(config, options).pipe(
        Effect.flatMap((result) => summarize(config, "this terminal", result)),
        Effect.catch((error) => Console.error(`dev: ${error.message}`)),
      );
      return foreground;
    }
    const result = yield* finishStart(config, options);
    yield* summarize(
      config,
      placement._tag === "Pane"
        ? describePane(placement.paneId, Option.some(SERVER_TAB))
        : `background, log ${CLI_LOG} (pnpm dev:logs)`,
      result,
    );
    return Option.none();
  });

/**
 * Runs a locked start or reset, then, when the server took this terminal,
 * waits for it to exit. The lock is released before that wait, so an agent
 * can adopt the server while it runs.
 */
const runLocked = <E, R>(
  effect: Effect.Effect<
    Option.Option<ChildProcessSpawner.ChildProcessHandle>,
    E,
    R
  >,
) =>
  Effect.gen(function* () {
    const foreground = yield* withLock(effect);
    if (Option.isSome(foreground)) yield* foreground.value.exitCode;
  }).pipe(Effect.scoped);

const seedFlag = (defaultValue: boolean, description: string) =>
  Flag.boolean(defaultValue ? "no-seed" : "seed").pipe(
    Flag.withDescription(description),
    Flag.withDefault(false),
    Flag.map((flag) => (defaultValue ? !flag : flag)),
  );

const startCommand = Command.make(
  "start",
  { seed: seedFlag(false, "Seed the dev shop once the server is up") },
  Effect.fn(function* ({ seed }) {
    const config = yield* loadConfig;
    yield* runLocked(
      Effect.gen(function* () {
        const server = yield* findServer;
        if (server.pids.length === 0)
          return yield* launchAndFinish(config, {
            seed,
            preferred: Option.none(),
          });
        yield* Console.log(
          `ok    adopted the running server: ${describeServer(server)}`,
        );
        const result = yield* finishStart(config, { seed });
        yield* summarize(config, describeServer(server), result);
        return Option.none();
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Start the dev server, or adopt the one already running; install the app on the dev store when it has no ShopSession. Never wipes.",
  ),
);

const stopCommand = Command.make(
  "stop",
  {},
  Effect.fn(function* () {
    const config = yield* loadConfig;
    yield* withLock(step("stop", stopServer(config)));
  }),
).pipe(Command.withDescription("Stop the dev server wherever it runs."));

const resetCommand = Command.make(
  "reset",
  { seed: seedFlag(true, "Skip seeding the dev shop") },
  Effect.fn(function* ({ seed }) {
    const config = yield* loadConfig;
    yield* runLocked(
      Effect.gen(function* () {
        const preferred = yield* step("stop", stopServer(config));
        yield* step(
          "wipe local D1 and Durable Objects, apply migrations",
          resetLocal(config.databaseName),
        );
        return yield* launchAndFinish(config, { seed, preferred });
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Stop the server, wipe .wrangler (local D1 and every Durable Object), start, install, and seed.",
  ),
);

/**
 * The tunnel the CLI started, read from the environment it gave the server
 * process: `shopify app dev` passes the tunnel URL to `pnpm dev` as `APP_URL`
 * (seen 2026-09-27). Its own output is no source: in a terminal the status
 * panel redraws over the line that printed it. `ps -E` shows another
 * process's environment on macOS, for processes of the same user.
 */
const findTunnelUrl = (config: Config) =>
  Effect.gen(function* () {
    for (const pid of yield* portListeners(config.port)) {
      const command = yield* runCommand("ps", [
        "-wwwE",
        "-p",
        String(pid),
        "-o",
        "command=",
      ]).pipe(Effect.orElseSucceed(() => ""));
      const url = /\bAPP_URL=(?<url>https:\/\/\S+)/u.exec(command)?.groups?.url;
      if (url !== undefined) return Option.some(url);
    }
    return Option.none<string>();
  });

/**
 * Only an answer from Cloudflare proves anything about a quick tunnel: 530
 * means its `cloudflared` is gone, any other status means it serves. A
 * request that gets no answer is `unknown`, not `dead`: for about a minute
 * after a start the macOS resolver can hold a cached "not found" for the new
 * hostname while public DNS already resolves it (seen 2026-09-27).
 */
type TunnelState = "reachable" | "dead" | "unknown";

const tunnelNote: Record<TunnelState, string> = {
  reachable: " (reachable)",
  dead: " (dead: pnpm dev:stop, then pnpm dev:start)",
  unknown: " (no answer yet; a new tunnel can take a minute to resolve)",
};

const statusCommand = Command.make(
  "status",
  {
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print the report as JSON"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ json }) {
    const config = yield* loadConfig;
    const server = yield* findServer;
    const listening = (yield* portListeners(config.port)).length > 0;
    const serving = listening && (yield* serverAnswering(config));
    const shopSession = yield* hasShopSession(config);
    const tunnelUrl = yield* findTunnelUrl(config);
    const tunnel = Option.isSome(tunnelUrl)
      ? yield* answering(tunnelUrl.value, 10_000).pipe(
          Effect.map(
            Option.match({
              onNone: (): TunnelState => "unknown",
              onSome: (response): TunnelState =>
                response.status === 530 ? "dead" : "reachable",
            }),
          ),
        )
      : null;
    const healthy =
      server.pids.length > 0 && serving && shopSession && tunnel !== "dead";
    const report = {
      healthy,
      server: describeServer(server),
      pids: server.pids,
      pane: Option.getOrNull(server.pane),
      tab: Option.getOrNull(server.tab),
      port: config.port,
      listening,
      answering: serving,
      tunnelUrl: Option.getOrNull(tunnelUrl),
      tunnel,
      shop: config.shop,
      shopSession,
    };
    yield* Console.log(
      json
        ? JSON.stringify(report, null, 2)
        : [
            `healthy:     ${healthy ? "yes" : "no"}`,
            `server:      ${report.server}`,
            `port:        ${config.port} (${listening ? "listening" : "not listening"}, ${serving ? "answering" : "not answering"})`,
            `tunnel:      ${report.tunnelUrl ?? "unknown"}${tunnel === null ? "" : tunnelNote[tunnel]}`,
            `shopSession: ${config.shop} ${shopSession ? "present" : "missing (pnpm dev:start installs)"}`,
          ].join("\n"),
    );
    if (!healthy) yield* Effect.sync(() => (process.exitCode = 1));
  }),
).pipe(
  Command.withDescription(
    "Report where the server runs, whether it answers, the tunnel, and the dev shop's ShopSession. Read-only; exit code 1 when unhealthy.",
  ),
);

const tailOf = (path: string, lines: number) =>
  readText(path).pipe(
    Effect.map((text) => text.split("\n").slice(-lines).join("\n")),
    Effect.orElseSucceed(() => `(no ${path})`),
  );

/** The CLI's recent output: its Herdr pane when it runs in one, else the background log. */
const recentCliOutput = (pane: Option.Option<string>, lines: number) =>
  Option.match(pane, {
    onSome: (paneId) =>
      Herdr.readPane(paneId, lines).pipe(Effect.orElseSucceed(() => "")),
    onNone: () => tailOf(CLI_LOG, lines),
  });

const logsCommand = Command.make(
  "logs",
  {
    lines: Flag.integer("lines").pipe(
      Flag.withDescription("Lines from each log"),
      Flag.withDefault(80),
    ),
  },
  Effect.fn(function* ({ lines }) {
    const server = yield* findServer;
    yield* Console.log(
      `== Shopify CLI: ${Option.match(server.pane, { onSome: (pane) => describePane(pane, server.tab), onNone: () => CLI_LOG })}`,
    );
    yield* Console.log(yield* recentCliOutput(server.pane, lines));
    yield* Console.log(`== Worker: ${WORKER_LOG}`);
    yield* Console.log(yield* tailOf(WORKER_LOG, lines));
  }),
).pipe(
  Command.withDescription(
    "Print the Shopify CLI's recent output and the tail of the Worker log.",
  ),
);

const devCommand = Command.make("dev").pipe(
  Command.withDescription(
    [
      "Run the local dev server (pnpm app:dev) for an agent or a person.",
      "Where it runs, first match wins:",
      "  1. a server already running for this checkout is adopted;",
      '  2. in Herdr, typed in a pane with no "server" tab: that tab becomes "server", the server runs here;',
      '  3. in Herdr, typed in the "server" tab: runs here;',
      '  4. in Herdr otherwise: an idle pane of the "server" tab (created if missing);',
      "  5. outside Herdr, typed in a terminal: runs here;",
      `  6. otherwise: in the background, logging to ${CLI_LOG}.`,
    ].join("\n"),
  ),
  Command.withSubcommands([
    startCommand,
    stopCommand,
    statusCommand,
    resetCommand,
    logsCommand,
  ]),
);

NodeRuntime.runMain(
  devCommand.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer),
  ),
);
