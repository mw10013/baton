# Member area: implementation plan

Status 2026-09-12: **parked** with the research doc; Phase 6 (live updates) and the
"plain RPC through the Worker" assumption in Phases 4 and 5 depend on
`docs/member-auth-and-shopify-access-research.md`. Phases 1 to 3 are unaffected.

Written 2026-09-12 for hand-off. The reasoning and the decisions are in
`docs/member-ux-research.md`; this document is the order of work, the files, and the
tests, and it can be deleted when the work is done. Each phase leaves the app working
and shippable on its own. Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt`, and the
Playwright member project after each phase.

Vocabulary: a _run_ is one workflow applied to one line item or one order
(`Domain.WorkflowRun`); a _run step_ is one copied step of it (`Domain.WorkflowRunStep`);
a step is _ready_ when it is open and nothing in an earlier stage of its run is open
(`readyWhere` in `src/lib/WorkflowRunRepository.ts`); the _queue_ is every run with a
ready step on one of the member's teams (`listQueue`).

## Phase 1: landing and routes

Goal: a one-shop member lands on their work; the shop-info page is gone.

1. `src/routes/login-callback.tsx`: after `getSession`, for a non-admin call
   `repository.listMemberShops(email)`; redirect to `/shop/$shop` when exactly one, to
   `/shop` otherwise. Keep the existing doc comment's reasoning and add why one shop
   skips the picker.
2. Rename `src/routes/shop.$shop.queue.tsx` to `src/routes/shop.$shop.index.tsx`
   (delete the current index; it is the shop-info page). Move its one useful string,
   "You're not on a team yet. Ask the shop owner to add you to a team to see work", into
   the queue's empty state for `teams.length === 0`.
3. `src/routes/shop.index.tsx`: keep. It is the picker and the Sign out for multi-shop
   members.
4. Update `e2e/member-area.member.spec.ts`: the "opens their shop" test asserts the
   queue heading instead of the shop-info page; the "sees the teams they are on" test
   asserts the team chips (Phase 3) or, until then, the queue's grouping.
5. `src/routeTree.gen.ts` regenerates on `pnpm dev`; do not hand-edit.

## Phase 2: data the queue needs

Goal: the client can tier and sort without extra reads.

1. `WorkflowRun` gains `orderProcessedAt integer not null` in the Durable Object schema
   (`initializeSchema` in `src/lib/ShopAgent.ts`). Add it as a new migration entry in
   `runShopAgentMigrations` (`"2_run orderProcessedAt"`: `alter table … add column …
default 0`, then backfill from `ShopOrder.processedAt` by `orderId`). Snapshot it at
   run creation in `WorkflowRunRepository` wherever `WorkflowRun` rows are inserted
   (tag match in reconcile and the manual attach). Add the field to `Domain.WorkflowRun`.
2. `Domain.QueueLoaderData` gains `memberId` and `memberEmail` so the page can compute
   "Mine". Both already come out of `requireMember`.
3. `listQueue` already returns `startedByEmail`; nothing else is needed for tiers.

## Phase 3: the queue page

Goal: the page in the prototype (`docs/member-ux/prototype.html`): top bar, chips,
tiers, redesigned card.

1. Top bar as a small component (`src/components/MemberBar.tsx`): the mark from
   `public/favicon.svg` inlined as an `<svg>`, the shop name from `getShopInfo`, and a
   Sign out `s-button variant="tertiary"` posting the existing `signOutFn` (move it from
   `shop.index.tsx` into `src/lib/memberSignOut.ts` or similar so both pages share it).
   Render it above `s-page` in `shop.$shop.index.tsx` and the work page. Polaris
   `s-page` has no slot for chrome above the heading; a plain `s-box` with
   `borderBlockEndWidth="base"` and an inline `s-stack` is the component set.
2. Team chips (`s-clickable-chip`, one row in an `s-stack direction="inline"`) rendered
   only when `teams.length > 1`; "All" plus one per team, each with a count; the choice
   is client state, not a search param.
3. Tiers. A pure function in `src/lib/queueTiers.ts`, unit-tested with Vitest:
   `tierQueue(items, memberId)` returns `{ attention, mine, inProgress, upNext }`, each
   sorted by `run.orderProcessedAt` ascending. Rules: `run.flag !== null` → attention;
   any step `startedBy === memberId` → mine; any step `startedAt !== null` → in
   progress; else up next. Render a tier only when non-empty, with its count in the
   heading.
4. Card: order number as an `s-link` to `/shop/$shop/work/$runId`; workflow badge; tier
   badge (`critical` Blocked, `success` Mine, `info` In progress, none for Up next);
   "ordered 3d ago" via `LocalDateTime` with a relative format (add a `relative` format
   to `src/components/LocalDateTime.tsx` if absent); the item line; personalization as a
   two-column `s-grid` of label/value rather than a joined string; order note; flag
   banner; one step box per ready step with Start / Done only. Note and Block leave the
   card (Phase 5 puts them on the work page); until Phase 5 ships keep Block on the card
   so nothing is lost between phases.
5. Phone width: every button row is an `s-stack direction="inline"` that wraps; no
   text field beside a button.
6. Playwright: extend the member spec with a "tiers" test that seeds an order with
   `advance: 1, started: true` and another untouched, signs in as the starter, and
   asserts Mine above Up next.

## Phase 4: the Done tier and undo

Goal: what the team finished in the last 24 hours is visible, with Undo and Note.

1. Repository: `listDone({ teamIds, since })` in `WorkflowRunRepository`: run steps
   with `completedAt >= since` and `teamId in teamIds`, joined to their run, newest
   first, with the run's other steps so the downstream rule can be evaluated. Return
   type `Domain.DoneItem = { run, step, undoBlockedBy: null | { stepName, teamName } }`
   where `undoBlockedBy` names the first later-stage step that has `startedAt` or
   `completedAt`, or for an item run the order run's first started step.
2. Repository: `uncompleteStep({ runStepId, memberId, teamIds })` in a transaction:
   `requireActionable` (same team guard as the other actions, minus the readiness
   check); the step must be completed; compute `undoBlockedBy` as above and fail with a
   new `StepUndoBlockedError({ runStepId, stepName, teamName })` when set; `update
WorkflowRunStep set completedAt = null, completedBy = null, completedByEmail = null`;
   `recomputeStatus(run.id, now)`. Also clear `cancelledAt` is not needed (a cancelled
   run is terminal and refused by `isTerminal`).
3. `Domain.RunResult` gains a variant `UndoBlocked` with `stepName` and `teamName`;
   `ShopAgent` gets plain RPC `listDone` and `uncompleteStep` under the member-area
   methods; `ShopAgentClient` gets both with decoders; the seed does not need them.
4. Queue loader returns `done` beside `items` (24 hours back, capped at 100 rows).
5. Page: a fifth tier "Done today" rendered collapsed (an `s-button variant="tertiary"`
   toggling client state; count in the label). Each entry: order number link, item,
   step name, "by <email> at <time>", note, and Note / Undo. When `undoBlockedBy` is
   set, Undo is replaced by subdued text "<team> started <step> · ask them".
6. Playwright: "undo puts the step back in progress" (seed `advance: 1`, sign in as a
   member of the first step's team, open Done today, press Undo, assert the card is
   back under In progress); "undo is refused once downstream started" (seed
   `advance: 1, started: true`, sign in as the first team, assert the "ask them" text).
7. Vitest for `uncompleteStep` in the repository's existing test file, covering both
   branches and the order-run branch.

## Phase 5: the work page

Goal: `/shop/$shop/work/$runId`.

1. Route `src/routes/shop.$shop.work.$runId.tsx`. Loader: `requireMember`, then a new
   plain RPC `getRunForMember({ runId, teamIds })` on `ShopAgent` that returns
   `Domain.WorkflowRunDetail` plus the order's live line items (the same read the
   order-run card uses today) and the order note, or `null` when no step of the run is
   on one of the member's teams (render not found). Members may open a run they no
   longer have a ready step on (they finished it), which is why the guard is "any step
   on my teams", not "a ready step".
2. Sections, all `s-section`: This item / Items on this order; Steps (every step in
   stage order with state text, actor, time, instructions, note, and Start / Done /
   Note / Undo where the member's team owns it and the rule allows); Also on this order
   (item runs only); Order note; Block (the text field and "Mark blocked", or the
   Dismiss button when flagged). Move the note and block server functions from the
   queue route into `src/lib/memberRunActions.ts` so both routes share them.
3. `@media print` in a `<style>` on the page: hide the top bar and every button; the
   rest prints as the job ticket.
4. Playwright: open the work page from a card, assert the step history lists the seeded
   completed step with its actor, add a note, mark blocked, see the banner on the
   queue.

## Phase 6: live updates

Goal: a teammate's Done moves the card without a refresh.

The member area has no socket: `ShopAgent`'s WebSocket path authenticates with the
Shopify admin session token (`src/lib/ShopAgentContext.tsx`), and the member-area
methods are deliberately plain RPC through `ShopAgentClient` with `teamIds` resolved by
the Worker. Two options, in order of preference:

1. **Poll first.** `useQuery` on the queue loader data with `refetchInterval: 15_000`
   and `refetchOnWindowFocus: true`. Ten lines, no new trust boundary, good enough for a
   bench. Ship this with Phase 3.
2. **Member socket later.** A second `useAgent` path whose upgrade request carries the
   better-auth cookie; the Worker validates it and `requireMember` on connect, stores
   `teamIds` on the connection's state, and a `subscribeQueue` callable reads and
   subscribes in one round trip like `subscribeOrders`. The object must never accept
   `teamIds` from the socket message. This is a day of work and its own review; do it
   when polling is visibly not enough.

## Phase 7: seed and docs

1. `e2e/fixture.ts` needs no change for Phases 1–5. If a "done today" example is wanted
   on first seed, it already exists: `#1002` and `#1005` carry completed steps.
2. Remove the "Implementation plan" pointer from the research doc, or leave it; delete
   this file when Phase 6's decision is made.

## Out of scope, on purpose

Per-unit ticking, a print action, an undo audit trail, a member name field, a kiosk
mode, barcode scanning. Each has a note in the research doc's Rejected or Decisions
section.
