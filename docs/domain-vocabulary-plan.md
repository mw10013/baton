# The domain vocabulary: implementation plan

This plan carries out the decisions in `docs/domain-vocabulary-research.md`. Read that doc
first: it says what a vocabulary is for, names Baton's four contexts, and gives the entry test a
word must pass. This plan says what to change, in what order, and how to know each step is done.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that enforces it or is the concept. Other
    sites `{@link}` it and do not restate it.
  - Each rule has a test whose title is the rule.
  - JSDoc never cites files under `docs/`. This plan and the research doc will be deleted.
  - Update the vocabulary in the same change as any rename. A rename is never a follow-up: every
    identifier, JSDoc, test title, log message and label constant moves in one change.
  - Do not commit unless the user says so. You are in linked worktree `wt-01`; never check out
    `main`.
- No migrations while prototyping: a stored literal changes in place in `initializeSchema`
  (`src/lib/ShopAgentSchema.ts`), and you reset local state yourself with `pnpm dev:reset` (it
  stops the dev server, wipes local D1 and object state, starts, installs and seeds). No need to
  ask; note in Deviations that you ran it.
- After each phase run: `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`,
  `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Record anything that does not go as written in [Deviations and issues](#deviations-and-issues)
  as you go, not at the end.
- Each phase is one change. Do not merge phases; a reviewer reads them one at a time.

## Phase 1: the block is the vocabulary

Goal: one word for the thing, everywhere.

1. In `src/lib/Domain.ts`, the JSDoc block that begins `/**\n * Glossary.` begins
   `/**\n * Vocabulary.` and its first paragraph says: "Vocabulary. These are the words for code,
   JSDoc, tests, research and screen ...". Replace "glossary" with "vocabulary" in every JSDoc,
   comment, log message and error string under `src/` and `scripts/`, and in `AGENTS.md`. 51
   occurrences in 12 files at the time of writing; `grep -rn glossary src scripts AGENTS.md`
   must return nothing when done.
2. In `scripts/lib/spec.ts`, the anchor `"/**\n * Glossary."` becomes `"/**\n * Vocabulary."`;
   `checkGlossary` becomes `checkVocabulary`, `glossaryTables` becomes `vocabularyTables`,
   `GlossaryTable` becomes `VocabularyTable`. Messages say "vocabulary". `scripts/spec.ts` and
   `test/integration/spec.test.ts` follow.
3. `docs/` is not touched: research docs are dated.

Done when: `grep -rn -i glossary src scripts AGENTS.md` is empty and `pnpm lint` passes.

## Phase 2: the header carries the rules of the vocabulary itself

Goal: the block says what a word is, what a context is, and what a word must pass. Ten bullets
and one table, not a chapter. Everything longer stays in the runbook (Phase 3).

1. **Contexts table**, first in the block, introduced by a paragraph whose first line starts
   with `Contexts.` (the checker finds a table by that first line; add `Contexts.` to the list of
   table names it accepts without a label constant, as `Billing.` is):

   | context    | about                                | whose words                  |
   | ---------- | ------------------------------------ | ---------------------------- |
   | production | what the shop makes and who makes it | Baton's and the shop floor's |
   | orders     | what Shopify says about an order     | Shopify's admin              |
   | billing    | what the shop pays for               | Shopify's Partner API        |
   | platform   | how the software runs                | Cloudflare's and Baton's     |

   Every later table is introduced by a sentence naming its context ("Run states, production:").

2. **The entry test**, as bullets in the header, in these words or shorter:
   - A word names a concept the domain has, not a mechanism or a metaphor.
   - A word has one meaning in its context. A word two contexts share always travels with its
     noun: "open order", "open run"; in identifiers, `<noun>Is<State>`, never `is<State>`.
   - Shopify's things get Shopify's words, unchanged. Baton's things get plain words, and an
     invented word never reaches a screen.
   - A stored literal is the vocabulary word where the store is ours; Shopify's literals are
     stored as sent and read through a predicate.
   - A word that fails is mapped to the existing word, retired, or split. A retired word goes on
     the retired list and `scripts/rules-lint.ts` refuses it.
3. **The Flow sentence**, after the workflow-states table: "The switch's screen words are Shopify
   Flow's (Turn on, Turn off; `refs/flow-manual/manage/manual.md`); the badge says On and Off
   where Flow says Active and Inactive, because "active" is not a production word here, and one
   execution is never called a run on a screen, because a run in Baton is a member's work."
4. **Replace "tier"** in the header's bullet "Which tier a site speaks" with plain words: "Which
   word a site speaks. Identifiers, ... speak the vocabulary word. Route segments, ... speak the
   screen word."

Done when: `pnpm spec check` parses the contexts table and every table's intro names a context;
`grep -n "tier" src/lib/Domain.ts` returns billing lines only.

## Phase 3: the runbook and the audit

Goal: the procedure lives in a runbook with commands, and the audit is a script.

1. Write `docs/vocabulary-runbook.md`, modelled on `docs/worktrees-runbook.md`: the five steps
   for a new word (look it up; grep the stem; write the row first; rename in the same change;
   retire the loser), the retire procedure, and the audit command. Short; it is a checklist.
2. Write `scripts/vocab-audit.ts` and a `pnpm vocab:audit` script. It reads every `export`ed
   identifier under `src/lib/` (`const`, `function`, `class`, `type`, `interface`, schema
   literals), splits camelCase into lowercase words, drops words that appear in any vocabulary
   table's `word` cell and words on an allowlist file (`scripts/vocab-allowlist.txt`: English
   function words and code words such as list, get, set, input, result, error, count, by, of,
   for, with, id, at, ...), and prints the remaining stems with a count and one example
   identifier each, most frequent first. It is an audit, not a check: it exits 0. Its first run
   is recorded in Deviations as the list for the review.
3. In `scripts/rules-lint.ts`, add two checks, run by `pnpm lint`:
   - **Reserved stems.** A list beside the retired copy words: `active`, `roster`, `slot`,
     `tier`, `glossary`. An exported identifier under `src/lib/` that contains one (case-
     insensitive, substring) is refused, with an exact-name allowlist for Shopify's fields
     (`activeSubscription`, `activeSubscriptionQuery`, `AppSubscriptionResponse`).
   - **Noun before state.** An exported function under `src/lib/` named `is<Word>` with no noun
     before `is` is refused. After Phase 4 there should be none; the check keeps it so.
     Each check has a test in `test/integration/rules-lint.test.ts` whose title is the rule.

Done when: `pnpm vocab:audit` runs and its output is in Deviations; `pnpm lint` runs both new
checks and passes on the tree as of the end of Phase 4 (run it at the end of Phase 4; until
then the reserved-stem check fails on purpose and the phase is not done).

## Phase 4: the renames, one change each

Each item is its own change with its own vocabulary row update. The order matters: 4.1 first,
because its check constraint is where the stored literal lives.

### 4.1 `active` → `on` (workflow) and `active` → `open` (run's stored literal)

- Workflow: `isActive` → `workflowIsOn`; `setWorkflowActive` (repository, `ShopAgent`
  callable, `ShopAgentClient`, the route's server function) → `setWorkflowOn`;
  `SetWorkflowActiveInput` → `SetWorkflowOnInput`; `listActiveWorkflowDetails` →
  `listOnWorkflowDetails`; `reconcileAllIfActive` → `reconcileAllIfOn`; `ActivateResult` →
  `SwitchResult`; `ChangeActivatedAtResult` stays (the column is `activatedAt`, which is the
  coverage date and keeps its name: it is a date, not a state). JSDoc prose says "on" and "off",
  never "active" or "the active set".
- Run: in `initializeSchema`, `status in ('active', 'done', 'closed')` becomes
  `('open', 'done', 'closed')`, and the check `blockedAt is null or status = 'active'` and the
  partial index `where status = 'active'` follow. `Domain.RunStatus` literals become
  `["open", "done", "closed"]`. Every SQL literal `'active'` in `RunRepository.ts`,
  `OrderRepository.ts` and the tests follows. The run-states table's `stored` cell says `open`.
  Run `pnpm dev:reset` after the change and note it in Deviations.
- The vocabulary's workflow-states table keeps `stored` as `activatedAt` set / null.

Tests: retitle any test whose title says "active" for a workflow or a run.

### 4.2 `roster` → members, member count, teams

- `TeamRoster` → `TeamWithMemberCount` (it is `{ id, name, memberCount }`); `recordRoster` →
  `recordMemberCount`; `RecordRosterInput` → `RecordMemberCountInput`; `rosterAtCeiling` →
  `membersAtCeiling`. JSDoc prose: "the shop's members", "the member count", "the shop's teams",
  by sense. The billing table's `seat` row says "a cycle's seats are its highest member count".

### 4.3 `slot` → the rule, spoken

- No identifier carries it; JSDoc only. `RunStatus`'s "holds the item's slot" becomes "holds
  its item: one run per item (the data model on `initializeSchema`)". Every other "slot" in
  `Domain.ts`, `RunRepository.ts` and `ShopAgentSchema.ts` is rewritten the same way. The
  nouns table gains no row; the rule is on the data model.

### 4.4 `tier` → `view` (member's workflows list)

- `RunTier` → `RunView`; `tierOf` → `viewOf`; `byTier` → `byView`; "tiered" and "tiering" in
  JSDoc become "by view". Check that `RunView` does not collide with an existing export
  (`WorkflowsListView` is the view list; if `RunView` reads wrong beside it, use
  `WorkflowsListViewOf` and say so in Deviations). Billing's "tier" stays.

### 4.5 `ProductionState` → `OrderPosition`

- The vocabulary says "position"; the code says "state". `ProductionState` → `OrderPosition`,
  `productionState` → `orderPosition`, `PRODUCTION_STATE_LABEL` → `ORDER_POSITION_LABEL`, and the
  label-constant list in `scripts/lib/spec.ts` follows. The order-positions table's intro names
  the new symbol.

### 4.6 `start` (a run) → `create`; `startable` → `eligible`

- `RunRepository.canStart` → `workflowIsEligible`; `Domain.canStartRuns` →
  `orderCanCreateRuns`; `StartContext` → `EligibleContext`; `startContext` → `eligibleContext`;
  `ActivateResult.Ok.started` (now `SwitchResult`) → `created`; `requireStartableTasks` →
  `requireEligibleTasks`; `WorkflowCannotStart` → `WorkflowNotEligible`. The `Workflow` JSDoc's
  sentence "`start` / `canStart` is creating a run" becomes "a workflow **creates** a run; only a
  member **starts** a task". JSDoc prose that says a workflow or reconcile "starts" a run says
  "creates". The `start` verb row is untouched: it is the member's.
- `isCancelled` → `orderIsCancelled`, `isFulfilled` → `orderIsFulfilled` (the noun-before-state
  rule; done here because these three predicates are read together).

### 4.7 Vocabulary rows for the words the audit found

Add rows, each in its context's table, for: draft (production; verbs apply, discard, turn on,
turn off in the verbs table, on a workflow, merchant only), import and sync (platform), ceiling
(platform, naming the three ceilings and the banners as its screen words). "Sweep", "retention"
and "gate" stay JSDoc terms on their symbols. Do not add the reconcile words (reconcile, match,
ambiguous, coverage date, eligible): the reconcile spec adds them.

Done when, for the whole phase: `pnpm vocab:audit` no longer lists active, roster, slot, tier,
state (for the order position) or start (for a run); `pnpm lint` passes with the Phase 3 checks
on; `pnpm test` passes; `grep -rn "'active'" src` returns only Shopify's app-subscription
literal.

## Phase 5: every existing row, re-read

Goal: the rows written before the entry test existed are checked against it. This phase changes
no code; its output is a table for the user's review.

For every row of every vocabulary table, answer the five entry-test questions. Write the rows
that fail, with which test and a proposed fix, into Deviations as a table (`word | table | fails
| proposal`). Rows expected to appear, from the research: "view" (is "one whole question about a
list" a concept or a description?), "included" (Shopify's word is "free tier"; the row chose
"included" on purpose; say whether that is rule 1 or rule 3), "counted order" (a mechanism word
that surfaces on the home page), and any word whose `symbol` cell names a symbol Phase 4
renamed. Do not fix them; the user decides.

## Phase 6: final checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt` clean.
- `pnpm vocab:audit` output pasted into Deviations, once at the start of Phase 3 and once at the
  end of Phase 4.
- `grep -rn -i "glossary\|roster\|slot\|tier" src scripts AGENTS.md` returns billing's "tier"
  lines and nothing else.
- `pnpm dev:reset` has been run once after 4.1.

## Deviations and issues

### General

- **One uncommitted diff.** The user chose one working-tree diff over a commit per phase, so the
  phases are not separable by commit. Each section below says what its phase changed.
- `pnpm typecheck`, `pnpm lint` (with both new checks on), `pnpm test` (530 tests) and
  `pnpm fmt` pass on the final tree. Three `spec.test.ts` cases doctor exact table rows by string;
  they were updated for the rows the new columns and cells realigned.
- The e2e specs the renames touch (`workflows.spec.ts`, `orders.spec.ts`,
  `member-runs.member.spec.ts`) pass: 50 of 50. The rest of the e2e suite was not run.

### Phase 1

- `src/lib/Domain.ts` had a second paragraph starting "Glossary." (the `Workflow` JSDoc, "A
  workflow definition has two nouns"). It now starts without a heading word, so the checker's
  anchor `/**\n * Vocabulary.` matches one block only.
- `AGENTS.md`'s sentence "The glossary ... is the vocabulary" became "The vocabulary at the top
  of `src/lib/Domain.ts` holds the words", and it now names the runbook and the two lint checks.

### Phase 2

- No list of "table names accepted without a label constant" existed in `scripts/lib/spec.ts`;
  tables are found by their intro. The context rule is a new check, `checkContexts`, run by
  `pnpm spec check`, with the test "every vocabulary table names its context". A table names its
  context in its intro's first line (`Run states, production:`, or the bare `Billing.`) or in a
  `context` column.
- The Nouns table spans three contexts, so it gained a `context` column rather than one context
  in its intro.
- The Screens table is exempt from the context check: its rows name pages, and a page's spec name
  is spoken in every context.

### Phase 3

- The audit also treats the words of each table's name as known ("Run states" makes "state"
  known), besides the `word` and `context` cells. So `ProductionState` never showed as "state"
  in the audit; the rename happened anyway (4.5).
- Reserved-stem allowlist: `CopySlot` only. The screen spec's copy slot is a place in a screen's
  copy, another context from the retired run slot, and the word the copy table is built on. The
  three Shopify names the plan listed (`activeSubscription`, `activeSubscriptionQuery`,
  `AppSubscriptionResponse`) are not exported under `src/lib/` (a service method and two
  module-private constants), so the check never sees them and they need no entry.
- The noun-before-state check found three predicates the plan did not list: `Domain.isUnassigned`,
  `Domain.isRunTaskUnassigned` and `WorkflowLayout.isValid`. They were renamed in 4.6
  (`workflowTaskIsUnassigned`, `runTaskIsUnassigned`, `layoutIsValid`), and the private
  `isUnassigned` in `WorkflowRepository.ts` became `taskIsUnassigned` to match.
- AGENTS.md gained `pnpm vocab:audit` in Commands.

First run of `pnpm vocab:audit` (start of Phase 3, before any rename):

<details><summary>225 lines</summary>

| word        | count | example                                                       |
| ----------- | ----- | ------------------------------------------------------------- |
| agent       | 20    | ShopAgentId (src/lib/Domain.ts)                               |
| draft       | 19    | WorkflowDraft (src/lib/Domain.ts)                             |
| session     | 19    | CurrentShopifySession (src/lib/CurrentShopifySession.ts)      |
| message     | 17    | InvalidatedMessage (src/lib/Domain.ts)                        |
| connection  | 16    | ConnectionRole (src/lib/Domain.ts)                            |
| line        | 16    | LineItemProperty (src/lib/Domain.ts)                          |
| bulk        | 14    | BulkOperationStatus (src/lib/Domain.ts)                       |
| sync        | 14    | OrderSyncSource (src/lib/Domain.ts)                           |
| detail      | 12    | TeamDetail (src/lib/Domain.ts)                                |
| loader      | 12    | AdminShopLoaderData (src/lib/Domain.ts)                       |
| socket      | 12    | SocketKeepalivePing (src/lib/Domain.ts)                       |
| admin       | 10    | requireAdmin (src/lib/AdminServerFnMiddleware.ts)             |
| repository  | 10    | OrderRepositoryError (src/lib/OrderRepository.ts)             |
| apply       | 9     | ApplyDraftInput (src/lib/Domain.ts)                           |
| seed        | 9     | SeedWorkflowsInput (src/lib/Domain.ts)                        |
| shopify     | 9     | CurrentShopifySession (src/lib/CurrentShopifySession.ts)      |
| command     | 8     | StartTaskCommand (src/lib/Domain.ts)                          |
| subscribe   | 8     | SubscribeOrdersInput (src/lib/Domain.ts)                      |
| user        | 8     | UserId (src/lib/Domain.ts)                                    |
| actor       | 7     | Actor (src/lib/Domain.ts)                                     |
| d1          | 7     | D1Bookmark (src/lib/D1Bookmark.ts)                            |
| found       | 7     | TeamNotFoundError (src/lib/Repository.ts)                     |
| discard     | 6     | DiscardDraftInput (src/lib/Domain.ts)                         |
| entitlement | 6     | Entitlements (src/lib/Domain.ts)                              |
| format      | 6     | formatErrorMessage (src/lib/LayerEx.ts)                       |
| heading     | 6     | heading (src/lib/Screen.ts)                                   |
| summary     | 6     | TeamSummary (src/lib/Domain.ts)                               |
| taken       | 6     | TeamNameTakenError (src/lib/Repository.ts)                    |
| use         | 6     | useShopAgent (src/lib/ShopAgentContext.tsx)                   |
| activated   | 5     | SetWorkflowActivatedAtInput (src/lib/Domain.ts)               |
| auth        | 5     | AuthError (src/lib/Auth.ts)                                   |
| body        | 5     | body (src/lib/Screen.ts)                                      |
| email       | 5     | Email (src/lib/Domain.ts)                                     |
| modal       | 5     | modal (src/lib/Screen.ts)                                     |
| object      | 5     | ShopAgentObjectsError (src/lib/ShopAgentObjects.ts)           |
| operation   | 5     | BulkOperationStatus (src/lib/Domain.ts)                       |
| role        | 5     | UserRole (src/lib/Domain.ts)                                  |
| roster      | 5     | TeamRoster (src/lib/Domain.ts)                                |
| search      | 5     | OrderSearch (src/lib/Domain.ts)                               |
| toast       | 5     | toast (src/lib/Screen.ts)                                     |
| webhook     | 5     | webhook (src/lib/Domain.ts)                                   |
| window      | 5     | DONE_WINDOW_MS (src/lib/Domain.ts)                            |
| activate    | 4     | ApplyAndActivateInput (src/lib/Domain.ts)                     |
| active      | 4     | isActive (src/lib/Domain.ts)                                  |
| blocker     | 4     | ReopenBlocker (src/lib/Domain.ts)                             |
| fn          | 4     | adminServerFnMiddleware (src/lib/AdminServerFnMiddleware.ts)  |
| header      | 4     | CONNECTION_ROLE_HEADER (src/lib/Domain.ts)                    |
| length      | 4     | TEAM_NAME_MAX_LENGTH (src/lib/Domain.ts)                      |
| link        | 4     | magicLinkKvKey (src/lib/Auth.ts)                              |
| mark        | 4     | MarkTaskDoneInput (src/lib/Domain.ts)                         |
| node        | 4     | OrderNode (src/lib/OrderSync.ts)                              |
| reconcile   | 4     | ReconcileUsageInput (src/lib/Domain.ts)                       |
| redacted    | 4     | ShopSessionRedacted (src/lib/Domain.ts)                       |
| turn        | 4     | TURN_OFF_HEADING (src/lib/workflowShared.ts)                  |
| unassigned  | 4     | isUnassigned (src/lib/Domain.ts)                              |
| up          | 4     | up (src/lib/Domain.ts)                                        |
| warning     | 4     | changeWarning (src/lib/changeWarning.ts)                      |
| banner      | 3     | banner (src/lib/Screen.ts)                                    |
| bookmark    | 3     | D1Bookmark (src/lib/D1Bookmark.ts)                            |
| ceiling     | 3     | cycleAtOrderCeiling (src/lib/Domain.ts)                       |
| completed   | 3     | bulkOperationCompleted (src/lib/Domain.ts)                    |
| copy        | 3     | CopySlot (src/lib/Screen.ts)                                  |
| editor      | 3     | EditorWindowMessage (src/lib/workflowEditorWindow.ts)         |
| join        | 3     | JoinTaskInput (src/lib/Domain.ts)                             |
| keepalive   | 3     | SocketKeepalivePing (src/lib/Domain.ts)                       |
| kv          | 3     | magicLinkKvKey (src/lib/Auth.ts)                              |
| login       | 3     | LoginInput (src/lib/Domain.ts)                                |
| middleware  | 3     | adminServerFnMiddleware (src/lib/AdminServerFnMiddleware.ts)  |
| move        | 3     | MoveTaskInput (src/lib/Domain.ts)                             |
| separate    | 3     | SeparateTaskInput (src/lib/Domain.ts)                         |
| server      | 3     | adminServerFnMiddleware (src/lib/AdminServerFnMiddleware.ts)  |
| stale       | 3     | STALE_SOCKET_MS (src/lib/ShopAgentContext.tsx)                |
| stream      | 3     | ShopAgentOrdersStreamError (src/lib/ShopAgentOrdersStream.ts) |
| tier        | 3     | RunTier (src/lib/Domain.ts)                                   |
| upsert      | 3     | ShopSessionUpsert (src/lib/Domain.ts)                         |
| access      | 2     | MemberAccess (src/lib/Domain.ts)                              |
| append      | 2     | append (src/lib/WorkflowLayout.ts)                            |
| badge       | 2     | badge (src/lib/Screen.ts)                                     |
| basic       | 2     | baton-basic (src/lib/Domain.ts)                               |
| baton       | 2     | baton-basic (src/lib/Domain.ts)                               |
| button      | 2     | button (src/lib/Screen.ts)                                    |
| close       | 2     | CONNECTION_CLOSE_FORBIDDEN (src/lib/Domain.ts)                |
| control     | 2     | Control (src/lib/Screen.ts)                                   |
| destroy     | 2     | destroyShopAgent (src/lib/Shopify.ts)                         |
| direction   | 2     | TaskDirection (src/lib/Domain.ts)                             |
| display     | 2     | ActorDisplay (src/lib/Domain.ts)                              |
| duplicate   | 2     | DuplicateWorkflowInput (src/lib/Domain.ts)                    |
| env         | 2     | CloudflareEnv (src/lib/CloudflareEnv.ts)                      |
| expired     | 2     | EXPIRED (src/lib/Domain.ts)                                   |
| gid         | 2     | ShopGid (src/lib/Domain.ts)                                   |
| instruction | 2     | TaskInstructions (src/lib/Domain.ts)                          |
| invalidated | 2     | InvalidatedMessage (src/lib/Domain.ts)                        |
| matche      | 2     | matchesLineItem (src/lib/RunRepository.ts)                    |
| mine        | 2     | mine (src/lib/Domain.ts)                                      |
| offline     | 2     | OfflineSessionNotFoundError (src/lib/Shopify.ts)              |
| partner     | 2     | ShopifyPartnerError (src/lib/ShopifyPartner.ts)               |
| placed      | 2     | placedSince (src/lib/RunRepository.ts)                        |
| poll        | 2     | pollBulkOrdersQuery (src/lib/OrdersSyncWorkflow.ts)           |
| pro         | 2     | baton-pro (src/lib/Domain.ts)                                 |
| progress    | 2     | SeedProgress (src/lib/Domain.ts)                              |
| promise     | 2     | tryPromisePassthrough (src/lib/LayerEx.ts)                    |
| property    | 2     | LineItemProperty (src/lib/Domain.ts)                          |
| provider    | 2     | ShopAgentProvider (src/lib/ShopAgentContext.tsx)              |
| recent      | 2     | RecentItem (src/lib/Domain.ts)                                |
| rename      | 2     | RENAME_HEADING (src/lib/workflowShared.ts)                    |
| resync      | 2     | ResyncOrderInput (src/lib/Domain.ts)                          |
| revoke      | 2     | RevokeMemberConnectionsInput (src/lib/Domain.ts)              |
| slot        | 2     | CopySlot (src/lib/Screen.ts)                                  |
| subscriber  | 2     | SubscriberIdInput (src/lib/Domain.ts)                         |
| teammate    | 2     | teammates (src/lib/Domain.ts)                                 |
| text        | 2     | bulkOrdersQueryText (src/lib/OrdersBulkRepository.ts)         |
| time        | 2     | formatDateTime (src/lib/format.ts)                            |
| unstarted   | 2     | RUN_UNSTARTED_LABEL (src/lib/Domain.ts)                       |
| age         | 1     | byAge (src/lib/Domain.ts)                                     |
| allowed     | 1     | RunNotAllowedError (src/lib/RunRepository.ts)                 |
| ambiguous   | 1     | ambiguousItems (src/lib/Domain.ts)                            |
| applied     | 1     | neverApplied (src/lib/workflowShared.ts)                      |
| backdrop    | 1     | useModalBackdropDismissGuard (src/lib/polarisModal.ts)        |
| better      | 1     | BETTER_AUTH_TABLES (src/lib/D1Schema.ts)                      |
| bridge      | 1     | APP_BRIDGE_URL (src/lib/shopifyConstants.ts)                  |
| canceled    | 1     | CANCELED (src/lib/Domain.ts)                                  |
| canceling   | 1     | CANCELING (src/lib/Domain.ts)                                 |
| cause       | 1     | causeToErrorMessage (src/lib/LayerEx.ts)                      |
| cdn         | 1     | CDN_URL (src/lib/shopifyConstants.ts)                         |
| clamp       | 1     | clampRunLimit (src/lib/Domain.ts)                             |
| cloudflare  | 1     | CloudflareEnv (src/lib/CloudflareEnv.ts)                      |
| confirm     | 1     | confirm (src/lib/Screen.ts)                                   |
| created     | 1     | CREATED (src/lib/Domain.ts)                                   |
| cursor      | 1     | OrdersCursor (src/lib/Domain.ts)                              |
| cutoff      | 1     | retentionCutoff (src/lib/Domain.ts)                           |
| date        | 1     | formatDateTime (src/lib/format.ts)                            |
| day         | 1     | ORDER_IMPORT_WINDOW_DAYS (src/lib/orderSyncConstants.ts)      |
| deleted     | 1     | DELETED_TOAST (src/lib/workflowShared.ts)                     |
| delivery    | 1     | WebhookDelivery (src/lib/OrderRepository.ts)                  |
| dirty       | 1     | setModalDirty (src/lib/polarisModal.ts)                       |
| dismiss     | 1     | useModalBackdropDismissGuard (src/lib/polarisModal.ts)        |
| diverge     | 1     | meterDiverges (src/lib/Domain.ts)                             |
| down        | 1     | down (src/lib/Domain.ts)                                      |
| ensure      | 1     | ensureSessionProps (src/lib/OrdersSyncWorkflow.ts)            |
| epoch       | 1     | EpochMillis (src/lib/Domain.ts)                               |
| exit        | 1     | planSelectionExitIframeHref (src/lib/ShopifyPartner.ts)       |
| failed      | 1     | FAILED (src/lib/Domain.ts)                                    |
| flight      | 1     | in_flight (src/lib/Domain.ts)                                 |
| flush       | 1     | UsageFlush (src/lib/OrderRepository.ts)                       |
| forbidden   | 1     | CONNECTION_CLOSE_FORBIDDEN (src/lib/Domain.ts)                |
| frame       | 1     | markSocketFrame (src/lib/ShopAgentContext.tsx)                |
| give        | 1     | BULK_GIVE_UP_MS (src/lib/orderSyncConstants.ts)               |
| gone        | 1     | TEAM_GONE (src/lib/teams.ts)                                  |
| guard       | 1     | useModalBackdropDismissGuard (src/lib/polarisModal.ts)        |
| has         | 1     | hasEmptyTeam (src/lib/Domain.ts)                              |
| help        | 1     | help (src/lib/Screen.ts)                                      |
| hide        | 1     | hideModal (src/lib/polarisModal.ts)                           |
| href        | 1     | planSelectionExitIframeHref (src/lib/ShopifyPartner.ts)       |
| ids         | 1     | CONNECTION_TEAM_IDS_HEADER (src/lib/Domain.ts)                |
| if          | 1     | reconnectIfSocketStale (src/lib/ShopAgentContext.tsx)         |
| iframe      | 1     | planSelectionExitIframeHref (src/lib/ShopifyPartner.ts)       |
| import      | 1     | ORDER_IMPORT_WINDOW_DAYS (src/lib/orderSyncConstants.ts)      |
| initialize  | 1     | initializeSchema (src/lib/ShopAgentSchema.ts)                 |
| interval    | 1     | BULK_POLL_INTERVAL_MS (src/lib/orderSyncConstants.ts)         |
| invalid     | 1     | OfflineSessionInvalidError (src/lib/Shopify.ts)               |
| layout      | 1     | Layout (src/lib/WorkflowLayout.ts)                            |
| lenient     | 1     | lenientSearchKey (src/lib/searchParams.ts)                    |
| logger      | 1     | makeLoggerLayer (src/lib/LayerEx.ts)                          |
| lowest      | 1     | lowestOpenStep (src/lib/Domain.ts)                            |
| magic       | 1     | magicLinkKvKey (src/lib/Auth.ts)                              |
| manual      | 1     | manual (src/lib/Domain.ts)                                    |
| migration   | 1     | runShopAgentMigrations (src/lib/ShopAgentSchema.ts)           |
| milli       | 1     | EpochMillis (src/lib/Domain.ts)                               |
| mutation    | 1     | mutationErrorMessage (src/lib/form.ts)                        |
| never       | 1     | neverApplied (src/lib/workflowShared.ts)                      |
| normalise   | 1     | normaliseOrderSearch (src/lib/Domain.ts)                      |
| normalize   | 1     | normalize (src/lib/WorkflowLayout.ts)                         |
| null        | 1     | textOrNull (src/lib/useMemberRunActions.ts)                   |
| number      | 1     | formatNumber (src/lib/format.ts)                              |
| out         | 1     | signOutFn (src/lib/memberSignOut.ts)                          |
| param       | 1     | OrdersSyncParams (src/lib/OrdersSyncWorkflow.ts)              |
| passthrough | 1     | tryPromisePassthrough (src/lib/LayerEx.ts)                    |
| ping        | 1     | SocketKeepalivePing (src/lib/Domain.ts)                       |
| placeholder | 1     | placeholder (src/lib/Screen.ts)                               |
| plural      | 1     | plural (src/lib/teams.ts)                                     |
| polari      | 1     | POLARIS_URL (src/lib/shopifyConstants.ts)                     |
| pong        | 1     | SocketKeepalivePong (src/lib/Domain.ts)                       |
| post        | 1     | postEditorWindowMessage (src/lib/workflowEditorWindow.ts)     |
| prefix      | 1     | SEED_ORDER_ID_PREFIX (src/lib/Domain.ts)                      |
| primary     | 1     | D1Primary (src/lib/D1Primary.ts)                              |
| prop        | 1     | ensureSessionProps (src/lib/OrdersSyncWorkflow.ts)            |
| provisional | 1     | provisionalCycleStart (src/lib/Domain.ts)                     |
| quantity    | 1     | meterQuantity (src/lib/ShopifyPartner.ts)                     |
| reconnect   | 1     | reconnectIfSocketStale (src/lib/ShopAgentContext.tsx)         |
| recovery    | 1     | withSocketRecovery (src/lib/ShopAgentContext.tsx)             |
| refresh     | 1     | RefreshTokenExpiredError (src/lib/Shopify.ts)                 |
| refused     | 1     | refused (src/lib/Domain.ts)                                   |
| relative    | 1     | formatRelative (src/lib/format.ts)                            |
| removed     | 1     | item_removed (src/lib/Domain.ts)                              |
| renamed     | 1     | RENAMED_TOAST (src/lib/workflowShared.ts)                     |
| reopened    | 1     | taskReopenedBy (src/lib/Domain.ts)                            |
| resolve     | 1     | resolveEntitlements (src/lib/SubscriptionPlan.ts)             |
| resource    | 1     | useResourceLinkTarget (src/lib/orderLinks.ts)                 |
| retention   | 1     | retentionCutoff (src/lib/Domain.ts)                           |
| revalidate  | 1     | revalidateStalePlans (src/lib/SubscriptionPlan.ts)            |
| revoked     | 1     | CONNECTION_CLOSE_REVOKED (src/lib/Domain.ts)                  |
| running     | 1     | RUNNING (src/lib/Domain.ts)                                   |
| same        | 1     | sameRunQuery (src/lib/Domain.ts)                              |
| selection   | 1     | planSelectionExitIframeHref (src/lib/ShopifyPartner.ts)       |
| sentence    | 1     | sentence (src/lib/Screen.ts)                                  |
| show        | 1     | showModal (src/lib/polarisModal.ts)                           |
| sign        | 1     | signOutFn (src/lib/memberSignOut.ts)                          |
| since       | 1     | placedSince (src/lib/RunRepository.ts)                        |
| submit      | 1     | submitBulkOrdersQuery (src/lib/OrdersSyncWorkflow.ts)         |
| subscribed  | 1     | useSubscribedQuery (src/lib/useSubscribedQuery.ts)            |
| target      | 1     | useResourceLinkTarget (src/lib/orderLinks.ts)                 |
| terminal    | 1     | RunTerminalError (src/lib/RunRepository.ts)                   |
| token       | 1     | RefreshTokenExpiredError (src/lib/Shopify.ts)                 |
| tone        | 1     | ORDER_ISSUE_TONE (src/lib/Domain.ts)                          |
| trigger     | 1     | itemTriggerLine (src/lib/workflowShared.ts)                   |
| try         | 1     | tryPromisePassthrough (src/lib/LayerEx.ts)                    |
| turned      | 1     | TURNED_OFF (src/lib/workflowShared.ts)                        |
| unit        | 1     | unitsToMake (src/lib/Domain.ts)                               |
| valid       | 1     | isValid (src/lib/WorkflowLayout.ts)                           |
| variable    | 1     | orderSyncVariables (src/lib/OrderSync.ts)                     |
| visible     | 1     | runIsVisibleTo (src/lib/Domain.ts)                            |
| watchdog    | 1     | SOCKET_WATCHDOG_MS (src/lib/ShopAgentContext.tsx)             |
| where       | 1     | currentWhere (src/lib/currentWhere.ts)                        |

</details>

### Phase 4

- **4.1.** Also renamed, beyond the plan's list: `applyAndActivate` → `applyAndTurnOn`,
  `ApplyAndActivateInput` → `ApplyAndTurnOnInput`, `decodeActivateResult` /
  `activateResultMessage` / `activateResult` → `decodeSwitchResult` / `switchResultMessage` /
  `switchResult`; the workflow's input field `active` → `on` (`SetWorkflowOnInput`, the seed
  fixtures, `replaceWorkflows`, the e2e fixture); and the workflows index's `?status=` values
  `active` / `inactive` → `on` / `off`. The workflow-states table's `stored` cell said `active`
  true / false, which was already stale; it now says `activatedAt` set / null. "Active teams"
  in the `MemberAccess` JSDoc dropped the adjective. Shopify's own "active" (a session, a bulk
  operation, an app subscription) is untouched. **Ran `pnpm dev:reset` after 4.1**: stopped,
  wiped, started, installed, seeded.
- **4.2.** Local variables named `roster` became `shopTeams` and `teamsById`. The triggers
  table's seat-mark words became `→ member count` and `→ member count if above` (and the
  checker's list with them); two pinned titles changed with their tests ("a new cycle resets the
  mark to the member count ...", "an unchanged cycle raises the mark to a member count past it
  ..."). JSDoc prose says the shop's teams, the member count, or the team's members, by sense.
- **4.3.** "Slot" had two more production senses beside the item's: the open-run ceiling ("frees
  this slot") and the task's actor columns ("actor slot", "Done slot", "`reopened*` slot"). Both
  were rewritten ("no longer counts here"; "the `done*` columns", "recorded actor"). The order
  page's "filled slot" for a task's team became "filled field". Polaris' `slot` attribute and the
  screen spec's copy slot keep the word, so the Phase 6 grep still returns those lines (below).
- **4.4.** `RunView` does not collide with an export and reads as "the view a run's row is in",
  so it was used. The test constant `TIER_TABS` became `RUN_VIEWS` (it also carried the retired
  "tab"). "The screen tier" in `Screen.ts` and `AGENTS.md` became "the screens' spec".
- **4.6.** `ChangeActivatedAtResult.Ok.started` also became `created` (the same count as
  `SwitchResult`'s), and `startedToast` became `createdToast`; the toast copy is unchanged. The
  order page's item kind `startable` and the closed kind's `startable` flag became `attachable`,
  not `eligible`: the item is not a workflow, and its verb row is "attach workflow". The merchant
  copy bullets in the `Workflow` JSDoc ("a workflow **starts when** ...") describe screen copy and
  were left.
- **4.7.** The Verbs table's screen columns must equal `VERB_LABEL`, so the four workflow verbs
  were added to `Verb` and `VERB_LABEL`, and the header buttons that show them (Turn on, Turn off,
  Apply changes, Discard changes) now read `VERB_LABEL`. The confirm buttons inside the Apply and
  Discard modals keep their literals ("Apply", "Discard").
- `grep -rn "'active'" src` returns nothing: no single-quoted Shopify literal remains either.
- The audit still lists `slot` (`CopySlot`, allowed) and now lists `eligible` (`EligibleContext`,
  a reconcile word the reconcile spec adds) and `switch` (`SwitchResult`). `activated` stays:
  `activatedAt` is the coverage date and kept its name.

End-of-Phase-4 run of `pnpm vocab:audit`. Gone since the first run: activate, active, apply,
ceiling, discard, draft, import, roster, sync, tier, turn. New: eligible, switch.

<details><summary>216 lines</summary>

| word        | count | example                                                       |
| ----------- | ----- | ------------------------------------------------------------- |
| agent       | 20    | ShopAgentId (src/lib/Domain.ts)                               |
| session     | 19    | CurrentShopifySession (src/lib/CurrentShopifySession.ts)      |
| message     | 17    | InvalidatedMessage (src/lib/Domain.ts)                        |
| connection  | 16    | ConnectionRole (src/lib/Domain.ts)                            |
| line        | 16    | LineItemProperty (src/lib/Domain.ts)                          |
| bulk        | 14    | BulkOperationStatus (src/lib/Domain.ts)                       |
| detail      | 12    | TeamDetail (src/lib/Domain.ts)                                |
| loader      | 12    | AdminShopLoaderData (src/lib/Domain.ts)                       |
| socket      | 12    | SocketKeepalivePing (src/lib/Domain.ts)                       |
| admin       | 10    | requireAdmin (src/lib/AdminServerFnMiddleware.ts)             |
| repository  | 10    | OrderRepositoryError (src/lib/OrderRepository.ts)             |
| seed        | 9     | SeedWorkflowsInput (src/lib/Domain.ts)                        |
| shopify     | 9     | CurrentShopifySession (src/lib/CurrentShopifySession.ts)      |
| command     | 8     | StartTaskCommand (src/lib/Domain.ts)                          |
| subscribe   | 8     | SubscribeOrdersInput (src/lib/Domain.ts)                      |
| user        | 8     | UserId (src/lib/Domain.ts)                                    |
| actor       | 7     | Actor (src/lib/Domain.ts)                                     |
| d1          | 7     | D1Bookmark (src/lib/D1Bookmark.ts)                            |
| found       | 7     | TeamNotFoundError (src/lib/Repository.ts)                     |
| entitlement | 6     | Entitlements (src/lib/Domain.ts)                              |
| format      | 6     | formatErrorMessage (src/lib/LayerEx.ts)                       |
| heading     | 6     | heading (src/lib/Screen.ts)                                   |
| summary     | 6     | TeamSummary (src/lib/Domain.ts)                               |
| taken       | 6     | TeamNameTakenError (src/lib/Repository.ts)                    |
| use         | 6     | useShopAgent (src/lib/ShopAgentContext.tsx)                   |
| activated   | 5     | SetWorkflowActivatedAtInput (src/lib/Domain.ts)               |
| auth        | 5     | AuthError (src/lib/Auth.ts)                                   |
| body        | 5     | body (src/lib/Screen.ts)                                      |
| email       | 5     | Email (src/lib/Domain.ts)                                     |
| modal       | 5     | modal (src/lib/Screen.ts)                                     |
| object      | 5     | ShopAgentObjectsError (src/lib/ShopAgentObjects.ts)           |
| operation   | 5     | BulkOperationStatus (src/lib/Domain.ts)                       |
| role        | 5     | UserRole (src/lib/Domain.ts)                                  |
| search      | 5     | OrderSearch (src/lib/Domain.ts)                               |
| toast       | 5     | toast (src/lib/Screen.ts)                                     |
| webhook     | 5     | webhook (src/lib/Domain.ts)                                   |
| window      | 5     | DONE_WINDOW_MS (src/lib/Domain.ts)                            |
| blocker     | 4     | ReopenBlocker (src/lib/Domain.ts)                             |
| fn          | 4     | adminServerFnMiddleware (src/lib/AdminServerFnMiddleware.ts)  |
| header      | 4     | CONNECTION_ROLE_HEADER (src/lib/Domain.ts)                    |
| length      | 4     | TEAM_NAME_MAX_LENGTH (src/lib/Domain.ts)                      |
| link        | 4     | magicLinkKvKey (src/lib/Auth.ts)                              |
| mark        | 4     | MarkTaskDoneInput (src/lib/Domain.ts)                         |
| node        | 4     | OrderNode (src/lib/OrderSync.ts)                              |
| reconcile   | 4     | ReconcileUsageInput (src/lib/Domain.ts)                       |
| redacted    | 4     | ShopSessionRedacted (src/lib/Domain.ts)                       |
| unassigned  | 4     | workflowTaskIsUnassigned (src/lib/Domain.ts)                  |
| up          | 4     | up (src/lib/Domain.ts)                                        |
| warning     | 4     | changeWarning (src/lib/changeWarning.ts)                      |
| banner      | 3     | banner (src/lib/Screen.ts)                                    |
| bookmark    | 3     | D1Bookmark (src/lib/D1Bookmark.ts)                            |
| completed   | 3     | bulkOperationCompleted (src/lib/Domain.ts)                    |
| copy        | 3     | CopySlot (src/lib/Screen.ts)                                  |
| editor      | 3     | EditorWindowMessage (src/lib/workflowEditorWindow.ts)         |
| join        | 3     | JoinTaskInput (src/lib/Domain.ts)                             |
| keepalive   | 3     | SocketKeepalivePing (src/lib/Domain.ts)                       |
| kv          | 3     | magicLinkKvKey (src/lib/Auth.ts)                              |
| login       | 3     | LoginInput (src/lib/Domain.ts)                                |
| middleware  | 3     | adminServerFnMiddleware (src/lib/AdminServerFnMiddleware.ts)  |
| move        | 3     | MoveTaskInput (src/lib/Domain.ts)                             |
| separate    | 3     | SeparateTaskInput (src/lib/Domain.ts)                         |
| server      | 3     | adminServerFnMiddleware (src/lib/AdminServerFnMiddleware.ts)  |
| stale       | 3     | STALE_SOCKET_MS (src/lib/ShopAgentContext.tsx)                |
| stream      | 3     | ShopAgentOrdersStreamError (src/lib/ShopAgentOrdersStream.ts) |
| upsert      | 3     | ShopSessionUpsert (src/lib/Domain.ts)                         |
| access      | 2     | MemberAccess (src/lib/Domain.ts)                              |
| append      | 2     | append (src/lib/WorkflowLayout.ts)                            |
| badge       | 2     | badge (src/lib/Screen.ts)                                     |
| basic       | 2     | baton-basic (src/lib/Domain.ts)                               |
| baton       | 2     | baton-basic (src/lib/Domain.ts)                               |
| button      | 2     | button (src/lib/Screen.ts)                                    |
| close       | 2     | CONNECTION_CLOSE_FORBIDDEN (src/lib/Domain.ts)                |
| control     | 2     | Control (src/lib/Screen.ts)                                   |
| created     | 2     | CREATED (src/lib/Domain.ts)                                   |
| destroy     | 2     | destroyShopAgent (src/lib/Shopify.ts)                         |
| direction   | 2     | TaskDirection (src/lib/Domain.ts)                             |
| display     | 2     | ActorDisplay (src/lib/Domain.ts)                              |
| duplicate   | 2     | DuplicateWorkflowInput (src/lib/Domain.ts)                    |
| eligible    | 2     | EligibleContext (src/lib/RunRepository.ts)                    |
| env         | 2     | CloudflareEnv (src/lib/CloudflareEnv.ts)                      |
| expired     | 2     | EXPIRED (src/lib/Domain.ts)                                   |
| gid         | 2     | ShopGid (src/lib/Domain.ts)                                   |
| instruction | 2     | TaskInstructions (src/lib/Domain.ts)                          |
| invalidated | 2     | InvalidatedMessage (src/lib/Domain.ts)                        |
| layout      | 2     | Layout (src/lib/WorkflowLayout.ts)                            |
| matche      | 2     | matchesLineItem (src/lib/RunRepository.ts)                    |
| mine        | 2     | mine (src/lib/Domain.ts)                                      |
| offline     | 2     | OfflineSessionNotFoundError (src/lib/Shopify.ts)              |
| partner     | 2     | ShopifyPartnerError (src/lib/ShopifyPartner.ts)               |
| placed      | 2     | placedSince (src/lib/RunRepository.ts)                        |
| poll        | 2     | pollBulkOrdersQuery (src/lib/OrdersSyncWorkflow.ts)           |
| pro         | 2     | baton-pro (src/lib/Domain.ts)                                 |
| progress    | 2     | SeedProgress (src/lib/Domain.ts)                              |
| promise     | 2     | tryPromisePassthrough (src/lib/LayerEx.ts)                    |
| property    | 2     | LineItemProperty (src/lib/Domain.ts)                          |
| provider    | 2     | ShopAgentProvider (src/lib/ShopAgentContext.tsx)              |
| recent      | 2     | RecentItem (src/lib/Domain.ts)                                |
| rename      | 2     | RENAME_HEADING (src/lib/workflowShared.ts)                    |
| resync      | 2     | ResyncOrderInput (src/lib/Domain.ts)                          |
| revoke      | 2     | RevokeMemberConnectionsInput (src/lib/Domain.ts)              |
| slot        | 2     | CopySlot (src/lib/Screen.ts)                                  |
| subscriber  | 2     | SubscriberIdInput (src/lib/Domain.ts)                         |
| switch      | 2     | SwitchResult (src/lib/Domain.ts)                              |
| teammate    | 2     | teammates (src/lib/Domain.ts)                                 |
| text        | 2     | bulkOrdersQueryText (src/lib/OrdersBulkRepository.ts)         |
| time        | 2     | formatDateTime (src/lib/format.ts)                            |
| unstarted   | 2     | RUN_UNSTARTED_LABEL (src/lib/Domain.ts)                       |
| age         | 1     | byAge (src/lib/Domain.ts)                                     |
| allowed     | 1     | RunNotAllowedError (src/lib/RunRepository.ts)                 |
| ambiguous   | 1     | ambiguousItems (src/lib/Domain.ts)                            |
| applied     | 1     | neverApplied (src/lib/workflowShared.ts)                      |
| backdrop    | 1     | useModalBackdropDismissGuard (src/lib/polarisModal.ts)        |
| better      | 1     | BETTER_AUTH_TABLES (src/lib/D1Schema.ts)                      |
| bridge      | 1     | APP_BRIDGE_URL (src/lib/shopifyConstants.ts)                  |
| canceled    | 1     | CANCELED (src/lib/Domain.ts)                                  |
| canceling   | 1     | CANCELING (src/lib/Domain.ts)                                 |
| cause       | 1     | causeToErrorMessage (src/lib/LayerEx.ts)                      |
| cdn         | 1     | CDN_URL (src/lib/shopifyConstants.ts)                         |
| clamp       | 1     | clampRunLimit (src/lib/Domain.ts)                             |
| cloudflare  | 1     | CloudflareEnv (src/lib/CloudflareEnv.ts)                      |
| confirm     | 1     | confirm (src/lib/Screen.ts)                                   |
| cursor      | 1     | OrdersCursor (src/lib/Domain.ts)                              |
| cutoff      | 1     | retentionCutoff (src/lib/Domain.ts)                           |
| date        | 1     | formatDateTime (src/lib/format.ts)                            |
| day         | 1     | ORDER_IMPORT_WINDOW_DAYS (src/lib/orderSyncConstants.ts)      |
| deleted     | 1     | DELETED_TOAST (src/lib/workflowShared.ts)                     |
| delivery    | 1     | WebhookDelivery (src/lib/OrderRepository.ts)                  |
| dirty       | 1     | setModalDirty (src/lib/polarisModal.ts)                       |
| dismiss     | 1     | useModalBackdropDismissGuard (src/lib/polarisModal.ts)        |
| diverge     | 1     | meterDiverges (src/lib/Domain.ts)                             |
| down        | 1     | down (src/lib/Domain.ts)                                      |
| ensure      | 1     | ensureSessionProps (src/lib/OrdersSyncWorkflow.ts)            |
| epoch       | 1     | EpochMillis (src/lib/Domain.ts)                               |
| exit        | 1     | planSelectionExitIframeHref (src/lib/ShopifyPartner.ts)       |
| failed      | 1     | FAILED (src/lib/Domain.ts)                                    |
| flight      | 1     | in_flight (src/lib/Domain.ts)                                 |
| flush       | 1     | UsageFlush (src/lib/OrderRepository.ts)                       |
| forbidden   | 1     | CONNECTION_CLOSE_FORBIDDEN (src/lib/Domain.ts)                |
| frame       | 1     | markSocketFrame (src/lib/ShopAgentContext.tsx)                |
| give        | 1     | BULK_GIVE_UP_MS (src/lib/orderSyncConstants.ts)               |
| gone        | 1     | TEAM_GONE (src/lib/teams.ts)                                  |
| guard       | 1     | useModalBackdropDismissGuard (src/lib/polarisModal.ts)        |
| has         | 1     | hasEmptyTeam (src/lib/Domain.ts)                              |
| help        | 1     | help (src/lib/Screen.ts)                                      |
| hide        | 1     | hideModal (src/lib/polarisModal.ts)                           |
| href        | 1     | planSelectionExitIframeHref (src/lib/ShopifyPartner.ts)       |
| ids         | 1     | CONNECTION_TEAM_IDS_HEADER (src/lib/Domain.ts)                |
| if          | 1     | reconnectIfSocketStale (src/lib/ShopAgentContext.tsx)         |
| iframe      | 1     | planSelectionExitIframeHref (src/lib/ShopifyPartner.ts)       |
| initialize  | 1     | initializeSchema (src/lib/ShopAgentSchema.ts)                 |
| interval    | 1     | BULK_POLL_INTERVAL_MS (src/lib/orderSyncConstants.ts)         |
| invalid     | 1     | OfflineSessionInvalidError (src/lib/Shopify.ts)               |
| lenient     | 1     | lenientSearchKey (src/lib/searchParams.ts)                    |
| logger      | 1     | makeLoggerLayer (src/lib/LayerEx.ts)                          |
| lowest      | 1     | lowestOpenStep (src/lib/Domain.ts)                            |
| magic       | 1     | magicLinkKvKey (src/lib/Auth.ts)                              |
| manual      | 1     | manual (src/lib/Domain.ts)                                    |
| migration   | 1     | runShopAgentMigrations (src/lib/ShopAgentSchema.ts)           |
| milli       | 1     | EpochMillis (src/lib/Domain.ts)                               |
| mutation    | 1     | mutationErrorMessage (src/lib/form.ts)                        |
| never       | 1     | neverApplied (src/lib/workflowShared.ts)                      |
| normalise   | 1     | normaliseOrderSearch (src/lib/Domain.ts)                      |
| normalize   | 1     | normalize (src/lib/WorkflowLayout.ts)                         |
| null        | 1     | textOrNull (src/lib/useMemberRunActions.ts)                   |
| number      | 1     | formatNumber (src/lib/format.ts)                              |
| out         | 1     | signOutFn (src/lib/memberSignOut.ts)                          |
| param       | 1     | OrdersSyncParams (src/lib/OrdersSyncWorkflow.ts)              |
| passthrough | 1     | tryPromisePassthrough (src/lib/LayerEx.ts)                    |
| ping        | 1     | SocketKeepalivePing (src/lib/Domain.ts)                       |
| placeholder | 1     | placeholder (src/lib/Screen.ts)                               |
| plural      | 1     | plural (src/lib/teams.ts)                                     |
| polari      | 1     | POLARIS_URL (src/lib/shopifyConstants.ts)                     |
| pong        | 1     | SocketKeepalivePong (src/lib/Domain.ts)                       |
| post        | 1     | postEditorWindowMessage (src/lib/workflowEditorWindow.ts)     |
| prefix      | 1     | SEED_ORDER_ID_PREFIX (src/lib/Domain.ts)                      |
| primary     | 1     | D1Primary (src/lib/D1Primary.ts)                              |
| prop        | 1     | ensureSessionProps (src/lib/OrdersSyncWorkflow.ts)            |
| provisional | 1     | provisionalCycleStart (src/lib/Domain.ts)                     |
| quantity    | 1     | meterQuantity (src/lib/ShopifyPartner.ts)                     |
| reconnect   | 1     | reconnectIfSocketStale (src/lib/ShopAgentContext.tsx)         |
| recovery    | 1     | withSocketRecovery (src/lib/ShopAgentContext.tsx)             |
| refresh     | 1     | RefreshTokenExpiredError (src/lib/Shopify.ts)                 |
| refused     | 1     | refused (src/lib/Domain.ts)                                   |
| relative    | 1     | formatRelative (src/lib/format.ts)                            |
| removed     | 1     | item_removed (src/lib/Domain.ts)                              |
| renamed     | 1     | RENAMED_TOAST (src/lib/workflowShared.ts)                     |
| reopened    | 1     | taskReopenedBy (src/lib/Domain.ts)                            |
| resolve     | 1     | resolveEntitlements (src/lib/SubscriptionPlan.ts)             |
| resource    | 1     | useResourceLinkTarget (src/lib/orderLinks.ts)                 |
| retention   | 1     | retentionCutoff (src/lib/Domain.ts)                           |
| revalidate  | 1     | revalidateStalePlans (src/lib/SubscriptionPlan.ts)            |
| revoked     | 1     | CONNECTION_CLOSE_REVOKED (src/lib/Domain.ts)                  |
| running     | 1     | RUNNING (src/lib/Domain.ts)                                   |
| same        | 1     | sameRunQuery (src/lib/Domain.ts)                              |
| selection   | 1     | planSelectionExitIframeHref (src/lib/ShopifyPartner.ts)       |
| sentence    | 1     | sentence (src/lib/Screen.ts)                                  |
| show        | 1     | showModal (src/lib/polarisModal.ts)                           |
| sign        | 1     | signOutFn (src/lib/memberSignOut.ts)                          |
| since       | 1     | placedSince (src/lib/RunRepository.ts)                        |
| submit      | 1     | submitBulkOrdersQuery (src/lib/OrdersSyncWorkflow.ts)         |
| subscribed  | 1     | useSubscribedQuery (src/lib/useSubscribedQuery.ts)            |
| target      | 1     | useResourceLinkTarget (src/lib/orderLinks.ts)                 |
| terminal    | 1     | RunTerminalError (src/lib/RunRepository.ts)                   |
| token       | 1     | RefreshTokenExpiredError (src/lib/Shopify.ts)                 |
| tone        | 1     | ORDER_ISSUE_TONE (src/lib/Domain.ts)                          |
| trigger     | 1     | itemTriggerLine (src/lib/workflowShared.ts)                   |
| try         | 1     | tryPromisePassthrough (src/lib/LayerEx.ts)                    |
| turned      | 1     | TURNED_OFF (src/lib/workflowShared.ts)                        |
| unit        | 1     | unitsToMake (src/lib/Domain.ts)                               |
| valid       | 1     | layoutIsValid (src/lib/WorkflowLayout.ts)                     |
| variable    | 1     | orderSyncVariables (src/lib/OrderSync.ts)                     |
| visible     | 1     | runIsVisibleTo (src/lib/Domain.ts)                            |
| watchdog    | 1     | SOCKET_WATCHDOG_MS (src/lib/ShopAgentContext.tsx)             |
| where       | 1     | currentWhere (src/lib/currentWhere.ts)                        |

</details>

### Phase 5: rows that fail the entry test

The five tests, numbered as in the vocabulary header: (1) a concept, not a mechanism or metaphor;
(2) one meaning in its context, shared words with their noun; (3) Shopify's words for Shopify's
things, plain words for Baton's, no invented word on a screen; (4) the stored literal is the word
where the store is ours; (5) a failing word is mapped, retired or split.

| word            | table           | fails         | proposal                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| view            | Nouns           | 1 and context | Passes 3: "view" is Shopify's word for the same control (the Orders page's "Select a view"). The meaning cell is a description ("one whole question about a list"); state the concept: "a preset of a list, one at a time, chosen by pressing its button". Its `context` cell says production, but the orders index's views are about orders: make the cell "production and orders", or treat it as a screen word like the Screens table. |
| included        | Billing         | 3             | Chosen on purpose: `Entitlements` says it is not a "free tier" because the allowance is what the app subscription already paid for. That is rule 1 (the concept is a paid allowance) overriding rule 3 (Shopify's pricing word). Keep it, and put the reason in the row's meaning so the next reader does not "fix" it to Shopify's word.                                                                                                 |
| counted order   | Billing         | 1             | "Counted" names the mechanism (the counting write, `countedAt`), not the concept. The concept is an order on the orders meter; the home page says "Orders this billing cycle". Propose "metered order", or retire the row to a JSDoc term on `ShopOrder.countedAt` and let "meter" carry the concept.                                                                                                                                     |
| dead event      | Billing         | 1             | "Dead" is a metaphor. The concept is a usage event dated before the current billing cycle. Propose "past-cycle event" (and `usageEventIsPastCycle`).                                                                                                                                                                                                                                                                                      |
| off / on        | Workflow states | 4             | The stored column is `activatedAt`, which carries the retired stem "activ" and names neither the word ("on") nor the date's meaning (the coverage date). The plan kept it on purpose. Propose `onSince` (it is both the switch and the coverage date), in place in `initializeSchema`, if the column is renamed at all.                                                                                                                   |
| team            | Order issues    | 2             | "team" is the noun in the same context; as an issue it means "a task with no team". The row's flag is already `unassigned`. Propose the word "unassigned", literal `unassigned` (replacing `team`), screen unchanged (Needs a team).                                                                                                                                                                                                      |
| choose workflow | Order issues    | 1             | Names the remedy, not the fault. The fault is an ambiguous item. Propose "ambiguous", literal `ambiguous`, screen unchanged (Needs a workflow). Defer to the reconcile spec, which adds "ambiguous".                                                                                                                                                                                                                                      |
| done            | Verbs           | 1             | "Done" is not a verb; the code says `markTaskDone` and "complete", and "mark done" is a retired screen phrase. The screen label Done is right. Propose the verb word "complete", screen Done, and the identifiers follow (`completeTask`).                                                                                                                                                                                                |
| not started     | Order positions | 2             | "Started" means a person has a task (task states); an order "not started" includes orders nothing will ever be made for (no match, cancelled run, removed item), so it is not the negation of that. The row's own note says "to make" was rejected for the same reason. Keep the screen word; consider the vocabulary word "idle" or "untouched" so the code does not read `started` in two senses.                                       |
| shop            | Nouns           | 3             | Shopify's merchant-facing word is "store"; "shop" is the API's. The member side's shop picker heading says "Your shops". The merchant never sees the word (the cell says its domain). Propose keeping "shop" in code (the API and the tenant) and deciding the member screen's word: "store" matches what the merchant reads in Shopify.                                                                                                  |
| sync            | Nouns           | —             | Passes: a platform word, and the platform context is about mechanisms. Listed because the screen says "syncing" in the order-ceiling banner and "Resync from Shopify" on the order page, a technical word on a merchant screen.                                                                                                                                                                                                           |

No row's `symbol` cell names a symbol Phase 4 renamed: `checkVocabulary` refuses a backticked word
that no longer occurs, and it passes.

### Phase 6

- `grep -rn -i "glossary\|roster\|slot\|tier" src scripts AGENTS.md` returns billing's "tier",
  and "slot" in two senses that are not the retired one: Polaris web-component slots (`slot=`,
  `listSlot`, "action slots", "slotted") and the screen spec's copy slot (`CopySlot`,
  `scripts/copy-audit.ts`, the copy table's `slot` column). It also returns the reserved list in
  `scripts/lib/rules-lint.ts` and its test, which name the retired words on purpose.

## Review of the implementation (2026-09-29)

Checked against the plan on the working tree: `pnpm typecheck`, `pnpm lint` (both new checks
on), `pnpm test` (530) and `pnpm fmt` pass; the Phase 6 greps return what the Deviations say;
no pre-rename identifier survives outside Shopify's own `session.isActive()`. The full e2e
suite result is at the end of this section.

### Deviations: verdicts

| deviation                                                                    | verdict | note                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `checkContexts` instead of a table-name list; Nouns gets a `context` column  | keep    | Better than the plan: the check reads the table, so a new table cannot forget its context.                                                                                           |
| Screens table exempt from the context check                                  | keep    | Screens are named in every context.                                                                                                                                                  |
| Audit treats each table's name words as known ("Run states" → "state")       | change  | It hides the very word the plan wanted caught (`ProductionState`). Drop the intro words from `known`; the words that then appear (state, position, issue) are judged like any other. |
| `CopySlot` on the reserved-stem allowlist                                    | keep    | The screens' spec is its own context; the copy table is built on the word.                                                                                                           |
| Three extra `is<State>` predicates renamed                                   | keep    | The check found them; the rule is right.                                                                                                                                             |
| 4.1 extra renames (`applyAndTurnOn`, `?status=on/off`, input field `on`)     | keep    | Required for one word everywhere. The URL change is fine while prototyping.                                                                                                          |
| 4.2 triggers-table words → "member count"                                    | keep    |                                                                                                                                                                                      |
| 4.3 "filled slot" → "filled field"; other slot senses rewritten              | keep    |                                                                                                                                                                                      |
| 4.4 `RunView`, `RUN_VIEWS`                                                   | keep    |                                                                                                                                                                                      |
| 4.6 item kind `startable` → `attachable`, not `eligible`                     | keep    | Right call: the item's verb row is "attach workflow"; "eligible" is the workflow's word.                                                                                             |
| 4.6 merchant copy "Starts when an order contains ..." left                   | keep    | Screen copy may differ from the vocabulary word (as "workflow" stands for run). Say so in one line on `itemTriggerLine` so the next reader does not "fix" it to "creates".           |
| 4.7 workflow verbs in `VERB_LABEL`; modal confirm buttons keep Apply/Discard | keep    | A confirm button repeating the verb's first word is Polaris' pattern. Add "confirm" to the copy table's `form` for the button row if it is not already implied.                      |
| Audit still lists `eligible`, `switch`, `activated`, `slot`                  | keep    | `eligible` is the reconcile spec's; `switch` is a JSDoc term on `SwitchResult`/`WorkflowSwitch`; `activated` is the column (row 5 below); `slot` is `CopySlot`.                      |
| Only three e2e specs run                                                     | done    | Full suite run in this review; result below.                                                                                                                                         |

### Phase 5 rows: what was done (2026-09-29)

Done in this tree, each with its vocabulary row:

1. **included**: kept; the meaning cell now says "a paid allowance, not a "free tier"".
2. **view**: kept; meaning is now the concept ("a preset of a list, one at a time, chosen by
   its button; the row's first is the default"), context "production and orders".
3. **team** (order issue) → **unassigned**: literal `unassigned` in `OrderIssue`,
   `ORDER_ISSUE_LABEL`, `orderIssues`, the issues table and the tests; screen unchanged.
4. **dead event** → **expired event**: `usageEventIsExpired`, `expiredUsageEvents`,
   `expiredUsageEventRetentionDays`; the triggers table's two rows and their pinned test titles
   ("a queued event expires once ...", "the retention sweep deletes expired usage events ...");
   the data-model row; the admin page's tile label "Usage events expired". "Expired" has one
   other sense nearby, an expired order under retention, which is the same sense with its own
   noun.
5. **done** (verb): kept as the word. The review first proposed the word cell "mark done" with
   no code change, but the verb word is the key of `VERB_LABEL` and a column of `taskActions`,
   so a word change is a code change (`markDone`). Instead the Verbs intro says: "done" is the
   verb "mark done", the state it leaves the task in; the identifiers say `markTaskDone`.

Kept as is:

6. **counted order**: "counts" is plain English and already on screen ("Each order synced from
   Shopify counts once"); "metered" would be the mechanism word.
7. **not started** (order position): the word travels with its noun (`OrderPosition`), so rule
   2 holds; "idle"/"untouched" are worse words for the merchant.
8. **sync**: passes as a platform word; "Resync from Shopify" is a merchant action on a Shopify
   fact, and no plainer word says it.

Deferred to the reconcile spec, recorded in `docs/reconcile-research.md` under "Carried over
from the vocabulary plan" so the spec cannot drop them:

9. **on/off stored `activatedAt`**: the column is the coverage date, which the merchant moves
   from the workflow page, so `onSince` would be wrong; it is renamed when the spec adds
   "coverage date".
10. **choose workflow** → **ambiguous**: when the spec adds the word.

Decided by the user (2026-09-29):

11. **shop**: the screen word is **store**, the code word stays **shop**. The tenant is a
    Shopify store, and "store" is the only word a merchant reads for it in Shopify; a member
    never sees Shopify, so for them "shop" is the shop floor, and "Your shops" read as places
    rather than the businesses they work for. Changed: the shop picker's heading and title
    ("Your stores"), the removed and lapsed pages ("this store", "Your stores"), and, by the
    same rule, the merchant's three "This shop ..." strings on the team and members pages. The
    noun row's screen cell and the Screens row follow.

### Deviations: what was done

- The audit no longer treats a table's name as a known word. It now lists `state` (20, `TaskState`),
  `issue` (5), `position` (4), `verb` (3) and `context` (2): category words the tables are named
  for. They are not domain words and not retired; the user decides whether they go on the
  allowlist or stay listed.
- `itemTriggerLine`'s JSDoc says "Starts" is the screen's word on purpose.
- The copy table's button row was left alone: "Apply" and "Discard" in the confirm modals are the
  verb words, which the row's `form` already allows.

### Full e2e suite

`npm run test:e2e` against the running dev server: 68 passed (embedded, admin and member
projects), 5.9 minutes.
