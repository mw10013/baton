# Plan: billing (slice G)

Implements `docs/billing-research.md` (settled 2026-10-18, Q1–Q17) under `docs/legacy-port-research.md` §0.1 (A1–A3), §0.2 (naming by role) and roadmap Q7 (legacy's App Pricing and Partner API design) and Q8 (cron on the Backend). Read the research's §0, §1.0, §1.3 and §4 first; this plan does not restate the reasons.

Legacy paths are relative to `refs/baton-legacy/`.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; the JSDoc rules (no `//` above a declaration, no reference to this plan, the research or any `docs/` file in code); the logging and SQL rules; layout only in parts under `src/web/components/screen/`.
- Work on `main`. Commit at the end of each green step. Stage paths explicitly; never `git add -A` or `git commit -a`.
- Each step ends green: `vp check`, `vp test` (unit, browser, integ) and, from Step 5 on, `vp run test:e2e` (a subset or the full suite, as the step needs). A step that cannot end green is recorded in §7 before moving on. Do not re-run the full e2e suite through a failure already understood; record it and fix the cause.
- A step that adds or deletes a route under `src/web/routes/` regenerates `src/web/routeTree.gen.ts` (`vp build`) before `vp check`.
- **No table changes**: `migrations/0001_init.sql` and the actor's `0001_init` stay as they are. Never `db:reset` the `staging` stage, `cloud:reset`, `alchemy deploy` or `vp run deploy:staging`; touch the `dev` stage only by running the dev server.
- Names follow roadmap §0.2 and research Q2: `makeUsageRepository` stores, `makeBilling` is the actor's billing service; Backend `ShopifyPartner`, `SubscriptionPlan`, `ShopifyAppEvents`. Nothing is called an agent.
- Each callable lands as the research's §1.3 table says, and nothing else. No new `DevRpcs`. `IntegRpcs` grow only by §3's rows.
- **Transactions.** Never nest one. `countOrder` runs inside the run repository's caller's transaction and touches storage only. **No network, no D1 and no flush inside a `transaction(…)`**; the flush is always after the write commits.
- **"We could not ask" is never "you have not paid".** A Partner, D1 or decode failure is `SubscriptionPlanError`: an error page on `/app`, `503` at the socket gate. Only a verified absence is `Unsubscribed`.
- The browser never names its own tier: no plan reaches route context or a server function's input.
- Secrets: never print, log or commit the Partner token or the app secret; check `.env` files by names only (`sed -E 's/=.*/=<hidden>/'`).
- Legacy is the spec, not the source. Keep legacy's method, error and constant names, test titles (byte for byte), copy and part names. Port SQL and JSDoc rules verbatim, lowercase. Where a JSDoc states Shopify's answers and Step 0 measured otherwise, write what was measured, dated.
- Do not rewrite the steps. Record what you built differently, and what surprised you, in §7 as you go.
- The integ suite leaks `.alchemy/local/baton-test-…-ShopActor` directories; delete the ones your runs create.

## 1. Outcome

- `/app` opens only for a shop with an app subscription on `baton-basic` or `baton-pro`. Otherwise it redirects, out of the frame, to the app's plan selection page; Shopify's return with `plan_handle` re-reads the plan at once. An unreachable Partner API is an error page, never a redirect.
- The plan is cached on `ShopSession` for 24 h, clamped to the app subscription's boundary plus 5 minutes; Manage plan shortens it to 15 minutes; a daily cron (`17 4 * * *`) re-reads every stale shop. A plan change closes every socket of the shop, and a reconnect meets the new answer: `402` for a lapse.
- An order is counted once, when its first run is created, against the billing cycle Shopify reports (or a provisional one); the counted order and each rise in seats are queued as usage events and sent to the App Events API after the write commits, on legacy's paths, and before an uninstall.
- The home page's **Your plan**: "Orders this billing cycle" and "Members" meter tiles with their detail lines, and Manage plan. `QuotaBanners` on the home page and the orders index. Both live.
- A member of a lapsed shop lands on **Subscription inactive** (`/shop/$key/lapsed`); the member socket answers `402`.
- Dev and e2e run on real $0 subscriptions; the test Backend fakes Partner and App Events.

## 2. What this plan rests on

- **Tables**: research §0.1. `ShopSession`'s plan columns are outside the auth upsert (`ShopSessionRepository`, `ShopSessionUpsert`).
- **F's seams**: the actor's `countOrder` and `flushUsage` no-ops (`src/backend/shop-actor.ts`), `makeRunRepository`'s `countOrder(orderId, now)` call after each run insert, `flushUsage` at legacy's five sites in `makeRuns` and `makeOrders` (unit-pinned in `test/unit/backend/shop-actor/`).
- **The gate**: `ShopAccess` (`merchant`, `member`, `resolve`, `resolveMember`), `ShopAccessDenied`, the upgrade route that turns a refusal into a close code, `actor-connection.ts`'s close outcomes (`3401` → "revoked"), `ShopActor.revoke` / `closeTagged`.
- **`/app`**: `beforeLoad` → `authenticateApp` (`src/web/server/shopify.ts`) → `BackendApi.authenticateAdmin`; `/auth/exit-iframe` exists.
- **The home page**: `src/web/routes/app.index.tsx` with the setup guide and the Orders strip; `setupFacts` server function.
- **Configuration**: `ShopifyApp` and `wireBackend` in `src/backend/stack.ts`; `StageConfigValues`; `docs/stage-config-runbook.md` ("Add a value").
- **Tests**: `ActorSqliteTest`; the D1 adapter of `test/unit/backend/membership-repository.test.ts` and `shop-session-repository.test.ts`; `ShopifyFake` and `IntegRpcs` in `test/integ/`; e2e `openApp`, `ownMember`, `AddToFixture`, the `install` and `shopify-admin` setup projects.
- **Unproven**, checked first: the Partner API's `activeSubscription` at `2026-10` for Baton Dev, and App Events `2026-10` (Step 0); whether Baton Dev's plans and the `mw10013-*` stores are in one organization (Step 0); `Cloudflare.Workers.cron` on the Backend under `alchemy dev` and in the test stage (Step 4); whether Manage plan's Backend call survives the browser leaving (Step 7).

## 3. Names and constants

| Name                                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/domain/billing.ts`                                              | Legacy `domain/Billing.ts` whole: `PlanHandle`, `Plan`, `planOfHandle`, `Entitlements`, `ENTITLEMENTS`, `entitlementsOfPlan`, `MAX_ENTITLEMENTS`, `USAGE_METER_ORDER` (`production-orders`), `USAGE_METER_MEMBER` (`members`), `PlanStatus`, `AppSubscription`, `ShopUsage` (triggers table), `BillingCycleInput`, `provisionalCycleStart`, `UsageEvent`, `usageEventIsExpired`, `seatEventValue`, `AdminShopPlanCache`, `adminShopPlanCache`, `adminShopEntitlements`; `membersAtCeiling` stays. `openOrdersAtCeiling` stays where it is. |
| `makeUsageRepository` (`src/backend/shop-actor/usage-repository.ts`) | `makeUsageRepository(sql, transaction)`: `countOrder(orderId, now)`, `setBillingCycle(input)`, `flushUsageEvents(shop)` (requires `ShopifyAppEvents`), `getUsage()`; privates `readCycle`, `currentCycle`, `countedSince`, `raiseSeatMark`, `queueUsageEvent`, `countKey`, `seatKey`; `ShopUsageRow`, `UsageEventRow`, `UsageFlush`; `UsageRepositoryError`. Legacy SQL.                                                                                                                                                                   |
| `makeBilling` (`src/backend/shop-actor/billing.ts`)                  | `makeBilling({ usageRepository, notify, shop, databaseSize })`: `flushUsageEvents` (logged, never raised, answers `UsageFlush`), `getUsage` (with `databaseSize`), `setBillingCycle(input)` (write, notify `ORDERS_KEY` when the count or cycle changed, then flush). Log prefix `Billing.`. The actor passes `billing.flushUsageEvents` as `flushUsage` and `usageRepository.countOrder` as `countOrder`.                                                                                                                                 |
| `ShopifyAppEvents` (`src/backend/shopify-app-events.ts`)             | Legacy's service; key and secret from the `Shopify` binding; `APP_EVENTS_API_VERSION` constant (Step 0); `ShopifyAppEventsError`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ShopifyPartner` (`src/backend/shopify-partner.ts`)                  | Legacy's service: `activeSubscription(shopGid)`, `planSelectionUrl(shop)`; `PARTNER_API_VERSION` constant (Step 0); `ShopifyPartnerError`; `planSelectionExitIframeHref`.                                                                                                                                                                                                                                                                                                                                                                  |
| `SubscriptionPlan` (`src/backend/subscription-plan.ts`)              | `resolve`, `refresh`, `expectChange`; `SubscriptionPlanError`; `PLAN_HANDLE_MAX_AGE_MS` 24 h, `PLAN_HANDLE_BOUNDARY_SKEW_MS` 5 min, `PLAN_HANDLE_MANAGE_WINDOW_MS` 15 min, `planHandleExpiresAt`, `cachedStatus`; `revalidateStalePlans` (concurrency 4); `entitlementsOfStatus`.                                                                                                                                                                                                                                                          |
| `ShopSessionRepository` additions                                    | `updatePlan({ shop, planHandle, planHandleExpiresAt, planBoundaryAt })`, `shortenPlanExpiry({ shop, notAfter })`, `listShopsWithStalePlan(now)` (legacy `updateShopSessionPlan`, `shortenShopSessionPlanExpiry`, `listShopsWithStalePlan`). `MembershipRepository.countMembers(shop)` if not present.                                                                                                                                                                                                                                      |
| Stub methods (`ShopActorShape`, `ShopActors`)                        | `getUsage()` → `ShopUsage`; `setBillingCycle(BillingCycleInput)`; `flushUsageEvents()` → remaining; `revoke` grows `by: "all"` (every socket, `3401`).                                                                                                                                                                                                                                                                                                                                                                                     |
| Procedure                                                            | `MerchantGetUsage` → `ShopUsage`, a query atom on `ORDERS_KEY` and `SYNC_KEY`.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `BackendApi`                                                         | `authenticateAdmin({ sessionToken, billingRedirect })` → `Subscribed { …today's fields, managePlanUrl } \| Unsubscribed { href }`; `homePlan` → `{ entitlements, usage, memberCount }` (or `Unsubscribed { href }`); the orders index's loader answer gains `usage`; `expectPlanChange`.                                                                                                                                                                                                                                                   |
| Server functions                                                     | `authenticateApp` (grows `billingRedirect`), `homePlan` (GET, `src/web/server/home.ts`), `prepareManagePlan` (POST).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Gate                                                                 | `ShopAccessDenied.status` gains `402`; `CONNECTION_CLOSE_PAYMENT_REQUIRED` = 4402 in `src/contract/shop-actor.ts`, terminal; on it `ShopSocket` invalidates the router.                                                                                                                                                                                                                                                                                                                                                                    |
| Cron                                                                 | `Cloudflare.Workers.cron("17 4 * * *", …)` on the Backend running `revalidateStalePlans`; `scheduled.revalidatePlans: shops=… failed=…`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Configuration                                                        | `SHOPIFY_PARTNER_API_TOKEN` (`Redacted`): dev and e2e from the checkout's `.env` through `Config`; staging a `StageConfigValues` field. Per-app constants (`partnerOrgId`, `partnerAppId`, `appHandle`) beside `ShopifyApp` for Baton Dev and Baton Staging. `test`: fakes, no token.                                                                                                                                                                                                                                                      |
| Routes                                                               | `shop.$key_.lapsed.tsx` (outside the member layout, static).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Components and parts                                                 | `ManagePlanButton` (`PREPARE_MANAGE_PLAN_WAIT_MS` 1500), `QuotaBanners` under `src/web/components/`; parts `MeterTile`, `Tiles` under `screen/` with their `Screen.ts` rows; `/dev/kit` sections for both parts.                                                                                                                                                                                                                                                                                                                           |
| `IntegRpcs`                                                          | `ScriptPartner` (a shop's answer: subscribed handle, cycle, trial, none, or a failure), `AppEventsSent`, `RevalidateStalePlans`, `ApiHomePlan`, `ApiUsage`.                                                                                                                                                                                                                                                                                                                                                                                |
| Test Backend fakes                                                   | `PartnerFake`, `AppEventsFake` beside `ShopifyFake` in `test/integ/`; the Partner fake answers `baton-pro` with a current monthly cycle for every shop unless scripted.                                                                                                                                                                                                                                                                                                                                                                    |
| Runbook                                                              | `docs/billing-runbook.md` (Step 10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 4. Steps

### Step 0: Spike and setup

- **Human steps first**, written under §7 "Human steps requested", then stop until they are done (the orchestrator relays them):
  1. A Partner API client token with the **Manage apps** permission (Partner Dashboard, Settings, Partner API clients), added to the main checkout's `.env` as `SHOPIFY_PARTNER_API_TOKEN` (worktrees: `worktree:init` links or copies `.env`; check which and record it).
  2. The Partner organization id and Baton Dev's Partner app id, confirmed (legacy: `2798461`, `417214922753`, handle `baton-local`), and that `baton-basic` and `baton-pro` exist on Baton Dev with both meters.
  3. A plan picked on `mw10013-dev-shop-00` and `mw10013-e2e-shop-00`: open `https://admin.shopify.com/store/<store>/charges/baton-local/pricing_plans` while signed in, select a plan, approve the $0 charge.
- **Spike**, a script outside `src/` (`scripts/` or a scratch file, deleted after): `activeSubscription` for each of the two stores' shop GIDs at `2026-10` and, if that fails, `2026-07`; record the response shape (redacted of nothing secret: handles, cycle, trial) in §7. Mint an App Events token and post one custom (non-billing) event, e.g. `baton_spike`, at `2026-10`; record the status and body, and one deliberate refusal (an unknown `shop_id`) to see the error shape. Record both versions chosen.
- **If `activeSubscription` returns null for a store that just subscribed, or an error naming the app or the organization**, record it under Issues and stop at `WAITING: Partner API` (the orchestrator brings it to the user: the stores or the app may sit in another organization).
- `CHECKPOINT: spike answered (<commit or "no commit">)` under §7 "Command results".

### Step 1: Domain

- `src/domain/billing.ts` (§3), legacy's JSDoc and tables; JSDoc that names legacy symbols that do not exist here names this repo's in backticks (`makeUsageRepository`'s `countOrder`, `SubscriptionPlan`, `ShopActors.setBillingCycle`), or drops a sentence about legacy's tooling (`pnpm spec check`, `scripts/rules-lint.ts`). The Shopify-answer sentences (`USAGE_METER_ORDER`, `UsageEvent.idempotencyKey`) say what Step 0 measured.
- Tests, unit (`test/unit/domain/billing.test.ts`): legacy `domain.test.ts`'s billing titles (research §4 row 1); `provisionalCycleStart`, `usageEventIsExpired`, `planOfHandle`, `adminShopPlanCache`'s five states, one title each in legacy's style.
- Verify: green.

### Step 2: Meter storage

- `makeUsageRepository` (§3), legacy's SQL and JSDoc. `countOrder` resolves the cycle before writing the marker, as legacy's comment says; a missing `ShopUsage` row dies.
- `ShopifyAppEvents` with legacy's token cache, `User-Agent` (`Baton/<handle>`), `401` retry with a fresh token, error text rules; the version from Step 0.
- Tests, unit over `ActorSqliteTest`: legacy `order-repository.test.ts` "OrderRepository usage" (titles unchanged; "reports whether the upsert created the row" only if not already ported, recorded either way), with a recording App Events layer for the flush titles; legacy `run-repository.test.ts` "RunRepository metering" (5) through `makeRunRepository` with the real `countOrder`. Legacy `shopify-app-events.test.ts` (5) with a fake `HttpClient`.
- Verify: green.

### Step 3: Meter in the actor

- `makeBilling` (§3). The actor builds it per activation and passes the real `countOrder` and `flushUsage` in place of the no-ops; `databaseSize` from `state.storage.sql.databaseSize` (check the Alchemy wrapper exposes it; record how).
- Stub methods `getUsage`, `setBillingCycle`, `flushUsageEvents`; `revoke` grows `by: "all"`; `MerchantGetUsage`.
- Uninstall: the webhook path calls `ShopActors.flushUsageEvents` (best-effort, `webhooks.app.uninstalled: shop=… pending=…: usage events unsent at uninstall`) before `destroy`.
- `ShopifyAppEvents` provided to the actor's runtime from the Backend's layer; the test Backend provides `AppEventsFake` (records events, scriptable refusal).
- Fixture: confirm `LoadFixture` and `AddToFixture` leave `ShopUsage` and the outbox untouched (legacy "reseeding leaves the usage counter unchanged").
- Tests, unit: legacy `shop-agent-usage-flush.test.ts` (6) over the services; F's call-site tests now see the real flush. Integ: research §4 row 2 (the two end-to-end titles, uninstall flushes first, `MerchantGetUsage` refused to a member); `shop-agent-connections.test.ts`'s "revokes every connection on the shop for a lapse" over `revoke({ by: "all" })`.
- Verify: green.

### Step 4: Plan and gate (Backend)

- **Check first**: declare the cron on the Backend and confirm the stack plans and deploys under `alchemy dev` and in an integ stage (no fire needed; `RevalidateStalePlans` runs the body). If Alchemy refuses it, read its cron docs and source first (`refs/alchemy/website/src/content/docs/cloudflare/messaging/cron.mdx`); record the cause; a small Alchemy bug gets a pnpm patch per `docs/dependency-patches-runbook.md`.
- `ShopifyPartner`, `SubscriptionPlan`, `revalidateStalePlans`, the `ShopSessionRepository` additions (§3), legacy's JSDoc. `revalidate` revokes through `ShopActors.revoke({ by: "all" })` on a handle change (not the first fetch) and pushes `ShopActors.setBillingCycle` with `MembershipRepository.countMembers` outside a trial; both best-effort, logged as legacy's.
- `BackendApi.authenticateAdmin` takes `billingRedirect`: after authenticating, `refresh` when true, else `resolve`; answers `Subscribed` with `managePlanUrl` or `Unsubscribed` with `planSelectionExitIframeHref`; a `SubscriptionPlanError` fails the call. `BackendApi.homePlan`, `expectPlanChange`, the orders index loader's `usage`.
- `ShopAccess`: the merchant branch resolves the plan after the shop check (`Unsubscribed` → `402`, failure → `503`); the member branch after membership (`404` first). `ShopAccessDenied` gains `402`; the upgrade route closes it with `CONNECTION_CLOSE_PAYMENT_REQUIRED`; `resolveMember` (member loaders) refuses `402` the same way.
- Configuration (§3): Baton Dev's constants and the `.env` token for dev and e2e; `test` binds the fakes. Staging's constants and stage config field wait for Step 10, but the code path that reads them (`ShopifyApp`'s staging arm) lands here with Baton Staging's values as a clearly failing placeholder only if the plan cannot be built without them; prefer adding the staging arm in Step 10.
- Test Backend: `PartnerFake`; `ScriptPartner`, `AppEventsSent`, `RevalidateStalePlans`, `ApiHomePlan`, `ApiUsage`.
- Tests, unit: legacy `subscription-plan.test.ts` (21) over `SubscriptionPlan` with the D1 adapter, a stub `ShopifyPartner`, a recording `ShopActors` and `TestClock`; legacy `repository.test.ts`'s two plan-column titles over `ShopSessionRepository`; `matchPlanHandle`'s zero and two matches; `authenticateAdmin`'s three answers. Integ: research §4 row 3.
- Verify: green; the existing 971 tests unchanged in count but for the additions.
- `CHECKPOINT: Backend half (<commit>)` under §7 "Command results". Continue unless the orchestrator says otherwise.

### Step 5: `/app` gate and the socket

- `/app`'s `beforeLoad` passes `billingRedirect: location.searchStr.includes("plan_handle")` and throws `redirect({ href })` on `Unsubscribed`; `managePlanUrl` into route context.
- `actor-connection.ts` and `ShopSocket`: `4402` is terminal (no reconnect) and invalidates the router; `3401` keeps today's behaviour. Merchant and member layouts both.
- Tests: browser, the socket's `4402` outcome beside legacy "the tab reconnects on 3401 and not on 4403". e2e: every embedded spec passes on the subscribed e2e store; the e2e setup checks the e2e store's plan once (an `ApiHomePlan`-like read, or `authenticateAdmin`'s answer) and fails with "pick a plan on `<store>` (docs/shopify-stores-runbook.md)" instead of redirecting every spec.
- Verify: green, full e2e once.

### Step 6: Your plan and QuotaBanners

- Parts `MeterTile`, `Tiles` (legacy's, `<progress max=limit value=count>`, full bar past the allowance); `QuotaBanners`. **Your plan** on the home page after the Orders strip, legacy's copy (research §1.1), Manage plan's slot left for Step 7; `QuotaBanners` on the home page (after `SocketBanner`) and the orders index. `MerchantGetUsage` seeded from `homePlan` and the orders index loader.
- `/dev/kit` sections for `MeterTile` and `Tiles`.
- Tests: browser (research §4 row 4). e2e in `test/e2e/embedded/`: "home renders a capacity meter per dimension"; "adding a member past the included seats succeeds and the home tile says it is billed" (its own members by test id; the e2e store's plan decides the allowance: read it from the meter's `max`, as legacy's billing spec does).
- Verify: green, e2e included.

### Step 7: Manage plan

- **Check first**: from a server function, a Backend call that the browser abandons (navigate `_top` away mid-call) still completes. Measure on the dev server: Manage plan, then read the dev log for the flush line and the plan row's deadline. If it is cut off, hold the Backend's work past the response (`ExecutionContext.waitUntil` in the Backend method, or the Website server function's own) and record which.
- `ManagePlanButton` on **Your plan** (legacy: secondary, `window.open(url, "_top")` once, after `prepareManagePlan` answers, fails, or 1.5 s).
- Tests: browser (opens once after the answer; opens at 1.5 s when the answer is slow; opens on failure).
- Verify: green.

### Step 8: Member half

- `shop.$key_.lapsed.tsx`: legacy's page verbatim (title "Subscription inactive — Baton", heading the shop, the section and paragraph, Your stores link), no loader, no socket.
- Member loaders (`resolveMember`) redirect a `402` to `/shop/$key/lapsed`; the member socket's `4402` invalidates the router, which lands there.
- Tests: integ research §4 row 5; browser the lapsed page.
- Verify: green, e2e included.

### Step 9: Billing e2e project

- Legacy `e2e/plan.billing.spec.ts` (2 titles, byte for byte) as its own Playwright project (`*.billing.spec.ts`, headed), excluded from the default projects, run by `vp run test:e2e:billing`. It drives the e2e store's real pricing page and restores the starting plan. Do not run it in a loop; run it once by hand if a headed browser is available, else record it as owed.
- Verify: `vp check` green; the default `vp run test:e2e` does not pick it up.

### Step 10: Staging and docs

- `docs/billing-runbook.md` from legacy `README.md` §Billing: the plans table and top features verbatim, where to create plans, the token, the per-app constants, subscribing a store, switching by hand, reading the App Events log, enabling an environment. `docs/shopify-stores-runbook.md` "Set up a checkout's stores" gains the plan step.
- Staging code path: Baton Staging's constants and `SHOPIFY_PARTNER_API_TOKEN` in `StageConfigValues` and `stacks/stage-config.ts` (stage config runbook, "Add a value"). **Do not push.** Write under §7 "Human steps requested" the staging steps for the orchestrator to relay (research Q15): Baton Staging made public (unlisted); legacy's two plans and meters on it; its Partner app id and handle; the token in `.env.staging`; `vp run stage-config --stage staging`; a plan picked on `mw10013-staging-shop-00`.
- `docs/legacy-port-research.md` §1.1 (billing tables read and written; the gate); `docs/glossary.md` (billing words, symbol column).
- `CHECKPOINT: ready for staging (<commit>)` under §7 "Command results". The orchestrator pushes after the staging steps are done (no table changed, no reset).
- Verify: `vp check` green.

## 5. Verification checklist

- `vp check`, `vp test`, `vp run test:e2e` green at the end; counts and times in §7.
- `MerchantRpcs` gained exactly `MerchantGetUsage`; `ShopActorShape` gained `getUsage`, `setBillingCycle`, `flushUsageEvents` and `revoke`'s `"all"`; `DevRpcs` unchanged.
- No `transaction(…)` nested; no `ShopifyAppEvents`, `flushUsageEvents`, D1 or Partner call inside one (read `usage-repository.ts`, `billing.ts`, `run-repository.ts`, `orders.ts`, `runs.ts`).
- `countOrder` and `flushUsage` are real in the actor; F's call-site tests still pass.
- Every place that resolves a plan maps a failure to an error or `503`, never to `Unsubscribed` (read `SubscriptionPlan`, `authenticateAdmin`, `ShopAccess`, `homePlan`).
- No plan, handle or entitlement in route context or a server function input; `managePlanUrl` is the only plan-derived value the `/app` context carries.
- Every legacy title §4 names is present byte for byte (`grep -rlF` each); every title dropped or moved is listed in §7 with its reason.
- No uppercase SQL keyword in `usage-repository.ts` or the `ShopSessionRepository` additions.
- No secret in a log line, an error message or a committed file (`grep -rn "PARTNER_API_TOKEN\|access_token" src test` and read each hit).
- The production bundle (`.alchemy/bundles/Backend/`, today's entries) contains no `IntegRpcs`, `PartnerFake` or `AppEventsFake` string.

## 6. Done when

- §1 holds on the dev stage; every step is green and committed; §7 is filled in; the `CHECKPOINT` lines are written; the staging human steps are listed.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict. Command results go under their own heading with counts and times.

### Plan review

**2026-10-18, lead, before implementation.** Checked against HEAD f556bb2, `refs/baton-legacy/` and `refs/alchemy` (installed `alchemy@2.0.0-beta.81`, identical). The steps stand; each is built to the corrected detail below.

**Step 0**

- `activeSubscription(appId, shopId)` is on the Partner API at `2026-10` (shopify.dev, Partner `2026-10`, `queries/activeSubscription`): `items { handle }`, `currentBillingCycle { startTime endTime }` (null in a trial), `trialEndsAt`. Legacy's query is unchanged. The spike only has to confirm it answers for Baton Dev.
- Legacy pinned `PARTNER_API_VERSION = "2026-07"` as a private constant. It read the App Events version, org id, app id and handle from wrangler vars (`2798461`, `417214922753`, `baton-local`, App Events `2026-07`). Exporting `APP_EVENTS_API_VERSION` as a code constant is new: a deviation the research approved (Q7).
- The stores runbook lists the `mw10013-*` stores under the Dev Dashboard organization `130059740`, and legacy's Partner org is `2798461`. Human step 2 asks whether these are one organization. If they are not, `activeSubscription` answers null or an error, and Step 0's `WAITING: Partner API` applies.

**Step 1**

- `src/domain/billing.ts` and `test/unit/domain/billing.test.ts` already exist (`membersAtCeiling` and its title). Step 1 extends both files rather than creating them.
- Legacy's `ENTITLEMENTS` is **not exported** (`const … satisfies Record<Plan, Entitlements>`); keep it module-private. Every other symbol in §3 matches legacy's exports.
- `openOrdersAtCeiling` stays in `src/backend/shop-actor/order-repository.ts`. `ShopUsage`'s two `{@link openOrdersAtCeiling}` therefore name it in backticks, because the domain may not import from the backend.
- Domain titles:
  - Legacy's third title is "the shop is at **its** order ceiling when the open orders have reached maxOpenOrders". The research has "the order ceiling" and calls it existing. It is not here; port it with legacy's text, against `openOrdersAtCeiling`'s home or as a plain domain test.
  - Legacy has no tests for `provisionalCycleStart`, `usageEventIsExpired`, `planOfHandle` or `adminShopPlanCache`. Those titles are new.

**Step 2**

- `makeUsageRepository` also needs the following privates and SQL:
  - legacy's `ShopUsageCycle` schema and `decodeCycle`;
  - `readUsage`;
  - `getUsage`'s open-orders count, with legacy's literal `fulfillmentStatus <> 'FULFILLED' and cancelledAt is null`.
- `markOrdersLimited`, `clearOrdersLimited` and `lastSweepAt` stay on the order repository (research Q2). Legacy's `markSeedOrdersCounted` is not needed, because the fixture writes `countedAt: 0` (`src/backend/fixture.ts`).
- `flushUsageEvents(shop)` takes the shop, as legacy's does. `sweepBatch` is `ShopLimits.sweepBatch` (200, `src/domain/platform.ts`).
- "OrderRepository usage" has 18 titles. **Two** are already ported in `test/unit/backend/shop-actor/order-repository.test.ts`: the ceiling title and "reports whether the upsert created the row". Port the other 16 into that `describe`.
- "RunRepository metering" has 5 titles, as the research says. It sits beside the existing "RunRepository countOrder" describe (4 titles), which used the recording stub.
- `ShopifyAppEvents` facts from legacy:
  - token endpoint `https://api.shopify.com/auth/access_token`, client credentials;
  - events endpoint `https://api.shopify.com/app/<version>/events`;
  - `User-Agent: Baton/<handle>`;
  - service method `send(event)`.
  - It needs the app handle, so the handle is a per-app constant the Backend binds (Step 4's configuration); in Step 2, pass the handle in through the layer.

**Step 3**

- **The fixture contradicts the step.** `ShopActor.loadFixture` today runs `DELETE FROM UsageEvent`, `DELETE FROM ShopUsage` and `INSERT INTO ShopUsage (id) VALUES (1)` (`src/backend/shop-actor.ts`, `loadFixture`). That wipes the cycle and the `shopGid`, so a dev or e2e shop's outbox waits up to 24 h for the next revalidation.
  - Build to legacy instead: `LoadFixture` leaves `ShopUsage` and `UsageEvent` untouched, and fix its JSDoc.
  - Lowercase the SQL lines touched.
  - Port "reseeding leaves the usage counter unchanged". It is from legacy `shop-agent-workflows.test.ts`, a file the plan does not name; put it in integ, or in unit over the actor's fixture path.
- **`ShopActors.revoke` is positional**: `(key, by: "member" | "session", id)`, and `ShopActorShape.revoke({ by, id })` (`src/backend/shop-actor/tag.ts`).
  - Change both to take `{ by: "member" | "session"; id } | { by: "all" }`. `"all"` closes every socket (merchant and members) with `3401`, using the reason "app subscription lapsed" (legacy).
  - `ShopActors.layerTest` grows the three new methods and records `"all"`.
- **F's flush sites are four plus one.** `runs.ts` has `reconcileAll` and Attach; `orders.ts` has the webhook and Sync from Shopify. The fifth is `ShopActor.onOrdersStream`'s `Effect.ensuring(flushUsage)` in `shop-actor.ts`, which no unit test pins.
- `databaseSize` is exposed: Alchemy's `DurableObjectStorage` has `sql.databaseSize`, and the actor already holds `state.raw.storage`.
- `ShopifyAppEvents` is yielded in `makeShopActor`'s outer phase beside `ShopifyAdmin` and provided in `provideBackend`'s `Layer.mergeAll`. Its `HttpClient` is satisfied at its own layer, because the actor provides `FetchHttpClient` only inside.
- **Uninstall.** `Webhooks.appUninstalled` runs `shopSessions.remove`, then `actors.destroy`. The flush goes **first**, before `remove`. Its JSDoc already promises this.
- Uninstall log lines are legacy's:
  - `webhooks.app.uninstalled: shop=… pending=…: usage events unsent at uninstall` (Warn, only when more than 0);
  - `webhooks.app.uninstalled: shop=…: usage event flush failed`.
- **The test Backend cannot swap services today.** `ShopifyFake` patches the Shopify library's module-global `fetch`, and `provideBackend` builds the real layers. Change `provideBackend` to take the `ShopifyPartner | ShopifyAppEvents` layer as an argument:
  - `makeBackend` passes the real ones;
  - `TestBackend` passes `PartnerFake` and `AppEventsFake` from `test/integ/`;
  - the bundle check (§5) then holds by construction.
  - `IntegRpcs`' handler context (`test/integ/backend.ts`, `Effect.context<…>`) grows the two fakes.
- The `makeBilling` notify on `ORDERS_KEY` is research Q11, **not legacy**: legacy's `setBillingCycle` writes, then flushes. Record it as a deviation from legacy, by design.
- Shop-agent-usage-flush has 6 titles. Two of them ("attaching a workflow sends the usage event it queued", "a cycle push sends the seat event it queued") are also research §4 row 2's integ titles. Port each title **once**, in unit over the services, and give the integ end-to-end tests their own new titles. A title duplicated across layers fails §5's byte-for-byte count.

**Step 4**

- Cron:
  - `Cloudflare.Workers.cron(expr, handler)` exists (`CronEventSource.ts`). It needs `Cloudflare.Workers.CronEventSourceLive` provided, which nothing provides today.
  - It **swallows the handler's failures** (`catchCause(() => Effect.void)`), so `revalidateStalePlans`'s caller logs its own failures (legacy's `scheduled.revalidatePlans: <cause>` at Error).
  - Declare it in `backendBody`. `TestBackend` then carries it too.
  - The local runtime supports crons and fires them on timers. `/cdn-cgi/handler/scheduled?cron=…` fires one by hand.
- `SubscriptionPlan` exports in legacy: `SubscriptionPlanError`, `SubscriptionPlan`, `revalidateStalePlans`, `resolveEntitlements`, `entitlementsOfStatus`. The constants, `planHandleExpiresAt` and `cachedStatus` are **private** there. Export them only if a test needs them; that is the implementer's call, recorded.
  - **`resolveEntitlements` is missing from §3**: it is what legacy's `/app` loaders used. Port it, for `homePlan` and the orders index's `usage`.
- `matchPlanHandle` is private in legacy and has **no legacy test**, so "zero and two matches" are new titles. Test them through `activeSubscription` with a fake `HttpClient`, or export it, and record which.
- `MembershipRepository.countMembers` exists only as a private closure. Expose it on the service, and change `membership-repository.test.ts`'s note that it is "not ported".
- `ShopSessionRepository`:
  - `layerTest` (an in-memory map) grows the three methods too;
  - `shop-session-repository.test.ts` uses only `layerTest`, so the two plan-column titles run over `makeD1Test` plus `layerWith` (`test/unit/backend/layers.ts`), which exercises the real SQL.
  - Legacy's title "updateShopSessionPlan rewrites only the plan cache fields" names legacy's method. Keep it byte for byte (§0: titles unchanged), and record the stale name.
- `ShopAccess` exposes only `resolve` and `resolveMember`; `merchant` and `member` are private.
  - The merchant branch: decode (401), host (403), then `shopExists` (404, its own D1 query), then the plan (402 or 503).
  - `unavailable` maps only defects to 503, so a typed `SubscriptionPlanError` needs its own mapping to 503. Log it as legacy does (`…: plan resolution failed`).
- **Three exhaustive matches** on `ShopAccessDenied.status` grow a `402` arm:
  - `refusalClose` in `src/backend/backend.ts`: 402 → `4402`. The plan says "the upgrade route", which lives here.
  - `BackendApi.shopAccess` (the merchant and member layouts' loader gate) in `src/backend/api.ts`: a new tagged error, e.g. `PaymentRequired`, which the member layout turns into the redirect to `/shop/$key/lapsed`. The merchant layout never sees it, because `/app`'s `beforeLoad` redirects first, but it must still compile.
  - `BackendApi.memberOf` in `src/backend/api.ts`: likewise.
- `authenticateAdmin` today answers `AdminSession { shop, shopGid }` (`src/contract/shop.ts`) through the `shopifyAdmin` middleware in `src/web/server/shopify.ts`. That middleware is the Website-side reader of the new union; `authenticateApp` is its only user.
- `ExitIframeDestination` (`src/web/server/shopify-urls.ts`) already admits the pricing URL.
- `src/web/server/home.ts` **exists** (it holds `setupFacts`). Add `homePlan` there.
- The orders index and the home page share `listOrders` (`BackendApi.listOrders`). Put the orders index's `usage` on a separate read (`BackendApi.usage` with a server function, `ApiUsage`) rather than growing `listOrders`, so the home page does not read usage twice.
- Configuration:
  - `SHOPIFY_DEV_STORE` is not read through `Config`. Only `app:dev` sources `.env`; the e2e server runs with `--env-file=.env`.
  - Read the token through Alchemy `Config` at stack time in `wireBackend` (Alchemy loads `.env`) and bind it as a Worker secret, as `StageConfigValues` binds `SHOPIFY_API_SECRET`.
  - Confirm the value reaches the Backend under both `vp run dev` and the e2e server, and record how.
- Step 4's verify line: the count is 971 (75 files) at HEAD, recorded in slice F.

**Step 5**

- `ShopSocket` holds no close handling. Close outcomes are mapped in `src/web/client/shop-actor-client.ts` (`retryPolicy` → `applyCloseOutcome`), which cannot reach a router. Thread an `onPaymentRequired` callback (or the router) from the layouts into the client layer, so that `4402` calls `router.invalidate()`. Add `4402` to `TERMINAL_CODES` with its own `CloseOutcome`.
- Legacy's `3401` also invalidated the router (`onSocketClose`). Here `3401` keeps today's reconnect, and the reconnect meets `4402`; that is enough.
- "the tab reconnects on 3401 and not on 4403" is **not** in this repo; it lives only in a JSDoc table (`src/domain/platform.ts`). Its coverage is the unit tables in `test/unit/web/client/actor-connection.test.ts` ("retry policy", "close outcome"). Add `4402` rows there, and port the legacy title as a browser test in `test/browser/web/components/ShopSocket.test.tsx` beside a `4402` case.
- Legacy's `/app` context carried `plan` and `planHandle`. Carrying only `managePlanUrl` is this plan's deliberate change (§0 rule).

**Step 6**

- `MeterTile`'s `<progress className="capacity-meter">` needs legacy's `.capacity-meter` rules (legacy `src/styles.css`). Port them into `src/web/styles.css`.
- "their `Screen.ts` rows" means the JSDoc parts-table row each part carries (as `Strip.tsx` does), taken from legacy `src/lib/Screen.ts`. This repo has no `Screen.ts`.
- Copy details:
  - the Members headline is singular at one ("1 member, 3 included");
  - the orders detail is "`K` over. Extra orders are billed at your plan's rate. Resets `<date>`." (one string with a trailing space before "Resets").
- Spacing comes from `screen/layout.ts`. `Tiles` uses `repeat(auto-fit, minmax(300px, 1fr))`.
- The members e2e title does **not** read the meter's `max`. Legacy seeds `MAX_ENTITLEMENTS.membersIncluded + 1` members (past every plan) and expects /Extra members are billed at your plan's rate/. Port it as legacy wrote it; only `plan.billing.spec.ts` reads `max`.

**Step 8**

- Legacy's lapsed page links with a TanStack `<Link to="/shop">Your stores</Link>` and uses a curly ’ in "store’s".
- Integ titles, both present in legacy `member-area.test.ts`:
  - "requireMember admits every member of a subscribed shop";
  - "redirects a member of a lapsed shop to the lapsed page".

**Step 9**

- Playwright runs every project by default.
  - A `*.billing.spec.ts` under `embedded/` matches `embedded`, and one elsewhere matches `chromium`. Add a `testIgnore` for `**/*.billing.spec.ts` to both.
  - Define the `billing` project only when the script asks for it (an env flag set by `test:e2e:billing`), so that plain `vp run test:e2e` cannot pick it up.
- Legacy's titles say "Plan card", legacy's own stale word. Keep them byte for byte.

**Cross-cutting**

- `shop-actor.ts`'s `loadFixture` has uppercase SQL (`INSERT INTO ShopOrder`, the `DELETE FROM`s). Lowercase it only where Step 3 edits it; otherwise leave it.
- In legacy, "the daily check re-reads every shop whose cached plan is stale, and only those" is one of `subscription-plan.test.ts`'s 21 titles. Port it there, in unit. The integ test through `RevalidateStalePlans` gets its own new title.

**Orchestrator revision 1 (2026-10-18, from the user, before Step 4).** Research Q7 is revised (`docs/billing-research.md` §0 Q7, 15df007). It wins over §3's Configuration row, and Step 4 and Step 10 are built to it:

- **Config, not code, for every value a Shopify app issues per stage:** the app's key and secret, `SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_APP_ID`, `SHOPIFY_APP_HANDLE`.
- **Where each stage reads them:**
  - Dev and e2e read the four Partner values from the checkout's `.env` through `Config`; the user has already added them to `.env` and `.env.staging`, so check them by name only. The app's key and secret in dev and e2e keep coming from the Shopify CLI (`shopifyCliApp`), as today.
  - Staging reads them from the stage config record. Add the four as `StageConfigValues` fields (the token `Redacted`, the rest plain), read them in `stacks/stage-config.ts`, and bind them in the app stack.
  - Declare each value once, in a typed schema. Decode `SHOPIFY_APP_HANDLE` and the ids with Schema.
- **Code holds only what Baton defines:** plan handles, meter handles, entitlements, the two API versions.
- `CLOUDFLARE_WORKERS_API_TOKEN` is in both `.env` files for a future admin explorer. Leave it there; bind nothing and read nothing.
- **State the rule once,** as JSDoc on `StageConfigValues`: values another service issues come through config; values Baton defines live in code. Also add a line to `docs/stage-config-runbook.md` "How it works".
- **Staging stays the orchestrator's** (Step 10's human steps): do not run `vp run stage-config --stage staging`, and do not push.

### Deviations

- **2026-10-18, Step 1:** the domain's JSDoc says "the Backend" for legacy's Worker and "the actor" for its Durable Object; the two tooling sentences (`scripts/rules-lint.ts`, `pnpm spec check`) and the `scripts/lib/cost.ts` and `README.md` paths are dropped (the cost sentence and "the operator's plans table" kept without a path). `PlanStatus`'s proration URL moved to `@see`. "the shop is at its order ceiling…" sits in `order-repository.test.ts` (`describe("openOrdersAtCeiling")`), beside the function.

- **2026-10-18, Step 2:** `makeUsageRepository.setBillingCycle` answers a boolean (the count or the cycle changed) for `makeBilling`'s notify (research Q11); legacy's answered void.
- **2026-10-18, Step 2:** `ShopifyAppEvents.send` reads a non-2xx answer's body into the error (`App Events request refused: status=403: {…not_installed…}`) instead of legacy's `filterStatusOk` (whose error carried no reason). It is research Q6's "now carrying Shopify's reason"; the 401 retry keys on the status the same way. "carries the refusal reason into the error a caller records" also asserts the events endpoint's refusal.
- **2026-10-18, Step 2:** `ShopifyAppEvents.layerWith({ apiKey, apiSecret, appHandle })` takes the handle (the plan's "pass the handle through the layer"); `ShopifyAppEvents.layer` reads `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_HANDLE` with `Shopify.layer`'s "absent while planning" rule. Nothing binds `SHOPIFY_APP_HANDLE` before Step 4.
- **2026-10-18, Step 2:** this repo's `upsertOrder` does not resolve the cycle (legacy's did); `countOrder` resolves it itself, so the meter's rules hold. "rolls the cycle forward on the first order past its end" keeps its title; its comment says the count resolves the cycle. `order-repository.test.ts`'s `CYCLE_START` is now legacy's `Date.UTC(2026, 5, 15)` (was day 400 since the epoch); every case in the file passes on it.

- **2026-10-18, Step 3:** configuration landed here, not in Step 4: `ShopifyAppEvents.layer` needs `SHOPIFY_APP_HANDLE` in the Backend, or dev would die at the first activation. Built to Orchestrator revision 1: `ShopifyPartnerConfig` (`src/backend/shopify-partner.ts`) is the one typed schema of the four values (`AppHandle`, `PartnerId`, the token `Redacted`); `wireBackend` binds them as the `ShopifyPartner` binding from `shopifyPartnerBinding` (dev and e2e: `Config.schema(ShopifyPartnerConfig)` from `.env`, the fakes when absent; test: `SHOPIFY_PARTNER_CONFIG_FAKE`; staging: the stage config record). `StageConfigValues` gained the four fields now and `stacks/stage-config.ts` reads them (`satisfies` would not compile otherwise); the rule is JSDoc on `StageConfigValues`. Step 10 keeps the runbook line and the human steps. Nothing was run against staging.
- **2026-10-18, Step 3:** `provideBackend(effect, billing)` takes the billing clients as a layer, typed `Layer<ShopifyBilling | B>` so the test Backend's `AppEventsFake.layer` (which also provides `AppEventsFake`) reaches its `IntegHandlers`; Step 4 widens `ShopifyBilling` with `ShopifyPartner`.
- **2026-10-18, Step 3:** `AppEventsFake` accepts every event; it has no scriptable refusal (no `IntegRpcs` row asks for one; refusals are pinned in unit over `makeUsageRepository`).
- **2026-10-18, Step 3:** `loadFixture` keeps the meter (`ShopUsage`'s cycle, counts, `shopGid`, seats; the `UsageEvent` outbox) as legacy did, but clears the orders' two `ShopUsage` columns, `ordersLimitedAt` and `lastSweepAt`: they describe the orders the load deletes, and "a webhook whose sweep deletes an order publishes…" relies on a load leaving `lastSweepAt` null. Its SQL is lowercased.
- **2026-10-18, Step 3:** `databaseSize` is `state.raw.storage.sql.databaseSize` (`Effect.sync`), read at each `getUsage`.
- **2026-10-18, Step 3:** `makeBilling` is an `Effect.fnUntraced` yielding `ShopifyAppEvents` (the plan's input list plus the service from context), so `flushUsageEvents` needs nothing; its `notify` is the runs service's through a deferred closure, because `makeRuns` needs `flushUsage` first.
- **2026-10-18, Step 3:** legacy `shop-agent-usage-flush.test.ts` ported as `test/unit/backend/shop-actor/billing.test.ts`, describe "Billing usage flush" (renamed by role, nothing is called an agent; the six titles unchanged). "syncing one order…" fails the fetch with `ReauthorizationRequired` (legacy: no offline session).
- **2026-10-18, Step 3:** the integ end-to-end titles (an attach and a cycle push reaching the App Events fake, uninstall flushes first, "revokes every connection on the shop for a lapse") move to Step 4: each needs a pushed cycle or a plan change, and only Step 4's `ScriptPartner` and `RevalidateStalePlans` can make one. "reseeding leaves the usage counter unchanged" and "MerchantGetUsage is refused to a member" are in integ now.

- **2026-10-18, Step 4:** `ShopSessionRepository`'s three plan methods die on a D1 or decode failure, as the repository's other methods do; `SubscriptionPlan` turns those defects into `SubscriptionPlanError` (`catchDefect`), so "we could not ask" still never reads as `Unsubscribed`. `layerTest` grew the three methods.
- **2026-10-18, Step 4:** `planHandleExpiresAt`, `cachedStatus` and the three constants are exported (legacy kept them private); only the tests and the JSDoc links use them. `matchPlanHandle` stays private and is tested through `activeSubscription` with a fake `HttpClient` (`test/unit/backend/shopify-partner.test.ts`, new titles, including the measured trial answer).
- **2026-10-18, Step 4:** `entitlementsOfStatus` fails `PlanUnsubscribed { href }` (`src/contract/billing.ts`) where legacy threw TanStack's `redirect`; `BackendApi.homePlan` turns it into `HomePlan`'s `Unsubscribed`. `PaymentRequired` is the `402` answer of `BackendApi.shopAccess` and `memberOf`. `ShopActors.revoke` is `(key, RevokeInput)`.
- **2026-10-18, Step 4:** `/app`'s `beforeLoad` and `authenticateApp` (Step 5's first bullet) landed here, since `authenticateAdmin`'s new answer had to compile: `billingRedirect: location.searchStr.includes("plan_handle")`, `redirect({ href })` on `Unsubscribed`, route context `{ shop, apiKey, managePlanUrl }`.
- **2026-10-18, Step 4:** `seed/test.sql`'s two shops are cached on `baton-pro` (were `basic`, a handle outside the allowlist, which would read as a miss and revalidate, revoking every socket on the first gate). Seed data only; no table change.
- **2026-10-18, Step 4:** `ScriptPartner` also makes the shop's cached plan stale (`planHandleExpiresAt` 0, handle kept), so the next gate, home read or `RevalidateStalePlans` re-reads it the way a real expiry would. `AppEventsSent` takes an optional `refuse`, the fake's scriptable refusal (the uninstall case needs a queued event at uninstall). `ApiWorkflowsList` and `ApiMemberWorkflowPage` errors grew `PaymentRequired`.
- **2026-10-18, Step 4:** the cron handler logs its own failure, `scheduled.revalidatePlans` at Error with the cause, since the event source swallows it.

- **2026-10-18, Step 5:** the `4402` rerun is an atom, not a callback threaded into the client layer: `applyCloseOutcome` maps `payment-required` to `forbidden` and bumps `paymentRequiredAtom`, and `ShopSocket`'s holder (both layouts) calls `router.invalidate()` on each bump, as the member layout already does for `membershipChangedAtom`. "the tab reconnects on 3401 and not on 4403" is a browser test in `ShopSocket.test.tsx`, beside the `4402` case.
- **2026-10-18, Step 5:** the e2e plan check is in `install.setup.ts`: a load that does not hydrate while the page sits on `/pricing_plans` fails with "pick a plan on <store> (docs/shopify-stores-runbook.md)" (measured: it does, on the store with no subscription for the configured app id).

- **2026-10-18, Step 6:** `MeterTile` takes `onClick` beside `href` (the router navigation outside the admin, as `Strip`'s link cells). `QuotaBanners` takes `Pick<ShopUsage, "ordersLimitedAt">`. Both pages read usage live through `useLiveRead` on `merchantUsageAtom` (seeded by `seedUsage`); the orders index's loader answers `{ data, usage }` and `OrdersIndexPage` grew a `usage` prop (browser tests pass `NO_USAGE`, `test/browser/usage.ts`). The home loader throws `redirect({ href })` when `homePlan` answers `Unsubscribed`. **Your plan** sits after the Orders strip and before the existing shop links section. Browser test titles are new (legacy had none for these parts); the two e2e titles are legacy's.

### Issues

- **2026-10-18, Step 0: `activeSubscription` answers null for both stores. `WAITING: Partner API`.** Spike (a scratch script outside the repo, deleted after; the token and the app secret read into the environment, never printed) for Baton Dev (org `2798461`, app `417214922753`, handle `baton-local`):
  - `activeSubscription` for `mw10013-dev-shop-00` (`gid://shopify/Shop/85265907941`) and `mw10013-e2e-shop-00` (`gid://shopify/Shop/77133480030`, both GIDs from the local dev D1 `ShopSession`): `200 {"data":{"activeSubscription":null}}` at `2026-10` and at `2026-07`, for both stores. No error, so the query exists at `2026-10` and the token is accepted.
  - The ids are right: `app(id: "gid://partners/App/417214922753")` answers `{ name: "Baton Dev", apiKey: "7c6cceb7…" }`, the `client_id` in `shopify.app.toml`. (The Partner API's own app GID is `gid://partners/App/…`; `activeSubscription(appId:)` takes `gid://shopify/App/…`, legacy's form, and did not complain.)
  - The stores are in that organization: Baton Dev's Partner `app.events` lists `RELATIONSHIP_INSTALLED` for `mw10013-dev-shop-00` (2026-10-15T21:45Z) and `mw10013-e2e-shop-00` (2026-10-15T22:26Z), and dev/e2e shops 01–03. It lists **no `SUBSCRIPTION_CHARGE_ACTIVATED` for any `mw10013-*` store**; the last activations are `sandbox-shop-01`'s (2026-10-08). So the cause is human step 3 not done (no plan picked on either store), not a second organization.
  - Stopped before Step 1, as the step says.

- **2026-10-18, Step 0, re-check after the plans were picked.**
  - `.env`'s `SHOPIFY_PARTNER_APP_ID` is **Baton Staging's** app id (the same value as `.env.staging`; `app(id:)` answers "Baton Staging", apiKey `54b4c701…`). For that id `activeSubscription` answers null for both stores and its `app.events` is empty. `SHOPIFY_PARTNER_ORG_ID` is `2798461`; `SHOPIFY_APP_HANDLE` is `baton-local`. See "Human steps requested".
  - With Baton Dev's id (`417214922753`) both stores answer `{"items":[{"handle":"baton-basic"},{"handle":"production-orders"},{"handle":"members"}],"currentBillingCycle":null,"trialEndsAt":"2026-10-20T00:21:02Z"}` (dev-shop-00; e2e-shop-00 `…00:21:52Z`). Activated 2026-10-19T00:21Z (UTC). The shops sit in a trial, so there is no cycle: `revalidate` pushes no `setBillingCycle`, and the flush waits (legacy's rule, no change). The meters are separate `items`, so `matchPlanHandle`'s matching (not position) is needed.
  - GID forms settled: `activeSubscription(appId:)` takes `gid://shopify/App/<id>` (legacy's form); `gid://partners/App/<id>` there answers `INVALID_GID … Use 'shopify' instead`. The Partner API's own `app(id:)` takes only `gid://partners/App/<id>`. Code keeps legacy's form.

- **2026-10-18, Step 4: Alchemy hands a digits-only bound value back to the Worker as a number.** Under `alchemy dev`, the Backend's init died on `SHOPIFY_PARTNER_ORG_ID`: the env-backed `ConfigProvider` node was `{ _tag: "Value", value: 2798461 }` (a number), which every `Config` scalar (`String`, `Number`, a `Config.schema` union) refuses as "Expected string"; the state file stores the binding as the string `"2798461"`. Also: `Config.schema` of the whole `ShopifyPartnerConfig` struct finds nothing among a Worker's bindings (no object at the root). Worked around in `shopifyPartnerBinding` (the ids read off the provider node, a number decoded back to its digits), recorded in its JSDoc. Not patched: the cause sits between `packEnvValue` and the local runtime's env, and the workaround is one function. Worth an upstream issue; staging (real Cloudflare `plain_text`) is unverified.
- **2026-10-18, Step 4:** the dev server's first cron fire revalidated `mw10013-dev-shop-00` with `.env`'s app id, which is Baton Staging's (see Human steps): the Partner API answered null, so the dev shop's plan is cached as a verified absence for 24 h. After `.env` is fixed, the first `/app` load through Shopify's billing redirect (`plan_handle`), a Manage plan press, or a dev `db:reset` re-reads it.

- **2026-10-18, Step 5, staging check owed for the digits-only binding workaround.** Cause, as measured: under `alchemy dev` the `ShopifyPartner` binding's `SHOPIFY_PARTNER_ORG_ID` (`"2798461"` in state) reached the Worker's env-backed `ConfigProvider` as `{ _tag: "Value", value: 2798461 }`, a number, which `Config.String` and every `Config` scalar refuse. Workaround: `shopifyPartnerBinding` (`src/backend/shopify-partner.ts`) reads the two ids off the provider node and decodes a number back to its digits. On staging (Cloudflare `plain_text` / `secret_text` from the stage config record), check after the push: the Backend answers requests (not a 500 from its init), the first `/app` load resolves the plan (`SubscriptionPlan.revalidate: shop=mw10013-staging-shop-00 handle=…` in the Backend's logs), and a manual cron run logs `scheduled.revalidatePlans: shops=… failed=0`. If staging hands the ids back as strings, the workaround is harmless; if it fails differently, the Backend's init dies with `the ShopifyPartner binding is not bound` or a decode error.

### Command results

- **2026-10-18, Step 0, App Events at `2026-10`** (measured, for Step 2's JSDoc):
  - Token mint (`POST https://api.shopify.com/auth/access_token`, client credentials, `User-Agent: Baton/baton-local`): `200`, body keys `access_token,token_type` (no `expires_in`, no `scope`: legacy's 2026-09-19 measurement still holds).
  - A custom event `baton_spike` (value 1) for `mw10013-e2e-shop-00`: `202 {"success":true}`.
  - The same for an unknown shop (`gid://shopify/Shop/1`): `403 {"success":false,"error":"Forbidden","errors":[{"field":"shop_id","code":"not_installed","message":"app is not installed on this shop"}]}`. So a refusal is **not** `202`: legacy's "answers `202` to an event it will later refuse" is wrong for a shop without the app. Whether an unknown handle or an out-of-cycle timestamp on an installed shop is `202` is still unmeasured (`baton_spike` matches no meter and answered `202`).
  - A bad bearer: `401 {"error":"Unauthorized","message":"Invalid token signature: …"}`.
  - Versions chosen: Partner API `2026-10`, App Events `2026-10`.
- **2026-10-18, Step 0:** `WAITING: Partner API` (no commit for the spike; this §7 record committed alone). `CHECKPOINT: spike answered` is owed after a plan is picked on both stores and `activeSubscription` re-checked.

- **2026-10-18, Step 0:** `CHECKPOINT: spike answered (no commit; recorded in §7)`. Partner API `2026-10` and App Events `2026-10`.

- **2026-10-18, Step 1:** `vp check` green (342 files); `vp test` 981 passed, 75 files, 67 s (971 + 10: seat value, order ceiling, provisional cycle, expiry, `planOfHandle`, five `adminShopPlanCache` states).

- **2026-10-18, Step 2:** `vp check` green (345 files); `vp test` 1007 passed, 76 files, 50 s (+16 "OrderRepository usage", +5 "RunRepository metering", +5 "ShopifyAppEvents").

- **2026-10-18, Step 3:** `vp check` green (350 files); `vp test` 1015 passed, 78 files, 50 s (+6 "Billing usage flush" unit, +2 integ in the new `test/integ/billing.test.ts`). First run: 1 failure, "a webhook whose sweep deletes an order publishes…" (see Deviations, `loadFixture`); fixed, then green.

- **2026-10-18, Step 4:** `vp check` green (355 files); `vp test` 1058 passed, 80 files, 52 s (+21 "SubscriptionPlan", +2 plan-cache titles, +8 `ShopifyPartner`, +3 `authenticateAdmin`, +2 `402` rows, +7 integ in `billing.test.ts`; the existing 971 unchanged).
- **2026-10-18, Step 4, cron:** the stack plans `[Backend/Cron(17 4 * * *)] create` under `alchemy dev` (and the integ stages deploy with it, `TestBackend` carrying `backendBody`). Fired by hand on the dev server: `GET <backend>/cdn-cgi/handler/scheduled?cron=17%204%20*%20*%20*&format=json` → `{"outcome":"ok"}`, log `scheduled.revalidatePlans: shops=1 failed=0`. (`+` for spaces is not decoded: use `%20`.)
- **2026-10-18, Step 4:** `CHECKPOINT: Backend half (4ad7a2c)`.

- **2026-10-18, Step 5:** `vp check` green (355 files); `vp test` 1064 passed, 80 files, 56 s (+4 close-code unit rows and a `payment-required` case, +2 browser in `ShopSocket.test.tsx`). `vp run test:e2e -- --project install`: 1 failed, 1 passed (`shopify-admin`), 68 did not run, 50 s: `Error: pick a plan on mw10013-e2e-shop-00 (docs/shopify-stores-runbook.md)`. The gate is right: `.env`'s `SHOPIFY_PARTNER_APP_ID` is Baton Staging's, for which the e2e store has no app subscription, so `/app` went to the pricing page (behind Cloudflare's challenge). Step 5 cannot end green on e2e until `.env` is fixed. `WAITING: .env app id` (see Human steps).

- **2026-10-18, Step 5, after `.env` was fixed:** `vp run test:e2e -- --project install` ran the whole suite (the flag did not narrow it): 70 passed, 5.3 min. Every embedded spec passes on the subscribed e2e store (Baton Basic, in a trial).

- **2026-10-18, Step 6:** `vp check` green (360 files); `vp test` 1067 passed, 81 files, 55 s (+3 browser: `MeterTile` ×2, `QuotaBanners`; the kit test counts the two meter tiles). First run: the kit test's `s-clickable[href]` count (7) failed on the new tiles; updated. `vp run test:e2e test/e2e/embedded/home.spec.ts test/e2e/embedded/members.spec.ts`: 9 passed (setup projects included), 1.3 min.

### Human steps requested

**2026-10-18, Step 0, still pending: step 3 below (a plan on each store).** `SHOPIFY_PARTNER_API_TOKEN` is in `.env` and works; steps 1 and 2 are answered by the spike (org `2798461`, app `417214922753` "Baton Dev", handle `baton-local`, the stores in that organization; the plans' existence is checked by the next spike, since `activeSubscription` cannot see a plan no store holds). Unblocks Step 0's re-check and Step 1 onward. For each of `mw10013-dev-shop-00` and `mw10013-e2e-shop-00`: signed in as the store owner, open `https://admin.shopify.com/store/<store>/charges/baton-local/pricing_plans`, choose `baton-pro` (or `baton-basic`), approve the $0 charge. If the page shows no plans, Baton Dev's plans are missing (step 2c): create `baton-basic` and `baton-pro` with the meters `production-orders` and `members` first. Reply with the plan picked on each store.

**2026-10-18, Step 0 (pending; unblocks the spike and every step after Step 3's unit work).** Check: `sed -E 's/=.*/=<hidden>/' .env` lists `SHOPIFY_PARTNER_API_TOKEN` (today it lists only `WEBSITE_PORT`, `SHOPIFY_DEV_STORE`, `SHOPIFY_E2E_STORE`).

1. **Partner API token.** Partner Dashboard → Settings → Partner API clients → Create API client, permission **Manage apps** (nothing else). Copy the token and add one line to the main checkout's `.env` (`/Users/mw/Documents/src/baton/.env`): `SHOPIFY_PARTNER_API_TOKEN=<token>`. Worktrees: `vp run worktree:init` _copies_ the main checkout's `.env` (rewriting `WEBSITE_PORT` and the store keys), so a worktree created afterwards gets it; an existing worktree (`wt-01`) needs the line added to its own `.env` by hand.
2. **Partner ids.** In the Partner Dashboard confirm (a) the organization id (the number in `partners.shopify.com/<org id>/…`; legacy `2798461`), (b) Baton Dev's app id (the number in `…/apps/<app id>`; legacy `417214922753`) and its handle (Apps → Baton Dev → App setup → URL handle, or the `handle` in `shopify.app.toml`; legacy `baton-local`), and (c) under Baton Dev → Pricing (App Pricing / managed pricing) that plans with handles `baton-basic` and `baton-pro` exist, each with the two usage meters `production-orders` and `members`. Reply with the three values and "plans ok" or what differs. Also confirm the `mw10013-*` stores are development stores of **that** organization: `docs/shopify-stores-runbook.md` records them under the Dev Dashboard organization `mw10013` (id `130059740`), which is not legacy's Partner id `2798461`; if they are two organizations, say so (Step 0 then stops at `WAITING: Partner API`).
3. **A plan on each store.** Signed in as the store owner, open `https://admin.shopify.com/store/mw10013-dev-shop-00/charges/<handle>/pricing_plans` and `https://admin.shopify.com/store/mw10013-e2e-shop-00/charges/<handle>/pricing_plans` (`<handle>` from 2), choose a plan on each (e.g. `baton-pro`), approve the $0 charge. Reply with the plan picked on each store.

**2026-10-18, Step 0, answered.** Step 3: the user picked Baton Basic (`baton-basic`) on both `mw10013-dev-shop-00` and `mw10013-e2e-shop-00` (lead). Confirmed by the re-check (trial until 2026-10-20).

**2026-10-18, Step 0, new (unblocks dev and e2e from Step 5 on; Steps 1–4 use fakes and go ahead).** In the main checkout's `.env` (`/Users/mw/Documents/src/baton/.env`), `SHOPIFY_PARTNER_APP_ID` holds Baton Staging's app id. Set it to Baton Dev's, `417214922753` (`partners.shopify.com/2798461/apps/417214922753`). `.env.staging` keeps Baton Staging's id. Also `.env.staging`'s `SHOPIFY_APP_HANDLE` is not `baton-local`: confirm it is Baton Staging's handle once Baton Staging has one (Step 10).

**2026-10-18, Step 5, blocking (unblocks Step 5's e2e and every step after).** `/Users/mw/Documents/src/baton/.env` still holds Baton Staging's app id in `SHOPIFY_PARTNER_APP_ID` (checked by equality only). With it the Partner API answers that neither `mw10013-*-shop-00` store has an app subscription, so the dev and e2e `/app` loads redirect to the pricing page (measured: the e2e `install` setup fails with "pick a plan on mw10013-e2e-shop-00"). Change that one line to Baton Dev's id, `SHOPIFY_PARTNER_APP_ID=417214922753`, and leave `.env.staging` as it is. Then: restart the dev server (`vp run dev:stop`, `vp run dev`) so the Backend is rebound; the dev store's plan is cached as "no subscription" until 2026-10-19 ~21:16 local, so either wait, open the app once from the plan selection page (its return carries `plan_handle`, which re-reads), or `vp run db:reset` the dev stage. The e2e stage is rebuilt on each run, so it needs nothing more.

**2026-10-18, Step 5, answered.** The lead set `.env`'s `SHOPIFY_PARTNER_APP_ID` to Baton Dev's `417214922753` (`.env.staging` untouched); verified by equality. The dev stage's cached "no subscription" for `mw10013-dev-shop-00` is left to expire on its own (about 2026-10-19 21:16 local) or to be cleared by the user reopening the app from the pricing page (`plan_handle` re-reads); no `db:reset` (dev is touched only by running the dev server).

### Implementation review

## 8. Out of scope

- Admin console (H): the shops list's plan columns, the shop page's Plan section, Refresh plan, `PlanCache` (the domain's `AdminShopPlanCache` ports here).
- Help (I): `plans-and-billing`, `limits`, "Learn more in Help.", `help-limits.test.ts`.
- Production's app and plans (roadmap Q18).
- A backfill of orders that got runs before this slice (research Q16).
- Legacy `rules-lint.test.ts`'s retired-word titles.
