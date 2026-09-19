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

**Status: research only. Nothing implemented.** Open questions for the project owner in §9.

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
4. **Downgrades under App Pricing are deferred to the end of the billing cycle** for paid to
   free, and `pendingUpdate` on `activeSubscription` is the only signal for a scheduled change.
   This is good news for policy: the merchant has the rest of the cycle to get under the limit,
   and Baton can say so on the home page. It is also why the redirect leg must never be the
   place a downgrade is "handled": on a downgrade the redirect arrives while the old plan is
   still active. §5.
5. **Cache `pendingUpdate` beside `planHandle`** so the home page can warn ahead of a scheduled
   downgrade. One extra column and one extra field in the existing query. §5.3.
6. **Orders: keep the soft limit.** Overage billing through the App Events API is the likely
   next step and changes nothing about upgrade or downgrade policy, but it forces the quota to
   count per billing cycle rather than per calendar month. Decide that before overage, not
   after. §6.
7. **Remove `BILLING_ENABLED`.** It exists because Baton had no plans; it now has them in every
   environment. Tests get a stub `SubscriptionPlan` layer instead of a production bypass. §7.

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
- **A downgrade takes effect at the end of the cycle, not on the click.** Paid to free is
  documented as deferred (`setup-subscription-charges.md`, "Plan downgrading"). Paid to paid is
  documented only through `pendingUpdate`, which "contains the items that are active at the
  start of the next billing cycle" (`active-subscription.md`). Route to Ship's copy says the
  same: "Upgrades take effect immediately. Downgrades apply at the end of your current billing
  period." Whether Pro to Basic is deferred or immediate with a prorated credit is the one
  thing to verify on the dev store before building on it; see §9.
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
merchant page view shows the banner. The 4 requests per second Partner API limit is org-wide;
one call per shop per day plus one per contract boundary is far under it even at thousands of
shops.

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

### 5.4 What not to build

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

### 6.2 Overage billing, if and when

Facts that bear on the decision, from `setup-usage-charges.md` and `build-billing-event.md`:

- A plan carries a base fee plus up to 5 meters, each with included units and fixed, graduated,
  or volume tiers. "Basic $29 with 250 included orders and $0.15 per extra order" is dashboard
  configuration, and it is Route to Ship's ladder verbatim.
- Baton reports usage by posting one event per counted order to the App Events API, with a
  permanent idempotency key. Shopify applies the included units, so every counted order is
  reported, not only the overage. Negative values reverse an order. The API always answers
  `202`; failures show only in the Dev Dashboard log.
- Usage bills monthly and **has no cap**. A merchant cannot set a spend ceiling and Shopify
  sends no approaching-cap notice. Any ceiling is Baton's own code before it emits an event.
- Usage is per **billing cycle**, anchored on subscription start. The current counter is per
  **calendar month**. With overage, the counter has to move to the cycle or the home page and
  the invoice disagree. `currentBillingCycle.startTime` is on `activeSubscription` and would be
  cached with §5.3's columns.
- Route to Ship is the only competitor that meters, and it sells it as "we never block your
  production work" rather than as a penalty. That is the framing to match if Baton follows.

Upgrade and downgrade interaction: Shopify prorates the base fee and applies each cycle's
included units to that cycle's plan. Baton's only job is to keep emitting events with the
right `shop_id`; which plan the events bill against is Shopify's. What is not documented is how
included units behave when the plan changes mid-cycle. Verify on the dev store before turning a
meter on.

Recommendation: stay on the soft limit. Move the counter to the billing cycle now, while
nothing depends on it, so that turning on a meter is "also post an event" and not a counter
rewrite. Keep the calendar-month copy off the pricing page until that is decided (§9).

### 6.3 Why not a hard stop

Unchanged from the earlier research: a missed order in a made-to-order shop is a missed
shipment. The App Store requirement 1.2.3 also wants upgrades and downgrades to work without
contacting support, which a hard stop that strands orders would make awkward.

## 7. Remove `BILLING_ENABLED`

The flag exists because Baton once had no plans. It now has them in local, and staging and
production will get theirs when those apps are created. Keeping a production bypass that grants
the widest tier is a standing risk with no remaining purpose.

Removal touches: `SubscriptionPlan.layerNoDeps` (drop the `Config.boolean` branch and the
`granted` short-circuit), `Domain.DEFAULT_PLAN_HANDLE` and its JSDoc, `Domain.PlanHandle`'s
JSDoc paragraph about the flag, the JSDoc on `MemberAccess.requireMember`, the comment in
`app.index.tsx`, all three `vars` blocks in `wrangler.jsonc`, `.env.example`, and the README
"Billing" section. `wrangler.jsonc` and the README both still describe the flag as `"false"`
while it is `"true"` in all three environments, which is drift the removal ends.

What the tests need instead: anything that currently relies on the bypass gets a stub
`SubscriptionPlan` layer returning a fixed `PlanStatus`. Candidates are
`test/integration/subscription-plan.test.ts`, the member-area tests, and the seed route. The
E2E suite runs against a same-org dev store that holds a real $0 contract, so it needs no stub.
`MAX_ENTITLEMENTS` stays for fixtures that need a ceiling and no shop.

## 8. Home page

Bang's home is the model and Baton's is a stripped port: Bang has progress meters per
dimension, an 80 to 90 percent warning ratio, an over-capacity state distinct from at-capacity
because the remedies differ, and a banner with both the cleanup action and Manage plan. Baton
has "n of m" text lines and `QuotaBanners`.

Worth carrying over, in order: the over-capacity versus at-capacity distinction for members
(at 3 of 3, "remove or upgrade"; at 9 of 3, "6 members have no seat" with Remove on the
members page and Manage plan), the scheduled-change line from §5.3, and the meters. The
reconcile-on-click that Bang has for memory is not needed: on E there is nothing to reconcile.

## 9. Questions for the project owner

1. **Is Pro to Basic deferred to cycle end, or immediate with a prorated credit?** Shopify
   documents deferral only for paid to free; Route to Ship's copy says all downgrades defer.
   One switch on the dev store settles it, and the answer decides whether the early-warning
   banner in §4.3 ever shows for a paid-to-paid downgrade. Policy E works either way.
2. **Seat rule: oldest members keep seats (E), or add an explicit seat order (F) now?**
   Recommendation E, with F held back until a merchant asks.
3. **Count orders per billing cycle now, ahead of overage?** Recommendation yes, since the
   counter is unobservable to merchants except through the home page copy, and moving it later
   means moving it under a live meter.
4. **Remove `BILLING_ENABLED` in this change or its own?** Recommendation its own, first, since
   it is mechanical and every other item here assumes plans are always on.
5. **Does the over-limit member page reuse the lapsed page, or get its own?** The messages
   differ ("plan lapsed" versus "no seat for you") but the shape is identical. Recommendation:
   one route with two messages.
