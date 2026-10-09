# Home: implementation plan

This plan carries out the decisions in `docs/home-research.md` (under "Decisions"). Read that doc
first: the page's four questions, the derived setup guide, the strip as links and why it costs
nothing extra, and the plan card's place are decided there. This plan says what to change, in what
order, and how to know each phase is done.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that is the concept or enforces it. Other sites
    `{@link}` it. A JSDoc never cites a file under `docs/`; it carries its reasoning inline.
  - The parts table on `ScreenPart` (`src/lib/Screen.ts`) is the spec for shape. A shape change
    starts at the row, then the part, then the kit page (`/dev/kit`), then the screen. Routes lay
    out nothing: no `s-grid`, `s-stack`, `s-box`, spacing props or `className` in
    `src/routes/app.index.tsx`.
  - The copy table on `CopySlot` and the controls table on `Control` (`src/lib/Screen.ts`) are the
    spec for words and jobs. Every string on Home fills a slot; a string no slot fits is a new row,
    recorded under Deviations.
  - Status predicates are `Domain` functions, never inline comparisons in a route
    (`scripts/rules-lint.ts`). "Is setup done" and "is this step done" are predicates.
  - `scripts/rules-lint.ts` refuses reserved stems and `is<State>` predicates without their noun in
    exported identifiers under `src/lib/`, and refuses retired words in screen copy.
  - The Shape families table on the map in `src/lib/Domain.ts` holds every exported shape to a
    suffix; `pnpm spec check` enforces it.
  - No migrations while prototyping: if an index is needed, edit `initializeSchema` or
    `migrations/0001_init.sql` in place and run `pnpm dev:reset` yourself.
  - Do not commit unless the user says so.
- After each phase run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`. Keep every file
  `pnpm fmt` touches.
- Record anything that does not go as written under [Deviations and issues](#deviations-and-issues)
  as you go, under the phase's heading: what the plan said, what you found, the options you saw and
  the one you took.
- Each phase is one change. Do not merge phases.

## The decisions, in the order the phases take them

| decision (research numbering)           | what                                                                                    | phase |
| --------------------------------------- | --------------------------------------------------------------------------------------- | ----- |
| 5, 6, 13                                | the strip on Home: all five cells as links, live, sharing the orders index's memo entry | 1     |
| 1, 2, 3                                 | the three setup facts, derived, read on every load                                      | 2     |
| 4, 1 (no Sync)                          | the setup guide part: "Getting started", "1 of 3 done", no Sync button                  | 3     |
| 7, 8, 9, 10, 11, 12                     | the route: order of sections, no trial line, no primary action, no help cards, no chart | 4     |
| (follow-ups in `docs/help-research.md`) | Installing's paragraph on the home page, the Home picture                               | 5     |

## Decisions taken in writing this plan

The review can reverse any of these.

1. **The third step reads "An item gets a workflow", not "An item starts a workflow".** The
   research wrote "starts". On the screens, Start is the member's verb and **Not started** is the
   badge of an item that has a workflow nobody has started, so "starts a workflow" would say the
   opposite of the badge. The fact is unchanged: some item has a workflow.
2. **The third fact is "a `Run` row exists", in any state.** The research said "has ever started a
   workflow". Baton keeps no history beyond its rows, and retention deletes closed runs, so on a
   shop with no open work for longer than retention the step comes back undone. That is decision
   3's status reading: no item has a workflow now. Nothing new is stored to make it "ever".
3. **The guide is loader-only; the strip is live.** The first two facts change only by the
   merchant's own writes on other screens, and the loader reruns when they come back to Home. The
   third changes by webhook; a merchant watching Home for their first order sees it on the next
   visit or reload. Making the guide live would put three more reads on every invalidation for a
   page state that changes once in a shop's life.
4. **Each open step's way out is a link named for the screen, not a button.** The research sketch
   had **Create workflow** buttons and "How to" links. The create modals open in-page from
   `commandFor` (`src/routes/app.teams.index.tsx`, `src/routes/app.workflows.index.tsx`) and have
   no URL, so a **Create team** button on Home could only navigate, which is a link pretending to
   be a button. The copy table's link slot says a link takes the person to a named place and its
   text is "the target screen's heading". So step 1 links **Teams**, step 2 **Workflows**, step 3
   nothing on-screen; the empty state on each index already carries its create button. The help
   link on each step uses the help page's title (the link slot again), `target="_blank"` as the
   foot line does. "How to" is cut: it is not a heading.
5. **The research's "a row in the events table on `useLiveQuery`" is withdrawn.** That table is per
   event (identify, invalidation, visibility), not per screen; Home's live query meets the same
   events with the same hook and adds no row.
6. **The strip on Home sits in a details card headed "Orders"**, not in an `IndexSection`, which is
   an index list's frame.
7. **No trial line, and `planBoundaryAt` leaves the loader.** Dropped by the user 2026-10-08
   (research decision 8). The loader reads `planBoundaryAt` today and the component never renders
   it; with no trial line nothing will, so `AppIndexLoaderData` loses the field and the loader its
   `Match` on the status. `PlanStatus` is unchanged.

## Phase 1: the strip on Home, sharing one read

### 1.1 One default orders read, in one place

The orders index and Home must call `listOrders` with the identical input, or they are two memo
keys and two reads per publish (research, "What the strip costs"). Today the input and its helpers
live in the route file: `ORDERS_PAGE_SIZE` (25), `ordersQueryKey`, `decodeOrdersIndexData`
(`src/routes/app.orders.index.tsx`). A route file must not export them (TanStack's code split, and
the `…LoaderData` rule in `AGENTS.md` keeps route types in their route).

- Move them to a module under `src/lib/` (suggested `src/lib/ordersIndexQuery.ts`). Name the
  orders index's arrival input once: page size, no cursor, no search, no Show value (Making, the
  default), no team. Its JSDoc states the rule: the orders index on arrival and Home read the same
  `listOrders` input, so they share one entry of the object's orders memo and one React Query
  cache entry; a second input is a second read per publish.
- `app.orders.index.tsx` imports them. `src/routes/app.orders.$orderId.tsx` refers to
  `decodeOrdersIndexData` in a comment; update the reference.

### 1.2 The strip's link variant (`src/components/screen/Strip.tsx`)

- The parts table's strip row first: `used on` gains `homepage`; `what it fixes` says a cell is
  either a filter press (index) or a link to the index with that value chosen (homepage), never
  both on one strip.
- `StripCell` becomes a union: today's `{ chosen, onSelect }`, or `{ href }` with nothing chosen.
  `s-clickable` takes `href`. The accessibility label drops ", selected" for a link cell.
- The links are `/app/orders?show=<value>`. Making is the default and its link has no `show`
  (the orders index's `SHOW` comment: Making is `?show=` left out). Build the href with the
  router's search typing, not string concatenation, if the part can take a typed link; otherwise
  record the choice.
- The kit page (`src/routes/dev.kit.tsx`) shows the link strip once beside the existing ones, with
  the seed's worst-case counts.

### 1.3 Tests

- A test that the orders index and Home build the same `listOrders` input, titled as the rule
  (for example "Home and the orders index read the same listOrders input"). If both import the one
  constant this is a one-line test; keep it, since it is the rule's pin.
- `test/integration/list-memo.test.ts` already pins the memo; read it and add nothing unless the
  shared input reveals a gap.

### 1.4 Done when

The orders index behaves as before (its e2e spec green) and the link strip renders on the kit page
at desktop and phone width.

## Phase 2: the three setup facts

### 2.1 The facts and where each lives

| step                             | fact                               | store                     | read                                                                                                                                                 |
| -------------------------------- | ---------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create a team and add a member   | some team of the shop has a member | D1 (`Team`, `TeamMember`) | `exists` over `TeamMember` joined to `Team` on the shop; `Team`'s `unique (shop, name)` and `TeamMember`'s primary key `(teamId, memberId)` serve it |
| Create a workflow and turn it on | some workflow is Active            | the object (`Workflow`)   | `exists` over `Workflow` where `state = 'active'`; at most 200 rows, no index needed                                                                 |
| An item gets a workflow          | some `Run` row exists              | the object (`Run`)        | `exists` over `Run`; the primary key serves it                                                                                                       |

- D1: a `Repository` method beside `countMembers`. Name it in the vocabulary's words.
- The object: one read returning both object facts, through `ShopAgent` (the class is the callable
  surface), a service under `src/lib/agent/` (ShopWork owns workflows and runs) and
  `ShopAgentClient`, the way `getUsage` goes (`src/lib/ShopAgentClient.ts`, `src/lib/ShopAgent.ts`,
  `src/lib/agent/Billing.ts`). Not `@callable()`: Home reads it from the loader only (decision 3
  above). Its returned shape follows the Shape families table; record the family and name you
  chose.
- Check with `explain query plan` that each `exists` stops at the first row. Record the plans
  under Deviations if any reads more than one row before it answers.

### 2.2 The predicates (`src/lib/domain/ShopWork.ts`)

- The steps as data, in order, with the fact each needs; one predicate for a step's done, one for
  the guide showing (any step undone). The JSDoc on the concept states the rules once:
  - the guide is derived from facts and stores nothing; it shows while any step is undone and comes
    back when a fact stops holding (research decisions 1 and 3);
  - the third step is a `Run` row in any state, and why retention can bring it back (decision 2
    above);
  - the third step has no action on Home: orders arrive by the orders webhooks as they are placed,
    and Sync open orders is a one-time catch-up kept on the Orders page so Home never teaches it as
    a routine (research decision 1's note).
- No new vocabulary noun is expected: the facts are about team, member, workflow and item. If you
  find you need one ("setup", "step" in an exported identifier), follow
  `docs/vocabulary-runbook.md` and record it.

### 2.3 Tests

One test per rule, titled as the rule, against a real object and local D1:

- each step is undone on an empty shop and done once its fact holds;
- the guide hides when all three hold;
- the guide shows again when a fact stops holding (turn the only workflow off);
- an item with a workflow in any state completes the third step (a closed run counts);
- the D1 fact ignores another shop's team.

### 2.4 Done when

The reads and predicates exist, the tests pass, and no screen uses them yet.

## Phase 3: the setup guide part

### 3.1 The row, then the part

- A parts-table row: `setup guide`; what it fixes: a heading with the done count, then the steps
  in order, each a done mark, its sentence, its link to a screen and its help link; `homepage`
  only; never: a checkbox, a dismiss button, a progress bar, a step that comes and goes. A done step
  stays in the list, marked, with no links, so the list does not reflow as steps complete.
- The part under `src/components/screen/` (suggested `SetupGuide.tsx`) inside a details card. It
  uses only the distances and breakpoint in `src/components/screen/layout.ts`. The done mark is an
  `s-icon` (check-circle for done, an empty circle for not), with the step's state in its
  accessibility label.
- Copy slots: the heading ("Getting started") is the section heading; the count ("1 of 3 done") is
  the slot the copy table gives a count beside a heading, or a new row if none does; each step's
  sentence is a line; the third step's "New orders arrive as they are placed." is its body. The
  route passes the strings; the part holds none.

### 3.2 Kit page

Every state once: none done, one done, two done, and the long-name case at phone width. All done
renders nothing; show that the slot is empty.

### 3.3 Done when

The kit page shows each state at 1280 and 390 wide, and `pnpm lint` passes the row and the part.

## Phase 4: the route (`src/routes/app.index.tsx`)

### 4.1 The loader

- Reads, in parallel (`Effect.all`, concurrency unbounded): the plan status, usage, member count
  (as today), the D1 setup fact, the object setup facts, and `listOrders` with the shared default
  input (Phase 1).
- Drops `planBoundaryAt` and the `Match` that computes it (decision 7 above). The status is
  still resolved, for the entitlements.
- `AppIndexLoaderData` stays in the route.

### 4.2 The page, top to bottom

1. `QuotaBanners`, unchanged.
2. The setup guide, while any step is undone. Step 1 links **Teams**, step 2 **Workflows**; the
   help links go to Creating a team and adding members, Creating your first workflow, Following an
   order through its workflow (`src/lib/helpPages.ts`), each `target="_blank"`.
3. A details card headed "Orders" holding the link strip. Live: `useLiveQuery` with the shared
   query key and read, the loader's page as `initialData`, as the orders index does. Labels come
   from `Domain.ORDERS_SHOW_LABEL`; the cell order is the orders index's `STRIP` (share it with
   Phase 1's module if it is not already shared).
4. "Usage and capacity", unchanged. No trial line.
5. The foot line, unchanged.

No primary action. No help cards. No paragraph.

### 4.3 The JSDoc

Rewrite the component's JSDoc: Home answers four questions in order (set up, needs me, plan,
learn); the strip shares the orders index's read and why; the guide's rules `{@link}` the
predicates of Phase 2 rather than restating them; keep the paragraphs on no tier name, banners for
remedies only, and the Members tile's count.

### 4.4 Tests

- `e2e/home.spec.ts`: keep its three tests. Add: the strip shows five cells with the orders index's
  labels; a cell links to Orders with that value chosen (click Issues, land on the orders index with
  Issues chosen); the seeded shop shows no setup guide (the seed has teams with members, active
  workflows and runs).
- The guide's visible states are covered by Phase 2's predicate tests and the kit page; an e2e on
  an empty shop would need a second seed and is not worth it.
- `e2e/plan.billing.spec.ts` reads the meters; run it.

### 4.5 Done when

Home renders as the research's "Proposed page" with the guide hidden on the seed, the strip's
counts equal the orders index's strip, and a member pressing Start in another browser moves
Making on Home within the throttle window.

## Phase 5: help

- `src/components/help/getting-started/installing.tsx`: the paragraph that describes the home page
  (it names **Orders this billing cycle** and **Manage plan**) also says the home page shows a
  Getting started list until setup is done, then where open orders stand.
- The hubs have no bodies; their leads are the descriptions in `src/lib/helpPages.ts`, and none
  names the home page today. Leave them.
- The Home picture: add a merchant `page` picture of Home on the showcase shop to the inventory
  (`src/lib/helpPictures.ts`) and its shot to `scripts/help-screenshots.ts`, placed in Installing
  where the paragraph describes the page. Take it with `pnpm help:screenshots --section
getting-started`, look at it, then `pnpm seed`.
- `docs/help-research.md`: the screenshot spec's exceptions row drops "No Home pictures until Home
  is redesigned"; the "Home page pictures" follow-up is closed with this plan's name.

### 5.1 Done when

`test/integration/help-pages.test.ts` and the picture tests pass, the help e2e project passes, and
the picture is looked at.

## Phase 6: the whole

- `pnpm fmt`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e --`, then `pnpm seed`.
- Open Home on the dev store at 1280 and at 390 wide. Look at it with the guide hidden (the seed)
  and shown (turn every workflow off, look, turn them back on).
- Update `docs/home-research.md` with a line under Next saying the plan is implemented, and the
  memory.

## Issues found while planning

1. **The research's step wording was off-vocabulary.** "Starts a workflow" collides with Start and
   Not started. Taken as decision 1 above.
2. **"Ever" cannot be read.** Retention deletes closed runs. Taken as decision 2 above.
3. **The create modals have no URL.** A Home button cannot open them. Taken as decision 4 above.
   An alternative the review may prefer: a search param on the two indexes that opens the create
   modal on arrival, so Home's steps can be **Create team** and **Create workflow** buttons. It
   costs a search param and a modal-on-load path on two screens.
4. **`PlanStatus` cannot tell a trial from a cycle.** Moot: the trial line is dropped
   (decision 7 above).
5. **The research overclaimed an events-table row.** Withdrawn as decision 5 above.

## Deviations and issues

Builders write here as they go, under the phase. Each entry: what the plan said, what was found,
the options, the one taken.

### Phase 1

- **The module and its names.** The plan suggested `src/lib/ordersIndexQuery.ts`; taken. It holds
  `ORDERS_PAGE_SIZE`, `ordersIndexInput` (the orders index's input from its URL keys),
  `ORDERS_ARRIVAL_INPUT` (that function with every key left out, carrying the rule's JSDoc),
  `ordersQueryKey` and `decodeOrdersIndexData`. Found: the old `ordersQueryKey(shop, q, show, team,
after)` took the keys one by one, so Home could have built a matching input and a key that
  differed. Options: keep the five-argument key and trust both sites; or key from the input itself.
  Taken: `ordersQueryKey(shop, input)` reads the key off the `ListOrdersInput`, so one input is one
  key by construction.
- **`STRIP` stays in the route for now.** The plan moves it in Phase 4 if needed; Phase 1 did not
  touch it.
- **The href.** The plan asked for the router's search typing if the part can take a typed link.
  `s-clickable` takes a plain `href` string, as `MeterTile` does, and the part holds no router
  import. Taken: the part takes `href: string`; the route (Phase 4) builds each with
  `router.buildLocation({ to: "/app/orders", search: ... }).href`, the way the orders index builds its
  row links, so the search is typed by the route tree. The kit page passes `/dev/kit`.
- **`StripCell` is a union and the strip's `cells` prop is a union of two arrays**, so one strip
  cannot mix filter presses and links (the row's "never both") at the type level.
- **The test.** "Home and the orders index read the same listOrders input" is in
  `test/integration/list-memo.test.ts`, beside the memo tests; it checks the input and the query key.
  `list-memo.test.ts` already pins "a second read of the same key executes no list SQL", which is
  the memo half; nothing added there.
- Checked: the kit page's link strip at 1280 (one line of five) and 390 (three, then two);
  `e2e/orders.spec.ts` 17 passed.

### Phase 2

- **A new vocabulary word, "setup".** The plan expected none. The concept has several symbols (the
  facts, their order, two predicates, the object's half, the part in Phase 3), and "step" is taken
  (a position in a workflow) and "task" too, so the guide's entries could not be called steps in
  code. Grepped the stem: no other domain meaning under `src/`, `scripts/`, `test/` or `e2e/`
  (only TanStack's `setupRouterSsrQueryIntegration`, the Playwright `setup` project and a
  Shopify URL). Taken, per `docs/vocabulary-runbook.md`: a row in the shop work nouns table,
  "setup: the three facts a shop needs before Baton does its work ... derived, never stored",
  symbols `SetupFacts`, `setupIsComplete`, screen "Getting started, the home page's guide". An
  entry is named by its fact, not as a step: `SetupFact` is `keyof SetupFacts`
  (`teamWithMember`, `activeWorkflow`, `run`). `pnpm vocab:audit` now lists "fact" (7), "complete"
  and "hold" (1 each); "fact" is a JSDoc term on `SetupFacts`, left as is.
- **Names.** `Domain.SetupFacts` (struct, the concept, carrying the rules' JSDoc and a facts table),
  `Domain.SETUP_FACTS` (the guide's order), `Domain.setupFactHolds` (an entry done),
  `Domain.setupIsComplete` (every fact holds, so the guide hides; the guide shows on its negation).
  D1: `Repository.teamWithMemberExists(shop)`. Object: `WorkflowRepository.workflowSetupFacts()`,
  `ShopWorkAgent.workflowSetupFacts`, `ShopAgent.getWorkflowSetupFacts()` (plain RPC, role `rpc`,
  added to the "keeps the Worker's plain RPCs out of the callable surface" list in
  `shop-agent-callables.test.ts`), `ShopAgentClient.getWorkflowSetupFacts(shop)`.
- **The returned shape's family.** `Domain.WorkflowSetupFacts`, `SetupFacts` with `activeWorkflow`
  and `run` picked: the two facts about workflows, which the object holds. No suffix family:
  it is not an `Input`, `Command` or `Result`, and not screen data (`…Data` is everything one
  screen reads in one round trip, and the home page reads three other things beside it). It is a
  model shape like `OrderCounts`, so it stays in `ShopWork.ts` with no Shape families row.
- **The object read lives in `WorkflowRepository`.** The plan named the agent service but not the
  repository. One statement reads both tables; `WorkflowRepository` already touches `Run` (the
  seed's replace), so it went there rather than in `RunRepository`.
- **Query plans** (`explain query plan`, sqlite3 over `migrations/0001_init.sql` and the
  `initializeSchema` DDL):
  - D1: `SEARCH t USING INDEX sqlite_autoindex_Team_2 (shop=?)`, then
    `SEARCH tm USING COVERING INDEX sqlite_autoindex_TeamMember_1 (teamId=?)`. Stops at the first
    edge.
  - Object: `SCAN Workflow` for the first subquery and `SCAN Run USING COVERING INDEX
sqlite_autoindex_Run_2` for the second. Each `exists` stops at its first row. The `Workflow`
    scan reads every row when no workflow is active, at most 200 (`WorkflowLimits.maxWorkflows`),
    which the plan accepted ("no index needed"). `Run` reads one row of its smallest index.
- **Tests** (`test/integration/setup-facts.test.ts`, six): the plan's five, titled as the rules,
  and one more, "a team with no member does not complete the first step", since the D1 read is a
  join and a team alone must not satisfy it.

### Phase 3

- **Row and part as planned:** `setup guide` in the parts table, `SetupGuide`
  (`src/components/screen/SetupGuide.tsx`), `homepage` only, inside an `s-section` (a details card)
  labelled by the heading. The heading and the count share one line (`1fr auto`); the section's
  own `heading` prop cannot carry the count, so the part renders an `s-heading` and labels the
  section with `accessibilityLabel`.
- **The mark's accessibility label.** The plan said the state goes in the icon's accessibility
  label. `s-icon` has no `accessibilityLabel` prop (`@shopify/polaris-types`). Taken: an
  `s-text accessibilityVisibility="exclusive"` beside the icon carries the step's state, which a
  screen reader reads and the screen does not show. The icons are `check-circle` (tone success)
  and `circle` (neutral).
- **The state words are the route's.** "The part holds no strings" includes the mark's label, so a
  step carries `state` ("Done" / "Not done") from the route.
- **"So the list does not reflow."** A done step loses its links, so it does lose a line; what does
  not change is each step's place. The row and the JSDoc say "no step changes place" instead.
- **The link gap.** At the inline row's `small-300`, "Teams" and "Creating a team and adding
  members" read as one link (looked at on the kit page). Taken: `base` between a step's two links,
  written into the row's `fixes` cell and the part's JSDoc.
- **The count's copy slot moves to Phase 4.** No copy row covers a count beside a heading, so the
  count needs a new `count` row on `CopySlot`. `pnpm spec check` refuses a row whose example no
  screen shows, and in Phase 3 no screen shows the guide (the kit page is not a screen), so the row
  goes in with the route in Phase 4.
- **"All done renders nothing".** The part does not decide it: the route leaves the guide out when
  `Domain.setupIsComplete` holds, so the rule has one site. The kit page shows the empty place as a
  card headed "Setup guide, all done" with nothing in it.
- **The long-name case.** The guide's strings are fixed (no merchant names reach it); the longest
  lines are the help title "Following an order through its workflow" and the link line
  **Workflows** beside "Creating your first workflow". At 390 each fits on one line.
- Looked at: the kit page at 1280 (`?width=large`) and 390, states 0, 1 and 2 of 3 done and the
  empty all-done card.

### Phase 4

- **Two new copy rows on `CopySlot`.** No slot fit two of the guide's strings, so each got a row
  (and a `CopySlot` literal):
  - `line`: one entry of a checklist the screen reads and the person does not tick; a verb phrase
    for what the person does, or a fact for what happens on its own; no period. Example "Create a
    workflow and turn it on". The plan called a step's sentence "a line" without a row behind it.
  - `count`: how much of a list is done, on its heading's line; "<n> of <total> done", no period.
    Example "of 3 done". `pnpm spec check` wants the example verbatim in a screen file, and the
    route builds the count as `${formatNumber(doneCount)} of 3 done`, so the example is that
    string's fixed tail. Options: an example the check cannot find ("1 of 3 done"); building the
    total from `Domain.SETUP_FACTS.length`, which leaves no fixed text to cite; or the literal 3.
    Taken: the literal 3, with a comment naming `Domain.SETUP_FACTS`. A fourth fact would have to
    change the string by hand.
- **The step state words** ("Done", "Not done") are the route's, passed to the part for the
  screen-reader text beside each mark (Phase 3).
- **The step copy is a record keyed by fact** (`STEP_COPY`), not a `switch` or `Match`:
  `scripts/rules-lint.ts` refuses the string literal `"run"` in a screen file as a retired word,
  and the third fact's key is `run`. An object key is not a string literal, so the record passes,
  and `satisfies Record<Domain.SetupFact, …>` keeps it exhaustive.
- **`STRIP` moved** to `src/lib/ordersIndexQuery.ts` as `ORDERS_STRIP`, with its JSDoc widened to
  both screens; the orders index, the home page, the kit page (which had its own copy,
  `ORDER_STRIP`, now removed) and `e2e/home.spec.ts` read it.
- **The hrefs** are `router.buildLocation({ to: "/app/orders", search: {} | { show } }).href`, typed
  by the route tree (Phase 1's choice). The help links are `/help/getting-started/<slug>` strings
  with titles from `findHelpPage`, as the foot line's `/help` is a string.
- **The loader** reads the six things in one `Effect.all({ ... }, { concurrency: "unbounded" })`;
  `entitlementsOfStatus` runs after it, since it needs the status. `planBoundaryAt` and the `Match`
  are gone, and `AppIndexLoaderData` gained `setupFacts` and `orders`.
- **No `SocketBanner` on the home page.** The plan's top-to-bottom list has none and the orders index
  has one. Home has no write the socket carries; a dropped socket only stops the strip moving. Left
  out, as the plan lists.
  Reversed in review 2026-10-08: the banner's own rule (`SocketBanner`) is that a page whose
  invalidations have stopped says so, and the orders index shows it for the same live counts. A
  strip that silently stops moving is the stale-page problem the banner exists for. Added above the
  quota banners, as on the orders index.
- **e2e.** `e2e/home.spec.ts` now seeds once in `beforeAll` (a team with a member, an active
  two-task workflow, four orders: not started, started, done, started and blocked) before the boot,
  so the guide assertion does not depend on what the previous spec left. Three tests added, titled
  "the seeded shop shows no setup guide", "the strip shows five cells with the orders index's
  labels" and "a strip cell opens the orders index with that value chosen". 7 passed.
- **`e2e/plan.billing.spec.ts` was not run.** It runs only headed and by hand
  (`pnpm test:e2e:billing`): it moves the dev store's real app subscription through Shopify's
  pricing page, behind a Cloudflare bot check that a headless browser cannot pass. The meter
  locator it reads (`progress[aria-label="Orders this billing cycle"]`) is unchanged, and
  `home.spec.ts`'s "home renders a capacity meter per dimension" passed.
- **"A member pressing Start moves Making on Home within the throttle window"** is checked in
  Phase 6 (see there).

### Phase 5

- **Installing's paragraph.** The plan said the paragraph should say the home page shows Getting
  started "until setup is done, then where open orders stand". The strip shows whether or not the
  guide does, so "then" would read as the strip appearing after setup. Written as: "Until Baton is
  set up, the home page starts with a **Getting started** list: a team with a member, a workflow
  turned on, and an item with a workflow. Below it, the home page shows where your open orders
  stand, then **Orders this billing cycle** and **Members** ...". The component's JSDoc no longer
  says "No pictures" and names the guide and the strip among what it was read against.
- **The picture.** `installing1`, `getting-started/installing-1.png`, merchant, shape `page`,
  `aspectRatio` "1056/508" from the run, placed under that paragraph. Its shot is the first in
  `MERCHANT_SHOTS` (the run starts on the orders index, so the shot goes home with `gotoApp`,
  waits for the strip's Issues link and parks the pointer). Looked at: the Orders card (2, 12, 24,
  4, 3), then Usage and capacity with both tiles and Manage plan, then the foot line; no guide,
  since the showcase shop is set up. The showcase's Members tile reads "7 members, 3 included",
  the showcase's own state, not a fault of this change.
- **The section run rewrote five other pictures** (how-baton-works-1, first-order-1,
  first-workflow-1, first-workflow-2, first-team-1) with new bytes and the same aspect ratios; the
  script's JSDoc says a rerun changes bytes, not frames (the seed stamps the clock). None of their
  screens changed in this plan, so those five were restored from git and only `installing-1.png`
  is new. `pnpm seed` ran after.
- **`docs/help-research.md`**: the exceptions row no longer says "No Home pictures until Home is
  redesigned", and the "Home page pictures" follow-up is closed, naming this plan.
- Checked: `pnpm test` (the help-pages and picture tests in it) 798 passed; `--project=public`
  6 passed.

### Phase 6

- **Results.** `pnpm fmt`, `pnpm typecheck`, `pnpm lint` clean (no warnings); `pnpm test` 40 files,
  798 tests passed; `npm run test:e2e --` 95 passed (3.3 min); `pnpm seed` after.
- **Home opened in the embedded admin** through the e2e admin session (`storageStatePath`,
  `gotoApp` from `e2e/app.ts`) by a throwaway Playwright script, headless, rather than
  `playwright-cli`, which has no way to load that storage state into the admin. Looked at:
  - guide hidden (the `pnpm seed` fixture) at 1280 and 390: Orders strip (6, 21, 36, 12, 9), then
    Usage and capacity, then the foot line; at 390 the strip is three then two;
  - guide shown at 1280 and 390: "Getting started", "1 of 3 done", the team step marked done with
    no links, the workflow step with **Workflows** and "Creating your first workflow", the third
    step with its body line and help link, above the strip and the plan card.
- **"Turn every workflow off, look, turn them back on."** Done with the dev seed instead of the
  switch: one seed of a team with a member and one inactive workflow and no orders, then
  `pnpm seed` to put the fixture back. Same facts (team true, workflow false, run false), fewer
  steps through the admin.
- **The live strip** (Phase 4's "Making moves within the throttle window"): with Home open at
  "Making, 36", a seed posted from outside the page (its publish reaches every connection) wrote a
  fixture with one started order; the Making cell read "Making, 1" 212 ms later with no reload. A
  member's Start goes through the same publish, so it was not driven separately.
- The research's Next line is updated. The memory was not touched (the task said not to).
