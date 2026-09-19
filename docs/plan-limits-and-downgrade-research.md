# Plan limits, downgrades, and plan-change detection

Research into three open questions on top of the implemented limits work
(`docs/limits-and-plans-research.md`, `docs/limits-and-plans-plan.md`, commit `04dda22`):

1. Which limits belong on the Basic and Pro plans, argued from first principles rather than
   by copying Route to Ship.
2. What happens to a shop that is over a limit after a downgrade, with the member limit as the
   hard case.
3. How a plan change is detected at all when Shopify App Pricing sends no webhooks, and how the
   downgrade policy has to be shaped so it works from any detection point, including a webhook
   request.

Every number is provisional. Every code reference was checked against the tree on 2026-09-19.
Shopify facts come from `refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing*` and
the Partner API object docs under `refs/shopify-docs/docs/api/partner/latest/`; competitor
facts come from scraped listings under `refs/` (no competitor source exists, so their
enforcement is inferred from copy only).

**Status: research only. Nothing implemented.** Reviewed with annotations on 2026-09-19; the
decisions taken are in §9. Baton has two paid plans and no free tier, and will not add one;
nothing below assumes a free plan.

Split out as its own hand-off: `docs/remove-billing-flag-plan.md`.

## Verdict

1. **Keep orders per month and members as the only plan-tied limits.** Teams, workflows, and
   steps stay flat constants. The first-principles test in §2 rules them out, and every
   competitor that names them markets them as unlimited. §2.
2. **Do not run a downgrade procedure at all. Derive who is over the limit from data that
   already exists, and enforce at access time.** A member holds a seat when they are among the
   first `maxMembers` members of the shop by `createdAt`. A member without a seat is refused at
   the one gate every member surface already runs through, `requireMember`. Nothing is deleted,
   nothing is deactivated, no flag is stored, and no event has to be caught. The merchant frees a
   seat by removing a member, which is the only member-management verb that exists today, or by
   upgrading. §4.
3. **Reject active/inactive members.** It is a second membership state that every surface would
   have to agree on, it needs bookkeeping on downgrade that has no reliable trigger, and the
   derived rule gives the merchant the same outcome with one verb instead of three. Keep it as
   the fallback if merchants ask to choose seats without removing anyone. §4.4.
4. **Plan-change timing is Shopify's, not Baton's.** App Pricing exposes no setting for when
   a change applies. The documented shape is upgrades immediate with proration and downgrades
   deferred to the end of the cycle, surfaced through `pendingUpdate`. Design for that shape,
   confirm it on the dev store during implementation, and note that policy E does not depend on
   it. The redirect leg is therefore never the place a downgrade is "handled": on a deferred
   downgrade the redirect arrives while the old plan is still active. §5.
5. **Cache `pendingUpdate` beside `planHandle`** so the home page can warn ahead of a scheduled
   downgrade, and **shorten the cache when the merchant clicks Manage plan** so a lost redirect
   costs minutes rather than a day. §5.3, §5.5.
6. **Turn on usage overage for orders, strongly recommended.** Without it the order limit is
   not a limit: a hard stop is out for a production tool, so a soft limit alone means a Basic
   shop can run 1,000 orders a month for the Basic price and the two plans differ only by
   seats. Overage is the only enforcement that keeps the floor running and charges for growth.
   It is dashboard configuration plus one event per counted order, and Shopify already exposes
   the reconciliation figure. Move the counter to the billing cycle first. §6.
7. **Remove `BILLING_ENABLED` now, as its own change.** Plan in
   `docs/remove-billing-flag-plan.md`. §7.

## 1. Where the tree stands

Already implemented and verified on a dev store (`docs/limits-and-plans-plan.md` §17):

| Concern                | Where                                                                                | Behaviour                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Plan handles and tiers | `src/lib/Domain.ts` `PlanHandle`, `ENTITLEMENTS`                                     | `baton-basic` 250 orders / 3 members, `baton-pro` 1,000 orders / 10 members                                          |
| Plan source of truth   | `src/lib/ShopifyPartner.ts` `activeSubscription`                                     | Partner API 2026-07, reads `items { handle }`, `currentBillingCycle { endTime }`, `trialEndsAt`                      |
| Plan cache             | D1 `ShopSession.planHandle`, `planHandleExpiresAt`; `src/lib/SubscriptionPlan.ts`    | 24 h max age, clamped to the next contract boundary plus 5 min skew; `refresh` on the `plan_handle` redirect         |
| Member cap             | `src/lib/Repository.ts` `addMember`                                                  | Blocks adding past `maxMembers`; never removes anyone on a downgrade                                                 |
| Order quota            | `ShopUsage.ordersThisMonth` in the Durable Object; `src/components/QuotaBanners.tsx` | Soft: warning banner past the quota, syncing continues                                                               |
| Flat constants         | `Domain.ShopLimits`, `Domain.WorkflowLimits`                                         | 25 teams, 50 workflows, 20 steps, 5,000 open runs, 250 line items per order, 90-day retention                        |
| Member gate            | `src/lib/MemberAccess.ts` `requireMember`                                            | Membership first, then plan; an unsubscribed shop sends members to the lapsed page and the socket gate answers `402` |
| Lapse revocation       | `SubscriptionPlan.revalidate`                                                        | Closes every socket when a cached handle becomes none                                                                |
| Manage plan            | `src/routes/app.index.tsx`                                                           | Button opens the Shopify-hosted pricing page in `_top`; home shows "n of m" for orders and members                   |
| `BILLING_ENABLED`      | `wrangler.jsonc` (all three envs `"true"`), `SubscriptionPlan.layerNoDeps`           | `false` grants every shop `baton-pro` without a Partner API call                                                     |

Two things the tree does not do: nothing happens to a shop that is over `maxMembers` (the
fourth member keeps signing in forever), and nothing shows a scheduled downgrade.

## 2. Which limits belong on a plan

### 2.1 The test

A limit earns a place on the pricing page only if it passes all five:

1. **Tracks value or cost.** It grows with what the merchant gets out of Baton or with what
   Baton pays to serve them, so a bigger shop pays more and a smaller one pays less.
2. **Legible before purchase.** A merchant can answer "which plan do I need" from numbers they
   already know about their business, without opening the app.
3. **Not a hygiene tax.** It must not punish modelling the business well. A limit on the number
   of ways work is described charges for detail, not for scale.
4. **Enforceable without destroying work.** Going over it, by growth or by downgrade, must have
   a remedy that costs nothing but money or a management click. Deleting production history or
   stopping a shipment is not a remedy.
5. **Not gameable.** A merchant cannot obtain a permanent Pro-shaped shop on a Basic price by
   moving between plans.

### 2.2 The candidates

| Candidate            | Value or cost                                                            | Legible                                              | Hygiene tax                                                      | Enforceable                                                                                    | Verdict                                    |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Orders per month     | Yes. Throughput is the value, and orders are the rows that cost storage. | Yes. Every merchant knows their monthly order count. | No.                                                              | Yes. Soft limit or overage; never a hard stop.                                                 | **Plan-tied.**                             |
| Members              | Yes. Seats are the SaaS convention because headcount tracks shop size.   | Yes. They know who works the floor.                  | No.                                                              | Yes. Over-limit members lose sign-in; history survives because run steps snapshot emails (§4). | **Plan-tied.**                             |
| Teams                | Weakly. Teams are a grouping of members, so members already price them.  | Partly. A shop's "departments" is a known number.    | Yes. Splitting a bench into two teams is modelling, not growth.  | Awkward. A team with open run steps cannot be removed without reassigning work.                | Flat constant (25).                        |
| Workflows            | No. Ten workflows for ten product types is one shop, not ten.            | No. Nobody knows this number before using the app.   | Yes, strongly.                                                   | No. A workflow with live runs cannot be deleted; a downgrade would strand runs.                | Flat constant (50).                        |
| Steps per workflow   | No.                                                                      | No.                                                  | Yes, strongly. It charges for describing the process accurately. | No. Steps are copied into runs; shortening a workflow does not shorten a run.                  | Flat constant (20).                        |
| Open runs            | Yes, as cost. This is the live working set.                              | No. It is an internal quantity.                      | No.                                                              | Awkward. Over the ceiling, auto-start yields. Meaningful only as a safety valve.               | Flat constant (5,000). MakerBatch's model. |
| Storage or retention | Yes, as cost.                                                            | No.                                                  | No.                                                              | Retention by plan would delete a merchant's history on downgrade. Fails test 4 outright.       | Flat constant (90 days, 2 GB).             |

Market check: Route to Ship prices on exactly seats and orders and markets pipelines and
departments as unlimited on every tier including free. Kanbanify markets "unlimited stages,
orders and users" and gates only boards. Nobody in the category limits workflows or steps.
MakerBatch's "items in production at once" is the one alternative worth remembering, since it is
a gauge that needs no monthly reset and no proration, but it is illegible before purchase and
Baton already keeps the equivalent as a constant.

Recommendation: the current split is right. Orders and members on the plan, everything else a
constant high enough that a medium shop never sees it.

## 3. What a downgrade has to survive

Before comparing policies, the constraints any policy must satisfy, from the codebase and from
Shopify:

- **There is no downgrade event.** App Pricing sends no webhooks
  (`shopify-app-pricing.md`, "Shopify App Pricing doesn't use webhooks"). The two signals are
  the `plan_handle` redirect, which the merchant's browser may never complete, and the Partner
  API, which Baton polls at most once per shop per day or at the contract boundary.
- **When a change applies is Shopify's decision.** App Pricing "automates ... proration"
  (`shopify-app-pricing.md`) and offers no per-plan or per-app setting for timing. The only
  documented timing rule is for a case Baton does not have, paid to free, which is deferred
  (`setup-subscription-charges.md`, "Plan downgrading"). For paid to paid the documentation is
  `pendingUpdate`, which "contains the items that are active at the start of the next billing
  cycle" (`active-subscription.md`), and the legacy proration page Shopify says it automates:
  a price increase applies immediately with a prorated charge, a price decrease applies with a
  prorated credit or is deferred. Route to Ship's copy, on the same platform, says "Upgrades
  take effect immediately. Downgrades apply at the end of your current billing period." §5.4
  takes this up.
- **Detection can land anywhere.** `SubscriptionPlan.resolve` runs on every `/app` page load,
  every member page load, every socket connect, and any future Flow action path. The first
  request after the cache expires is the one that learns about the change, and it may be a
  request with no merchant at the other end.
- **Members are cheap to remove and cheap to re-add.** `Member` is `{ id, shop, email,
createdAt }`. Deleting a row cascades `TeamMember` and revokes sign-in; run history survives
  because `WorkflowRunStep` snapshots `startedByEmail`, `completedByEmail`, and `teamName`.
  Re-adding an email mints a new id and the merchant re-assigns teams.
- **The member gate is a single function.** `requireMember` is the only path to the member
  area, for page loads, server functions, and the socket connect. Whatever rule decides who is
  in belongs there.

The consequence of the first three points is the central design constraint: **any policy that
requires doing something at the moment of detection is wrong**, because the moment of detection
is unpredictable and may be a webhook. The policy has to be a pure function of the current plan
and the current data, evaluated whenever anyone asks.

## 4. Member policies

### 4.1 The options

| Policy                                  | What happens on downgrade                                                                                        | State added                             | Needs a detection moment | Gameable                                                       | Merchant experience                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A. Block adds only (today)              | Nothing. Existing members keep access; no new adds.                                                              | None                                    | No                       | **Yes.** Upgrade, add 10, downgrade, keep 10 on a Basic price. | Invisible. Too generous to be a plan limit.                                                                     |
| B. Delete down to the limit             | Delete the newest N-limit members.                                                                               | None                                    | **Yes**                  | No                                                             | Hostile. Team assignments are lost and the merchant did not choose who.                                         |
| C. Deactivate down to the limit         | Flip an `active` flag on the newest members; merchant can swap active and inactive within the limit.             | `Member.active`, activate/deactivate UI | **Yes**                  | No                                                             | Good, but the deactivation itself happens without the merchant present, and every surface must honour the flag. |
| D. Deactivate everyone, force a choice  | Flip every member inactive; merchant activates up to the limit.                                                  | Same as C                               | **Yes**                  | No                                                             | Worst of C: the floor stops until the merchant notices, and a webhook can trigger it.                           |
| E. Derived seats by `createdAt`         | Nothing is written. The first `maxMembers` members by `createdAt` have access; the rest are refused at the gate. | None                                    | **No**                   | No                                                             | Deterministic and explained on the members page. Merchant removes a member to let the next one in, or upgrades. |
| F. Derived seats plus explicit ordering | E, but the merchant can reorder seat priority.                                                                   | `Member.seatOrder`                      | No                       | No                                                             | E with choice. Only worth it if E's "remove to free a seat" proves too blunt.                                   |

A, B, and D are out on their own rows. The real comparison is C against E.

### 4.2 Why E over C

C is the design in the prompt: active and inactive members, deactivation on downgrade, the
merchant swaps within the limit. It gives a good result, but it gets there by storing a
decision that Baton has to make at a moment it cannot pick. E gives the same result by refusing
to make a decision at all.

- **E has no detection problem.** The rank is computed from `createdAt` and the plan on every
  gate check. A downgrade learned about inside a webhook changes nothing except the answer the
  next member request gets. C has to write the flags somewhere, and if the write happens in a
  webhook handler the merchant finds out from a confused employee.
- **E is one rule, stated once.** "A member has a seat when fewer than `maxMembers` members
  were added before them." That is a `Domain` predicate with a test whose title is the rule,
  which is the project convention. C is a rule about the flag plus a rule about when the flag
  gets written plus a rule about what an inactive member sees on each surface.
- **E cannot be gamed.** Whatever the plan history, only the first N by `createdAt` are in on
  Basic. C cannot be gamed either, but only because of the downgrade write, which is the fragile
  part.
- **E reuses the only verb the members page has.** Remove exists. Deactivate and activate would
  be two new verbs whose only purpose on a Pro shop is to prepare for a downgrade, which is the
  "functionality that just makes things more complex" the prompt warns against. On E, a Pro
  merchant with 10 members has nothing to manage.
- **E's cost is one indexed count per member request**: members of this shop with an earlier
  `createdAt`. The existing `unique (shop, email)` index does not cover it, so add
  `Member (shop, createdAt)`. That is the same order of cost as the `findMemberAccess` query
  already on the path.

What E gives up: a merchant who wants member 7 to keep a seat and member 2 to lose it must
remove member 2. Member 2's history survives and they can be re-added later, but their team
assignments are lost and they re-enter at the back of the queue. At 3 to 10 seats this is a
handful of clicks. If it turns out merchants want to keep the roster and choose seats, F adds a
`seatOrder` column without changing the gate rule, and C is never needed.

### 4.3 What the merchant sees on E

- **Home and members page, over the limit:** a critical banner. "Your plan includes 3 members.
  Only the 3 oldest members can sign in until you remove members or upgrade." The members list
  shows a `No seat` badge on the members outside the limit, in `createdAt` order so the cutoff
  is visible. Two actions: Remove, Manage plan.
- **A member without a seat:** `requireMember` sends them to a page like the existing
  `/shop/$shop/lapsed` one. "Your shop's plan does not include a seat for you. Ask the shop
  owner." The socket gate answers `402` as it does for a lapsed shop.
- **Before the downgrade lands (§5.3):** the same banner in warning colour. "Your plan changes
  to Basic on 14 Oct. Basic includes 3 members; you have 9. Remove members before then or the 3
  oldest keep their seats."

### 4.4 Revoking open sockets

`revalidate` already closes every socket when a handle becomes none. The same has to happen
when a handle changes, because a member outside the new limit may have a tab open with a
keepalive that never re-asks the gate. Widen the condition from "handle became null" to "handle
changed". The revoke closes seated members too; they reconnect and pass.

## 5. Detecting the plan change

### 5.1 The two signals and what each one is good for

| Signal                           | Fires when                                             | Reliable                                                           | Carries                                                                                       | Use it for                                                                                  |
| -------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `plan_handle` redirect to `/app` | Merchant completes the hosted pricing page             | No. Browser-based, can be abandoned                                | A hint only; Baton already revalidates against the Partner API and never stores the parameter | Fast path so an upgrade grants headroom on the very next page view. Already implemented.    |
| Partner API revalidation         | Cache older than 24 h, or the contract boundary passed | Yes, eventually. The boundary clamp pins the deadline to cycle end | `items[].handle`, `currentBillingCycle`, `trialEndsAt`, `pendingUpdate`, `cancelAtEndOfCycle` | The only source of truth. Every downgrade that is deferred lands here, not on the redirect. |

The redirect is a latency optimisation for upgrades. It is not, and cannot be made into, the
place a downgrade is handled, because when the merchant clicks Basic the Partner API still
answers Pro with `pendingUpdate` set to Basic. The change lands at the cycle boundary, when no
browser is involved, and the boundary clamp already schedules the revalidation for that
instant plus five minutes. The tree has the right detection design; it only lacks a policy that
tolerates it, which §4 supplies.

### 5.2 Why polling from a webhook is fine once the policy is derived

A webhook that finds the cache stale calls the Partner API, writes the new handle, and returns.
On E nothing else needs to happen. The next member request computes a different rank, the next
merchant page view shows the banner. The Partner API's published limit is 4 requests per second
per client, but in practice `activeSubscription` is flow-controlled rather than hard-limited:
bursts are delayed, not refused. One call per shop per day plus one per contract boundary is
far under either reading.

One caveat worth keeping: the Flow action path treats `SubscriptionPlanError` as a transient
`429`, so a Partner API outage during a webhook does not become a terminal rejection. Keep that
behaviour.

### 5.3 Cache the scheduled change

Add `pendingUpdate { items { handle } }` and `cancelAtEndOfCycle` to the query in
`ShopifyPartner.ts`, and two columns to `ShopSession`: `pendingPlanHandle text` and
`planBoundaryAt integer` (the cycle end already read for the clamp, currently discarded after
computing the deadline). Inline into `migrations/0001_init.sql` per the no-new-migrations rule.

This gives the home page "changes to Basic on 14 Oct" and the members page its early warning,
and it costs nothing at detection time. A cancellation scheduled for cycle end shows the same
way ("Your subscription ends on 14 Oct").

### 5.4 Downgrade timing: what Baton can and cannot choose

The question raised in review: can Baton make downgrades apply at the end of the current
billing period, so the merchant pays the month they committed to and cannot upgrade for a day
and drop back, and is that the right policy?

**Baton cannot choose.** There is no timing setting on an App Pricing plan and no mutation an
app can call to schedule or defer a merchant's own plan change. Shopify applies its proration
rules on the hosted page and the app learns the outcome from `items` and `pendingUpdate`. The
only timing control an app has is on cancellation, through `appSubscriptionCancel`'s
`deferCancellation` and `prorate` flags, and that mutation is for the app cancelling a merchant,
not for a merchant changing plans.

**What Shopify most likely does** is the shape Baton wants anyway: upgrades immediate with a
prorated charge for the remaining days, downgrades deferred to the cycle boundary with
`pendingUpdate` set. Two pieces of evidence: `pendingUpdate` exists and is described only in
terms of "the next billing cycle", and Route to Ship advertises exactly that behaviour on the
same platform. The alternative, an immediate downgrade with a prorated credit, is documented
only on the legacy Billing API page.

**Either way the gaming concern is small.** Under a deferred downgrade, upgrading for a day
costs a full Pro month. Under an immediate downgrade with credit, upgrading for a day costs one
day of the Pro price, which is a fair price for a day of Pro. Neither yields a Pro-shaped shop
on a Basic price, because policy E computes seats from the plan in force at each request, and
the order quota is a monthly count against the plan in force when the page is viewed.

Recommendation: design for "upgrades immediate, downgrades deferred", and treat the dev-store
switch as the first step of implementation rather than a separate probe. The billing E2E spec
already switches a dev store between the two plans headed; adding `pendingUpdate` to the query
(§5.3) and reading it on the admin shop page after a Pro to Basic switch answers the question
in one run. If it turns out immediate, the only thing that changes is that the early-warning
banner in §4.3 never has a date to show.

### 5.5 A timely signal when the redirect is lost

Upgrades are the case that hurts: a merchant pays for Pro, the welcome redirect fails, and the
cache holds Basic for up to a day. Three ways to close that gap:

| Option                                                      | Cost                                                               | Covers                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| A. Shorten the cache to minutes, as Shopify's example does  | One Partner call per shop per few minutes of merchant activity     | Every path, including changes made from the Shopify admin billing card |
| B. Shorten the cache on the Manage plan click               | One server function; sets `planHandleExpiresAt` to now plus 15 min | Every change that starts from Baton's own button                       |
| C. Nothing; rely on the boundary clamp and the daily expiry | Zero                                                               | Deferred changes only; an upgrade waits up to a day                    |

Checked against the schema, because review asked whether the row stores a recorded-at rather
than a deadline. It stores the deadline: `ShopSession.planHandleExpiresAt integer` in
`migrations/0001_init.sql`, written by `Repository.updateShopSessionPlan` as
`update ShopSession set planHandle = ?, planHandleExpiresAt = ?`, and read by
`SubscriptionPlan.cachedStatus` as `now >= planHandleExpiresAt` means miss. The boundary clamp
depends on this shape: it pins the deadline to the cycle end at write time rather than storing
the boundary and recomputing. So B is one statement on the existing column: keep `planHandle`,
set `planHandleExpiresAt` to the lesser of its current value and now plus 15 minutes. No new
column, no new concept, and the admin page's "fresh until" line shows the effect.

Recommendation: B. The Manage plan button already goes through the server to build the pricing
URL, so a server function that shortens the deadline before opening the page is a few lines and
adds no steady-state traffic. It also covers cancellations started from the button. The path it
misses, a merchant changing plans from the app's billing card inside Shopify admin without
opening Baton, still gets the welcome redirect (the welcome link applies to any plan approval)
and falls back to C, which is acceptable because downgrades and cancellations are deferred to
the boundary the clamp already targets.

### 5.6 What not to build

- **A scheduled poll** (alarm or cron) that walks every shop. The lazy revalidation already
  bounds staleness to a day and a shop nobody is using does not need a fresh plan.
- **The Partner API `events` query** as a change feed. It exists (`SUBSCRIPTION_UPDATED`,
  `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_FROZEN`) and would be the right tool for an audit page,
  but as a change feed it is polling with extra steps.
- **Trusting `plan_handle`.** The parameter is untrusted input on a URL. The tree already treats
  it as a refresh trigger only.

## 6. Orders

### 6.1 The soft limit under upgrade and downgrade

The quota is compared in the Worker against the Durable Object's counter on each page view, so
it is already a derived rule in the sense of §3: a downgrade mid-month with 600 orders counted
against a new 250 quota shows the over-quota banner on the next page view and nothing else
changes. An upgrade clears it the same way. No policy work is needed for the soft limit.

### 6.2 Overage billing: recommendation and strength

**Recommendation: turn on usage overage for orders. Strong.** The reasoning is short:

1. A hard stop is out (§6.3). Orders past the quota must keep syncing.
2. With no hard stop and no overage, the order limit is copy, not a limit. A Basic shop at
   1,000 orders a month pays the Basic price and sees a banner. The plans then differ only by
   seats, and seats alone do not track the value a shop gets from Baton.
3. Overage is the only third option, and it is the one the market leader in this category
   uses and sells as a feature: "we never block your production work".
4. Under App Pricing it is configuration plus one event per counted order. Shopify does the
   arithmetic, the included units, the invoice, and the proration on plan changes.

What it costs, from `setup-usage-charges.md` and `build-billing-event.md`:

| Piece                   | Detail                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard               | One meter per plan, same handle on both (say `order_synced`), fixed pricing, included units 250 and 1,000, unit price per plan. Cheaper per order on Pro, which is the upgrade nudge.                                                                                                                      |
| Credential              | An API key from the Dev Dashboard with the `write_global_api_app_events` scope. A second secret beside the Partner token, held in the Worker.                                                                                                                                                              |
| Event per counted order | `POST https://api.shopify.com/app/2026-07/events` with `shop_id` (the shop GID already on `ShopSession`), `event_handle`, `timestamp`, a permanent `idempotency_key`, `attributes.value: 1`. Every counted order, not only overage; Shopify applies the included units.                                    |
| Where it fires          | The same place `ShopUsage.ordersThisMonth` is incremented, on first insert of a paid in-cycle order. The count and the event share one rule, so they cannot disagree about what an order is.                                                                                                               |
| Reversal                | A negative-value event with a fresh idempotency key. The earlier decision not to decrement on cancellation should flip once money is attached: a cancelled order inside the cycle is reversed.                                                                                                             |
| Delivery                | The API always answers `202`. Failures show only in the Dev Dashboard log (`NO_SUBSCRIPTION`, `PERIOD_CLOSED`, `IDEMPOTENCY_KEY_ERROR`, ...). Baton needs an outbox: a small table in the Durable Object with the pending events, flushed with retry, so a network failure does not lose a billable order. |
| Reconciliation          | `activeSubscription.items[].usage { quantity }` reports what Shopify has counted this cycle. Compare it with the local counter on the daily revalidation and log a warning on divergence. This turns the silent `202` into an observable.                                                                  |
| Uninstall               | 24 hours to flush after uninstall, then `PERIOD_CLOSED`. The uninstall webhook flushes the outbox before deleting the session row.                                                                                                                                                                         |
| Constraints             | Monthly billing only (no yearly plan, already the case). No usage caps: a merchant cannot set a spend ceiling and there is no approaching-cap notice. If Baton ever wants a ceiling it is a local rule that stops emitting, not a Shopify feature.                                                         |
| Testing                 | A same-org dev store holds a real contract at $0, so meters, events, and the usage figure all exercise without charges.                                                                                                                                                                                    |

Trade-offs, honestly:

- **Billing surprise.** No cap means a shop that triples in a month gets a bill it did not
  approve line by line. Mitigation is the in-app meter ("620 of 250 orders, $55.50 in overage
  so far") and the tier ladder that makes Pro cheaper past a known break-even. Route to Ship
  lives with the same exposure.
- **Silent failure.** The `202`-always API means a misconfigured handle bills nothing and says
  nothing. Reconciliation against `usage.quantity` is not optional.
- **Two counting rules become one.** The counter moves from calendar month to billing cycle
  (§6.4) so the home page and the invoice agree. That is a one-line change to the month key
  today and a rewrite under a live meter later.
- **Cancellation semantics.** Reversal events are simple, but "cancelled" has to be defined once:
  the order's `cancelledAt` set inside the cycle in which it was counted. A cancellation in a
  later cycle is not reversed, matching Route to Ship's "refunded and cancelled orders don't
  count" only approximately. Acceptable.

Implementation size: a `ShopifyAppEvents` service beside `ShopifyPartner`, an outbox table and
flush in `OrderRepository`, an `updateShopSessionUsage` or an extra field on the plan cache for
the reconciled quantity, meter configuration in the dashboard, and the counter key change. On
the order of the member-cap work, not the retention work.

### 6.3 Why not a hard stop

Unchanged from the earlier research: a missed order in a made-to-order shop is a missed
shipment. The App Store requirement 1.2.3 also wants upgrades and downgrades to work without
contacting support, which a hard stop that strands orders would make awkward. This is the
premise of §6.2: with the hard stop excluded, overage is what makes the limit real.

### 6.4 Cancelled orders: reverse inside the cycle

Recommendation: yes, reverse a cancellation, but only when the order was counted in the
current cycle, and only for cancellation, not refund.

- **Fairness and copy.** The pricing page will say what Route to Ship's says, "cancelled orders
  don't count", because a merchant who never made the thing should not pay for it. A refunded
  order was made and shipped; it counts.
- **Cost is one negative event and one decrement.** The cancellation webhook already lands in
  `upsertOrder` and sets `cancelledAt`; `countTowardQuota` already skips orders that arrive
  cancelled. The new work is the transition: an order that was counted (`fullyPaid`, fresh,
  in-cycle) and now has `cancelledAt` set for the first time emits `attributes.value: -1` under
  a fresh idempotency key and decrements the counter. `deleteSeedOrders` already shows the
  decrement pattern with `max(0, ordersThisMonth - n)`.
- **Cross-cycle cancellations are not reversed.** Shopify closes the period, `PERIOD_CLOSED`
  would reject the event, and the local counter has already reset. State this on the pricing
  copy as "cancelled within the billing period".
- **Gaming is negligible.** Cancelling a real order after fulfilment to avoid a $0.15 charge
  wrecks the merchant's own Shopify reports.

The order needs a per-order marker of "counted this cycle" so the reversal fires once and only
for counted orders. A nullable `countedAt` on `ShopOrder`, set by `countTowardQuota`, is
enough and doubles as the idempotency key input for both events.

### 6.5 An enterprise ceiling on orders

Review asked whether, with overage uncapped, Baton also needs a hard ceiling so a shop cannot
grow the Durable Object without bound toward the 10 GB SQLite limit.

**Where the storage cliff actually is.** The verification record in
`docs/limits-and-plans-plan.md` §17 measured 122,880 bytes for 137 orders with 218 line items,
about 900 bytes per order before runs. Call it 2 KB per order with its runs and steps. With
90-day retention the working set is three months of orders, so:

| Monthly orders | Retained rows | Approximate bytes | Against the 2 GB soft guard | Against 10 GB |
| -------------- | ------------- | ----------------- | --------------------------- | ------------- |
| 1,000          | 3,000         | 6 MB              | 0.3%                        | 0.06%         |
| 10,000         | 30,000        | 60 MB             | 3%                          | 0.6%          |
| 100,000        | 300,000       | 600 MB            | 30%                         | 6%            |
| 300,000        | 900,000       | 1.8 GB            | 90%                         | 18%           |

Storage is not what limits Baton at any volume a made-to-order shop reaches. Route to Ship's
founding customer peaked at 1,651 orders a month. The constraints that bite first are
elsewhere: one Durable Object per shop is single-threaded, so webhook throughput and the cost
of `reconcileAll` walking every open order scale with the live working set, and the open-run
ceiling of 5,000 already fences that.

**So the ceiling is positioning, not protection, and it should still exist.** Every other
growth dimension has a plan-independent constant (teams, workflows, open runs, storage), and
"we don't support enterprise volume" is a product statement worth encoding rather than leaving
to the storage guard, which fires late and only on the bulk path.

Recommendation: add `ShopLimits.maxOrdersPerCycle`, provisional 10,000, ten times Pro's
included units. Below it, overage bills. At it, Baton stops counting and stops syncing new
orders for the rest of the cycle, shows a critical banner ("Baton is built for shops under
10,000 orders a month; syncing resumes on <cycle end>"), and logs it. This is the one place a
hard stop on orders is acceptable, because the shop is outside what Baton sells, and it is the
storage guard's cousin: same shape, fires earlier, on a number the merchant can understand.
Keep the storage guard as the second, independent fence.

### 6.6 Move the counter to the billing cycle now

Decided in review. `ShopUsage.monthKey` becomes a cycle key derived from
`currentBillingCycle.startTime`, cached on `ShopSession` with the §5.3 columns and passed to
the Durable Object on the calls that count. The home page copy changes from "this month" to
"this billing period" with the period's end date. Nothing else depends on the key, so this is
the moment to change it.

## 7. Remove `BILLING_ENABLED`

Decided in review: now, as its own change, before the rest of this document. The hand-off is
`docs/remove-billing-flag-plan.md`; it inventories every site and needs no further research.
The one fact worth keeping here: the integration tests already run with the flag on and seed
the plan cache, so removal changes no test behaviour.

## 8. Home page

Bang's home is the model and Baton's is a stripped port: Bang has progress meters per
dimension, an 80 to 90 percent warning ratio, an over-capacity state distinct from at-capacity
because the remedies differ, and a banner with both the cleanup action and Manage plan. Baton
has "n of m" text lines and `QuotaBanners`.

Worth carrying over, in order: the over-capacity versus at-capacity distinction for members
(at 3 of 3, "remove or upgrade"; at 9 of 3, "6 members have no seat" with Remove on the
members page and Manage plan), the scheduled-change line from §5.3, and the meters. The
reconcile-on-click that Bang has for memory is not needed: on E there is nothing to reconcile.

## 9. Decisions taken (annotation review, 2026-09-19)

1. **Plan-tied limits stay orders and members.** Accepted as in §2.
2. **Member policy is E**, derived seats by `createdAt`, no stored state. F is held back until
   a merchant asks to choose seats without removing anyone. C is rejected.
3. **The seatless-member page reuses the lapsed page** with a second message.
4. **Plan-change timing:** design for upgrades immediate, downgrades deferred. Confirm on the
   dev store as the first step of implementation, not as a separate probe. §5.4.
5. **Shorten the plan cache on the Manage plan click.** §5.5, option B.
6. **Orders: usage overage is on, from the start of the implementation plan.** The counter
   moves to the billing cycle in the same plan. §6.2, §6.6.
   - **Cancelled orders are reversed inside the cycle they were counted in.** §6.4.
   - **An enterprise ceiling on orders per cycle**, plan-independent, provisional 10,000 and
     expected to be tuned. §6.5.
7. **Remove `BILLING_ENABLED` now, as its own change**, per `docs/remove-billing-flag-plan.md`.
8. **Home page carries Bang's treatment**: over-capacity distinct from at-capacity, the
   scheduled-change line, meters. §8.
9. **The Partner API limit is soft for `activeSubscription`**: flow control, not refusal.

## 10. Open

Nothing. Every recommendation in this document has been accepted; the next document is the
implementation plan.
