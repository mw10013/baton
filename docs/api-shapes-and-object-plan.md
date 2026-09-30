# API shapes and the object: implementation plan

This plan carries out the round-1 decisions in `docs/api-shapes-location-research.md`. Read that doc first: Part 1 says which shape families are the domain's and why loader data is not; Part 2 measures `ShopAgent.ts`, rules out separate objects and mixins, and says why one class of delegating callables over one Effect service per context is the split. This plan says what to change, in what order, and how to know each step is done.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, in JSDoc, on the symbol that enforces it or is the concept. Other sites `{@link}` it. Rules move with their symbols and are not rewritten.
  - JSDoc never cites files under `docs/`. This plan and the research doc will be deleted.
  - A new exported identifier under `src/lib/` speaks the vocabulary: no reserved stem, no `is<State>` without its noun (`scripts/rules-lint.ts`). Nothing in this plan adds a vocabulary word.
  - Do not commit unless the user says so. In a linked worktree, stay on its `wt-NN` branch.
- After each phase run: `pnpm typecheck`, `pnpm lint` (runs `pnpm spec check`), `pnpm test`, `pnpm fmt`. Keep every file `pnpm fmt` touches.
- Record anything that does not go as written in [Deviations and issues](#deviations-and-issues) as you go: what the plan said, what you found, the two options, which you took and why.
- Each phase is one change. Do not merge phases. Phases 3 to 5 are each "one module": do not start the next until the previous passes.
- Phases 1, 3, 4 and 5 are moves, not rewrites. No symbol is renamed, no rule reworded, no table edited, except where a phase says so. A reviewer diffs each new file against the range it came from.
- Line numbers below are `src/lib/ShopAgent.ts` and the context files at commit `c306809`. Re-derive them with `grep -n` before cutting; do not trust them after Phase 1 touches a file.

## The two maps

**The domain map** (the `Contexts.` table at the top of `src/lib/Domain.ts`) does not change. Production may import Orders and Platform; Orders and Billing may import Platform (Billing also Orders, for `countedAt`); Platform imports nothing.

**The object map** is new, for the files under `src/lib/agent/`. It is the spec for Phase 3's JSDoc and Phase 6's lint.

| file                          | holds                                                                                       | may import under `agent/` | the crossing                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/lib/agent/Host.ts`       | `ShopAgentHost`: what every module needs from the object itself                             | nothing                   |                                                                                                                    |
| `src/lib/agent/Billing.ts`    | `BillingAgent`: usage, the billing cycle, the member count, the usage-event flush           | `Host`                    |                                                                                                                    |
| `src/lib/agent/Orders.ts`     | `OrdersAgent`: fetch and upsert one order, the bulk stream, the bulk operation helpers      | `Host`                    |                                                                                                                    |
| `src/lib/agent/Production.ts` | `ProductionAgent`: workflows, drafts, runs, tasks, teams, the orders index, reconcile, seed | `Host`, `Billing`         | `BillingAgent.flushUsageEvents`: every path that creates a run sends the queue (the triggers table on `ShopUsage`) |
| `src/lib/ShopAgent.ts`        | the class: the `@callable()` surface, the role guard, the runtime, connections, sync wiring | all four                  | the sync: store (orders), reconcile (production), flush (billing), publish (host)                                  |

Production importing Billing is the one edge the object map has that the domain map does not, and it is one symbol wide. The triggers table on `Domain.ShopUsage` already says every run-creating path sends the queue, and `reconcileAllNow` is where production creates runs; the alternative, appending the flush in the class after each of the six workflow callables, puts a billing rule in six places. Do not widen the edge: `ProductionAgent` imports nothing else from `agent/Billing.ts`.

Every `agent/` file imports the domain through `@/lib/Domain`, never a context file (the existing lint). Nothing outside `src/lib/ShopAgent.ts` imports an `agent/` file; the class is their only consumer, and the tests keep reaching the object through its stub.

# Part 1: the shapes

## Phase 1: loader data to its route

Goal: every `…LoaderData` type lives in the route module that owns it; the barrel defines nothing; the ownership rule has one owner.

1. Move each type below into its route file, directly above the `getLoaderData` server function that `satisfies` it. Move its JSDoc with it, unchanged, except: a `{@link X}` to a domain symbol becomes `{@link Domain.X}` (the route imports `* as Domain`), and the leading route-id sentence (`` `/app/teams` (`app.teams.index`). ``) is deleted, because the file is the route. Export nothing new from the route: the type is module-private (`interface TeamsIndexLoaderData`), since the route is its only reader. Where a second file reads it (rows marked below), export it from the route and import it there by path, or replace the use with the domain type the row names.

   | type                       | from                             | to                                       | note                                                                                                                                                                                                                                             |
   | -------------------------- | -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `LoginLoaderData`          | `domain/Platform.ts` 278–281     | `routes/login.tsx`                       |                                                                                                                                                                                                                                                  |
   | `AdminShopLoaderData`      | `domain/Billing.ts` 536–561      | `routes/admin.shop.$shop.tsx`            | its JSDoc is the ownership rule; step 2 moves the rule, the type keeps one line. Also read by `ShopAgentClient.ts` line 64, in prose only: reword to "the route's `getLoaderData`".                                                              |
   | `AppIndexLoaderData`       | `domain/Billing.ts` 563–578      | `routes/app.index.tsx`                   |                                                                                                                                                                                                                                                  |
   | `OrderLoaderData`          | `domain/Production.ts` 1857–1858 | deleted                                  | no reader; `app.orders.$orderId` returns `Domain.OrderPageData \| null` from the client already                                                                                                                                                  |
   | `WorkflowsIndexLoaderData` | `domain/Production.ts` 1860–1863 | `routes/app.workflows.index.tsx`         |                                                                                                                                                                                                                                                  |
   | `WorkflowLoaderData`       | `domain/Production.ts` 1865–1866 | `routes/app.workflows.$workflowId.tsx`   | read by the workflow editor too (`$workflowId_.edit`); the editor's `getLoaderData` returns the client's `Domain.WorkflowPageData \| null` and needs no alias. `suggestedCopy` (line 100) types its parameter `Domain.WorkflowPageData \| null`. |
   | `MembersLoaderData`        | `domain/Production.ts` 1868–1877 | `routes/app.members.tsx`                 |                                                                                                                                                                                                                                                  |
   | `TeamsIndexLoaderData`     | `domain/Production.ts` 1879–1887 | `routes/app.teams.index.tsx`             |                                                                                                                                                                                                                                                  |
   | `TeamLoaderData`           | `domain/Production.ts` 1889–1900 | `routes/app.teams.$teamId.tsx`           | `extends TeamDetail` becomes `extends Domain.TeamDetail`                                                                                                                                                                                         |
   | `RunListLoaderData`        | `domain/Production.ts` 1902–1922 | `routes/shop.$shop.workflows.index.tsx`  | `{@link sameRunQuery}` becomes `{@link Domain.sameRunQuery}`; `MemberAccess["teams"]` becomes `Domain.MemberAccess["teams"]`                                                                                                                     |
   | `RunLoaderData`            | `domain/Production.ts` 1924–1931 | `routes/shop.$shop.workflows.$runId.tsx` |                                                                                                                                                                                                                                                  |
   | `OrdersIndexLoaderData`    | `Domain.ts` 118–131              | `routes/app.orders.index.tsx`            | its JSDoc (why `usage` is loader-only) moves with it. `ShopAgent.ts` line 1685 cites it in prose: reword to "the orders index's loader data". The two `import type` lines at the top of `Domain.ts` go.                                          |

2. The ownership rule. The JSDoc on `AdminShopLoaderData` (Billing 536–548: `<RoutePrefix>LoaderData` names the contract, the prefix derives from the route id, ownership not exclusivity, the module-private `getLoaderData`, promote rather than bend) moves to `ShopAgentClient.ts`, into the "Loader reads versus socket reads" section of the class JSDoc, as its own paragraph beginning `**Loader data.**`. It gains one sentence: "The type lives in its route, module-private, above its `getLoaderData`; `scripts/rules-lint.ts` refuses a `LoaderData` export anywhere else." The sentence in that section that says "(see `Domain.AdminShopLoaderData` for the contract naming)" becomes "(the rule below)". Each moved type's JSDoc that restated part of the rule ("`null` is not found", route id in backticks) keeps only what is specific to that page.
3. `src/lib/Domain.ts`: delete the `OrdersIndexLoaderData` interface and its two `import type` lines. In the map's JSDoc, the sentence "and defines one thing of its own, `OrdersIndexLoaderData`, the one page shape that reads two contexts, until the loader-data types leave the domain" becomes "and defines nothing of its own: a page shape that reads two contexts is loader data, and loader data lives in its route". The file is then the map and four `export *` lines.
4. `scripts/lib/rules-lint.ts` gains `loaderDataExportHits(file, source)`: for a file under `src/` that is not under `routes/`, every name from `exportedNames(source)` ending in `LoaderData` is a hit. JSDoc, in the file's style: `**Loader data lives in its route.** ...`, one sentence, linking the rule on `ShopAgentClient` by name. `scripts/rules-lint.ts` runs it and prints `rules-lint: <file> exports <name>; loader data lives in its route (the rule on ShopAgentClient)`.
5. `test/integration/rules-lint.test.ts` gets a `describe("loader data lives in its route")` with: a `LoaderData` export under `lib/` is refused; the same name under `routes/` is allowed; a local (non-exported) type is ignored.
6. `AGENTS.md`, the bullet that starts "The map at the top of `src/lib/Domain.ts`", gains: "A `…LoaderData` type lives in its route; `scripts/rules-lint.ts` refuses the export elsewhere."

Done when: `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; `grep -rn "LoaderData" src/lib` returns only the rule's prose on `ShopAgentClient` and the lint; `git diff --stat` touches the twelve routes, the three context files, `Domain.ts`, `ShopAgentClient.ts`, `ShopAgent.ts` (one prose line), `scripts/`, the lint test and `AGENTS.md`, nothing else.

## Phase 2: the shape families on the map

Goal: the five suffix families are stated once, on the map, and `pnpm spec check` holds every export to its row.

1. In the map's JSDoc in `src/lib/Domain.ts`, after the `Shared words.` table and before `What a word must pass to get a row:`, add a paragraph whose first line begins `Shape families.` and this table. The paragraph says: these are the developer dialect's suffixes for what crosses a boundary, not vocabulary words; a word here gets no nouns row; the rule for each family is on the symbol its row names.

   | family      | suffix                              | what it is                                                     | decoded by                                  | lives in                       | rule on                                       |
   | ----------- | ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------- | ------------------------------ | --------------------------------------------- |
   | input       | `Input`                             | what the browser or the Worker sends, and nothing more         | the object's `@callable()` gate             | its context file               | `MarkTaskDoneInput`                           |
   | command     | `Command`                           | the whole write, input joined to the actor from the connection | nothing; assembled from decoded values      | `Production.ts`                | `StartTaskCommand`                            |
   | result      | `Result`                            | the outcomes of one write, a tagged union                      | `ShopAgentClient` on the way back           | its context file               | `ApplyResult`                                 |
   | screen data | `PageData`, `IndexData`, `ListData` | everything one screen reads, in one round trip                 | `ShopAgentClient`                           | `Production.ts`                | `OrdersIndexData`                             |
   | loader data | `LoaderData`                        | a route's loader contract, owned by the route                  | nothing; `satisfies` on the server function | the route, under `src/routes/` | `ShopAgentClient` (its loader-data paragraph) |

   The `rule on` cell names the symbol whose JSDoc holds the family's rule. `MarkTaskDoneInput` holds the "what the browser sends and nothing more" rule (Production 3248–3260); `StartTaskCommand` the command rule (3306–3325); `ApplyResult` gets one sentence added to its JSDoc: "Every `…Result` is a union of tagged outcomes and each non-`Ok` tag names what the domain refuses; the tag, not a thrown error, is what the page branches on." `OrdersIndexData` already holds the screen-data naming rule.

2. `scripts/lib/spec.ts`: `checkContexts` exempts the table whose intro starts with `Shape families.`, as it exempts `Screens.` (the rows name no context). Add `checkShapeFamilies(barrel, sources)`, where `sources` is a map of path to source for the four context files, `ShopAgentClient.ts` and every file under `src/routes/`: for each row, the `rule on` symbol is an export of, or the class in, one of the sources (report "Shape families <family>: rule symbol <name> not found"); for each source under `src/lib/domain/` and each export whose name ends in a row's suffix, the file is what the row's `lives in` allows (`its context file` allows any of the four; a named file allows that one; `the route` allows none under `domain/`), else report "Shape families <family>: <name> is in <file>, the row says <lives in>". Suffix match is on the whole suffix at the end of the name, longest suffix first, so `OrdersIndexData` matches `IndexData` and not `Data`.
3. `scripts/spec.ts` runs it and `pnpm spec print` renders the parsed rows after the map.
4. `test/integration/spec.test.ts` gets a `describe("the shape families table")`: the real table parses and every rule symbol exists; a row whose rule symbol is doctored is reported; a `Command` export placed in `Orders.ts` (a doctored source) is reported.
5. `AGENTS.md`, the same bullet as Phase 1 step 6, gains: "The `Shape families` table on the map names the suffix families (`Input`, `Command`, `Result`, screen data, `LoaderData`), where each lives and the symbol that holds its rule; `pnpm spec check` holds every export to its row."

Done when: `pnpm spec check` parses the table and passes; the three new tests pass; `pnpm vocab:audit` no longer needs "loader" or "command" explained (they are still listed; the audit is an audit).

# Part 2: the object

## What stays in `src/lib/ShopAgent.ts`

The class file keeps, in this order, and a reviewer can check the list against the file:

- the imports it still needs;
- `ShopAgentNotifyError`, `decodeConnectionState`, `connectionState`, `connectionStateFromHeaders`, `memberConnectionTag`, `setSubscription`, `ShopAgentForbiddenError`, `CallerRole`, `forbidden`, `connectionRoleGuard`, `callableEffect`, `memberCallableEffect` (lines 82–300): the role guard and the decode are the surface, and they read `getCurrentAgent`, which only the class may;
- `makeRunEffect` and `shopifyAdminLayer` (302–370), changed by Phase 3 to build the host and the three module layers;
- `SHOP_AGENT_BINDING`, `IMPORT_IN_FLIGHT`, `isWorkflowInstanceNotFoundError`, `IMPORT_STALE_MS`, `importRowIsFresh`, `OrderWebhookInput`, `OrdersSyncErrorInput`, `OrdersStreamInput` (727–792): the sync wiring's own;
- `PublishScope`, `PublishTeams`, `unionTeams` (794–828);
- the class JSDoc and the class: `importStarting`, the constructor, `onConnect`, `getConnectionTags`, `subscription`, `connections`, `publishTo`, `closeMemberConnections`, `revokeMemberConnections`, `revokeAllConnections`, `publish`, `unsubscribe` (915–1246);
- the sync wiring: `fetchAndUpsertOrder` stays only as a two-line delegation if Phase 4 leaves it a class method; `syncOrders`, `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`, `syncOrder` (1332–1774) and `resyncOrder` (1935–1953) stay whole, calling the modules;
- every `@callable()` and plain RPC method, as a delegation.

The class JSDoc's two rules ("A tracking row disables Import open orders only while it is fresh", "The action set is the one gate") stay where they are; the second is on `requireRunAction`, which moves in Phase 5, so its text moves with it and the class JSDoc links it.

## The shape of a delegation

Every callable becomes the decorator, the signature, the guard and decode (which stay in the class, because they read the connection), and one call into a module service. The effect the module returns takes the decoded input, and for a member method the `Domain.MemberConnectionState` the guard proved:

```ts
@callable()
merchantBlockRun(
  input: typeof Domain.BlockRunInput.Encoded,
): Promise<Domain.RunResult> {
  return this.runEffect(
    callableEffect("ShopAgent.merchantBlockRun", Domain.BlockRunInput, {
      role: "merchant",
      parse: { onExcessProperty: "error" },
    })((decoded) =>
      Effect.flatMap(ProductionAgent, (production) =>
        production.merchantBlockRun(decoded),
      ),
    )(input),
  );
}
```

A plain RPC method (no decorator, `role: "rpc"` or a bare `Schema.decodeUnknownEffect`) delegates the same way. The method keeps a one-line JSDoc that names what it does and links the module effect for the rule: `/** The merchant blocks a run; the rule is on {@link ProductionAgent}'s `merchantBlockRun`. */`. The rule text itself (the long JSDoc on the method today) moves onto the module's method in the service interface, unchanged.

The log span name stays `ShopAgent.<method>`: the logs are the object's, and nothing downstream should notice the split.

## Phase 3: the host and the billing module

Goal: the host service exists and one small module proves the pattern end to end.

1. Create `src/lib/agent/Host.ts` with `ShopAgentHost`, a `Context.Service` in the style of `src/lib/Auth.ts`. Its interface is exactly what the modules need from the object and nothing the object can do without them:

   ```ts
   readonly shop: Effect.Effect<string>;                    // `this.name`, read lazily: the SDK sets it after construction
   readonly publish: (touched: PublishScope, teams?: PublishTeams) => Effect.Effect<void>;
   readonly setSubscription: (subscription: Domain.Subscription | null) => Effect.Effect<void>;   // on the calling connection, via getCurrentAgent
   readonly closeMemberConnections: (memberIds: readonly string[]) => Effect.Effect<void>;
   ```

   `PublishScope` and `PublishTeams` move here from `ShopAgent.ts` 794–801 with their JSDoc, exported; `unionTeams` stays in the class. The JSDoc on `ShopAgentHost` states the object map (the table above, as prose or a table) and says: the host is the object's fan-out and identity, built once per instance in the constructor; a module never touches a connection, the SDK or `this`.

2. `makeRunEffect(env, storage, host: ShopAgentHost["Type"])`: adds `Layer.succeed(ShopAgentHost, host)` to the merged layer, and, from this phase on, each module's layer. The constructor builds `host` from `this` (`publish: (touched, teams) => this.publish(touched, teams)`, and so on) and passes it. `this.name` is read inside `shop`, not captured.
3. Create `src/lib/agent/Billing.ts` with `BillingAgent`, a service whose layer requires `OrderRepository`, `ShopifyAppEvents`, `Repository` (for the member count) and `ShopAgentHost`. Move into it, with JSDoc unchanged:
   - `flushUsageEvents` (372–420), as the service's `flushUsageEvents: Effect.Effect<void>` (the shop comes from the host);
   - the bodies of `getUsage` (1775–1799), `setBillingCycle` (1800–1820), `recordMemberCount` (1821–1862), `reconcileUsage` (1863–1912), and the class's `flushUsageEvents` RPC (1913–1934), each as a service method taking the decoded input.
4. The five methods in the class become delegations. Every other call to the module-level `flushUsageEvents(shop)` in the class (the sync wiring, `merchantAttachWorkflow`, `resyncOrder`, `seedOrders`, `reconcileAllNow`) becomes `Effect.flatMap(BillingAgent, (billing) => billing.flushUsageEvents)`; a helper `const flushUsageEvents = Effect.flatMap(BillingAgent, (b) => b.flushUsageEvents)` at module scope in the class file is fine.
5. `test/integration/shop-agent-usage-flush.test.ts` and `shop-agent-orders-ceiling.test.ts` reach these methods through the stub and do not change. If one imports a moved helper, update the import and record it.

Done when: typecheck, lint and tests pass; `ShopAgent.ts` no longer defines `flushUsageEvents` or the four billing bodies; `wc -l src/lib/agent/Billing.ts` is recorded in Deviations (expected about 250).

## Phase 4: the orders module

Goal: what the object does with an order as Shopify's thing is one file; the sync wiring in the class reads as store, reconcile, flush, publish.

1. Create `src/lib/agent/Orders.ts` with `OrdersAgent`, layer requiring `OrderRepository`, `Shopify`, `FetchHttpClient` and `ShopAgentHost`. `ShopifyAdmin` stays per call (see `shopifyAdminLayer`): the module method takes the session as an argument and provides the layer itself, the way the class does today. Move into it:
   - `fetchAndUpsertOrder` (1247–1331), as `fetchAndUpsertOrder(input, afterWrite)`, where `afterWrite` is the per-order effect the caller supplies (the same parameter `runShopAgentOrdersStream` already takes). The module never imports `agent/Production.ts`; the class passes production's reconciler in.
   - the bulk operation helpers the stream handlers use that are orders' (`isWorkflowInstanceNotFoundError`, `importRowIsFresh` stay in the class: they are about the Cloudflare Workflow instance, the wiring's concern).
   - `runShopAgentOrdersStream` stays in `src/lib/ShopAgentOrdersStream.ts`; the module re-exports nothing. If it reads more naturally as a method of `OrdersAgent`, move the file under `agent/` as `OrdersStream.ts` and record it; do not change its body.
2. The class's `syncOrders`, `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`, `syncOrder` and `resyncOrder` stay in the class and call `OrdersAgent` for the store, `this.reconciler(source)` (until Phase 5 moves it) for the reconcile, `BillingAgent` for the flush and `this.publish` for the push. The JSDoc on `syncOrders` gains one sentence naming the four steps and the modules that own them; the rest of its text is unchanged.
3. `test/integration/shop-agent-orders-stream.test.ts`, `orders-sync-workflow.test.ts` and `shopify-webhook.test.ts` do not change.

Done when: typecheck, lint and tests pass; `wc -l src/lib/agent/Orders.ts` recorded (expected about 150; the module is small, and that is fine: it is the file the lint holds, not a size target).

## Phase 5: the production module

Goal: the object's production code is one file, the class is the callable surface.

1. Create `src/lib/agent/Production.ts` with `ProductionAgent`, layer requiring `WorkflowRepository`, `RunRepository`, `OrderRepository` (for `readOrders`), `Repository` (D1 teams), `BillingAgent` (the one crossing) and `ShopAgentHost`. Move into it, JSDoc unchanged, in the order they appear in the class:
   - the result mappers `workflowResult`, `applyResult`, `discardResult`, `draftResult`, `switchResult`, `changeActivatedAtResult`, `taskResult`, `runResult` (434–726);
   - `orderTeamIds` (811–825), `MERCHANT`, `memberActor` (830–846), `requireRunAction`, `requireTaskAction` (848–903), `merchantTaskCommand`, `seedReadyTasks` (905–913);
   - `readOrders`, `listOrders`, `subscribeOrders` (1954–2037): the orders index is production's reading, and the subscribe attaches through `host.setSubscription`;
   - `listWorkflows` through `removeWorkflow` (2038–2513);
   - `teams`, `eligibleContext`, `reconcileAllNow`, `reconcileAllIfOn`, `reconciler` (2514–2646); `reconciler` is exported on the service so the class's sync wiring can pass it to `OrdersAgent.fetchAndUpsertOrder` as `afterWrite`;
   - `readOrderDetail` through `merchantUnblockRun` (2647–3142);
   - `publishToTeams` (3143–3169), which reads `RunRepository` and calls `host.publish`; it is production's because "the teams a write could have changed" is a production question;
   - `readRuns` through `memberUnblockRun` (3170–3583), `teamExists` through `merchantAssignRunTaskTeam` (3584–3940), `seedWorkflows`, `seedOrders` (3941–4286), `listTeamWorkflows`, `listAllTeamWorkflows`, `countTasksByTeam` (4287–4322).
2. Each moved body becomes a method on the service interface with the same name, taking the decoded input (and `Domain.MemberConnectionState` for the `member*` methods). The class methods become delegations; the `member*` ones use `memberCallableEffect` exactly as today and pass `member` through.
3. The class JSDoc's "The action set is the one gate" paragraph moves with `requireRunAction`; the class JSDoc keeps one sentence linking it.
4. Every remaining `this.reconciler(...)` in the class's sync wiring becomes `Effect.flatMap(ProductionAgent, (p) => p.reconciler(source))`.
5. Tests reach every method through the stub and do not change. `run-actions.test.ts` reads `domain/Production.ts?raw`, untouched.

Done when: typecheck, lint and tests pass; `wc -l src/lib/ShopAgent.ts src/lib/agent/*.ts` recorded (expected roughly class 1,600, Production 2,200, Orders 150, Billing 250, Host 80); `grep -c "@callable" src/lib/ShopAgent.ts` is unchanged from before Phase 3 (66 including prose mentions; record the exact number before you start).

## Phase 6: the lint, the docs, and the contracts checkpoint

Goal: `pnpm lint` holds the object map; the reader knows where things are; the follow-up the research recorded is decided.

1. `scripts/lib/rules-lint.ts`: `contextImportHits` gains a second map, the object map, read from a constant `OBJECT_MAP` in the same file (`Host: []`, `Billing: ["Host"]`, `Orders: ["Host"]`, `Production: ["Host", "Billing"]`) with the map's JSDoc; a file under `lib/agent/` may import under `agent/` only what its row allows; any file under `src/` that is not `lib/ShopAgent.ts` or under `lib/agent/` may not import `@/lib/agent/…` or a relative path into it. Messages in the existing style.
2. `test/integration/rules-lint.test.ts`: Orders importing Production is refused; Production importing Billing is allowed; Billing importing Production is refused; a route importing `@/lib/agent/Production` is refused; `ShopAgent.ts` importing all four is allowed.
3. `AGENTS.md`: the "Project" section's line "Per-shop state lives in the `ShopAgent` Durable Object (`src/lib/ShopAgent.ts`) and its private SQLite" gains "; the class is the callable surface and the sync wiring, and what it does per context is a service under `src/lib/agent/` (`Host`, `Billing`, `Orders`, `Production`), whose import direction `scripts/rules-lint.ts` holds." The map bullet gains "`src/lib/agent/` has its own map, on `ShopAgentHost`."
4. The contracts checkpoint, from the research's Follow-ups. Measure and record in Deviations: `wc -l src/lib/domain/Production.ts`; the number of `{@link}`s in `domain/Production.ts` from a shape (`Input`, `Command`, `Result`, `PageData`, `IndexData`, `ListData`) to a model symbol and the reverse; how many symbols a contracts file would hold. Then write one paragraph under Deviations titled "Contracts file: decision" saying whether a `domain/ProductionContracts.ts` (or `contracts/Production.ts`) is worth those cross-file links now, and why. Do not implement it in this plan either way; if yes, it is its own plan. This step is not optional and the plan is not done without the paragraph.

Done when: `pnpm lint` passes on the tree; the five new cases pass; the paragraph exists.

## Not in this plan

- A contracts file per context (Phase 6 step 4 decides; a separate plan implements).
- Moving `Command` rules to `RunNote` or `Actor` (decision 3: keep).
- Any change to `ShopAgentSchema.ts`, the repositories, `worker.ts`, the routes' server functions beyond the loader-data type, or any test that reaches the object through its stub.
- Any rename. A module method keeps the class method's name; a moved helper keeps its name.

## Deviations and issues

Record here as you go. For each: the phase and step, what the plan said, what you found, the options, what you did.

**Line counts.** Before Phase 3: `ShopAgent.ts` 4,322 (49 `@callable()` decorators; `grep -c "@callable"` 66 counting prose). After Phase 3: class 4,201, `agent/Billing.ts` 197, `agent/Host.ts` 64. After Phase 4: class 4,141, `agent/Orders.ts` 133. After Phase 5: class 2,281, `agent/Production.ts` 2,514, `agent/Orders.ts` 131, `agent/Billing.ts` 197, `agent/Host.ts` 73. Decorators: 49 before and after. `grep -c "@callable"` is 59, not 66: the seven lost are prose mentions ("`@callable()` so the `/app` socket can read it", "Plain RPC, not `@callable()`") in JSDoc that moved to the modules with its method. The class is 2,281, not the expected 1,600: every callable keeps its signature and its `callableEffect` head (name, schema, role, parse), which is about 12 lines a method across 59 methods, and the sync wiring (`syncOrders`, `onOrdersStream`, `syncOrder`, the workflow callbacks) stayed whole.

**Phase 1.**

- Step 1, `ShopAgentClient.ts` line 64. The table said reword to "the route's `getLoaderData`"; step 2 said "(the rule below)". Both name the same sentence. I took step 2's wording, since the rule now sits in the same section.
- Step 1, `OrderLoaderData`: deleted as planned. My first cut removed only its JSDoc line; the lint added in step 4 caught the stray export, which is the lint doing its job.
- Step 1, JSDoc on the moved types. `LoginLoaderData` and `WorkflowsIndexLoaderData` had only the route-id sentence, so they now have no JSDoc. `WorkflowLoaderData` kept "`null` is not found." `AdminShopLoaderData` keeps one line: "The shop's D1 row, plan and usage, or `NotFound` when the shop has no row."
- Step 1, `app.workflows.$workflowId.tsx`: its `getLoaderData` has no `satisfies` (it returns the client's value). The type sits above it and types the component's `detail`, as before.

**Phase 2.**

- Step 2: `checkVocabulary` also had to skip the Shape families paragraph. Otherwise it treats the suffix cells (`Input`, `PageData`, `LoaderData`, ...) as vocabulary words that must occur elsewhere in `Domain.ts`. It strips the paragraph and its table before collecting words. `checkShapeFamilies` checks the table's rule symbols instead.
- Step 2: `checkShapeFamilies` reads exports with its own regex rather than `exportedNames` from `scripts/lib/rules-lint.ts`, because that module imports `spec.ts` and the reverse import would be circular.
- Step 3: `pnpm spec print` prints the Shape families rows first, not "after the map": print does not render the map.

**Phase 3.**

- Step 1, the host's interface. Two things the plan did not list were needed, because a module never touches the SDK or `this`: `databaseSize` (read by `getUsage`, from `this.ctx.storage`) and `importInFlight(now)` (read by the orders index, from the SDK's `getWorkflows`). Both are on `ShopAgentHost`. The "Read, never refreshed" comment moved to the host builder in the constructor, beside the `getWorkflows` call it describes.
- Step 1, `shop`. The plan typed it `Effect.Effect<string>`. It is `() => string`, read at call time. Laziness holds either way, and the function form leaves each moved body's `const shop = this.name;` as `const shop = host.shop();` rather than re-wrapping every body in `Effect.flatMap`.
- Step 3, `flushUsageEvents`. The plan typed it `Effect.Effect<void>`. It keeps its result (`{ sent, remaining }`), because the class's RPC `flushUsageEvents` answers `remaining`. The RPC body is one line in the class (`flush.remaining`) rather than a second service method with the same name.
- Step 3, the billing layer's requirements are `OrderRepository`, `ShopifyAppEvents` and `ShopAgentHost`. `Repository` is not needed: `recordMemberCount` takes the count from the Worker and never reads D1.
- Step 3, JSDoc links. `flushUsageEvents`'s `{@link ShopAgent.reconcileAllNow}` became prose ("`ProductionAgent`'s `reconcileAllNow`"), since Billing may not import Production.
- The shape of a delegation. The plan's example uses `Effect.flatMap(ProductionAgent, (p) => ...)`. oxlint reads the data-first call as an array method with a `thisArg` (`unicorn(no-array-method-this-argument)`), and the service's `.use` trips `react-hooks(rules-of-hooks)` at module scope. The delegations use `ProductionAgent.pipe(Effect.flatMap((production) => ...))`, the form the object already used for repositories.
- Module services capture their dependencies with `Effect.context<...>()` at build time and provide them to each method (`Effect.provideContext`), so the moved bodies keep their `yield* OrderRepository` lines unchanged and the service methods need no requirements.

**Phase 4.**

- Step 1, the per-order reconcile. The plan said `fetchAndUpsertOrder(input, afterWrite)`. The module takes the reconciler effect, not the per-order function, and yields it after the fetch. Passing the function would load the eligible context before the fetch, including for an order Shopify answers `null` for, which is a D1 read the old code skipped. The class passes production's reconciler; the module never reads production.
- Step 1, `shopifyAdminLayer` moved to `agent/Orders.ts` with its JSDoc. The plan listed it as staying in the class, but the class no longer uses it once the fetch moves; the module provides it per call, as planned.
- Step 1, the orders layer requires `OrderRepository`, `Shopify` and `ShopAgentHost`. `FetchHttpClient` is not in the fetch's requirements. There were no bulk-operation helpers left to move: the stream is `runShopAgentOrdersStream`, which stays in its file, and the helpers that remained are the Workflow instance's, which stay in the class. `agent/Orders.ts` is one method.
- Step 2, the four-steps sentence went on `syncOrder` (the webhook path), not `syncOrders`. `syncOrders` starts the import and neither stores nor reconciles; `syncOrder` is where the four steps run.

**Phase 5.**

- `unionTeams` moved to `agent/Host.ts`, not left in the class. Both the class's `syncOrder` and production's `merchantAssignRunTaskTeam` use it, and a function of `PublishTeams` belongs beside that type.
- `orderTeamIds` is exported from `agent/Production.ts`. The class's `syncOrder` reads the same teams on both sides of its write. The object map allows the class to import all four modules, so this is inside the map.
- Step 3, the class JSDoc. "The action set is the one gate" was already on `requireRunAction`, not the class, and moved with it. The class had no JSDoc of its own: the concurrency note sat orphaned above `PublishScope`. It now sits on the class and gained the sentence that links the gate.
- Two class JSDocs stayed on the class rather than moving: the `<role><Verb>` naming rule (on `merchantListRunsForOrder`) and "Member-area methods. Two idioms..." (now on `listRuns`). Both are rules about the callable surface, which is the class.
- `readRunPage` became a module-level function in `agent/Production.ts` because it captures nothing, which oxlint's `consistent-function-scoping` requires. The class's sync wiring got two module-level helpers for the same reason: `reconcilerFor(source)` and `fetchAndUpsertOrder(orderId, source)`.
- `seedWorkflows` and `seedOrders` read `ENVIRONMENT` from `CloudflareEnv` in the runtime instead of `this.env`. It is the same object; the class passes `env` to `makeEnvLayer`.
- The service's `reconciler` is exported wrapped in the module's provide, so the class's sync wiring gets an effect with no requirements beyond `ProductionAgent`.
- The test log shows the same `uncaught exception` lines (workflow errors, a hung-request cancel) before and after Phase 5. I compared them against the Phase 4 tree: identical, so they are pre-existing.

**Phase 6.**

- Step 1: the object map is a separate function, `objectImportHits`, beside `contextImportHits`, with its own constant `OBJECT_MAP` and message. The two maps differ in shape (one is read from a table, the other is a constant) and in the exemption (the barrel versus the class), so one function with two maps would branch on everything.
- Step 3: the object map table is on `ShopAgentHost`, with a `may import` column that `OBJECT_MAP` restates. The lint does not parse the table; the JSDoc on `OBJECT_MAP` names the table as its source.
- Step 4 measurements, `src/lib/domain/Production.ts`: 3,383 lines, 197 exports. 68 are shapes (`Input`, `Command`, `Result`, `PageData`, `IndexData`, `ListData`) and 129 are model. The shapes take about 870 lines with their JSDoc. `{@link}`s in the JSDoc directly on an export: 18 from a shape to a model symbol, 8 from a model symbol to a shape (`TaskState` to three results, `RunNote` to `SetRunNoteCommand`, `WorkflowDraftDetail` to `WorkflowPageData` twice, `SeedOrderChange` to `SeedOrdersInput`, `OrderCounts` to `ListOrdersInput`), and 19 between shapes. In code, the shapes use 32 distinct model symbols, and no model symbol uses a shape. A contracts file would hold the 68 shapes and import 32 model symbols.

**Contracts file: decision.** Not now. The split would be clean in direction, because code dependencies run one way (shapes use the model, never the reverse), but it buys only file size. `domain/Production.ts` would go from 3,383 to about 2,500 lines. In exchange, 26 JSDoc links would cross files, a 32-symbol import would appear, and the Shape families table, its `lives in` cells and `checkShapeFamilies` would have to learn a sixth file. No reader today needs the shapes without the model: the object reads both, and the routes read both through the barrel. The one-way dependency means the split stays mechanical whenever it is done. The trigger to revisit is a consumer that needs the shapes and not the model, such as a public API package or a client bundle that must not carry the model's rules.

**Review fixes** (after the implementation, checked against `c306809`: no body changed, no method missing, every delegation head matches).

- `agent/Host.ts`: the `ShopAgentHost` JSDoc opened with a bare line inside the comment; fixed.
- The surface rules ("Plain RPC, not `@callable()`…", "`@callable()` so the `/app` socket can read it", the `CALLABLE_ROLES` paragraph on `merchantMarkTaskDone`, "One callable rather than…" on `seedWorkflows`) had moved into the modules with their methods, where no decorator exists. They are rules about the callable surface, which is the class, so they are on the class delegations now, the way the `<role><Verb>` naming rule and the member idioms already were. The module methods keep the domain reasoning.
- The modules captured `Effect.context` at build and merged it over every call (`Effect.provideContext`), which lets anything present at layer build (the layer's `Scope`) shadow the call's value. Removed: the service methods carry their requirements, and the class's runtime provides them.
- `orderTeamIds` is on the `ProductionAgent` service instead of a second export from the module; the class's `syncOrder` reads it through the service.
- `listWorkflows` is back in class order (after `subscribeOrders`).
- The service's `reconciler` JSDoc said the class passes it "as `afterWrite`"; it is the `reconciler` argument, and the function it yields is the `afterWrite`.
- `shopifyAdminLayer`'s JSDoc drops `Env` from "the stack's other requirements": `ShopifyAdmin.layerNoDeps` needs only `Shopify` and `CurrentShopifySession`. `flushUsageEvents`'s `{@link ShopAgent.reconcileUsage}` is `{@link reconcileUsage}`, the module-local. Both were reworded in the move and not recorded.
- `{@link D1_TABLES}` on `deleteTeam` was never an import (pre-existing); it is prose with the file now.
- `setBillingCycle`, `merchantListRunsForOrder`, `listTeamWorkflows`, `listAllTeamWorkflows` and `countTasksByTeam` capture nothing once the provide wrapper is gone, so they are module-level (oxlint `consistent-function-scoping`), like `readRunPage`.
