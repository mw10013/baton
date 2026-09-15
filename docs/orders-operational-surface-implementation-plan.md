# Orders as the operational surface: implementation plan

Status 2026-09-15: **implemented**, both changes, green on `pnpm typecheck`,
`pnpm lint`, `pnpm test` and the `orders` / `teams` e2e specs. The reasoning and every product decision are in
`docs/orders-operational-surface-research.md`; its "Decisions" list and the
"Refinements after code review" list are binding, and where the body of that doc
disagrees with the refinements, the refinements win. This document is the order of
work. Like `docs/merchant-run-intervention-implementation-plan.md`, it is disposable
once the code is in and any deviations are folded back into the research doc.

Vocabulary is the research doc's: an index _row_ is `Domain.OrderRow`; a _ready_ step
is one that satisfies the `readyWhere` predicate; a _reconcile flag_ is any
`Domain.RunFlag` other than `blocked`; _waiting on_ is the set of teams that own a
ready step on an open run of the order.

## Ground rules for this work

- **Two changes, in this order.** Change A is Phases 1 to 3 (alarm split, hoisted
  predicate, waiting-on column). Change B is Phases 4 and 5 (team filter, drill-in).
  Each change ends green on `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the e2e
  suite before the next begins. Do not commit; the user commits.
- **No schema change.** Everything here is derived at read time from columns that
  exist. There is no migration, no reset of Durable Objects, and no seed change.
- **The ready predicate has one definition.** After Phase 2 the string
  `completedAt is null and not exists (... p.stage < ...)` appears in exactly one
  module. If you find yourself writing it a second time, you have skipped the phase.
- **Ids on the wire, names in the route.** The Durable Object does not know team
  names. `OrderRow.waitingOn` is ids; the route maps them through the roster that
  `OrdersView` carries.
- **No actions in index rows.** Not Assign team, not anything. Rows triage and link.
- **Copy is fixed.** Column header `Waiting on`; badges `Blocked` and `Order changed`
  (replacing `Flagged`); filter label `Waiting on`; chip `Waiting on <team>`. Do not
  invent variants.
- Follow `CLAUDE.md`: Effect v4 idioms, namespace imports, JSDoc carrying its
  reasoning inline and never pointing at `docs/`, `pnpm typecheck`, `pnpm lint`,
  `pnpm fmt` (keep everything it touches), `pnpm graphql-codegen` is not needed (no
  `#graphql` strings change).

## Phase 1: alarm disambiguation

Files: `src/lib/Domain.ts`, `src/lib/OrderRepository.ts`,
`src/routes/app.orders.index.tsx`, `test/integration/domain.test.ts`,
`test/integration/order-repository.test.ts`.

1. **`Domain.RunCounts`** (`src/lib/Domain.ts:1424`) becomes

   ```ts
   export const RunCounts = Schema.Struct({
     open: Schema.Number,
     done: Schema.Number,
     /** Open runs carrying a reconcile flag (`RunFlag` other than `blocked`): the order moved under a live run. */
     flagged: Schema.Number,
     /** Open runs a worker or the merchant blocked. Disjoint from `flagged`: a run has one flag. */
     blocked: Schema.Number,
   });
   ```

   `flagged` changes meaning from "any flag" to "reconcile flag". Update the struct's
   JSDoc: the two counters are disjoint because `WorkflowRun.flag` is a single column,
   and they are split because the merchant's next click differs — the order page and
   an intervention for `blocked`, accept-and-move-on for a reconcile flag.

2. **`Domain.runCounts`** (`src/lib/Domain.ts:1483`), the detail page's twin of the SQL
   aggregate, gets the same split:

   ```ts
   flagged: counts.flagged + (open && run.flag !== null && run.flag !== "blocked" ? 1 : 0),
   blocked: counts.blocked + (open && run.flag === "blocked" ? 1 : 0),
   ```

   with `blocked: 0` in the seed. `src/routes/app.orders.$orderId.tsx:547` calls this
   and needs no change.

3. **`OrderRepository.listOrders`** run aggregate (`src/lib/OrderRepository.ts:562`):

   ```sql
   sum(flag is not null and flag <> 'blocked' and status in ('pending', 'active')) as flagged,
   sum(flag = 'blocked' and status in ('pending', 'active')) as blocked
   ```

   Read `blocked` as `Number(row[4] ?? 0)`; the empty default becomes
   `{ open: 0, done: 0, flagged: 0, blocked: 0 }`.

4. **`stateBadge`** (`src/routes/app.orders.index.tsx:109`), `in_production` branch:
   replace the single `Flagged` badge with two, both after the active count:

   ```tsx
   <s-stack direction="inline" gap="small-300">
     <s-badge tone="info">{activeLabel}</s-badge>
     {row.runs.blocked > 0 && <s-badge tone="critical">Blocked</s-badge>}
     {row.runs.flagged > 0 && <s-badge tone="warning">Order changed</s-badge>}
   </s-stack>
   ```

   (`activeLabel` stands for the existing `N active · M done` template literal;
   keep it as it is.)

   Extend the function's JSDoc with the three-alarm reasoning: `Needs attention` is a
   configuration fault (remedy: workflow editor or members page), `Blocked` is a person
   waiting on the merchant now (remedy: the order page), `Order changed` is Shopify
   moving under a live run (remedy: usually accept). `Blocked` is critical because
   someone is stopped; `Order changed` is warning because nothing is stopped.

5. **Tests.**
   - `test/integration/domain.test.ts` `Domain.runCounts` (line 116): add a `blocked`
     run and a reconcile-flagged run to the fixture and assert both counters, plus that
     a done run with a stale flag counts in neither.
   - `test/integration/order-repository.test.ts`: a new `it` under
     `OrderRepository.listOrders filters` that inserts one run with
     `flag = 'blocked'` and one with `flag = 'item_removed'` on separate open orders
     (copy the raw insert in `seedStates`, line 241, and set `flag`) and asserts each
     row's `runs.blocked` / `runs.flagged`.
   - `e2e/orders.spec.ts`: grep for `Flagged`; if asserted, update to the new label.

## Phase 2: hoist the ready predicate

Files: new `src/lib/readyWhere.ts`, `src/lib/WorkflowRunRepository.ts`,
`src/lib/OrderRepository.ts`.

1. **New module `src/lib/readyWhere.ts`** exporting a pure function that returns the
   SQL text, with no `SqlClient` dependency so both repositories can wrap it:

   ```ts
   /**
    * A step is ready when it is open and nothing in an earlier stage of the same
    * run is still open. For an order run the item runs are stage zero: its
    * steps are ready only when no item run on the order is open and at least
    * one is done ... (move the full docblock from WorkflowRunRepository here,
    * verbatim, and add:) One module because three readers depend on agreeing
    * exactly — the member queue (`listQueue`), every step action's guard, and
    * the orders index's waiting-on column and filter. A second copy would
    * drift, and a merchant filter that disagrees with a worker queue is worse
    * than no filter.
    */
   export const readyWhere = (alias: string): string => `( ... )`;
   ```

   The body is the current literal at `src/lib/WorkflowRunRepository.ts:586`,
   character for character, with `${alias}` substitutions. The inner subqueries use
   aliases `p`, `r`, and `i`; callers must not use those for the outer tables they
   join, or SQLite's scoping will silently resolve the inner `r` to the wrong row.
   State that in the JSDoc.

2. **`WorkflowRunRepository`**: delete the local `readyWhere` closure and its docblock;
   replace with

   ```ts
   const readyWhere = (alias: string) =>
     sql.literal(ReadyWhere.readyWhere(alias));
   ```

   (`import * as ReadyWhere from "@/lib/readyWhere"`). Every existing call site
   (`readySteps`, `isReady`, `listQueue` at 1447 and 1452, and any others `grep
readyWhere(` finds) is unchanged. Leave a one-line comment pointing at the module
   for why the definition moved out.

3. **`OrderRepository.listOrders`** `emptyReady` (`src/lib/OrderRepository.ts:463`):
   replace the hand-written "nothing open in an earlier stage" subquery with the
   hoisted predicate:

   ```ts
   const emptyReady =
     emptyIds.length === 0
       ? sql.literal("1 = 0")
       : sql`(${sql.in("s.teamId", emptyIds)} and ${sql.literal(ReadyWhere.readyWhere("s"))})`;
   ```

   `attentionStep` already aliases the step as `s` and the run as `r`; the predicate's
   inner `r` shadows the outer `r` inside its own `exists`, which is what we want
   (it looks up the step's own run by `s.runId`). Update the `listOrders` JSDoc
   sentence "as `WorkflowRunRepository` defines it" to name the module instead.

   Behaviour change, intended: a pending order run's step on an empty team no longer
   trips `attention` until the item runs are done. The existing attention test
   (`test/integration/order-repository.test.ts:409`) seeds only item runs, so it stays
   green. Add one case to it: an order run (`lineItemId null`) on an empty team beside
   an active item run does **not** count; the same order run beside a done item run
   does.

4. Run `pnpm test`. `test/integration/workflow-repository.test.ts` exercises
   `listQueue`; it must be untouched and green.

## Phase 3: the waiting-on column

Files: `src/lib/Domain.ts`, `src/lib/OrderRepository.ts`, `src/lib/ShopAgent.ts`,
`src/routes/app.orders.index.tsx`, `test/integration/order-repository.test.ts`,
`e2e/orders.spec.ts`.

1. **`Domain.OrderRow`** (`src/lib/Domain.ts:1436`) gains, after `attention`:

   ```ts
   /**
    * Teams with a ready step on an open run of this order, distinct, as ids:
    * "who is holding it", answered at the altitude the list grows with.
    * Unassigned ready steps contribute nothing (that fault is `attention`),
    * and a team no longer in the roster contributes nothing for the same
    * reason. Ids, not names: the Durable Object has no names; the route
    * resolves them from `OrdersView.teams`. Empty for an order in production
    * means every ready step is unassigned or unstaffed, which is exactly when
    * `attention` is showing.
    */
   waitingOn: Schema.Array(TeamId),
   ```

2. **`Domain.OrdersView`** (`src/lib/Domain.ts:1592`) gains
   `teams: Schema.Array(TeamRoster)` — the roster the page was read against, so the
   route names the ids without a second read. `readOrders` in `ShopAgent`
   (`src/lib/ShopAgent.ts:1834`) already calls `this.teams()`; bind it once and put it
   in both the repository input and the view.

3. **`OrderRepository.listOrders`**: one more per-page query after `attentionRows`.
   Alias the outer run as `wr` (not `r`, see Phase 2 §1):

   ```ts
   const waitingRows =
     ids.length === 0 || liveIds.length === 0
       ? []
       : yield *
         sql`
           select distinct wr.orderId, s.teamId
           from WorkflowRunStep s
           join WorkflowRun wr on wr.id = s.runId
           where ${sql.in("wr.orderId", ids)}
             and wr.status in ('pending', 'active')
             and ${sql.in("s.teamId", liveIds)}
             and ${sql.literal(ReadyWhere.readyWhere("s"))}
         `.values;
   ```

   Fold into `Map<orderId, TeamId[]>`, sort each list by the roster's team **name**
   (the roster is in scope as `teams`), and emit `waitingOn: waiting.get(order.id) ?? []`.
   Sorting server-side keeps the route a pure render and keeps the `+N` overflow stable
   across refreshes. JSDoc on the query: why it is a fourth per-page read rather than
   a join on the page query (same reason the comment at line 540 gives for the other
   aggregates), and why `liveIds` gates it (a deleted team is `attention`, not
   waiting-on).

   Do not add anything to `openCounts`. Per-team counts are ruled out (research
   "Deliberately not doing").

4. **Route: name resolution.** In `RouteComponent`, derive once from the view:

   ```ts
   const teamName = new Map(
     view?.teams.map(({ id, name }) => [id, name]) ?? [],
   );
   ```

   Then a renderer beside `tagBadges`, sharing `TAG_BADGE_LIMIT`:

   ```tsx
   const waitingOnBadges = (ids: readonly Domain.TeamId[]) => (
     <s-stack direction="inline" gap="small-300">
       {ids.slice(0, TAG_BADGE_LIMIT).map((id) => (
         <s-badge key={id}>{teamName.get(id) ?? "Unknown team"}</s-badge>
       ))}
       {ids.length > TAG_BADGE_LIMIT && (
         <s-text color="subdued">{`+${String(ids.length - TAG_BADGE_LIMIT)}`}</s-text>
       )}
     </s-stack>
   );
   ```

   `"Unknown team"` should never render (the repository gates on `liveIds`) but the
   map lookup is nullable and a blank badge is worse. JSDoc on `TAG_BADGE_LIMIT`: it
   now caps two columns, on purpose, so the table has one collapse idiom.

5. **Route: column.** Header between `Workflows` and `Items`
   (`src/routes/app.orders.index.tsx:467`):

   ```tsx
   <s-table-header listSlot="labeled">Waiting on</s-table-header>
   ```

   and the cell after the workflows cell:

   ```tsx
   <s-table-cell>{waitingOnBadges(row.waitingOn)}</s-table-cell>
   ```

   No placeholder copy for an empty cell. The research doc explains why (the empty
   cell beside a critical badge or a flag badge is honest); put that reasoning in a
   short JSX comment above the cell so nobody adds a dash later.

6. **Tests.**
   - `test/integration/order-repository.test.ts`, new `describe("OrderRepository.listOrders waitingOn")`.
     Reuse `seedStates` and the `step` helper from the attention test. Cases, each
     asserting `row.waitingOn` by order name:
     - two ready steps on the same team across two item runs → one id;
     - a ready step on `team-cut` and a not-ready later-stage step on `team-polish`
       → only `team-cut`;
     - a ready step on a deleted team (`team-gone`) → `[]` and `attention: true`;
     - a pending order run (`lineItemId null`) on `team-pack` beside an active item
       run on `team-cut` → only `team-cut`; then complete the item run's step, mark
       the item run `done`, and the same order → only `team-pack`;
     - a done order → `[]`;
     - ordering: three teams named so that id order and name order differ, assert
       name order.
   - `e2e/orders.spec.ts`: assert the `Waiting on` header exists and that the seeded
     in-production order shows its team name. Check `e2e/seed.ts` for which team the
     seeded workflow's first step is on and assert that name.

7. **Checkpoint.** Run the dev server, open `/app/orders`, and check: an
   in-production row shows team badges; a `Needs attention` row from an unassigned
   step shows an empty cell; a row with more than three teams shows `+N`. Reseed with
   `pnpm seed` if the local shop has no runs.

Change A ends here. Typecheck, lint, test, e2e, `pnpm fmt`.

## Phase 4: the team filter

Files: `src/lib/Domain.ts`, `src/lib/OrderRepository.ts`,
`src/routes/app.orders.index.tsx`, `test/integration/order-repository.test.ts`.

1. **`Domain.ListOrdersInput`** (`src/lib/Domain.ts:1395`) gains

   ```ts
   /** `null` is any team; an id keeps only orders with a ready step on that team — "waiting on", the queue's own predicate, not "owns a step anywhere". */
   team: Schema.NullOr(TeamId),
   ```

   `SubscribeOrdersInput` spreads the fields and picks it up. `subscribeOrders` parses
   with `onExcessProperty: "error"`, so the route must always send the key (null or
   id), never omit it.

2. **`OrderRepository.listOrders`** takes `team` and adds a filter beside
   `attentionFilter`:

   ```ts
   const teamFilter =
     team === null
       ? sql.literal("1 = 1")
       : sql`exists (
           select 1 from WorkflowRun wr
           join WorkflowRunStep s on s.runId = wr.id
           where wr.orderId = ShopOrder.id
             and wr.status in ('pending', 'active')
             and s.teamId = ${team}
             and ${sql.literal(ReadyWhere.readyWhere("s"))}
         )`;
   ```

   Add it to the page query's `sql.and([...])`. Do **not** add it to the `openCounts`
   query: the strip stays independent of the team filter for the same reason it is
   independent of `paid` (`Domain.OpenStageCounts` JSDoc). JSDoc on `teamFilter`: it
   is the waiting-on column's membership test as a `where`, so a filtered page is
   exactly the rows whose cell names the team.

3. **Route: search, key, loader.**
   - `OrdersSearch` gains `team: Schema.optionalKey(Domain.TeamId)`.
   - `ordersQueryKey` gains `team` as a fifth element; update its JSDoc sentence to
     "keyed by every filter".
   - `OrdersLoaderInput`, `loaderDeps`, `getLoaderData`, `setFilters`, the
     `subscribeOrders` call, and `filtered` all thread `team` the way they thread
     `paid`. `setFilters` emits `team` only when non-null, like `state`.
   - `Clear filters` resets `team: null`.

4. **Route: control.** In the filter grid, a third row under `Payment`:

   ```tsx
   <s-text color="subdued">Waiting on</s-text>
   <s-stack direction="inline" gap="small-300">
     <s-select
       label="Waiting on"
       labelAccessibilityVisibility="exclusive"
       value={team ?? ""}
       onChange={(event) => {
         const value = (event.currentTarget as HTMLSelectElement).value;
         setFilters({ state, paid, attention, team: value === "" ? null : Domain.TeamId.make(value) });
       }}
     >
       <s-option value="">Any team</s-option>
       {view?.teams.map(({ id, name }) => (
         <s-option key={id} value={id}>{name}</s-option>
       ))}
     </s-select>
   </s-stack>
   ```

   Check `src/routes/app.orders.$orderId.tsx` for how the existing "Assign team" picker
   reads `s-select` change events and match it exactly rather than the cast above.
   Options are names only — no counts (research "Deliberately not doing"). If the
   active `team` id is not in the roster (deleted since the link was made), add a
   disabled option `Deleted team` selected, so the control does not silently show
   `Any team` while the list is filtered.

   The research suggested a chip shown only when active; a select whose value is the
   team already reads as the chip, and one control is better than a control plus a
   chip. Note this as a deviation.

5. **Empty state.** `emptyText(null)` reads "No orders match these filters." which is
   right for a team filter; no change.

6. **Tests.** `order-repository.test.ts`, under the waitingOn `describe`: `team` set to
   `team-cut` returns exactly the rows whose `waitingOn` contains it, across the same
   fixture as Phase 3; `team` set to an unknown id returns nothing; `openCounts` is
   unchanged by `team`.

## Phase 5: drill-in from team detail

Files: `src/routes/app.teams.$teamId.tsx`, `src/routes/app.teams.index.tsx`,
`e2e/teams.spec.ts`.

1. **Team detail** (`src/routes/app.teams.$teamId.tsx:412`): a secondary action in the
   page header, before `More actions`:

   ```tsx
   <s-button
     slot="secondary-actions"
     href={`/app/orders?team=${encodeURIComponent(team.id)}`}
   >
     Orders waiting on this team
   </s-button>
   ```

   Confirm `s-button` accepts multiple `secondary-actions` slots alongside the menu
   trigger; if only one is allowed, put the link inside the `team-actions` menu as its
   first item instead.

2. **Teams index** (`src/routes/app.teams.index.tsx:170`): no link. The row already
   links to the detail page and the index's job is the roster. Deliberate; leave a
   short comment only if a reviewer would otherwise add one.

3. **e2e**: in `e2e/teams.spec.ts`, open a seeded team, click the link, assert the
   orders page URL carries `team=` and the select shows the team's name.

Change B ends here. Typecheck, lint, test, e2e, `pnpm fmt`.

## Deviations

Record here anything that had to differ from this plan or from the research doc, and
fold it back into the research doc's "Refinements" list when the work is done.

Implemented 2026-09-15. Everything below differs from the plan as written; nothing
differs from the research doc's decisions.

1. **`Domain.productionState` takes `Pick<OrderRow, "order" | "runs">`, not
   `OrderRow`.** The order page rebuilds the aggregate from its own run list and was
   already passing `itemUnits: 0, attention: false` as filler; adding `waitingOn: []`
   would have been a third invented value on a call that reads neither. Narrowing the
   parameter to the two fields the function reads removes the filler instead of
   growing it, and keeps future `OrderRow` fields from touching that call site.
2. **`waitingOn` is grouped through the roster, not by re-branding the stored
   string.** `listOrders` already has `teams` in scope, so the fold looks each row's
   `teamId` up in a `Map<string, TeamRoster>` and takes the branded `id` from the
   roster entry. No `TeamId` construction from a SQL value anywhere, and the
   name-sort comes off the same entry.
3. **The team select maps its value back through `view.teams`** —
   `view?.teams.find(({ id }) => id === value)?.id ?? null` — rather than
   constructing a `TeamId` from the DOM value. Same reason as §2: the roster is
   already on the view, so the branded id never has to be minted at the boundary.
   `Domain.TeamId.make` is not used.
4. **One control, no chip** (this was already flagged in Phase 4 §4 as a deviation
   from the research doc): the select's value is the team, which reads as the chip.
   A `Deleted team` disabled option covers a `?team=` link that outlived its team,
   so the control never reads `Any team` over a filtered list.
5. **The order-run readiness case is its own `it`,** not an extra assertion inside
   the existing attention test (Phase 2 §3 said "add one case to it"). That test's
   assertions are tightly coupled to its own fixture and roster; a separate
   `it` in the same `describe` seeds the order run on `#1005`, which `seedStates`
   leaves runless, and asserts both directions of the gate.
6. **The `WorkflowRun` check constraint bit the tests**: `lineItemTitle`,
   `quantity` and `customAttributes` are tied to `lineItemId`, so a hand-inserted
   order run must null all four. That note lives in the test, not in
   `readyWhere.ts`, which exports the plain string as planned.
7. **The waitingOn test fixture takes `position` off a counter.**
   `WorkflowRunStep` is unique on `(runId, position)`, so the plan's "three ready
   steps in one stage" case cannot reuse `stage` as `position` the way the attention
   test's helper does.
8. **Teams index carries a short comment** explaining why there is no per-row orders
   link (Phase 5 §2 left this optional). With the detail page now carrying the
   drill-in, the row is the obvious place a reviewer would add a second one.
9. **Multiple `secondary-actions` confirmed.** `s-page`'s slot takes several
   buttons; verified in the admin — the drill-in and `More actions` both hoist into
   the title bar. No fallback into the `team-actions` menu was needed.
10. **The e2e assertion for the select reads the element's `value` through
    `evaluate`,** not `toHaveValue`: `s-select` is a custom element, so Playwright's
    value matcher refuses it.
11. **The waiting-on e2e assertion rides on the existing order-workflow test** in
    `e2e/orders.spec.ts` rather than a new test, since that test already seeds a
    one-step workflow on a staffed team and walks past the index. The drill-in gets
    a test of its own in `e2e/teams.spec.ts`, because the existing teams test ends
    by deleting its team.
12. **An unstaffed team shows in Waiting on.** The plan's `OrderRow.waitingOn`
    JSDoc said an empty cell means "unassigned or unstaffed", but the repository
    gates on the roster, not on member count, so a team with no members is both
    `attention` and a badge. Kept, since the badge names the team to staff; the
    JSDoc and the cell comment now say "unassigned or on a deleted team".
