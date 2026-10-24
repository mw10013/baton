#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { CliError, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import path from "node:path";

import { runCommand } from "./lib/command.ts";
import {
  appFrame,
  awaitHydration,
  closeDevConsole,
  gotoApp,
  prepareApp,
} from "./lib/embedded-app.ts";
import { StoreName, StoreOf } from "./lib/worktree.ts";

class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  message: Schema.String,
}) {}

/**
 * The agent Chrome: one Chrome per machine that agents drive, with its own profile, logged in to
 * Shopify once by a person. It is not the person's own Chrome, which listens on 9222 for the
 * chrome-devtools MCP's `--autoConnect` and asks before every new connection. A debugging port on
 * a separate profile never asks, so an agent can drive it with nobody at the laptop. Every project
 * and checkout on the machine shares it, so one Shopify login covers every dev store.
 */
const AGENT_CDP = "http://127.0.0.1:9333";
const AGENT_PROFILE = path.join(homedir(), ".chrome-agent");
/**
 * Agents mostly work in background tabs, where Chrome otherwise slows timers and rendering.
 * `open -g` keeps the launch from taking focus.
 */
const AGENT_LAUNCH = [
  "-gna",
  "Google Chrome",
  "--args",
  `--user-data-dir=${AGENT_PROFILE}`,
  "--remote-debugging-port=9333",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

const session = "dev";
const HandleLine = Schema.Trim.pipe(
  Schema.decodeTo(Schema.TemplateLiteralParser(['handle = "', Schema.NonEmptyString, '"'])),
);
const decodeHandleLine = Schema.decodeUnknownOption(HandleLine);

const CdpTarget = Schema.Struct({ id: Schema.String, url: Schema.String, title: Schema.String });
const decodeTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(CdpTarget));
const decodeTargets = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(CdpTarget)));
const isServerRunning = Schema.is(
  Schema.String.check(Schema.isPattern(/^chrome-devtools-mcp daemon is running\./u)),
);

const cdp = (route: string, method: "GET" | "PUT" = "GET") =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${AGENT_CDP}${route}`, {
        method,
        signal: AbortSignal.timeout(5000),
      });
      return response.ok ? await response.text() : Promise.reject(new Error(response.statusText));
    },
    catch: () =>
      new BrowserError({ message: `The agent Chrome is not answering on ${AGENT_CDP}.` }),
  });

const runCLI = Effect.fn("browser.runCLI")(function* (args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("vp", ["exec", "playwright", "cli", `-s=${session}`, ...args], {
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const code = yield* child.exitCode;
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new BrowserError({
      message:
        "Browser command failed; see output above. Check vp run dev:status, then vp run browser agent.",
    });
  }
}, Effect.scoped);

/**
 * The CLI's run-code VM cannot import modules. Serialize the shared helpers with their complete
 * closure here; keep new helper dependencies in this list so tests and the CLI use the same rules.
 * Node's TypeScript loader erases types before Function.toString exposes these bodies.
 */
const readinessCode = (url?: string) => `async (page) => {
  const appFrame = ${appFrame.toString()};
  const awaitHydration = ${awaitHydration.toString()};
  const closeDevConsole = ${closeDevConsole.toString()};
  const prepareApp = ${prepareApp.toString()};
  const gotoApp = ${gotoApp.toString()};
  await ${url === undefined ? "prepareApp(page)" : `gotoApp(page, ${JSON.stringify(url)})`};
  return { ready: true };
}`;

const ready = Effect.gen(function* () {
  yield* runCLI(["--raw", "run-code", readinessCode()]);
  yield* runCLI(["snapshot", "--filename=.playwright-cli/dev-ready.yml"]);
});

const devStore = Config.schema(StoreOf("dev"), "SHOPIFY_DEV_STORE").pipe(
  Effect.map(Schema.encodeSync(StoreName)),
);

/**
 * Starts the agent Chrome when it is not answering. Returns whether it was started, because a
 * chrome-devtools server attached to the previous Chrome has to be restarted.
 */
const ensureAgentChrome = Effect.gen(function* () {
  if (
    yield* cdp("/json/version").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
  ) {
    return false;
  }
  yield* runCommand("open", AGENT_LAUNCH);
  yield* cdp("/json/version").pipe(
    Effect.retry(Schedule.max([Schedule.spaced("500 millis"), Schedule.during("20 seconds")])),
  );
  return true;
});

/**
 * Opens the dev store's admin in a new tab and waits for its own title. Logged in, the admin titles
 * the page `<store> · <page> · Shopify`; a lapsed login lands on accounts.shopify.com, titled
 * "Log in — Shopify". Neither the first URL nor an early title tells them apart: Chrome titles a
 * loading tab with its URL, and a lapsed login passes through `admin.shopify.com/login` first.
 * Only a person may sign in, so a lapse fails for them to fix.
 */
const checkShopifyLogin = Effect.fn("browser.checkShopifyLogin")(function* (store: string) {
  const unreadable = () =>
    new BrowserError({ message: `The agent Chrome on ${AGENT_CDP} gave an unreadable tab list.` });
  const loggedIn = (target: typeof CdpTarget.Type) => target.title.startsWith(`${store} · `);
  const loggedOut = (target: typeof CdpTarget.Type) =>
    new URL(target.url).hostname === "accounts.shopify.com";
  const opened = yield* cdp(
    `/json/new?${encodeURI(`https://admin.shopify.com/store/${store}`)}`,
    "PUT",
  ).pipe(Effect.flatMap((text) => decodeTarget(text).pipe(Effect.mapError(unreadable))));
  const landed = yield* cdp("/json/list").pipe(
    Effect.flatMap((text) => decodeTargets(text).pipe(Effect.mapError(unreadable))),
    Effect.map(Array.findFirst((target) => target.id === opened.id)),
    Effect.repeat({
      until: Option.exists((target) => loggedIn(target) || loggedOut(target)),
      schedule: Schedule.max([Schedule.spaced("500 millis"), Schedule.during("20 seconds")]),
    }),
    Effect.ensuring(cdp(`/json/close/${opened.id}`).pipe(Effect.ignore)),
  );
  if (Option.exists(landed, loggedIn)) return;
  return yield* new BrowserError({
    message: Option.exists(landed, loggedOut)
      ? "The agent Chrome is not logged in to Shopify. A person logs in at the window it shows, then runs vp run browser agent again."
      : `The Shopify admin did not finish loading in the agent Chrome within 20 seconds (${Option.match(landed, { onNone: () => "tab gone", onSome: (target) => target.url })}).`,
  });
});

/**
 * Makes the agent Chrome ready for this checkout: Chrome running and logged in to Shopify, and this
 * checkout's chrome-devtools server attached to it. The server's session id is `WEBSITE_PORT`,
 * unique across checkouts and projects, so a restart here never drops another checkout's server.
 */
const agent = Effect.gen(function* () {
  const port = yield* Config.Port("WEBSITE_PORT");
  const started = yield* ensureAgentChrome;
  yield* checkShopifyLogin(yield* devStore);
  const sessionId = `--sessionId=${String(port)}`;
  const missingCli = () =>
    new BrowserError({
      message:
        "chrome-devtools failed. Install it with vp install -g --node lts chrome-devtools-mcp@latest.",
    });
  const status = yield* runCommand("chrome-devtools", ["status", sessionId]).pipe(
    Effect.mapError(missingCli),
  );
  if (started || !isServerRunning(status)) {
    yield* runCommand("chrome-devtools", [
      "start",
      sessionId,
      `--browserUrl=${AGENT_CDP}`,
      "--no-usage-statistics",
      "--no-performance-crux",
    ]).pipe(Effect.mapError(missingCli));
  }
  yield* Console.log(
    `Ready: agent Chrome ${AGENT_CDP}, logged in. chrome-devtools <tool> ${sessionId}`,
  );
});

/** This session's own tab in the shared agent Chrome is closed; other agents' tabs are left. */
const close = runCLI(["--raw", "run-code", "async (page) => { await page.close(); }"]).pipe(
  Effect.ignore,
  Effect.andThen(runCLI(["detach"])),
);

const open = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const port = yield* Config.Port("WEBSITE_PORT");
  const store = yield* devStore;
  const toml = yield* fs.readFileString("shopify.app.toml");
  const handle = yield* Effect.fromOption(
    Array.findFirst(toml.split("\n"), (line) =>
      Option.map(decodeHandleLine(line), ([, value]) => value),
    ),
  ).pipe(
    Effect.mapError(() => new BrowserError({ message: "shopify.app.toml has no app handle" })),
  );
  yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      return response.ok;
    },
    catch: () =>
      new BrowserError({ message: "Dev server is not answering. Start it with vp run dev." }),
  }).pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.void
        : Effect.fail(
            new BrowserError({ message: "Dev server is not healthy. Check vp run dev:status." }),
          ),
    ),
  );
  yield* agent;
  yield* close.pipe(Effect.ignore);
  const url = `https://admin.shopify.com/store/${store}/apps/${handle}/app`;
  yield* Effect.gen(function* () {
    yield* runCLI(["attach", `--cdp=${AGENT_CDP}`]);
    yield* runCLI(["tab-new"]);
    yield* runCLI(["--raw", "run-code", readinessCode(url)]);
    yield* runCLI(["snapshot", "--filename=.playwright-cli/dev-ready.yml"]);
    yield* Console.log("Ready: session=dev; snapshot=.playwright-cli/dev-ready.yml");
  }).pipe(Effect.onError(() => close.pipe(Effect.ignore)));
});

const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

Command.make("browser").pipe(
  Command.withDescription("Drive the embedded app in this checkout's Shopify dev store"),
  Command.withSubcommands([
    Command.make("agent", {}, () => agent.pipe(Effect.mapError(toUserError))),
    Command.make("open", {}, () => open.pipe(Effect.mapError(toUserError))),
    Command.make("ready", {}, () => ready.pipe(Effect.mapError(toUserError))),
    Command.make("close", {}, () => close.pipe(Effect.mapError(toUserError))),
  ]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
