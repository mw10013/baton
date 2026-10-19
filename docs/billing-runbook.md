# Billing runbook

Baton bills through Shopify App Pricing. Plans are configured in the Partner Dashboard, never in code; the Backend reads the merchant's plan handle through the Partner API (`src/backend/shopify-partner.ts`) and caches it on the D1 `ShopSession` row (`src/backend/subscription-plan.ts`). Usage is metered in the shop's actor and sent to the App Events API (`src/backend/shop-actor/usage-repository.ts`, `src/backend/shopify-app-events.ts`).

## Plans

Two public plans, one per tier, each with two usage meters. Handles must match `PlanHandle`, `USAGE_METER_ORDER` and `USAGE_METER_MEMBER` in `src/domain/billing.ts` exactly (case-sensitive); tier 1 sizes must match `ENTITLEMENTS` there.

| Field                 | Basic                                                | Pro                                                  |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Handle                | `baton-basic`                                        | `baton-pro`                                          |
| Display name          | Basic                                                | Pro                                                  |
| Billing period        | Monthly                                              | Monthly                                              |
| Monthly charge        | $29                                                  | $79                                                  |
| Free trial            | 14 days                                              | 14 days                                              |
| Welcome link          | `/app`                                               | `/app`                                               |
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

The numbers were set 2026-10-08 against Route to Ship's published ladder. A change starts at `ENTITLEMENTS`, the Partner Dashboard and this table together.

**Top features** is not one sentence: each feature is its own field, capped at **40 characters**, up to eight per plan. Copy that does not fit is copy the dashboard silently truncates, so the lines are written to the limit. Enter them in this order:

| #   | Basic                                    | Pro                                      |
| --- | ---------------------------------------- | ---------------------------------------- |
| 1   | `200 orders included, then $0.12 each`   | `1,500 orders included, then $0.05 each` |
| 2   | `3 members included, then $12 each`      | `10 members included, then $7 each`      |
| 3   | `Workflows and teams at no extra charge` | `Workflows and teams at no extra charge` |
| 4   | `Billed once work starts on an order`    | `Billed once work starts on an order`    |
| 5   | `Up to 50 members, 2,500 open orders`    | `Up to 50 members, 2,500 open orders`    |

Line 1 must agree with `ordersPerCycle` in `ENTITLEMENTS` and with the meter's tier 2 price; line 2 with `membersIncluded` and the member meter's tier 2 price. Line 4 states the metering rule (`makeUsageRepository`'s `countOrder`): an order is counted once, when Baton creates its first run, and never reversed. Avoid "up to N orders" (it reads as a hard cap) and "a month" (the period is the billing cycle). Line 5 must agree with `maxMembers` and `maxOpenOrders` in `ShopLimits` (`src/domain/platform.ts`), the same on every plan.

- Handles match display names, so the Dev Dashboard billing log and the invoice use the same words. The name is capped at **18 characters**, the handle at 30; neither can be changed once saved.
- **Do not add or re-handle a meter on a live plan without a migration.** An app subscription carries the item set it was created with, so existing subscribers keep an app subscription with no meter item until a plan switch replaces it.
- No free plan. No yearly option: usage meters require monthly billing.
- The welcome link is `/app`. Shopify appends `?plan_handle=<handle>` to it, and `/app`'s guard treats any `plan_handle` as the billing redirect that forces a fresh Partner API read.
- Plans belong to an app, so they exist once per app: Baton Dev (`baton-local`, `shopify.app.toml`) and Baton Staging.
- No test handles: development stores in the same Partner organization get every public plan at $0.
- Leave Shopify's built-in private `shopify-test` plan untouched.

Where: Partner Dashboard > App distribution > All apps > the app > Distribution > Manage listing > the locale > Pricing content > Manage > Public plans. Each plan needs a display name and top features for every published language or it does not show; the usage meters are added inside the plan editor. Plans exist only on an app whose distribution is public (unlisted is enough); choosing a distribution is permanent.

## Credentials and per-app values

Values a Shopify app issues per stage come through configuration; values Baton defines (plan and meter handles, entitlements, API versions) live in code.

- `SHOPIFY_PARTNER_API_TOKEN`: a Partner API client token with the **Manage apps** permission. Partner Dashboard > Settings > Partner API clients > Create. One token serves every app in the organization. A secret.
- `SHOPIFY_PARTNER_ORG_ID`: the number in the Partner Dashboard URL (`partners.shopify.com/<org id>/…`).
- `SHOPIFY_PARTNER_APP_ID`: the app's number in its Partner Dashboard URL (`…/apps/<app id>`). Baton Dev's is `417214922753`; Baton Staging's is its own.
- `SHOPIFY_APP_HANDLE`: the app's URL handle, which builds the plan selection URL `https://admin.shopify.com/store/<store>/charges/<handle>/pricing_plans` and the App Events `User-Agent`.
- Where they live: dev and e2e read the four from the checkout's `.env`; staging reads them from the stage config record (`docs/stage-config-runbook.md`, filled from `.env.staging`); the integration tests use fakes.
- App Events: no separate credential. The Backend exchanges the app's Client ID and Secret for a bearer token at `https://api.shopify.com/auth/access_token` (client credentials). The token answer carries no `expires_in` (measured 2026-09-19 and 2026-10-18), and a request without a `User-Agent` is refused at Shopify's edge.
- API versions: `PARTNER_API_VERSION` and `APP_EVENTS_API_VERSION`, both `2026-10`, in code.
- Check `.env` files by names only: `sed -E 's/=.*/=<hidden>/' .env`.

## Subscribe a store

Every store the suites and the dev server use needs an app subscription, or `/app` sends it to the plan selection page:

1. Signed in as the store owner, open `https://admin.shopify.com/store/<store>/charges/<handle>/pricing_plans`.
2. Pick a plan (on a development store the button reads "Test with this plan") and approve the $0 charge.
3. Back in the app, the home page's **Your plan** shows the plan's included numbers.

## Switch a plan by hand

Press **Manage plan** on the home page, pick the other plan, approve. The return to `/app?plan_handle=…` re-reads the plan at once. Manage plan also shortens the cached plan to 15 minutes, in case the return is lost. `vp run test:e2e:billing` does the same both ways, headed, and restores the starting plan.

## Read the App Events log

Usage reaches Shopify only for a shop in a billing cycle (not in a trial), and only for orders counted inside the current cycle. Confirm in the Dev Dashboard > the app > Logs, type **App event**: a working event is logged `App billing event` / `production-orders` / `OK`. An event for a shop without the app is refused (`403 not_installed`); one that matches no meter is accepted (`202`) and logged non-billable. A refused event stays in the shop's outbox with its error and is retried on the next flush.

## Enable an environment

1. Make the app's distribution public (unlisted) and create the plans above on it.
2. Put the four values above in the stage's configuration (`.env` for dev, `.env.<stage>` and `vp run stage-config --stage <stage>` for a deployed stage).
3. Subscribe the stage's store (above), open the app, and confirm the home page shows the plan's numbers.
4. The cached plan lasts 24 hours (`PLAN_HANDLE_MAX_AGE_MS`); a plan switch through the pricing page re-reads it at once, and the daily cron (`17 4 * * *`) re-reads every stale shop.
