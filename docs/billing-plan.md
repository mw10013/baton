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

### Deviations

### Issues

### Command results

### Human steps requested

### Implementation review

## 8. Out of scope

- Admin console (H): the shops list's plan columns, the shop page's Plan section, Refresh plan, `PlanCache` (the domain's `AdminShopPlanCache` ports here).
- Help (I): `plans-and-billing`, `limits`, "Learn more in Help.", `help-limits.test.ts`.
- Production's app and plans (roadmap Q18).
- A backfill of orders that got runs before this slice (research Q16).
- Legacy `rules-lint.test.ts`'s retired-word titles.
