# Bounded contexts: implementation plan

This plan carries out the round-2 decisions in `docs/spec-location-research.md`. Read that doc first: Part 2 says what a bounded context is, draws Baton's map (production, orders, billing; platform as a dialect) and says why `Domain.ts` splits along it. This plan says what to change, in what order, and how to know each step is done.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that enforces it or is the concept. Other sites `{@link}` it. Rules and tables move with their symbols and are not rewritten.
  - JSDoc never cites files under `docs/`. This plan and the research doc will be deleted.
  - The vocabulary moves in the same change as the symbols it names. A word is never left in a file that no longer holds its symbol.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run: `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`, `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Record anything that does not go as written in [Deviations and issues](#deviations-and-issues) as you go.
- Each phase is one change. Do not merge phases.
- This is a move, not a rewrite. No symbol is renamed, no rule reworded, no table edited, except where a phase says so. `git diff --stat` after Phase 2 should be almost all moved lines; a reviewer diffs each new file against the range it came from.

## The map

The four files and what may import what. This is the spec for Phase 1's JSDoc and Phase 4's lint.

| file                           | context    | kind           | may import              |
| ------------------------------ | ---------- | -------------- | ----------------------- |
| `src/lib/domain/Production.ts` | production | core           | `Orders`, `Platform`    |
| `src/lib/domain/Orders.ts`     | orders     | supporting     | `Platform`              |
| `src/lib/domain/Billing.ts`    | billing    | generic        | `Orders`, `Platform`    |
| `src/lib/domain/Platform.ts`   | (dialect)  | technical      | nothing under `domain/` |
| `src/lib/Domain.ts`            | all        | barrel and map | the four, by `export *` |

Relationships, one named crossing each:

| from       | to       | relationship                                          | the crossing                                                                    |
| ---------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| production | orders   | downstream; conformist on words, translation on model | `OrderState`, `orderIsOpen`, `unitsToMake`, `ShopOrder`, `OrderLineItem`        |
| billing    | orders   | downstream; one shared field                          | `ShopOrder` field `countedAt` (the vocabulary's "counted order")                |
| everything | platform | uses the dialect                                      | ids (`Shop`, `ShopGid`, `EpochMillis`), `ShopLimits`, `ShopSession`, connection |

Nothing outside `src/lib/domain/` imports a context file directly; it imports `@/lib/Domain`, as all 88 importers do today.

## Phase 1: the map at the top of `Domain.ts`

Goal: the header says what the contexts are and how they relate, and nothing else that a context file will carry.

1. In `src/lib/Domain.ts`, the JSDoc that begins `/**\n * Vocabulary.` keeps its first paragraph and the entry test (the "What a word must pass to get a row" bullets), and its `Contexts.` table becomes the map: the four rows above, with a fourth column `kind` (core, supporting, generic, dialect) and a paragraph after it that states the three relationships and their crossings in the words of the table above. Platform's row says "dialect, not a context: the technical words; no model of the business".
2. Add a `Shared words.` table after the map, introduced by a paragraph whose first line starts with `Shared words.`: one row per word two contexts share, with columns `word`, `contexts`, `noun form`. Rows today: open (orders, production; "open order", "open run"), closed (orders, production), cancel (orders, production), start (production only, two senses: `startTask`, `workflowStartsRun`; row it so the sense is on record). Move the shared-word prose that follows the run-state and order-position tables into this table's paragraph and delete the copies.
3. The `Screens.` table stays in the header; it is a cross-context index.
4. Everything else in the header (the nouns table, billing table, run states, task states, workflow states, order positions, order issues, verbs, and the prose between them) stays where it is until Phase 2, which moves each to its context file. Do not move any of it now.
5. `scripts/lib/spec.ts`: `checkContexts` accepts `Shared words.` as a table with a `contexts` column and requires every context it names to be a row of the map. Add `kind` to the map's required columns.
6. `AGENTS.md` line 8 says: "The map at the top of `src/lib/Domain.ts` names the contexts and what each may import; each context's vocabulary is at the top of its file under `src/lib/domain/`." Write it now even though the files arrive in Phase 2; the same change lands both in the reviewer's eyes.

Done when: `pnpm spec check` passes with the map and shared-words tables parsed, and `git diff src/lib/Domain.ts` shows only the header changed.

## Phase 2: the barrel and the four files

Goal: one file per context, each opening with its own vocabulary; `Domain.ts` re-exports all four; no importer changes.

1. Create `src/lib/domain/Platform.ts`, `Orders.ts`, `Billing.ts`, `Production.ts`. Move every export of `Domain.ts` into one of them by the table below. Move each symbol's JSDoc with it, unchanged. Keep the order of symbols inside a file the same as in `Domain.ts` so the diff is readable.
2. `src/lib/Domain.ts` becomes the map header (Phase 1) followed by:

   ```ts
   export * from "./domain/Platform";
   export * from "./domain/Orders";
   export * from "./domain/Billing";
   export * from "./domain/Production";
   ```

   A duplicate export name fails typecheck. That is intended: it is the polyseme check. If it fires, the two symbols are one concept with two homes or two concepts with one name; fix the name by the vocabulary's shared-word rule, never by renaming one at random.

3. Each context file opens with `/**\n * Vocabulary, <context>.` and carries the tables and prose for its words, moved from the header:

   | file       | tables moved from the header                                                                                                                                                                                      |
   | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Production | nouns rows with context production (merchant, member, team, workflow, step, run, task, block, note, draft, view), run states, task states, workflow states, order positions, order issues, verbs, and their prose |
   | Orders     | nouns rows with context orders (order, item)                                                                                                                                                                      |
   | Billing    | the billing table and its prose                                                                                                                                                                                   |
   | Platform   | nouns rows with context platform (shop, import, sync, ceiling)                                                                                                                                                    |

   The nouns table's `context` column goes away: the file is the context. A row that names two contexts ("view": production and orders) goes to Production with a sentence saying the orders index reads it too.

4. Where a symbol goes. The line numbers are `Domain.ts` at commit e803d97; the split is by the block, not by hand-picking:

   | lines     | block                                                                                                                                                                                                                                                    | file                                                                                                        | notes                                                                                                         |
   | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
   | 262–420   | `TaskState`, `taskStateOf`, every `*_LABEL`, `Verb`                                                                                                                                                                                                      | Production                                                                                                  | labels are production words, including `ORDER_POSITION_LABEL`, `ORDER_ISSUE_LABEL`, `ORDERS_INDEX_VIEW_LABEL` |
   | 422–434   | `Shop`, `ShopGid`, `ShopAgentId`, `SessionId`                                                                                                                                                                                                            | Platform                                                                                                    |                                                                                                               |
   | 450–587   | `PlanHandle`, `Plan`, `Entitlements`, `PlanStatus`, `AppSubscription`, meters                                                                                                                                                                            | Billing                                                                                                     |                                                                                                               |
   | 589–650   | `ShopSession*`                                                                                                                                                                                                                                           | Platform                                                                                                    | its `plan` fields reference Billing types: see 6 below                                                        |
   | 661–731   | `Email`, `UserId`, `UserRole`, `userIsAdmin`, `User`, `AuthSession`, `SessionContext`, `LoginInput`                                                                                                                                                      | Platform                                                                                                    | auth is generic                                                                                               |
   | 743–888   | `MemberId`, `Member`, `TeamId`, `TeamName`, `Team*`, `MemberAccess`, `MemberTeam`, `WorkflowId`, `WorkflowTaskId`                                                                                                                                        | Production                                                                                                  |                                                                                                               |
   | 896–956   | `WorkflowLimits`, `ShopLimits`, `retentionCutoff`                                                                                                                                                                                                        | Platform                                                                                                    | ceilings are the object's; the nouns they count are numbers here, no import needed                            |
   | 959–1236  | `ShopUsage`, billing cycle, `UsageEvent`, `usageEventIsExpired`, `cycleAtOrderCeiling`, `membersAtCeiling`, `seatEventValue`, `meterDiverges`, `RecordMemberCountInput`                                                                                  | Billing                                                                                                     | the triggers table moves with `ShopUsage`; `cycleAtOrderCeiling` imports `ShopLimits` from Platform           |
   | 1239–1962 | names, `Workflow*`, `WorkflowDraft*`, task inputs, results, `Team*Result`, `AssignRunTaskTeam*`                                                                                                                                                          | Production                                                                                                  |                                                                                                               |
   | 1964–1972 | `ShopSessionRedactedPage`                                                                                                                                                                                                                                | Platform                                                                                                    |                                                                                                               |
   | 1979–2345 | `OrderSyncSource`, `EpochMillis`, `LineItemProperty`, `ShopOrder`, `OrderLineItem`, `orderCanCreateRuns`, `orderIsCancelled`, `orderIsFulfilled`, `OrderState`, `orderIsOpen`, `unitsToMake`, `OrderDetail`, seed types, `SyncState`, `OrdersSyncStatus` | Orders                                                                                                      | `EpochMillis` goes to Platform                                                                                |
   | 2380–2530 | `OrderPosition`, `OrdersIndexView`, `OrderIssue`, `OrdersCursor`, `OrderSearch`, `normaliseOrderSearch`                                                                                                                                                  | Production                                                                                                  | positions, issues and views are production words                                                              |
   | 2550–2600 | `ListOrdersInput`, `SubscribeOrdersInput`, `ResyncOrderInput`                                                                                                                                                                                            | Orders                                                                                                      | list and resync are about the synced order                                                                    |
   | 2611–2832 | `RunCounts`, `OrderRow`, `orderPosition`, `orderIssues`, `ORDER_ISSUE_TONE`, `ambiguousItems`, `runCounts`, `OrderCounts`, `OrdersPage`, `GetOrderDetailInput`, `SubscribeOrderInput`                                                                    | Production                                                                                                  | production's reading of an order (decision 3)                                                                 |
   | 2855–2918 | `BulkOperation*`, `bulkOperationCompleted`, `OrdersSyncResult`, `OrdersIndexData`                                                                                                                                                                        | Orders                                                                                                      | `OrdersIndexData` references `OrderRow`: see 6 below                                                          |
   | 2935–3000 | `AdminShopPlanCache`, `adminShopPlanCache`, `adminShopEntitlements`                                                                                                                                                                                      | Billing                                                                                                     |                                                                                                               |
   | 3004–3122 | `*LoaderData`                                                                                                                                                                                                                                            | the page's context: `LoginLoaderData` to Platform, `AdminShopLoaderData` to Billing, the rest to Production | see 6 below                                                                                                   |
   | 3167–3357 | `Subscription`, `SubscriptionState`, `ConnectionRole`, `*ConnectionState`, `CONNECTION_*`, `RevokeMemberConnectionsInput`, `SubscriberIdInput`, `InvalidatedMessage`, `AgentMessage`, keepalive                                                          | Platform                                                                                                    | the socket is platform                                                                                        |
   | 3212–3264 | `Actor`, `MemberActor`, `ActorDisplay`, `actorLabel`, `actorIsMember`                                                                                                                                                                                    | Production                                                                                                  | merchant and member are production words; `runActions` reads it                                               |
   | 3359–4790 | `RunId`, `RunTaskId`, `RunStatus`, `ClosedReason`, run predicates, `Run`, `RunTask`, lists, views, `currentTasks`, `reopenBlockedBy`, `runActions`, `taskActions`, `LineItemState`, `lineItemState`, inputs, commands, results                           | Production                                                                                                  | the matrices move with their symbols                                                                          |

5. Imports between context files are named imports of what the file uses (`import { ShopOrder, orderIsOpen } from "./Orders"`), never `import *`. `{@link}` in moved JSDoc keeps working for imported names; a `{@link}` to a symbol the file does not import is turned into an import if the file uses the symbol, or into backticks plus the context's name in prose if it does not ("`orderIsOpen` in Orders").
6. Where the table sends a symbol against the map's direction, that is a finding, not a placement. Known cases, and what to do:
   - `ShopSession` (Platform) caches the plan as `planHandle: Schema.String`, deliberately not `PlanHandle`, so no Billing import is needed; its JSDoc's `{@link PlanHandle}` becomes backticks ("`PlanHandle` in Billing"). Already conformist; nothing to decide.
   - `OrdersIndexData` (Orders) references `OrderRow` (Production). It is the orders index's page data, which shows positions: move it to Production beside `OrdersPage`.
   - `MemberConnectionState` (Platform) carries `MemberId`, `Email` and `TeamId`; `MerchantConnectionState` and `ConnectionState` are its siblings. Platform may not import Production. Move the three connection-state schemas to Production (the roles merchant and member are production words); `Subscription`, `ConnectionRole` and the header constants stay in Platform, which Production imports.
   - `AdminShopLoaderData` reads `ShopSessionRedacted` (Platform), `AdminShopPlanCache` and `Entitlements` (Billing): it goes to Billing, not Platform.
   - Any other case: stop, write it under Deviations with the two options, and pick the one that keeps the direction. Never add an allowed edge to the map to make a placement compile.
7. Tooling that reads `Domain.ts` by path:
   - `scripts/spec.ts`: `DOMAIN` becomes the five files. `checkVocabulary` runs per context file against that file plus the barrel; `checkScreenColumns`, `checkOrderIssues`, `checkContexts`, `checkScreens` run against the file that holds the table (the map and Screens in `Domain.ts`; the state and verb tables in `Production.ts`); `parse` for `runActions` and `taskActions` and `parseTriggerTable` read `Production.ts` and `Billing.ts`. The anchor `"/**\n * Vocabulary."` matches `"/**\n * Vocabulary, production."` by prefix; make the anchor a regex `^/\*\*\n \* Vocabulary[.,]`.
   - `test/integration/run-actions.test.ts` imports `@/lib/domain/Production.ts?raw`. `test/integration/spec.test.ts` imports each file it checks.
   - `scripts/vocab-audit.ts` reads the five files for the vocabulary.
   - `scripts/rules-lint.ts`: `ALLOWED` (the files that may spell a status literal) becomes `lib/Domain.ts` plus `lib/domain/`. Its JSDoc says so.
   - `docs/vocabulary-runbook.md` line 3 and step 3 ("write the row first, in the table of the word's context") say the row goes in the context's file under `src/lib/domain/`, and the map in `Domain.ts` gains a shared-words row when a word crosses.
   - `AGENTS.md` lines 4 and 6 name `src/lib/domain/Production.ts` for the matrices and `src/lib/domain/Billing.ts` for the triggers table.
8. Nothing under `src/routes/`, `src/components/`, `src/lib/*Repository.ts` or `src/lib/ShopAgent.ts` changes. If typecheck says otherwise, a symbol was renamed or dropped; put it back.

Done when: `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; `git diff --stat` shows no file outside `src/lib/Domain.ts`, `src/lib/domain/`, `scripts/`, `test/integration/{spec,run-actions}.test.ts`, `AGENTS.md` and the runbook; `wc -l src/lib/domain/*.ts` is recorded in Deviations (expected roughly Production 3,000, Orders 400, Billing 400, Platform 700).

## Phase 3: the seam is one-way

Goal: `Orders.ts` imports nothing from `Production.ts`, and the production reading of an order is visibly in Production.

1. `grep -n "from \"./Production\"" src/lib/domain/Orders.ts` returns nothing. Where it does, the symbol is production's (move it) or the reference is prose (`{@link}` to backticks).
2. `grep -n "from \"./Production\"\|from \"./Billing\"\|from \"./Orders\"" src/lib/domain/Platform.ts` returns nothing.
3. `grep -n "from \"./Production\"" src/lib/domain/Billing.ts` returns nothing. Billing's one crossing is `ShopOrder` from Orders, for `countedAt`.
4. On `orderPosition`, `orderIssues` and `lineItemState` in `Production.ts`, the JSDoc's first line says it is production's reading of an order and names the Orders symbols it reads (`orderIsOpen`, `unitsToMake`). One sentence each; do not restate the rules.
5. `test/integration/spec.test.ts` gets one test titled "the orders context imports nothing from production", asserting the three greps above on the raw sources. It is the pinned test for the map's direction until Phase 4 makes it a lint.

Done when: the test passes and no other test changed.

## Phase 4: the import direction is a lint

Goal: `pnpm lint` refuses an import the map does not allow, and a deep import from outside `domain/`.

1. `scripts/lib/rules-lint.ts` gains `contextImportHits(file, source)`: for a file under `src/lib/domain/`, every `from "./X"` must be in the map's `may import` column for that file (the table at the top of this plan, written as a constant with the map's JSDoc). For any other file under `src/`, `from "@/lib/domain/…"` or a relative path into `domain/` is refused: the barrel is the public surface.
2. `scripts/rules-lint.ts` runs it and prints `rules-lint: <file> imports <X>; the map in src/lib/Domain.ts allows <list>` and `rules-lint: <file> imports a context file directly; import @/lib/Domain`.
3. `test/integration/rules-lint.test.ts` gets cases: Orders importing Production is refused; Production importing Orders is allowed; a route importing `@/lib/domain/Production` is refused; Platform importing anything under `domain/` is refused.
4. Phase 3's grep test is deleted; the lint's test titles replace it.
5. `AGENTS.md` line 8 gains: "`scripts/rules-lint.ts` refuses an import against the map's direction and a direct import of a context file from outside `src/lib/domain/`."

Done when: `pnpm lint` passes on the tree and each new test case passes.

## Not in this plan

- Splitting `…Input`, `…Result`, `…LoaderData`, `…Command` out of the context files (decision 5: later).
- Splitting `ShopAgent.ts` by context.
- Any rename, any rule change, any table edit beyond the map and shared-words tables in Phase 1.

## Deviations and issues

Implemented 2026-09-30, all four phases, uncommitted.

**Line counts.** `Domain.ts` 131, `Production.ts` 3,452, `Orders.ts` 260, `Billing.ts` 578, `Platform.ts` 474. Orders is smaller and Billing and Platform larger than expected, because of the moves below.

**Phase 1.**

- The map keeps the `Contexts.` intro so `checkContexts` still finds it. Columns: `context`, `kind`, `about`, `whose words`, `file`, `may import`. `Domain.ts` is not a row: its row would have made "all" a context. The prose above the table says the barrel re-exports the four.
- `workflowStartsRun` does not exist. The `start` row names `StartTaskInput` (the verb, since `startTask` is not in `Domain.ts`) and `workflowIsEligible` (a workflow creates a run; "starts" is merchant copy only).
- The entry test's shared-word bullet now points at the Shared words table; the `<noun>Is<State>` wording moved into the table's paragraph. The "open is `orderIsOpen`" sentence after Order positions moved there too.
- `checkContexts` exempts the Shared words table from the names-its-context rule and checks its `contexts` cells against the map instead. New test: "a map with no kind column, and a shared word in a context outside the map, are reported".

**Phase 2: placements against the map's direction** (the plan's "any other case"). Each one was settled by picking the option that keeps the direction:

| symbol                                                                                                | table said                   | problem                                                                                         | options                                                    | chosen                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowId`                                                                                          | Production                   | `OrderLineItem.matchedWorkflowIds` needs it; Orders may not import Production                   | move the id to Platform; or type the field `Schema.String` | reviewed 2026-09-30: `Schema.String`, the `planHandle` precedent. The field is production's writing on the orders row; `WorkflowId` is back in Production                                                            |
| `SeedProgressFields`, `doneAndAdvanceExclusive`, `SeedProgress`, `SeedOrderChange`, `SeedOrdersInput` | Orders                       | they seed runs, blocks and members (`BlockReason`, `MemberId`)                                  | move to Production; or split each schema                   | Production: they describe production state                                                                                                                                                                           |
| `ListOrdersInput`, `SubscribeOrdersInput`                                                             | Orders                       | read `OrdersIndexView`, `OrderSearch`, `OrdersCursor`, `TeamId`                                 | move to Production; or move the view types to Orders       | Production, beside `OrdersPage`: the orders index's inputs speak positions and views. `ResyncOrderInput` stays in Orders                                                                                             |
| `AppIndexLoaderData`                                                                                  | Production                   | reads `Entitlements`, `ShopUsage`; Production may not import Billing                            | Billing; or add an edge                                    | Billing: every field is billing's                                                                                                                                                                                    |
| `OrdersIndexLoaderData`                                                                               | Production                   | reads `OrdersIndexData` (Production) and `ShopUsage` (Billing); no context file may import both | define it in the barrel; or add an edge                    | the barrel, `Domain.ts`, below the `export *` lines: the one cross-context page shape. It uses `import type` from two context files. Reviewed 2026-09-30: kept, and the map's paragraph now says the barrel holds it |
| `SqliteBoolean`, `BoundedId`                                                                          | not listed (private helpers) | used by Platform, Orders and Production                                                         | export them from Platform; or duplicate them               | exported from Platform, so the barrel gains two exports                                                                                                                                                              |

**Phase 2: other deviations.**

- Relative imports carry `.ts` (`./Platform.ts`, `./domain/Orders.ts`): `scripts/spec.ts` imports `Domain.ts` under Node's type stripping, which does not resolve extensionless paths.
- The `import` and `sync` rows are platform words whose symbols (`OrdersSyncResult`, `SyncState`, `OrdersSyncStatus`, `OrderSyncSource`) the plan puts in Orders. First landed as a "Nouns, platform" table inside `Orders.ts`; reviewed 2026-09-30: the words are orders words, not platform's. Both reach a screen (Import open orders, Resync from Shopify) and a dialect word never does; their meanings are about orders; nothing outside orders reads the symbols. The two rows joined Orders' nouns table and the four symbols stayed in `Orders.ts`; the map does not change.
- Billing imports only from Platform. It does not import `ShopOrder`, because no Billing code uses it; the counted order's `countedAt` is named in prose and in the map.
- A `{@link}` rewritten as "`X` in Production" was checked by `checkVocabulary` against the barrel and failed on one line ("`Subscription` in Platform" in Billing's prose). `checkVocabulary` now takes the context files by name and checks a word written as "`X` in <Context>" against that context's file. Tests: "a word written as another context's is checked against that context's file" and "Domain.ts and every context file name only words that exist".
- The first JSDoc in `Domain.ts` (the rule bullets) stays; its paragraph on action tables and lists moved to `Production.ts`, where the symbols it links are. The Vocabulary paragraph's sentence on checked screen columns moved to Production's vocabulary, since the checked tables are there.
- The test "an intro with no context, and a context cell outside the Contexts table, are reported" doctored the nouns table's `context` column, which is gone. It now doctors Production's Run states intro, and exercises a `context` cell with an inline table. The screen-column and order-issue "Domain.ts passes" tests are now "Production.ts passes".

**Phase 3.** `orderPosition` reads `orderIsCancelled` and `orderIsFulfilled`, not `orderIsOpen` and `unitsToMake`; each JSDoc names what that function reads. `lineItemState` had no JSDoc; it has one now.

**Phase 4.** The `may import` column is read out of the map in `Domain.ts` (`contextImports` in `scripts/lib/rules-lint.ts`) rather than written a second time as a constant, so the map is the one copy. The barrel is exempt. Tests: the five cases in `test/integration/rules-lint.test.ts`, plus "the map in Domain.ts reads as each context file's allowed imports" and "the barrel re-exports the context files".
