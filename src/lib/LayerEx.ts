import {
  Cause,
  ConfigProvider,
  Effect,
  Layer,
  Logger,
  References,
  Context,
} from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";

const CAUSE_RENDER_LIMIT = 2000;

/**
 * Bounded rendering of a non-Error `cause` value. Strings pass through (e.g. a
 * corrupt stored value attached as `cause`); everything else goes through
 * `JSON.stringify`, falling back to `String()` for circular or otherwise
 * non-serializable values (`JSON.stringify` also returns `undefined` for
 * `undefined`, functions, and symbols — the `??` covers that).
 *
 * The cap is hygiene for the general case, not any specific call site: this
 * renders arbitrary `unknown` values from every `catch: (cause) => new X({
 * cause })` site, present and future, and a future cause could be a caught
 * response body or raw event payload with no size bound. 2,000 chars is ample
 * for diagnosis while making log bloat structurally impossible; the explicit
 * `[truncated]` marker distinguishes a cap from a value that really ends there.
 *
 * Deliberately NOT `Inspectable.toStringUnknown`, which looks like a drop-in:
 * despite its declared `string` return type it yields runtime `undefined` when
 * a cause's top-level `toJSON` returns `undefined` (its `formatJson` wraps
 * `JSON.stringify` with no `??` guard), which would make the `.length` check
 * below throw inside the error renderer — the one path that must always
 * produce a string for `new Error(message)`. The `??` here guards exactly
 * that edge. Nothing is lost by staying bespoke: `JSON.stringify` already
 * invokes `Redacted.toJSON` (`"<redacted>"`) on nested secrets, so redaction
 * is equivalent; the only delta is circular values rendering as
 * `[object Object]` via the `String()` fallback instead of partial JSON.
 */
const renderCauseValue = (cause: unknown): string => {
  const stringify = () => {
    if (typeof cause === "string") return cause;
    try {
      return JSON.stringify(cause) ?? String(cause);
    } catch {
      return String(cause);
    }
  };
  const text = stringify();
  return text.length > CAUSE_RENDER_LIMIT
    ? `${text.slice(0, CAUSE_RENDER_LIMIT)}… [truncated]`
    : text;
};

/**
 * Renders an `Error` and its full `.cause` chain into one string. `Error`
 * causes recurse; `undefined`/`null` causes add nothing; any other cause value
 * renders via {@link renderCauseValue}. Without that last branch a non-Error
 * cause would silently vanish from diagnostics: everything not encoded in
 * `.message` is stripped at the RPC/serialization boundaries this string
 * crosses (see {@link causeToErrorMessage}).
 */
export const formatErrorMessage = (error: Error): string => {
  const message =
    error.name && error.name !== "Error"
      ? `${error.name}: ${error.message}`
      : error.message;
  if (error.cause instanceof Error)
    return `${message}\n[cause]: ${formatErrorMessage(error.cause)}`;
  if (error.cause === undefined || error.cause === null) return message;
  return `${message}\n[cause]: ${renderCauseValue(error.cause)}`;
};

/**
 * Flattens an Effect `Cause` into a single string suitable for `new Error(message)`
 * at an RPC / serialization boundary.
 *
 * Why a single string: TanStack Start's `ShallowErrorPlugin` and Cloudflare DO
 * RPC both strip everything except `.message` when an `Error` crosses the
 * boundary — `.name`, `._tag`, `.cause`, `.stack`, and custom properties are
 * dropped, then the client reconstructs `new Error(message)`. Anything not
 * encoded inside `.message` is gone.
 *
 * `Cause.prettyErrors` normalizes arbitrary failures and defects (strings,
 * primitives, plain objects, `Error` subclasses, Effect `TaggedError`s, nested
 * causes) into `Error[]`, so this works regardless of what user code threw or
 * failed with. `formatErrorMessage` then walks each `.cause` chain so the full
 * chain renders into the joined string. This is especially important for
 * unannotated `Effect.tryPromise`, whose `UnknownError` wrapper has a generic
 * message ("An error occurred in Effect.tryPromise") and the useful detail on
 * `.cause`.
 */
export const causeToErrorMessage = <E>(cause: Cause.Cause<E>): string =>
  Cause.prettyErrors(cause).map(formatErrorMessage).join("\n");

/**
 * Deliberate `unknown` passthrough for promises whose rejections carry
 * framework control flow — TanStack `redirect`/`notFound` objects and raw
 * `Response`s thrown by `serverEntry.fetch` or middleware `next()` — that the
 * worker seam (`httpControlFlow` in `worker.ts`) must rethrow as-is. Wrapping
 * these in a tagged error would bury the control-flow value inside an app
 * error. Use only at framework seams; everywhere else annotate the catch with
 * a tagged error.
 */
export const tryPromisePassthrough = <A>(
  evaluate: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause });

/**
 * Callback bridge for layers wrapping callback-driven promise APIs (e.g.
 * better-auth's `sendMagicLink`/`databaseHooks`): snapshot the already-built
 * per-request context at layer-build time and derive a local promise runner
 * from it, so callbacks invoked later from inside the foreign library's
 * promise machinery still run with this request's services and logger. This is
 * effect's own idiom — `IndexedDbDatabase` and `NodeHttpServer.makeHandler` do
 * the identical context snapshot; `runPromiseWith` (not `runForkWith`) because
 * these libraries await their callbacks and propagate rejections through their
 * own error paths. The requirement `R` propagates into the calling layer's
 * dependencies, keeping the layer graph honest.
 */
export const makeRunPromise = <R = never>() =>
  Effect.map(Effect.context<R>(), Effect.runPromiseWith);

export const makeEnvLayer = (env: Env) =>
  Layer.succeedContext(
    Context.make(CloudflareEnv, env).pipe(
      Context.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
    ),
  );

/**
 * Builds the logging layer, choosing the console format by deployment target.
 *
 * Only `ENVIRONMENT === "local"` uses `consolePretty()`. In a Worker there is no
 * TTY, so `consolePretty` resolves to its browser mode and emits one `console.*`
 * call per fragment (group header, cause, and each annotation) with `%c` color
 * directives. Cloudflare's log pipeline records each call as a separate entry,
 * so a single `Effect.logError` is shredded across several rows — the header row
 * appears message-less while the real text sits on a sibling row. That is fine
 * for an attached local dev terminal but unreadable in the dashboard and in
 * `tail:staging`/`tail:PRODUCTION` output.
 *
 * Every deployed environment (staging, production) therefore uses `consoleJson`:
 * one `console.log` of a single JSON string per event, so `message` and `cause`
 * stay intact as fields in one log entry.
 *
 * Logging convention (obscure, enforced at every call site): pass a SINGLE
 * string to `Effect.log*` and attach structured context via
 * `Effect.annotateLogs`, e.g.
 * `Effect.logError("X failed").pipe(Effect.annotateLogs({ error }))`. Do NOT use
 * the `Effect.logError("X failed", { error })` two-argument form: `consoleJson`
 * (`formatStructured` in effect's Logger.ts) renders the `message` field as the
 * value itself only for one argument, but as an ARRAY for two or more. Cloudflare
 * Workers Logs surfaces a string `message` in the dashboard Message column; an
 * array leaves that column blank. Annotations land in the separate, indexed
 * `annotations` field, which is the structured shape Workers Logs recommends.
 *
 * Make the message scannable: when a fixed label would be too generic to tell
 * entries apart in the Message column (e.g. `"ShopAgent.bump"` repeated for
 * every step), interpolate the distinguishing value into the string, e.g.
 * `Effect.logInfo(\`ShopAgent.bump: shop=${shop}\`)`. Keep that same value in
 * `annotateLogs` too so it stays a queryable field; the interpolation is for
 * human scanning, the annotation for filtering. Avoid interpolating high-volume
 * unbounded values that would only bloat the column.
 *
 * Log level mirrors the split: `Debug` locally for development noise, `Info` in
 * deployed environments.
 */
export const makeLoggerLayer = (env: Env) => {
  const isLocal = env.ENVIRONMENT === "local";
  return Layer.merge(
    Logger.layer(
      isLocal
        ? [Logger.consolePretty(), Logger.tracerLogger]
        : [Logger.consoleJson, Logger.tracerLogger],
      { mergeWithExisting: false },
    ),
    Layer.succeed(References.MinimumLogLevel, isLocal ? "Debug" : "Info"),
  );
};
