# Plan: workflows (slice E)

Implements `docs/workflows-research.md` (settled 2026-10-18, Q1–Q15) under `docs/legacy-port-research.md` §0.1 (A1–A3) and §0.2 (naming by role). Read the research's §0, §1.0, §1.3 and §4 first; this plan does not restate the reasons.

Legacy paths are relative to `refs/baton-legacy/`.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; the JSDoc rules (no `//` above a declaration, no reference to this plan, the research or any `docs/` file in code); the logging and SQL rules; layout only in parts under `src/web/components/screen/`.
- Work on `main` in the main checkout. Commit at the end of each green step. Stage paths explicitly; never `git add -A` or `git commit -a`.
- Each step ends green: `vp check`, `vp test` (unit, browser, integ) and `vp run test:e2e`. A step that cannot end green is recorded in §7 before moving on.
- A step that adds or deletes a route under `src/web/routes/` regenerates `src/web/routeTree.gen.ts` (`vp build`) before `vp check`.
- No table changes: `migrations/0001_init.sql` and the actor's `0001_init` stay as they are. Never `db:reset` the `staging` stage, `cloud:reset` or `alchemy deploy`; touch the `dev` stage only by running the dev server.
- Names follow §0.2 of the roadmap: storage is `<Area>Repository`; an area's application service takes the area's bare name; nothing is called an agent. "Workflow" alone is the product's definition; Cloudflare's is the orders sync Workflow.
- Each callable lands as the research's §1.3 table says, and nothing else: three first-render reads are server functions → Backend → stub method (and D1 for the setup facts); every workflow write is a `Merchant…` procedure answering legacy's result union as its success, with no declared error; no new `DevRpcs` or `IntegRpcs`.
- **No `MembershipRepository` (D1) call inside a `transaction(…)`.** Read the live teams first, then call the repository.
- Legacy is the spec, not the source. Keep legacy's method names (but Q10's), test titles (byte for byte), copy, page sizes and part names. Port SQL and JSDoc rules verbatim, lowercase.
- Do not rewrite the steps. Record what you built differently, and what surprised you, in §7 as you go.
- The integ suite leaks `.alchemy/local/baton-test-…-ShopActor` directories; delete the ones your runs create.

## 1. Outcome

- The merchant's embedded admin has Workflows (`/app/workflows`, `/app/workflows/$workflowId`, `/app/workflows/$workflowId/edit`), as legacy's: the index with paging, filter and search; Create, Rename, Duplicate, Edit tag, Delete; the switch; the draft editor with every task write, Apply, Discard and Turn on; the editor in an App Bridge window (or, if Step 6's check fails, as a page only, recorded); Workflows in the App nav.
- `Workflow` rows are read and written in the actor through `WorkflowRepository`, with legacy's rules; the shop's live teams come from D1 through `MembershipRepository.listTeams`.
- Deleting a team nulls every workflow, draft and run task pointer to it and repairs pointers to teams already gone; the reconcile seam is called where legacy reconciles; `ORDERS_KEY` is notified at legacy's publish sites.
- App Home shows legacy's setup guide while any of its three facts is false.
- `/dev/kit` renders every screen part with worst-case data on the `dev`, `test` and `e2e` environments, and is not found on staging.
- The naming of §0.2 holds across the Backend and the actor; the glossary carries it.

## 2. What this plan rests on

- **The actor's repositories over its SQL client.** `makeOrderRepository(sql, transaction)` with `syncTransaction(sql)` (`src/backend/shop-actor.ts`); unit tests build them over `ActorSqliteTest` (`test/unit/backend/layers.ts`), migrated by the actor's own `migrations`.
- **The actor yields Backend services** in its outer phase (`ShopSessions`, `Members`, `ShopifyAdmin`, `OrdersSyncWorkflow`), provided where `backendBody` yields `ShopActor`.
- **Stub reads from the Backend.** `BackendApi.listOrders` → `installedShop(sessionToken)` → `ShopActors.listOrders` → the actor's `listOrders` (`src/backend/api.ts`, `shop-actors.ts`); the server function in `src/web/server/orders.ts`.
- **The forged merchant socket** (`openAs` in `test/integ/actor-clients.ts`) calls `MerchantRpcs` in integ; `addToFixture` there passes workflows once a test gives them.
- **The domain is ported.** Every workflow schema, input, result union, `SetupFacts` and `WorkflowLimits` exists (`src/domain/shop-work.ts`, `platform.ts`). Do not redefine any.
- **The screens' patterns** from slice C: mutation atoms over procedures, answers read with `mode: "promiseExit"`, `router.invalidate({ sync: true })` after a write, `thrownCopy` for a lost socket or defect, `appHref` on every `/app` link, `-search-params.ts`, `-table-pages.ts`.
- **Unproven**, checked first where needed: `node:sqlite` running the repository's `json_each` / `json_extract` SQL as the DO does (Step 2); App Bridge's `s-app-window` with this repo's guards and a `BroadcastChannel` to the opener (Step 6).

## 3. Names and constants

| Name                                                                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MembershipRepository` (`src/backend/membership-repository.ts`)            | Today's `Members`, renamed (Step 1); gains `listTeams({ shop })` (every team with `memberCount`, legacy `Repository.listTeams`) and `teamWithMemberExists({ shop })` (legacy's one `exists`).                                                                                                                                                                                                                                                                                                                                                                                           |
| `ShopSessionRepository` (`src/backend/shop-session-repository.ts`)         | Today's `ShopSessions`, renamed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `OrdersBulkOperation` (`src/backend/orders-bulk-operation.ts`)             | Today's `OrdersBulkRepository`, renamed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `makeOrderRepository` (`src/backend/shop-actor/order-repository.ts`)       | Moved from `shop-actor/orders.ts`, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `makeOrders` (`src/backend/shop-actor/orders.ts`)                          | Today's `makeOrdersAgent`; its `workflows` parameter (the orders sync Workflow's handle) becomes `ordersSync`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `makeMembership` (`src/backend/shop-actor/membership.ts`)                  | Today's `makeMembersAgent`; gains `workflows` (the repository), `reconcileAll`, `notify` (Step 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `WorkflowLayout` (`src/domain/workflow-layout.ts`)                         | Legacy `WorkflowLayout.ts` verbatim: `Placed`, `Layout`, `normalize`, `append`, `appendTask`, `move`, `join`, `separate`, `remove`, `stepsOf`. Imported as `import * as WorkflowLayout`.                                                                                                                                                                                                                                                                                                                                                                                                |
| `makeWorkflowRepository` (`src/backend/shop-actor/workflow-repository.ts`) | Legacy `WorkflowRepository` over `(sql, transaction)`, every method but `replaceWorkflows`; `ACTIVE_WORKFLOWS_BY_TAGS`; errors `WorkflowRepositoryError` (or `orDie`, as the order repository decides decode failures), `WorkflowNotFoundError`, `WorkflowTagTakenError`, `WorkflowNameTakenError`, `TaskNotFoundError`, `StepNotFoundError`, `WorkflowLimitError`, `NoDraftError`, `NoTasksError`, `TaskUnassignedError`, beside it (they never cross a boundary: the procedures answer unions).                                                                                       |
| `makeWorkflows` (`src/backend/shop-actor/workflows.ts`)                    | `makeWorkflows({ repository, membership, reconcileAll, notify, shop })`: legacy `agent/ShopWork.ts`'s workflow handlers and result mappers, `teams()`, `teamExists`, `reconcileAllIfActive`; one method per procedure, plus `listWorkflows`, `getWorkflowDetail`, `workflowSetupFacts`. `membership` is the D1 repository.                                                                                                                                                                                                                                                              |
| `reconcileAll`                                                             | `(caller: string, id: string) => Effect<void>`; the actor passes `Effect.void` until F.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Procedures                                                                 | `MerchantCreateWorkflow`, `MerchantDuplicateWorkflow`, `MerchantUpdateWorkflow`, `MerchantUpdateWorkflowTag` → `WorkflowResult`; `MerchantApplyDraft` → `ApplyResult`; `MerchantDiscardDraft` → `DiscardResult`; `MerchantSetWorkflowState`, `MerchantApplyAndTurnOn` → `SwitchResult`; `MerchantDeleteWorkflow` → `DeleteWorkflowResult`; `MerchantAddStep`, `MerchantAddTask`, `MerchantUpdateTask`, `MerchantMoveTask`, `MerchantSeparateTask`, `MerchantJoinTask`, `MerchantRemoveTask` → `TaskResult`. Payloads are the domain's inputs (`CreateWorkflowInput`, …, `TaskIdInput`). |
| Stub methods                                                               | `listWorkflows(input)` → `WorkflowsIndexData`; `getWorkflowDetail({ workflowId })` → `WorkflowPageData \| null`; `workflowSetupFacts()` → `WorkflowSetupFacts`; on `ShopActorShape` and `ShopActors`.                                                                                                                                                                                                                                                                                                                                                                                   |
| Loader methods                                                             | `BackendApi.workflowsPage`, `workflowDetail`, `setupFacts`, each over the merchant's session token, `ShopNotInstalled` with no `ShopSession`; server functions in `src/web/server/workflows.ts` and `src/web/server/home.ts`.                                                                                                                                                                                                                                                                                                                                                           |
| `WORKFLOWS_PAGE_SIZE`                                                      | 50.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Routes                                                                     | `src/web/routes/app.workflows.tsx` (layout), `app.workflows.index.tsx`, `app.workflows.$workflowId.tsx`, `app.workflows.$workflowId_.edit.tsx`; `dev.kit.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Components                                                                 | `WorkflowSteps` (`StepFlow`, `TaskCard`, `TeamLine`, `TeamFaultBanners`), `WorkflowSwitch`, `WorkflowTag` under `src/web/components/`; `workflowShared` copy and helpers and `workflowEditorWindow` under `src/web/` beside their callers.                                                                                                                                                                                                                                                                                                                                              |
| Parts                                                                      | `Fields`, `PageNote`, `Panel`, `EmptyAside`, `FootLine`, `Connector`, `Prose` (with its `.prose` CSS), `SelectableCard`, `SetupGuide` under `src/web/components/screen/`, each with its `Screen.ts` row as JSDoc.                                                                                                                                                                                                                                                                                                                                                                       |
| Helpers                                                                    | `retainSearchParamsUnder` in `src/web/routes/-search-params.ts`; `DELETED_TOAST.workflow` in `src/web/components/teams.ts`; the element-based `hideModal` / `showModal` (legacy `polarisModal.ts`) beside `src/web/client/app-bridge.ts`.                                                                                                                                                                                                                                                                                                                                               |

## 4. Steps

### Step 1: Naming

- The renames of §3's first six rows (§0.2 of the roadmap): files, symbols, `Effect.fn` names, log operation prefixes (`MembersAgent.deleteTeam:` → `Membership.deleteTeam:`, and so on), JSDoc `{@link}`s, test files and their describe names (`test/unit/backend/members.test.ts` → `membership-repository.test.ts`, `shop-actor/members-agent.test.ts` → `membership.test.ts`, `orders-agent.test.ts` → `orders.test.ts` after the order repository's test moves to `order-repository.test.ts`, …). Legacy test titles stay byte for byte. No behaviour change.
- `docs/glossary.md`: **Repository**, **Application service**, **Area** (orders, membership, workflows, runs), the workflow vs orders sync Workflow rule; the **Handler** entry says a handler decodes and dispatches to an application service; the source-layout row for `src/domain/` names `workflow-layout.ts`.
- Verify: green, e2e included; `grep -rn "Agent\b" src test` finds only legacy references in JSDoc, if any; `grep -rn "Members\b\|ShopSessions\b\|OrdersBulkRepository" src test` finds nothing but prose that means the people.

### Step 2: Layout and repository

- **Check first.** Port `makeWorkflowRepository`'s `editDraft`, `listWorkflows` and `unassignTeam` and run three legacy tests over `ActorSqliteTest`: "the first editor write on a task the workflow holds creates the draft and edits the same task id", "the workflows index pages by name and a search narrows it", "unassignTeam nulls the team on both sides". Record the result in §7. **If `node:sqlite` diverges** (a `json_each` join, a multi-statement call): record it, keep each `sql` call one statement (the migrations' rule), and if a query still diverges run the repository tests in integ through the actor (one `IntegRpcs` procedure per method family on the test Backend). Continue either way.
- `src/domain/workflow-layout.ts` from legacy, with its JSDoc; `vite.config.ts` gets `domainBoundary("src/domain/workflow-layout.ts", ["shop-work.ts"])` and lets `shop-work.ts` import it if its JSDoc links need to (otherwise backticks).
- The rest of `makeWorkflowRepository` (§3), SQL lowercase, legacy's JSDoc. Its transactions go through the `transaction` argument.
- `MembershipRepository.listTeams` and `teamWithMemberExists`, legacy's SQL.
- Tests. Unit: legacy `workflow-layout.test.ts` (nine titles); legacy `workflow-repository.test.ts` over `ActorSqliteTest`, titles unchanged, but the four `replaceWorkflows`/seed tests and "copyName" (Step 5); the query-plan test for `ACTIVE_WORKFLOWS_BY_TAGS`; legacy `data-model.test.ts`'s "a workflow is identified by its tag and by its name; no two workflows share either; the name is compared exactly"; `listTeams` and `teamWithMemberExists` on the D1 adapter with legacy `setup-facts.test.ts`'s "a team with no member does not complete the first step" and "the D1 fact ignores another shop's team".
- Verify: green.

### Step 3: Application service, procedures, team delete

- `makeWorkflows` (§3) from legacy `agent/ShopWork.ts`: the result mappers, `teams()` over `MembershipRepository.listTeams` read before any repository call, `teamExists`, each handler, its log line (`Workflows.<method>: shop=<shop> workflowId=<id>…`), `reconcileAll` where legacy calls `reconcileAllNow` / `reconcileAllIfActive` (the research's §1.3 column), `notify([ORDERS_KEY])` where legacy publishes (on `Ok`; delete on `Deleted`). `Workflows.deleteWorkflow` is legacy's `removeWorkflow` (Q10).
- The actor yields nothing new; it builds the repository and `makeWorkflows` once per activation, `reconcileAll: () => Effect.void`, and its handlers map the fifteen procedures. `src/contract/shop-actor.ts`'s `MerchantRpcs` gains them with the domain's payloads and unions.
- `Membership.deleteTeam`: after the D1 delete (or `NotFound`), `teamIdsInUse`, then `listTeams`, then `unassignTeam` for the team and every in-use id gone from D1, then `reconcileAll("deleteTeam", teamId)`, then the closes, then `notify([ORDERS_KEY])` on both answers. Replace the seam sentence in its JSDoc with legacy's `deleteTeam` reasoning (D1 first, the next delete repairs, ids in use read before teams).
- Tests. Unit (`test/unit/backend/shop-actor/workflows.test.ts`): `makeWorkflows` over the repository on `ActorSqliteTest`, `MembershipRepository` on the D1 adapter, a recording `reconcileAll` and `notify`: legacy "addTask and separateTask map missing step / task / team to results"; the non-run half of "createDraft / applyDraft / discardDraft / setWorkflowState / updateWorkflowTag map failures to results" (createDraft through the repository); reconcile recorded exactly at §1.3's sites (Apply and Edit tag only when active); a notice only on `Ok`. `membership.test.ts`: legacy "deleteTeam nulls every task pointer, D1 first; a dangling id reads as unassigned and a retry repairs it" and "the next team delete nulls pointers to a team that is already gone". Integ (`test/integ/workflows.test.ts`): every procedure over a forged merchant socket; legacy "addStep refuses an unknown team, accepts an existing one", "applyAndTurnOn promotes the draft and turns the switch on in one call; an empty workflow is refused", "a task whose team was deleted resolves teamName null; removeWorkflow takes the definition and its draft", "createWorkflow and updateWorkflowTag refuse a tag another workflow holds; the switch never does", "callable inputs reject excess properties"; the two publish titles ("Edit tag and Apply publish to every screen whether or not a run moved; a refused call publishes nothing", "turning a workflow on or off, deleting it, or deleting a team publishes to every screen; a refused call publishes nothing") read as an `ORDERS_KEY` notice on a second merchant socket; a forged member socket refused all fifteen with `Forbidden`.
- Verify: green.

### Step 4: Loaders

- Stub methods `listWorkflows`, `getWorkflowDetail`, `workflowSetupFacts` on the actor, `ShopActorShape` and `ShopActors`.
- `BackendApi.workflowsPage`, `workflowDetail`, `setupFacts` (§3): token, `ShopNotInstalled` before any actor or D1 call; `setupFacts` runs `MembershipRepository.teamWithMemberExists` and `ShopActors.workflowSetupFacts` together. Request schemas in `src/contract/workflows.ts`, decoded leniently from the URL as legacy (`lenientSearchKey`, `ListSearchParam`). Server functions in `src/web/server/workflows.ts` and `src/web/server/home.ts`.
- Tests. Unit (`api.test.ts`): each method, a bad token refused, no session → `ShopNotInstalled` and no actor call. Integ: each with a signed merchant token over `addToFixture` workflows (index paging by name and search; detail with team names; setup facts on an empty shop and after a team with a member and an active workflow).
- Verify: green.

### Step 5: Index and workflow page

- Parts and helpers of §3 the two pages use, with legacy's JSDoc and `Screen.ts` rows. `workflowShared` (`suggestedTag`, `tagCommaError`, `copyName`, the messages, blockers, dialog copy, `TAG_HELP`).
- `WorkflowSteps`, `WorkflowSwitch`, `WorkflowTag` from legacy; each write a mutation atom over its procedure; the answer's union drives the copy; anything thrown → `thrownCopy`.
- `/app/workflows` layout (search `state`, `q`, `after`, retained under `/app/workflows`; `PAGE_KEYS` in `-app-search.ts` handles them so a nav click drops them), index (50 per page, filter press-buttons, search, badges, columns, Create modal; on `Ok` it navigates to the editor page until Step 6 opens the window), workflow page (trigger card, `TeamFaultBanners`, switch, Edit, More actions: Rename, Duplicate, Delete; toasts "Workflow renamed", "Workflow duplicated", "Workflow deleted").
- `AppNav`: Home, Orders, Workflows, Teams, Members.
- Tests. Unit: `workflowShared` with legacy's "suffixes the name and trims the base to fit the 64-character limit". Browser: `SelectableCard`, `WorkflowSwitch` and `WorkflowTag` states from in-memory procedure answers (`test/browser/shop-actor.ts` gains the procedures). e2e (`test/e2e/embedded/workflows.spec.ts`, data by `AddToFixture`, names from the test id): legacy "creating a workflow with a taken tag is refused under the field and names the holder", "duplicate asks for a name and a tag, and the new workflow is inactive with the given tag", "editing the tag from the detail page writes immediately and starts no draft", "the workflows index keeps its filter across the workflow page", "the workflow page raises Needs a team as its one banner and marks an empty team's step No members", "the workflows index searches by name and clears back to the list". Specs assert only on their own rows (the e2e store is shared).
- Verify: green.

### Step 6: Editor, then the window

- The editor route as a page (`/app/workflows/$workflowId/edit`, `chrome` search param): canvas `draftTasks ?? tasks`, selection, the aside, the arrangement buttons, Add step and Add task, the no-teams line, Apply (confirm only when active), Discard, Turn on (`MerchantApplyAndTurnOn` when never applied), Rename, Delete; legacy's copy; every task write sets the banner and invalidates. Duplicate lands here.
- **Check first, on the dev store** (`vp run dev`, the Chrome DevTools MCP or the Playwright CLI per `docs/playwright-cli-runbook.md`): an `s-app-window` whose `src` is the editor with `?chrome=window` and the guards' search loads without a session-token bounce, its procedures work over its own socket, and a `BroadcastChannel` message from it reaches the opener. Record what you saw. **If it fails:** Edit and Create navigate to the editor page; record it under "Issues"; skip the rest of this bullet list's window items.
- The window: `workflowEditorWindow` (`useWorkflowEditorWindow`, `postEditorWindowMessage`), the element-based `hideModal`, `applied` and `deleted` handling, Create and Edit opening it.
- Tests. e2e: legacy "a fresh workflow turns on from the editor, then edits go through the draft" and "the editor counts instructions down from 300 and refuses 501 on save", in the window if it landed (Playwright reaches the window's frame; record how), else on the page.
- Verify: green.

### Step 7: App Home and kit

- App Home: `SetupGuide` "Getting started", "n of 3 done", legacy's three steps and copy, from `setupFacts`; shown while `!setupIsComplete`; help titles wait for I (no link). The existing links stay below it.
- `/dev/kit`: legacy `dev.kit.tsx` with the sections whose parts exist, worst-case data, `?width=small|large`; not found unless the environment is `dev`, `test` or `e2e` (the environments that bind `DEV_ENDPOINT`): the cheapest gate the Website can read (a binding set in the same `Match` in `src/backend/stack.ts`, or a Backend check); record which.
- Tests. Browser: `SetupGuide` states; the kit renders without error. e2e: the App Home guide's steps on the e2e store after `AddToFixture` adds a team with a member and an active workflow (assert the steps' states, not the guide's absence).
- Verify: green.

### Step 8: Docs

- `docs/legacy-port-research.md`: §1.1's "Actor tables" row (`Workflow` read and written) and nothing else; the orchestrator updates §3.
- `CHECKPOINT: ready for staging (<commit>)` under §7 "Command results". The orchestrator runs staging (`deploy:staging`, no reset: no table changed).
- Verify: `vp check` green.

## 5. Verification checklist

- `vp check`, `vp test`, `vp run test:e2e` green at the end; counts and times in §7.
- The fifteen procedures exist in `MerchantRpcs`; `createServerFn` in `src/web/server/workflows.ts` and `home.ts` is GET only.
- `ShopActorShape` gained exactly `listWorkflows`, `getWorkflowDetail`, `workflowSetupFacts`.
- No `MembershipRepository` call inside a `transaction(…)` (read each handler).
- Every legacy title §4 names is present byte for byte (`grep -rn` each).
- No `…Agent` symbol, no `Members`, `ShopSessions` or `OrdersBulkRepository` symbol left in `src/` or `test/`.
- The repository has no uppercase SQL keyword.
- The production bundle (`.alchemy/bundles/Backend/`) contains no `IntegRpcs` or `ShopifyFake` string.

## 6. Done when

- §1 holds on the dev stage; every step is green and committed; §7 is filled in; the `CHECKPOINT` line is written.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict. Command results go under their own heading with counts and times.

### Plan review

### Deviations

### Issues

### Command results

### Human steps requested

### Implementation review

## 8. Out of scope

- Reconcile and runs (the seam's body), the order page's Workflow select, Attach, Change and Cancel workflow, the member work list: F.
- App Home's Orders strip, plan tiles, Manage plan, quota banners: F and G.
- Help links and help pages: I. The kit's help and member-list parts: with their slices.
- `seedWorkflows`, `replaceWorkflows`: the fixture covers them.
