/**
 * This checkout's local servers, the dev server (`scripts/dev.ts`) and the e2e server
 * (`scripts/e2e.ts`): both Shopify CLI's `shopify app dev` in front of `alchemy dev`, on their own
 * store, port and stage ({@link serverParams}). Here is how either is found, probed, started where
 * it belongs ({@link startServer}), stopped ({@link stopServer}), and how its tunnel is checked
 * ({@link tunnelReady}).
 *
 * @module
 */
import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Resolver } from "node:dns/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCommand } from "./command.ts";
import * as Herdr from "./herdr.ts";
import type { WebEnvironment } from "./web.ts";
import { checkoutKind, currentBranch, e2ePortOf, stage } from "./worktree.ts";

const Pid = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
export const decodePid = Schema.decodeUnknownResult(Pid);

/** The pids in line-oriented command output; anything that is not a pid is skipped. */
export const pidsFrom = (output: string) =>
  Array.filterMap(output.split("\n"), (line) => decodePid(line.trim()));

export const portListeners = (port: number) =>
  runCommand("lsof", ["-t", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-nP"]).pipe(
    Effect.map(pidsFrom),
    Effect.orElseSucceed((): number[] => []),
  );

const AppUrlVariable = Schema.TemplateLiteralParser(["APP_URL=", Schema.String]).pipe(
  Schema.decodeTo(
    Schema.Tuple([
      Schema.Literal("APP_URL="),
      Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/u)),
    ]),
  ),
);
const decodeAppUrlVariable = Schema.decodeUnknownOption(AppUrlVariable);

/**
 * The tunnel the CLI opened, read from the environment it gave the server: whatever listens on the
 * port (Alchemy's proxy, a child of the CLI's web command) has `APP_URL` in its environment, and
 * `ps -E` shows another process's environment on macOS for the same user. The CLI's own output is
 * no source: in a terminal its status panel redraws over the line that printed it. None when the
 * server does not run under the CLI.
 */
export const findTunnelUrl = (port: number) =>
  Effect.gen(function* () {
    for (const pid of yield* portListeners(port)) {
      const command = yield* runCommand("ps", ["-wwwE", "-p", String(pid), "-o", "command="]).pipe(
        Effect.orElseSucceed(() => ""),
      );
      const url = Array.findFirst(command.split(/\s+/u), (word) =>
        Option.map(decodeAppUrlVariable(word), ([, value]) => value),
      );
      if (Option.isSome(url)) return url;
    }
    return Option.none<string>();
  });

/** Any HTTP answer counts: the first request after a start waits on Vite's compile. */
export const answering = (port: number) =>
  Effect.tryPromise(() =>
    fetch(`http://localhost:${String(port)}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }),
  ).pipe(Effect.option, Effect.map(Option.isSome));

/**
 * Resolvers that hold no negative answer for a tunnel hostname that is not in DNS yet. A new quick
 * tunnel's name is in public DNS by the time the CLI prints it, but a lookup through the system
 * resolver made a moment earlier caches "not found" for the negative TTL (60 s on Cloudflare's
 * resolvers), and every load through the system resolver fails until it expires. So the system
 * resolver is not asked until these have the name.
 */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

/**
 * How long {@link tunnelReady} waits in all: longer than the 60 s negative TTL, so a system lookup
 * made too early by anything else (a browser, the CLI) has expired by the end.
 */
export const TUNNEL_READY_TIMEOUT = Duration.seconds(90);

/**
 * A quick tunnel whose `cloudflared` is gone answers every request with Cloudflare's 530; any other
 * status is the server behind it answering. No answer at all proves nothing either way.
 */
export const tunnelServes = (status: number) => status !== 530;

/** Which half of {@link tunnelReady} failed: the public DNS lookup, or `/` through the tunnel. */
export const TunnelPhase = Schema.Literals(["resolve", "answer"]);
export type TunnelPhase = typeof TunnelPhase.Type;

/**
 * What {@link TunnelError} says: which half failed, after how long, and what was seen last (a
 * lookup error code, or the HTTP status or fetch error through the tunnel).
 */
export const tunnelErrorMessage = (failure: {
  readonly phase: TunnelPhase;
  readonly url: string;
  readonly lastSeen: string;
  readonly waitedMs: number;
}) => {
  const waited = `${String(Math.round(failure.waitedMs / 1000))}s`;
  return failure.phase === "resolve"
    ? `the tunnel ${failure.url} does not resolve on public DNS after ${waited} (last: ${failure.lastSeen})`
    : `the tunnel ${failure.url} resolves but / does not answer through it after ${waited} (last: ${failure.lastSeen})`;
};

export class TunnelError extends Schema.TaggedError<TunnelError>()("TunnelError", {
  phase: TunnelPhase,
  message: Schema.String,
}) {}

const describeCause = (cause: unknown) =>
  cause instanceof Error
    ? "code" in cause && typeof cause.code === "string"
      ? cause.code
      : cause.message
    : String(cause);

/** One lookup of `hostname` on {@link PUBLIC_RESOLVERS}; fails with what was seen. */
const resolvePublic = (hostname: string) =>
  Effect.tryPromise({
    try: () => {
      const resolver = new Resolver({ timeout: 2000, tries: 1 });
      resolver.setServers(PUBLIC_RESOLVERS);
      return resolver.resolve4(hostname);
    },
    catch: describeCause,
  });

/** One `GET /` through the tunnel; succeeds with the status, fails with what was seen. */
const fetchThrough = (url: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(new URL("/", url), { redirect: "manual", signal: AbortSignal.timeout(10_000) }),
    catch: describeCause,
  }).pipe(Effect.map((response) => response.status));

/** What a single look at a tunnel found; see {@link tunnelState}. */
export const TunnelState = Schema.Literals(["ready", "not resolving", "not answering"]);
export type TunnelState = typeof TunnelState.Type;

/**
 * A single look at the tunnel, {@link tunnelReady}'s two halves once each without waiting, for a
 * status report: the system resolver is asked (by `fetch`) only once public DNS has the name.
 */
export const tunnelState = Effect.fn("tunnelState")(function* (url: string) {
  if (Option.isNone(yield* Effect.option(resolvePublic(new URL(url).hostname))))
    return "not resolving" satisfies TunnelState;
  const status = yield* Effect.option(fetchThrough(url));
  return Option.exists(status, tunnelServes) ? "ready" : ("not answering" satisfies TunnelState);
});

/**
 * Waits until the tunnel serves: first until {@link PUBLIC_RESOLVERS} resolve its hostname, then
 * until `/` through it answers with anything {@link tunnelServes} accepts, polling each every
 * second within {@link TUNNEL_READY_TIMEOUT} for both. Succeeds with the time it took.
 */
export const tunnelReady = Effect.fn("tunnelReady")(function* (
  url: string,
  timeout: Duration.Duration = TUNNEL_READY_TIMEOUT,
) {
  const started = Date.now();
  const remaining = () =>
    Duration.millis(Math.max(0, Duration.toMillis(timeout) - (Date.now() - started)));
  const poll = <A>(attempt: Effect.Effect<A, string>, phase: TunnelPhase) =>
    attempt.pipe(
      Effect.retry(Schedule.max([Schedule.spaced("1 second"), Schedule.during(remaining())])),
      Effect.mapError(
        (lastSeen) =>
          new TunnelError({
            phase,
            message: tunnelErrorMessage({ phase, url, lastSeen, waitedMs: Date.now() - started }),
          }),
      ),
    );
  yield* poll(resolvePublic(new URL(url).hostname), "resolve");
  yield* poll(
    fetchThrough(url).pipe(Effect.filterOrFail(tunnelServes, (status) => `HTTP ${String(status)}`)),
    "answer",
  );
  return Duration.millis(Date.now() - started);
});

/** This checkout's root, where both servers run and where every path below is relative to. */
export const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");

export class ServerError extends Schema.TaggedError<ServerError>()("ServerError", {
  message: Schema.String,
}) {}

const fail = (message: string) => new ServerError({ message });

/** What tells the dev server from the e2e server; see {@link serverParams}. */
export interface ServerParams {
  readonly environment: WebEnvironment;
  /** The `.env` key of the server's store. */
  readonly storeVariable: "SHOPIFY_DEV_STORE" | "SHOPIFY_E2E_STORE";
  readonly portOf: (websitePort: number) => number;
  readonly lock: string;
  readonly log: string;
  /** The herdr tab the server runs in ({@link startServer}). */
  readonly tab: string;
  /** The package script that runs the server in the foreground and sets its web environment. */
  readonly script: string;
}

/**
 * The dev and e2e servers are both Shopify CLI's `shopify app dev` in this checkout's directory,
 * in front of `alchemy dev`; they differ in the store, the port, the stage, the lock, the logs and
 * the herdr tab, and in the package script that runs one in the foreground.
 */
export const serverParams = (environment: WebEnvironment): ServerParams =>
  Match.value(environment).pipe(
    Match.when("dev", (): ServerParams => ({
      environment,
      storeVariable: "SHOPIFY_DEV_STORE",
      portOf: (websitePort) => websitePort,
      lock: ".logs/dev.lock",
      log: ".logs/dev/current",
      tab: "dev",
      script: "app:dev",
    })),
    Match.when("e2e", (): ServerParams => ({
      environment,
      storeVariable: "SHOPIFY_E2E_STORE",
      portOf: e2ePortOf,
      lock: ".logs/e2e.lock",
      log: ".logs/e2e/current",
      tab: "e2e",
      script: "e2e:serve",
    })),
    Match.exhaustive,
  );

/** {@link serverParams} with this checkout's values: its port, store and stage. */
export interface Server extends ServerParams {
  readonly port: number;
  readonly store: string;
  readonly stage: string;
}

/** The port from `.env`, which the package scripts load with `--env-file`. */
const loadWebsitePort = Config.Port("WEBSITE_PORT").pipe(
  Effect.mapError(() =>
    fail("WEBSITE_PORT is not set to a port: run through the package scripts, which load .env"),
  ),
);

/** This checkout's `environment` server, from `.env` and the checkout's stage. */
export const loadServer = Effect.fn("loadServer")(function* (environment: WebEnvironment) {
  const params = serverParams(environment);
  const store = yield* Config.NonEmptyString(params.storeVariable).pipe(
    Effect.mapError(() =>
      fail(
        `${params.storeVariable} is not set: add it to .env (mw10013-${environment}-shop-NN, NN the worktree index)`,
      ),
    ),
  );
  return {
    ...params,
    port: params.portOf(yield* loadWebsitePort),
    store,
    stage: yield* stage(environment).pipe(Effect.mapError((error) => fail(error.message))),
  } satisfies Server;
});

/**
 * Shopify CLI's `app dev` process, as `pgrep -f` matches it. Under Vite+'s tool manager the CLI's
 * command line is `node …/@shopify/cli/…/bin/run.js app dev …`, without the word `shopify app
 * dev`; a CLI installed elsewhere shows `shopify app dev`. Both are matched.
 */
const CLI_PROCESS = String.raw`shopify app dev|@shopify/cli/.*bin/run\.js app dev`;
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
/**
 * The pattern of a server's CLI: {@link CLI_PROCESS} on `--store <store>`. The dev and e2e servers
 * are both a `shopify app dev` in this checkout's working directory, so the working-directory
 * check that follows every match cannot tell them apart; the store does. A store name that is a
 * prefix of another (`…-shop-0` and `…-shop-00`) must end the argument.
 */
const cliPattern = (store: string) => `(${CLI_PROCESS}) .*--store ${escapeRegExp(store)}( |$)`;
const isCliCommand = (store: string) =>
  Schema.is(Schema.String.check(Schema.isPattern(new RegExp(cliPattern(store), "u"))));
/**
 * A server's `alchemy dev`, by the `--stage` its package script (`web:dev`, `web:e2e`) passes:
 * the stage is what tells this checkout's dev and e2e servers apart, and both from another
 * checkout's. The scripts' own shells hold the stage only as `$stage`, so the match is on
 * Alchemy's CLI process, which gets the expanded argument. `dev-mw` also matches `dev-mw-wt-01`;
 * the working-directory check that follows every match separates them.
 */
const alchemyProcess = (server: Server) => ` dev --stage ${server.stage}`;

const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 20_000;

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One line per step with its duration; a failing step says so before its error. */
export const step = Effect.fn("step")(function* <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
) {
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
 * A server's processes: Shopify CLI's `app dev` on its store ({@link cliPattern}) and Alchemy's
 * CLI process running `alchemy dev` on its stage ({@link alchemyProcess}), whose exit ends the
 * web command. Both are listed, because a SIGINT to the CLI alone leaves Alchemy's tree running on
 * the port.
 */
const serverPids = (server: Server) =>
  Effect.all([checkoutPids(cliPattern(server.store)), checkoutPids(alchemyProcess(server))]).pipe(
    Effect.map(([cli, alchemy]) => [...cli, ...alchemy]),
  );

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

/**
 * The herdr pane whose foreground process is the server's CLI or `alchemy dev`, matched as
 * {@link serverPids} matches them, by store and by stage: the other environment's server may run
 * in a pane of the same workspace.
 */
const findServerPane = (server: Server) =>
  Effect.gen(function* () {
    if (!(yield* Herdr.running)) return Option.none<Herdr.Pane>();
    const panes = yield* Herdr.listPanes;
    const isCli = isCliCommand(server.store);
    const alchemy = alchemyProcess(server);
    const hosting = yield* Effect.forEach(
      panes,
      (pane) =>
        Herdr.processInfo(pane.pane_id).pipe(
          Effect.map(({ processes }) =>
            processes.some(
              (process) =>
                (isCli(process.argv.join(" ")) || process.argv.join(" ").includes(alchemy)) &&
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

/** A server's processes and, in herdr, the pane it runs in. */
export const findServer = (server: Server) =>
  Effect.all({ pids: serverPids(server), pane: findServerPane(server) });
export type FoundServer = Effect.Success<ReturnType<typeof findServer>>;

export const describeServer = (found: FoundServer) =>
  Option.match(found.pane, {
    onSome: (pane) => `herdr pane ${pane.pane_id}`,
    onNone: () =>
      found.pids.length > 0
        ? `pid ${found.pids.join(", ")} (background, or a terminal outside herdr)`
        : "not running",
  });

/** Sends `signal` to `pid`; a process that is already gone is not an error. */
const signal = (pid: number, signal: NodeJS.Signals | 0) =>
  Effect.try(() => process.kill(pid, signal)).pipe(Effect.option, Effect.map(Option.isSome));

const processAlive = (pid: number) => signal(pid, 0);

/**
 * Runs `effect` holding the server's lock file, so parallel agents in one checkout cannot start
 * two servers or stop one while another starts it. The lock holds the holder's pid; a lock whose
 * holder is gone is taken over.
 */
export const withLock = <A, E, R>(server: Server, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(ROOT, ".logs"), { recursive: true });
      const lock = path.join(ROOT, server.lock);
      const holder = yield* fs.readFileString(lock).pipe(
        Effect.map((text) =>
          Option.filter(Result.getSuccess(decodePid(text.trim())), (pid) => pid !== process.pid),
        ),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      if (Option.isSome(holder) && (yield* processAlive(holder.value)))
        return yield* fail(
          `another ${server.environment} command (pid ${String(holder.value)}) holds ${server.lock}; wait for it to finish`,
        );
      yield* fs.writeFileString(lock, String(process.pid));
    }),
    () => effect,
    () =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(path.join(ROOT, server.lock), { force: true })),
        Effect.ignore,
      ),
  );

/**
 * Stops the server wherever it runs. In a pane it presses Ctrl-C, as a person would: the whole
 * foreground group exits and the pane is left at its prompt. Otherwise, or when a pane ignores
 * Ctrl-C for {@link STOP_TIMEOUT_MS}, it sends SIGTERM to the server's processes
 * ({@link serverPids}), their descendants (the tunnel's `cloudflared`, Vite, `workerd`) and
 * whatever listens on the port, then waits for all of them to be gone.
 */
export const stopServer = Effect.fn("stopServer")(function* (server: Server) {
  const found = yield* findServer(server);
  const listeners = yield* portListeners(server.port);
  if (found.pids.length === 0 && listeners.length === 0) {
    yield* Console.log(`no ${server.environment} server running`);
    return;
  }
  const remaining = Effect.all([serverPids(server), portListeners(server.port)]);
  const terminate = remaining.pipe(
    Effect.flatMap(([pids, ports]) => withDescendants([...pids, ...ports])),
    Effect.flatMap((pids) =>
      Effect.forEach(pids, (pid) => signal(pid, "SIGTERM"), { discard: true }),
    ),
  );
  const stopped = remaining.pipe(
    Effect.map(([pids, ports]) => pids.length === 0 && ports.length === 0),
  );
  if (Option.isSome(found.pane)) {
    yield* Herdr.sendKeys(found.pane.value.pane_id, "ctrl+c");
    if (!(yield* waitUntil(stopped, STOP_TIMEOUT_MS, 500))) yield* terminate;
  } else yield* terminate;
  if (!(yield* waitUntil(stopped, STOP_TIMEOUT_MS, 500)))
    return yield* fail(
      `port ${String(server.port)} is still held after SIGTERM; check with lsof -i :${String(server.port)}`,
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
const idlePaneIn = Effect.fn("idlePaneIn")(function* (server: Server, tabId: string) {
  const first = yield* Effect.fromOption(
    Array.findFirst(yield* Herdr.listPanes, (pane) => pane.tab_id === tabId),
  ).pipe(Effect.mapError(() => fail(`the "${server.tab}" tab has no panes`)));
  const ordered = yield* Herdr.panesInLayoutOrder(first.pane_id);
  const idle = yield* Effect.findFirst(ordered, (pane) =>
    Herdr.processInfo(pane).pipe(Effect.map(({ idle }) => idle)),
  );
  return yield* Option.match(idle, {
    onSome: Effect.succeed,
    onNone: () => Herdr.splitPane(ordered[0] ?? first.pane_id, ROOT),
  });
});

/** Where a new server runs: rules 2 to 4 of {@link startServer} (rule 1, adoption, is its own). */
const placeServer = Effect.fn("placeServer")(function* (server: Server) {
  if (!(yield* Herdr.running)) return isTty() ? Placement.Foreground : Placement.Background;
  const workspaceId = yield* checkoutWorkspace;
  const tab = Array.findFirst(
    yield* Herdr.listTabs(workspaceId),
    (candidate) => candidate.label === server.tab,
  );
  if (isTty() && Option.isSome(tab) && Option.contains(Herdr.callerTabId(), tab.value.tab_id))
    return Placement.Foreground;
  const paneId = yield* Option.match(tab, {
    onNone: () => Herdr.createTab({ workspaceId, cwd: ROOT, label: server.tab }),
    onSome: (found) => idlePaneIn(server, found.tab_id),
  });
  return Placement.Pane(paneId);
});

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The server in the foreground: `vp run <script>` ({@link serverParams}). A separate script from
 * the launcher (`dev`, `e2e:start`), so starting does not recurse and the public entry point
 * applies adoption and the lock.
 */
const runServer = (server: Server, options: ChildProcess.CommandOptions) =>
  ChildProcess.make("vp", ["run", server.script], { cwd: ROOT, ...options });

/**
 * Starts the server where {@link placeServer} says. A foreground start returns
 * the handle of `vp run <script>`, which owns the caller's terminal until it exits;
 * the other placements return once the server is launched and outlive the
 * command.
 */
const launchServer = Effect.fn("launchServer")(function* (server: Server, placement: Placement) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Match.valueTags(placement, {
    Pane: ({ paneId }) =>
      Effect.gen(function* () {
        yield* waitUntil(
          Herdr.processInfo(paneId).pipe(Effect.map(({ idle }) => idle)),
          10_000,
          250,
        );
        yield* Herdr.runInPane(paneId, `cd ${shellQuote(ROOT)} && vp run ${server.script}`);
        yield* Console.log(`ok    started in herdr tab "${server.tab}" (pane ${paneId})`);
        return Option.none<ChildProcessSpawner.ChildProcessHandle>();
      }),
    Background: () =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          runServer(server, {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: true,
          }),
        );
        // Unreferenced, the process survives this command's scope closing.
        yield* handle.unref;
        yield* Console.log(`ok    started in the background (pid ${String(handle.pid)})`);
        return Option.none<ChildProcessSpawner.ChildProcessHandle>();
      }),
    Foreground: () =>
      spawner
        .spawn(
          runServer(server, {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            detached: false,
          }),
        )
        .pipe(Effect.map(Option.some)),
  });
});

const waitAnswering = (server: Server) =>
  step(
    "server answering",
    waitUntil(answering(server.port), START_TIMEOUT_MS, 1000).pipe(
      Effect.filterOrFail(
        (answered) => answered,
        () =>
          fail(
            `no answer on port ${String(server.port)} after ${String(START_TIMEOUT_MS / 1000)}s; see vp run ${server.environment}:logs`,
          ),
      ),
    ),
  );

const ClientId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
const ClientIdLine = Schema.TemplateLiteralParser(['client_id = "', ClientId, '"']);
const decodeClientIdLine = Schema.decodeUnknownOption(ClientIdLine);

/** The app's client id, from the `client_id = "…"` line of `shopify.app.toml`. */
export const loadClientId = Effect.gen(function* () {
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
export const adminUrl = (store: string, clientId: string) =>
  `https://admin.shopify.com/store/${store}/apps/${clientId}`;

/** What `start` and `status` report about the app: its admin URL and the tunnel. */
export const appReport = Effect.fn("appReport")(function* (server: Server) {
  const clientId = yield* loadClientId.pipe(Effect.option);
  return {
    app: Option.getOrNull(Option.map(clientId, (id) => adminUrl(server.store, id))),
    tunnel: Option.getOrNull(yield* findTunnelUrl(server.port)),
  };
});

const summarize = Effect.fn("summarize")(function* (server: Server, where: string) {
  const { app, tunnel } = yield* appReport(server);
  const label = `${server.environment}:`.padEnd(7);
  yield* Console.log(
    [
      "",
      `server: ${where}`,
      `${label} http://localhost:${String(server.port)}`,
      `app:    ${app ?? "(no client_id in shopify.app.toml)"}`,
      `tunnel: ${tunnel ?? "(none: the server is not running under shopify app dev)"}`,
      `logs:   ${server.log}`,
    ].join("\n"),
  );
});

/**
 * Starts the server, or adopts the one running. Where it runs; the first rule that applies wins:
 *
 * 1. A server already serving this checkout in this environment, wherever it runs, is adopted:
 *    `start` leaves it running, `stop` stops it, whoever started it. It is found by process,
 *    working directory, and store or stage ({@link findServer}), never by label; the other
 *    environment's server, in the same directory, is never adopted, reported or stopped.
 * 2. With herdr running, the server belongs to the checkout's workspace, which is opened if
 *    needed: labelled with the project name for the main checkout, `wt-NN` for a worktree
 *    (grouped under the main checkout's workspace, which is opened first). In it, a tab labelled
 *    for the environment (`dev`, `e2e`):
 *    - typed by a person (a TTY) in that tab: the caller's terminal, in the foreground;
 *    - otherwise (an agent, or a person in another tab): an idle pane of that tab, a new split
 *      when none is idle, or a new tab. It never types into a busy pane.
 * 3. Without herdr, typed by a person: the caller's terminal, in the foreground.
 * 4. Otherwise: a detached background process.
 *
 * herdr is asked whether it runs (`herdr status`), never `HERDR_ENV`: T3 Code agents run outside
 * herdr but can still drive it over its socket. The whole start holds the server's lock
 * ({@link withLock}). `afterReady` runs once the server answers and is summarized, also beside a
 * foreground server, which holds the terminal until it exits.
 */
export const startServer = <E extends { readonly message: string }, R>(
  server: Server,
  afterReady: Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const foreground = yield* withLock(
      server,
      Effect.gen(function* () {
        const found = yield* findServer(server);
        if (found.pids.length > 0) {
          yield* Console.log(`ok    adopted the running server: ${describeServer(found)}`);
          yield* waitAnswering(server);
          yield* summarize(server, describeServer(found));
          yield* afterReady;
          return Option.none();
        }
        if ((yield* portListeners(server.port)).length > 0)
          return yield* fail(
            `port ${String(server.port)} is held by another process: lsof -nP -iTCP:${String(server.port)} -sTCP:LISTEN`,
          );
        const placement = yield* placeServer(server);
        const handle = yield* launchServer(server, placement);
        if (Option.isSome(handle)) return handle;
        yield* waitAnswering(server);
        yield* summarize(
          server,
          Match.valueTags(placement, {
            Pane: ({ paneId }) => `herdr tab "${server.tab}" (pane ${paneId})`,
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
      yield* waitAnswering(server).pipe(
        Effect.flatMap(() => summarize(server, "this terminal")),
        Effect.flatMap(() => afterReady),
        Effect.catch((error) => Console.error(`${server.environment}: ${error.message}`)),
        Effect.forkChild,
      );
      yield* foreground.value.exitCode;
    }
  }).pipe(Effect.scoped);

/** The tail of the server's log, `lines` long. */
export const logTail = (server: ServerParams, lines: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(path.join(ROOT, server.log))
      .pipe(Effect.orElseSucceed(() => `(no ${server.log})`));
    yield* Console.log(
      text
        .split("\n")
        .slice(-lines - 1)
        .join("\n"),
    );
  });

const StartTime = Schema.Trim.pipe(Schema.decodeTo(Schema.DateFromString));
const decodeStartTime = Schema.decodeUnknownOption(StartTime);

/** When `pid` started, from `ps -o lstart=`; none when it is gone. */
export const processStart = (pid: number) =>
  runCommand("ps", ["-o", "lstart=", "-p", String(pid)]).pipe(
    Effect.map(decodeStartTime),
    Effect.orElseSucceed(() => Option.none<Date>()),
  );
