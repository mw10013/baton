# Member queue UX research

Date: 2026-09-17. Source: `src/routes/shop.$shop.index.tsx`, `src/routes/shop.$shop.work.$runId.tsx`,
`src/components/MemberRun.tsx`, `src/lib/queueTiers.ts` at commit `4fe44ae`; the two screenshots
reviewed on 2026-09-17 (queue with #1008 blocked, work page for #1008); the Polaris App Home web
component docs in `refs/shopify-docs/docs/api/app-home/latest/`. Follows `member-ux-research.md`
(2026-09-12), which chose cards, tiers, chips and the work page. This one asks why those screens
still feel overloaded, and what changes. Mockups: `member-queue-ux/mockups.html`.

## Decisions (2026-09-17)

Answered in the Plannotator review of the first draft.

1. **Volume: 200 made-to-order items a day is the high end.** No market research behind
   it; the customer is a small or medium shop, and a shop doing hundreds a day is not
   looking at Baton. At three steps an item, one team's open queue is tens on a normal day
   and low hundreds in a rush. Design for tens, survive hundreds.
2. **Mobile first.** Device unknown; the member side must work on a phone. Cards, not rows.
3. **Blocked means stop.** Start and Done are hidden while a run is blocked. Unblock first,
   then Done. Fewer options on the card beats one tap saved.
4. **Anyone can block, edit the reason, and unblock.** No permissions; not that kind of
   system. The reason is multi-line and last write wins, like the note.
5. **Heading is "Queue".**
6. **Search: not in 1.0.** See §5.
7. **The screenshot table is right.**

Implemented 2026-09-17; see `member-queue-ux-implementation-plan.md` for the order of work
and its Deviations list. Three things settled during the work and are folded in below:
the block reason is rewritten by a `setBlockReason` command that leaves `by` and `flagAt`
alone (§7, "Editing the reason"); the work page's header card puts the item first and the
workflow badge, status and age under it (§Conclusion 5); and the reason editor replaces
the banner body in place rather than opening a section (§7, "Where the controls go").

The block model (§7) and search (§5) were the parts the review asked to think through
again; both sections are rewritten below.

## Conclusion

1. **Say each fact once.** A blocked card today says "Needs attention" (section heading),
   "Blocked" (badge), "Needs attention" (banner heading), "Blocked:" (banner body). Four
   tokens for one fact. The section heading carries the tier; the card carries nothing that
   repeats it. The banner heading is the flag kind ("Blocked", "Quantity changed", "No longer
   needed"), and its body is only the reason.
2. **One action per state.** A blocked card offers Unblock, inside the banner, and nothing
   else. An unblocked card offers Start or Done. Today it offers Dismiss, Start and Done at
   once and the reader cannot tell which is expected. Polaris banners take actions in a
   `secondary-actions` slot, which is where Unblock belongs.
3. **Rename "Your work".** "Your work" answers a question nobody asked. The first draft
   proposed the team name for a one-team member and "Queue" for everyone else; Decision 5
   settled on **"Queue" for everyone**, and that is what shipped. One heading beats a
   heading that changes meaning when someone is added to a second team, and the chips
   already name the teams.
4. **Breadcrumb, not an inline back link.** `s-page` has a `breadcrumb-actions` slot for
   exactly this; the work page puts "Engraving" (or "Queue") there and drops the "‹ Your
   work" link that floats inside the first card.
5. **The card is item first, step second, chrome last.** Header line: order number, item,
   age. Body: personalization. Foot: the step name and its one or two buttons. Workflow
   name, stage count and "together with" move to the work page. Instructions stay but read
   as the step's subtitle, not a paragraph.
6. **Cards everywhere, Up next capped.** Up next shows the ten oldest and a "Show all 37"
   button; the other tiers are small by construction. At the decided volume that is the
   whole scaling story. Compact rows for the lower tiers are the fallback if a real queue
   proves the cap is not enough, not part of 1.0.
7. **Notes are multi-line and rendered as written.** `s-text-area rows=3` replaces the
   text field; the saved note keeps its line breaks. The last write still wins; that was
   decided for 1.0 and the doc records it. "Add note" is a secondary button beside Undo,
   not a tertiary text button in a row of bordered buttons.
8. **A block is a hold with one editable reason.** Anyone sets it, anyone edits the reason,
   anyone lifts it. The reason is multi-line, last write wins, no history. On the queue
   card the banner offers Unblock; on the work page it offers Unblock and Edit reason.
   The separate "Blocked" section at the foot of the work page goes.

## What the screenshots show

Queue card for #1008 (blocked, Engraving, one step ready):

| Element                                         | Purpose        | Verdict                                                               |
| ----------------------------------------------- | -------------- | --------------------------------------------------------------------- |
| "Your work" heading                             | page title     | says nothing; rename                                                  |
| `lead@m.com` subdued line                       | who am I       | belongs in the bar, not the page                                      |
| Chips with counts                               | team filter    | keep                                                                  |
| "Needs attention · 1" heading                   | tier           | keep, this is where the tier is said                                  |
| `#1008` link                                    | drill-down     | keep                                                                  |
| "Signet ring" badge                             | workflow name  | drop from card; work page keeps it                                    |
| "Blocked" badge                                 | tier again     | drop; the section already says it                                     |
| "ordered 31m ago"                               | age            | keep                                                                  |
| Item + personalization                          | what to make   | keep, this is the content                                             |
| Banner "Needs attention / Blocked: reason · by" | the flag       | heading = "Blocked", body = reason, actor and time subdued underneath |
| Dismiss button below banner                     | clear the flag | move into the banner, rename Unblock                                  |
| Grey step box "Engrave crest · step 2 of 3"     | the step       | keep the name; "2 of 3" is for the work page                          |
| Instructions paragraph                          | how            | keep, subdued                                                         |
| Start and Done                                  | act            | hidden while blocked                                                  |

Work page for #1008: heading `#1008`, an inline "‹ Your work" link inside the first card, the
same warning banner, "This item", "Steps" with Undo and Note, then "Also on this order", "Order
note", and a "Blocked" section with Unblock at the bottom. The banner at the top and the Unblock
at the bottom describe one state from two places a screen apart.

## Findings

### 1. Redundancy is the main cause of the overload

Counting the words on the blocked card: three status tokens ("Needs attention", "Blocked",
"Needs attention"), two names for the thing ("Signet ring" badge and "Signet ring ×1" item
title), two counts ("step 2 of 3" and the tier count), and three buttons of which the reader
can choose only one sensibly. None of this is wrong; all of it is said twice. Polaris guidance
for the Shopify order page is instructive: the order page says "Unfulfilled" once, as the card
heading, with the action on the same card. It does not badge the section and banner the card.

Fix: the tier heading is the only place the tier is said. Badges on a card are reserved for
facts that vary within a tier (nothing today; "×2 to make" if that returns).

### 2. Three buttons and no verb hierarchy

When flagged, the card renders Dismiss, then the step box with Start and Done. A block is
"do not work on this". Offering Start under it contradicts the banner. Two options:

| Option                                                  | For                                        | Against                                                                 |
| ------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| A. Hide Start/Done while blocked; Unblock in the banner | one action, matches the meaning of blocked | fixer presses Unblock then Done: two taps                               |
| B. Keep Start/Done; Done implies unblock                | one tap for the fixer                      | banner says stop, button says go; server must clear the flag implicitly |

Recommend A. Two taps for the rare fixer beats a card that argues with itself for everyone.
The reconcile flags (item removed, quantity changed, order cancelled) keep "Dismiss", because
there the action is acknowledgement, not lifting a hold; their step actions also stay hidden
because in every case the work has changed or gone.

### 3. The banner copy

`s-banner` has a `heading` and body. Today heading is fixed ("Needs attention") and the body
starts with the flag kind. Swap: heading is the flag kind, body is the detail.

| Flag                 | Heading          | Body                                                        |
| -------------------- | ---------------- | ----------------------------------------------------------- |
| `blocked`            | Blocked          | the reason as typed; below, subdued: `lead@m.com · 31m ago` |
| `blocked`, no reason | Blocked          | subdued: `lead@m.com · 31m ago`                             |
| `quantity_changed`   | Quantity changed | "From 2 to 1."                                              |
| `item_removed`       | No longer needed | "Removed, refunded, or shipped in Shopify."                 |
| `order_cancelled`    | Order cancelled  | (none)                                                      |
| `order_deleted`      | Order deleted    | (none)                                                      |
| `order_fulfilled`    | Already shipped  | "Fulfilled in Shopify."                                     |

Banner tone: `critical` for blocked and cancelled/deleted, `warning` for the rest. The flag
banner is shared by both screens (`FlagBanner`), so one change lands twice.

### 4. Heading and breadcrumb

Polaris `s-page` heading is required and the `breadcrumb-actions` slot "only accepts link
components". The work page heading becomes `#1008` (as now) with a breadcrumb link back to the
queue whose text is the queue heading. Options for the queue heading:

| Option              | For                                          | Against                         |
| ------------------- | -------------------------------------------- | ------------------------------- |
| "Your work" (today) | familiar                                     | tautology; the user objected    |
| "Queue"             | one word, names the object, works with chips | slightly software-ish           |
| Team name           | most orienting for the one-team majority     | needs a fallback for multi-team |
| Shop name           | the bar already shows it                     | redundant                       |

Recommend: team name when `teams.length === 1`, else "Queue". Breadcrumb text follows.
**Decided otherwise (Decision 5):** "Queue" unconditionally, and the breadcrumb reads
"Queue" to match.

A wrinkle: `s-link` inside the slot takes `href`; TanStack `Link` is an anchor of its own
type. Either render `s-link` with `href` and intercept the click to `router.navigate`, or
accept a full navigation. Built as the first: `router.buildLocation` supplies the `href` so
the link is real to a middle-click, and `onClick` preventDefaults into `router.navigate` so
an ordinary click keeps the socket and the query cache.

### 5. Scaling the list

Today every run is a full card, in four sections, in one column. At 6 it reads; at 60 a
worker scrolls past thirty personalizations to reach the tier they wanted.

What the tiers already do: attention and mine are small by construction (one person can only
have a few things in hand). In progress is bounded by team size. Up next is unbounded.

| Approach                                    | For                                                     | Against                                                                              |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Cards everywhere (today)                    | personalization visible without a tap; right on a phone | linear height; 60 runs is 30 screens                                                 |
| Rows everywhere (`s-table`)                 | dense                                                   | personalization is the content and does not fit a cell; rejected before, still right |
| Cards for attention + mine, rows below      | acts where it matters, scans where it doesn't           | two card styles; rows are a desktop shape on a phone-first screen                    |
| Cards, Up next capped at 10 with "Show all" | trivial; oldest-first means the top ten is the work     | a member hunting one order taps Show all and scrolls                                 |
| Pagination                                  | standard                                                | a bench does not page; a socket push reorders pages under you                        |

Recommend the cap alone for 1.0. Decision 1 puts a normal team queue in the tens; ten cards
plus a count is one or two phone screens. Decision 2 (mobile first) is the argument against
rows: a row that truncates "The Millers · est. 2019" to fit 360px has lost the thing the
card exists to show. If a rush queue proves the cap is not enough, the row-for-lower-tiers
variant is the next step and is sketched in the mockups so it is not lost.

No pagination: the object already returns the whole queue in one read, and a shop with 500
open runs per team is not this app's customer.

**Search.** Recommend none in 1.0.

| Option                                                  | For                                                | Against                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| No search                                               | nothing to build; nothing to explain               | a member with an order number in hand scrolls or taps Show all                               |
| Client-side filter field (`s-text-field icon="search"`) | the standard resource-list affordance; a few lines | one more control at the top of a screen we are trying to quiet; hides the tiers while typing |
| Server search                                           | scales past what the object returns                | nothing today needs it                                                                       |

Reasoning: the member who arrives with an order number is the packer, and the packer's card
is the order card, sorted oldest first, which is also the order the packing slips come in.
The maker picks by age, not by number. Browser find covers the desktop case. The signal to
add the filter is a merchant asking "how do I find order X" or a queue where Show all is
tapped on most visits. When it comes it is client-side over the rows already on the page;
no server work.

**On not knowing.** Two cheap ways to learn the real numbers without a survey: log the queue
size per team on each `listQueue` call (one annotation, already shop-scoped), and read the
App Store reviews of Route to Ship and Kanbanify for the words "hundreds", "dozens",
"tablet", "phone". The competitor deep dive found one reviewer with a dozen workers across
four departments; that is the best datum we have.

### 6. Notes

`s-text-area` is the multi-line control; `rows` sets height. The saved note renders in an
`s-paragraph` with `white-space: pre-wrap` (or one `s-text` per line) so appended comments
stay on their own lines. The "Note (Merchant):" prefix stays for a merchant note.

Button placement. Polaris defines tertiary as "low emphasis button for less important
actions" and the admin uses it for inline edit links, so the current control is legitimate
Polaris. The reason it reads oddly here is the row: a bordered Undo beside a borderless Note
looks like a button and a label. The earlier decision (order-item-workflow research, 2026-09-16)
was "equal-weight secondary actions" for step rows. Apply it: Undo and Add note are both
secondary. Where there is a primary (Done), it is alone on the left.

### 7. The block model

The review asked what a block is, who it is for, and what Dismiss means. Answer first, then
the UI.

**What it is.** A hold on one run: "do not work on this item; something outside the
workflow has to happen first." It does not change the steps; when lifted, the run goes back
to exactly where it was. Route to Ship calls the same thing Escalate.

**Who it is for.** Three readers, in order of how often they need it:

| Reader                | What they need from it                              | Where they see it                           |
| --------------------- | --------------------------------------------------- | ------------------------------------------- |
| The merchant or lead  | to go do the thing (call the customer, order stock) | order page strip; Blocked tier if on a team |
| Teammates             | to not pick it up                                   | Blocked tier                                |
| The person who set it | a reminder, and to record what they already did     | both                                        |

So a block is mostly an escalation upward and a stop sign sideways. The reason is written
for the first reader: "Crest file missing; asked the customer" tells the merchant what to
chase.

**What Unblock means.** The hold is lifted. Nothing else. The run returns to its tier with
its steps as they were; whoever unblocks presses Done next if the work is in fact done.
"Dismiss" is the wrong word for this and goes: it suggests hiding a notification. Dismiss
stays for the reconcile flags (item removed, quantity changed, order cancelled), where the
action really is "seen it".

**Editing the reason.** The review's instinct was right: the mistake case ("typo, or I wrote
the wrong thing") is real, and "unblock then re-block" is a trick users will not find on
their own. It also loses who set the block and when. Allow editing.

Two designs for the reason field:

| Design                                                  | For                                                                            | Against                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A. One multi-line reason, anyone edits, last write wins | same model as the note: every free-text field in Baton works one way; no table | two people editing at once lose a line                                                      |
| B. Blocks table, one row per comment, append only       | a real thread; nothing lost                                                    | a second concept (block vs comment), a list UI on the card, history nobody asked for in 1.0 |

Recommend A. It matches the note exactly, and one rule ("free text is editable by anyone,
last write wins") is what keeps the system learnable. People who want a thread will write
one by hand, dated and initialled; that is how shared spreadsheets work today and it is what
they are used to. B is the upgrade path if a merchant asks for who-said-what.

Attribution stays as it is: `by`/`at` for who set the block. No `editedBy`; an edit is just
text (decided 2026-09-17). Built as `setBlockReason` — a command of its own rather than a
second call to `blockRun`, because `blockRun` writes `by` and `flagAt` and an edit must
leave both alone. It refuses on anything but a standing `blocked` flag, with a refusal of
its own (`RunNotBlockedError` → `NotBlocked` → "This work is no longer blocked."): the
reachable case is a teammate lifting the hold while the editor is open, and the generic
"belongs to another team" would send that reader after the wrong thing.

**Where the controls go.** The queue card is the busy place; the work page is where you go
to do something less common.

| Surface    | Banner shows     | Banner actions       |
| ---------- | ---------------- | -------------------- |
| Queue card | reason, by, when | Unblock              |
| Work page  | reason, by, when | Unblock, Edit reason |

Edit reason opens the same multi-line editor inline in the banner (text area, Save, Cancel).
Start and Done are hidden on both surfaces while blocked (decision 3). Blocking an unflagged
run stays where it is: the "Block this work" form at the foot of the work page, reason
optional, text area rather than text field. Whether the reason should be required is open;
an empty reason gives the merchant nothing to act on, but forcing a sentence at a bench is
friction. Recommend optional with the placeholder "What is stopping this? Who needs to
know?".

### 8. What leaves the card

- Workflow name badge. The worker acts on the step, not the workflow. It stays on the work
  page header.
- "step 2 of 3". Progress is the work page's Steps section.
- "together with: …" sibling steps. Work page.
- The tier badge. Section heading.
- The member email line. The bar shows the shop; adding the email there (or under Sign out)
  answers "who am I" on every screen instead of one.

## Rejected

- **A kanban board or a table.** Rejected in the 2026-09-12 research for reasons that still
  hold: a member on Engraving sees steps from many workflows, and personalization does not
  fit a cell.
- **Removing Start.** Start is how "Mine" happens and how a teammate learns the work is in
  hand. Keep both verbs, but only when the run is unblocked.
- **A notes or blocks table with an audit trail.** Decided against for 1.0; multi-line text
  with last write wins is the compromise for both. Record here so the next reader does not
  reopen it.
- **Unblock-then-re-block as the way to fix a reason.** Considered in the first draft;
  undiscoverable and loses attribution. Edit reason instead.
- **Compact rows for the lower tiers.** Sketched, deferred: phone first, and the decided
  volume does not need them.
- **Hiding instructions behind a disclosure.** Instructions are the one thing a new hire
  needs on the card; subdue, don't hide.

## Implementation notes (for the plan)

- `FlagBanner` in `MemberRun.tsx`: heading per flag, body per flag, actor/time line, an
  optional actions slot; used by both screens.
- `shop.$shop.index.tsx`: heading "Queue"; drop email line, workflow badge, tier badge,
  stage count, siblings; step actions gated on `run.flag === null`; Up next capped at ten
  with Show all.
- `shop.$shop.work.$runId.tsx`: `s-link slot="breadcrumb-actions"`; remove inline back link;
  `s-text-area` for the note and the block reason; note rendering with line breaks; Unblock
  and Edit reason into the banner and the "Blocked" section removed when flagged.
- `MemberBar.tsx`: optionally the member email beside Sign out.
- Domain: a `updateBlockReason` member callable (and merchant equivalent) that rewrites
  `flagDetail.reason`; optionally `editedBy`/`editedAt` in `flagDetail`. Rename member-facing
  copy from Dismiss to Unblock for `blocked`; Dismiss stays for reconcile flags.
