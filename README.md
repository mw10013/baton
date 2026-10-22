# Baton

- https://admin.shopify.com/store/mw10013-dev-shop-01/apps/baton-local/app
- https://baton-website-staging.mw10013.workers.dev

## Run locally

Copy `.env.example` to `.env` first; it holds this checkout's port and Shopify dev store.

```sh
vp install
vp run dev        # start or adopt this checkout's dev server
vp run dev:status
vp run dev:logs
vp run dev:stop
vp run db:reset    # wipe local D1 and Durable Objects, reseed, restart, open the app, load the fixture
vp run fixture     # put the dev store back into the dev fixture
```

## Staging

A push to `main` deploys staging through Workers Builds.

```sh
vp run cloud:reset --stage staging --confirm staging   # wipe D1 and Durable Objects, redeploy
```

### Plans

Two public plans, one per tier, each with two usage meters. Handles must match
`Domain.PlanHandle`, `Domain.USAGE_METER_ORDER`, and `Domain.USAGE_METER_MEMBER` exactly
(case-sensitive); tier 1 sizes must match `ENTITLEMENTS` in `src/lib/domain/Billing.ts`.

| Field                 | Basic                                                | Pro                                                  |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Handle                | `baton-basic`                                        | `baton-pro`                                          |
| Display name          | Baton Basic                                          | Baton Pro                                            |
| Billing period        | Monthly                                              | Monthly                                              |
| Monthly charge        | $29                                                  | $79                                                  |
| Free trial            | 14 days                                              | 14 days                                              |
| Redirect URL          | `/app`                                               | `/app`                                               |
| Top features          | See below — one line per feature, 40 characters each | See below — one line per feature, 40 characters each |
| Usage meter 1: name   | Production orders                                    | Production orders                                    |
| Usage meter 1: handle | `production-orders`                                  | `production-orders`                                  |
| Pricing model         | Tiered, graduated                                    | Tiered, graduated                                    |
| Charge as             | Cost per unit                                        | Cost per unit                                        |
| Tier 1                | Units 1 to 200 at $0.00                              | Units 1 to 1500 at $0.00                             |
| Tier 2                | Units 201 and up at $0.12                            | Units 1501 and up at $0.05                           |
| Usage meter 2: name   | Members                                              | Members                                              |
| Usage meter 2: handle | `members`                                            | `members`                                            |
| Pricing model         | Tiered, graduated                                    | Tiered, graduated                                    |
| Charge as             | Cost per unit                                        | Cost per unit                                        |
| Tier 1                | Units 1 to 3 at $0.00                                | Units 1 to 10 at $0.00                               |
| Tier 2                | Units 4 and up at $12.00                             | Units 11 and up at $7.00                             |

| #   | Basic                                    | Pro                                      |
| --- | ---------------------------------------- | ---------------------------------------- |
| 1   | `200 orders included, then $0.12 each`   | `1,500 orders included, then $0.05 each` |
| 2   | `3 members included, then $12 each`      | `10 members included, then $7 each`      |
| 3   | `Workflows and teams at no extra charge` | `Workflows and teams at no extra charge` |
| 4   | `Billed once work starts on an order`    | `Billed once work starts on an order`    |
| 5   | `Up to 50 members, 2,500 open orders`    | `Up to 50 members, 2,500 open orders`    |

## Production

The `production` stage serves `https://baton.mw10013.com` using the production Shopify app
(`baton-work`). Its credentials come from the production stage-config record, populated from
untracked `.env.production`; deploy that record before the application stack. Production disables
the dev kit and dev endpoints and seeds `support@mw10013.com` as its administrator.

`vp run cloud:reset` accepts staging only. Production data must be preserved: do not edit applied
D1 migrations in `migrations/` or actor migrations in `src/backend/shop-actor.ts`; append migrations
for subsequent schema changes. Do not destroy production Workers, which own Durable Object data.

Production hosting and its Workers Builds trigger still require initial setup; adding stage support
does not deploy infrastructure or connect a release branch.
