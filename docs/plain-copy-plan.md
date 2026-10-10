# Plain copy: implementation plan

This plan carries out the nine decisions in `docs/plain-copy-research.md`. Read that doc first.
Its tables of "Now" and "Proposed" text are the target copy. This plan says what to change, in
what order, and how to know each phase is done.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - The retired-word table on `RETIRED` in `scripts/lib/rules-lint.ts` is the spec for words that
    stay off screens. A retired word starts at its row, then its pattern, then a test titled with
    the rule.
  - The vocabulary's screen column is the spec for what a word shows as. The merchant row in
    `src/lib/domain/ShopWork.ts` already says "you" to the merchant and "the merchant" to a member.
  - A JSDoc never cites a file under `docs/`.
  - Do not commit unless the user says so.
- After each phase run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm fmt`. Keep every file
  `pnpm fmt` touches. `pnpm lint` stays red from phase 1 until phase 4 by design: its hits are the
  work list.
- Write copy the way the research says: plain words, what the screen shows and what the person
  does, no metaphor, "you" to the reader. Never "refuse".
- Record anything that does not go as written under [Deviations and issues](#deviations-and-issues)
  as you go: what you found, the options you saw, and the one you took.

## Scope

In scope: every string a merchant or a member reads.

- Screens: the files `copyFiles()` in `scripts/lib/copy-files.ts` returns (routes, components, and
  the listed `src/lib` modules).
- Help: the bodies under `src/components/help/`, and three modules `copyFiles()` does not read
  yet: `src/lib/helpPages.ts` (titles and summaries), `src/lib/helpReference.ts` (the Reference
  tables' rows) and `src/lib/helpPictures.ts` (picture alt text).

Out of scope: JSDoc, comments, identifiers, file and slug names, the operator console
(`admin.*`), the dev kit (`dev.*`), the public home page and the privacy policy. Code may keep
`Strip`, `SelectRow`, `*_MODAL`, `capacity-meter` and the rest. Help slugs
(`reference/states-and-badges`, `members/recording-your-work`) and picture names stay, so no
URL changes.

## The decisions, in the order the phases take them

| decision                           | what                                                                                          | phase |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ----- |
| 9                                  | retire verb, strip, cell, modal, select (as a noun), in force, on record, tile, seat, uncount | 1     |
| 1, 2, 3, 8 and the research tables | the counts at the top, menu, window, "current" sentences, the other rewordings in help        | 2     |
| 6                                  | Badges, Starting and finishing tasks, Your plan                                               | 2, 3  |
| 7 and the research tables          | sign-in link, and the screen rewordings                                                       | 3     |
| 5                                  | "You" instead of "Merchant" on the merchant's screens; "you" on merchant help                 | 2, 4  |
| 4                                  | "position" stays: nothing to do                                                               | —     |

## Phase 1: the lint

### 1.1 Scope (`scripts/lib/copy-files.ts`)

Add `helpPages.ts`, `helpReference.ts` and `helpPictures.ts` to the `src/lib` list. Update the
module JSDoc: the help's titles, summaries, reference rows and picture alt text are copy too.
These files may already hold other retired words. Fix those in phase 2 as well.

### 1.2 The patterns (`scripts/lib/rules-lint.ts`)

Add one row per word to the table on `RETIRED`, with its reason in plain words, and a pattern:

| word        | pattern (a starting point)                                                            | why (for the row)                                                             |
| ----------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| verb, verbs | `\bverbs?\b`                                                                          | a code word; copy names the button                                            |
| strip       | `\bstrip\b`                                                                           | nothing on screen is named strip; "the counts at the top", or the item's name |
| cell, cells | `\bcells?\b`                                                                          | a table word; copy names the column or the count                              |
| modal       | `\bmodals?\b`                                                                         | a code word; the screen word is window                                        |
| select      | the noun only: `\b(?:Show\|Team\|Workflow\|Assign team) selects?\b` and `\bselects\b` | the screen word is menu (the Show menu); "Select a team", the verb, stays     |
| in force    | `\bin force\b`                                                                        | say what the workflow has now                                                 |
| on record   | `\bon record\b`                                                                       | say where it still shows                                                      |
| tile, tiles | `\btiles?\b`                                                                          | name the heading the merchant sees (Orders this billing cycle, Members)       |
| seat, seats | `\bseats?\b`                                                                          | the screen word is members                                                    |
| uncount     | `\buncount`                                                                           | say the order stays on the bill                                               |

Change the existing **picker** row: "the control is a select" becomes "the control is a menu,
named by its label (the Workflow menu, the Assign team menu)".

Check each pattern against the files `copyFiles()` returns. A hit that is not copy (a prop value,
an option's value attribute) is a pattern to tighten, not copy to change. Record it.

### 1.3 Tests (`test/integration/rules-lint.test.ts`)

One `it` per new row, titled with the rule, the way the existing ones are ("picker is retired in
screen copy"). Example: "modal, cell, strip and verb are retired in screen copy", "select as a
noun is retired in screen copy, and Select, the verb, is not". Update the picker test if its text
names select.

### 1.4 Done when

`pnpm test` passes. `pnpm lint` lists the hits. Paste the count of hits per file here under
Deviations and issues, as the work list for phases 2 and 3.

## Phase 2: help

Work file by file through the hits under `src/components/help/` and the three `src/lib/help*.ts`
modules. The research tables give the target text. The rules:

- **The counts at the top.** "the strip" becomes "the counts at the top" (of the Orders page, of
  the Workflows list). Where the help is telling the reader to press one, name it: "press Not
  started at the top of the list". "cell" becomes the count, or the column ("the Issues column").
  "value" in "one value at a time" becomes "choice".
- **Menu.** "the Show select" → "the Show menu", and so for Team, Workflow and Assign team.
  "sets the Show and Team selects aside" → "ignores the Show and Team menus".
- **Window.** "The modal says…" → "A window opens and says…" or "The window says…".
- **Current.** The word stays. Reword the sentences built around it, as decision 8 lists: "Each
  task whose step is current shows…" → "Once every earlier step is done, each task in the next
  step shows…". "A task in a later step, not yet current, offers only Assign team" → "A task in a
  later step offers only Assign team". Find others with `grep -rn "is current\|not yet current"`.
- **In force, on record, record.** As the research table: "the steps it has now", "Steps already
  done still show on the order", "so you can see who did what", "mark it done".
- **A Done, presses.** "To take back its last Done" → "To undo the last Done, press Reopen". The
  research proposed "the last task marked done", but "marked done" is already a retired word.
  The heading "Undo a Done" becomes "Undo Done". "Your own presses read Merchant" goes in phase 4
  with the label.
- **You.** On merchant help pages (everything but `members/`), "the merchant" becomes "you":
  Who can do what, the Reference rows in `helpReference.ts`, and the summaries in `helpPages.ts`.
  Member help keeps "the merchant". The table headers Member and Merchant on Who can do what stay.
- **Billing.** `plans-and-billing.tsx` and `getting-started/installing.tsx`: the research's
  billing table ("uncount", "Baton refuses nothing", "tile").
- **Meta phrasing.** The research's last table: "The words" heading, "What else has to hold", "A
  match never moves an item", "the workflow should build", "its tasks reach the members",
  "Baton takes each item a Shopify order sells", "no item's workflow is still open".
- **Syncing from Shopify.** "the newest copy wins whichever message arrives first", "resizes its
  workflow", "splits a product's tags on commas" (Creating a workflow), "while the page
  connects" (Removing and deleting): the research's engineering table.
- **Titles.** In `helpPages.ts`: "States and badges" → "Badges", "Recording your work" →
  "Starting and finishing tasks". Update every link whose text is the old title (`grep -rn
  "States and badges\|Recording your work" src`) and the page headings if they repeat it. The
  summaries in `helpPages.ts` follow the same rules. Fix "The strip's positions and Issues, the
  Show select, the Team select and search." and "The strip's five filters, the Team select and
  search.", "counted orders", "An item matches a tag", "what each means and what clears it".
- **Alt text** in `helpPictures.ts` follows the same rules ("The Block window", "the Team menu",
  "the Issues column", "still show on the order").
- The JSDoc on each help body that quotes old copy is updated to match. A JSDoc that says a page
  "names the strip" says what it now says.

### 2.1 Tests

`test/integration/help-pages.test.ts` and `help-reference.test.ts` may assert titles or rows.
Update them to the new text. Do not delete a test.

### 2.2 Done when

`pnpm lint` has no hits under `src/components/help/` or `src/lib/help*.ts`. Read every changed
help page in the browser at `/help/...` once.

## Phase 3: screens

| where                                           | now                                                                                                                                                 | new                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/app.index.tsx:288`                  | heading "Usage and capacity"                                                                                                                        | "Your plan"                                                                                                                                                            |
| `src/routes/app.index.tsx:309`                  | "{n} past your plan's included seats is/are billed at your plan's rate."                                                                            | "{n} over. Extra members are billed at your plan's rate." (as the orders tile says)                                                                                    |
| `src/routes/app.orders.index.tsx:378`           | "Sync open orders to pull in what is on the bench … order webhooks keep them current."                                                              | "Press Sync open orders to bring in your open orders from the last {30} days, or wait for the next order. After that, Baton adds each new order as it is placed."      |
| `src/routes/app.orders.$orderId.tsx:80`         | "…so there is no work left to attach."                                                                                                              | "This order is cancelled or fulfilled in Shopify, so you can't attach a workflow to it."                                                                               |
| `src/lib/changeWarning.ts:95`                   | "Steps already done stay on record."                                                                                                                | "Steps already done still show on the order."                                                                                                                          |
| `src/lib/SocketBanner.tsx:103`                  | "Not connected to this shop. Live updates are paused and changes on this page are disabled until the connection returns."                           | "Baton lost its connection. This page won't update, and you can't make changes until it reconnects."                                                                   |
| `src/lib/workflowShared.ts:136`                 | "…the products the workflow should build."                                                                                                          | "…the products this workflow is for."                                                                                                                                  |
| `src/routes/login.tsx`                          | "Send magic link", "Open your magic link", "a magic sign-in link", "The magic link appears here after you submit.", "Couldn't send the magic link." | "Send sign-in link", "Open your sign-in link", "a sign-in link", "The sign-in link appears here after you press Send sign-in link.", "Couldn't send the sign-in link." |
| `src/routes/login-callback.tsx:53, 65`          | "This magic link has expired…", "Request a new magic link"                                                                                          | "This sign-in link has expired or was already used.", "Request a new sign-in link"                                                                                     |
| `src/components/help/members/signing-in.tsx:26` | "Send magic link"                                                                                                                                   | "Send sign-in link"                                                                                                                                                    |

Then every remaining `pnpm lint` hit in screen files: a modal heading or body that says "modal",
a "select" in copy, and so on. Line numbers are as of 2026-10-09. Find each by its text.

Check the copy, controls and parts tables on `CopySlot`, `Control` and `ScreenPart`
(`src/lib/Screen.ts`). `pnpm spec check` refuses an example no screen shows. If an example quotes
changed copy, change the example.

### 3.1 Tests

- `test/integration/change-warning.test.ts`: the cancel warning's text and its test title ("done
  steps stay on record" → "done steps still show on the order").
- `e2e/orders.spec.ts`: "Steps already done stay on record." → the new text. The test titled "the
  strip and the Show select hold one value" keeps its meaning. Retitle it "the counts at the top
  and the Show menu hold one value".
- `e2e/member.ts` and `e2e/member-area.member.spec.ts`: "Send magic link" and "Open your magic
  link" → the new button and link text. Test titles that say "magic link" may stay. They name the
  mechanism, not copy.

### 3.2 Done when

`pnpm lint` has no hits. `pnpm test` passes.

## Phase 4: "You" instead of "Merchant"

Today `actorLabel` (`src/lib/domain/ShopWork.ts`) spells the merchant "Merchant" on every
screen. The order page shows "Done by Merchant" to the merchant. The vocabulary's merchant row
says "you" to the merchant and "the merchant" to a member.

- `actorLabel` takes who is looking. The merchant looking sees "you" for the merchant ("Done by
  you", "Blocked by you"). Where the label stands alone as a segment, as in `RunSteps`
  ("Sewing · Merchant · 2 h"), it reads "You". A member looking keeps "Merchant", as today. The
  JSDoc on `actorLabel` states the rule once, with the vocabulary row's words. Every caller passes
  the viewer.
- Callers: `src/components/RunSteps.tsx` (used on the order page and the member's item page),
  `src/components/MemberRun.tsx` (member only), `src/routes/shop.$shop.workflows.index.tsx`
  (member only), and the label at `ShopWork.ts` near `Started by` (check who sees it).
- Help: `orders/order-page.tsx` says "Your own presses read Merchant, and a member's read their
  email." It becomes "What you did shows You. What a member did shows their email." Check
  Attaching a workflow and Fixing issues for "by Merchant".
- Tests: `test/integration/domain.test.ts` ("Cut · Started by Merchant", check which viewer it
  renders for), and any e2e under `e2e/` that reads "by Merchant" on the order page
  (`e2e/fixture.ts` comments name "Blocked by Merchant"). `e2e/member-runs.member.spec.ts` reads
  "by Merchant · " on a member screen. That stays.
- Add a test titled with the rule, for example "the merchant sees their own work as you, a member
  sees it as Merchant".

### 4.1 Done when

`pnpm typecheck`, `pnpm lint` and `pnpm test` pass.

## Phase 5: the whole

- `npm run test:e2e --`. Then `pnpm seed`, since the e2e seed replaces the dev shop's data.
- `node scripts/copy-audit.ts > /tmp/copy-audit.md` and search it for the retired words, "the
  merchant" on merchant screens, and "position" (which stays).
- `bash -c 'grep -rn -i "strip\|modal\|select\b\|in force\|on record" src/components/help src/lib/help*.ts'`
  and read what is left. Each hit should be a comment or an identifier.
- Read the help pages in the browser: Orders list, Fixing issues, Attaching a workflow, Badges,
  Who can do what, Plans and billing, Finding your work, Starting and finishing tasks, Signing in.
  Look at the home page's Your plan section and the sign-in page.
- `pnpm fmt`. Keep every file it touches.

## Deviations and issues

Record here as you go. One entry each: the phase, what you found, the options, what you did.

- **Phase 1, hits that were not copy.** `\bstrip\b` hit `import { Strip } from
  "@/components/screen/Strip"` in three routes, `\btiles?\b` hit the `Tiles` import, and
  `\bmodals?\b` hit `HTMLElementTagNameMap["s-modal"]` in `WorkflowTag.tsx`. Options: a
  per-file exemption, or the guard `run` already has. Took the guard: verb, strip, cell, modal,
  tile and seat are matched only as words not joined to a path or identifier
  (`(?<![-_/.$\w])…\b(?![-_/$]|\.\w)`), as `run` is. The select, in force, on record and
  uncount patterns needed no guard.
- **Phase 1, `helpPages.ts` under the anchored patterns.** Bringing `helpPages.ts` into scope
  made `slug: "syncing"` and `title: "Syncing from Shopify"` hits of the existing `^syncing`
  pattern (a write in flight), though neither is a status line. The help-pages test already
  exempts a title from the anchored patterns. Options: leave `helpPages.ts` out of the lint and
  rely on its test, exempt the file, or teach `retiredCopyHits` the two keys. Took the last: a
  `title:` line is held to the unanchored patterns, as a help link's text is, and a `slug:` line
  is not read. Test: "a help page's title is held to the patterns that match anywhere, and its
  slug is not read".
- **Phase 1, `pnpm test` not green.** The plan says phase 1 is done when `pnpm test` passes, but
  `help-pages.test.ts` ("help copy is free of the retired words") and `help-reference.test.ts`
  ("the reference copy is free of the retired words") hold the help modules to `RETIRED`, so
  the new rows fail them until phase 2 rewords the copy. Expected, the same hits as the lint.
  Left red through phase 1. Their JSDoc said the lint does not read `src/lib/`. Updated: the
  lint reads the module a line at a time, the test reads each string whole.
- **Phase 1, hit counts per file** (the work list):

  ```
    25 src/lib/helpPictures.ts
    12 src/components/help/orders/orders-list.tsx
    11 src/lib/helpReference.ts
     4 src/components/help/workflows/editing.tsx
     4 src/components/help/orders/attaching-a-workflow.tsx
     3 src/lib/helpPages.ts
     3 src/components/help/reference/states-and-badges.tsx
     3 src/components/help/reference/plans-and-billing.tsx
     2 src/components/help/workflows/turning-on-and-off.tsx
     2 src/components/help/workflows/managing.tsx
     2 src/components/help/teams-and-members/removing-and-deleting.tsx
     2 src/components/help/members/finding-your-work.tsx
     1 src/routes/app.index.tsx
     1 src/lib/changeWarning.ts
     1 src/components/help/teams-and-members/creating-a-team.tsx
     1 src/components/help/teams-and-members/adding-a-member.tsx
     1 src/components/help/orders/fixing-issues.tsx
     1 src/components/help/getting-started/installing.tsx
     1 src/components/help/getting-started/first-workflow.tsx
     1 src/components/help/getting-started/first-order.tsx
  ```

  The lint reads a line at a time, so a retired word in the middle of a wrapped JSX paragraph
  that the line reader takes for code is missed. Phase 5's grep is the backstop.

- **Phase 2, hits the lint had not listed as new.** Once `helpPictures.ts` was in scope, two alt
  texts hit words retired before this plan: "Three steps run in order" (`run`) and "a leather
  journal marked Done" (`marked done`). Reworded: "Three steps, in order", and "reading Making",
  "reading Done", "reading Not started".
- **Phase 2, alt text length.** `help-pages.test.ts` holds every alt text to 30 to 60 words. "The
  counts at the top cover" is longer than "The strip counts", so `findingYourWork1` and
  `ordersList1` went to 62, and `orderPage1` to 64 with "with a Done badge". Shortened to
  "Counts at the top cover", "rows show", "Below sit" and "reading Done".
- **Phase 2, first-order's "current" sentence.** Decision 8 gives "Once every earlier step is
  done, each task in the next step shows…" for "Each task whose step is current shows…". On
  Following an order through its workflow that sentence describes a new order, where there is
  no earlier step, and the next paragraph already says the next step's tasks read Ready.
  Options: the decision's words, or name the step. Wrote "Each task in the first step shows on
  the Workflows list of every member on its team, and reads Ready." The other "current"
  sentences take the decision's form: "Every earlier step is done and nobody has started it"
  (the Ready row on Badges, and Ready on Finding your work), "until every earlier step is done"
  (a task's badge on Badges), "A task in a later step offers only Assign team, to you" (Who can
  do what). "current task" in the other sentences stays, per decision 8.
- **Phase 2, the pictures show the old copy.** The alt texts now describe the new copy: Your plan
  on the home page, "the products this workflow is for" in the Create, Edit tag and Duplicate
  windows, and "steps already done still show on the order" in the Cancel workflow window. The
  PNGs under `public/assets/help/` were shot before phase 3 and still show "Usage and capacity",
  "the products the workflow should build" and "stay on record". The plan has no step to reshoot
  them. Options: reshoot with `scripts/help-screenshots.ts` (needs the showcase shop), or leave
  them for the next help cycle. Left them: the reshoot is outside the plan and replaces the dev
  shop's data. The pictures to reshoot are `installing1`, `firstWorkflow1`, `matching2`,
  `managing1` and `attachingAWorkflow3`. Also `scripts/help-screenshots.ts` presses "Send magic
  link" and "Open your magic link" (see phase 3).
- **Phase 2, other rewordings beyond the research tables**, found while reading each page:
  "the items the workflow builds" → "the items this workflow is for" (Creating your first
  workflow, as "should build"); "the tasks go back to the state they had" → "how they were"
  (Blocking); "the current task and its state" → "and its badge" (Finding your work); "shows
  each workflow's state" → "shows whether each workflow is Active or Inactive" (Badges);
  "whatever state its workflow is in" → "whether its workflow is open, done or closed" (the
  Change workflow row); "Baton records that you started it too" → "Baton marks it started too",
  and "Done without Start records the start too" → "also marks it started"; "the email at the
  top is who every Start and Done is recorded for" → "is the name every Start and Done shows";
  "recorded work keeps its names" → "work already done keeps its names" (the Delete row); the
  Badges issues table's column "What clears it" → "How to fix it", to match the summary; the
  Badges summary "Task states, workflow states, order positions, issues and faults" → "What
  each badge means on an order, an item, a task, a workflow, a team and a member."; the
  research's "cancelling the workflow afterwards does not take the order back off" took "your
  bill" at its end so the sentence says off what.
- **Phase 2, "Starting and finishing tasks".** The retired pattern is `\bfinish(?:ed)?\b`, so
  "finishing" passes the lint. The title is decision 6's, so it stays. Noted because the retired
  table's reason ("done (a task)") reads against it.
- **Phase 2, "Send magic link" on Signing in** is left for phase 3, with the login screen it
  quotes, as the plan's phase 3 table lists it.
- **Phase 3, two more sign-in sentences.** `login.tsx` also says "Enter your email to receive a
  magic sign-in link." and "a magic sign-in link has been sent." Both took "a sign-in link", as
  the table's "a magic sign-in link" row says.
- **Phase 3, sites the plan did not list.** `e2e/members.spec.ts` matched the home page's old
  members line (`/past your plan's included seats/u`); it now matches `/Extra members are billed
  at your plan's rate/u`. Its title ("…the home tile says it is billed") stays: a test title, not
  copy. `scripts/help-screenshots.ts` waited for "Steps already done stay on record." and pressed
  "Send magic link" and "Open your magic link"; updated to the new text so the next reshoot runs.
  The comment on `installing1` in `helpPictures.ts` named "Usage and capacity"; now "Your plan".
- **Phase 3, the dev kit.** `src/routes/dev.kit.tsx` repeats the old Orders empty sentence ("Sync
  open orders to pull in what is on the bench…"). The kit is out of scope and the lint does not
  read it. Left as is. The kit shows a part with sample copy, so the stale sentence shows only on
  `/dev/kit`.
- **Phase 3, the copy, controls and parts tables.** No example in `CopySlot`, `Control` or
  `ScreenPart` quoted changed copy. `pnpm spec check` passed with no edit. The tables' own words
  (strip, cell, modal, select) are JSDoc and stay, as the scope says.
- **Phase 3, `pnpm lint` green at the end of phase 3**, as the task asked (the plan said phase 4).
- **Phase 4, no "Done by" on the order page.** The plan's examples ("Done by you", "Blocked by
  you") are not what the screens print: `RunSteps` shows "<team> · <who> · <when>" under a Done
  or Started badge, and the block banner shows "<who> · <when>". Every `actorLabel` site prints
  the label as a segment, so the merchant reads "You" on both. The one "by" sentence, "Started
  by Merchant" in `runRowLines`, is on the member's Workflows list, where the merchant stays
  "Merchant". `actorLabel` therefore has one form per viewer, not a sentence form and a segment
  form. Its JSDoc says so.
- **Phase 4, the viewer at each site.** `actorLabel(actor, viewer)`. `RunSteps` and `BlockBanner`
  took a `viewer` prop (the order page passes `merchant`, the member's item page `member`),
  `blockedByLabel` a `viewer` argument; `runRowLines` and `doneActorLabel` on the member's list
  pass `member`. `ClosedLine` and `closedReasonText` already took a viewer and are unchanged.
- **Phase 4, tests.** New: "the merchant sees their own work as you, a member sees it as
  Merchant" in `test/integration/domain.test.ts`. `run-repository.test.ts` reads the block's
  label as a member would ("Merchant"). `domain.test.ts`'s "Cut · Started by Merchant" is the
  member's list and stays. `e2e/orders.spec.ts` now expects "<team> · You · " after Done and
  "You · " in the block banner (`doneByMerchant` renamed `doneByYou`); the comments in
  `e2e/fixture.ts` that quoted "Merchant" on the order page now quote "You".
  `e2e/member-runs.member.spec.ts` ("by Merchant · ", "<team> · Merchant") is the member's
  screens and stays.
- **Phase 5, results.** `npm run test:e2e --`: 95 passed (3.9 min), then `pnpm seed`. The copy
  audit (`/tmp/copy-audit.md`, 935 strings) has no retired word (the audit drops them by
  design, so `pnpm lint` passing is the real check); "the merchant" shows only on member
  screens (the member's empty list, the shop picker, the member's item page, `closedReasonText`
  for a member); "position" stays on Reading the orders list and Badges. The plan's grep over
  `src/components/help` and `src/lib/help*.ts` leaves only JSDoc, comments, picture comments
  ("Shape: modal" names a picture shape) and identifiers (`RecordingYourWork`).
- **Phase 5, reading in the browser.** Read with `pnpm playwright-cli` headless, after
  `body[data-hydrated="true"]`: the nine pages the plan lists, and once each the fifteen other
  help pages phase 2 changed. The sign-in page reads "Demo mode: no emails are sent. The
  sign-in link appears here after you press Send sign-in link." with a Send sign-in link
  button, and the expired-link page "This sign-in link has expired or was already used." with
  Request a new sign-in link. The home page is embedded in the Shopify admin, so it was read
  with a short Playwright script (in `/tmp`, not kept) on the e2e admin session
  (`playwright/.auth/shopify-admin.json`), the way the embedded e2e project opens it: the section reads Your plan, then
  Orders this billing cycle and Members. The members-over line did not show (3 members, 3
  included); `e2e/members.spec.ts` covers it.
- **Phase 5, one rewording after reading.** Plans and billing read "…and Orders this billing
  cycle says when the cycle resets. Members shows how many you have today." after naming both
  headings in the sentence before. Reworded to "On the home page, under Your plan, Orders this
  billing cycle and Members show where you stand against what your plan includes. Orders this
  billing cycle also says when the cycle resets, and Members shows how many members you have
  today."

### Review, 2026-10-09

The implementation was checked after the five phases: the diff read, and `pnpm typecheck`,
`pnpm lint` and `pnpm test` rerun (804 passing). The copy matches the research tables. What
was done about the open items:

- **The help pictures.** The five stale pictures were retaken with `pnpm help:screenshots`, a
  section at a time (`workflows`, `getting-started`, `orders`): the full run and the first
  `orders` run each stopped on a wait that timed out. `matching2` was a one-off (the Edit tag
  window did not open on the first try; the rerun shot it). `fixingIssues2` failed every time:
  `openRow` pressed the #1209 link with Playwright's pointer, and that row is the last Issues
  row, at about 720 px, inside the dead band a page shot's viewport resize leaves (the cause on
  `openModalBy`). `openRow` now clicks the link natively, as `openModalBy` does, and says why.
  Nineteen pictures changed bytes (a rerun stamps the clock), the five that needed it among
  them; each was looked at and shows the new copy. The dev store was put back on the
  development fixture by the script's closing reseed.
- **Fixing issues picture 1 gained a row.** It now lists eleven orders, not ten: #1003, the
  real leather journal order `scripts/lib/showcase-store.ts` creates, had been synced into
  Baton by the getting-started block's first-order walk and survived the orders block's
  showcase seed, where the committed picture was shot without it. Its Pack task lost its
  team with the others, so it reads Needs a team. Options: cancel the order and reshoot, or
  keep the row. Kept: it is a showcase order and reads as the rest do. The alt text now says
  nine leather journal orders, and the inventory's `aspectRatio` is `1056/775`.
- **The dev kit.** Its Orders empty sentence now reads as the Orders page does. The kit is
  out of scope for the lint, but it shows the part with the page's copy, so a stale sentence
  there misleads the next shape change.
- The rest of the deviations stand as recorded: the guarded patterns, the `title:` and `slug:`
  handling, the alt-text shortenings, the first-order "current" sentence, and the "Starting
  and finishing tasks" title against the `finished` row.
