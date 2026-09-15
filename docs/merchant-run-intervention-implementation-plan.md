# Merchant run intervention: implementation plan

Status 2026-09-14: **Phases 1 and 2 in, uncommitted; Phases 3 to 8 not started**.
See "Deviations" at the bottom. The reasoning and every product decision
are in `docs/merchant-run-intervention-research.md` (the "Decisions" list is binding);
the target states are drawn in `docs/merchant-run-intervention/mockups.html`. This
document is the order of work. Like `docs/member-ux-implementation-plan.md`, it is
disposable once the code is in and any deviations are folded back into the research doc.

Vocabulary is the research doc's: a _run_ (`Domain.WorkflowRun`) with its _run steps_
(`Domain.WorkflowRunStep`); an _actor_ is who did a step action, either a member (id and
email) or the merchant; a _role_ is `Domain.ConnectionRole` (`"merchant" | "member"`).

## Ground rules for this work

- **Schema goes into the initial schema, not a second migration.** The app is still in
  prototyping and every Durable Object is reset from scratch (the same call the member
  area made on 2026-09-14). So `"1_initialize schema"` in `src/lib/ShopAgent.ts` gains
  the new columns in place, there is no backfill, and the `flagDetail` decoder accepts
  only the new shape. **Consequence:** once Phase 1 lands, every existing local
  Durable Object has a stale `WorkflowRunStep` table. The dev server must be stopped,
  `.wrangler` state wiped (`pnpm d1:reset` recreates local D1 and drops the DO
  storage under `.wrangler`), the server restarted, and `pnpm seed` re-run before any
  browser check. This is a coordination point with the user, not something the
  implementer does unannounced; see "Checkpoint" under Phase 1.
- **No merchant Start.** Five merchant callables (complete, uncomplete, note, block,
  dismiss); the merchant never claims work.
- **Same rules minus the team check.** Stage order, terminal-run refusal, and the
  downstream undo guard all stay. Only "is this step's team one of mine" is skipped.
- **Copy is fixed.** Manage / Hide, Mark done, Reopen, Block / Unblock, Note / Edit
  note, `by Merchant`. Do not invent variants.
- Follow `CLAUDE.md`: Effect v4 idioms, namespace imports, JSDoc for the subtle parts,
  `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (keep everything it touches), no commit.

## Phase 1: domain and schema

Files: `src/lib/Domain.ts`, `src/lib/ShopAgent.ts` (`initializeSchema`).

1. **`Domain.Actor`** union, next to `ConnectionRole`:

   ```ts
   export const Actor = Schema.Union([
     Schema.Struct({
       role: Schema.Literal("member"),
       memberId: MemberId,
       email: Email,
     }),
     Schema.Struct({ role: Schema.Literal("merchant") }),
   ]);
   ```

   Plus a tiny `actorLabel(actor)` helper (`"Merchant"` or the email) so every page
   spells the merchant the same way. JSDoc: why a union rather than inferring from a
   null email (decision 11).

2. **`WorkflowRunStep`** gains, in this order after the existing columns:
   - `startedByRole: Schema.NullOr(ConnectionRole)`
   - `completedByRole: Schema.NullOr(ConnectionRole)`
   - `reopenedAt: Schema.NullOr(Schema.Number)`
   - `reopenedByRole: Schema.NullOr(ConnectionRole)`
   - `reopenedByEmail: Schema.NullOr(Email)` (no id column: decision 10)
   - `noteByRole: Schema.NullOr(ConnectionRole)`

   Update the struct's JSDoc: the role column is the actor discriminator, the id and
   email are null for a merchant, and `reopened*` is a last-actor slot cleared by the
   next completion. Because `QueueStep`, `RunStepView`, and `DoneItem.step` all spread
   `WorkflowRunStep.fields`, they pick these up with no further change.

3. **Step actor accessors** in Domain so pages never reassemble the union by hand:
   `stepStartedBy(step)`, `stepCompletedBy(step)`, `stepReopenedBy(step)`, each
   returning `Actor | null` from the role column and its companions.

4. **`RunFlagDetail.by`** becomes `Schema.optionalKey(Actor)`; `byEmail` is removed.
   Only `blockRun` writes it and only `flagActor` in `src/components/MemberRun.tsx`
   reads it, so this is a contained rename. No old-shape compatibility (ground rule 1).

5. **Command types.** Replace the `memberId` / `memberEmail` / `teamIds` triple on
   `StartStepCommand`, `CompleteStepCommand`, `SetStepNoteCommand`, `BlockRunCommand`,
   `DismissFlagCommand`, `UncompleteStepCommand` with:
   - `actor: Actor`
   - `teamIds?: readonly string[]` (present for a member, absent for the merchant)

   `StartStepCommand` keeps a member-only actor at the type level if convenient
   (`Extract<Actor, { role: "member" }>`), since there is no merchant start.
   `UncompleteStepCommand` now carries the actor (its "records nobody" JSDoc is
   replaced: undo now writes the `reopened` slot; the old sentence was true only
   while there was nowhere to show it).

6. **Schema DDL** in `initializeSchema`: the six columns on `WorkflowRunStep`, the three
   role columns with `check (x in ('merchant','member'))`. No new index.

7. **Checkpoint (user-facing).** After Phase 1 typechecks, tell the user the schema
   changed and that the dev server needs a stop, `pnpm d1:reset`, restart, and
   `pnpm seed` before any browser verification. Continue with Phases 2 to 4 in the
   meantime; they do not need a running server.

## Phase 2: repository

File: `src/lib/WorkflowRunRepository.ts`.

1. **Permission helpers.** `requireActionable({ runStepId, teamIds })` and
   `requireReadyTeam(runId, teamIds)` take `teamIds: readonly string[] | undefined`.
   When `undefined` the team clause is skipped entirely, including the
   "unassigned step (`teamId` null) is nobody's" refusal, because completing an
   unassigned step is the very case the merchant is fixing. JSDoc both with that
   sentence. `uncompleteStep` has its own inline team check; route it through the same
   rule.

2. **Actor columns on write.** A local `actorColumns(actor)` that yields
   `{ role, id, email }` with nulls for the merchant, used by:
   - `startStep`: `startedByRole = coalesce(startedByRole, ?)` alongside the existing
     `coalesce` on id and email.
   - `completeStep`: writes `completedAt`, `completedByRole/By/ByEmail`, backfills the
     started slot with the same actor, and **clears** `reopenedAt/ByRole/ByEmail`.
   - `uncompleteStep`: nulls the completed slot (all four columns), keeps started,
     writes `reopenedAt = now`, `reopenedByRole`, `reopenedByEmail` (email null for the
     merchant).
   - `setStepNote`: writes `noteByRole = actor.role` with the note; clearing the note
     (`null`) also nulls `noteByRole`.
   - `blockRun`: `flagDetail.by = actor`; drop `byEmail`.
   - `dismissFlag`: no actor, unchanged apart from the optional `teamIds`.

3. **Interface.** The `WorkflowRunRepository` service signature mirrors the new command
   types. `assignRunStepTeam`, `cancelRun`, `uncancelRun` are untouched.

4. **Tests** in `test/integration/workflow-run-repository.test.ts`, alongside the
   existing step tests (`completeStep enforces team…`, `uncompleteStep re-opens…`,
   `blockRun sets the flag…`), which need their call sites updated to the actor shape:
   - merchant completes an **unassigned** step (teamId null): allowed, `completedByRole
= 'merchant'`, ids and emails null, started slot backfilled as merchant.
   - merchant completes over a member's start: `startedBy*` kept, completed slot is
     merchant.
   - merchant undo is refused downstream with the same `StepUndoBlockedError` a member
     gets, naming the blocker; a member's downstream start blocks a merchant undo the
     same way.
   - undo (member and merchant) sets the `reopened` slot; the next `completeStep`
     clears it.
   - stage order and terminal-run refusals still apply to a merchant actor.
   - `setStepNote` records `noteByRole` for both roles; clearing nulls it.
   - `blockRun` by merchant stores `{ role: "merchant" }`; by member stores id and email.

## Phase 3: Mine tier on email

Files: `src/lib/queueTiers.ts`, `src/routes/shop.$shop.index.tsx`,
`test/integration/domain.test.ts`.

1. `tierOf` and `tierQueue` take `memberEmail: Domain.Email` and compare
   `step.startedByEmail`. Rewrite the JSDoc: re-entering an email mints a **new** id, so
   email is what survives; the previous comment had it backwards (decision 12).
2. The queue page passes `memberEmail` (already in `QueueLoaderData`) and its inline
   `step.startedBy === memberId` test on the card becomes an email comparison too.
3. Extend the `tierQueue` test: a step started under a different member id but the same
   email still lands in Mine.

## Phase 4: ShopAgent callables

File: `src/lib/ShopAgent.ts`; registry in `test/integration/shop-agent-callables.test.ts`.

1. **Member callables** (`startStep`, `completeStep`, `uncompleteStep`, `setStepNote`,
   `blockRun`, `dismissFlag`) build
   `actor = { role: "member", memberId, email: memberEmail }` from the connection and
   pass `teamIds`. Log lines unchanged.

2. **Five merchant callables**, `role: "merchant"`, strict decode, same wire inputs as
   the member ones (`CompleteStepInput`, `UncompleteStepInput`, `SetStepNoteInput`,
   `BlockRunInput`, `RunIdInput`):
   `merchantCompleteStep`, `merchantUncompleteStep`, `merchantSetStepNote`,
   `merchantBlockRun`, `merchantDismissFlag`. Each builds `{ role: "merchant" }`, omits
   `teamIds`, calls the same repository operation, wraps in `runResult`, and publishes
   with **`publishToTeams`** (not `publish("all")`): the merchant's own order page is
   subscribed by order and the workers by team, and `publishToTeams` already reaches
   both for the touched order. One JSDoc on the group: why they are separate methods
   rather than a role branch inside the member ones (the callable role gate is per
   method, and the test registry enumerates it).
   Log format: `ShopAgent.merchantCompleteStep: shop=<shop> step=<id>` with `{ shop,
step }` annotations; no member id.

3. **`CALLABLE_ROLES`** in the callables test gains the five names as `"merchant"`. The
   existing "refuses every merchant callable on a member connection" test then covers
   them for free.

4. **Callable test** in `test/integration/shop-agent-callables.test.ts` or
   `member-queue-socket.test.ts`: over a merchant socket, `merchantCompleteStep` on a
   seeded ready step returns `Ok`, and a member socket subscribed to that team receives
   an invalidation (`isInvalidated`). One test is enough; the repository tests carry
   the rules.

## Phase 5: member-side rendering

Files: `src/routes/shop.$shop.index.tsx`, `src/routes/shop.$shop.work.$runId.tsx`,
`src/components/MemberRun.tsx`.

1. **Attribution through `actorLabel`.** Every `by ${email}` becomes
   `by ${Domain.actorLabel(actor)}`:
   - queue card "In progress since … by …" (hide the suffix when the actor is the
     viewer, as today, now by email).
   - work page `stepState`: `Done by Merchant · 14:02`, `In progress since 13:40 by
Merchant`.
   - Done tier entry: `by Merchant at 14:31`.
   - `flagActor` returns `actorLabel(run.flagDetail.by)`; the banner reads
     `Blocked: … · Merchant`.
2. **Reopened line** on the work page step box, under the state line, only while
   `reopenedAt` is set: `Reopened by <label> · <LocalDateTime relative>`.
3. **Note attribution**: `Note (Merchant): …` when `noteByRole === "merchant"`, plain
   `Note: …` otherwise, on both the card and the work page.
4. **Block wording** on the work page (decision 13): button "Mark blocked" → "Block"
   (keep `tone="critical"`), "Dismiss" → "Unblock", explanatory line "Unblock once the
   reason is resolved; the card goes back to its place in the queue." Section headings
   unchanged. The e2e test that clicks "Mark blocked" (`member-queue.member.spec.ts`,
   the work-page test) is updated in Phase 7.

## Phase 6: the merchant order page

File: `src/routes/app.orders.$orderId.tsx`. Target: mockups 1 to 4.

1. **State.** `reassigning` → `managing` (same `ReadonlySet<string>` of run ids). Add
   `noteDraft` (`{ runStepId, note } | null`, one editor at a time, as on the work page)
   and `blockReason` keyed by run id.

2. **Mutations.** One `interveneMutation` over a tagged input
   (`{ kind: "complete" | "reopen" | "note" | "block" | "unblock" | "cancel" | "uncancel", … }`)
   calling the matching merchant callable, decoded with `decodeRunResult`. The existing
   `runMutation` (cancel/uncancel) folds into it so `busy` stays one boolean. On `Ok`,
   show an App Bridge toast (`shopify.toast.show`) with the step or run name:
   `Cut marked done`, `Cut reopened`, `Note saved`, `Run blocked`, `Run unblocked`,
   `Run cancelled`, `Cancel undone`. On a non-`Ok` result, the toast carries the
   `runResultMessage` text and no banner is raised (the subscription re-renders the row).
   Update `runResultMessage`'s `UndoBlocked` comment: the merchant page now sends undo.

3. **`stepTrail`** keeps the progress line, the trail, the unassigned "assign a team"
   rows, and the empty-team warning. It loses the reassign disclosure and the per-step
   note lines (those move into the Manage rows; the collapsed run shows no notes, as in
   mockup 1). Update its JSDoc.

4. **`manageRows(run, teams)`**, rendered under the trail when `managing.has(run.id)`,
   one row per step in position order. Per row:
   - name, `teamName`, and the state line with attribution and time, in the work page's
     order: `Done by <label> · <time>` (plus `· started by <label>` when the starter
     differs from the completer, mockup 4), `In progress since <time> by <label>`,
     `Reopened by <label> · <relative>` when set, `Ready`, `Waiting on step <n>`. The
     readiness rule is the one `stepTrail` already computes (`lowestOpenStage`).
   - the note line or the note editor (text field + Save note / Cancel), as on the work
     page.
   - actions per the research table: **Mark done** (primary) when ready and the run is
     open; **Reopen** (secondary) when done and `undoBlockedBy === null`; otherwise the
     refusal sentence `<team> started <step> · reopen it first`; **Note** / **Edit
     note** (tertiary) on every step of an open or done run; the team select (the
     existing `assignTeam(step.id)`) on every open step of an open run.
     `undoBlockedBy` is computed client-side from the run's own steps plus the order
     run's steps (`runs` on the page already carries both), using the exported pure
     helper from `WorkflowRunRepository`. Nothing on a cancelled run except Undo cancel.
   - all controls `disabled={!identified || busy}`.

5. **Run-level actions** below the rows: **Block** (critical) with a Reason text field,
   or when `flag === "blocked"` the line `Blocked by <label> · <time>: <reason>` and
   **Unblock** (secondary); then **Cancel** (tertiary) or **Undo cancel**. Cancel leaves
   the run header, which becomes name + status badge + flag badge only.

6. **Disclosure button** `Manage` / `Hide` (tertiary), shown for any run that is not
   cancelled (a cancelled run shows only Undo cancel inline, as today). Collapsed state
   otherwise identical to today (mockup 1).

7. **Order-run steps**: the same rows; the merchant can mark packing done. The
   `Waiting for every item to be made` state text applies when the order run is
   pending, reusing the page's existing `openItemRuns` count.

## Phase 7: end-to-end tests

Files: `e2e/orders.spec.ts` (merchant, `e2e` project) and
`e2e/member-queue.member.spec.ts` (`member` project). Seed helpers in `e2e/seed.ts`
already build members, teams, workflows, and orders.

1. **Merchant Manage flow** (`orders.spec.ts`, embedded admin via `gotoApp`): seed a
   two-stage workflow (Cut → Polish, two teams) and one order; open the order page;
   `Manage`; `Mark done` on Cut → toast and `Done by Merchant` in the row; `Reopen` →
   `Reopened by Merchant`; `Mark done` again then `Mark done` on Polish → run badge
   `done`. Then `Block` with a reason → `Blocked by Merchant … : reason` badge and
   line; `Unblock` clears it. Keep the count of admin sign-ins at zero: the `e2e` project
   reuses the setup project's storage state.
2. **Reopen refused** (same file or a second test): mark Cut done, mark Polish done,
   then assert Cut's row shows `<Polish team> started Polish · reopen it first` and no
   Reopen button.
3. **Worker sees the merchant** (`member-queue.member.spec.ts`): reuse the signed-in
   member sessions; seed as the work-page test does; have the merchant complete the
   member's ready step through the seed's admin channel or a merchant socket (see
   `test/integration/agent-socket.ts` `merchantHeaders` for the header shape; if the
   e2e side has no merchant transport, drive it through a second Playwright page on the
   admin, as the orders spec does); assert the Done tier entry reads `by Merchant`, and
   after a merchant reopen the work page shows `Reopened by Merchant`. Sign-in budget:
   this must not add magic-link sends beyond the two in `beforeAll`.
4. Update the existing work-page test for the copy change: `Mark blocked` → `Block`,
   `Dismiss` → `Unblock`.

Run: `npm run test:e2e -- e2e/orders.spec.ts e2e/member-queue.member.spec.ts`. Vitest:
`pnpm test`.

## Phase 8: verification and wrap-up

1. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt` (keep every touched file).
2. After the user has reset and restarted the dev server (Phase 1 checkpoint), verify
   in the embedded admin with Chrome: the order page for a seeded order shows Manage,
   the four mockup states render with the mockup copy, and a member queue in a second
   tab updates live on a merchant Mark done. Screenshots of mockups 2 to 4 against the
   real page are the review artefact.
3. Record deviations from this plan at the bottom of this file under "Deviations", then
   leave the work uncommitted for review.

## Out of scope

Anything on the research doc's "Not recommended" and "Decisions" lists: merchant Start,
complete-through, cascade undo, staff-user identity, an event table, per-team stats,
editing timestamps, dropping the `startedBy` / `completedBy` id columns, a second note
column.

## Deviations

Recorded as the work lands. Phases 1 and 2 are in; Phases 3 to 8 are not started.

- **Phase 1 and Phase 2 landed together, plus the member call sites.** Phase 1's
  item 5 (the command types) is what the repository writes against, so Phase 1 alone
  cannot typecheck: changing `StartStepCommand` and friends breaks every caller in
  `WorkflowRunRepository.ts` and `ShopAgent.ts` the moment it is saved. The schema
  checkpoint therefore covers Phase 1 + Phase 2 + the mechanical half of Phase 4.1
  (member callables building `actor: { role: "member", ... }`). The five merchant
  callables (Phase 4.2/4.3) are **not** in yet, so nothing yet writes a `'merchant'`
  role over the wire — only the repository tests do.
- **`Domain.ActorDisplay`, and `stepReopenedBy` returns it, not `Actor`.** Decision 10
  drops the reopener's id column, so the `reopened` slot physically cannot produce a
  full `Actor`. Rather than mint a fake `MemberId` from the email, the display half of
  the union is its own type (`{ role: "merchant" } | { role: "member"; email }`),
  `actorLabel` takes that, and `Actor` is assignable to it. `stepStartedBy` and
  `stepCompletedBy` still return `Actor | null` as planned.
- **`Domain.MemberActor` exported.** The plan suggested `Extract<Actor, { role:
"member" }>` "if convenient" for `StartStepCommand`; it is used in three places
  (the command, the seed helper, the test factory), so it is a named export.
- **`teamIds` is `readonly string[] | undefined`, spelled explicitly.** Written as
  `teamIds?: readonly string[] | undefined` on the commands so `exactOptionalPropertyTypes`
  lets a caller pass an explicit `undefined` (the merchant path) as well as omit it.
- **`actorColumns` is module-scoped**, not a closure inside the repository's `Effect.gen`:
  it captures nothing, and oxlint's `unicorn(consistent-function-scoping)` flags it there.
- **`uncompleteStep` keeps its inline team check** rather than routing through
  `requireActionable` (plan Phase 2.1). Its terminal rule genuinely differs — a `done`
  run is undoable, only a cancelled one is refused — so sharing the guard would mean
  parameterising it for one caller. The `teamIds === undefined` skip is duplicated in
  the two places with a comment pointing at `requireActionable`.
- **Repository tests use a `memberActor(id, email?)` factory and a `MERCHANT` constant.**
  The 35 existing `memberId:` / `memberEmail:` call sites were rewritten to
  `actor: memberActor("m1")`, which defaults the email to `<id>@example.com` — the
  convention every one of them already followed.
- **Six new repository tests** cover Phase 2.4: merchant on an unassigned step, merchant
  completing over a member's start, the reopened slot set by both roles and cleared by
  the next Done, the merchant held to stage order / terminal / downstream-undo,
  `noteByRole` for both roles and its clearing, and merchant `blockRun` / `dismissFlag`.
  The "member's downstream start blocks a merchant undo" case is folded into the
  stage-order test rather than standing alone.
