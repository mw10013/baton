import type { Page, Request, TestInfo } from "playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";

/** One request from a frame below the admin's own document. Times are epoch milliseconds. */
interface FrameRequest {
  readonly url: string;
  readonly type: string;
  readonly start: number;
  /** When the response head arrived; set with a head and no `end` is a body that never finished. */
  headers?: number;
  status?: number;
  end?: number;
  failure?: string;
}

interface Watch {
  readonly requests: Map<Request, FrameRequest>;
  readonly console: Array<string>;
}

const watches = new WeakMap<Page, Watch>();

/**
 * Where {@link reportLoad} appends one line per app load when `E2E_FRAME_LOG=1`: duration, request
 * and script counts, peak requests in flight, and the slowest requests.
 */
const LOAD_LOG = ".logs/e2e/frame-loads.jsonl";

/**
 * Records `page`'s requests from every frame but the admin's own document, and the console of
 * all its frames, once per page; a second call returns the first watch. Cheap enough to stay on:
 * listeners and a map entry per request, read only by {@link reportLoad}.
 */
export const watchFrameRequests = (page: Page): Watch => {
  const existing = watches.get(page);
  if (existing) return existing;
  const watch: Watch = { requests: new Map(), console: [] };
  watches.set(page, watch);
  const at = () => new Date().toISOString();
  page.on("request", (request) => {
    if (request.frame() === page.mainFrame()) return;
    watch.requests.set(request, {
      url: request.url(),
      type: request.resourceType(),
      start: Date.now(),
    });
  });
  page.on("response", (response) => {
    const entry = watch.requests.get(response.request());
    if (!entry) return;
    entry.headers = Date.now();
    entry.status = response.status();
  });
  page.on("requestfinished", (request) => {
    const entry = watch.requests.get(request);
    if (entry) entry.end = Date.now();
  });
  page.on("requestfailed", (request) => {
    const entry = watch.requests.get(request);
    if (!entry) return;
    entry.end = Date.now();
    entry.failure = request.failure()?.errorText ?? "failed";
  });
  page.on("console", (message) => {
    watch.console.push(`${at()} ${message.type()} ${message.location().url}: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    watch.console.push(`${at()} pageerror: ${error.stack ?? error.message}`);
  });
  return watch;
};

const peakInFlight = (requests: ReadonlyArray<FrameRequest>, now: number) => {
  const edges = requests
    .flatMap((entry): Array<[number, number]> => [
      [entry.start, 1],
      [entry.end ?? now, -1],
    ])
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  let inFlight = 0;
  let peak = 0;
  for (const [, delta] of edges) {
    inFlight += delta;
    peak = Math.max(peak, inFlight);
  }
  return peak;
};

const describe = (entry: FrameRequest, now: number) =>
  `${(entry.end ?? now) - entry.start}ms ${
    entry.end === undefined
      ? `pending (${entry.headers === undefined ? "no response head" : `head after ${entry.headers - entry.start}ms, body unfinished`})`
      : (entry.failure ?? String(entry.status))
  } ${entry.url}`;

/**
 * Reports the app load that began at `since`. A load that did not hydrate gets the frame's
 * requests still pending, its failed ones, and the console, printed and attached to the test, so
 * a stall names the request it waited on instead of only timing out.
 */
export const reportLoad = async (
  page: Page,
  testInfo: TestInfo,
  since: number,
  hydrated: boolean,
) => {
  const watch = watchFrameRequests(page);
  const now = Date.now();
  const requests = [...watch.requests.values()].filter((entry) => entry.start >= since);
  if (process.env.E2E_FRAME_LOG === "1") {
    mkdirSync(".logs/e2e", { recursive: true });
    appendFileSync(
      LOAD_LOG,
      `${JSON.stringify({
        at: new Date(since).toISOString(),
        test: testInfo.titlePath.join(" > "),
        hydrated,
        ms: now - since,
        requests: requests.length,
        scripts: requests.filter((entry) => entry.type === "script").length,
        pending: requests.filter((entry) => entry.end === undefined).length,
        peakInFlight: peakInFlight(requests, now),
        slowest: requests
          .toSorted((a, b) => (b.end ?? now) - b.start - ((a.end ?? now) - a.start))
          .slice(0, 5)
          .map((entry) => describe(entry, now)),
      })}\n`,
    );
  }
  if (hydrated) return;
  const report = [
    `The app frame did not hydrate within ${now - since}ms; ${requests.length} frame requests.`,
    "Pending:",
    ...requests.filter((entry) => entry.end === undefined).map((entry) => describe(entry, now)),
    // A request a previous document left in flight can hold this load's, as Chrome's cache lock
    // holds a GET behind another for the same URL; list them so the holder is named.
    "Pending since before this load:",
    ...[...watch.requests.values()]
      .filter((entry) => entry.start < since && entry.end === undefined)
      .map((entry) => describe(entry, now)),
    "Failed:",
    ...requests.filter((entry) => entry.failure !== undefined).map((entry) => describe(entry, now)),
    "Console:",
    ...watch.console,
  ].join("\n");
  console.error(report);
  await testInfo.attach("app-frame-requests.txt", { body: report, contentType: "text/plain" });
};
