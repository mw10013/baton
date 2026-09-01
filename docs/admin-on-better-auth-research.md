# `/admin` onto better-auth — phase 2 research

**Implemented 2026-09-01** (touchpoints below all landed; 4 integration tests added). Research + recommendation for the first deferred item in `docs/member-access-phase-1-plan.md`. Prototyping stance: edit `migrations/0001_init.sql` in place if needed, `pnpm d1:reset`, no migration sequence. Also answers the "WebSocket cookie-session branch" question.

## What exists today

| Piece                                    | Where                                                             | Fate                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Password + sealed cookie                 | `src/lib/AdminAuth.ts` (`useSession`, `pwVersion`, 1h slide)      | delete                                                                           |
| `ADMIN_AUTH_SECRET/PASSWORD/PASSWORD1`   | `.env`, `.env.example`, `test/integration/vitest.config.ts:45-47` | delete; replace with `ADMIN_EMAILS`                                              |
| `ADMIN_LOGIN_LIMITER`                    | `wrangler.jsonc` (all three envs), `admin.login.tsx:33-40`        | delete (magic-link sends already go through `LOGIN_LIMITER` in `/login`)         |
| `/admin` guard                           | `src/routes/admin.tsx` `beforeLoad` → `AdminAuth.requireSession`  | rewrite: better-auth session + `user.role === "admin"`                           |
| `adminServerFnMiddleware`                | `src/lib/AdminServerFnMiddleware.ts`                              | rewrite same way (mirror `memberServerFnMiddleware` + role check)                |
| `/admin/login`                           | `src/routes/admin.login.tsx`                                      | delete — `/login` is the one login page                                          |
| `/admin/logout` POST route + hidden form | `src/routes/admin.logout.ts`, `admin.index.tsx:19-34`             | delete; sign-out server fn like `shop.index.tsx:30-37`                           |
| `AdminAuth.layer` in runtime             | `src/worker.ts:84`                                                | remove                                                                           |
| `User.role` + `UserRole` FK-enum         | `migrations/0001_init.sql`, `Domain.UserRole`                     | already there (`'user'`, `'admin'`), `admin()` plugin already wired in `Auth.ts` |

Nothing in `test/` or `e2e/` touches `AdminAuth` (only Shopify-admin auth tests). Schema needs no change.

## Decision 1: who is an admin — allowlist vs pre-populated DB

Options considered:

1. **`ADMIN_EMAILS` env allowlist, role stamped at first sign-in** (tceas, `refs/tceas/src/lib/Auth.ts:56-66,90-108`). `databaseHooks.user.create.before` returns `{ data: { ...user, role: "admin" } }` when the email matches; guard reads `user.role`.
2. **Pre-populate `User` rows** with `role='admin'` (in `0001_init.sql` or a seed script; better-auth's `npx auth create-admin` is the CLI form, `refs/better-auth/docs/content/docs/plugins/admin.mdx:73-79`). Magic-link verify on an existing email just signs it in, so a seeded row works without an `Account` row.
3. **`adminUserIds` plugin option** (`admin.mdx:797-807`). Needs user ids, which don't exist before first sign-in. Dead on arrival.
4. **Live allowlist at the guard** (`adminEmails.has(user.email)` per request, ignore `role`). Revocation is instant, but `auth.api.listUsers` / ban / impersonate check `User.role` in the DB, so the console would have a session the plugin refuses.

**Recommendation: option 1, exactly tceas's shape.** Reasons:

- Survives `pnpm d1:reset` (config, not data) — the whole prototyping loop depends on resetting freely. Option 2 puts a personal email in a migration file or adds a seed step to every reset.
- Per-env by construction: `.env` locally, `.env.staging` / `.env.production` via the existing `wrangler deploy --secrets-file` scripts. tceas keeps it out of `vars` so no admin email is ever committed (`refs/tceas/wrangler.jsonc:39-44`). Same here.
- `role` in the DB is what the `admin()` plugin reads, so listUsers/ban/impersonate become usable from the console later with zero extra plumbing.
- Already integration-tested in tceas (`refs/tceas/test/integration/auth.test.ts:182`); port the test.

Accepted trade-offs (all fine for a prototype):

- Role is stamped only at `User` **creation**. Adding an email to `ADMIN_EMAILS` after that person already signed in as a member does not promote them; removing an email does not demote. Fix is `wrangler d1 execute ... update User set role=...` or, while prototyping, `pnpm d1:reset`. If this bites, the cheap upgrade is a `databaseHooks.session.create.before` that re-syncs `role` from the allowlist on every sign-in — not worth it now.
- Admin access now depends on email delivery (demo mode locally; break-glass in prod is `wrangler d1 execute` on the primary). Already accepted in `docs/member-access-research.md` §"Site admin on better-auth".

## Decision 2: sign-in gate and redirects

- **Gate** becomes `Member row exists **or** email ∈ ADMIN_EMAILS`, in both places it lives: the `/login` server fn (`src/routes/login.tsx:54-60`, so an admin with zero memberships gets a link) and the `user.create.before` backstop in `Auth.ts`. Expose `isAdminEmail(email)` on the `Auth` service so `/login` doesn't re-parse the config. Enumeration property unchanged: same "check your email" panel either way.
- **Disjoint roles, tceas's invariant, adopted** (revised 2026-09-01 after first trying a softer "admin may also be a member" shape): an admin is cross-tenant and never on the shop side; impersonation (`admin()` plugin, `session.impersonatedBy`) is the sanctioned door and comes later with a user list on the console. Guards mirror each other: `/shop/*` bounces an admin session to `/admin`, `/admin` bounces a non-admin session to `/shop`, both use `redirect<AnyRouter>` to break the guard-type cycle (`refs/tceas/src/routes/app.tsx:24-30`). A stray `Member` row for an admin email is inert — not blocked at write time, the `/shop` guard still bounces. Operator testing uses two emails (one in `ADMIN_EMAILS`, one as a member).
- **Post-login landing**: `/login-callback` routes by role — `/admin` for admins, `/shop` for everyone else. No cross-links between the two areas.

## Decision 3: implementation touchpoints (in order)

1. `Auth.ts`: `ADMIN_EMAILS` config (comma-separated, trimmed, lowercased; default `""`), `isAdminEmail`, hook rewrite: admin email → stamp role; else membership check as today. Expose `listUsers` later if the console wants it — not now.
2. `src/routes/login.tsx`: gate `shops.length === 0 && !isAdminEmail`.
3. `src/lib/AdminServerFnMiddleware.ts` + `src/routes/admin.tsx`: `getSession` → role check → inject `{ user }`. Every existing `/admin/*` server fn already uses the middleware, so the child routes don't change.
4. Delete `AdminAuth.ts`, `admin.login.tsx`, `admin.logout.ts`; `admin.index.tsx` gets a sign-out server fn mirroring `shop.index.tsx` (`tanstackStartCookies` forwards the cleared cookie from a server fn; from a raw route handler it's unverified, so don't take that path).
5. `worker.ts:84` drop `AdminAuth.layer`. `wrangler.jsonc` drop `ADMIN_LOGIN_LIMITER` from all three envs.
6. `.env` / `.env.example`: drop the three `ADMIN_*` vars, add `ADMIN_EMAILS`. `test/integration/vitest.config.ts` same (`ADMIN_EMAILS: "admin@example.com"`). `pnpm typecheck` regenerates `worker-configuration.d.ts` without the old secrets.
7. `/login-callback`: role-based redirect.
8. Tests: `auth.test.ts` — admin email gets `role='admin'` on first sign-in, member email stays `'user'`, non-member non-admin still blocked. `member-area.test.ts`-style whole-flow for `/admin`: anonymous → 307 `/login`; member session → 307 `/shop`; admin session → 200 and `/shop` → 307 `/admin`; callback routes each role. Existing `/admin/*` pages need the real `CLOUDFLARE_WORKERS_API_TOKEN` for the DO explorer, so the whole-flow test hits `/admin` (index) only.

Estimated size: ~150 lines net removed. No research left to do; this can go straight to implementation.

## The "WebSocket cookie-session branch" — what it means, recommendation

**Color.** The embedded `/app` UI does not talk to the ShopAgent Durable Object through server fns; it opens a browser WebSocket to `/agents/shop-agent/{shop}` via `useAgent` (`src/routes/app.tsx:171-181,424`). Before the DO wakes, `routeAgentRequest` runs `authorizeShopAgentRequest` (`src/worker.ts:316-364`), which only knows one identity: a Shopify session token in `?token=` — it decodes it, checks the token's `dest` shop against the URL shop, then checks the plan. The member area (`/shop/$shop`) has no Shopify token; its identity is the better-auth cookie. Phase 1 sidestepped this entirely: `/shop/$shop` reads shop data with a server fn that calls the DO by RPC from the Worker (`src/routes/shop.$shop.tsx:14-27`), never from the browser. "Phase 1 member pages use server fns only" means exactly that — no member-area socket exists, so the gate never had to learn a second identity.

**When it's needed.** Only if a member-area screen wants what `/app` has: live updates or browser-side RPC against the DO (a workflow board that re-renders when the merchant moves a job, for instance). Read-only pages and form submits are fine on server fns forever.

**What it would be.** A second branch in `authorizeShopAgentRequest`, tceas's `authorizeOrganizationAgent` verbatim (`refs/tceas/src/worker.ts:233-277`): no `?token=` → `auth.getSession(request.headers)` (same-origin upgrade carries the cookie for free) → 401 if none → `findMember({ shop: urlShop, email })` → 403 on a miss → then the same plan check the token branch does. ~20 lines, membership checked once per connection, socket never re-authed (same trade-off `/app` already accepts). The client side needs a `ShopAgentContext`-style provider on `/shop/$shop` without the token `query` — the harder half, given `app.tsx`'s hydration/quarantine notes.

**Recommendation: keep deferring.** Nothing in phase 2 needs a member socket; the workflow engine is the first thing that would, and that's explicitly later. Add the branch the day a member page needs live DO state, not before — the Worker-side half is small and the shape is already written in tceas.
