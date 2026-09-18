# Admin console E2E tests

Research date: 2026-09-18. Scope: headless Playwright coverage of the operator console at `/admin`, read-only, against local development. Open questions for the owner are at the end.

## How admin sign-in works today

The admin console and the member area share one login flow. There is no separate admin login page or password.

1. `/login` (`src/routes/login.tsx`) takes an email and calls better-auth's magic-link plugin.
2. The login server fn refuses to send a link unless the email has a `Member` row or is in `ADMIN_EMAILS`. Both cases render the same "Check your email" section.
3. With `DEMO_MODE=true` (set in `.env`), the link is cached in KV and rendered as an "Open your magic link" anchor. No mail is sent.
4. Following the link hits `/api/auth/magic-link/verify`, which creates the `User` row on first sign-in. The `databaseHooks.user.create.before` hook in `src/lib/Auth.ts` stamps `role = 'admin'` when the email matches `ADMIN_EMAILS`, then redirects to `/login-callback`.
5. `/login-callback` (`src/routes/login-callback.tsx`) sends `role === "admin"` to `/admin` and everyone else to `/shop`.
6. `/admin` (`src/routes/admin.tsx`) runs `requireAdmin` in `beforeLoad`: anonymous goes to `/login`, signed-in non-admin goes to `/shop`.

Two consequences matter for tests:

- **Role is stamped at creation only.** Changing `ADMIN_EMAILS` after a `User` row exists neither promotes nor demotes it. A test email must be in `ADMIN_EMAILS` before its first sign-in on a given local D1, or after `pnpm d1:reset`.
- **Admin and member are disjoint.** An admin email must not be seeded as a member. The `/shop` guard bounces admins to `/admin`, and `/admin` bounces members to `/shop`.

## Which admin account

`ADMIN_EMAILS` is a comma-separated env var. Local `.env` currently holds one address; `.env.example` shows a placeholder. It is read once at layer build and lowercased.

Options:

| Option                                                                                     | Pros                                                                   | Cons                                                                                                             |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A. Spec reads `ADMIN_EMAILS` from `.env` and signs in as the first entry                   | Zero config; works with whatever the developer already has             | Test identity depends on the developer's personal setup; a real address could receive mail if `DEMO_MODE` is off |
| B. Dedicated `e2e.admin@example.com`, added to `ADMIN_EMAILS` in `.env` and `.env.example` | Stable identity, mirrors `e2e.member@example.com`; obviously synthetic | One-time `.env` edit per developer; must land before first sign-in on that D1                                    |
| C. Spec injects the role directly via the dev seed endpoint                                | No env dependency                                                      | Requires a new mutation path in `api.dev.seed.ts` that bypasses the production role gate; more surface           |

Recommendation: **B**. The spec should assert at startup that its email is present in `ADMIN_EMAILS` and fail with a clear message otherwise, the way `seedConfig` in `e2e/seed.ts` fails when `PORT` or `SHOPIFY_PREVIEW_URL` is missing.

## Where the tests live in the Playwright config

`playwright.config.ts` has four projects: `setup` and `e2e` (embedded, through the Shopify preview tunnel, need Chrome's Shopify cookies), `member` (localhost, empty storage state, no setup dependency), and `billing` (headed, manual).

The admin console is not embedded and needs no Shopify cookies, so it belongs with `member`, not `e2e`. Two ways to slot it in:

- **New `admin` project**, `testMatch: ["**/*.admin.spec.ts"]`, same `use` block as `member` (localhost base URL, empty storage state). Add it to `test:e2e` and `test:e2e:headed`. Keeps the member suite's per-file limiter accounting untouched.
- **Reuse `member` project** by naming the file `admin.member.spec.ts`. No config change, but the name is misleading and the file would share the member project's ordering.

Recommendation: new `admin` project.

## Rate limiter

`LOGIN_LIMITER` was 5 magic-link sends per 60 seconds in every environment, and every local request shares one key because nothing sets `cf-connecting-ip`. The member specs spent 4 per run and the admin spec 1, so project order decided whether the fifth send was refused. Verified in a full run: with `admin` placed first, `member-area.member.spec.ts` failed with "Too many attempts".

Decision (2026-09-18): the local binding in `wrangler.jsonc` is now 1000 per 60 seconds. Staging and production redeclare their own `LOGIN_LIMITER` at 5 per 60 and are untouched; Wrangler does not inherit bindings into named envs. The retry loop in `signIn` and the send-budget comments across `e2e/` were removed with it. The limiter had no automated coverage before this change and still has none; the integration tests share `wrangler.jsonc`, so a real-binding test would need a per-config override.

## Seeding interaction

`POST /api/dev/seed` deletes `User` rows only for the listed member emails and wipes `Verification` wholesale. It never touches `ShopSession`. So:

- The admin `User` and `Session` survive any member seed. An admin spec can seed members freely after signing in.
- Signing in must complete before any seed call in the same file, because a seed wipes the unconsumed magic-link row.
- `/admin/shops` lists `ShopSession` rows, which exist only for shops where the app is installed. The row for the shop derived from `SHOPIFY_PREVIEW_URL` exists on any machine where the embedded suite has run. The admin spec can compute that domain with `seedConfig()` and assert it appears, but the assertion is soft on a fresh D1.

## Pages and what a read-only spec can assert

| Route                              | Heading                     | Read-only assertions                                                                         | Mutations present (do not click)  |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| `/admin`                           | `Admin v<version>`          | Page heading, "Shops" / "Shop Agent Objects" / "Orphan Shop Agent Objects" links, Sign out   | Sign out (a POST server fn)       |
| `/admin/shops`                     | `Shops`                     | Table renders; search field filters by shop; breadcrumb back to Admin; row link drills down  | none                              |
| `/admin/shop/$shop`                | `<shop>`                    | Plan section, Shopify session section, member count; or "No session" banner for unknown shop | "Refresh plan" (Partner API POST) |
| `/admin/shop-agent-objects`        | `Shop Agent Objects`        | Table renders; breadcrumb                                                                    | none                              |
| `/admin/orphan-shop-agent-objects` | `Orphan Shop Agent Objects` | Table renders; breadcrumb                                                                    | Destroy per row                   |

Guard tests that need no sign-in and no send:

- Anonymous `GET /admin` redirects to `/login` and renders the "Log in" page.
- Anonymous `GET /admin/shops` does the same.

Guard test that costs one send: a seeded member visiting `/admin` bounces to `/shop`. Skip in the first pass to keep the send count at one.

All admin pages render Polaris web components (`s-page`, `s-table`, `s-link`) and hydrate through the same `data-hydrated` marker, so `gotoMember` and `awaitHydration` in `e2e/member.ts` and `e2e/hydration.ts` apply unchanged. In-app navigation on `/admin` uses `router.navigate` from `s-link` `onClick`, so those clicks stay client-side and need no reload wait.

Sign out is worth one assertion at the end of the file: click it, land on `/`, then `GET /admin` bounces to `/login`. It is a mutation on the session only, not on shop data, and it leaves the D1 in the same state a fresh run expects.

## Proposed file

`e2e/admin.admin.spec.ts`, one file, roughly:

1. `beforeAll`: assert env, `signIn(page, ADMIN_EMAIL)` from `e2e/member.ts`, expect URL `/admin`, capture storage state.
2. Anonymous bounce for `/admin` and `/admin/shops` (fresh context, no state).
3. Dashboard renders heading and the three section links.
4. Shops: navigate from dashboard, table visible, filter by `?filter=<shop>` search param. The `s-search-field` sits in the table's filters slot, which Polaris hides until the table paginates, so it is not fillable with one installed shop.
5. Shop drill-down: click the preview shop row, expect heading equal to the shop domain and the "Shopify session" section. Fallback: visit `/admin/shop/nobody.myshopify.com` and expect the "No session" banner, which needs no installed shop.
6. Shop Agent Objects and Orphan pages: navigate, heading visible, breadcrumb returns to Admin.
7. Sign out and confirm the bounce.

Estimated run time under 30 seconds excluding any limiter wait. Everything runs headless under the existing `channel: "chrome"`.

## Decisions (2026-09-18)

1. Admin identity: dedicated `e2e.admin@example.com`, appended to `ADMIN_EMAILS` in `.env` and `.env.example`. The spec fails with a clear message if the address is absent.
2. New `admin` Playwright project, `testMatch: ["**/*.admin.spec.ts"]`, same `use` block as `member`, ordered after `member`, wired into `test:e2e` and `test:e2e:headed`. The embedded `e2e` project ignores `*.admin.spec.ts`.
3. Shop drill-down: assert the `SHOPIFY_PREVIEW_URL` shop row and detail page only when the row is present; always assert the "No session" banner for a made-up shop.
4. First pass includes the Shop Agent Objects and Orphan pages (read-only) and the anonymous bounce tests. Sign out is left out; the admin session stays in place across runs.
