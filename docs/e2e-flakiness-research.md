# E2E flakiness research

The embedded e2e specs sometimes timed out in `awaitHydration`: the app frame never got `body[data-hydrated]`, even after `prepareApp`'s reload-and-retry. It was never an assertion failure, and the spec it hit changed from run to run. On `main` during slice F it hit 3 of about 9 full runs.

**Cause:** the dev proxy in `@alchemy.run/cloudflare-runtime` (`WorkerProxy`, which serves the e2e server's public port) truncates a large response when the request carries `Connection: close`. The Shopify CLI's own proxy, which sits between the tunnel and that port, sends every request with `Connection: close`. When its upstream comes back short, it never ends the response it is relaying. The browser then holds one module request forever: headers received, body unfinished. The client entry's import graph never settles, so React never hydrates.

**Fix:** a pnpm patch to the runtime (`patches/@alchemy.run__cloudflare-runtime@2.0.0-beta.81.patch`). On a clean upstream close, the client socket is ended instead of destroyed. With the stall gone, `prepareApp`'s reload-and-retry is removed; it only hid the stall. `gotoApp` in the e2e helpers now records the app frame's requests, so a load that does not hydrate fails with its pending requests and console attached.

Measured in `wt-01` on 2026-10-18, store `mw10013-e2e-shop-01`, e2e stage `e2e-mw-wt-01`, after merging `main` (slice F's embedded specs: 30 app loads per run).

## Legacy comparison

`refs/baton-legacy` rarely hit this. Read-only comparison:

|                           | Legacy                                                                                             | Baton                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| How the app frame loads   | Admin URL; frame over the CLI's quick tunnel; **plain `vite dev`** (`@cloudflare/vite-plugin`)     | Same admin URL and tunnel; Vite runs as a child of **`alchemy dev`**, behind Alchemy's `WorkerProxy`, then workerd      |
| Proxy chain for a module  | tunnel → CLI proxy → Vite                                                                          | tunnel → CLI proxy → **Alchemy `WorkerProxy` (byte pipe)** → workerd → Vite                                             |
| Server                    | Long-lived `pnpm dev:start`, warm; a preflight checks that the tunnel answers and a session exists | Playwright `webServer` starts a fresh stage, a fresh Vite and a fresh tunnel each run; readiness is a localhost `GET /` |
| Hydration marker and wait | `body[data-hydrated="true"]`; 15 s, reload, then a wait bounded by the 10 s action timeout         | `body[data-hydrated]`; 15 s, reload, 10 s (now one 15 s wait, no reload)                                                |
| Vite                      | No `optimizeDeps`, `warmup` or SSR settings; `importProtection` for `better-auth`/`kysely`         | No `optimizeDeps`, `warmup` or SSR settings; no `importProtection`                                                      |
| Workers                   | 1 for the whole suite                                                                              | Embedded project 1, serial per file; the `chromium` project runs in parallel against the same server                    |
| Effect imports            | The `effect` barrel (one prebundle)                                                                | One module per path (about 30 prebundled chunks)                                                                        |

The difference that matters is the second row. Legacy's chain has no `WorkerProxy`, and the defect lives in that hop. The other differences turned out not to matter (see Evidence):

- the cold server and new tunnel per run;
- parallel projects;
- the prebundle layout;
- module count.

## Evidence

### Instrumenting the frame

`gotoApp` was wrapped to log every request from frames below the admin document: start, response head, finish or failure, and duration. It also logged the console. A load that did not hydrate dumped its pending requests. Each load also wrote counts, peak requests in flight and the slowest requests to a JSONL file.

**A cold app load.** About 250 requests, of which 241 are scripts:

- 121 raw `node_modules/.pnpm` files: `@tanstack/react-router`, `router-core` and `start-client-core`, which TanStack Start excludes from prebundling;
- 52 prebundled `.vite/e2e/deps` chunks;
- 56 `src/web` modules, 5 `src/contract` and 3 `src/domain`.

The peak was 25–77 requests in flight. That is far under a quick tunnel's in-flight cap, and no request returned 429 or 504. Hydration took 3.1 s at the median and 5.0 s at the 90th percentile.

**Server-only modules.** `alchemy/Cloudflare/Bridge` is in the client's prebundle metadata. Vite's dependency scan reads raw `src/web/server/*.ts` before the Start compiler strips server-function handlers. The browser never requests it, though: no `src/backend` module and no Bridge chunk appears in any load. It costs one optimizer entry, not a client module, and is not the stall.

### Catching the stall

The first loop ran 9 instrumented runs (270 loads) before the fix. Every run passed 49/49, but 9 loads (3.3%) only hydrated thanks to the reload:

| Run | Loads | Rescued by the reload | Request pending at 15 s                       |
| --- | ----- | --------------------- | --------------------------------------------- |
| 0   | 30    | 0                     |                                               |
| 1   | 30    | 0                     |                                               |
| 2   | 30    | 1                     | `react-dom_client.js`                         |
| 3   | 30    | 0                     |                                               |
| 4   | 30    | 2                     | `Schema-*.js`, `seroval/dist/dev/index.js`    |
| 5   | 30    | 1                     | `Stream-*.js`                                 |
| 6   | 30    | 0                     |                                               |
| 7   | 30    | 5                     | `Effect-*.js` ×2, `seroval` ×2, `Schema-*.js` |
| 8   | 30    | 0                     |                                               |

Every rescued load had exactly one request pending for its whole 15 s, while the other ~250 finished in under 0.5 s. The pending request was always one of the largest modules (`Effect` 780 KB, `Stream`, `Schema`, `react-dom_client`, `seroval`). A run fails when the reload's load stalls too. Stalls cluster (run 7 had 5), which fits main's 3 failures in 9: main ran while the machine was busy with other e2e and dev servers.

### Finding the hop

The module list from a real load was replayed outside the browser, with 70 requests in flight, against each hop of a running e2e server:

| Target                                                         | Requests | Hung (20 s timeout)                                                   |
| -------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| Vite child, directly                                           | 24,100   | 0                                                                     |
| Alchemy `WorkerProxy` (port 4001), Node `fetch` (keep-alive)   | 24,100   | 0                                                                     |
| Shopify CLI proxy (`[::1]:<proxy port>`)                       | 24,100   | **9**: `react-dom_client` ×2, `Stream`, `Effect`, `rpc`, `seroval` ×4 |
| The CLI's own `http-proxy-node16`, standalone, → Vite          | 14,460   | 0                                                                     |
| The CLI's own `http-proxy-node16`, standalone, → `WorkerProxy` | 14,460   | **5**: response head after 12–90 ms, body never finished              |

So the stall needs both the CLI proxy and `WorkerProxy`. The CLI's proxy (`http-proxy` with no agent) sends `Connection: close` on a fresh connection per request. Fetching straight from `WorkerProxy` with `Connection: close` and checking each body against its `Content-Length` showed the defect:

| `WorkerProxy`, unpatched           | Requests | Short bodies                                                        |
| ---------------------------------- | -------- | ------------------------------------------------------------------- |
| `Connection: close`                | 2,220    | 2 (`Effect-*.js`: 760,688 of 781,374 bytes, then the socket closed) |
| keep-alive                         | 2,220    | 0                                                                   |
| Vite directly, `Connection: close` | 2,220    | 0                                                                   |

## The cause

`WorkerProxy` (`@alchemy.run/cloudflare-runtime`, `src/core/proxy/WorkerProxy.ts`, `makeRelay`) splices each client connection to workerd with `upstream.pipe(socket)`, then does this:

```ts
upstream.on("close", () => socket.destroy());
```

With `Connection: close`, workerd closes its socket right after the last byte. `pipe` has already read those bytes, but some may still be queued on the client socket when the client is slow or behind backpressure. That happens only for large bodies. `destroy()` discards the queue, so the response ends short of its `Content-Length`. Unchanged in `2.0.0-beta.83`, the latest at the time of writing.

On its own, a short response would be an error the browser could see. Behind the Shopify CLI's proxy it is a hang: `http-proxy` does not end the response it is relaying when its upstream response is cut short. The tunnel keeps the browser's request open, with headers received and the body never finished. The module waits forever, so does the client entry that imports it, and `data-hydrated` never appears. That also explains the original evidence: no `socket accepted`, no server error, no Vite message.

Neither hypothesis held:

- **The tunnel:** direct replays through the CLI proxy hang without a tunnel.
- **Module-graph size:** the count is about 250 and stable, and Vite serves it all in under 0.5 s.

The graph's size only matters because the large modules are the ones that get cut.

## The fix

- **`patches/@alchemy.run__cloudflare-runtime@2.0.0-beta.81.patch`:** the relay ends the client socket on a clean upstream close (`socket.end()`, after `pipe` has flushed) and destroys it only when the close had an error. Recorded in `docs/dependency-patches-runbook.md` with when to retire it.
- **Verification at the hop:** patched `WorkerProxy` with `Connection: close` returned 0 short bodies in 4,440 requests, and 24,100 requests through the CLI proxy had 0 hangs (max 163 ms).
- **`prepareApp`:** one 15 s wait, no reload. A healthy cold load hydrates in about 3 s, so a frame still waiting at 15 s is stuck on a request. A reload would only make it fail later and less legibly.
- **`test/e2e/embedded/frame-requests.ts`:** `gotoApp` (the e2e wrapper) watches the app frame's requests and console on every load. It costs a listener and a map entry per request. A load that does not hydrate prints, and attaches to the test, its pending requests (marked "no response head" or "body unfinished"), its failed requests and the console. `E2E_FRAME_LOG=1` also appends one line per load to `.logs/e2e/frame-loads.jsonl`: duration, counts, peak in flight and the slowest requests.

An upstream Alchemy issue is owed: `WorkerProxy` destroys the client on upstream close and truncates `Connection: close` responses. The fix is above.

## Runs

**Before** (the first loop, unpatched, with the reload-and-retry): 9 runs, 270 app loads, all 49/49, but 9 loads needed the reload. The earlier measurement at `eca17d0` failed 1 of 8 runs (`teams.spec.ts`, both waits timed out), and main failed 3 of about 9.

| Run | Passed | Failed | Did not run | Loads rescued by reload | Duration |
| --- | ------ | ------ | ----------- | ----------------------- | -------- |
| 0   | 49     | 0      | 0           | 0                       | 4.8m     |
| 1   | 49     | 0      | 0           | 0                       | 5.0m     |
| 2   | 49     | 0      | 0           | 1                       | 4.6m     |
| 3   | 49     | 0      | 0           | 0                       | 4.3m     |
| 4   | 49     | 0      | 0           | 2                       | 4.6m     |
| 5   | 49     | 0      | 0           | 1                       | 4.8m     |
| 6   | 49     | 0      | 0           | 0                       | 4.4m     |
| 7   | 49     | 0      | 0           | 5                       | 5.4m     |
| 8   | 49     | 0      | 0           | 0                       | 4.5m     |

**After** (patched, no reload, so any stall is a failure). The plan was 12 runs; it was stopped after 2 on the maintainer's call. Each run takes about 5 minutes, and quick-tunnel creation was being rate-limited (below):

| Run | Passed | Failed | Did not run | Loads not hydrated in 15 s | Median / max load | Duration |
| --- | ------ | ------ | ----------- | -------------------------- | ----------------- | -------- |
| 1   | 49     | 0      | 0           | 0 of 30                    | 3.3 s / 7.0 s     | 4.6m     |
| 2   | 49     | 0      | 0           | 0 of 30                    | 3.3 s / 9.0 s     | 4.6m     |

Two runs are thin on their own. At the before-rate (9 stalls in 270 loads), about 2 stalls would be expected in these 60 loads, and there were none. The stronger evidence is the hop-level replay: 24,100 requests through the CLI proxy hung 9 times unpatched and 0 times patched. If a stall ever does come back, the failing test now names the pending request.

Retries are off locally, so a failure is a failure.

## Not the flake: tunnel creation

After the fix, `shopify app dev` repeatedly failed to start with `Could not start Cloudflare tunnel: max retries reached`. Asked directly, `POST https://api.trycloudflare.com/tunnel` answered **HTTP 429, Cloudflare error 1015**: this machine's IP was rate-limited for creating quick tunnels. Many had been created in a short time: this investigation's server restarts, plus four dev servers and main's e2e on the same machine, each restart a new tunnel. The limit is per IP, so it stops every checkout's e2e and dev restarts at once. The runs above began once the API answered 200 again. Attempts that died on tunnel creation are not counted.

This is separate from hydration. If it recurs, wait for `api.trycloudflare.com` to stop answering 429. A named tunnel (`shopify app dev --tunnel-url`) would remove the dependency on quick tunnels altogether.

## Second stall: `getShopifyApp` with no response head

After the proxy fix was merged (e76df60), main's run 1 (15:32–15:37 EDT) lost `embedded/workflows.spec.ts` "editing the tag from the detail page writes immediately and starts no draft" at `awaitHydration`, 15.1 s in. The new report named one pending frame request, with **no response head** after 15,070 ms: the `getShopifyApp` server function, through the tunnel. This is a different signature from the proxy truncation, where a large module's head had arrived and its body stalled.

### Where it stopped

- **Not in the handler.** `getShopifyApp` returns two bindings (`SHOPIFY_API_KEY`, `SHOPIFY_APP_URL`). It touches no D1, no Backend and no Admin API. The `/app` route's `beforeLoad` calls it on every client load and navigation, hydration included, and hydration waits on it.
- **Main's server log can't place it.** The Website doesn't log server-function requests, and nothing Backend-side is involved. Around 15:36:56–15:37:11, the stalled load's window, the log has no Website line and no `socket accepted`. That is consistent with a load stuck before React mounts.
- **The timing.** The previous test ("duplicate asks for a tag…") ends with `searchWorkflows`, a client navigation that re-runs `beforeLoad`, and so issues a `getShopifyApp`. The failing test began at about 15:36:56 with a fixture add, then `gotoApp`. At **15:36:56.000** the Website log forwarded a browser `TypeError: Failed to fetch` whose stack runs through App Bridge's `fetch` wrapper into a route `loadResource`. That is a server-function fetch from the old frame, aborted as the admin navigated.
- **Replay can't reproduce it**, against a wt-01 e2e server, 20 calls in flight:

  | Target | `getShopifyApp` calls | Stalled | Max |
  | --- | --- | --- | --- |
  | Vite child | 3,000 | 0 | 59 ms |
  | Alchemy `WorkerProxy` (patched) | 3,000 | 0 | 65 ms |
  | Shopify CLI proxy | 3,000 | 0 | 84 ms |
  | Quick tunnel | 3,000 | 0 | 400 ms |

  So no hop on the server side loses it.

### The mechanism: Chrome's cache lock on a same-URL GET

`getShopifyApp` was `method: "GET"` with no input, so every call, from every load and every navigation, requested the **same URL**. Chrome's HTTP cache allows one transaction per URL. Another GET for that URL in the same browser context waits, **unsent**, until the first finishes, for up to about 20 s. Playwright reports such a request as issued with no response head.

Measured with a local server and headless Chrome (`channel: "chrome"`, as the e2e projects use). The first `/fn` takes 8 s; the second asks for the same URL:

| Second request | Waited | Reached the server |
| --- | --- | --- |
| GET, same URL, first still in flight in another page of the context | **7,452 ms** | only after the first finished |
| GET, same URL, first aborted by navigating its page | 2 ms | at once |
| GET, same URL, first's head sent and body slow | 2 ms | at once |
| **POST**, same URL, first still in flight in another page | 2 ms | at once |

That matches the signature exactly. What it doesn't establish is which request held the lock in main's run: the aborted fetch at 15:36:56.000 should have released it, and the report then listed only requests started during the load. Hence the instrumentation change below.

### The fix

- **`getShopifyApp` is `method: "POST"`.** Chrome never holds a POST behind another request, so no frame can sit behind a same-URL GET from any document in the context. It reads nothing, so there's nothing to cache. It is the only constant-URL server function: `authenticateApp`'s URL carries the document's `id_token`.
- **The stall report also lists requests still pending from before the load** ("Pending since before this load"). If a load ever waits behind a holder again, the holder is named.

### Run

One full run on wt-01 with the change, against `mw10013-e2e-shop-01`. All 38 app loads hydrated (median 3.1 s, 90th percentile 3.9 s, max 6.3 s), every one through the POST `getShopifyApp`. The run had 51 passed, 3 failed and 13 did not run, none of it in hydration:

- **2 failures, same cause.** `order-page.spec.ts:58` and `orders.spec.ts:178`, via `openOrders`: strict-mode violation on `navLink(page, "Orders")`. On this store, the admin nav shows Shopify's own Orders link beside the app's, and the locator isn't scoped to the app's nav section.
- **1 failure.** `workflows.spec.ts:336`: the editor's "Your unsaved changes will be lost." stayed hidden.

These come from slice F's specs as merged (6d61508), not from this change. They are for the slice F implementer.

One run can't show the rate; main saw this stall once. The case for the fix rests on the mechanism: the exact signature, reproduced in Chrome, and gone with POST.
