# Baton

A Shopify admin app skeleton: TanStack Start + Cloudflare Workers + Durable Objects + D1 + Effect v4.

Everything below the UI is production shape — auth, session storage, per-shop Durable Object with its own SQLite, WebSocket live updates, webhooks, a password-gated operator console, and a billing gate. The merchant-facing surface is deliberately one page whose only job is to prove each of those seams carries real data.

## What is here

| Piece                                              | Where                                                      |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Shopify OAuth / token exchange / session refresh   | `src/lib/Shopify.ts`, `src/routes/auth.$.tsx`              |
| Session storage (D1)                               | `src/lib/Repository.ts`, `migrations/0001_init.sql`        |
| Per-shop Durable Object + private SQLite           | `src/lib/ShopAgent.ts`, `src/lib/CounterRepository.ts`     |
| Typed DO RPC facade for the Worker                 | `src/lib/ShopAgentClient.ts`                               |
| Shared `/app` WebSocket, keepalive, zombie healing | `src/routes/app.tsx`, `src/lib/ShopAgentContext.tsx`       |
| Billing gate (App Pricing via Partner API)         | `src/lib/SubscriptionPlan.ts`, `src/lib/ShopifyPartner.ts` |
| Mandatory + lifecycle webhooks                     | `src/routes/webhooks.*.ts`                                 |
| Operator console                                   | `src/routes/admin.*.tsx`                                   |
| Merchant home (the demo)                           | `src/routes/app.index.tsx`                                 |
| Public landing + privacy policy                    | `src/routes/index.tsx`, `src/routes/privacy.tsx`           |

The home page shows three things, each one a proof rather than a feature:

- **Counter** — read and written in the shop's Durable Object SQLite; a bump broadcasts over the WebSocket so every open tab updates without a reload.
- **Shop** — read from the Shopify Admin API _by the Durable Object_, using the offline session stored in D1.
- **Plan** — resolved from the plan handle cached on the D1 session row.

Delete the sections, keep the wiring.

## Billing is off

There are no App Pricing plans in Partners yet, so `BILLING_ENABLED` is `"false"` in `wrangler.jsonc`. `SubscriptionPlan` then short-circuits to `Domain.DEFAULT_PLAN_HANDLE` without a Partner API call, and every gate downstream — the `/app` route boundary, the WebSocket connect check, `resolveEntitlements` — keeps running in its real shape and simply always passes.

To turn billing on: create the plans in Partners, rename the handles in `Domain.PlanHandle`, set `SHOPIFY_PARTNER_API_TOKEN`, and flip the var. No call sites change.

## Setup

Prerequisites: Shopify Partner account, Shopify CLI, and a development store — see https://shopify.dev/docs/apps/build/scaffold-app

Shopify CLI config safety:

- Always pass `--config` when a command can affect a linked Shopify app.
- Avoid bare `shopify app deploy`; it uses the CLI's current default config, which can change after `shopify app config link` or `shopify app config use`.
- `shopify app config link --config <name>` creates/links `shopify.app.<name>.toml`, but can also make that config the CLI default.

```bash
pnpm i
cp .env.example .env
```

1. Create and link the Shopify app. `client_id` is empty in `shopify.app.toml`, which is what makes this create a new app rather than relink an existing one:

```bash
shopify app config link --config shopify.app.toml
git diff -- shopify.app.toml   # confirm client_id, name, handle
```

2. Fill in the values the link produced:

- `wrangler.jsonc` → `vars.SHOPIFY_PARTNER_ORG_ID`, `vars.SHOPIFY_PARTNER_APP_ID` (`shopify app info`), and `vars.SHOPIFY_APP_HANDLE` if the handle changed.
- `wrangler.jsonc` → `vars.CLOUDFLARE_ACCOUNT_ID` (only read by the admin Durable Object explorer).
- `wrangler.jsonc` → `ratelimits[].namespace_id` — account-wide ids, so pick ones not already in use before deploying.
- `.env` → `ADMIN_AUTH_SECRET` (`openssl rand -base64 32`) and `ADMIN_PASSWORD` for the `/admin` console.

`SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` are injected by `shopify app dev` from the linked app — do not put them in `.env`. Inspect them with `shopify app env show --config shopify.app.toml`.

3. Create the local D1 database and apply migrations:

```bash
pnpm wrangler d1 create baton-d1-local   # only needed for a remote database
pnpm d1:migrate:apply
```

4. Deploy the app config, then run:

```bash
shopify app deploy --config shopify.app.toml
shopify app dev --config shopify.app.toml --store <your-dev-store>
```

## Every day

```bash
pnpm app:dev        # Shopify CLI dev (tunnel + shopify.web.toml runs pnpm dev)
pnpm typecheck
pnpm lint
pnpm test           # integration tests (workers pool)
pnpm test:browser
pnpm test:e2e       # Playwright against SHOPIFY_PREVIEW_URL (see .env.playwright)
```

## Deploying

Only a local config is defined in `wrangler.jsonc`. Add `env.staging` / `env.production` blocks with their own `name`, `vars`, `d1_databases`, `durable_objects`, `migrations`, and `ratelimits` when you need them, plus matching `shopify.app.<env>.toml` files — a deployed environment is a separate Shopify app, not a flag on this one.

```bash
pnpm deploy
pnpm tail
```

## Reference sources

`refs/` is a gitignored symlink to a shared checkout of library sources (TanStack, Cloudflare, Effect, Shopify). `AGENTS.md` documents what lives where. The `refs:*` scripts in `package.json` refresh individual entries.
