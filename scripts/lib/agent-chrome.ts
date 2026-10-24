import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

import { runCommand } from "./command.ts";

/** A failure of the agent Chrome; every message is for the person at the terminal. */
export class AgentChromeError extends Schema.TaggedError<AgentChromeError>()("AgentChromeError", {
  message: Schema.String,
}) {}

/**
 * The agent Chrome: one Chrome per machine that agents drive, with its own profile, logged in to
 * Shopify once by a person. It is not the person's own Chrome, which listens on 9222 for the
 * chrome-devtools MCP's `--autoConnect` and asks before every new connection. A debugging port on
 * a separate profile never asks, so an agent can drive it with nobody at the laptop. Every project
 * and checkout on the machine shares it, so one Shopify login covers every store.
 */
export const AGENT_CDP = "http://127.0.0.1:9333";
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

/** The Shopify origins whose cookies carry the admin login, as an e2e browser needs them. */
const SHOPIFY_URLS = ["https://admin.shopify.com", "https://accounts.shopify.com"];

const CdpTarget = Schema.Struct({ id: Schema.String, url: Schema.String, title: Schema.String });
const decodeTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(CdpTarget));
const decodeTargets = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(CdpTarget)));

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
      new AgentChromeError({ message: `The agent Chrome is not answering on ${AGENT_CDP}.` }),
  });

/**
 * Starts the agent Chrome when it is not answering. Returns whether it was started, because a
 * chrome-devtools server attached to the previous Chrome has to be restarted.
 */
export const ensureAgentChrome = Effect.gen(function* () {
  if (
    yield* cdp("/json/version").pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
  ) {
    return false;
  }
  yield* runCommand("open", AGENT_LAUNCH).pipe(
    Effect.mapError(
      () => new AgentChromeError({ message: "Could not launch the agent Chrome with open." }),
    ),
  );
  yield* cdp("/json/version").pipe(
    Effect.retry(Schedule.max([Schedule.spaced("500 millis"), Schedule.during("20 seconds")])),
  );
  return true;
});

/**
 * Opens the store's admin in a new tab and waits for its own title. Logged in, the admin titles
 * the page `<store> · <page> · Shopify`; a lapsed login lands on accounts.shopify.com, titled
 * "Log in — Shopify". Neither the first URL nor an early title tells them apart: Chrome titles a
 * loading tab with its URL, and a lapsed login passes through `admin.shopify.com/login` first.
 * Only a person may sign in, so a lapse fails for them to fix.
 */
export const checkShopifyLogin = Effect.fn("agentChrome.checkShopifyLogin")(function* (
  store: string,
) {
  const unreadable = () =>
    new AgentChromeError({
      message: `The agent Chrome on ${AGENT_CDP} gave an unreadable tab list.`,
    });
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
  return yield* new AgentChromeError({
    message: Option.exists(landed, loggedOut)
      ? "The agent Chrome is not logged in to Shopify. A person logs in at the window it shows, then runs vp run browser agent again."
      : `The Shopify admin did not finish loading in the agent Chrome within 20 seconds (${Option.match(landed, { onNone: () => "tab gone", onSome: (target) => target.url })}).`,
  });
});

/**
 * Writes the agent Chrome's Shopify login as the Playwright storage state that isolated browsers
 * (the e2e workers, the screenshot and screencast scripts) load. It reads the live browser, which
 * renews the session itself, after {@link checkShopifyLogin} proves the login, so the copy is as
 * fresh as the agent Chrome. The write is atomic through a staging file beside the output, and the
 * file is 0600: it holds a login.
 */
export const exportShopifyAdminAuth = Effect.fn("agentChrome.exportShopifyAdminAuth")(function* ({
  output,
  store,
}: {
  readonly output: string;
  readonly store: string;
}) {
  yield* ensureAgentChrome;
  yield* checkShopifyLogin(store);
  const cookies = yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => chromium.connectOverCDP(AGENT_CDP),
      catch: () =>
        new AgentChromeError({ message: `Playwright could not connect to ${AGENT_CDP}.` }),
    }),
    (browser) =>
      Effect.tryPromise({
        try: () =>
          Option.match(Array.head(browser.contexts()), {
            onNone: () => Promise.reject(new Error("no default context")),
            onSome: (context) => context.cookies(SHOPIFY_URLS),
          }),
        catch: () =>
          new AgentChromeError({ message: "Could not read the agent Chrome's Shopify cookies." }),
      }),
    // Closing a browser connected over CDP only disconnects; the agent Chrome keeps running.
    (browser) => Effect.promise(() => browser.close()),
  );
  const fs = yield* FileSystem.FileSystem;
  const parent = path.dirname(output);
  yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
  const staged = path.join(parent, `.${path.basename(output)}.${String(process.pid)}`);
  yield* fs.writeFileString(staged, JSON.stringify({ cookies, origins: [] }, null, 2), {
    mode: 0o600,
  });
  yield* fs.rename(staged, output);
  return cookies.length;
});
