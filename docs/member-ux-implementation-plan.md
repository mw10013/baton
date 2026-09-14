# Member area: implementation plan

Status 2026-09-14: **implemented**, Phases 1 to 7, uncommitted at the time of writing.
The reasoning and the decisions are in `docs/member-ux-research.md`; the trust boundary
this rides on is `docs/member-auth-and-shopify-access-research.md`. This document was the
order of work and is kept only for the "Deviations" section at the end, which records
where the code departs from the plan as written on 2026-09-12. Delete it once that
section has been folded into the research doc or is no longer interesting.

Vocabulary: a _run_ is one workflow applied to one line item or one order
(`Domain.WorkflowRun`); a _run step_ is one copied step of it (`Domain.WorkflowRunStep`);
a step is _ready_ when it is open and nothing in an earlier stage of its run is open
(`readyWhere` in `src/lib/WorkflowRunRepository.ts`); the _queue_ is every run with a
ready step on one of the member's teams (`listQueue`).

## Phase 1: landing and routes — done

1. `src/routes/login-callback.tsx`: a non-admin with exactly one membership is sent to
   `/shop/$shop`; zero or several to `/shop`.
2. `src/routes/shop.$shop.queue.tsx` became `src/routes/shop.$shop.index.tsx`; the
   shop-info page is gone. Its "not on a team yet" sentence is the queue's empty state
   for `teams.length === 0`.
3. `src/routes/shop.index.tsx` kept as the picker; its sign-out moved to
   `src/lib/memberSignOut.ts` so the top bar shares it.
4. `src/routes/shop.$shop.tsx` gained a `notFoundComponent` ("You no longer have access
   to this shop", link to `/shop`), which is what a child loader's `notFound` renders.

## Phase 2: data the queue needs — done

1. `WorkflowRun.orderProcessedAt` in `initializeSchema`, snapshotted in `insertRun`. No
   second migration: the app is still in prototyping and every Durable Object is reset
   from scratch, so the column is simply part of the initial schema (review decision,
   2026-09-14).
2. `Domain.QueueLoaderData` carries `memberId` and `memberEmail`.

## Phase 3: the queue page — done

`src/components/MemberBar.tsx` (mark, shop domain, Sign out), team chips, tiers
(`src/lib/queueTiers.ts`, unit-tested in `test/integration/domain.test.ts`), the card
(`src/components/MemberRun.tsx` holds the pieces the work page shares), `relative`
format on `LocalDateTime`. Playwright: "a started card moves to Mine for the starter
and In progress for a teammate".

## Phase 4: the Done tier and undo — done

`listDone`, `uncompleteStep`, `undoBlockedBy` (exported, pure) and
`StepUndoBlockedError` in `WorkflowRunRepository`; `Domain.DoneItem`, `UndoBlocker`,
`RunResult.UndoBlocked`; `ShopAgent.uncompleteStep` as a member callable. Playwright:
"undo puts a finished step back in progress", "undo is refused once downstream
started". Vitest covers both branches and the order-run branch.

## Phase 5: the work page — done

`src/routes/shop.$shop.work.$runId.tsx`, on `Domain.RunView` (`getRunView` in the
repository; `getRunForMember` plain RPC for the loader, `subscribeRun` callable for the
socket). Sections as planned; `@media print` in `src/styles.css` hides `.print-hide`
and every `s-button`. Playwright: "the work page shows the step history and takes a
note, a block, and Done".

## Phase 6: live updates — done before this plan resumed

The member socket shipped with `docs/member-auth-and-shopify-access-research.md`
(commit `2d3a56b`), so neither option in the original Phase 6 was needed: the queue and
the work page both ride `useSubscribedQuery` over the member socket, and the Done tier
updates under the same push.

## Phase 7: seed and docs — done

`e2e/fixture.ts` needed no change; `e2e/seed.ts` and `e2e/member-queue.member.spec.ts`
gained an opt-in two-stage order (`withBand`) for the downstream-started tests.

## Deviations from the 2026-09-12 plan

Where the code departs, the code is right and this is the record.

- **No plain RPC for member mutations.** The plan predates the member socket. Reads
  that paint during SSR (`listQueue`, `getRunForMember`) are plain RPC through
  `ShopAgentClient`; every mutation, `uncompleteStep` included, is a `@callable()`
  behind `memberCallableEffect`, with `teamIds` from the connection. The planned
  `src/lib/memberRunActions.ts` of shared server functions became
  `src/lib/useMemberRunActions.ts`, a hook over the socket that both pages use.
- **The queue read is one value.** `listQueue` and `subscribeQueue` return
  `Domain.QueueView = { items, done }` rather than the loader adding `done` beside
  `items`: a teammate's Undo moves a card between the two halves under one push, and
  the loader and the socket paint one snapshot. Tests that read `listQueue` take
  `.items`.
- **The work page is live too.** `subscribeRun` registers the same team-scoped
  subscription as the queue (`orderId: null`), so any push to the member's teams
  refetches the open run. Over-broad by an order or two; the read is one run.
- **`getRunView` decorates every step** with `ready` and `undoBlockedBy`, both facts
  about other rows the page cannot see, instead of returning
  `WorkflowRunDetail` plus line items. `null` for "not there" and "not yours" alike.
- **Undo's terminal check is cancelled-only.** A `done` run must accept undo of its
  last step (research decision), so `uncompleteStep` does not use `requireActionable`
  and refuses only cancelled runs. An undo on an open step is `StepNotReadyError`,
  whose doc now covers that reading.
- **Team chips are `s-button`s**, `primary` for the selected one. Polaris
  `s-clickable-chip` exposes no pressed state, so a chip row could not show which
  filter was on.
- **Dismiss stayed on the card** beside the flag banner. The plan moved Note and
  Block to the work page and said nothing about Dismiss; a reconcile flag
  ("quantity changed") is acknowledged where it is read.
- **The top bar is a plain `div`** (`.member-bar`), not an `s-box`: the JSX typings
  for the custom elements carry no `class`, and the print rule needs one.
- **Relative time is coarse** (`formatRelative`: minutes, hours, days), rendered
  through `LocalDateTime` like the other timestamps because `Date.now()` differs
  between SSR and hydration.
- **`e2e/member-queue.member.spec.ts`'s team-removal test** now expects the queue's
  "not on a team yet" state, which is what a member with no teams left sees since
  Phase 1 moved that sentence onto the queue.

## Out of scope, on purpose

Per-unit ticking, a print action, an undo audit trail, a member name field, a kiosk
mode, barcode scanning. Each has a note in the research doc's Rejected or Decisions
section.
