# Member access (non-Shopify users) — research

Research only, not a spec. Figures out how people who are **not** the shop owner get at a shop's Baton data. `docs/Baton — Development Spike.md` is rough guidance here; it deliberately punts multi-shop membership, but we diverge on that one point because the schema we'd pick (Better Auth's organization plugin) gives multi-shop membership for free and hand-rolling a single-shop schema would need a migration later anyway.

All Better Auth references are the vendored checkout `refs/better-auth` (v1.7.2, matching the `better-auth@1.7.2` already in `package.json` — currently zero imports in `src/`). Doc paths below are relative to `refs/better-auth/docs/content/docs/`.

## TL;DR — recommended shape

- **Fourth surface**: a member portal (working name `/portal`) beside the three existing surfaces. Members sign in with **email magic links via Better Auth**; no Shopify identity involved.
- **Terminology: "member"** — matches Better Auth's organization plugin table name literally, and reads correctly for the domain.
- **Tenancy: organization = shop, 1:1.** Better Auth's `member` join table (`userId`, `organizationId`, `role`) natively models one user in many shops, and a shop owner being a member of someone else's shop — because the Shopify (embedded) identity and the Baton (Better Auth) identity are completely disjoint systems. No linkage needed.
- **Identity/membership lives in D1**, not the ShopAgent DO. "Which shops can this email see?" is a cross-shop query; a per-shop DO cannot answer it. Per-shop workflow state stays in the DO as today.
- **Invite-only**: no open sign-up. Compose `magicLink({ disableSignUp: true })` + a global before hook on `/sign-in/magic-link` + `databaseHooks.user.create.before` as backstop.
- **Owner configures members from the embedded app** via server fns that call `auth.api.*` server-side — the owner never has a Better Auth session and doesn't need one.

## Surfaces (today + proposed)

| Surface | Routes | Who | Auth |
| --- | --- | --- | --- |
| Public | `/`, `/privacy` (help later) | anyone | none |
| Embedded app | `/app/*` | shop owner/staff inside Shopify admin | session token → token exchange (`src/lib/Shopify.ts:1281`), guarded 3 ways: worker preflight `src/worker.ts:235-243`, route `beforeLoad` `src/routes/app.tsx:146-149`, `shopifyServerFnMiddleware` |
| Operator console | `/admin/*` | us | password + sealed cookie (`src/lib/AdminAuth.ts`), stays as-is |
| **Member portal (new)** | `/portal/*` (name TBD) | invited members, no Shopify login | Better Auth magic link |

The existing worker seam already dispatches by path prefix (`src/worker.ts`), so a fourth prefix is mechanical. Better Auth's HTTP handler mounts as one catch-all route (`integrations/tanstack.mdx`):

```ts
// src/routes/api.auth.$.ts
createFileRoute("/api/auth/$")({ server: { handlers: { GET: ({ request }) => auth.handler(request), POST: ... } } })
```

## Identity model

Better Auth core tables (`concepts/database.mdx`): `user`, `session`, `account`, `verification`. Organization plugin (`plugins/organization.mdx`) adds:

- `organization` — `id`, `name`, `slug` (unique), `metadata`. **Map 1:1 to a shop**; candidate: `slug` = shop domain, or an `additionalFields` `shop` column referencing `Session.shop`.
- `member` — `id`, `userId`, `organizationId`, `role`. The multi-shop permutations the spike worried about are just rows here.
- `invitation` — `email`, `inviterId`, `organizationId`, `role`, `status`, `expiresAt` (default expiry 48h).
- `session.activeOrganizationId` — optional; see tenancy below.

Roles: built-in `owner`/`admin`/`member`, comma-separated multi-role strings, custom roles via `createAccessControl` from `better-auth/plugins/access`. **Don't design roles now** — everyone is `member`; the column existing is enough.

Owner-of-shop-A who is member-of-shop-B: shop A's owner uses `/app` (Shopify identity); to see shop B they get invited by B's owner like anyone else and use `/portal` with their email. Two unrelated identities, zero special-casing. Whether an owner also wants a portal identity for *their own* shop is an open question (probably yes eventually, trivially done by inviting themselves).

## Where the data lives: D1

- Membership is inherently cross-shop ("list my shops" on portal login). ShopAgent DOs are addressed by shop domain (`src/lib/ShopAgent.ts:180`, `env.SHOP_AGENT.getByName(shop)`) — no DO can enumerate across shops. D1 is the shared relational store and already holds the cross-shop `Session` table (`migrations/0001_init.sql`).
- Better Auth has a **built-in D1 dialect** — `packages/kysely-adapter/src/d1-sqlite-dialect.ts`; `database: env.D1` is auto-detected as `D1Database` (`dialect.ts:51`). No drizzle/kysely dependency in our app code; Better Auth's Kysely stays internal to it, our Effect SQL (`@effect/sql-d1`) untouched.
- Caveat baked into the adapter: `// D1 has no interactive transactions; only its batch() API.` → multi-row ops (accept-invitation creating a member) run non-atomically. Acceptable for exploration.
- **Migrations**: `npx auth@latest generate` (CLI was renamed from `@better-auth/cli`; it stubs `cloudflare:workers` so an `auth.ts` importing `env` still loads — `concepts/cli.mdx:174`) emits raw SQL for the Kysely/D1 adapter. Drop that into `migrations/0002_*.sql` and keep `wrangler d1 migrations apply` as the single migration path — no need for the runtime `getMigrations` endpoint the docs suggest for D1.
- Per-shop workflow data (jobs, activity) stays in the ShopAgent DO. A portal request resolves membership in D1, then talks to the shop's DO exactly like the embedded app does.

## Sign-in flow (magic link)

Plugin: `plugins/magic-link.mdx`; source `packages/better-auth/src/plugins/magic-link/index.ts`.

- `POST /sign-in/magic-link` `{ email, callbackURL }` → writes a `verification` row, calls **our** `sendMagicLink({ email, url, token })` — email transport is entirely delegated (open question below). Token default 5 min expiry, single-use, `storeToken: "hashed"` available.
- `GET /magic-link/verify?token=…` → consumes token, sets session cookie, redirects.
- Session: cookie + `session` table, 7d expiry / 1d sliding refresh (`concepts/session-management.mdx`). **Cookie cache** (`session.cookieCache`, signed `session_data` cookie) skips the D1 read on `getSession` — the latency win on Workers; skip `secondaryStorage` entirely (no KV story in the docs, and KV's eventual consistency is a poor session fit).

Invite-only gating (no turnkey flag, three composable points):

1. `magicLink({ disableSignUp: true })` — verify-time block, redirects `?error=new_user_signup_disabled`.
2. Global before hook on `ctx.path === "/sign-in/magic-link"` checking the email against `member`/`invitation` rows (`concepts/hooks.mdx` — the doc's own example is this shape). Rejects before any email is sent → no enumeration, no wasted sends.
3. `databaseHooks.user.create.before` returning `false`/throwing `APIError` — authoritative backstop covering every sign-up path (`concepts/database.mdx:855`).

Rate-limit the send endpoint like `/admin/login` does (`env.ADMIN_LOGIN_LIMITER`, `src/routes/admin.login.tsx:33-40`) — a second ratelimit binding in `wrangler.jsonc`.

## Owner configures members from the embedded app

Wrinkle: the org plugin's invitation **endpoints** assume the caller has a Better Auth session with permission. The shop owner has none. Resolution: the embedded app's server fns (behind `shopifyServerFnMiddleware`, so shop identity is already proven) call the **server API** directly — `auth.api.addMember` / `auth.api.createInvitation` work server-side, and `organizationHooks` (`beforeAddMember`, `afterAcceptInvitation`, …) provide seams. Two candidate flows to prototype:

- **A. Direct add**: server fn creates user (if absent) + `addMember`; member just signs in via magic link. Simplest; `invitation` table unused.
- **B. Real invitations**: server fn `createInvitation` with our `sendInvitationEmail`; member accepts after signing in. More moving parts (accept requires a session whose email matches) but gives pending/revoke states in the UI.

Start with A for the proof of concept; B is additive.

## Portal tenancy per request

Every portal request must resolve to a shop before touching data (spike doc's one hard security requirement). Two mechanisms:

- **Path-scoped (recommended)**: `/portal/$shop/...`; a `memberServerFnMiddleware` (mirroring `adminServerFnMiddleware`, `src/lib/AdminServerFnMiddleware.ts:7-17`) does `getSession` → assert a `member` row for `(userId, orgForShop)` → inject `{ user, shop, runEffect }`. URL is shareable, multiple shops open in tabs works.
- `session.activeOrganizationId` + `organization/set-active`: stateful; docs themselves note client-side-only active org is fine and multi-tab-safe. Skip for now.

Better Auth is promise-based; wrap it as an Effect service (`Context.Service` + `Effect.tryPromise`, same shape as `AdminAuth`) so handlers keep the `runEffect(Effect.gen(...))` idiom (`src/routes/app.index.tsx:35-57` as the template). Add `tanstackStartCookies()` as the **last** plugin only if we call `auth.api.*` from server fns that must set cookies (`integrations/tanstack.mdx`) — sign-in itself goes through the catch-all handler, which needs nothing.

## Workers/operational notes

- `nodejs_compat` is required (AsyncLocalStorage, `installation.mdx:325`) — **already set** (`wrangler.jsonc:6`).
- Known papercut: "No request state found…" from a duplicated `better-auth`/`@better-auth/core` install (`reference/faq.mdx:130`) — check `pnpm why @better-auth/core` if it appears.
- Set `baseURL` explicitly + `trustedOrigins`; request inference is discouraged (`reference/options.mdx:21-130`). Interacts with the tunnel/localhost dev split (`pnpm port`).
- `advanced.backgroundTasks.handler: waitUntil` (from `cloudflare:workers`) defers the magic-link email send past the response (`reference/options.mdx:698`).
- `advanced: { database: { joins: true } }` — claimed 2-3x on `/get-session`, our hot path.
- Magic-link verify for a never-verified account **removes existing passwords and revokes sessions** (email ownership wins) — harmless for us (magic-link-only) but worth knowing.

## Open questions (decide before/while building)

1. **Portal naming** — `/portal`? `/work`? Affects nothing structural.
2. **Email transport** for magic links/invites (Resend? SES?). Dev can log the URL to `logs/server.log` and skip a provider entirely.
3. **Org creation timing** — create the `organization` row at app install (`storeSession`, `src/lib/Shopify.ts:512`) vs lazily at first invite. Lazy is less coupling; install-time gives an invariant (every shop has an org).
4. **Org↔shop linkage field** — `slug` = shop domain vs `additionalFields.shop`. Slug is built-in/unique but shows in URLs if we ever use org slugs.
5. **Uninstall cleanup** — `/webhooks/app/uninstalled` currently touches `Session`; should it also drop/disable the org + members?
6. Does the owner get a portal identity for their own shop (self-invite)? Not needed for the PoC.

## Explicitly not now (spike discipline)

Roles/permissions beyond the `role` column existing, account recovery, MFA, departments/assignments, workflow engine, Shopify write-backs, revocation UX beyond deleting a `member` row. The only spike constraint we drop is "do not design multi-shop worker accounts" — the org plugin's `member` table makes multi-shop the default, and constraining to one shop would be artificial work.
