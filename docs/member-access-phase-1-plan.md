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

**Done.** `KV` binding (`baton-kv-local`), `send_email` `EMAIL` binding, `LOGIN_LIMITER` (namespace_id 1002), `EMAIL_FROM` var. Local secrets live in `.env` (not `.dev.vars` — this repo uses `.env`, wrangler reads it when no `.dev.vars` exists): `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (placeholder, rotate before real deploy), `DEMO_MODE=true`.

### 3. Auth foundation (milestone B)

**Done.** Divergences from the notes below: `advanced.backgroundTasks`/`waitUntil` deliberately not set — better-auth awaits `sendMagicLink`, which is what makes the demo-mode KV read-back in `/login` race-free and makes an `EmailError` fail `signInMagicLink` loudly; better-auth core tables added to `migrations/0001_init.sql` (User/Session/Account/Verification + `UserRole` FK-enum, no organization tables, no `activeOrganizationId`).

- `src/lib/Auth.ts`: Effect `Layer.effect` per request wrapping `betterAuth` — core + `magicLink` + `admin` + `tanstackStartCookies` (last). Raw `env.D1` (not the session wrapper). `disableSignUp` paths blocked; sign-in gate = `Member` row exists for email, backstopped by `databaseHooks.user.create.before` returning `false`. `makeRunPromise` seam for callbacks (tceas `refs/tceas/src/lib/LayerEx.ts:122-123`). Wrap ops `Effect.fn("Auth.<op>")` + tagged `AuthError`.
- `src/lib/Email.ts`: wrap `send_email` binding, `EmailError` with CF codes; local dev body echoed to log annotations only when `ENVIRONMENT === "local"`.
- `sendMagicLink`: real mode → Email service; demo mode → KV write only (URL never persisted in real mode). Deferred via `waitUntil` (`advanced.backgroundTasks`).
- `D1Primary`/`D1Session` split (tceas `refs/tceas/src/lib/D1Primary.ts`, `D1Session.ts`): auth + membership writes on primary, member-area reads on session; never provide the bare `SqlClient` tag.
- Catch-all `src/routes/api.auth.$.tsx` with allowlist: only `GET /api/auth/magic-link/verify` public; everything else 404.
- `/login`: email form → server fn (`LOGIN_LIMITER` + invite gate) → `auth.api.signInMagicLink` → "Check your email" (demo mode renders the link).
- `/login-callback`: redirect to `/shop`.
- "Log in" button on `/`.

### 4. Member area (milestone C)

**Done.** `requireMember` responds `notFound` (not a redirect) so a non-member cannot distinguish "shop exists" from "no such shop". `/shop` also carries a sign-out button.

- `/shop`: `listShopsForEmail` for the session user; empty state for zero memberships.
- `/shop/$shop/*`: `beforeLoad` guard + `memberServerFnMiddleware` (mirror `src/lib/AdminServerFnMiddleware.ts`) — `getSession` → `findMember(email, shop)` vs URL param → inject `{ user, shop, runEffect }`.
- `/shop/$shop` page: shop name header + basic shop info via `env.SHOP_AGENT.getByName(shop)`. Proof of access; workflow screens later.

### 5. Tests

- Schema drift test: `getSchema(auth.options)` diffed against live D1 via constant-argument pragmas (tceas `refs/tceas/test/integration/auth.test.ts:87-157`). **Done** (`test/integration/auth.test.ts`).
- Integration: read magic-link URL from KV, feed to `auth.handler(new Request(url, { redirect: "manual" }))`, harvest cookies. **Done** — plus non-member sign-up-blocked backstop and invalid-token tests.
- E2E: add member in embedded app → log in via demo link → land on `/shop` → open shop page. **Not written**: `e2e/shopify-admin.setup.ts` shells out to `scripts/refresh-shopify-playwright-auth.ts`, which does not exist in this repo, so embedded-admin e2e cannot bootstrap. Login → `/shop` → `/shop/$shop` was verified manually headed (playwright-cli) instead; `/shop/$shop`'s `getShopInfo` verified up to `OfflineSessionInvalidError` against a seeded fake token — the happy path needs a real install.

## Deferred (phase 2+)

- `/admin` onto better-auth (`ADMIN_EMAILS` bootstrap, retire `AdminAuth` + `ADMIN_LOGIN_LIMITER`); sign-in gate becomes `Member` row **or** `ADMIN_EMAILS`.
- WebSocket cookie-session branch in `authorizeShopAgentRequest` — phase 1 member pages use server fns only.
- Invitation lifecycle UI, roles beyond the column, audit trail, workflow engine.
