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

## Billing is off

There are no App Pricing plans in Partners yet, so `BILLING_ENABLED` is `"false"` in `wrangler.jsonc`. `SubscriptionPlan` then short-circuits to `Domain.DEFAULT_PLAN_HANDLE` without a Partner API call, and every gate downstream — the `/app` route boundary, the WebSocket connect check, `resolveEntitlements` — keeps running in its real shape and simply always passes.

To turn billing on: create the plans in Partners, rename the handles in `Domain.PlanHandle`, set `SHOPIFY_PARTNER_API_TOKEN`, and flip the var. No call sites change.

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
