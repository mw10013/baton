# `Session` → `ShopSession` rename — research + execution notes

Rename the D1 table `Session` (Shopify offline-token sessions) to `ShopSession`, plus its TypeScript identifier family. Why: better-auth is coming (`docs/member-access-research.md`) and claims the PascalCase `Session` table name for auth sessions; the codebase also juggles two other "session" meanings (`ShopifyApi.Session` API objects, D1 read-replica `withSession`) that this rename disambiguates from.

Written for an implementing agent. The touchpoint inventory below is complete as of 2026-08-31 (verified by exhaustive grep); re-verify with the audit greps at the end.

## TL;DR

- **Edit `migrations/0001_init.sql` in place + `pnpm d1:reset`. Do NOT write an `alter table … rename` migration.** No remote databases exist to migrate: `wrangler.jsonc` has **no `env` key at all** (only `baton-d1-local`, a placeholder id, `wrangler.jsonc:54-60`); `.env.staging`/`.env.production` don't exist; git history shows env blocks were never added. The only data anywhere is a disposable 32KB local dev db (`pnpm d1:reset` is the documented wipe).
- Rename the whole identifier family: table, `Domain.Session*` schemas, `Repository` **and** `Shopify` service method names (decided — see §3 for the full old→new name table), span labels, error strings. `Session` → `ShopSession` within the family only; drop `ByShop` suffixes where the new name would say "shop" twice.
- **Do not touch** the three other "session" concepts (danger list below): `ShopifyApi.Session` + the session-token cluster, AdminAuth's cookie session, D1 read-replica `d1Session`/`withSession`.
- Land this **before** the better-auth migration `0002_*` gets written.
- Branch off `main`; do not commit without explicit instruction (CLAUDE.md).

## 1. Migration

`migrations/0001_init.sql` — the entire file is this one table (`create table if not exists Session (` at `:1`; columns `shop` PK, `shopGid`, `shopAgentId` unique, `scope`, `accessToken`/`accessTokenExpiresAt`, `refreshToken`/`refreshTokenExpiresAt`, `planHandle`/`planHandleExpiresAt`). Change the table name in place.

Migration application paths (all pick the change up automatically from the file):

1. Local: `pnpm d1:migrate:apply` — but since the old table exists locally, run `pnpm d1:reset` (deletes `.wrangler`, reapplies) instead.
2. Tests: `test/integration/vitest.config.ts:11-12` `readD1Migrations(migrationsPath)` + `test/apply-migrations.ts` — fresh db per test worker, **no config change needed**.
3. Staging/production: `d1:*:staging` / `:PRODUCTION` scripts exist in `package.json` but point at env blocks that don't exist in `wrangler.jsonc` — they fail today and keep failing identically; out of scope.

## 2. SQL touchpoints — `src/lib/Repository.ts`

All raw SQL naming the table lives here (9 statements) plus two test cleanups:

- `Repository.ts:128` `select * from Session where shop = …` (`findSessionByShop`)
- `:162-166` `insert into Session (…) on conflict(shop) do update set …` (`upsertSession`)
- `:177` `update Session set accessToken = null …` (`clearSessionAccessToken`)
- `:192` `update Session set …` tokens (`updateSessionTokens`)
- `:210` `update Session set …` plan (`updateSessionPlan`)
- `:220` `delete from Session where shop = …` (`deleteSessionByShop`)
- `:229` `update Session set scope = …` (`updateSessionScope`)
- `:241`, `:283` `from Session` projection selects (`findSessionRedactedByShop`, `getSessionRedactedPage`)
- `:318` `left join Session s on s.shopAgentId = je.value` (`findOrphanShopAgentIds`)
- Error strings: `:133`, `:248` `"Invalid Session row"`, `:290` `"Invalid Session rows"` → `ShopSession`
- `test/integration/repository.test.ts:47` and `test/integration/subscription-plan.test.ts:97`: `env.D1.exec("delete from Session")`

## 3. TypeScript identifier family (rename all)

`src/lib/Domain.ts`: `Session` (`:135`, `:162`), `SessionRedacted` (`:164`, `:169`), `SessionRedactedPage` (`:171`, `:179`; note its `sessions:` field) → `ShopSession`, `ShopSessionRedacted`, `ShopSessionRedactedPage`. Doc comments at `:148`, `:238` mention the table/row. **Do not rename** `Domain.SessionId` (`:21-22` — Shopify API synthetic offline-session id from `shopify.session.getOfflineId()`), `ConnectionState.sessionToken` (`:321-323`), `SessionTokenInput` (`:327-330`).

Consumers of the renamed types:

- `src/lib/Repository.ts` — service interface throughout (`:38-99`) + implementations; also the ~10 method names. New names (drop `ByShop` where the name would say "shop" twice — the argument conveys the key): `findSessionByShop` → `findShopSession`, `upsertSession` → `upsertShopSession`, `clearSessionAccessToken` → `clearShopSessionAccessToken`, `updateSessionTokens` → `updateShopSessionTokens`, `updateSessionPlan` → `updateShopSessionPlan`, `deleteSessionByShop` → `deleteShopSession`, `updateSessionScope` → `updateShopSessionScope`, `findSessionRedactedByShop` → `findShopSessionRedacted`, `getSessionRedactedPage` → `getShopSessionRedactedPage`. `Effect.fn` span labels embed the same names (`"Repository.findSessionByShop"` etc.) — rename in lockstep so spans match methods.
- `src/lib/Shopify.ts` — `Domain.Session` at `:120`, `:125`, `:187`, `:525`, `:612`, `:616`, `:1355`; and the `Shopify` service's persisted-offline-session methods (surface listed `:87-190`). **Decided (2026-08-31): rename these too, same pass** — the win is a clean three-way taxonomy inside this 1600-line file: `ShopSession` = the persisted offline session (row or rehydrated), bare `sessionToken` = the App Bridge JWT, bare `sessionId` = Shopify's synthetic offline id. After the rename a bare "session" in `Shopify.ts` only ever means the JWT/id concepts. `ShopSession` not `ShopifySession`: call sites go through the service (`shopify.storeShopifySession` would stutter) and one term shared with the table beats two near-synonyms; contrast with `CurrentShopifySession` (stays — holds the live `ShopifyApi.Session`) is intentional. New names: `storeSession` → `storeShopSession`, `loadSessionByShop` → `loadShopSession`, `deleteSessionByShop` → `deleteShopSession`, `refreshSession` → `refreshShopSession`, `refreshSessionIfExpired` → `refreshShopSessionIfExpired`, `ensureSession` → `ensureShopSession`. Unchanged: `recoverRefreshRace` (no "session" in name), `sessionIdFromShop`, `decodeSessionToken`, `withShopifyDocumentHeaders`, `validateWebhook`, `authenticateAdmin`, `authenticateFlowAction`. Callers to touch: `src/routes/webhooks.app.uninstalled.ts:43` (`deleteSessionByShop`), `ShopAgent.ts` (`ensureSession` in `getShopInfo`), `SubscriptionPlan.ts`, tests `shopify-webhook.test.ts:149-230`, `shopify-offline-refresh.test.ts` — find the rest via the audit greps.
- `src/lib/SubscriptionPlan.ts` — `:124`, `:207` `session: Domain.Session`; comment `:143` "A shop with no `Session` row resolves to `Unsubscribed`".
- `src/routes/admin.shop.$shop.tsx` (`:46`, `:57`), `src/routes/admin.shops.tsx` (`:24-31`, `:139-179`).
- Tests: `test/integration/repository.test.ts` (`:23-25` fixture, `:49` describe label "Repository SQL (D1 Session)", ~40 method call sites), `test/integration/subscription-plan.test.ts` (`:25-48`, `:186-271`), `test/integration/shopify-offline-refresh.test.ts` (`:205`, `:220` `updateSessionTokens`), `test/integration/shopify-webhook.test.ts` (`:149-230` — calls `Shopify.*` methods; only changes if those get renamed).
- Comments naming the table: `src/components/PlanCache.tsx:10`, `src/lib/ShopAgentObjects.ts:38`, `src/lib/ShopAgent.ts:107`, `src/worker.ts:102`, `src/routes/webhooks.compliance.ts:21,:33`.

## 4. User-visible strings + docs

- `src/routes/admin.shop.$shop.tsx:293` `<s-section heading="Session" accessibilityLabel="Stored Shopify session">` → heading `"Shopify session"` (only literal "Session" heading in the UI). The "No session" banner (`:212-214`) and `admin.shops.tsx:189` "No sessions." are prose about the concept — fine as-is.
- `src/routes/privacy.tsx:103,:121` — generic "session" prose, leave untouched.
- `README.md:12` "Session storage (D1)" row → update. `AGENTS.md:14`/`CLAUDE.md` "shared session state lives in D1" → e.g. "shared Shopify session state (`ShopSession`) lives in D1".
- `docs/member-access-research.md` already says `ShopSession` — no change.

## 5. Danger list — same files, different "session"; DO NOT rename

1. **`ShopifyApi.Session` class** (Shopify API objects): `src/lib/Shopify.ts:89,116,130,144,152,160,166,168,178,513,554,585,699,806`; `src/lib/CurrentShopifySession.ts:5-8` (whole service); `src/lib/ShopAgent.ts:153,:156`; `src/lib/ShopifyAdmin.ts:3,29,34,39`; `src/lib/ShopifyServerFnMiddleware.ts:10,26,48,71,76,85`; tests `shopify-offline-refresh.test.ts:65,67`, `shopify-webhook.test.ts:78,80`.
2. **The critical mixed sites**: `Shopify.ts:525-538` `storeSession` converts `ShopifyApi.Session` → `Domain.Session` row in one expression (both meanings within 15 lines); `Shopify.ts:684-712` `loadSessionByShop` does the reverse (doc comment `:677-682` explains the id/`shopGid` mismatch). Highest find-replace risk in the repo — edit by hand.
3. **Session-token cluster** (App Bridge JWT): `Shopify.ts:82,:818` (`sessionId`), `:186-188,:1354-1359` (`sessionIdFromShop` — note it takes `Domain.Session["shop"]` as a param type, so its *signature* changes while its *name* must not), `:93,:1374-1377` (`decodeSessionToken`), `:191`, `:219,:298-304` (`StoredSessionExpiry`), `:443-455,:1043-1269` (`sessionToken`/`sessionShop`/`failInvalidSessionToken`…); protocol literals `"X-Shopify-Retry-Invalid-Session-Request"` (`:1051,:1134`, also tests `shopify-admin-auth.test.ts:129,149`) and `"/auth/session-token"` (`:1064,:1160,:1220,:1225`); `ShopAgent.ts:266-299`; `app.index.tsx:131-203` (`sessionTokenRef`).
4. **AdminAuth cookie session**: `src/lib/AdminAuth.ts` (`useSession`, `SESSION_MAX_AGE_SECONDS`, cookie `"admin-session"`, `requireSession`), `AdminServerFnMiddleware.ts:13`, `admin.tsx:12`.
5. **D1 read-replica session** (Cloudflare concept): `src/worker.ts:36-42,64,92,116,172-176` (`d1Session`, `env.D1.withSession`, `D1DatabaseSession`), `src/lib/D1Bookmark.ts:5,9`, `src/router.tsx:41`, `src/start.ts:24`. Note `worker.ts:102` mentions the `Session` **table** in a comment three lines from `d1Session` code — that comment DOES change.
6. Playwright session names in AGENTS.md/CLAUDE.md (`{port}-localdev`) — unrelated.

## 6. Execution order + verification

1. Branch. Edit `migrations/0001_init.sql`.
2. Rename `Domain` schemas, `Repository` SQL + method names + span labels + error strings, consumers, comments, UI heading, README/AGENTS.md lines.
3. `pnpm d1:reset` (local db is disposable).
4. `pnpm typecheck && pnpm lint && pnpm test` — integration tests build fresh DBs from the edited migration, so they are the real check.
5. Audit greps must come back empty (excluding `refs/`, `docs/`, `.wrangler/`):
   - `grep -rn --exclude-dir=refs --exclude-dir=node_modules --exclude-dir=.wrangler -e "from Session" -e "into Session" -e "update Session" -e "delete from Session" -e "join Session" src/ test/ migrations/`
   - `grep -rn --exclude-dir=refs "Domain\.Session\b\|Domain\.SessionRedacted\|SessionRedactedPage" src/ test/` — only `Domain.SessionId` hits may remain.
   - `grep -rn --exclude-dir=refs -e "storeSession" -e "loadSessionByShop" -e "deleteSessionByShop" -e "refreshSession" -e "ensureSession" -e "findSessionByShop" -e "upsertSession\b" src/ test/` — must be empty (old method names gone).
6. Smoke: `pnpm app:dev`, open embedded app (exercises token exchange → `upsertShopSession`), then `/admin/shops` (exercises `getShopSessionRedactedPage`).

Out of scope: any better-auth work, env-block/staging setup, e2e runs.
