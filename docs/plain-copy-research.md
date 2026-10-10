# Plain copy: code words on merchant and member screens

Written 2026-10-09. The help said "The states, the verbs, the limits and the plans, as tables." No
merchant talks like that. "Verb" is a word from the code, and the help and the screens use many
more of them. This doc lists them and proposes plain words.

Sources: the help bodies under `src/components/help/`, `src/lib/helpPages.ts`,
`src/lib/helpReference.ts`, `src/lib/helpPictures.ts` (picture alt text), the routes, and
`node scripts/copy-audit.ts`. The two "verb" summaries are already fixed.

## Short answers

- About 110 places in the help and on screens use a word from the code: strip, select, modal,
  position, state, current, in force, on record, tile, seats, counted. Also "the merchant" on pages
  the merchant reads.
- The fix: help and screens use the names the screen shows (buttons, badges, column headings) and
  plain words for everything else. Code words stay in code, JSDoc and docs.
- `scripts/rules-lint.ts` already refuses retired words in screen copy. The code words found here
  join that list, so they don't come back (Q9).
- Three page titles and one screen heading change (Q7), and "magic link" becomes "sign-in link"
  (Q8).

## The rule

Copy says what the person sees and what they do. It names a control by the label on it. It never
uses a word that only the code or this team uses. A merchant reads "you". A member reads "you".

## What was found

Counts are approximate. Each table shows typical cases, not every one. The plan lists every file
and line, found again with a grep once the questions are answered.

### The counts row at the top of a list ("strip", "cell", "value")

About 20 places. Nothing on screen names the row, so the help made up "strip".

| Now                                         | Proposed                                   |
| ------------------------------------------- | ------------------------------------------ |
| "The strip and the Show select" (heading)   | "The counts at the top and the Show menu"  |
| "press Not started on the strip"            | "press Not started at the top of the list" |
| "Each cell shows how many orders are there" | "Each shows how many orders it has"        |
| "The list shows one value at a time"        | "The list shows one choice at a time"      |
| "The Issues cell holds one red badge"       | "The Issues column shows one red badge"    |

### "select" (a dropdown)

About 27 places: the Show select, the Team select, the Workflow select, the Assign team select.
"Select" is the name of the Polaris component. The lint's retired table chose it on 2026-09 when
it retired "picker". Proposed: "menu" (the Show menu, the Team menu, the Workflow menu). Q2.

### "modal" (a dialog)

About 30 places across 11 help pages and 17 picture alt texts: "The modal says…". Proposed:
"window" ("A window opens and says…"). Q3.

### "position" (an order's status)

About 15 places: "What each position means", "Each order is in one position", "order positions".
Kept (decision 4): an order moves left to right through No workflow, Not started, Making and
Made, and "position" says where it is along that row.

### "state"

"each workflow's state", "the current task and its state", "Task states, workflow states".
Proposed: name what the screen shows ("whether each workflow is Active or Inactive", "its badge").

### "current" (a step or task that is ready)

About 20 places: "Each task whose step is current", "the team of the current task". Proposed: "to
do now" or "working on it now". Kept (decision 8): only the sentences built around it are
reworded.

### "in force", "on record", "record"

| Now                                                                      | Proposed                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| "the workflow's page shows the steps in force"                           | "the workflow's page shows the steps it has now"           |
| "Puts the draft's steps and tasks in force for new items."               | "New items start with the draft's steps and tasks."        |
| "Steps already done stay on record." (Cancel workflow window, on screen) | "Steps already done still show on the order."              |
| "Its tasks stay in Manage as the record"                                 | "Its tasks stay under Manage, so you can see who did what" |
| "Sign in, find your work and record it."                                 | "Sign in, find your work and mark it done."                |

### "the merchant" on pages the merchant reads

Who can do what, the Reference tables and one summary say "The merchant presses them", "Only the
merchant has these". Proposed: "you". The order page also shows **Merchant** as the name on what
the merchant did. Proposed: **You** on the merchant's own screens, as the member's screens already
show "Cancelled by you". Q6.

### "a Done", "presses"

"To take back its last Done", "Undo a Done", "Your own presses read Merchant". Proposed: "To undo
the last task marked done", "Undo Done", "What you did shows…".

### Billing words

| Now                                                              | Proposed                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| "{n} past your plan's included seats are billed…" (home page)    | "{n} over. Extra members are billed at your plan's rate." (as the orders tile says)  |
| "cancelling a workflow does not uncount its order"               | "cancelling the workflow afterwards does not take the order back off"                |
| "Baton refuses nothing for being past what your plan includes."  | "Going past what your plan includes never stops Baton working."                      |
| "the orders tile says…", "The Members tile shows today's count." | "Orders this billing cycle says…", "Members shows how many you have today."          |
| "The billing cycle, counted orders, members…" (summary)          | "What each plan includes, which orders and members you pay for, and changing plans." |

### Engineering words on screens

| Where                 | Now                                                                                           | Proposed                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders page, empty    | "Sync open orders to pull in what is on the bench … order webhooks keep them current."        | "Press Sync open orders to bring in your open orders from the last 30 days, or wait for the next order. After that, Baton adds each new order as it is placed." |
| Disconnected banner   | "Live updates are paused and changes on this page are disabled until the connection returns." | "Baton lost its connection. This page won't update, and you can't make changes until it reconnects."                                                            |
| Syncing from Shopify  | "so the newest copy wins whichever message arrives first"                                     | "so Baton always ends up with the latest version of the order"                                                                                                  |
| Syncing from Shopify  | "changes an item's quantity resizes its workflow"                                             | "changes the number to make"                                                                                                                                    |
| Creating a workflow   | "since Shopify splits a product's tags on commas"                                             | "since Shopify uses commas to separate tags"                                                                                                                    |
| Removing and deleting | "It is disabled for a moment while the page connects."                                        | "It can't be pressed for a moment after the page opens."                                                                                                        |

### Engine and meta phrasing

| Now                                                                  | Proposed                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| "The words" (How Baton works, heading)                               | "Orders, workflows and teams"                                        |
| "What else has to hold" (Matching, heading)                          | "What else a workflow needs to start"                                |
| "A match never moves an item…"                                       | "A matching tag never moves an item to another workflow."            |
| "An item matches a tag, a member starts it…" (summary)               | "An item's product has the tag, a member starts the work…"           |
| "what each means and what clears it" (summary)                       | "and how to fix each"                                                |
| "the products the workflow should build" (tag field help, on screen) | "the products this workflow is for"                                  |
| "its tasks reach the members of their teams"                         | "its tasks show on the Workflows list of each member on their teams" |
| "Baton takes each item a Shopify order sells through…" (help home)   | "Baton takes each item on a Shopify order through…"                  |
| "so there is no work left to attach" (order page error)              | "so you can't attach a workflow to it"                               |
| "no item's workflow is still open"                                   | "every item's workflow is done or closed"                            |

## Out of scope, noted

- **Reopen and Undo** are one action with two names (merchant and member), and the help explains
  that twice. Unifying them is a label change, not a word fix.
- **The error page** (`DefaultErrorComponent`) shows the raw error message and stack trace. That
  can put engineering text in front of a merchant. It needs its own fix.
- **Privacy policy** uses OAuth, API and webhook. It is a legal page, so it stays.

## Decisions

1. The row of counts at the top of the Orders page and the Workflows list is "the counts at the
   top". Where help can, it names the item instead ("press Not started") (Q1).
2. "select" becomes "menu": the Show menu, the Team menu, the Workflow menu, the Assign team menu
   (Q2).
3. "modal" becomes "window" ("A window opens and says…") (Q3).
4. "position" stays. An order moves left to right through the counts at the top, and "position"
   says where it is (Q4, your note).
5. The merchant is "you" on the merchant's help pages, and the order page shows "You" instead of
   "Merchant" on what the merchant did. Member screens keep "the merchant" (Q6).
6. "States and badges" becomes "Badges", "Recording your work" becomes "Starting and finishing
   tasks", and the home page's "Usage and capacity" becomes "Your plan" (Q7).
7. "magic link" becomes "sign-in link" on the sign-in screens (Q8).
8. "current" stays. Only the sentences built around it are reworded: "Each task whose step is
   current" becomes "Once every earlier step is done, each task in the next step shows…", and "A
   task in a later step, not yet current, offers only Assign team" becomes "A task in a later step
   offers only Assign team" (Q5).
9. These words join the lint's retired list for screen and help copy: verb, strip, cell, modal,
   select, in force, on record, tile, seat, uncount (Q9).

No open questions remain.
