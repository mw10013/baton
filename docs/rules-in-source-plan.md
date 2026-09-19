# Rules in source: implementation plan

Handoff plan. The implementer is expected to be an LLM agent working in
this repository under `AGENTS.md`. Read `docs/jsdoc-as-spec-research.md`
first; it holds the reasoning and the accepted decisions. This plan holds
the work.

## Goal

Every behavioural rule the software enforces is:

1. **Stated once**, normatively, in the JSDoc of the symbol that enforces it
   or the symbol that *is* the concept (a `Schema.Literals`, a branded type).
2. **Pointed at**, not restated, from every other site that depends on it,
   with a `{@link}` or a one-line "follows the rule on X".
3. **Enforced through a `Domain` function** wherever it is a predicate on
   domain rows. Routes and the object never compare `status`, `flag` or the
   like inline.
4. **Pinned by a test** whose title is the rule in plain words.
5. **Examined from first principles** before being written down. The docs
   in `docs/` are not evidence. The code is the only record of what is
   implemented, and the code can be wrong. Where the code and a sensible
   reading of the domain disagree, that is a question for the owner, not a
   thing to paper over.

## Ground rules for the implementer

- **Source is primary. `docs/` is untrusted.** Do not consult a doc under
  `docs/` to learn a rule. Do not cite one from `src/`. If a doc happens to
  be open, treat any rule in it as a hypothesis to test against the code.
- **Questions are output, not blockers.** When the code's rule looks wrong,
  incoherent with a sibling rule, or surprising for a merchant or worker,
  write it to the Questions log (below) with the evidence, and continue with
  everything that does not depend on the answer. Do not resolve a question
  by guessing. Do not change behaviour to match your guess.
- **Behaviour-preserving by default.** Every refactor step in this plan is
  a no-behaviour-change refactor unless a Questions entry has been answered
  and says otherwise. A failing test after a step means the step is wrong,
  not the test.
- **Small diffs.** One concept per change. Never mix the pilot with the next
  concept, and never mix a behaviour fix with a refactor.
- **Effect idioms** for anything under `src/lib/`. Pure predicates are plain
  functions; anything with an effect, a service, or a failure channel uses
  Effect.
- **`AGENTS.md` commands after every change**: `pnpm typecheck`,
  `pnpm lint`, `pnpm fmt` (keep every file it touches), `pnpm test`.
  `pnpm graphql-codegen` if a `#graphql` literal moved.
- **No commits** unless told. Report state at the end of each phase.

## Phase 0: Inventory (no code changes)

Output: `docs/rules-inventory.md`, a single table plus the Questions log.
This is the map for every later phase and the only doc this plan creates.

### 0.1 Concepts

List every concept symbol in `src/lib/Domain.ts`. Start from
`grep -n "Schema.Literals(\[" src/lib/Domain.ts` (15 today) and add branded
types that carry rules (ids, cursors, note lengths, plan handles). For each:

| concept | symbol | values | has cross-site rules? |

"Cross-site" means more than one place in `src/` decides something based
on its value. Confirm by grepping the field name: for `RunStatus` that is
`.status ===` and `.status !==`; for `RunFlag`, `.flag`.

Known starting set with cross-site rules, from the research:
`RunStatus`, `RunFlag`, `ProductionState`, `BulkOperationStatus`,
`UserRole`, `ConnectionRole`. Verify; expect to add a few.

### 0.2 Rules per concept

For each concept with cross-site rules, list every rule as one row:

| rule (one sentence, normative) | enforcing symbol | readers (file:line) | test? | first-principles note |

How to find rules: read the enforcing layer first, `WorkflowRunRepository`,
`OrderRepository`, `WorkflowRepository`, then `ShopAgent`, then routes. A
rule is any branch on the concept's value that decides whether an action
is allowed, what a page offers, or how a count is made.

The **first-principles note** is the important column. For each rule, ask
in order:

1. What would a merchant or worker expect here, knowing nothing of the
   code? (Undo example: "I just pressed Done by mistake, I take it back.")
2. Is this rule consistent with its siblings? (Undo was allowed by the write
   and hidden by one of three readers.)
3. Is the refusal the user sees phrased in terms of the rule? (The
   `RunTerminalError` message on the order page says "already finished",
   which is wrong for an undoable done run.)
4. Does the rule need a DB constraint, an application check, or both, and
   are they the same rule? (`WorkflowRun_live_item_uidx` and the
   `runIsLive` lookup must agree on what "live" means.)

Write "ok" when all four hold. Otherwise write a Questions entry and put
its id in the column.

### 0.3 Relationship rules

Rules that are not about one enum: "one live run per line item", "a step's
`teamName` is frozen once completed", "reconcile cancels pending runs and
flags active ones". These hang on a function or a DB index, not a concept
symbol. List them in a second table with the same columns. Their home is
the enforcing function's JSDoc, and the table on the nearest concept symbol
links to them.

### 0.4 Inline predicate census

`grep -rn -E "\.(status|flag) (===|!==) \"" src | grep -v routeTree`
and the same for every other concept field found in 0.1. Record counts per
file. This is the backlog for Phase 2 and the baseline the lint (Phase 4)
must drive to zero outside `Domain.ts`.

Today: 40 sites for `status`, 16 for `flag`. Heaviest file is
`src/routes/app.orders.$orderId.tsx` with 20.

## Phase 1: Pilot, `RunStatus`

Accepted in review. Do it exactly as follows and record every deviation.

### 1.1 Predicates and table

In `src/lib/Domain.ts`, beside `RunStatus`:

```ts
/** Work can still be recorded: Start, Done, notes, Block, team assignment, cancel. */
export const runIsOpen = (run: { readonly status: RunStatus }) =>
  run.status === "pending" || run.status === "active";

/**
 * The run still stands for its line item. Only `cancelled` is out, because
 * only `cancelled` was chosen; `done` is the last step's Done and is undone
 * the same way. Undo and every "which run is this item's" lookup use this.
 */
export const runIsLive = (run: { readonly status: RunStatus }) =>
  run.status !== "cancelled";
```

Extend the `RunStatus` JSDoc with the table from the research doc,
corrected: cancel's gate is `runIsOpen` (the repository refuses `done`).
Keep the existing derivation paragraph above it. Every row's gate is a
`{@link}` to one of the two predicates or names `uncancelRun`'s inverse.

### 1.2 Replace the enforcers

- `WorkflowRunRepository.ts`: delete the private `isTerminal`; the three
  callers become `!Domain.runIsOpen(run)`. The inline checks in `cancelRun`
  and `uncompleteStep` become `runIsOpen` / `runIsLive`. `uncancelRun` keeps
  its `!== "cancelled"` check but its comment says it is the inverse of
  `runIsLive`. The `find((run) => run.status !== "cancelled")` in
  `reconcileOrder` becomes `runIsLive`.
- `ShopAgent.ts`: delete the private `isOpen`; callers use `Domain.runIsOpen`.
- `Domain.ts` itself: `ambiguousItems` and `runCounts` use the predicates.
- `OrdersSyncWorkflow.ts`: the one site.

Shorten each write's JSDoc terminal sentence to a pointer: "Gate:
{@link runIsOpen}; see {@link RunStatus}." Keep any sentence that says
*why* this action differs (undo's does).

### 1.3 Lift the member gate

Add to `Domain.ts` (pure, no Effect needed):

```ts
/**
 * What a member may do to a step, in one place for the work page and the
 * queue's Done tier so the two cannot disagree. Rules: {@link RunStatus}
 * table for status; a flag stops Start, Done and Undo but not the note;
 * Undo is also blocked by downstream work, {@link undoBlockedBy}.
 */
export const stepActions = (
  run: { readonly status: RunStatus; readonly flag: RunFlag | null },
  step: RunStepView,
  teamIds: readonly string[],
) => { … start, done, undo, note … };
```

Rewrite `src/routes/shop.$shop.work.$runId.tsx` to render from it, deleting
`open`, `undoable`, `canAct`, `acting`, `ready`, `finished`. Rewrite the
Done tier in `src/routes/shop.$shop.index.tsx` to use `undo` from it.
Behaviour must be identical to today, including the Undo fix already in
the tree.

### 1.4 Tests

In `test/integration/domain.test.ts`, one `describe("stepActions")` with a
test per rule, titles as rules:

- "a done run's last step is undoable while nothing downstream started"
- "undo is refused once a later stage started, naming the blocker"
- "a cancelled run offers no actions"
- "a flag hides Start, Done and Undo but not the note"
- "a step on another team offers nothing"
- "Start is offered only before the step is started; Done while it is ready"

And for the predicates, one test each on all four statuses.

Repository tests already cover the writes; add
"cancelRun refuses a done run" if absent.

### 1.5 The merchant order page, last

`src/routes/app.orders.$orderId.tsx` has 20 sites. Replace them one helper
at a time: `readySteps`, `attentionRows`, `orderSummary`, `renderLineItem`,
the Manage drawer's `open`. Each becomes `Domain.runIsOpen` /
`Domain.runIsLive`. The Reopen gate already uses `Domain.undoBlockedBy`;
leave it. Fix the `Terminal` error message here: it is reachable from
Reopen on a cancelled run only, so say "That workflow run was cancelled."
Record this as a behaviour change in Deviations; it is a wording fix, not
a rule change.

### 1.6 Verify

Typecheck, lint, fmt, unit tests. Then the e2e member and admin projects:
`npm run test:e2e --`. Then manually: open a done run's work page as a
member and confirm Undo on the last step, press it, confirm the run is
`active` and the step shows "Reopened by".

## Phase 2: Remaining concepts, one per change

Order by reader count from the Phase 0 census. Expected: `RunFlag`, then
`ProductionState`, then the rest. For each, the same recipe as Phase 1:

1. Predicates in `Domain` for every shape the census found.
2. Table on the concept symbol, rows linking predicates and enforcers.
3. Enforcers' JSDoc shortened to pointers.
4. Readers call predicates; inline comparisons deleted.
5. Tests titled as rules.
6. Questions raised for anything failing the four first-principles checks.

`RunFlag` note: the flags are set by reconcile and by people, and the
`RunCounts` split (`flagged` versus `blocked`) is already a rule with two
readers. Expect it to need a `flagIsReconcile` predicate.

`ProductionState` note: computed on every read from order row plus run
counts. Its rule is a function, not a table; the table on the symbol should
say which function and link it.

## Phase 3: Relationship rules

From 0.3. For each, confirm the enforcing function's JSDoc states it
normatively and that the DB constraint, if any, is named in the same
JSDoc. Add a test if missing. No new tables; add a link from the nearest
concept's table.

## Phase 4: Hold the line

- A script, `scripts/rules-lint.ts` or a line in `pnpm lint`, that fails
  when `\.(status|flag|state|role) (===|!==) "` appears under `src/`
  outside `src/lib/Domain.ts`. Extend the field list from the Phase 0
  census. Start as a grep; a custom oxlint rule only if the grep proves
  noisy.
- `AGENTS.md`: replace the JSDoc bullet with:

  > Prefer JSDoc for complex and subtle behavior the code cannot show, and
  > for rules: any behaviour more than one site must agree on is stated
  > once, normatively, on the symbol that enforces it or the symbol that is
  > the concept. Other sites `{@link}` it rather than restate it; a site
  > that follows a different rule says so and why. Status, flag and role
  > predicates are `Domain` functions, never inline comparisons in routes or
  > the object. Each rule has a test whose title is the rule. A JSDoc must
  > carry its reasoning inline and never reference `docs/`.

## Questions log

Format, kept in `docs/rules-inventory.md` while the work runs:

```
Q-<n>  concept=<RunStatus>  rule="<one sentence>"
  evidence: <file:line> …
  first-principles: <what a merchant or worker would expect, and why the code may differ>
  options: <a>, <b>
  status: open | answered(<date>): <the decision>
```

Seed entries the research already surfaced:

- Q-1 `RunStatus` — The order page's `Terminal` message says "already
  finished" for a refusal that can only come from a cancelled run. Wording.
- Q-2 `RunStatus` — `setStepNote` refuses a `done` run. A worker who
  noticed something after the last Done cannot write it down without
  undoing. Is that intended? Options: allow notes on done runs (then
  `note` gate is `runIsLive`), or keep and document why.
- Q-3 `RunStatus` — `blockRun` needs a ready step of the member's team. On
  a done run there is none, so a member cannot block a done run; the
  merchant can reopen and then block. Confirm that is the intended shape.
- Q-4 `RunFlag` — `order_fulfilled` cancels pending runs and flags active
  ones. A pending run whose order shipped is gone silently, with no flag to
  show why. Is cancel-with-flag possible, and wanted?

Expect Phase 0 to add ten to twenty more. That is the point.

## Deviations and issues

Append-only log the implementer keeps as the work runs. One entry per
deviation from this plan, per behaviour change, and per thing that turned
out different from what the plan assumed.

```
D-<n>  phase=<1.3>  <date>
  planned: <what the plan said>
  found: <what the code actually did / what blocked it>
  did: <what was done instead, or "stopped, see Q-<n>">
  behaviour change: yes | no
```

Seed entry:

- D-0 phase=1.5 — `Terminal` message wording on the order page changes
  from "already finished" to "was cancelled". Behaviour change: yes,
  wording only. Tied to Q-1.

## Reporting

At the end of each phase, report: files touched, the census count now
versus baseline, open Questions, and the Deviations added. Do not begin the
next phase while a Question blocks a step in the current one; do begin any
step it does not block.
