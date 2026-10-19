/**
 * What this checkout's local servers (the dev server and the e2e server, both Shopify CLI's
 * `shopify app dev` in front of `alchemy dev`) are found and probed by: the processes on a port,
 * whether the port answers, the quick tunnel the CLI opened and whether that tunnel serves.
 *
 * @module
 */
import * as Array from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Resolver } from "node:dns/promises";

import { runCommand } from "./command.ts";

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
