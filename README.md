# Baton

Made-to-order production workflows for Shopify merchants.

Baton runs on TanStack Start, Cloudflare Workers, Durable Objects, D1, and Effect v4. It provides the production workflow foundation: auth, session storage, per-shop Durable Objects with private SQLite, WebSocket live updates, order webhooks, member access, an operator console, and gated billing.

## What is here

| Piece                                              | Where                                                      |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Shopify OAuth / token exchange / session refresh   | `src/lib/Shopify.ts`, `src/routes/auth.$.tsx`              |
| Shop session storage (D1, `ShopSession`)           | `src/lib/Repository.ts`, `migrations/0001_init.sql`        |
| Per-shop Durable Object + private SQLite           | `src/lib/ShopAgent.ts`, `src/lib/CounterRepository.ts`     |
| Typed DO RPC facade for the Worker                 | `src/lib/ShopAgentClient.ts`                               |
| Shared `/app` WebSocket, keepalive, zombie healing | `src/routes/app.tsx`, `src/lib/ShopAgentContext.tsx`       |
| Billing gate (App Pricing via Partner API)         | `src/lib/SubscriptionPlan.ts`, `src/lib/ShopifyPartner.ts` |
| Mandatory + lifecycle webhooks                     | `src/routes/webhooks.*.ts`                                 |
| Operator console                                   | `src/routes/admin.*.tsx`                                   |
| Production workflow home                           | `src/routes/app.index.tsx`                                 |
| Public landing + privacy policy                    | `src/routes/index.tsx`, `src/routes/privacy.tsx`           |

The current home page exposes foundational production-workflow data:

- **Counter** — read and written in the shop's Durable Object SQLite; a bump broadcasts over the WebSocket so every open tab updates without a reload.
- **Shop** — read from the Shopify Admin API _by the Durable Object_, using the offline session stored in D1.
- **Plan** — resolved from the plan handle cached on the D1 session row.

## Billing

Baton bills through Shopify App Pricing. Plans are configured in the Partner Dashboard, never
in code; the app reads the merchant's plan handle through the Partner API
(`src/lib/ShopifyPartner.ts`) and caches it on the D1 session row (`src/lib/SubscriptionPlan.ts`).

### Plans to create

Two public plans, one per tier. Handles must match `Domain.PlanHandle` exactly (case-sensitive);
limits must match `ENTITLEMENTS` in `src/lib/Domain.ts`. All numbers are provisional.

| Field          | Basic                                                                    | Pro                                                                         |
| -------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Handle         | `baton-basic`                                                            | `baton-pro`                                                                 |
| Display name   | Basic                                                                    | Pro                                                                         |
| Billing period | Monthly                                                                  | Monthly                                                                     |
| Monthly charge | $29                                                                      | $79                                                                         |
| Free trial     | 14 days                                                                  | none                                                                        |
| Usage meters   | none                                                                     | none                                                                        |
| Welcome link   | `/app`                                                                   | `/app`                                                                      |
| Top features   | Up to 250 orders a month. 3 team members. Unlimited workflows and teams. | Up to 1,000 orders a month. 10 team members. Unlimited workflows and teams. |

- No free plan. No yearly option: usage-based charges, if added later, require monthly billing.
- The welcome link is a relative App Home path. Shopify appends `?plan_handle=<handle>` to it,
  and `src/routes/app.tsx` treats any `plan_handle` in the search string as the billing redirect
  that forces a fresh Partner API read.
- Plans belong to an app, so create them once per app: `baton-local` (`shopify.app.toml`) now,
  `baton-staging` and the production app when those exist.
- Test handles: none. Development stores in the same Partner organization get every public
  plan at $0, so `Domain.PlanHandle` carries only the two public handles.
- Leave Shopify's built-in private `shopify-test` plan untouched: no stores under "Stores with
  plan access", redirect URL as shipped. Its store list only controls which stores see that one
  private plan on the selection page; it has nothing to do with install access or with dev
  stores getting the public plans free. Test against `baton-basic` and `baton-pro` directly.

Where: Partner Dashboard > App distribution > All apps > the app > Distribution > Manage
listing > the locale > Pricing content > Manage > Public plans > Add. Each plan needs a display
name and top features for every published language or it does not show.

### Credentials

- `SHOPIFY_PARTNER_API_TOKEN` (`.env`): a Partner API client token with the **Manage apps**
  permission. Partner Dashboard > Settings > Partner API clients > Create. One token serves all
  apps in the organization.
- `SHOPIFY_PARTNER_ORG_ID` (`wrangler.jsonc`): the number in the Partner Dashboard URL.
- `SHOPIFY_PARTNER_APP_ID` (`wrangler.jsonc`): the numeric app id from the app's Partner
  Dashboard URL. Filled for local; empty for staging and production until those apps exist.
- `SHOPIFY_APP_HANDLE` (`wrangler.jsonc`): the app handle, used to build the plan selection URL
  `https://admin.shopify.com/store/<store>/charges/<handle>/pricing_plans`.

### Enabling an environment

1. Create the plans above for the app.
2. Confirm `SHOPIFY_PARTNER_APP_ID` and `SHOPIFY_APP_HANDLE` for the environment.
3. On a development store: open the app, confirm it redirects to the plan selection page,
   pick a plan, confirm it returns to `/app`, and confirm `/admin/shop/<shop>` shows the handle.
   The plan cache is 24 hours (`PLAN_HANDLE_MAX_AGE_MS`); use the admin page's refresh button
   instead of waiting.

## Run locally

### Prerequisites

- Node.js 26
- pnpm 10
- Shopify CLI
- A Shopify Partner account and development store

See Shopify's [app setup guide](https://shopify.dev/docs/apps/build/scaffold-app) if you need to create a Partner account or development store.

### First-time setup

Install dependencies and create your local environment file:

```bash
pnpm install
cp .env.example .env
```

Create or select the Shopify app used for local development:

```bash
shopify app config link --config shopify.app.toml
git diff -- shopify.app.toml
```

Confirm that `shopify.app.toml` now contains the intended `client_id`, app name, and handle.

Configure `.env`:

- `ADMIN_AUTH_SECRET`: generate with `openssl rand -hex 32`.
- `ADMIN_PASSWORD`: password for the local `/admin` console.
- `ADMIN_PASSWORD1`: second accepted admin password.
- `SHOPIFY_PARTNER_API_TOKEN`: Partner API token.

Configure `wrangler.jsonc` using the linked app:

- `SHOPIFY_PARTNER_ORG_ID`
- `SHOPIFY_PARTNER_APP_ID`
- `SHOPIFY_APP_HANDLE`

Shopify CLI supplies `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`; do not add them to `.env`. Inspect them with:

```bash
shopify app env show --config shopify.app.toml
```

Apply the local D1 migrations:

```bash
pnpm d1:migrate:apply
```

Wrangler creates the local D1 storage automatically. Do not create a remote D1 database just to run the app locally.

### Start the app

```bash
shopify app dev --config shopify.app.toml --store <your-dev-store>
```

Use the preview URL printed by Shopify CLI to install or open the app. On subsequent runs, use the same command or pass the store through the package script:

```bash
pnpm app:dev -- --store <your-dev-store>
```

### Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:browser
pnpm test:e2e
```

`pnpm test:e2e` is headless and never touches billing. Plan switching drives Shopify's hosted
pricing page, which sits behind a Cloudflare bot check that challenges headless browsers, so it
lives in its own Playwright project and runs headed, by hand, and not in a loop:

```bash
pnpm test:e2e:billing
```

It moves the dev store's real subscription and restores the starting plan when it finishes.

## Deploying

Only a local config is defined in `wrangler.jsonc`. Add `env.staging` / `env.production` blocks with their own `name`, `vars`, `d1_databases`, `durable_objects`, `migrations`, and `ratelimits` when you need them, plus matching `shopify.app.<env>.toml` files — a deployed environment is a separate Shopify app, not a flag on this one.

Always pass `--config` to Shopify CLI commands that can affect a linked app. Avoid bare `shopify app deploy`: it uses the current default config, which can change after `shopify app config link` or `shopify app config use`.

Before deploying, set `CLOUDFLARE_ACCOUNT_ID` and choose unused account-wide `ratelimits[].namespace_id` values for the target Cloudflare environment.

```bash
pnpm deploy
pnpm tail
```

## Reference sources

`refs/` is a gitignored symlink to a shared checkout of library sources (TanStack, Cloudflare, Effect, Shopify). `AGENTS.md` documents what lives where. The `refs:*` scripts in `package.json` refresh individual entries.
