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

**Done.** Integration + e2e, both green.

**Integration** (`pnpm test:integration`, 84 tests):

- Schema drift: `getSchema(auth.options)` diffed against live D1 via constant-argument pragmas (tceas `refs/tceas/test/integration/auth.test.ts:87-157`). `test/integration/auth.test.ts`.
- Auth service round trip: magic-link URL out of KV, fed to `auth.handler`, cookies harvested — plus the non-member sign-up-blocked backstop and invalid-token cases. `test/integration/auth.test.ts`.
- Whole-flow HTTP through `workerExports.default.fetch` (real worker, real routes, real middleware). `test/integration/member-area.test.ts`: `/api/auth/$` allowlist (verify serves, everything else 404s); anonymous `GET /shop` → 307 `/login`; magic link → `/shop` lists the member's shops; non-member shop → 404; `deleteMember` flips the member's own shop page 500 → 404 and drops it from `/shop`; `/login-callback` → 307 `/shop`, failure state for `?error=`.
- The `/shop/$shop` happy path is unreachable here: `getShopInfo` runs in the ShopAgent DO's own isolate, out of reach of the in-process Shopify fetch stub, so a seeded shop tops out at 500 (the revocation test uses that 500 as proof the membership gate was passed). The e2e covers it against the real install instead.

**E2E** (`pnpm test:e2e`, 7 tests incl. setup). Unblocked by copying `scripts/refresh-shopify-playwright-auth.ts` from `refs/bang` (decrypts the logged-in admin session out of Chrome's cookie DB via Keychain) and writing `.env.playwright`.

- `src/routes/api.e2e.seed.ts` — one fixture endpoint, bang's shape: `POST {shop, members}` replaces the shop's membership with exactly `members` and drops each listed email's better-auth identity, so every run is a first sign-in and a retry starts clean. `ENVIRONMENT === "local"` only. Deliberately does not seed `ShopSession`, so seeding a shop the app is not installed on fails loudly instead of surfacing as a `/shop/$shop` 500.
- Two Playwright projects, not one. `e2e` (admin storage state, tunnel) runs `home.spec.ts` + `members.spec.ts`. `member` (empty storage state, `http://localhost:$PORT`, no `setup` dependency, so no Keychain prompt) runs `member-area.member.spec.ts` — the member area is the one non-embedded surface, and `BETTER_AUTH_URL` mints links against localhost, never the tunnel.
- `members.spec.ts`: empty state → add a padded, mixed-case address → row comes back trimmed and lowercased (proof `Domain.Email` normalizes structurally) → re-add is idempotent → remove returns the empty state.
- `member-area.member.spec.ts`: anonymous `/shop` → `/login`; a non-member gets the identical "check your email" panel with no link (no member enumeration); a seeded member follows the demo link → `/shop` → `/shop/$shop` **against the real install, so `getShopInfo` renders for real** → sign out → `/shop` bounces again; revoking mid-session closes the shop page on the next request while the cookie is still valid.
- `data-hydrated` added to `src/routes/__root.tsx`, and `e2e/member.ts` mirrors `e2e/app.ts` as the non-embedded helper module (`gotoMember` / `awaitHydration` / `followMagicLink`). Until React attaches, SSR'd markup is painted and React-dead: `onClick` buttons are no-ops and the login form falls through to a native GET `/login?email=...`, while Playwright's actionability checks pass. Fixed on the product side with `disabled={!hydrated}` on both member-area buttons; the embedded marker was renamed `data-app-interactive` to distinguish it from `data-hydrated`. Rationale lives in the JSDoc on `__root.tsx`, `app.tsx`, and `e2e/member.ts`.

## Deferred (phase 2+)

- `/admin` onto better-auth: research + recommendation in `docs/admin-on-better-auth-research.md` (`ADMIN_EMAILS` allowlist stamps `role='admin'` at first sign-in; retire `AdminAuth`, `ADMIN_*` secrets, `ADMIN_LOGIN_LIMITER`; gate = `Member` row **or** `ADMIN_EMAILS`).
- WebSocket cookie-session branch in `authorizeShopAgentRequest` — explained in the same doc; stays deferred until a member page needs live DO state.
- Invitation lifecycle UI, roles beyond the column, audit trail, workflow engine — not planned.
- `wrangler.jsonc` `env.staging` / `env.production` skeleton blocks **added** (2026-09-01): `ENVIRONMENT` now narrows to `"local" | "staging" | "production"`, `--env staging` resolves, `api.e2e.seed.ts`'s guard is real. D1 ids, KV ids and `SHOPIFY_PARTNER_APP_ID` are placeholders until those envs exist.
