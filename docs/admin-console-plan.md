# Plan: admin console

Implements `docs/admin-console-research.md` (slice H). Every question in its §5 was settled on 2026-10-19 (§0 there has the one-line forms; Q4 and Q13 were revised in review and accepted as revised). Read the research's §0.1, §1 and §5 first; this plan does not repeat their reasoning.

Legacy paths are relative to `refs/baton-legacy/`. Legacy is the spec for every screen: read the legacy route file before building its page, and port its copy, structure and JSDoc reasons, translated to the glossary's words (an **admin**, never an "operator"; an **actor**, never a "Shop Agent").

## 0. Rules for the implementer

- **AGENTS.md.**
  - Vite+ only; `vp check --fix` after every change.
  - Effect Schema for parsing (no hand trimming); `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`.
  - Layout only in `src/web/components/screen/` parts; links through `navigate` or a TanStack `<Link>`.
  - The JSDoc rules: never cite this plan, the research or any `docs/` file in code.
  - Logging: `<operation>: shop=<shop> key=<value>: <detail>`, fields in `Effect.annotateLogs`.
  - SQL: lowercase keywords, positional parameters.
- **Commits.** Work on `main`. Commit at the end of each green step. Stage paths explicitly; never `git add -A` or `git commit -a`. Do not push.
- **Each step ends green.**
  - `vp check --fix`, and `vp test <files>` for the tests the step touches.
  - e2e only where a step changes what a spec exercises, and then that spec alone (`vp run test:e2e -- <spec>`). Never the full e2e suite.
  - The full `vp test` once, in Step 6.
  - A step that cannot end green is recorded in §7 before moving on. Do not re-run a test through a failure you understand; record it.
- **What does not change.**
  - No table change: `migrations/0001_init.sql` and the actor's `0001_init` stay as they are. Never `db:reset` staging, `cloud:reset`, `deploy:staging`, or `vp run stage-config` (§7 Human steps).
  - `ShopActorRpcs` is unchanged; no procedure is added. `DevRpcs` and `IntegRpcs` do not grow.
  - The console is loader-only: no socket, no live read.
- **Never write a token to the browser.** A redacted read projects the tokens away in SQL; nothing on these pages reads `ShopSessionRepository.find`.
- Do not rewrite the steps. Record in §7 what you built differently, and what surprised you, as you go.

## 1. Outcome

- **One schema per concept** (research Q4): `ShopKey` and the `ShopSession` row schema live once, in `src/domain/platform.ts`; the Backend's `ShopSessionRow`, the domain's `Shop` and the legacy exports nothing uses are gone.
- **The admin console** (`/admin`, signed in as the admin):
  - The dashboard lists four consoles in legacy's section shape: Shops, Shop actors, Orphan shop actors, Members.
  - **Shops** (`/admin/shops`): every `ShopSession` row, tokens redacted, its cached plan, 25 a page both ways, a search by shop.
  - **Shop page** (`/admin/shop/$shop`): the Plan section (cached plan, usage, members, Refresh plan) and the Shopify session section; No session for a shop with no row, with no actor touched.
  - **Shop actors** (`/admin/shop-actors`) and **Orphan shop actors** (`/admin/orphan-shop-actors`): Cloudflare's inventory of the actor namespace on staging; an orphan (stored data, no `ShopSession` row) can be destroyed; a tombstone cannot. On a stage without the inventory token, an info banner.
- Every admin method on `BackendApi` checks the role itself; a member is sent to `/shop`, a signed-out visitor to sign-in and back.
- The billing spec's "a paid-to-paid downgrade applies at once, and the usage outbox drains" reads the outbox off the shop page again, as legacy's did.

## 2. What this plan rests on

- **The admin identity exists.** Better Auth `role = 'admin'`, seeded per environment (`seed/*.sql`); `/admin`'s `beforeLoad` is `requireRole("admin")` (`src/web/routes/-guards.ts`); `BackendApi.listMembers` already checks the role. e2e signs the admin in as `a@a.com` (`test/e2e/auth.setup.ts`, `playwright/.auth/admin.json`).
- **Billing left the pieces.** `ShopActors.getUsage` (answers `ShopUsage` with `databaseSize`, `openOrders`, `pendingUsageEvents`), `MembershipRepository.countMembers`, `SubscriptionPlan.refresh`, `adminShopPlanCache`, `adminShopEntitlements` (`src/domain/billing.ts`, unit-tested).
- **The duplicates** (research Q4's table): `ShopSessionRow` and its `ShopSessionUpsert` in `src/backend/shop-session-repository.ts` are live; the domain's `Shop`, `ShopSession`, `ShopSessionUpsert`, `ShopSessionRedacted`, `ShopSessionRedactedPage` are imported by nothing (only `adminShopPlanCache`'s parameter type names `ShopSessionRedacted`). `ShopKey` is in `src/contract/shop.ts`.
- **Alchemy's actor namespace** exposes only `getByName` at runtime (`refs/alchemy/packages/alchemy/src/Cloudflare/Workers/DurableObject.ts`: `idFromName`, `idFromString`, `get` are commented out), and every actor is created by `getByName(shopActorId)`, where `shopActorId` is the shop domain. The namespace object carries `namespaceId` as an `Output`.
- **Distilled's inventory client**: `listNamespaceObjects` and `listNamespaces` in `@distilled.cloud/cloudflare`'s `durable_objects` service (installed, `1.0.0-rc.13`). Its pagination reads `resultInfo.cursors.after`; legacy's hand-written client read `result_info.cursor` (`refs/baton-legacy/src/lib/ShopAgentObjects.ts`). Step 0 settles which is true.
- **The token**: `CLOUDFLARE_WORKERS_API_TOKEN` is already in `.env` and `.env.staging` (the user, 2026-10-19). Staging's values reach the Backend through the stage config record (`docs/stage-config-runbook.md`, "Add a value"; `StageConfigValues` in `src/backend/stack.ts`), as `SHOPIFY_PARTNER_API_TOKEN` does (`shopifyPartnerBinding`).
- **Local stages have no inventory**: `alchemy dev` runs its own workerd, with no `list_objects` (legacy's dev read miniflare's local explorer). The dev, e2e and test stages bind no token.

## 3. Names

| Where                               | Name                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/platform.ts`            | `ShopKey` (moved from the contract, its pattern and JSDoc), `ShopSession` (the row: the live fields, `shopGid` as `ShopGid`, legacy's field JSDoc), `ShopSessionUpsert` (omits the lease and the plan columns), `ShopSessionRedacted`, `ShopSessionRedactedPage`                                                       |
| `ShopSessionRepository`             | `findRedacted(shop)`, `getRedactedPage({ after, before, filter, limit })`, `findOrphanShopActorIds(names)`                                                                                                                                                                                                             |
| `BackendApi` (private)              | `requireAdmin(request)`                                                                                                                                                                                                                                                                                                |
| `BackendApi`                        | `shopSessionsPage`, `adminShop`, `refreshPlan`, `shopActors`, `orphanShopActors`, `destroyOrphan`                                                                                                                                                                                                                      |
| `src/contract/admin.ts`             | `ShopSessionsPageRequest`, `AdminShopRequest`, `AdminShopData` (`NotFound` \| `Found`, legacy's `AdminShopLoaderData` without `derivedShopAgentId`), `PlanRefreshFailed`, `ShopActorObject`, `ShopActorObjectsRequest`, `ShopActorObjectsPage` (`Unavailable` \| `Listed`), `DestroyOrphanRequest`, `OrphanHasSession` |
| `src/backend/shop-actor-objects.ts` | `ShopActorObjects` (legacy's `ShopAgentObjects`): `list({ cursor, limit })`; `layer` (binding present or `Unavailable`), `layerTest(objects)`; error `ShopActorObjectsError`                                                                                                                                           |
| `src/web/server/admin.ts`           | server functions `shopSessionsPage`, `adminShop`, `refreshPlan` (POST), `shopActors`, `orphanShopActors`, `destroyOrphan` (POST)                                                                                                                                                                                       |
| Routes                              | `admin.shops.tsx`, `admin.shop.$shop.tsx`, `admin.shop-actors.tsx`, `admin.orphan-shop-actors.tsx`                                                                                                                                                                                                                     |
| Components                          | `AdminShopsPage`, `AdminShopPage`, `ShopActorsPage`, `OrphanShopActorsPage`, `PlanCache`                                                                                                                                                                                                                               |
| Backend binding (staging only)      | `ShopActorObjects`: env `CLOUDFLARE_WORKERS_API_TOKEN` (`Redacted`), the account id, the actor namespace id                                                                                                                                                                                                            |
| `StageConfigValues`                 | `CLOUDFLARE_WORKERS_API_TOKEN: Redacted<string>`                                                                                                                                                                                                                                                                       |

**Copy** (legacy's, the words translated):

- Dashboard sections: Shops, "View connected shops and their stored Shopify sessions.", View shops; Shop actors, "View the Cloudflare Durable Objects behind each shop's actor.", View objects; Orphan shop actors, "Find shop actors with no installed shop and destroy them, without re-creating any.", View orphans; Members, "Every shop's members, with the date each was added.", View members. Heading "Admin", Sign out and "Signed in as …" as today.
- Columns and labels where legacy said Shop Agent ID: **Shop actor ID**. The inventory pages' headings: **Shop actors**, **Orphan shop actors**; their columns Object ID, Name, Stored data (and Action).
- The local-stage banner (info): "The actor inventory is Cloudflare's, so it is not available on this stage."
- Refresh plan's failure fallback: "Could not refresh the plan from Shopify."

## 4. Steps

### Step 0: Spike S1, the inventory

1. Read the staging actor namespace's inventory with `CLOUDFLARE_WORKERS_API_TOKEN` from `.env.staging`, from a scratch script outside `src/` (delete it afterwards), through distilled's `listNamespaceObjects`. Find the namespace id with `listNamespaces` (class `ShopActor`, script `baton-backend-staging`) and the account id from Alchemy's state or `cf`.
2. Record in §7, Command results: whether the token is allowed to list (and the error if not); the namespace id; the object count; whether every object has `name`; which cursor field Cloudflare answers (`result_info.cursor` or `result_info.cursors.after`) and whether distilled's pager follows it; `hasStoredData`'s values seen.
3. **If the token cannot list:** record a Human step (the user widens the token to Workers Scripts Read) and continue with Steps 1–2; Step 3 waits for it.
4. **If an object has no `name`:** destroy by name cannot reach it. Record it, and in Step 3 patch Alchemy (`pnpm patch`, `docs/dependency-patches-runbook.md`) to expose `idFromString` and `get` on the namespace binding, and destroy by id as legacy did (`destroyShopAgentObjectById`).
5. **If distilled's pager follows the wrong cursor field:** call one page at a time and read the cursor yourself, or patch distilled the same way; say which in §7.

### Step 1: One schema per concept (research Q4)

1. Move `ShopKey` into `platform.ts` with its pattern and JSDoc; delete the domain's `Shop`. `src/contract/shop.ts` imports `ShopKey` from the domain and re-exports nothing new; update every importer (`rg -l ShopKey src test`). `shop-work.ts`'s three `shop: Shop` fields take `ShopKey`.
2. The domain's `ShopSession` becomes the row: the fields of `ShopSessionRow` (`shopActorId`, `refreshLeaseUntil`, the tokens, the plan columns), `shopGid` as `ShopGid`, keeping legacy's JSDoc on `planHandle` and `planBoundaryAt` and `ShopSessionRow`'s on `shopActorId` and the lease. Delete `ShopSessionRow`; the repository decodes `ShopSession`.
3. One `ShopSessionUpsert`, the domain's, omitting the lease and the plan columns (the live one's rule); `shopify.ts` imports it from the domain. `ShopSessionRedacted` derives from `ShopSession` (tokens out, `hasAccessToken`, `hasRefreshToken` in, the lease out too); `ShopSessionRedactedPage` stays.
4. Delete the unreferenced legacy exports in `platform.ts`: `AuthSession`, `LoginInput`, `UserId`, `UserRole`, `SessionId`, `SocketKeepalivePing`, `SocketKeepalivePong`, `InvalidatedMessage`, `RevokeMemberConnectionsInput`, the `CONNECTION_*` header names. Re-check each with `rg -w` first; where one carries a rule still true, move the rule to the symbol that enforces it and say which in §7.
5. Green: `vp check --fix`; `vp test test/unit` (the D1, auth, Shopify and domain suites).

### Step 2: Backend reads, the role check, Refresh plan (research Q5–Q7)

1. **`ShopSessionRepository.findRedacted` and `getRedactedPage`**: legacy's `findShopSessionRedacted` and `getShopSessionRedactedPage` (`refs/baton-legacy/src/lib/Repository.ts`) with their SQL and JSDoc, `shopActorId` where legacy selected `shopAgentId`, lowercase SQL. Decode into `ShopSessionRedacted` and `ShopSessionRedactedPage`.
2. **`requireAdmin(request)`** in `BackendApi`: the session, `Unauthorized` signed out, `Forbidden` unless `userIsAdmin(me)`. `listMembers` uses it in place of its inline `Match`.
3. **`shopSessionsPage(request, { after, before, filter })`**: `requireAdmin`, then `getRedactedPage` with `limit` 25; answers the page plus `now` (the Backend's `Clock`).
4. **`adminShop(request, { shop })`**: `requireAdmin`; `findRedacted` first, `NotFound` with no actor call; otherwise `plan` from `adminShopPlanCache` at the Backend's clock, `entitlements` from `adminShopEntitlements`, then `ShopActors.getUsage` and `countMembers` concurrently. Port legacy `getLoaderData`'s JSDoc (the row before the usage read; the plan decoded, never resolved).
5. **`refreshPlan(request, { shop })`**: `requireAdmin`; `SubscriptionPlan.refresh(shop)`; a `SubscriptionPlanError` becomes `PlanRefreshFailed { message }`. Port legacy `refreshPlan`'s JSDoc (the only write; both outcomes success).
6. Contract schemas in `src/contract/admin.ts` (§3). Encode what is not JSON-plain, as `BackendApi`'s JSDoc says.
7. **Tests, unit.**
   - `test/unit/backend/shop-session-repository.test.ts`, legacy's six titles under `describe("getRedactedPage")`: "forward first page reports the next cursor", "forward page with an after cursor reaches the end", "forward page applies the filter (like)", "backward page reverses ordering and reports previous cursor", "backward page applies the filter (like)", "projects hasAccessToken / hasRefreshToken from null checks"; and "findRedacted answers a row with neither token".
   - `test/unit/backend/api.test.ts`: "shopSessionsPage, adminShop and refreshPlan are Forbidden to a user and Unauthorized signed out"; "adminShop answers NotFound for a shop with no row and never calls its actor" (a recording `ShopActors`); "adminShop answers the cached plan, usage and member count"; "refreshPlan refreshes the shop's plan and answers PlanRefreshFailed when Shopify cannot be read" (a stub `SubscriptionPlan`).

### Step 3: The inventory (research Q13)

1. **`ShopActorObjects`** (`src/backend/shop-actor-objects.ts`): `list({ cursor, limit })` over distilled's `listNamespaceObjects`, with the account id, namespace id and token from its binding; decode as legacy's `ShopAgentObject` (its JSDoc on the three optional fields ports). Without the binding, `list` answers `Unavailable`. Errors log as legacy's `ShopAgentObjects.list` line (status, body, URL), renamed.
2. **The binding**, staging only, in `wireBackend` (`src/backend/stack.ts`): `StageConfigValues` grows `CLOUDFLARE_WORKERS_API_TOKEN` (`Redacted`); `stacks/stage-config.ts` reads it; the Backend gets the token, the account id and the actor namespace id. Take the namespace id from Alchemy's `ShopActor` (`namespaceId`) and the account id from `CloudflareEnvironment`; if either cannot be had at deploy, fall back to Step 0's lookup at runtime and record why. Dev, e2e and test bind nothing.
3. **`ShopSessionRepository.findOrphanShopActorIds(names)`**: legacy's `findOrphanShopAgentIds` (`json_each` anti-join), on `shopActorId`.
4. **`BackendApi`**:
   - `shopActors(request, { cursor })`: `requireAdmin`, `list` with legacy's `LIMIT` 1000.
   - `orphanShopActors(request, { cursor })`: `requireAdmin`, `list`, then legacy's diff: an object with `hasStoredData === false` is a tombstone (listed, no Destroy); one whose `name` has no row is an orphan; one with a row is not listed.
   - `destroyOrphan(request, { name })`: `requireAdmin`; `findRedacted(name)` again, `OrphanHasSession` when the row exists; otherwise `ShopActors.destroy(name)`. Log `destroyOrphan: shop=<name> status=destroyed|failed`. (By id instead if Step 0 found unnamed objects.)
5. **Tests, unit.** `findOrphanShopActorIds`: "a name with a ShopSession row is not an orphan", "an empty list reads nothing". `api.test.ts` over `ShopActorObjects.layerTest`: "the orphan list keeps tombstones without Destroy and drops shops that have a session", "destroyOrphan refuses a shop that has a session", "destroyOrphan destroys a shop actor with no session", "the inventory answers Unavailable without its binding".

### Step 4: Screens (research Q3, Q8–Q10)

1. `src/web/server/admin.ts`: the six server functions over `backend()`; each rescues `Unauthorized` to `/sign-in?redirect=<its page>` and `Forbidden` to `homeFor("user")`, as `listMembers` does; `refreshPlan` and `destroyOrphan` are POST.
2. **Dashboard** (`admin.index.tsx`): §3's four sections, legacy's shape (heading, sentence, primary View button through `navigate`).
3. **`/admin/shops`**: legacy `admin.shops.tsx` whole: its search schema with `filter` decoded by `Schema.Trim` and dropped when empty (lenient, `-search-params.ts`), its two loader redirects, `ListSearchField` in the table's filters slot ("Search by shop"), its columns with Shop actor ID, `PlanCache` judged at the answer's `now`, "No sessions.".
4. **`/admin/shop/$shop`**: legacy `admin.shop.$shop.tsx` whole, minus "Shop Agent ID from name" (Shop actor ID shown instead): the `ShopKey` param, `NotFound` and `Found`, the two sections and every field, Refresh plan (POST, then `router.invalidate({ sync: true })`, loading, the error banner with `PlanRefreshFailed`'s message or §3's fallback). Its `staleReloadMode: "blocking"` JSDoc ports onto this route.
5. **`/admin/shop-actors`** and **`/admin/orphan-shop-actors`**: legacy's two files whole (paging, cursor history, Destroy with its loading state, tombstone rule, "No orphans.", "No Shop Agent objects found." as "No shop actors found."), the banner on `Unavailable`.
6. `staleReloadMode: "blocking"` on all four routes.
7. `PlanCache` (`src/web/components/PlanCache.tsx`): legacy's, its JSDoc and badge table.
8. **Tests, browser** (`test/browser/web/components/`): "PlanCache shows each cache state's badge and the stored handle"; "the shop page shows No session for a shop with no row"; "the shop page shows a dash for an empty field and of — when the cache grants nothing"; "Refresh plan holds its loading state and shows the failure"; "an orphan tombstone has no Destroy"; "the inventory pages show the unavailable banner".

### Step 5: e2e (research Q12)

1. `test/e2e/http.spec.ts`, signed-out block: "an anonymous visitor is bounced from /admin to /sign-in", "an anonymous visitor is bounced from /admin/shops to /sign-in" (assert `location`).
2. `test/e2e/admin.spec.ts`, admin storage state, read-only (no Refresh plan, no Destroy, no Sign out): "the dashboard names the consoles and links to each"; "shops lists installed shops, filters by domain, and drills into one" (filter by URL as legacy; the e2e shop is always installed, so no skip); "a shop with no stored session shows the No session banner"; "the Shop actors console renders its table and breadcrumb" and "the Orphan shop actors console renders its table and breadcrumb" (legacy's titles, agent read as actor, as the research's Q13 says), asserting the heading, the unavailable banner and the breadcrumb (the e2e stage has no inventory). Run this spec and `http.spec.ts` alone.
3. `test/e2e/embedded/plan.billing.spec.ts`'s second title: after the downgrade, a new context with `playwright/.auth/admin.json` opens `/admin/shop/<e2e shop>`, presses Refresh plan, and reads Cached plan containing `baton-basic` and Usage events pending `0` (legacy's `readAdminFields`, adjusted to this repo's parts). Rewrite its JSDoc. The billing project is headed and by hand: do not run it; record a Human step.

### Step 6: Close

1. Full `vp test`; record counts and times in §7.
2. Update `docs/legacy-port-research.md`: §1.1's billing row ("Admin console's plan fields are H") and a console row; §3's H row as implemented; Q10 and §5's explorer row as superseded by this slice's Q13. Glossary: add a word only if one is new.
3. Record the Human steps for staging (§7).

## 5. Verification checklist

- `rg -n "ShopSessionRow|\bShop\b.*brand\(\"Shop\"\)" src` finds nothing; `ShopKey` and `ShopSession` are declared once (`rg -n "export const (ShopKey|ShopSession) " src`).
- No admin page reads `ShopSessionRepository.find`; the redacted SQL never selects `accessToken` or `refreshToken` as columns (read it).
- `adminShop` reads the row before any `ShopActors` call; `destroyOrphan` re-checks the row at the press (read them).
- Every admin `BackendApi` method starts with `requireAdmin`.
- No `operator` or `Shop Agent` in new code or copy, except test titles kept from legacy (`rg -i "operator|shop agent" src`).
- Every test title in §4 exists (`rg -F` each).
- `migrations/` and the actor's schema are unchanged (`git diff --stat`).

## 6. Done when

- §1 holds on the dev stage (the inventory pages show the banner) and every step is green and committed; §7 is filled in; the staging Human steps are listed.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step (`**2026-10-19, Step 2:** …`).

- A **deviation** is anything built differently from the step that specified it. Say what, and why.
- An **issue** is anything the plan did not predict. Say what you saw, what you did, and whether it is open.
- **Command results** carry counts and times, and Step 0's answers.
- **Human steps requested** lists what only the lead or the user can do.

### Plan review

**2026-10-19, lead:** Checked against the code: `platform.ts`'s dead exports, `ShopSessionRow`/`ShopSessionUpsert` in the repository, `StageConfigValues` and `shopifyPartnerBinding` in `stack.ts`, Alchemy's `namespaceId` output on the namespace, `ShopActors.destroy(key: ShopKey)` and `getUsage`. The steps hold. Changes and notes:

1. Step 5.2's inventory titles said "Shop Agent Objects"; the research's Q13 reads agent as actor and the glossary forbids the legacy word. Renamed to "the Shop actors console …" and "the Orphan shop actors console …".
2. Step 1.4 deletes only the `CONNECTION_*` **header** names; `CONNECTION_CLOSE_*` and `ConnectionRole` stay if referenced (check each with `rg -w`).
3. `destroyOrphan`'s `name` decodes as `ShopKey` (what `ShopActors.destroy` takes). An inventory name that is not a shop domain cannot be destroyed by name; the orphan page lists it without Destroy, and §7 records it if Step 0 sees one.

### Deviations

- **2026-10-19, Step 0:** the token could not list, so the account and namespace ids came from `cf` (its own OAuth login, read-only: `cf accounts list`, `cf durable-objects namespaces list`), and one read-only `cf durable-objects namespaces objects list` on the staging namespace stood in for the inventory read the token could not make. No scratch script reached distilled's `listNamespaceObjects` with a working credential; the scratch scripts (raw `fetch`, outside the repo in `/tmp`) are deleted.
- **2026-10-19, Step 0 → Step 3:** Step 3 waits for the token (Step 0.3). Steps 1 and 2 proceed; so do the parts of Steps 4 and 5 that do not touch the inventory (dashboard Shops and Members sections, `/admin/shops`, `/admin/shop/$shop`, `PlanCache`, their browser and e2e titles, the billing spec). The inventory's pages, dashboard sections and titles land with Step 3.
- **2026-10-19, Step 1:** also deleted `User` and `SessionContext` (imported by nothing, and built on `UserId`, `UserRole` and `AuthSession`, which the step deletes). `UserRole`'s rule (only `user` and `admin`, Better Auth's admin-plugin defaults, mirrored by the `UserRole` lookup table; per-shop access is a `Member` row) moved onto `userIsAdmin`, the symbol that enforces it. The header names' and the other deleted exports' rules are legacy's (the gate header, `Notice`, Effect RPC's pings replaced them); nothing carried over.
- **2026-10-19, Step 1:** `CONNECTION_CLOSE_FORBIDDEN`, `CONNECTION_CLOSE_REVOKED`, `CONNECTION_CLOSE_DISPLACED` and `ConnectionRole` stay in `platform.ts` (the lead's note 2). `ConnectionRole` is imported (`shop-work.ts`, two components); the three close codes are imported by nothing (every caller takes the contract's copies), so they are duplicates left for a later sweep.
- **2026-10-19, Step 1:** `shopGid` as `ShopGid` made `SubscriptionPlan`'s own `decodeShopGid` redundant; it is gone. The unit tests' rows take `SEED_SHOP_GID` (new, `test/seed-shops.ts`) or decode a `ShopGid`. Importers of `ShopKey` from inside `src/contract/` (`./shop.ts`) moved to the domain too.
- **2026-10-19, Step 2:** `AdminShopPlanCache` (domain billing) became a schema, its type derived, so `AdminShopData` in the contract names the domain's one definition instead of copying the union. `shopSessionsPage` answers `{ page, now }` (`ShopSessionsPageData`); the page size is `SHOP_SESSIONS_PAGE_SIZE` (25) in the contract. `ShopSessionsPageRequest`'s cursors decode as `ShopKey` (the cursor is a shop) and `filter` as a non-empty string (the route trims). `refreshPlan` logs `refreshPlan: shop=<shop>: <message>` at warning before answering `PlanRefreshFailed`. `TestBackend` (api.test.ts) grew a `sessions` option, so a test can seed a row with a known plan handle (the seed row's `planHandle` is `"basic"`, which reads as Unrecognized).

### Issues

- **2026-10-19, Step 0: distilled drops `name`.** `NamespacesObjectsListResultItem` (distilled `durable_objects`, rc.13) declares only `id` and `hasStoredData`; Schema's `Struct` strips undeclared keys on decode, so `listNamespaceObjects` can never hand back a `name`, whatever Cloudflare sends. The by-name join (Q13) through distilled needs a `pnpm patch` adding `name: S.optional(S.NullOr(S.String))` to that item, or a direct read. Open until the token works and the raw body shows whether Cloudflare sends `name` at all.
- **2026-10-19, Step 0: the staging object showed no `name`.** `cf`'s listing of the staging namespace answered one object, `{ id, hasStoredData: true }`, no `name`. `cf` may itself strip fields it does not declare, so this is not proof; legacy's JSDoc ("prod orphan rows typically carry no name") points the same way. If Cloudflare does not send `name`, Step 0.4 applies, and more than destroy changes: the orphan join must be by id too, since `ShopSession.shopActorId` is the name. Open.
- **2026-10-19, Step 0: `limit` has a floor.** Cloudflare refused `limit` 2, 10 and 25 with `[10077] Malformed parameter: limit is too low`; 100 was accepted. Legacy's `DEFAULT_LIMIT` 25 would fail; its pages' `LIMIT` 1000 is fine. The pager is moot for Step 3: the pages show one page at a time, so `list` calls the operation once (distilled's call function is one request) and reads the cursor itself; distilled's `ResultInfo` carries both `cursor` and `cursors.after`, so `list` can read either.

### Command results

- **2026-10-19, Step 0 (S1):**
  - Token: **not allowed**. `CLOUDFLARE_WORKERS_API_TOKEN` (`.env.staging`, the same value as `.env`) answers `401 [1000] Invalid API Token` on `/user/tokens/verify` and `/accounts/<id>/tokens/verify`, `403 [9109] Invalid access token` on `/accounts`, and `401 [10000] Authentication error` on the namespaces and objects lists. Not a scope problem: Cloudflare does not recognise the token (revoked, expired, or from another account).
  - Account id `87997fc2724b0127effb8e4524989975`; actor namespace id `76be23649c4a49ea8772f89465f5ce82` (`baton-backend-staging_ShopActor`, class `ShopActor`, script `baton-backend-staging`, SQLite).
  - Objects (through `cf`, limit 100): **1**; `name` absent on it (see Issues); `hasStoredData` seen: `true`.
  - Cursor field: not observed (one page, and `cf` prints only `result`); distilled's pager follows `resultInfo.cursors.after`; its `ResultInfo` decodes `cursor` too. Unsettled until the token works.
- **2026-10-19, Step 1:** `vp check --fix` clean (373 files). `vp test test/unit`: 52 files, 828 tests passed, 12.3 s.
- **2026-10-19, Step 2:** `vp check --fix` clean (374 files). `vp test test/unit/backend/shop-session-repository.test.ts`: 15 passed, 2.2 s. `vp test test/unit/backend/api.test.ts`: 37 passed, 2.2 s.

### Human steps requested

**2026-10-19, Step 0 (blocks Step 3):** replace `CLOUDFLARE_WORKERS_API_TOKEN`. Cloudflare rejects the current value as invalid (not under-scoped).

1. Cloudflare dashboard → Manage account → Account API tokens (or My Profile → API Tokens) → Create token → Custom token: permission **Account · Workers Scripts · Read** on account `Mw10013@gmail.com's Account`; no IP filter; no expiry, or one you will track.
2. Put the new value in `.env.staging` and `.env` as `CLOUDFLARE_WORKERS_API_TOKEN=…` (main checkout).
3. Tell the implementer. It unblocks Step 0's answers (does Cloudflare send `name`; which cursor field) and with them Step 3 (by name as planned, or by id with the Alchemy patch), and later the stage config record (item 1 below).

Known before the run (the lead's, at close):

1. Add `CLOUDFLARE_WORKERS_API_TOKEN` to the staging record: it is already in `.env.staging`; run `vp run stage-config --stage staging` (the runbook's "Add a value") before the push.
2. The billing spec by hand: `vp run test:e2e:billing`.
3. Staging, after the push (research Q14): sign in as the staging admin; Shops lists `mw10013-staging-shop-00`; its page reads every field and the page source holds no token; Refresh plan leaves the plan and moves Fresh until; Shop actors lists the staging shop's actor; Orphan shop actors lists none or staging's orphans; one embedded load still works.

### Implementation review

## 8. Out of scope

- Any admin write beyond Refresh plan and Destroy on an orphan.
- An app version in the dashboard heading.
- Making the console live, or giving an admin a socket.
- The inventory on dev, e2e or test stages.
- Production's token and record (with production).
