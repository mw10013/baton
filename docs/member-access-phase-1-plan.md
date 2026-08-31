# Member access — phase 1 plan

Execution plan for `docs/member-access-research.md` (all decisions live there; this doc is order + touchpoints). Prototyping stance: edit `migrations/0001_init.sql` in place, `pnpm d1:reset`, no migration sequence.

## Milestones

- **A — Members manageable from the embedded app.** Testable with existing Shopify auth; no better-auth login needed yet. First visible win.
- **B — Magic-link login works locally** (demo mode, no real email).
- **C — Member area live**: `/shop` list + guarded `/shop/$shop` shop page.

## Steps

### 1. Schema + member CRUD (milestone A)

**Done.** No roles (dropped — membership is binary, see research decisions); better-auth core tables deferred to step 3 where the auth config exists to derive them from.

- `migrations/0001_init.sql`: `Member` (email-keyed, `unique (shop, email)`, FK `shop → ShopSession on delete cascade`, `check (email = lower(trim(email)))`). Conventions: ISO-8601 `text` dates, `0/1` booleans.
- `Repository`: `listMembers(shop)`, `addMember({ shop, email })`, `deleteMember({ shop, email })`, `findMember({ shop, email })`, `listMemberShops(email)`.
- `Domain.Email` decodes with trim + lowercase — normalization is structural, every boundary decodes through it.
- Embedded members screen `src/routes/app.members.tsx`: list / add-by-email / remove, server fns behind `shopifyServerFnMiddleware`. Owner self-adds their own email.

### 2. Infra (wrangler.jsonc)

- KV namespace binding (demo-mode magic links, key `demo:magicLink:${email}`, TTL 300s).
- `send_email` binding, `allowed_sender_addresses: ["noreply@mail.mw10013.com"]` (domain already onboarded at account level).
- `LOGIN_LIMITER` ratelimit binding beside `ADMIN_LOGIN_LIMITER` (which retires in phase 2).
- Vars: `BETTER_AUTH_URL` per env (`ENVIRONMENT` already exists). Secrets: `BETTER_AUTH_SECRET`, `DEMO_MODE` (local `.dev.vars`).
- Typecheck regenerates `worker-configuration.d.ts`.

### 3. Auth foundation (milestone B)

- `src/lib/Auth.ts`: Effect `Layer.effect` per request wrapping `betterAuth` — core + `magicLink` + `admin` + `tanstackStartCookies` (last). Raw `env.D1` (not the session wrapper). `disableSignUp` paths blocked; sign-in gate = `Member` row exists for email, backstopped by `databaseHooks.user.create.before` returning `false`. `makeRunPromise` seam for callbacks (tceas `refs/tceas/src/lib/LayerEx.ts:122-123`). Wrap ops `Effect.fn("Auth.<op>")` + tagged `AuthError`.
- `src/lib/Email.ts`: wrap `send_email` binding, `EmailError` with CF codes; local dev body echoed to log annotations only when `ENVIRONMENT === "local"`.
- `sendMagicLink`: real mode → Email service; demo mode → KV write only (URL never persisted in real mode). Deferred via `waitUntil` (`advanced.backgroundTasks`).
- `D1Primary`/`D1Session` split (tceas `refs/tceas/src/lib/D1Primary.ts`, `D1Session.ts`): auth + membership writes on primary, member-area reads on session; never provide the bare `SqlClient` tag.
- Catch-all `src/routes/api.auth.$.tsx` with allowlist: only `GET /api/auth/magic-link/verify` public; everything else 404.
- `/login`: email form → server fn (`LOGIN_LIMITER` + invite gate) → `auth.api.signInMagicLink` → "Check your email" (demo mode renders the link).
- `/login-callback`: redirect to `/shop`.
- "Log in" button on `/`.

### 4. Member area (milestone C)

- `/shop`: `listShopsForEmail` for the session user; empty state for zero memberships.
- `/shop/$shop/*`: `beforeLoad` guard + `memberServerFnMiddleware` (mirror `src/lib/AdminServerFnMiddleware.ts`) — `getSession` → `findMember(email, shop)` vs URL param → inject `{ user, shop, runEffect }`.
- `/shop/$shop` page: shop name header + basic shop info via `env.SHOP_AGENT.getByName(shop)`. Proof of access; workflow screens later.

### 5. Tests

- Schema drift test: `getSchema(auth.options)` diffed against live D1 via constant-argument pragmas (tceas `refs/tceas/test/integration/auth.test.ts:87-157`).
- Integration: read magic-link URL from KV, feed to `auth.handler(new Request(url, { redirect: "manual" }))`, harvest cookies.
- E2E: add member in embedded app → log in via demo link → land on `/shop` → open shop page.

## Deferred (phase 2+)

- `/admin` onto better-auth (`ADMIN_EMAILS` bootstrap, retire `AdminAuth` + `ADMIN_LOGIN_LIMITER`); sign-in gate becomes `Member` row **or** `ADMIN_EMAILS`.
- WebSocket cookie-session branch in `authorizeShopAgentRequest` — phase 1 member pages use server fns only.
- Invitation lifecycle UI, roles beyond the column, audit trail, workflow engine.
