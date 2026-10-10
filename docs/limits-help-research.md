# Limits help: what merchants need to know

Written 2026-10-09. The limits are now firm. This doc proposes what the Limits help page says,
and whether Plans and billing and the README mention the hard limits.

## Short answers

- The Limits page lists only what a merchant would plan around. Everything else is cut.
- Two hard limits lead the page: 50 members and 2,500 open orders, the same on every plan.
- Below them: 200 workflows, 50 teams, 365 days of order history.
- No "contact support". We won't raise the limit for anyone.
- The Limits page doesn't mention Sync open orders. At the open-order limit, Syncing from Shopify
  keeps it as the way to get missing orders back, since targeted shops will rarely get there (Q3).
- Plans and billing names the two hard limits (Q5). The README gets one Top features line for the
  pricing page (Q6).

## What the page has now

21 rows in three tables: eight text lengths, members, screens and sign-ins per member, teams,
workflows, tasks per workflow, items per order, properties per item, open orders, the 30-day sync
window, order history, and the Done or closed window. It ends by telling the merchant to press
Sync open orders at the open-order limit.

## What stays and what goes

A row stays if a merchant would plan around it before hitting it. If the screen already tells
them when they hit it, it goes.

| Limit                         | Value    | Verdict | Why                                               |
| ----------------------------- | -------- | ------- | ------------------------------------------------- |
| Members                       | 50       | Keep    | Decides how many staff can use Baton              |
| Open orders                   | 2,500    | Keep    | Decides how much work can be in progress          |
| Workflows                     | 200      | Keep    | A shop with one workflow per product could hit it |
| Teams                         | 50       | Keep    | A shop setting up stations could hit it           |
| Order history                 | 365 days | Keep    | Merchants should know old orders are deleted      |
| Text lengths (8 rows)         | various  | Cut     | The field says so when you save                   |
| Tasks per workflow            | 20       | Cut     | The editor says so                                |
| Items per order               | 250      | Cut     | No small or medium shop gets close                |
| Properties per item           | 8 KB     | Cut     | Too technical, rarely hit                         |
| Screens and sign-ins / member | 2 and 2  | Cut     | Only matters to someone sharing a login           |
| Done or closed window         | 24 hours | Cut     | How the member list works, not a limit            |
| Sync window                   | 30 days  | Cut     | Syncing from Shopify already says it              |

The cut limits are still enforced. They just leave the help page.

## The page, proposed

**Hard limits.** One line, then a table.

> These limits are the same on every plan. Going past the orders or members your plan includes is
> not a limit. Baton bills for the extra ones (see Plans and billing).

| What        | Limit | At the limit                                                            |
| ----------- | ----- | ----------------------------------------------------------------------- |
| Members     | 50    | You can't add another member.                                           |
| Open orders | 2,500 | New orders don't come into Baton until some are fulfilled or cancelled. |

**Other limits.**

| What          | Limit    | At the limit                                                  |
| ------------- | -------- | ------------------------------------------------------------- |
| Workflows     | 200      | You can't create or duplicate another workflow.               |
| Teams         | 50       | You can't create another team.                                |
| Order history | 365 days | Baton deletes orders older than this. Shopify still has them. |

No reason is given for the limits, no banner is described, and nothing is said about orders per
billing cycle.

The test that holds the page to every limit becomes "every limit a merchant plans around is on
the Limits page", over these five.

## The open-order limit and Sync open orders

What happens today at 2,500 open orders:

1. A new order comes in by webhook. Baton doesn't store it.
2. Baton only sees that order again if Shopify sends another webhook for it. A paid order usually
   gets none until it's fulfilled, when the work is already done.
3. So orders placed while the shop was at the limit are missing. Only Sync open orders brings
   them in.
4. The red banner goes away only when a sync starts. That's why the banner and help say to press
   Sync open orders.

You don't want merchants pushed to Sync open orders: it's expensive for us, and webhooks should be
enough after install. But the open-order limit is the one case where nothing else recovers the
missing orders. Two ways to handle it:

- **Keep today's behaviour.** The banner stays until a sync starts, and Syncing from Shopify says
  to press Sync open orders at the limit. Shops of the size Baton targets won't reach 2,500 open
  orders, so this sync runs rarely and costs little. A merchant who does hit the limit can get
  their orders back. No code change.
- **Drop the recovery.** The banner goes away when open orders drop below the limit, and help
  never mentions the sync for this. Orders placed while at the limit stay missing. Needs a code
  change.

Recommended: keep today's behaviour (Q3). Either way, the Limits page itself doesn't mention the
sync.

## The member limit message

The Members page says: "This store has reached the maximum number of members. Contact support to
raise it." We won't raise it, so the second sentence is wrong.

Proposed: "A shop can have 50 members." It matches the teams and workflows messages.

## Plans and billing

It ends a section with "The only hard stops are in Limits." Proposed instead:

> Every plan has two hard limits: 50 members and 2,500 open orders. See Limits.

A test keeps this page free of numbers, because plan numbers (price, included orders) are set in
the Partner Dashboard and can change without a deploy. The two hard limits come from the code and
can't go out of date. The test changes to allow those two numbers and still blocks any other.

## README

The README's Plans section is the text to enter in the Partner Dashboard. The only change there
is a fifth Top features line on both plans (Q6): `Up to 50 members, 2,500 open orders` (35
characters, four of eight lines used today). No explanation paragraph.

## Decisions

1. No "contact support" anywhere: we won't raise the member limit.
2. The Limits page doesn't tell merchants to press Sync open orders.
3. The page doesn't describe screens and sign-ins per member, items per order, or the sync window.
4. The page gives no reason for the limits. A reason like "to keep screens fast" suggests the app
   could be slow.
5. The page doesn't mention the red banner or orders per billing cycle.
6. Plain words: "you can't add", not "refuses". "Baton deletes orders older than", not "an order
   leaves Baton".
7. The Limits page keeps workflows, teams and order history below the two hard limits (Q1).
8. At the open-order limit, today's behaviour stays: the banner stays until a sync starts, and
   Syncing from Shopify says to press Sync open orders (Q3).
9. Help says to press Sync open orders once after installing, and nowhere else but the open-order
   limit (Q4).
10. Plans and billing says "Every plan has two hard limits: 50 members and 2,500 open orders. See
    Limits.", and its test allows those two numbers and blocks any other (Q5).
11. The README's Top features get a fifth line on both plans: `Up to 50 members, 2,500 open
    orders` (Q6).

No open questions remain.
