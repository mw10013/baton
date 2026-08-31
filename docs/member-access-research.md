# Member access (non-Shopify users) — research

Research only, not a spec. How people who are **not** the shop owner (and the owner, outside Shopify admin) get at a shop's Baton data. `docs/Baton — Development Spike.md` is rough guidance; we deliberately diverge on multi-shop membership (see below).

References:
- `refs/better-auth` (v1.7.2 docs/source; `better-auth@1.7.2` already in `package.json`, zero imports in `src/` yet). Doc paths below relative to `refs/better-auth/docs/content/docs/`.
- `refs/tceas` — TanStack Start + Cloudflare + Effect + Better Auth 1.7.0 reference app. **Primary pattern source.** Not to be followed slavishly; its tenancy model (auto-provisioned personal orgs) differs from Baton's (org = installed shop).

Decisions taken (2026-08-31, with mw):

- **Skip the organization plugin** — roll minimal `Member` table.
- Member area lives at **`/shop/$shop/*`** ("shop" — identifiable, easy to debug); page header/label uses the **shop name** for now.
- **Rename Shopify's D1 `Session` table → `ShopSession`** so better-auth keeps PascalCase `User`/`Session`/`Account`/`Verification`.
- **`/admin` operator console moves onto better-auth too** (magic link + `role=admin` via `ADMIN_EMAILS` bootstrap), **sequenced after member auth lands**; retires `AdminAuth` password + sealed cookie.
- **No explicit invite-accept step**: owner adds an email → `Member` row exists → person logs in; the magic link proving email ownership *is* acceptance. No invitation table/status.
- **Owner self-adds** their own email in the member list (role `owner`); no install-time auto-provisioning.
- `Member.shop` **FK to `ShopSession(shop)` with `on delete cascade`** — uninstall tears down memberships via referential integrity.
- Uninstall = **full shop teardown** (ShopSession row, members via cascade, ShopAgent DO destroyed). Reinstall starts fresh; members re-added. `User` rows persist but are inert (invite-only gate requires a `Member` row).
- Transactional email via **`mail.mw10013.com`** (Cloudflare Email Sending) — domain already onboarded at the account level (tceas uses it); Baton only adds the `send_email` binding.
- Term: **member** — final (see Terminology).
- `Session` → `ShopSession` rename starts **sooner rather than later** as a parallel work item; execution notes in `docs/session-to-shopsession-rename-research.md`.

## TL;DR — recommendations

- **Fourth surface**: signed-in member area beside public (`/`, `/privacy`), embedded (`/app/*`), operator (`/admin/*`). Login button on the public homepage at `baton.mw10013.com`; magic-link email sign-in; no Shopify identity involved. Owner and workers use the same flow.
- **Better Auth: core + `magicLink` + `admin` plugins. Skip the `organization` plugin — roll a minimal `Member` table keyed by shop domain.** Analysis below.
- Identity/membership in **D1** (cross-shop queries: "which shops can this email see?"); per-shop workflow state stays in the ShopAgent DO.
- Adopt TCEAS wholesale for: server-fn-first (no auth client), catch-all handler with allowlist, `D1Primary`/`D1Session` split, Cloudflare Email Sending + KV demo-mode magic links, hand-written migration + schema drift test, org-in-URL authorization posture.
- Multi-shop worker: rows in `Member`; after login, one shop → straight in, several → shop picker. Shop lives in the URL, never in session state.

## Surfaces + naming

| Surface | Routes | Who | Auth |
| --- | --- | --- | --- |
| Public | `/`, `/privacy`, help later | anyone | none |
| Embedded app | `/app/*` | owner inside Shopify admin | token exchange (`src/lib/Shopify.ts:1281`); 3-layer guard (`src/worker.ts:235-243`, `src/routes/app.tsx:146-149`, `shopifyServerFnMiddleware`) |
| Operator console | `/admin/*` | us | password + sealed cookie (`src/lib/AdminAuth.ts`) |
| **Member area (new)** | `/shop/$shop/*` | invited members incl. owner | Better Auth magic link |

Naming: audience is no-code merchants + their workers — avoid "portal". Owner tells worker "go to baton.mw10013.com, log in". Route prefix decided: **`/shop/$shop/*`** (identifiable in URLs/logs, easy to debug; distinct from operator `/admin/shop/$shop`). Page label: the shop name, for now. Deployment mirrors bang/modeo: `baton.mw10013.com` subdomain of `mw10013.com`; email sender would follow tceas's `mail.` pattern (`noreply@mail.mw10013.com` in `refs/tceas/wrangler.jsonc:56-61` — sender pinned via `allowed_sender_addresses`).

## Terminology: what to call these people

Population is mixed: shop employees without Shopify logins **and** externals (embroidery worker, factory, supplier) the owner grants view/act access to. Needs one word covering both.

- **Member** (decided) — neutral, covers internal + external, matches the DB table and better-auth vocabulary, natural UI copy ("Members", "Add member by email"). No Shopify collision.
- **Collaborator** — rejected: Shopify has real "collaborator accounts" (Partner/agency store access); merchants who know the term would be confused.
- **Staff** — rejected: Shopify's own word for admin staff accounts, and implies employment (externals aren't).
- **Worker** — rejected (mw).
- **Team / teammate** — rejected: hokey, better-auth org-plugin "teams" association, and begs "can a shop have multiple teams?" (no — SMB target, one flat member list per shop).
- **Crew** — runner-up with workshop personality; singular "crew member" is clunky.

User-role taxonomy once admin migrates onto better-auth: `User.role = "admin"` = site operators (us); everyone else = regular users whose per-shop capability comes from `Member.role` (`owner` | `member`). A shop owner is just a user with an `owner` member row on their shop — and can simultaneously hold a plain `member` row on someone else's shop.

## Organization plugin vs roll-our-own

### What tceas actually did (hybrid)

- Uses the plugin for member/invitation/role **operations** (`refs/tceas/src/lib/Auth.ts:173-203`), but **org creation never goes through better-auth**: `allowUserToCreateOrganization: false`, and `Repository.ensureOwnedOrganizationId` (`refs/tceas/src/lib/Repository.ts:204-273`) re-implements it as raw SQL because:

  > "better-auth's own route inserts the `Organization` and owner `Member` rows as two separate statements — no transaction on D1, so a failure between them orphans an `Organization` row. Here both inserts ride one atomic D1 batch (`D1Client.batch`) instead."

  Plus a partial unique index backstop (`refs/tceas/migrations/0001_init.sql:73-79`) because "better-auth's organizationLimit is a count-then-insert check with no transaction on D1".
- Cost it accepted, documented: manual re-implementation "MUST be kept in sync with how better-auth writes these rows — track refs/better-auth/.../crud-org.ts on upgrades"; invitation-accept never implemented; `sendInvitationEmail` is a log stub.
- The real gap is confirmed in `refs/tceas/docs/effect-sql-d1-vs-bare-d1.md:25`: the Effect D1 driver **does** support atomic `batch`; better-auth is what never batches (its adapter detects D1 and just sets `transaction = false`).
- Authorization is **doubled anyway**: every org-scoped request re-validates `Repository.findMemberRole({ userId, organizationId })` server-side against the URL param before the plugin's own check ever runs (`refs/tceas/src/routes/app.$organizationId.tsx:36-87`). `session.activeOrganizationId` is "never read for authorization — it survives only as the login-time redirect hint" (`refs/tceas/src/lib/Auth.ts:256-264`).

### Baton's tenancy is different — and that tips the scale

1. **Baton already has a tenant table.** `Session` keyed by shop domain (`migrations/0001_init.sql`), created at install. An `Organization` row 1:1 with it is pure ceremony plus a linkage decision (slug vs additionalFields) that buys nothing.
2. **The plugin's endpoint authorization assumes callers with better-auth sessions.** Baton's member management originates in the embedded app under a *Shopify* session — every plugin call would be a server-side bypass with explicit orgId, i.e. we'd use the plugin as a table schema, not as an authorization layer.
3. **D1 atomicity.** Plugin writes (accept-invitation = update invitation + insert member) are non-atomic on D1. Our own writes ride one `d1.batch` — the exact reason tceas bypassed org creation, generalized.
4. **The per-request check we need is app-owned regardless** (tceas's `findMemberRole` pattern). Rolling our own removes the redundant second checker and the upgrade-sync burden.
5. **Multi-shop membership is just rows** in our table; `listShops(userId)` is one query. No `activeOrganizationId`, no org switcher machinery — tceas itself made org switching pure navigation with "no server call, no D1 write" (`refs/tceas/src/routes/app.$organizationId.tsx:106-137`).

What we give up: invitation lifecycle endpoints (pending/resend/cancel — small to hand-roll, and tceas never finished accept anyway), `getFullOrganization`/`listOrganizations` (trivial queries), stock role plumbing (we own a `role` column with an FK enum table, tceas convention `refs/tceas/migrations/0001_init.sql:6-8`).

What we keep from Better Auth: the hard parts — `user`/`session`/`account`/`verification` core, magic-link token issuance/consumption (single-use, hashed at rest, 5-min TTL), cookie/session management with cookie cache, and the **`admin` plugin** (listUsers, ban, revoke sessions, impersonate — tceas wires these into its operator console; ours could later).

### Recommendation

**Skip `organization`. Plugins: `magicLink` + `admin` + `tanstackStartCookies` (last).** Own tables, written via Effect SQL atomic batches:

```sql
create table Member (
  id text primary key,
  userId text not null references User (id) on delete cascade,
  shop text not null references ShopSession (shop) on delete cascade,
  role text not null references MemberRole (role) default 'member',
  createdAt text not null,
  unique (userId, shop)
);
```

FKs decided: let the database own referential integrity. `on delete cascade` from `ShopSession` means uninstall's row delete tears down that shop's memberships automatically; cascade from `User` covers admin-plugin user removal. No invitation table (no accept step — decided).

Fallback position if this proves wrong: the org plugin can be added later; its tables are additive and our `Member` data would map 1:1 onto `member`.

## tceas patterns to adopt

- **Server-fn-first, no auth client.** tceas has zero `createAuthClient` usage; all ops are server fns over an Effect `Auth` service, "no duplicate client-side auth state, one validation pipeline, no extra bundle" (`refs/tceas/docs/better-auth-integration.md:318-320`). Matches Baton's existing `runEffect` idiom.
- **Catch-all with allowlist** (`refs/tceas/src/routes/api/auth/$.tsx:13-31`): only `GET /api/auth/magic-link/verify` (the link a browser follows) is public; every other better-auth HTTP route 404s. Sign-in request itself goes through a server fn calling `auth.api.signInMagicLink`. Strong posture, adopt verbatim.
- **Effect seams**: `Auth` as `Layer.effect` per request; `makeRunPromise` snapshots the request context so better-auth callbacks (`sendMagicLink`, `databaseHooks`) run inside Effect with this request's services/logger (`refs/tceas/src/lib/LayerEx.ts:122-123`, consumed `refs/tceas/src/lib/Auth.ts:53`). Every call wrapped `Effect.fn("Auth.<op>")` + `AuthError` tagged error. Session output validated once through domain `Schema` (`refs/tceas/src/lib/Auth.ts:48-50`).
- **Redirect-on-failure-channel caveat** carried over: `Effect.fail(redirect(...))` means a stray `catchAll`/`retry` can eat redirects (`refs/tceas/src/worker.ts:96-99`). Baton already uses `ResponseError` for this — keep Baton's convention.
- **PascalCase `modelName` mapping** (`User`, `Session`…) — collision with Baton's existing D1 `Session` table (Shopify sessions). **Decided: rename Shopify's → `ShopSession`** (migration + touches in `Repository`, `Domain.ts`, `Shopify.ts`); better-auth keeps clean PascalCase `User`/`Session`/`Account`/`Verification`.
- **First-admin bootstrap** via `ADMIN_EMAILS` in `user.create.before` (`refs/tceas/src/lib/Auth.ts:97-107`) — optional for Baton; our `/admin` password console already exists.

## D1 primary vs read-replica ("SqlPrimary/SqlSession" → `D1Primary`/`D1Session`)

tceas splits two app-owned service tags, both holding a `D1Client`; the library `SqlClient` tag is deliberately never provided "so every call site must name which database path it runs on" (`refs/tceas/src/lib/D1Session.ts:14-20`):

- `D1Primary` (`refs/tceas/src/lib/D1Primary.ts:19-29`): raw `env.D1` binding — always primary, never stale; writes bypass the session so they don't advance the bookmark ("pair them with primary reads, not session reads").
- `D1Session` (`refs/tceas/src/lib/D1Session.ts:27-35`): per-request `env.D1.withSession(bookmark)` — replica-tolerant reads.
- Choice is per `Repository` method with the reason inline: replica-tolerant (`findMemberRole` — "a just-revoked membership may linger for replica-lag seconds", `:166`) vs correctness-sensitive (`findOwnedOrganizationId` — "a stale-replica miss would trigger a duplicate create attempt", `:194`; all writes).
- **better-auth gets raw `env.D1`**, not the session wrapper (`refs/tceas/src/lib/Auth.ts:68-74`): `D1DatabaseSession` lacks `exec` so duck-typing fails, "and sessionless queries route to the primary, which is exactly what auth wants (a stale-replica session lookup right after sign-in would be a bug, not a latency win)."

Baton today: single session-wrapped client (`src/worker.ts:170-176`) + bookmark threading already in place (`src/start.ts:7-13`, `src/router.tsx:52-62`, `src/lib/D1Bookmark.ts`) — same 4-hop pattern as tceas, including the monotonic-advance sentinel guard (`refs/tceas/src/lib/d1BookmarkStore.ts:39-49`). **Adopt the split**: introduce `D1Primary` alongside; membership writes + auth on primary, member-area reads on session. This makes sense for us.

## Email, demo mode, testing (adopt all three)

- **Cloudflare Email Sending** native `send_email` binding — no SES/Resend/API key. `refs/tceas/wrangler.jsonc:56-61`; `Email` service wraps `binding.send(...)` with `EmailError` carrying CF's string codes (`refs/tceas/src/lib/Email.ts:17-84`). Local dev: miniflare writes simulated emails to `.wrangler/tmp/email/**`; body echoed into log annotations only when `ENVIRONMENT === "local"` (gated on a wrangler var, deliberately not on the `DEMO_MODE` secret). Onboard `mail.mw10013.com` subdomain (avoids root DMARC issues; ~3k emails/mo included — `refs/tceas/docs/cloudflare-email-service-research.md`).
- **KV demo mode**: exactly one key shape, `demo:magicLink:${email}` → full clickable URL, TTL = token TTL (300s) (`refs/tceas/src/lib/Auth.ts:26,146-158`). Real mode skips the KV write entirely so the URL is never persisted. Demo mode changes *delivery only* — the token flow runs unchanged; login UI renders the link (`refs/tceas/src/routes/login.tsx:41-63`). Per-email key so concurrent tests don't clobber.
- **Tests**: integration tests read the URL from KV and feed it to `auth.handler(new Request(url, { redirect: "manual" }))`, harvesting cookies (`refs/tceas/test/integration/auth.test.ts:42-63`; `DEMO_MODE: "true"` bound in miniflare). E2E auto-detects: demo link visible → click it, else scrape `.wrangler/tmp/email/*/email-text/*.txt` by mtime (`refs/tceas/e2e/auth.ts:30-68`). `pnpm magic-link` script prints/opens newest simulated link. Seed/reset as one primitive behind `POST /api/e2e/seed`, 404 outside local.
- Rate-limit the sign-in server fn like `/admin/login` (`env.ADMIN_LOGIN_LIMITER` pattern, `src/routes/admin.login.tsx:33-40`); note tceas turns better-auth's own `rateLimit` off (in-memory, meaningless across isolates).

## Login flow from the homepage; multi-shop

1. `/` gets a "Log in" button (tceas: header sign-in → `/login`, `refs/tceas/src/routes/index.tsx:28-45`). Public homepage keeps its app-marketing role — that's fine; one button.
2. `/login`: email form → server fn → `auth.api.signInMagicLink` → "Check your email" (demo mode: renders link). Invite-only gate runs *before* send: reject emails with no `Member` row (+ `databaseHooks.user.create.before` returning `false` as authoritative backstop covering all paths — `concepts/database.mdx:855`).
3. Link → `GET /api/auth/magic-link/verify` (sole public auth route) → cookie → redirect `/login-callback`.
4. `/login-callback` (invisible on success, tceas `refs/tceas/src/routes/login-callback.tsx:29-56`): query `Member` rows for user → **one shop → straight to `/work/$shop`; several → shop picker**. No active-shop session state; shop is URL state from here on. Multiple tabs on different shops just works.
5. Guard on `/work/$shop/*`: `beforeLoad` + `memberServerFnMiddleware` (mirroring `src/lib/AdminServerFnMiddleware.ts:7-17`): `getSession` → `findMemberRole(userId, shop)` against the URL param → inject `{ user, shop, role, runEffect }`. This is tceas's two-layer posture minus the redundant plugin layer.
6. Shop switcher for multi-shop users = plain navigation (dropdown listing their `Member` shops), zero server state — tceas precedent.
7. Data access: after the member check, talk to `env.SHOP_AGENT.getByName(shop)` same as embedded. For WebSockets, tceas authorizes **in the Worker before the DO wakes**, cookie-based, membership checked once per connection (`refs/tceas/src/worker.ts:245-277`) — Baton's existing `authorizeShopAgentRequest` (`src/worker.ts:306-354`) does the same with Shopify tokens; member connections add a cookie-session branch there.

Owner: same flow, same table — a `Member` row with `role='owner'` on their shop, **self-added** in the embedded app's member list (decided; no install-time auto-provisioning, no Admin-API owner-email fetch). The email they add is the one they'll log in with — may differ from their Shopify account email, which is a feature.

Member management stays in the **embedded app** (owner is already authenticated there); server fns behind `shopifyServerFnMiddleware` insert/delete `Member` rows directly (atomic batch). **No accept step** (decided): adding an email is the grant; the person's first magic-link login proves email ownership and that's acceptance. Revoke = delete the row. If "has this person ever logged in?" matters later, derive it (`User` row exists / session history) rather than tracking invitation status.

## Tenant lifecycle: uninstall teardown

Conceptually settled: `ShopSession` **is** the tenant. The teardown seam already exists and is well-built: `/webhooks/app/uninstalled` (`src/routes/webhooks.app.uninstalled.ts:35-51`) does `shopify.deleteSessionByShop(shop)` (deliberately unconditional — replica-lag-safe, retry-idempotent, see its JSDoc) + `destroyShopAgent(shop)` (`deleteAll()` so storage stops billing; destroy errors propagate so Shopify retries). Member auth adds nothing to this handler: the `Member` cascade rides the existing session delete via FK.

1. Delete the `ShopSession` row → `Member` rows cascade (FK). Better-auth `User` rows persist — inert by design: the sign-in gate checks `Member` rows, so a user with zero memberships can't get a magic link, and `disableSignUp` blocks re-creation paths. A user with memberships in *other* shops keeps those untouched — this is why multi-shop membership and cascade play nicely.
2. Destroy the ShopAgent DO. Rehydration guard: see below.
3. Reinstall = fresh start: new ShopSession row, empty DO, owner re-adds members. No "magic re-linkup" — with multi-shop users and cascaded rows there's nothing safe to resurrect, and re-adding emails is cheap.

### DO deletion guard — recommendation

**A destroyed DO cannot be prevented from rehydrating** — any later `getByName(shop)` wakes a fresh, empty object whose constructor re-runs migrations. A tombstone inside the DO is impossible (`deleteAll()` would wipe it; a rehydrated DO is indistinguishable from a never-created one). So "stays deleted" cannot be a DO-side property; it must be an *edge* property: **no user-facing path may address a DO for a shop without first proving a D1 row exists.** Concretely:

- **WebSocket path — already guarded.** `authorizeShopAgentRequest` (`src/worker.ts:306-354`) resolves session + plan *before* the DO wakes; post-uninstall there's no ShopSession row → 401/403, DO never touched. Member-area sockets add a cookie-session branch there: better-auth `getSession` + `Member` row for the URL shop.
- **Embedded server fns — already guarded transitively.** Everything behind `shopifyServerFnMiddleware` re-runs `authenticateAdmin`, which needs the D1 session/token exchange; post-uninstall it fails before any `ShopAgentClient` call.
- **Member-area server fns — guarded by construction.** `memberServerFnMiddleware` asserts the `Member` row, whose FK to `ShopSession` makes membership itself proof of install. No extra check needed.
- **Operator console (`/admin/*`) — deliberately unguarded.** Inspecting is how orphans are found; note that `getAdminSnapshot` on a destroyed shop *revives* it as an empty orphan — accept this, the orphan console (`/admin/orphan-shop-agent-objects`) is the janitor.
- **Residual leak, accepted:** a request authenticated pre-uninstall racing the webhook can revive an empty DO after `destroyShopAgent`. Cost is one empty DO (pennies), visible in the orphan console, deletable there. Not a correctness issue — no user path can reach it afterward.

**Do not** add a per-wake D1 existence check inside the ShopAgent constructor for now (self-healing "no ShopSession → deleteAll + abort"). It would cost a D1 read on every cold start, insta-kill orphans the operator console is trying to inspect, and defends only the raced-revival case above, which is already benign. Revisit only if orphan volume ever becomes real.

## Site admin on better-auth (phase 2)

Decided: once member auth lands, `/admin` moves onto the same machinery and `AdminAuth` (password + sealed cookie, `src/lib/AdminAuth.ts`) is retired, along with `ADMIN_PASSWORD`/`ADMIN_PASSWORD1`/`ADMIN_AUTH_SECRET` and their rotation dance. tceas is the template:

- `ADMIN_EMAILS` config + `databaseHooks.user.create.before` assigns `role: "admin"` at first sign-in (`refs/tceas/src/lib/Auth.ts:97-107`).
- `/admin` guard checks `User.role === "admin"`; admin is cross-tenant and owns no memberships by invariant; the `/shop` and `/admin` guards admit disjoint roles so they can't redirect-loop (`refs/tceas/src/routes/admin.tsx:24-30`).
- Admin plugin ops become available for the console: `listUsers`, ban, revoke sessions, impersonate (tceas wires an `ImpersonationBanner` when `session.impersonatedBy` is set).
- Trade-off accepted: admin access now depends on email delivery; local dev uses demo mode/simulated email files, and worst-case break-glass is `wrangler d1 execute` on the primary.

Sign-in gate composition changes slightly: allowed = email has a `Member` row **or** is in `ADMIN_EMAILS`.

## Audit trail — deferred, with a lean

Deferred (decided direction, not built). When it comes: per-shop **work activity** (job state changes with actor + timestamp — which the spike already requires) lives in **ShopAgent SQLite**; that activity log *is* the audit seed, no separate machinery. Cross-shop **auth events** (sign-ins, member add/remove) would belong in D1 if ever needed — a member's login isn't shop-scoped, so the DO is the wrong home for it. Don't build either until a screen needs it.

## Migrations + drift protection

- **Hand-write the migration** (`migrations/0002_*.sql`), like tceas (`refs/tceas/migrations/0001_init.sql`, header: "Hand-written against the runtime schema definitions (`getAuthTables`) rather than `@better-auth/cli` output"). The CLI can't reach D1; better-auth's runtime `getMigrations` fails on D1 anyway (`pragma_index_list` with dynamic arg → `SQLITE_AUTH`, `refs/tceas/test/integration/auth.test.ts:88-98`).
- **Adopt the drift test**: `getSchema(auth.options)` (pure, DB-free) diffed against live D1 via constant-argument pragmas (`refs/tceas/test/integration/auth.test.ts:87-157`). This is the guard rail that makes hand-written migrations safe across better-auth upgrades.
- Conventions: dates ISO-8601 `text`, booleans `0/1`, FK enum lookup tables instead of check constraints (D1 can't alter checks without table rebuild).

## Workers/operational notes

- `nodejs_compat` required (AsyncLocalStorage) — already set (`wrangler.jsonc:6`).
- Dual-module hazard: "No request state found…" from duplicated `better-auth`/`@better-auth/core` (`reference/faq.mdx:130`) — `pnpm why @better-auth/core` if seen.
- Set `baseURL` explicitly (`BETTER_AUTH_URL`); tceas reads IP from `cf-connecting-ip`.
- `advanced.backgroundTasks.handler: waitUntil` defers email send past response.
- Cookie cache (`session.cookieCache`) for `getSession` latency; skip `secondaryStorage` (no KV story; KV eventually consistent).
- Magic-link verify for a never-verified account removes passwords/revokes sessions (email ownership wins) — harmless here (magic-link-only).

## Open questions

All prior open questions resolved (terminology = member; rename starts soon, see `docs/session-to-shopsession-rename-research.md`; DO guard = edge checks, recommendation above; `mail.mw10013.com` already onboarded). Remaining are implementation-time choices flagged inline: exact member-area label copy, whether `ADMIN_LOGIN_LIMITER` is reused or a second ratelimit binding added for magic-link sends.

## Explicitly not now (spike discipline)

Roles beyond the column existing, invitation lifecycle UI, account recovery/MFA, departments/assignments, workflow engine, Shopify write-backs. Dropped spike constraint: single-shop membership — `Member (userId, shop)` makes multi-shop the default; constraining would be artificial.
