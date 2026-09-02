# Workflow definitions — research

Research date: 2026-09-02. Research only, not a spec.

Scope: the **definition** side of production workflows — what a merchant configures in the embedded app so that, later, a paid order's line items can be turned into work. Instantiation (paid order → running workflows → member queue) is explicitly out of scope; this doc only makes sure the definitions can be instantiated later without a rewrite.

Follows `docs/team-research.md` (teams: D1, archive-not-delete, DO rows reference `teamId` as an opaque id) and `docs/route-to-ship-tag-routing-research.md` (Route to Ship routes per line item on product tags).

## One-paragraph model

A shop has many **workflows**. A workflow has an ordered list of **steps**; each step is owned by exactly one **team**. A workflow carries a list of **product tags**. When a line item's product has any tag in a workflow's list, that line item gets **exactly one** instance of that workflow — matching two of its tags is still one match. Zero matching workflows → no work. Several matching workflows → one instance per matching workflow, independent of each other. Instance key: `(lineItemId, workflowId)`. Steps run **sequentially**; a team completes its step and the next team's step becomes available.

```text
Shop
├── Teams (D1)                       who
│   └── Members
└── Workflows (ShopAgent DO SQLite)  what
    ├── tags: ["engraving", "engrave"]
    └── Steps (ordered)
        ├── 1. Engrave      → team Engraving
        ├── 2. Inspect      → team QC
        └── 3. Pack         → team Dispatch
```

## What already exists that matters

- **Product tags are already synced per line item.** `OrderLineItem.productTags` is a JSON array snapshot (`src/lib/OrderSync.ts:115`, `node.product?.tags ?? []`). The Domain comment already anticipates routing:

  > `productTags` is a **snapshot** taken at sync time, not a live read: a resync overwrites it. Once tag-based routing exists, the routing row must copy the tags it actually matched, so that a merchant retagging a product cannot silently rewrite history. — `src/lib/Domain.ts:438-442`

- **Placement is decided.** `docs/team-research.md` → Open questions: "Workflow templates live in the DO, referencing `teamId` as an opaque D1 id." Same doc → Deferred hooks: `archiveTeam` must call `shopAgent.countStepsOwnedBy(teamId)` and refuse if > 0.
- **Schema lives in `initializeSchema`** (`src/lib/ShopAgent.ts:110`). While prototyping, append to the existing `1_initialize schema` migration and reset local state; no second migration until there is data to keep.
- **UI pattern exists.** `src/routes/app.teams.index.tsx` / `app.teams.$teamId.tsx`: server fns under `shopifyServerFnMiddleware`, `Repository` for D1, archived filter via search param, TanStack Form. Workflows can mirror this with `ShopAgentClient` in place of `Repository`.
- **Route to Ship shape (for reference, not to copy).** Pipeline → Departments → Steps, sequential or parallel at both levels, step types start/stop / checklist / approval, per-department `Complete once per order` toggle (`refs/route-to-ship/demo.md:35`; tag-routing research → Configuration Hierarchy). Baton flattens the middle layer: a step _is_ the department stop.

## Terminology

The word matters because it appears in nav, empty states, and every table name. Candidates:

| Word         | For                                                                                                  | Against                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow** | App tagline is literally "made-to-order production workflows". Plain English for a no-code merchant. | Collides with Shopify Flow ("workflows") in the merchant's head, and with Cloudflare Workflows in code — `src/lib/OrdersSyncWorkflow.ts`, `SyncState.workflowId` already exist and mean the _other_ thing. |
| **Pipeline** | Route to Ship's word, so competitor docs translate 1:1. Zero collisions in this codebase.            | Engineering flavour (CI/CD, data). Less friendly than "workflow" to a jeweller. Wouldn't match the app tagline.                                                                                            |
| **Process**  | Neutral, ISO-9000 friendly ("production process").                                                   | Bland; "process" is also an OS/JS word in code.                                                                                                                                                            |
| **Route**    | Pairs with "Baton" (relay) and "Route to Ship".                                                      | Collides with TanStack routes in code; merchants read "route" as shipping.                                                                                                                                 |
| **Line**     | Manufacturing ("production line"), and the thing being built is a line item.                         | "Line" already overloaded by _line item_ in the same screens.                                                                                                                                              |

Recommendation: **merchant-facing "workflow"**, matching the tagline. Handle the code collision by prefix, not by renaming Cloudflare things: DO tables `Workflow` / `WorkflowStep`, Domain `Domain.Workflow*`, and keep the Cloudflare side under its existing `OrdersSyncWorkflow` name. Anything that talks to Cloudflare's runtime should keep saying `OrdersSync…`, so the bare word always means the production concept. Alternative if that feels too fragile: `Pipeline` everywhere in code, "workflow" only in copy. That split is cheap now and expensive later, so decide before the migration lands.

Vocabulary for the rest of this doc (and proposed for the app):

| Concept                                     | Merchant word | Code            | Route to Ship equivalent         |
| ------------------------------------------- | ------------- | --------------- | -------------------------------- |
| Definition of a production path             | workflow      | `Workflow`      | pipeline                         |
| One stop in that path, owned by a team      | step          | `WorkflowStep`  | department + its steps           |
| Tags that select the workflow               | product tags  | `Workflow.tags` | `Shopify Tags`                   |
| Later: a workflow running for one line item | _open_        | _open_          | order's pipeline progress / task |

"Template" vs "definition": the DO tables are the definition; a running instance later copies the steps. Avoid saying "template" in merchant copy — a merchant just has "workflows".

**Instance word — open (mw, 2026-09-02):** "job" rejected for now; not keen on a second noun, and workflow/job must not read as interchangeable. Thoughts for when it comes up:

- Route to Ship never names the instance either. It says "the order's pipeline progress" and calls the per-department unit a "task". Merchant copy can do the same: "this workflow on line item X".
- Code still needs a table name. Options that stay in the workflow family: `WorkflowRun` (Cloudflare/GitHub Actions flavour, but clearly "one execution of a definition") or `LineItemWorkflow` (says exactly what row it is). Either keeps one noun in copy and one qualifier in code. Decide in the instantiation doc.

## Invariants

1. **A workflow belongs to one shop.** Implicit: it lives in that shop's DO.
2. **Steps are totally ordered within a workflow.** `position` 1..n, dense, unique per workflow. Reorder rewrites positions in one DO transaction.
3. **Every step has exactly one team, and it must be an active team** at the time the step is saved. Not enforced by FK (cross-store); enforced in the server fn by checking `Repository.listTeams({ shop })` before writing, and by the `archiveTeam` refuse-guard afterward.
4. **Tags are normalised on write**: trim, lowercase, dedupe, non-empty. Shopify tag matching in the Admin is case-insensitive in search, and merchants type `Engraving` and `engraving` interchangeably; matching must be case-insensitive so normalise once at the boundary. Matching later: `lineItem.productTags.map(lower) ∩ workflow.tags ≠ ∅`.
5. **A tag may appear on more than one active workflow.** This is Route to Ship's documented behaviour ("each line item is routed independently… a single product can have multiple tags matching different pipelines") and it is the user's stated model (zero or more workflows per line item). Enforcing tag uniqueness would only remove one of two ways a line item gets two workflows, so don't. Surface it in the UI instead (see below).
6. **A workflow with zero steps is saveable but inert.** It never routes. Rationale: the create → add steps flow is naturally incremental; forcing ≥1 step at create means a modal with a nested step form. Routing (later) filters `stepCount > 0`. The list shows a "No steps — won't route" badge.
7. **Archive, don't delete.** `archivedAt` like `Team`. Archived workflows stop routing and drop out of pickers; a future running instance still resolves its name. Unique name spans archived rows, same reasoning as `Team_shop_name_uidx`.
   - **Name collision with an archived workflow: reject**, same as teams today. Copy: "A workflow named X is archived. Unarchive it or choose another name." Alternatives considered: unique-among-active only (two rows named X, one archived — history and pickers get ambiguous); auto-suffix "X (2)" (silent, surprising). Unarchive is a one-click path in the archived filter, so rejecting costs the merchant nothing.
8. **Bounds.** Arbitrary, enforced in Domain schemas so the DO never sees oversize rows: ≤ 20 steps per workflow, ≤ 20 tags per workflow, ≤ 50 active workflows per shop, step/workflow name ≤ 64 chars (matches `TeamName`), tag ≤ 255 (Shopify's own tag limit). Raise later; a number now prevents an unbounded `position` loop and keeps the reorder UI sane.
9. **Editing a definition never rewrites history.** Guaranteed structurally by the later instance copying step rows (team-research → "Workflow templates vs workflow instances"). Nothing in this phase needs versioning; the shape just has to be copyable, which flat rows are.

## Schema — DO SQLite, appended to `1_initialize schema`

```sql
create table if not exists Workflow (
  id text primary key,
  name text not null check (name = trim(name) and length(name) > 0),
  tags text not null,
  createdAt integer not null,
  updatedAt integer not null,
  archivedAt integer
);
create unique index if not exists Workflow_name_uidx on Workflow (name collate nocase);

create table if not exists WorkflowStep (
  id text primary key,
  workflowId text not null references Workflow (id) on delete cascade,
  position integer not null,
  name text not null check (name = trim(name) and length(name) > 0),
  teamId text not null,
  createdAt integer not null,
  unique (workflowId, position)
);
create index if not exists WorkflowStep_teamId_idx on WorkflowStep (teamId);
```

Notes:

- `tags text` as JSON array, decoded with `Schema.fromJsonString(Schema.Array(...))` like `productTags`. Querying "which workflows match tag X" happens in TS over a ≤ 50-row table; no need for a `WorkflowTag` join table yet. If routing ever needs an index, split it then.
- `teamId` has **no FK** because it _cannot_: `Team` is a D1 table and `WorkflowStep` is in the ShopAgent's private SQLite. SQLite foreign keys don't cross databases, let alone Cloudflare stores. This is the cost accepted in team-research approach A (`migrations/0001_init.sql`: "at the cost of a hard FK from Durable Object rows to a team, which is deliberately left as an opaque id"). Integrity is application-level: server fn validates the team is active before writing, `archiveTeam` refuses while steps point at it (with the re-check), and reads tolerate a null resolution. The alternative — teams in the DO — was rejected because teams are identity (D1, beside `Member`), not work.
- No `teamName` copy on the definition. The definition is a live pointer (team-research → "Current assignment is a pointer; history is a snapshot"). Names are joined in the server fn from `Repository.listTeams`. Snapshotting `teamName` belongs on the instance rows later.
- `WorkflowStep_teamId_idx` serves `countStepsOwnedBy(teamId)` for the archive guard.
- Integer epoch-ms timestamps, matching `ShopOrder`, not ISO text like D1's `Team`. The two stores already differ; don't mix within one store.
- No `status` column. `archivedAt is null and stepCount > 0` _is_ "active". Add an explicit draft/active flag only if a merchant needs to park a fully-built workflow without archiving it.

## Domain — `src/lib/Domain.ts` (shape only)

```ts
WorkflowId, WorkflowStepId              // branded NonEmptyString
WorkflowName, StepName                  // branded, trimmed, 1..64 like TeamName (isMaxLength(64))
ProductTag                              // branded, trim → lowercase, 1..255 (Shopify's tag limit)
Workflow      { id, name, tags: readonly ProductTag[], createdAt, updatedAt, archivedAt: number | null }
WorkflowStep  { id, workflowId, position, name, teamId: TeamId, createdAt }
WorkflowSummary { ...Workflow, stepCount }                              // list page
WorkflowDetail  { workflow, steps: (WorkflowStep & { teamName: TeamName | null })[] }  // teamName null = archived/unknown team, render as warning
```

## ShopAgent surface

All definition CRUD is `@callable()` on `ShopAgent`, reached from the browser over the existing agent socket (`useShopAgent`), the same way `activateOrders` is. Reasoning (2026-09-02 discussion):

- The socket gate already authenticates the caller as this shop's embedded admin (session-token signature, exp/nbf/aud, `dest` shop, active subscription). A server fn under `shopifyServerFnMiddleware` yields the same identity with one more hop.
- The DO already holds `Repository` over D1 (`makeRunEffect`), so it validates `teamId` against active teams and joins team names itself.
- The team-archive guard becomes race-free: count → D1 archive → re-check all run inside one single-threaded object, serialized against `addStep` by the DO input gate. In the Worker that sequence would race.
- `ShopAgentClient` (Worker → stub) stays for calls that spend a Shopify API call or need Worker-only context (`getShopInfo`, plan ceilings, member area).

Cost accepted: no SSR of workflow data — the page paints after hydration and socket identification, like the orders page.

## Embedded UI

Embedded-only, like teams. Two routes, same skeleton as `app.teams.*`:

- **`/app/workflows`** — table: name, tags (as chips), steps count, updated. `?archived` toggle. Create modal: name + tags. Badge when `stepCount === 0`. Optional warning icon when a tag is shared with another active workflow.
- **`/app/workflows/$workflowId`** — header (rename, tags editor, archive); ordered step list with team `<select>` (active teams only), up/down, remove; "Add step" inline row. Team pickers show a warning row for a step whose team resolves to null.

Tags input: comma-separated text, normalised on submit, rendered as chips. Suggesting existing tags is a nice-to-have: `select distinct` over `OrderLineItem.productTags` is cheap in the DO and gives the merchant real tags instead of typos. Product-tag autocomplete via Admin GraphQL is possible (`productTags` query) but adds a scope/latency; prefer the local snapshot.

**Deferred niceties (mw, 2026-09-02: bare bones first).** Two ideas parked, recorded so the words don't get re-explained:

- _Routing preview_ — not a step-flow graphic. A count on the detail page: "N synced line items would match this workflow's tags", computed from `OrderLineItem.productTags`. Catches tag typos before instantiation exists. Later.
- _Tag suggestions_ — autocomplete in the tags input from `select distinct` over synced `OrderLineItem.productTags`, so the merchant picks real product tags instead of typing. Later.

## Route to Ship features deliberately left out of this phase

| Feature                                      | Why not now                                                                                      | Hook for later                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Parallel steps / parallel pipelines          | User: hard to explain to no-code merchants; sequential first.                                    | `position` stays; add `groupId` or `parallelGroup` column.    |
| Step types (start/stop, checklist, approval) | POC step = "mark complete".                                                                      | `WorkflowStep.kind text default 'complete'` + payload column. |
| Instructions / notes per step                | Not needed to prove the shape.                                                                   | `WorkflowStep.instructions text`.                             |
| `Complete once per order` (workPerOrder)     | Needs the instance model first; the Dispatch use case is real.                                   | `WorkflowStep.perOrder integer default 0`.                    |
| Order-tag routing                            | Route to Ship's own Help documents product tags only; order tags are an unverified public claim. | `Workflow.orderTags` later if ever.                           |
| Quantity semantics (qty 3 → 3 runs or 1?)    | Instantiation concern.                                                                           | Decide in the instantiation doc.                              |
| Versioning definitions                       | Instances copy steps, so definitions can be edited freely.                                       | None needed.                                                  |

## Suggestions beyond what was asked

- **Name the step by the work, not the team.** "Engrave" owned by team Engraving, not step "Engraving". Two steps can share a team (e.g. Assembly → QC → Assembly rework), so the name must carry meaning on its own. Default the step name to the team name in the UI to keep entry fast.
- **Show the same team twice in a row as a soft warning**, not an error. Legit for a POC but usually a sign two steps should be one.
- **Empty-state copy should teach the tag contract**: "Add the tag `engraving` to any product in Shopify and its line items will follow this workflow." Merchants will otherwise expect order tags or collections.
- **Consider collections later, not now.** Some merchants organise by collection rather than tag; Route to Ship doesn't, and tags are already on the line item snapshot.

## Decisions (2026-09-02, mw)

1. **Word: workflow.** Everywhere — copy and code (`Workflow`, `WorkflowStep`). "Pipeline" not used at all; mixing would confuse.
2. **Instance word: open.** "Job" rejected for now (see Terminology). Not needed in this phase.
3. **Zero-step workflows: saveable but inert.** Revisit if it feels wrong.
4. **Shared tags across workflows: allowed, no warning required.** Practical consequence accepted: a line item matching several workflows gets several instances. See how it feels once instantiation exists.
5. **Step name: required free text, no uniqueness.** Easier to refer to things. Route to Ship's step-name uniqueness rule unknown; irrelevant for now.
6. **Bounds: 20 steps / 20 tags / 50 workflows.** Possibly low, fine for prototyping; keep as Domain constants.
7. **Same team on consecutive steps: allowed.** No restriction until it's felt.
8. **Routing preview: later.**
9. **Tag suggestions: later.**

Focus: data structures, data flow, and a bare-bones embedded UI for the shop admin to define workflows, steps, and step → team assignment. UI polish comes over time.

## Follow-up decisions (2026-09-02, mw)

- **Matching clarified:** one instance per `(lineItem, workflow)`; several tags of the same workflow matching is still one instance; several workflows sharing a tag → one instance each.
- **No new migration:** append to `1_initialize schema`, reset local DO state.
- **Archived-name collision: reject with an unarchive hint** (consistent with `Team`).
- **`teamId` FK:** impossible cross-store; app-level integrity as described in Schema notes.
- **Bounded, branded names everywhere.** `WorkflowName`/`StepName` = `isMaxLength(64)` like `TeamName`; `ProductTag` ≤ 255. Side note: `Domain.Email` (`src/lib/Domain.ts:180`) has no max length today — separate fix, worth doing (RFC 5321 caps at 254).

- **Rename: no name history.** Definitions are free to rename; instances copy.
- **`archiveWorkflow` is unconditional — always, not just this phase.** Nothing points at a definition: instances copy their steps, so archiving only stops routing new line items. Rule: guard live pointers (step → team), never guard copies (instance → definition).
- **Step whose team is archived/unknown (`teamName: null`): flag, don't block.** Same treatment as zero steps — workflow shows "needs attention", the step renders with a warning and an empty team picker, and routing (later) skips the workflow until fixed. Other edits (rename, tags, other steps) keep working; the risk is at routing time, not in the editor. Unarchiving the team restores validity with no edit, since the pointer is live.
  - Race elimination: `archiveTeam` runs inside the DO (count → D1 archive → re-check), serialized with `addStep`/`updateStep` by the DO input gate. No compensating write needed beyond the re-check.
  - Team detail page lists "steps owned by this team" so the merchant reassigns before archiving.

---

# Workflow definitions — spec (phase 1)

## Goals / non-goals

- Goals: shop admin defines workflows (name, product tags), ordered steps (name, team), in the embedded app over the agent socket (`@callable()`). Archive not delete. Bounded everything. `archiveTeam` moves into the DO and gains its step guard. Definitions are copyable for a later instantiation phase.
- Non-goals: instantiation/routing at order time, member-area changes, step types/instructions, parallel steps, previews, tag suggestions, order-tag routing, Shopify writes.

## Schema — `src/lib/ShopAgent.ts` `initializeSchema` (append; no new migration)

```sql
create table if not exists Workflow (
  id text primary key,
  name text not null check (name = trim(name) and length(name) > 0),
  tags text not null,
  createdAt integer not null,
  updatedAt integer not null,
  archivedAt integer
);
create unique index if not exists Workflow_name_uidx on Workflow (name collate nocase);

create table if not exists WorkflowStep (
  id text primary key,
  workflowId text not null references Workflow (id) on delete cascade,
  position integer not null,
  name text not null check (name = trim(name) and length(name) > 0),
  teamId text not null,
  createdAt integer not null,
  unique (workflowId, position)
);
create index if not exists WorkflowStep_teamId_idx on WorkflowStep (teamId);
```

- `tags`: JSON array of normalised tags. `teamId`: opaque D1 `Team.id`, no FK (cross-store).
- Epoch-ms integers like `ShopOrder`. Reset local DO state after the change (`pnpm d1:reset` for D1 is unrelated; DO SQLite resets with `.wrangler` wipe).

## Domain — `src/lib/Domain.ts`

```ts
WorkflowId, WorkflowStepId      // NonEmptyString + brand, like TeamId
WorkflowName, StepName          // same shape as TeamName: trim on decode, NonEmpty, isMaxLength(64), brand
ProductTag                      // trim + lowercase on decode, NonEmpty, isMaxLength(255), brand
ProductTags                     // Array(ProductTag) → dedupe on decode, isMaxLength(20)

Workflow        { id, name, tags: ProductTags, createdAt: Number, updatedAt: Number, archivedAt: NullOr(Number) }
WorkflowStep    { id, workflowId, position: Number, name: StepName, teamId: TeamId, createdAt: Number }
WorkflowSummary { ...Workflow.fields, stepCount: Number }
WorkflowDetail  { workflow: Workflow, steps: Array(WorkflowStep) }   // DO-side; teamName joined in the server fn

WorkflowLimits  = { maxWorkflows: 50, maxSteps: 20, maxTags: 20 } as const   // one place, referenced by schema + repository
```

`tags` column ↔ `Schema.fromJsonString(ProductTags)` as `productTags` does. Inputs from the UI: `tags` arrives as one comma-separated string; split → `ProductTags` in the server fn.

## `src/lib/WorkflowRepository.ts` — DO SQLite, sibling of `OrderRepository`

`Context.Service` + `Layer.effect` over `SqlClient` (same construction as `OrderRepository.layer`), added to `durableRepositoryLayer` in `makeRunEffect`. `Effect.fn("WorkflowRepository.<op>")` per method, rows decoded through `Domain` schemas, `WorkflowRepositoryError` for decode/missing-row faults.

```ts
listWorkflows({ includeArchived })           → readonly WorkflowSummary[]     // stepCount via correlated subquery; order by name collate nocase
getWorkflow({ workflowId })                  → Option<WorkflowDetail>          // steps ordered by position
createWorkflow({ name, tags })               → Workflow | WorkflowNameTakenError | WorkflowLimitError
updateWorkflow({ workflowId, name, tags })   → void | WorkflowNotFoundError | WorkflowNameTakenError
setWorkflowArchived({ workflowId, archived })→ void | WorkflowNotFoundError    // idempotent, unconditional
addStep({ workflowId, name, teamId })        → WorkflowStep | WorkflowNotFoundError | WorkflowLimitError   // position = max+1
updateStep({ stepId, name, teamId })         → void | StepNotFoundError
moveStep({ stepId, direction })              → void | StepNotFoundError        // no-op at the edge
removeStep({ stepId })                       → void | StepNotFoundError        // then compact positions > removed
countStepsOwnedBy({ teamId })                → number                          // only steps of non-archived workflows? No: count all — an archived workflow can be restored
```

- Name uniqueness: catch the unique-index failure and map to `WorkflowNameTakenError` (copy tells the merchant an archived workflow may hold the name).
- Limits: `createWorkflow` counts active workflows; `addStep` counts steps of that workflow; both fail with `WorkflowLimitError` before inserting.
- `moveStep` swap: three updates (target → -1, neighbour → target's position, -1 → neighbour's position) inside one `sql.withTransaction` because of `unique (workflowId, position)`. Supported: `@effect/sql-sqlite-do` builds a storage-backed `withTransaction` (`storage.transaction`, rollback on failure) when the layer is given `ctx.storage`, which `makeRunEffect` already does (`SqliteClient.layer({ storage })`). Constraints from its source: no nested transactions, and a transaction holds the single connection permit, so keep it to the few statements.
- `removeStep` compaction: `update WorkflowStep set position = position - 1 where workflowId = ? and position > ?`. Same transaction as the delete.

## `src/lib/ShopAgent.ts` — `@callable()` methods

One callable per operation, body = `this.runEffect(callableEffect("ShopAgent.<op>", Domain.<Input>, { onExcessProperty: "error" })(handler)(input))`, exactly as `activateOrders`. Inputs are browser-reachable, so every one is a `Domain` schema with bounded strings (`WorkflowName`, `StepName`, `ProductTags`, ids `isMaxLength(128)`).

```text
listWorkflows({ includeArchived })                  → WorkflowSummary[]
getWorkflow({ workflowId })                         → WorkflowDetailView | null   // steps carry teamName (null if unknown) + activeTeams for the picker
createWorkflow({ name, tags })                      → WorkflowResult
updateWorkflow({ workflowId, name, tags })          → WorkflowResult
setWorkflowArchived({ workflowId, archived })       → WorkflowResult
addStep({ workflowId, name, teamId })               → StepResult
updateStep({ stepId, name, teamId })                → StepResult
moveStep({ stepId, direction })                     → StepResult
removeStep({ stepId })                              → StepResult
archiveTeam({ teamId })                             → TeamArchiveResult
listStepsOwnedBy({ teamId })                        → { workflowName, stepName }[]   // team detail page
```

- **Team check inside the DO.** `addStep`/`updateStep` load active teams via `(yield* Repository).listTeams({ shop, includeArchived: false })` and refuse an unknown/archived `teamId` with `{ _tag: "TeamNotActive" }`. `getWorkflow` joins names from `listTeams({ includeArchived: true })` and returns `activeTeams` in the same round trip so the picker needs no second call.
- **Expected failures are result values.** `runEffect` collapses failures into a thrown `Error(message)` at the socket seam, so name-taken / not-found / limit / team-not-active come back as tagged unions decoded in the browser (`decodeOrdersView` pattern):

```ts
Domain.WorkflowResult = Union(
  { _tag: "Ok", workflow },
  { _tag: "NameTaken" },
  { _tag: "NotFound" },
  { _tag: "Limit", limit },
);
Domain.StepResult = Union(
  { _tag: "Ok", step: NullOr(WorkflowStep) },
  { _tag: "NotFound" },
  { _tag: "Limit", limit },
  { _tag: "TeamNotActive" },
  { _tag: "Archived" },
);
Domain.TeamArchiveResult = Union(
  { _tag: "Ok" },
  { _tag: "InUse", count },
  { _tag: "NotFound" },
);
```

- **`archiveTeam` (moved from `app.teams.index.tsx`)**: `countStepsOwnedBy` → if > 0 return `InUse` → `Repository.setTeamArchived({ archived: true })` → re-check → if > 0 flip back and return `InUse`. Restore stays a plain D1 write and can remain a server fn (nothing to guard). Writes on an archived workflow return `Archived`.
- Not `@callable()`: nothing new. `ShopAgentClient` is untouched this phase.

## Browser — routes

Pattern: `app.orders.tsx` — `useShopAgent()` for `{ agent, identified }`, `useQuery` keyed by shop with `enabled: identified`, `withSocketRecovery(agent)(() => agent.stub.<op>(input))` then schema decode, `useMutation` + `queryClient.invalidateQueries` on success. Wait for `data-app-interactive` before interacting in e2e. Result-union tags map to copy in the mutation `onSuccess` (field error for `NameTaken`, banner for the rest).

### `src/routes/app.workflows.index.tsx`

- Query: `listWorkflows({ includeArchived })` from `?archived` search param.
- Mutations: `createWorkflow`, `setWorkflowArchived`.
- Page: `<s-page heading="Workflows">`; create form: name + tags (text, "comma-separated product tags", split client-side, normalised again in the DO); table: name (link), tags as chips, steps count, "No steps" badge when 0, updated, Archive/Restore; "Show archived" toggle. Loading/empty states like the orders page.
- Nav: `<s-link href="/app/workflows">Workflows</s-link>` in `app.tsx` after Teams.

### `src/routes/app.workflows.$workflowId.tsx`

- Query: `getWorkflow({ workflowId })` → `{ workflow, steps (with teamName), activeTeams }`; `null` → not-found view.
- Mutations: `updateWorkflow`, `addStep`, `updateStep`, `moveStep`, `removeStep`, `setWorkflowArchived`.
- Page: heading = workflow name, "Archived" badge; rename + tags fields; "Needs attention" banner when `steps.length === 0` or any `teamName === null`; steps table ordered by position: position, name (inline edit), team `<s-select>` over `activeTeams` (blank option + warning when the current team is not active), ↑ ↓ Remove; "Add step" row (name + team select). Step controls disabled while archived.
- Empty state when `activeTeams` is empty: link to `/app/teams` ("Create a team before adding steps.").

### `app.teams.index.tsx` / `app.teams.$teamId.tsx`

- Archive button calls `agent.stub.archiveTeam({ teamId })`; `InUse` → banner "Reassign this team's workflow steps before archiving." Restore keeps `setTeamArchivedFn`.
- Team detail adds a "Workflow steps owned" list from `listStepsOwnedBy({ teamId })`, so the merchant reassigns before archiving. The teams pages therefore gain `useShopAgent` alongside their existing server fns.

## Tests

- `test/integration/workflow-repository.test.ts` (harness = `order-repository.test.ts`, layer swapped): create/list (nocase uniqueness incl. archived rows, archived filter, `stepCount`), tags round-trip normalised, limits (51st workflow, 21st step), add/move/remove keeps positions dense and unique, move at edges no-op, archive/restore idempotent, `countStepsOwnedBy` across workflows, workflow delete cascades steps (only via test, no API).
- `test/integration/repository.test.ts`: unchanged; `setTeamArchived` unguarded at repository level by design.
- ShopAgent callable tests (harness = `shop-agent-orders-stream.test.ts`, `runInDurableObject` on the instance): `addStep` with archived/unknown team → `TeamNotActive`; `archiveTeam` with owned steps → `InUse` and team still active; `archiveTeam` after reassign → `Ok`; writes on archived workflow → `Archived`; excess properties rejected.
- `Domain` unit checks inside the same file: `ProductTags` trims/lowercases/dedupes, rejects empty and >20; names reject >64.
- Optional browser smoke: create workflow → add two steps → reorder → archive team refused.

## Implementation order

1. Schema append + `Domain` types + `WorkflowLimits` → `pnpm typecheck`.
2. `WorkflowRepository` + layer wiring in `makeRunEffect` + integration tests.
3. `ShopAgent` callables + result unions + callable tests.
4. `app.workflows.index.tsx`, `app.workflows.$workflowId.tsx`, nav link.
5. `archiveTeam` callable wired into teams pages + owned-steps list on team detail.
6. `pnpm typecheck && pnpm lint && pnpm test && pnpm fmt`.

## Deferred hooks (so instantiation is additive)

- Instance rows copy `WorkflowStep` (name, position, teamId + snapshotted teamName) per `(lineItemId, workflowId)`; `Workflow.archivedAt is null and stepCount > 0 and every step's team active` is the routing predicate.
- `WorkflowStep` gains `kind`, `instructions`, `perOrder` columns without touching existing rows.
- `Domain.Email` max length (254) — separate small fix.
