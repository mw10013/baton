# Limits, plans and cost

2026-10-08. What bounds one shop, what it costs Baton at the margin, what the two plans should include and charge, and which hard limits sit above the meters. The cost model is `pnpm cost` (`scripts/cost.ts`, model in `scripts/lib/cost.ts`); every figure below is its output or its input.

## The short version

- Storage is not the constraint. A year of 5,000 orders a month, with items, runs and tasks, is about 0.5 GB of the object's 10 GB. Storage at $0.20 per GB-month is cents.
- Cost is not the constraint either, up to the shops the app is for. The 25-member, 2,000-order shop costs about $16 a month. The dominant line is object rows read, and it comes from one place: after every publish, the first read of each list key re-reads the whole list, so cost is `publishes × open orders × distinct list keys`. Everything else is under a dollar.
- The object's single thread is the constraint, and it is a fan-out constraint: a publish costs the object one short read per live screen. The model puts a 50-member shop at 5,000 orders a month at 17% busy in its busiest hour, and a 100-member shop at 10,000 a month at 52%, where queueing starts to show. That is the fence, and the target is to stay far under it: a Durable Object's latency is its weak point, so the ceilings are set where the busiest hour stays under 20%, not near the 1,000-a-second soft limit.
- The UI is the softer constraint: every index pages at 25 with search, so a few hundred of anything is workable and a thousand is not.
- The current plans include 20 and 30 orders a cycle. Route to Ship includes 250 and 1,000 at $39 and $99. A 200-order Basic shop pays Baton $56 and Route to Ship $39. The recommendation is to move the included orders to 200 and 1,500 and keep the monthly charges.
- Recommended hard limits: 50 members, 2,500 open orders (as now), 200 workflows, 50 teams (as now), 20 tasks a workflow (as now), 2 connections and 2 sign-in sessions a member, and a size cap on line-item properties. No hard limit on counted orders a cycle: the open-order ceiling is the one that bounds cost and load.

## Words used below

Vocabulary words, from the maps in `src/lib/Domain.ts` and `src/lib/domain/`: shop, member, merchant (Shopify staff with the app open), order, open order, counted order, run, task, workflow, team, publish, invalidation, socket, connection (the object's end of one socket, from identify to close; the connection table on `ConnectionRole`), live (a screen the object re-reads on every publish), memo, ceiling, included, meter, seat, billing cycle. The model's inputs are the shop's numbers (members, merchants, open orders, orders a month, and the rest of `Shop` in `scripts/lib/cost.ts`), and a _live screen_ is a live screen whose window is visible, so it re-reads on every publish rather than deferring. "The account" is Baton's one Cloudflare account, whose included usage every shop shares.

## What is limited today

| limit                     | value                  | where                                  | kind                      | enforced                                                                  |
| ------------------------- | ---------------------- | -------------------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| orders included per cycle | 20 / 30                | `ENTITLEMENTS` in `domain/Billing.ts`  | plan, metered past it     | the meter bills; nothing refuses                                          |
| members included          | 3 / 10                 | `ENTITLEMENTS`                         | plan, metered past it     | the meter bills; nothing refuses                                          |
| open orders               | 2,500                  | `ShopLimits.maxOpenOrders`             | ceiling, plan-independent | a new order is refused and `ordersLimitedAt` raises the banner            |
| members                   | 12                     | `ShopLimits.maxMembers`                | ceiling, plan-independent | Add member refuses                                                        |
| teams                     | 50                     | `ShopLimits.maxTeams`                  | ceiling                   | Create team refuses                                                       |
| workflows                 | 1,000                  | `WorkflowLimits.maxWorkflows`          | guard against a runaway   | Create workflow refuses                                                   |
| tasks a workflow          | 20                     | `WorkflowLimits.maxTasks`              | document size             | Add task refuses                                                          |
| line items an order       | 250                    | `ShopLimits.maxLineItemsPerOrder`      | fetch size                | the rest are not stored                                                   |
| order retention           | 365 d                  | `ShopLimits.orderRetentionDays`        | storage                   | the sweep deletes, 200 rows a pass, at most every 6 h on the webhook path |
| name, instructions, note  | 64 / 500 / 2,000 chars | `ShopWork.ts`                          | field size                | schema and the text-limit part                                            |
| invalidation throttle     | 2 s                    | `INVALIDATION_THROTTLE_MS`             | fan-out                   | a live screen re-reads at most once per window                            |
| list memo keys            | 32                     | `MEMO_CAPACITY` in `agent/ShopWork.ts` | memory                    | the cache evicts                                                          |
| list pages                | 25                     | `INDEX_PAGE_SIZE`, `ORDERS_PAGE_SIZE`  | UI                        | server-paged                                                              |

Every JSDoc on these says "provisional". The plan numbers also live in the Partner Dashboard and `README.md`, which must move with them.

## What bounds a shop

### Storage: the 10 GB object

From the DDL on `initializeSchema`: an order is one `ShopOrder` row, one `OrderLineItem` row per item, one `Run` per matched item and one `RunTask` per task of each run. The model takes 400, 600, 700 and 350 bytes a row and 40% for indexes. An order with two matched items and four tasks a run is about 6 KB. Orders stay a year, open or closed, so stored orders are twelve months of intake:

| orders a month | stored orders | storage | share of 10 GB |
| -------------- | ------------- | ------- | -------------- |
| 250            | 3,000         | 25 MB   | 0.2%           |
| 1,000          | 12,000        | 99 MB   | 1.0%           |
| 5,000          | 60,000        | 494 MB  | 4.9%           |
| 10,000         | 120,000       | 988 MB  | 9.9%           |

The row limits (2 MB a row, 100 columns, 100 KB a statement, 100 bound parameters) matter more than the total. One of them is unguarded: `properties` on a line item and `lineItemProperties` on its run are JSON of whatever the storefront attached, and nothing caps their size (gap 2 below).

D1 holds `ShopSession`, `Member`, `Team` and `TeamMember`: a few rows a shop, and the 10 GB database limit is for the whole account, not a shop. Not a concern at any size here.

### The object's single thread

Cloudflare's figures (`refs/cloudflare-docs/.../durable-objects/best-practices/rules-of-durable-objects.mdx`, "Message throughput limits"): one object handles roughly 1,000 requests a second of pass-through, 500 to 750 with JSON parsing and validation, 200 to 500 with storage writes; the soft limit is 1,000 a second, past which requests queue and then fail as overloaded. Those are the numbers at which an object breaks, not the numbers to design to: every request on an object waits for the one before it, so latency climbs well before the limit. The ceilings below keep the busiest hour under 20% busy.

What reaches the object per shop:

- A webhook: one call, which fetches the order from Shopify inside the object. Wall time is billed while the fetch waits, and the thread is held for the duration of the write, not the fetch.
- A verb (Start, Done, Block, Cancel, Attach, Apply): one incoming socket message.
- A publish: nothing from the object's side but one outgoing frame per connection, which is free. Then every live screen re-reads, each a server function that calls the object once. The first read per list key after a publish is a miss and runs the query; the rest are memo hits.
- A navigation: one loader read, a hit between publishes.
- The keepalive: a ping every 240 s per socket, answered by `setWebSocketAutoResponse`, which costs nothing and never wakes the object.

So the per-publish cost to the thread is `live screens × hit` plus `distinct keys × miss`, and the number of publishes is `orders × (webhooks per order + items × (2 × tasks + 1))`. The worry is right in form: 500 live screens is 500 reads per publish. The model's answer is where it tips:

| shop                                     | peak object requests / s | object busy, busiest hour |
| ---------------------------------------- | ------------------------ | ------------------------- |
| 12 members, 1,000 orders a month         | 1.8                      | 1.7%                      |
| 25 members, 2,500 orders a month         | 8.1                      | 5.7%                      |
| 50 members, 3 merchants, 5,000 a month   | 30.9                     | 17.0%                     |
| 100 members, 3 merchants, 10,000 a month | 118.6                    | 52.4%                     |
| 500 members, 3 merchants, 10,000 a month | 574.8                    | 189% (over)               |

"Busy" is the share of the busiest hour the thread spends in reads and writes, with the busiest hour three times the average working hour (22 days of 8 hours). Past about 50% every read queues behind another and the live screens lag; past 100% the object is overloaded. Request rate alone never reaches the soft limit at these sizes; it is the serialized read time that does.

Two assumptions carry this table and neither is measured: a memo hit at 3 ms and a miss at 0.07 ms a row (the 586 ms over 9M rows measured 2026-10-03). The `ms=` instrumentation on `listOrders` and `readRuns` already logs both in local and staging; a bench that fills a shop and reads the log would replace both numbers (follow-up 1).

### The UI

Every index pages at 25 with search: workflows, teams, members, orders. The orders index has the position strip and a team filter. That shape of screen is fine to a few hundred rows and poor at a thousand: nobody pages 40 times. The hard limits below are set to what these screens carry, which is well under what storage or the thread would allow.

## The cost model

`pnpm cost` costs one shop a month at the marginal Workers Paid rates. It nets out no allowance: the account's included usage is already spoken for, so every shop is costed as the one past it. Rates, from `refs/cloudflare-docs` (`workers/platform/pricing.mdx`, `partials/durable-objects/durable-objects-pricing.mdx`, `partials/workers/d1-pricing.mdx`), USD:

| item                   | included a month (the account) | marginal rate    |
| ---------------------- | ------------------------------ | ---------------- |
| Worker requests        | 10 M                           | $0.30 / M        |
| Worker CPU             | 30 M ms                        | $0.02 / M ms     |
| object requests        | 1 M                            | $0.15 / M        |
| object duration        | 400 k GB-s                     | $12.50 / M GB-s  |
| rows read (object, D1) | 25 B                           | $0.001 / M       |
| rows written           | 50 M                           | $1.00 / M        |
| object storage         | 5 GB                           | $0.20 / GB-month |
| D1 storage             | 5 GB                           | $0.75 / GB-month |

Object storage billing starts 2026-01-07 per the docs' note. Incoming socket messages bill at 20 to one request; outgoing frames, protocol pings and auto-responses are free; duration is billed at 128 MB while the object is awake and not eligible to hibernate, which with hibernating sockets means only while a call runs.

Subcommands: `shop` (flags or `--preset`, `--json`), `ladder` (every preset), `rates` (the rates, limits and per-event assumptions). The ladder today:

| preset  | members | merchants | open  | orders / month | USD / month | per member | per order | storage | peak req / s | object busy |
| ------- | ------- | --------- | ----- | -------------- | ----------- | ---------- | --------- | ------- | ------------ | ----------- |
| solo    | 1       | 1         | 40    | 60             | $0.02       | $0.00      | $0.000    | 6 MB    | 0.0          | 0.1%        |
| small   | 5       | 2         | 150   | 250            | $0.19       | $0.00      | $0.001    | 25 MB   | 0.3          | 0.4%        |
| medium  | 12      | 2         | 500   | 1,000          | $2.21       | $0.01      | $0.004    | 99 MB   | 1.8          | 1.7%        |
| large   | 25      | 2         | 1,500 | 2,500          | $18.56      | $0.03      | $0.015    | 247 MB  | 8.1          | 5.7%        |
| ceiling | 50      | 3         | 2,500 | 5,000          | $72.64      | $0.07      | $0.028    | 494 MB  | 30.9         | 17.0%       |
| stress  | 100     | 3         | 2,500 | 10,000         | $194.96     | $0.13      | $0.038    | 988 MB  | 118.6        | 52.4%       |

The shop the 2026-10-03 research targeted (25 members, 2 merchants, 2,000 open, 2,000 a month) comes to $16.00, against that research's $17 with the memo. Rows read are 94% of it: 48,000 publishes, each re-reading two orders-index keys at 42 rows an open order and four workflows-list keys at 18 rows an open run. Every other line is under a dollar.

What this says about the levers:

- A member's marginal cost is cents: one more hit per publish. Members are not a cost problem; they are a thread problem, above.
- An order's marginal cost is cents too, and most of it is the publishes the order causes (six webhooks and nine verbs for two items of four tasks), each of which re-reads the lists once per key.
- The one cost lever worth having in reserve is clearing the memo per key rather than whole (`clearListMemo` runs `invalidateAll` on both caches). A verb on one run invalidates every orders-index filter and every team set. Not proposed now: $16 at the target shop does not need it.

What the model does not measure, in order of how much it moves the answer: the hit and miss times (above), the webhook's 350 ms wall time (a typical Admin API round trip; it drives duration, which is $0.02 at the target shop, so it barely matters), the row bytes, and the D1 rows a server function reads for the session (5). The sweep's deletes are counted as writes in the month the order arrives, a year early, which is conservative.

## Route to Ship and the field

From `refs/route-to-ship/pricing.md` and `listing.md`, USD, monthly, 14-day trial, "every feature on every plan":

| plan       | price | users | orders a month | extra user | extra order |
| ---------- | ----- | ----- | -------------- | ---------- | ----------- |
| Free       | $0    | 1     | 25             | upgrade    | not stated  |
| Production | $39   | 3     | 250            | $15        | $0.15       |
| Team       | $99   | 10    | 1,000          | $12        | $0.10       |
| Floor      | $249  | 30    | 5,000          | $10        | $0.05       |
| Enterprise | $499  | 100   | unlimited      | $6         | none        |

Orders count once per calendar month when synced; refunded and cancelled orders do not count. No hard order cap on a paid plan ("we never block your production work"). Workflows and departments are unlimited on every plan. The listing shows four plans and leaves Enterprise out.

The rest of the field is one flat plan each and no usage: Kanbanify $7 (unlimited orders and users, one board), Maker's Production View $15, BenchCue $7, MakerBatch free / $15 / $19 by items in production at once (25 / 200 / unlimited). These are the floor of what a merchant will pay for a production view; Route to Ship is the ceiling and the only one that prices seats and volume. Every one of them trials, 14 days except BenchCue's 7.

## Recommendations

### Plans

Keep two plans and two meters, keep the monthly charges, and move the included orders to where the field is. The current 20 and 30 are far under: a Basic shop at 200 orders pays $29 + 180 × $0.15 = $56 against Route to Ship's $39.

| field                   | Basic, now | Basic, proposed | Pro, now | Pro, proposed |
| ----------------------- | ---------- | --------------- | -------- | ------------- |
| monthly charge          | $29        | $29             | $79      | $79           |
| trial                   | 14 days    | 14 days         | none     | 14 days       |
| orders included a cycle | 20         | 200             | 30       | 1,500         |
| order past included     | $0.15      | $0.12           | $0.10    | $0.05         |
| members included        | 3          | 3               | 10       | 10            |
| seat past included      | $15        | $12             | $10      | $7            |

Worked against Route to Ship. The last column is what the shop costs Baton in Cloudflare charges a month, from `pnpm cost`:

| shop                     | Route to Ship | Baton now  | Baton proposed | infrastructure |
| ------------------------ | ------------- | ---------- | -------------- | -------------- |
| 3 members, 200 orders    | $39           | $56        | $29            | $0.08          |
| 5 members, 250 orders    | $69           | $93.50     | $59            | $0.19          |
| 8 members, 600 orders    | $99           | $136 (Pro) | $79 (Pro)      | $0.77          |
| 12 members, 1,000 orders | $123          | $196 (Pro) | $93 (Pro)      | $2.21          |
| 25 members, 2,500 orders | $249          | $476 (Pro) | $234 (Pro)     | $18.56         |
| 50 members, 5,000 orders | $449 (Floor)  | $976 (Pro) | $534 (Pro)     | $72.64         |

Under Route to Ship at every row but the last, where Baton has no Floor tier and does not want one: 50 members is the fence, not a market. Infrastructure is under 15% of the charge at every row; it does not set the price, positioning does.

Why the included orders and not the price: the monthly charge is what the listing shows and what a merchant compares; the included allowance is what makes a 200-order shop's bill $29 rather than $56. The seat prices come down because a seat costs cents and Route to Ship's are the reference. The Pro order rate goes to $0.05 because a 2,500-order shop is the one Route to Ship takes at $249 and Baton wants under it.

What changes in code: `ENTITLEMENTS`, the README's plan table and top-feature lines, and the Partner Dashboard meters. Nothing else reads the numbers.

### Hard limits

Plan-independent, as now: the object never sees the plan, and a per-plan ceiling would put plan state in the object to fall out of sync (the reasoning on `ENTITLEMENTS`). The meters differentiate the plans; the ceilings fence the app.

| limit                        | now   | proposed | why                                                                                                                                                         |
| ---------------------------- | ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| members                      | 12    | 50       | 17% busy at 5,000 orders a month; 100 is 52%. Two pages of the members index. Twelve refuses a shop the app can serve.                                      |
| open orders                  | 2,500 | 2,500    | Keep. The quantity every list read is linear in and the one that bounds cost per order; 5,000 orders a month at a two-week turnaround is 2,500 open.        |
| counted orders a cycle       | none  | none     | The meter bills and nothing refuses, as Route to Ship. Cost per order is bounded by the open-order ceiling, so a cycle cap buys nothing but a refusal path. |
| workflows                    | 1,000 | 200      | Eight pages with search. Still a guard, not a promise; a shop near it has a tag design problem, not a size problem.                                         |
| teams                        | 50    | 50       | Keep. A team costs nothing to store or read; the only cost is the team filter's select and the member page's checklist, which carry 50 (decision 4).        |
| tasks a workflow             | 20    | 20       | Keep; the document size rule.                                                                                                                               |
| line items an order          | 250   | 250      | Keep.                                                                                                                                                       |
| connections a member         | none  | 2        | New (gap 1, decision 8). A member's share of the fan-out: one screen on a bench computer and one on a phone. The third connect closes the oldest.           |
| sign-in sessions a member    | none  | 2        | New (decision 8). Two devices signed in at once; a third sign-in revokes the oldest. This is what stops a login being shared across a floor.                |
| line-item properties an item | none  | 8 KB     | New (gap 2). Truncate past it on write, on the item and the run copy; the row limit is 2 MB and the stream holds an order whole.                            |
| order retention              | 365 d | 365 d    | Keep; 1 GB at 10,000 a month.                                                                                                                               |

## Gaps found

1. **Connections per member.** A member's screens are unbounded; each is a connection that re-reads on every publish. One member with 40 windows open is 40 reads a publish. The object already tags connections by member id for revocation, so the count is one `getWebSockets(tag)`. Decision 8 sets the cap and pairs it with a session cap.
2. **Line-item property size.** `properties` is stored as JSON whatever its size, on the item and again on the run. A storefront app can attach kilobytes (a design proof as a data URL would do it). The row limit is 2 MB and a statement is 100 KB. Truncate per item on write.
3. **Order note size.** Shopify caps an order note at 5,000 characters, so it is bounded, but the schema does not say so. Not a change; a note on the DDL.
4. **Members with no team.** Not a limit; a member on no team sees nothing and costs a read per publish. The connection cap covers the cost; the empty list is a UI question outside this research.
5. **Workflow tags per order.** An order whose tags match many workflows gets a run per matched item per workflow. Bounded by items × workflows, which the two ceilings bound. Nothing to add.
6. **The usage-event queue.** Bounded by a cycle's events: an expired event is deleted at the next flush. Nothing to add.
7. **Webhook replay.** Shopify retries a webhook up to 19 times over 48 hours on a non-2xx, and a merchant can bulk-edit tags on thousands of orders at once, which is thousands of webhooks in a minute, each a Shopify fetch and a publish. The open ceiling bounds the writes; nothing bounds the rate. Follow-up 2.

## Decisions

### Reviewed 2026-10-08

Eleven questions went to review. Accepted as recommended: 1 (members ceiling 50), 2 (no cap on counted orders a cycle), 3 (workflows 200), 5 (included orders 200 and 1,500), 6 (Pro at $0.05 an order and $7 a seat), 7 (ceilings stay plan-independent), 11 (set the members ceiling from the model now, measure in follow-up 1). Dropped: 10, Shopify's revenue share, which the user said is not a concern at the traction expected. The vocabulary complaints (a "shape", a "tab", a "fleet") are fixed above and in the CLI, whose input is now a shop and whose live count is live screens. Three were reopened with research, below.

**4. Teams: raise rather than cut.** The user asked whether 20 was a UI number only. It is. A team is a D1 row and a `teamName` copied onto run tasks; no read is linear in teams, and the model has no term for them. The screens that list every team are the orders index's team filter (a select), the member page's team checklist and the task editor's team choice. A native select scrolls at 50; a checklist of 50 is long but works. So the ceiling stays at 50, which no shop in the field needs (Route to Ship's departments are unlimited, and a 50-member shop has perhaps ten), and the UI is the thing to fix if a shop ever reaches 30: a search in the filter, as the members index has. Decided: keep 50.

**8. Connections and sessions a member: 2 each, newest wins.** The user's point: a connection cap of 5 is high, and the real gap is seat sharing. One member login handed to five workers on five phones is five connections, five seats of load and one seat of revenue. What the app can see:

- A connection is a socket, and the object tags every member connection with the member id (`memberConnectionTag` in `ShopAgent.ts`). Counting a member's connections is one `getWebSockets(tag)`. A phone and a bench computer are two; the same window reloaded is one, since the old connection closes.
- A sign-in is a better-auth session row in D1, one per device the magic link was opened on. Counting a member's sessions is one query on `Session` by user id. better-auth has `revokeOtherSessions`; the server side can do the same on sign-in: keep the newest N, revoke the rest.
- Neither identifies a device. Two phones sharing a login are two sessions and two connections, and nothing distinguishes that from one worker with a phone and a bench computer. So the cap is the control, not detection.

The pairing matters. A connection cap alone is gamed by taking turns: five workers, two connections, each reconnects when a verb is needed, and the two-second throttle hides it. A session cap alone is gamed by one device with many windows, which the connection cap bounds. Two and two says: a member is a person with at most two devices. A third sign-in revokes the oldest session (that device lands on the sign-in page), and a third connection closes the oldest with a close code the screen shows as "Signed in elsewhere". At the 50-member ceiling that is 100 connections at most, 103 with three merchants, and the model at 100 live screens and 5,000 orders a month is 25% busy, inside the fence, and in practice a second window is hidden and defers its re-read.

Merchants: the user noted Shopify charges for staff accounts, which bounds merchants on its own. From memory, a Basic Shopify plan has 2 staff accounts, Shopify 5, Advanced 15, Plus unlimited; not in `refs/`, so treat as a direction, not a figure. Beyond that, the App Bridge session token's `sub` claim is the staff user's id, so a per-staff-user connection cap is possible the same way; not proposed now, since the plan's staff limit already does it and a merchant has no seat to share.

Decided: 2 connections and 2 sessions a member, newest wins, both plan-independent ceilings on `ShopLimits`; the member's screen says "Signed in elsewhere" and offers sign-in. The second review accepted 2 and 2 over 1 and 1.

**9. A trial on Pro, and how long.** The user asked whether a Pro trial touches the billing and metering logic, whether upgrade and downgrade play games with it, and whether 7 days would do.

What the code already does: a trial is an app subscription with no billing cycle (`AppSubscription.cycleStartAt` null, `boundaryAt` the trial end). The triggers table on `ShopUsage` has a row for it: "revalidation during a trial: pushes no billing cycle". Orders are still counted in the object's provisional cycle, and usage events sent during a trial are not reported and do not carry into the paid cycle (measured on the dev store 2026-09-22, recorded on `AppSubscription`). None of this knows which plan is trialling. A trial on Pro changes no code: the dashboard field and the README line.

What Shopify does about gaming (`refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/offer-free-trials.md`, "Trial proration"): trial days are tracked per plan over a 180-day window, so uninstall and reinstall does not restart a trial, and shortening a trial subtracts days already used. A plan change is a new app subscription with a new cycle starting at the switch, every meter at zero (the reasoning on `AppSubscription`). So the games are:

- Trial Basic, then trial Pro: two trials, 28 days free with both at 14. Shopify tracks each plan's days separately, so this is allowed, and it is the only game a Pro trial adds. A merchant doing it is evaluating, which is the point.
- Switch plans to reset the order count mid-cycle: a switch is a new cycle at zero, with or without a trial. Shopify prorates the subscription charge, so the switch is not free, and the included orders are per cycle, so a switch every two weeks would double the allowance for a prorated charge. Pre-existing, trial or not, and not worth closing: it costs the merchant a plan change through Shopify's own screens each time, and the amounts are tens of dollars.
- Downgrade from Pro to Basic to keep Pro's trial days: the days belong to the Pro plan and are spent; nothing carries over.

The metering itself is unaffected: counts are per cycle in the object, the seat mark is sent whole at each new cycle, and a plan change already resets both.

On length. A production app's trial has to show an order going through: synced, matched, started, done, fulfilled. A shop shipping daily sees that in a week; a made-to-order shop with a two-week turnaround does not, and those are the shops the app is for. The field is 14 everywhere but BenchCue, and a merchant comparing against Route to Ship's Team plan sees its 14 days. A shorter trial does not save cost (a trial shop costs cents) or close a game (the games above are the same length-independent). Recommended: 14 days on both. If 7 is preferred, 7 on both rather than two different lengths, since the plan copy reads better and Shopify's per-plan day tracking makes a mixed pair confusing when a merchant switches during the trial.

Decided: a trial on Pro, no code change; 14 days on both plans, accepted at the second review.

## Questions

None open. The two from the second review, with the answers:

1. **Connections and sessions a member: 2 and 2, or 1 and 1?** 2 and 2, accepted 2026-10-08. One device is strict enough to stop sharing but refuses the worker who checks a task on a phone away from the bench. Two is the smallest number that fits one person.
2. **Trial length: 14 or 7 days?** 14 on both, accepted 2026-10-08, for the reasons in decision 9.

## Follow-ups

1. **Measure the model's two guesses.** A bench that seeds a shop (`pnpm seed` can be extended, or the bench from the 2026-10-03 research recreated), opens N live screens or fires N reads, and reads `ms=` and `rows=` off the log for a hit and a miss. Replace `hitMs` and `msPerRowRead` in `EventCost`, rerun the ladder, revisit the members ceiling.
2. **Rate limiting.** Not researched here. The webhook path has no rate limit (gap 7), the member and merchant server functions have none, the socket has none, and the sign-in magic link has none. A separate research: what to limit (per shop, per member, per IP), where (the Worker, before the object, since the object is what must be protected), and with what (Cloudflare's rate limiting binding, or a counter in KV).
3. **Per-key memo clearing.** The cost lever held in reserve, above. Worth it when a shop's rows-read line passes the plan's seat revenue, which no shop here does.
4. **The limits page in Help.** Reference has Limits and Plans pages with open questions (the help memory). Once the numbers here are decided, they are those pages' numbers: a plan line is "N orders included, then $X each", never "unlimited", never a provisional number.
5. **Shopify staff-account limits.** Verify the per-plan staff counts before writing them anywhere; they are from memory.

## Status

Research written 2026-10-08 and reviewed twice the same day: nine decisions accepted, one dropped, three researched and decided above, and the two remaining questions accepted. Nothing open. `pnpm cost` built, tested (`node --test scripts/lib/cost.test.ts`), typecheck and lint green. Plan `docs/limits-plan.md` implemented 2026-10-08, all seven phases, uncommitted: typecheck, lint, `pnpm test` (791) and the e2e suite (92) green; deviations in the plan's last section. The Partner Dashboard still carries the old tiers until the user updates it.
