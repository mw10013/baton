# The order detail page redesign: implementation plan

Status 2026-09-15: **done**, all five phases, with three deviations recorded
under "Deviations" at the foot of this document and five review fixes under
"Review fixes" after it. The reasoning and every product decision are in
`docs/order-detail-ux-research.md`; its "Decisions" list is binding, and where the
body of that doc disagrees with the decisions, the decisions win. This document is
the order of work. Like `docs/orders-operational-surface-implementation-plan.md`, it
is disposable once the code is in and any deviations are folded back into the
research doc.

Vocabulary is the research doc's: the **item card** is one line item's section; the
**trail** is `stepTrail`'s inline step list; the **Now line** is the new read-only
current-step line; the **strip** is the wrapping full-width block that replaces free
text in a badge; the **disclosure** is what `Manage` opens.

Everything here is in one file — `src/routes/app.orders.$orderId.tsx` — plus its two
e2e specs and one `Domain` helper. **There is no schema change, no migration, no
Durable Object reset, no seed change, and no new callable.** Every phase is a render
change over data the page already holds.

## Ground rules

- **Five phases, each green before the next.** `pnpm typecheck`, `pnpm lint`,
  `pnpm test` after every phase; `npm run test:e2e -- orders.spec.ts` after Phases 1
  and 4, which are the ones that move selectors.
- **No new server function, callable, or query.** `getOrderDetail` already returns
  everything: `order`, `lineItems`, `runs` (each with its steps), `orderWorkflow`,
  `orderWorkflowBlocker`, `itemWorkflows`, `teams`.
- **`manageRows` keeps every action it has.** This redesign demotes and re-houses
  interventions; it removes none. If an action disappears, the phase is wrong.
- **Attention states never move behind a disclosure.** `stepTrail`'s unassigned-step
  `Assign team` row and its empty-team warning stay inline and always visible. The
  new blocked strip joins them.
- **Copy is fixed by this plan.** Do not invent variants. Every string that changes
  is spelled out below; `Manage` / `Hide` keep their labels.
- Follow `CLAUDE.md`: Effect v4 idioms, namespace imports, `readonly`/`const`,
  optional chaining, JSDoc carrying its reasoning inline and **never** pointing at
  `docs/`, then `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (keep every file it
  touches). `pnpm graphql-codegen` is not needed — no `#graphql` string changes.

> [!IMPORTANT]
> `e2e/orders.spec.ts:86` asserts on
> `s-section[accessibilityLabel="Line items"]`, which Phase 1 deletes, and
> `e2e/orders.spec.ts:148` asserts the exact sentence "Order workflow is off, so it
> will not start on this order." which Phase 3 shortens. Both are updated in the
> phase that breaks them, not later.

## Phase 1: subtract

Pure deletion and one extraction. This phase alone removes most of the noise, and
nothing in it depends on anything below.

Files: `src/routes/app.orders.$orderId.tsx`, `e2e/orders.spec.ts`.

1. **Delete `startedLines`** (`:654`) and its render block (`:1126-1133`). The
   `supplemental-start` stack keeps the `no_workflow` paragraph, the `ready_to_ship`
   banner, the `lineItemsComplete` warning and the error banner; drop `startedLines`
   from the stack's visibility condition at `:1119`.
2. **Delete the `Line items` wrapper section** (`:1154`). `lineItems.map(renderLineItem)`
   moves to the page body directly, and `renderLineItem`'s own `s-section` becomes
   top-level. Keep the empty case as a bare `s-paragraph` — `No line items.` — with no
   section around it.
3. **Stop concatenating the block reason into the badge.** `flagLabel` (`:140`) drops
   its `blocked` branch and returns `RUN_FLAG_LABEL.blocked` — the word `Blocked` —
   like every other flag. The reason moves to the strip in Phase 2. Nothing else
   reads `flagLabel`.
4. **`Attach workflow` becomes a disclosure.** A new `attachOpen: ReadonlySet<string>`
   of line item ids, defaulting empty. Closed, the item card shows a
   `variant="tertiary"` button labelled `Attach workflow`; open, it shows the existing
   `s-grid` with the select, the `Attach` button, and a `Cancel` that closes it. The
   grid's markup is unchanged (`:1030-1073`) — including the JSDoc at `:1032`
   explaining why it is a grid and not an inline stack, which stays exactly as it is.
5. **Update `e2e/orders.spec.ts:86`** to assert on the first line item's section
   instead of the wrapper: `s-section[accessibilityLabel="Signet ring"]` for the seed
   order the spec navigates to, or the item title the fixture at `:84` lands on.
   Check the seed before writing the selector.

Done when: the page renders one card per line item, no "started for" lines, a
`Blocked` badge with no prose in it, and no visible select until `Attach workflow` is
clicked.

## Phase 2: the item card

Files: `src/routes/app.orders.$orderId.tsx`.

1. **The strip.** A new module-level helper beside `blockedLine` (`:220`):

   ```ts
   /**
    * A run's blocked state as a wrapping block rather than a badge. The reason is
    * merchant prose up to `Domain.StepNote`'s 1000 characters; a badge is sized for
    * a closed vocabulary and a long reason there stretches the row until the run's
    * own controls leave the viewport. The ready step is named because `blocked` is
    * a run-level flag (`merchantBlockRun` takes a `runId`) and on a multi-stage run
    * "blocked" alone does not say what is stuck.
    */
   const blockedStrip = (...) => ...
   ```

   Rendered as an `s-box` with `background="subdued"`, `borderWidth="base"`,
   `padding="small"`, holding: a `s-text type="strong"` reading
   `Blocked · <ready step name>` (or just `Blocked` when no step is ready — a
   cancelled or finished run), the reason as an `s-paragraph`, the existing
   `blockedLine` actor/time as subdued text, and the `Unblock` button lifted out of
   `manageRows` (`:843-862`). `Unblock` stays in the disclosure as well; a merchant
   who opened `Manage` should not have to close it to unblock.

2. **The Now line.** A read-only line under the trail, from the run's own steps:
   - ready step exists → `Now · <step> · <team>`, plus `· since <time>` when
     `startedAt` is set, through `LocalDateTime format="time"`.
   - pending order run with open item runs → the existing `Waiting for N items`
     line (`:967-973`), which moves here unchanged.
   - `run.status === "done"` → `Done · N stages`, the string `stepTrail`'s `progress`
     already computes (`:274`).

   Reuse `manageStateLine`'s vocabulary (`:186`) rather than inventing a second
   phrasing; extract the shared bits if it saves a duplicate, otherwise keep them
   separate and add a JSDoc on each saying the other exists and why they differ.

3. **Demote the trail's own progress line.** `stepTrail` prints `Stage 2 of 3` above
   the trail (`:300`). With a Now line under it that is one restatement too many:
   move `Stage N of M` inline to the end of the trail row as subdued text.

4. **The order summary line.** Directly under the page heading, before the cards,
   and **only** when `lineItems.length > 1` or any run has a flag or an unassigned
   step. Built from data in hand:

   `<N> items · <B> blocked · <D> made · waiting on <teams>`

   Each clause is omitted when its count is zero; `waiting on` lists the distinct
   team names of ready steps on open runs, capped at three with `+N more`. `made`
   counts line items whose every non-cancelled run is `done`.

> [!NOTE]
> The four-row budget from decision 3 is the acceptance test for this phase. Open a
> seed order with personalization, a flag and three steps: title row, personalization
> row, trail row, Now line. If a fifth row appears at rest, something belongs in the
> disclosure.

## Phase 3: phases and naming

Files: `src/routes/app.orders.$orderId.tsx`, `e2e/orders.spec.ts`.

1. **The order workflow section is headed by the workflow's own name**, not the
   literal `Order workflow`: `heading={orderWorkflow.name}`. Its
   `accessibilityLabel` stays `Order workflow` so the concept remains addressable
   from tests and assistive tech.
2. **Its subtitle is the invariant**, a subdued line directly under the heading:
   `Starts when every item is made`. Never "Shipping", "Packing" or "Fulfilment".
3. **`orderWorkflowLine` shrinks to one line each** (`:573`). The five branches keep
   their meanings and their links, and lose the trailing explanation that repeats the
   invariant now stated in the subtitle:
   - `off` → `` `${name} is off.` `` + `Turn it on` link.
   - `no_steps` / `no_team` → `` `${name} cannot start: it has no steps.` `` /
     `` `… a step with no team.` `` + `Fix the workflow` link.
   - `tooOld` → `Placed before ${name} was turned on. Attaching a workflow to an item opts the order in.`
   - `itemRunCount === 0` → `No item on this order has a workflow.`
   - `itemRunsAllCancelled` → `Every item run on this order was cancelled.`
   - otherwise → nothing; the subtitle already says it.
4. **The section is hidden when it has nothing to say.** Replace the condition at
   `:1162` — `orderRuns.length > 0 || Domain.canStartRuns(order)` — with: there is an
   order run, **or** `orderWorkflowBlocker !== null` (a blocker the merchant can act
   on), **or** `tooOld || itemRunCount === 0 || itemRunsAllCancelled` (a reason worth
   stating). A healthy order workflow that simply has not started yet still shows —
   its trail is the answer to "what happens after this is made" — but an order with
   no runs, no blockers and nothing to explain shows nothing.
5. **Update `e2e/orders.spec.ts:145-151`** to the shortened `off` sentence:
   `Order workflow is off.` The `Turn it on` link assertion at `:154` is unchanged.

## Phase 4: calm the disclosure

`manageRows` (`:733`) keeps every action. This phase changes weight, not content.

Files: `src/routes/app.orders.$orderId.tsx`, `e2e/orders.spec.ts`.

1. **`Mark done` loses `variant="primary"`** (`:790`) and becomes `secondary`, equal
   in weight to `Reopen`. Add a JSDoc on `manageRows` stating why inline, in the
   shape the file already uses:

   ```ts
   /**
    * … No action here is primary. Every write on this page is a merchant reaching
    * past a worker — the bench claims and completes steps on the work page — and a
    * primary button is the grammar of "this is what you came here to do", which is
    * false here.
    */
   ```

2. **The note renders as a paragraph.** `Domain.stepNoteLine(step)` currently prints
   through a single `s-text` (`:784`). It becomes an `s-paragraph` inside a subdued
   `s-box`, so 1000 characters wrap instead of stretching the row. Keep
   `stepNoteLine`'s `Note (Merchant):` prefix exactly as it is.
3. **The note editor gains a remaining-character count** once the draft passes 800,
   as subdued text beside `Save note` (`noteEditor`, `:674`). `Domain.StepNote` caps
   at 1000 (`Domain.ts:440`) and a silent refusal mid-paragraph is the failure mode.
4. **Fix the forbidden doc reference.** The JSDoc at `:669-673` cites
   `` `docs/…-research.md` ``, which `CLAUDE.md` forbids. Rewrite it to carry the
   reasoning inline — the safeguard is that the current text sits in the field before
   it is overwritten, so a merchant sees what they are about to destroy; a step has
   one note and last write wins, and anyone with access to the step can write it,
   not only the member who claimed it. Do not delete the comment; replace its
   pointer with its content.
5. **Group the run-level actions.** `Block` / `Unblock` and `Cancel` move below an
   `s-divider` at the bottom of the disclosure, after the step rows, so the step list
   reads as one object and the run actions as another.
6. **A step with no available action renders as one line.** The `s-box` per step
   (`:760-841`) is kept only for the ready step and for finished steps — the ones
   with a `Mark done`, a `Reopen`, or a reopen refusal to show. A step in a later
   stage collapses to a single subdued line, `<stage> <name> · <team> · Waiting on
step <n>`, keeping its `Note` button and nothing else. On a three-step run this is
   roughly half the disclosure's height, and it is the change that makes decision 13
   hold without a drawer.
7. **Prune `managing` against the runs in hand.** `managing` (`:396`) is a set of run ids in
   React state; a run cancelled from another session repaints the page but leaves its
   id in the set. Drop ids with no matching run on each render — cheap, and it keeps
   the open/closed state honest. The set survives re-renders by design: the
   subscription updates query data, it does not remount, so a webhook landing while
   `Manage` is open must not close it. Add a JSDoc on `managing` saying so, because
   the next reader's instinct will be to reset it on new data.
8. **Update `e2e/orders.spec.ts`** where it depends on button variants or ordering —
   `:208` (`Mark done` hidden before `Manage`), `:212`, `:221`, `:223` all use
   `getByRole("button", { name: … })` and should survive unchanged; run the spec and
   fix only what actually breaks.

## Phase 5: the aside

Files: `src/routes/app.orders.$orderId.tsx`.

One row, added to the `Order details` grid (`:1181`) above `Placed`, and only when
`lineItems.length > 1`:

```
Items    3 items, 7 units
```

`units` sums `Domain.unitsToMake(item)` across line items — the same count the card
shows, so the two cannot disagree. No quantity row for single-item orders, and no
per-item quantity in the aside ever (decision 8).

## Not in this plan

Recorded so the next reader does not assume they were forgotten:

- **A step table for the order** — rejected for this page, kept in mind for the
  orders index.
- **A drawer for intervention** — revisit only if the disclosure's step list keeps
  growing.
- **Collapsing made items**, **folding the aside**, and **hiding personalization on
  thin-personalization verticals** — the research doc's open questions 1, 2 and 4.
  Each is a follow-up, and each has a default assumed here.
- **Note threads** — a product decision that would bring an audit trail with it.

## Deviations

Three places where the code departs from the plan above. Each was forced by what the
page actually rendered, and each is here so the research doc can absorb it before
this document is thrown away.

1. **`blockedLine` lost the reason; it is attribution only.** Phase 2 said the strip
   holds "the existing `blockedLine` actor/time as subdued text", but `blockedLine`
   also appended `: <reason>` — so the strip would have printed the same merchant
   prose twice, once as its own paragraph and once inside the attribution line. It
   now returns `Blocked by <actor> · <time>` and nothing else, in both the strip and
   the disclosure. Decision 6 is the reason: the strip is where the sentence lives.

2. **An order run no longer prints its workflow name in `renderRun`.** Phase 3 makes
   the section heading the workflow's own name, which made the run row underneath it
   a verbatim restatement — the two-headings fault decision 2 deleted the `Line
items` wrapper for, reintroduced one section down. `renderRun` now suppresses the
   name for order runs only; an item run keeps it, because its section is headed by
   the line item, not the workflow.

3. **A third e2e assertion broke, not the two the plan flagged.**
   `orders.spec.ts`'s "blocks a run with a reason and unblocks it" asserted the old
   concatenated badge, `Blocked: Out of walnut stock`. It now reads the strip: the
   `Blocked · Cut` heading, the reason on its own, and the attribution line. Its
   `Unblock` click also takes `.first()`, because Phase 2 deliberately offers that
   button in two places at once — the strip and the still-open disclosure.

Two smaller notes that are not deviations but were left implicit by the plan:

- **A collapsed waiting step is one line plus its pickers, not one line.** Phase 4.6
  said "keeping its `Note` button and nothing else", which would have dropped the
  `Assign team` picker that the bordered box offered — and the ground rule that
  `manageRows` keeps every action wins over the row budget. The picker rides along
  and wraps to a second line at the embedded admin's width. Still roughly half the
  height of the box it replaced.
- **`managing` is pruned by reading, not by writing.** Phase 4.7 asked for stale ids
  to be dropped "on each render"; doing that with `setManaging` means a second render
  pass, so reads go through `managingRun`, which answers `false` for an id with no
  run on this order. Observably identical, and it keeps the "never reset on new data"
  rule the same JSDoc states.

## Review fixes

A second pass over the finished code, in the embedded admin with a 250-character
block reason, found five things the plan left open. Each is fixed; each is here so
the research doc can absorb it.

1. **The attach picker closes on a successful attach.** Phase 1.4 made it a
   disclosure but said nothing about after `Attach`; left open, the card showed
   the new run and, under it, a still-enabled `Attach` for the same workflow.
   `attachMutation.onSuccess` now drops the item from `attachOpen` and clears its
   `attachChoice` on `Ok`.
2. **No divider on a done run's disclosure.** Phase 4.5's `s-divider` rendered
   unconditionally, so `Manage` on a finished run ended in a rule with nothing
   under it. It renders only when a run action follows: the run is open or blocked.
3. **`Block` and `Save note` are secondary too.** Phase 4.1 demoted `Mark done` and
   wrote a JSDoc saying no action in the disclosure is primary, while `Block`
   (`primary` + `critical`) and `Save note` (`primary`) still were. Both are
   `secondary`; `Block` keeps its critical tone. The JSDoc now names all three.
4. **"Waiting on" excludes blocked runs, on the page and on the index.** The
   summary read `1 item · 1 blocked · waiting on E2E Block Bench` for one run, and
   the orders index's cell and team filter did the same, because `readyWhere` does
   not look at `flag`. The team cannot move a blocked run and `blocked` is already
   its clause, so the page's `waitingOn`, `OrderRepository`'s waiting-on read and
   its team filter all skip `flag = 'blocked'`. `readyWhere` itself is untouched:
   the worker queue still lists a blocked run, last, because the worker who blocked
   it is the one who unblocks it. One integration test covers the cell and filter.
5. **No Now line while blocked.** The strip already says `Blocked · Cut`; a `Now ·
Cut · Team` line directly under the trail named the same step twice on one
   card. `nowLine` returns nothing for a blocked run.

And one edge the review found by reading: `readySteps` now takes `openItemRuns`
and returns nothing for an order run while any item run is open — `readyWhere`'s
"item runs are stage zero" rule — so a blocked pending order run's strip says
`Blocked`, not `Blocked · Pack`.

## Acceptance

- One card per line item; no wrapper section; no "started for N items".
- A 200-character block reason wraps inside its strip and pushes nothing off screen.
- At rest, an ordinary order shows one page-level primary action (`Resync from
Shopify`) and no step-level primary action anywhere.
- An item card with personalization, a flag and three steps is four rows tall with
  the disclosure closed.
- The order workflow section is headed by the workflow's name, subtitled
  `Starts when every item is made`, and absent when there is nothing to say.
- Every action `manageRows` offered before the change is still reachable after it.
- No primary button inside a disclosure; `waiting on` never names a blocked run's
  team, on the page or on the index.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green; `npm run test:e2e` green on
  `orders.spec.ts`.
