# E2E flakiness research

Measured in `wt-01` on 2026-10-18 at `eca17d0` (main fast-forwarded in), store `mw10013-e2e-shop-01`, e2e stage `e2e-mw-wt-01`. Nothing was fixed or changed; this is a measurement.

## Result

8 back-to-back `vp run test:e2e` runs: **7 clean (49/49), 1 failed (47 passed, 1 failed, 1 did not run).** One hydration timeout in 8 runs; no other spec failed once.

| Run | Passed | Failed | Flaky | Did not run | Duration |
| --- | ------ | ------ | ----- | ----------- | -------- |
| 1   | 49     | 0      | 0     | 0           | 4.2m     |
| 2   | 49     | 0      | 0     | 0           | 4.1m     |
| 3   | 49     | 0      | 0     | 0           | 4.6m     |
| 4   | 47     | 1      | 0     | 1           | 4.4m     |
| 5   | 49     | 0      | 0     | 0           | 4.0m     |
| 6   | 49     | 0      | 0     | 0           | 4.0m     |
| 7   | 49     | 0      | 0     | 0           | 4.1m     |
| 8   | 49     | 0      | 0     | 0           | 4.7m     |

Retries are off locally, so a "flaky" count is always 0; a failure is a failure.

Per spec file: `embedded/teams.spec.ts` 1 failure in 8 runs (12.5%); every other file 0 in 8. The file's second test did not run (serial mode skips the rest after a failure).

## The failure (run 4)

`test/e2e/embedded/teams.spec.ts:58`, "teams screen creates, adds members to, renames, and deletes a team", reported at 0ms because the failure is in `beforeAll`, the file's first test.

```
TimeoutError: locator.waitFor: Timeout 10000ms exceeded.
  - waiting for locator('iframe[src*="embedded=1"]:not([src*="chrome=window"])').contentFrame().locator('body[data-hydrated]')
    at awaitHydration (scripts/lib/embedded-app.ts:21:40)
    at prepareApp   (scripts/lib/embedded-app.ts:61:3)  <- the second wait, line 63
    at openApp      (test/e2e/embedded/app.ts:23:34)
    at teams.spec.ts:22:24                              <- beforeAll
TypeError: Cannot read properties of undefined (reading 'close')   <- afterAll, because beforeAll never set `context`
```

It is the `prepareApp` retry: the first `awaitHydration` (15s) timed out, the admin document was reloaded, and the second (10s) timed out too. So the frame got no `body[data-hydrated]` in about 25s across two loads. The `afterAll` TypeError is a consequence, not a second bug.

## Log evidence (run 4, `.logs/e2e/current`, 02:46:46–02:51:08 EDT)

The previous test (`socket.spec.ts`, passed in 7.9s) closed its socket, then nothing from the server for 31 seconds:

```
2026-10-18 02:49:43.088169500  [Backend] ShopActor.webSocketClose: shop=mw10013-e2e-shop-01.myshopify.com role=merchant code=1001:
2026-10-18 02:50:14.135485500  [Backend] ShopActor.fetch: shop=mw10013-e2e-shop-01.myshopify.com role=merchant: socket accepted
2026-10-18 02:50:14.238211500  [Backend] ShopActor.addFixture: ... workflows=2 orders=32 lineItems=6
```

The first line after the gap is the next file's `openApp` (`addFixture workflows=2`), after teams had already failed. No `socket accepted` was logged for teams' two loads, so the app frame never ran client code far enough to open its socket.

In that window and the whole run:

- No Vite message: no "Re-optimizing dependencies", no page reload, no 504 "Outdated Optimize Dep", no transform or server error. (Dependency optimization appears once per run, at server start, "because lockfile has changed", in the first run only; that is before any spec.)
- Vite does not log requests, so a module request that started and never finished would not appear either way. That cannot be ruled in or out from these logs.
- The Website log for the run (`.alchemy/log/e2e-mw-wt-01/Website/2026-10-18T06-47-08.746Z.log`) is the browser's console forwarded. It holds the same recurring noise as every run (Polaris `s-page` warnings, a `LiveWorkflowSwitch` hook-order error, one `TypeError: Failed to fetch` from `app.tsx:35` `beforeLoad` at 02:50:27, an icon fetch failure). The 02:50:27 one is during another file's test, after teams failed; none of it is timed to the 02:49:44–02:50:10 window.

## Hypotheses (unverified)

- The cause `prepareApp`'s JSDoc gives (the Cloudflare quick tunnel can leave a module request pending forever, so the server-rendered page shows but the client entry never hydrates) is conjecture. It has not been substantiated, and nobody knows what is happening. The evidence is consistent with it (no socket, no server error, a retry that also fails) but does not show a stuck request.
- Vite module loading (the maintainer's suspicion, also unverified): the client may pull in too many modules, possibly including server modules, so the dev server has a large module graph to serve through the tunnel on a cold or contended load. If so, the stall would be in loading the entry's imports, not in the tunnel. Nothing here measured the number of modules requested or their timing; that would be the next thing to look at.
- The failure was a first-test `openApp` right after a previous file, with the tunnel the common factor; it is not tied to teams' own code (the other 7 runs passed it).
- One failure in 8 runs is too few samples for a rate; the runs would need many more repeats to tell a per-boot rate from a one-off.

## An earlier, invalid batch

A first batch of 5 runs (before the Shopify CLI Connector App was authorized on the e2e store) failed identically every time and says nothing about flakiness:

- `orders.spec.ts:49` and `refresh.spec.ts:99` failed in `scripts/test-order.ts create` with `mw10013-e2e-shop-01.myshopify.com has no store auth with the scopes the fixture needs`; the rest of those two files did not run.
- `socket.spec.ts:16` failed 5/5 on `expect(...getByText(/^(No open orders|Sync from Shopify)$/u).first()).toBeVisible()` (line 29, 10s), and passes after the auth step. Why it depended on the auth was not established.
- `stores:check` only checks the store exists, so it did not catch the missing auth. The runbook's step 3 (`shopify store auth --store <store>.myshopify.com --scopes read_products,write_products,read_orders,write_orders,read_draft_orders,write_draft_orders`) is what fixes it.

## Raw output

`/tmp/wt01-e2e-run-{1..8}.txt` (the second batch), `/tmp/wt01-evidence/` (copy of `.logs/e2e/current`, the Website logs and `run4.log`, the extract for run 4). These are not in the repo.
