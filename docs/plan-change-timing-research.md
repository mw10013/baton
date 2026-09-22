# Plan change timing: research

Date: 2026-09-22.

Question: when a merchant changes plan on the Shopify-hosted plan selection
page, does the new plan apply at once or at the end of the billing cycle?

Answer: at once, in both directions. Baton has two paid monthly plans and no
free plan, and the only deferral App Pricing documents is a downgrade from a
paid plan to a free plan.

## 1. Evidence

### Observed, 2026-09-22

On `sandbox-shop-01`, subscribed to Pro: Manage plan, choose Basic, redirect
back to `/app`. The home page showed Basic's limits on arrival. The upgrade
direction (Basic to Pro) was already known to be immediate.

A measurement on 2026-09-19 found the same thing: the handle moved at once and
`pendingUpdate` was `null` (removed from the `Domain.PlanStatus` JSDoc in
`ba01221`).

### Documented

- `refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-subscription-charges.md`,
  "Proration logic": "Downgrading from a paid plan to a free plan is deferred,
  meaning it's effective at the end of the paid plan's current cycle." That is
  the whole section. No other deferral is listed.
- `refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing.md`, App
  Billing Events: `SUBSCRIPTION_CANCELLATION_SCHEDULED` is described as "for
  example, a downgrade to a free plan that takes effect at the end of the
  billing cycle". Same case.
- Same file, intro: App Pricing "automates ... proration". A paid-to-paid
  change is prorated, which only makes sense if it applies mid-cycle.
- `refs/shopify-docs/docs/api/partner/latest/objects/AppCredit.md`: credits
  are issued "when a paid app subscription is downgraded partway through its
  billing cycle". Again a mid-cycle downgrade.
- `refs/shopify-docs/docs/api/partner/latest/active-subscription.md`, "Pending
  updates": `pendingUpdate` holds items active at the start of the next cycle
  "if the merchant has scheduled a plan change". It exists for the deferred
  cases above.

The deferral list in `docs/apps/launch/billing/manual-pricing/subscription-billing.md`
("Deferral": annual to cheaper annual, annual to 30-day) is the legacy Billing
API. It does not describe App Pricing, and Baton's plans are monthly only
(`README.md`, "Plans"), so neither case could arise anyway.

### Why the dev store result counts

`sandbox-shop-01` is a development store in the same Partner organization as
the app, so Shopify offers every public plan at no charge
(`shopify-app-pricing.md`, "Testing"). Basic and Pro are the real paid plans,
not test variants; `Domain.PlanHandle` has no `-test` handles. The docs say
what happens: "Shopify creates an app subscription contract with effective
prices of $0 for its recurring and usage-based items." Same plans, same
contract, $0 effective price. The one documented deferral is keyed on the
target being a free _plan_, which is plan configuration, and Basic is not a
free plan. The no-charge contract is Shopify's intended way to test plan
switching, and its result stands for production.

## 2. What Baton needs

Nothing about pending changes. A plan change is a handle change on the next
`activeSubscription` read, and the billing redirect (`plan_handle`) forces that
read on return. `pendingUpdate` and `cancelAtEndOfCycle` were already dropped
(`docs/orders-webhooks-billing-plan.md`, Step 6), and there is no path to
either: no free plan to downgrade to, and the hosted page has no cancel
control.

The boundary clamp in `SubscriptionPlan.planHandleExpiresAt` stays, for a
different reason than its JSDoc gives. At the boundary the billing cycle rolls
(and a trial ends, turning `trialEndsAt` into `currentBillingCycle`), and the
revalidation after it is what pushes the new cycle to `ShopAgent.setBillingCycle`
so order counting starts over. That holds with or without scheduled plan
changes.

## 3. Decisions

No open questions remain.

- Plan changes apply at once, up and down. Baton tracks nothing pending.
- The second billing e2e test asserts it: renamed "a paid-to-paid downgrade
  applies at once, and the usage outbox drains", and after Pro to Basic it
  requires the refreshed cached plan to read `baton-basic`. `switchPlan`
  already required the home page to read Basic on the redirect.
- The recollection of a scheduled downgrade had no recorded run behind it and
  is dropped.

## 4. Changes made

| Site                                                           | Change                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Domain.PlanStatus` JSDoc                                      | States the rule: changes apply at once; App Pricing defers only a downgrade to a free plan, and Baton has none. |
| `planHandleExpiresAt` JSDoc                                    | Clamp justified by the cycle roll and trial end, which reach `ShopAgent.setBillingCycle`.                       |
| `PLAN_HANDLE_MAX_AGE_MS` JSDoc                                 | "Scheduled changes" replaced by plan changes (redirect) and cycle rolls (clamp).                                |
| `PLAN_HANDLE_BOUNDARY_SKEW_MS` JSDoc                           | Unchanged; it is about the cycle transition.                                                                    |
| `Domain.AppIndexLoaderData` JSDoc                              | "The scheduled-change fields" becomes "The entitlements and the boundary".                                      |
| `e2e/plan.billing.spec.ts`                                     | File JSDoc, second test title, comments, and the `baton-basic` assertion as above.                              |
| `docs/orders-webhooks-billing-research.md`, "Downgrade timing" | One line pointing here.                                                                                         |
