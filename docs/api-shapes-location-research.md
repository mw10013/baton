# After the context split: the API shapes, and the object

Follows `docs/spec-location-research.md`, whose round-2 decisions left two things for later: decision 5, "the API shapes stay in their context file; a contracts split is a later question", and the note that `ShopAgent.ts` hosts all three contexts in one class and is "the next thing the map would ask about". The bounded-contexts split has landed (`c306809`). Part 1 is the shapes; Part 2 is the object; the recommendation at the end takes both together, because the answer to one changes the other.

# Part 1: the API shapes

## The question

Part 2 of the spec-location research measured that 178 of the 460 exports in the old `Domain.ts` were `…Input`, `…Result`, `…LoaderData`, `…Command`, `…Data`, `…Row`: "the contracts between the routes, the client and the object. They speak the vocabulary but they are not the model." The split moved them into the context files by the words they speak. Three things now ask whether that was the right home:

1. **They are a second axis.** The context files are cut by language (where a word changes meaning). The shapes are cut by transport (what crosses which boundary). A file cut by one axis holds the other axis interleaved.
2. **Some span contexts.** `OrdersIndexLoaderData` reads production and billing, and no context file may import both, so it sits in the barrel, `Domain.ts`, as the one thing the barrel defines. The map's JSDoc says it stays there "until the loader-data types leave the domain". `AppIndexLoaderData` went to Billing because every field is billing's, though the home page is not a billing screen.
3. **They are not domain in the DDD sense.** Evans's model is the nouns, states and rules. A wire input is an application-layer thing: Vernon's application service takes a command or a DTO, Cockburn's hexagon calls it a port. Effect's own idiom draws the same line, and it matters here because Baton is written in Effect's idioms on purpose: `Rpc.make(tag, { payload, success, error })` declares a procedure by its schemas, `RpcGroup.make` collects the declarations, and the handlers arrive separately as a layer (`refs/effect/packages/effect/src/unstable/rpc/Rpc.ts`, `RpcGroup.ts`); `HttpApiEndpoint` says it outright, "endpoint values are declarations, not handlers" (`refs/effect/packages/effect/src/unstable/httpapi/HttpApiEndpoint.ts`). Baton's transport is the agents SDK socket, not Effect RPC, so the group type is not adopted, but the split it makes, a declaration that names the payload and the outcome, and a handler that is provided, is the one to mirror. Part 2 does.

So: which of these shapes are the domain's, which are someone else's, and does moving the latter buy anything?

## What is there today

Counted from the four context files on 2026-09-30, by identifier suffix. Code lines are the symbol's own lines; JSDoc lines are the comment above it.

| family      | suffix                                  | symbols (Production / Orders / Billing / Platform) | code lines | JSDoc lines | decoded where                                                | consumed by                                                                |
| ----------- | --------------------------------------- | -------------------------------------------------- | ---------- | ----------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Input       | `…Input`                                | 43 / 1 / 3 / 3                                     | 244        | 148         | the object's `@callable()` gate, `onExcessProperty: "error"` | `ShopAgent.ts` (122 sites), `ShopAgentClient.ts`, 6 routes, 3 repositories |
| Command     | `…Command`                              | 8 / 0 / 0 / 0                                      | 41         | 33          | nowhere: a type, assembled in the object from decoded values | `RunRepository.ts`, `ShopAgent.ts`, one JSDoc in `MemberRun.tsx`           |
| Result      | `…Result`                               | 12 / 1 / 0 / 0                                     | 118        | 66          | `ShopAgentClient` on the way back across the stub            | the object, the client, the routes that branch on `_tag`                   |
| Screen data | `…PageData`, `…IndexData`, `…ListData`  | 5 / 0 / 0 / 0                                      | 43         | 40          | `ShopAgentClient`                                            | the object, the client, 5 routes                                           |
| Loader data | `…LoaderData`                           | 8 / 0 / 2 / 1, plus 1 in the barrel                | 58         | 56          | nowhere: a `satisfies` on the route's server function        | its own route (one is read by two routes, one by none)                     |
| Rows, views | `…Row`, `…ListItem`, `…Counts`, `…View` | 18 / 0 / 0 / 3                                     | 172        | 174         | inside screen data                                           | everywhere screen data is                                                  |

The families are about 20% of Production.ts by lines. Moving all of them would take the file from 3,452 to roughly 2,800 lines. That is not the difference between a scannable file and an unscannable one; the model and its rules are 1,700 lines on their own.

Two measurements matter more than size.

**Who links to whom.** In Production, shape JSDocs `{@link}` model symbols 29 times and other shapes 19 times. Model JSDocs link shapes 4 times: `RunNote` to `SetRunNoteCommand`, `WorkflowDraftDetail` to `WorkflowPageData`, `SeedOrderChange` to `SeedOrdersInput`, `OrderCounts` to `ListOrdersInput`. In Billing, `ShopUsage` links `BillingCycleInput`. The dependency is almost one-way, shapes read the model, which is what a layer boundary looks like. The four reverse links are the places a rule was written on a shape and the concept points at it.

**Where the shapes sit in the file.** They are not a block. Workflow inputs and results sit beside `Workflow` and the draft (lines 750 to 1250); order inputs and screen data beside `OrderRow` and the views (1750 to 2000); the member mutation inputs, commands and results at the end beside `runActions` (3250 onward). Each shape is next to the concept it carries. That is the co-location decision 2 of round 1 chose, applied inside the file: `ApplyResult`'s variants (`NoDraft`, `NoTasks`, `TaskUnassigned`) are readable beside the draft rules they refuse on.

## What each family is, from its own JSDoc

The families already have definitions, written on the symbols. They are the test for whether a family is the domain's.

- **Input** is "what the browser sends, and nothing more": the id of the thing clicked plus the text typed. The reasoning on the member inputs is a rule about what is absent (`memberId`, `teamIds` come off the connection, never the wire) and why (a member who could name their own teams could act on any team's work). That is a permission rule, and it is the domain's.
- **Command** is "the whole write, as the run repository takes it": input joined to the actor from the connection. `StartTaskCommand`'s JSDoc holds the merchant-versus-member permission difference (`teamIds` optional is the whole difference). `SetRunNoteCommand` holds the note rule: no actor, last write wins, nothing records who wrote it, and every free-text field on a run follows it. `RunNote`, a model symbol, links there for the rule. These are rules with owners; the owner happens to be a command.
- **Result** is an outcome union. Every one of the 12 in Production is a `Schema.Union` of tagged outcomes, and each non-`Ok` tag names something the domain refuses (`Limit`, `NoTasks`, `TaskUnassigned`, `NotFound`). The variants are the rules' answers. `DeleteTeamResult`'s JSDoc is the retry rule for a partial delete.
- **Screen data** is "everything one screen reads, in one socket round trip", named by the Screens table's spec name plus TanStack's word `Data`. The JSDoc on `OrdersIndexData` says the structs "carry no rule of their own, so a generic suffix is right and the screen name carries the meaning". They are the domain's reading assembled for one screen; the fields are model types and rows.
- **Loader data** is "the data contract for a route's loader, owned by that route", named mechanically from the route id, never from the vocabulary, with the ownership rule on `AdminShopLoaderData`: only the owning route drives its shape; when another consumer needs it to change, promote the shape to a domain-named type. The JSDoc on each is one line naming its route.
- **Rows and views** are vocabulary words. `OrdersIndexView` and `WorkflowsListView` have a row in the nouns table ("view: a preset of a list, one at a time, chosen by its button") and `pnpm spec check` compares their labels to the label constants. `OrderRow` is production's reading of an order, the seam decision 3 placed on purpose.

Read against Evans's definition, one family fails the domain test and one passes it in an unusual way:

- **Loader data fails.** The rule on it says the route owns it, the name derives from the route id and not the vocabulary, and it carries no reasoning beyond "this route". It is the one family whose home the domain's own JSDoc says is elsewhere. Its presence in the domain is also the only reason a context file wants to import two contexts: a screen composes contexts, and a route is where a screen is composed.
- **Command passes as a rule owner.** The commands carry the permission rules and the note rule, and the model links to them. They pass the entry test ("a concept the domain has": who is acting, on what, with what authority) even though the JSDoc frames them as the repository's parameter type.

Input, result and screen data pass: their variants and absences are rules, and they sit beside the concepts they carry.

## Options

### A. Leave everything where it is

For: nothing moves; co-location by feature inside each context file is doing what round 1 wanted. Against: the barrel defines a type, the map's JSDoc carries a "until" clause, `AppIndexLoaderData` is filed under billing by field count rather than by owner, and the loader-data rule is stated in Billing on `AdminShopLoaderData` for a family that lives in three files and the barrel.

### B. Loader data goes to its route

Each `…LoaderData` type moves into the route module that owns it, beside the `getLoaderData` server function that `satisfies` it. Eleven types, about 60 lines of code and 56 of JSDoc, twelve route files. `WorkflowLoaderData` is read by the workflow page and the workflow editor; it is `WorkflowPageData | null`, so the editor reads the promoted domain type directly and the alias stays with the page. `OrderLoaderData` has no reader outside the domain and is deleted. `OrdersIndexLoaderData` leaves the barrel, which becomes four `export *` lines and the map. `AppIndexLoaderData` leaves Billing.

The ownership rule needs an owner symbol once the types are in eleven files. The candidates are `ShopAgentClient`, whose "Loader reads versus socket reads" section already states the other half of the rule and names `getLoaderData` as the fixed server-function name, or a new `src/lib/LoaderData.ts` holding nothing but the JSDoc and a `satisfies` helper. `ShopAgentClient` is the smaller change and the rule already cites it. A `rules-lint` check pins the placement: an identifier ending `LoaderData` is exported only from `src/routes/`.

For: closes the barrel's "until" clause; ends the only cross-context shape; puts the type where its only reader and its `satisfies` are, which is where a reader looking for "what does this page get" starts. Against: the rule text moves from the domain to the client, which is a layer file; a route module gains a type export, which TanStack route files can carry but do not usually.

### C. Commands go to the run repository

`RunRepository` is the only executor of the eight commands, and the JSDoc calls them "as the run repository takes it". Move them beside the methods that take them.

Against, and decisive: they own two rules that the model links to (`RunNote` to `SetRunNoteCommand`), `MemberRun.tsx` cites one for its copy, and `Actor` is a production concept. Moving them puts a permission rule in a repository file, which is where round 1 said rules do not go. If the commands' framing bothers, the fix is to move the rule text to the concept (the note rule to `RunNote`, the permission rule to `Actor` or `ConnectionState`) and let the commands link it, which is a JSDoc edit and not a move.

### D. A contracts file per context

`src/lib/domain/ProductionContracts.ts` (or `src/lib/contracts/Production.ts`) holds that context's inputs, results and screen data; the model file keeps the nouns, states, rules and matrices; the barrel re-exports both. This is what "contracts split" meant in decision 5.

For: the model file drops to roughly 2,800 lines and reads as model only; the object's socket surface per context becomes one file, which is the shape a later `ShopAgent.ts` split by context would want. Against: it undoes the co-location inside the file that the measurements above show is working. `ApplyResult` leaves the draft rules it answers; `MarkTaskDoneInput`'s absent-fields rule leaves `ConnectionState` and `runActions`; 29 `{@link}`s become cross-file, and a reader of the draft rules has a second file open to see what the draft refuses with. The one-way dependency (contracts import model, never the reverse) is real, but the four reverse links show the domain already reaches into the shapes for rules, and those would become the contracts file's rules, which is the layering mistake C makes. The size saved is 20%, which is not the difference between scannable and not.

If D is ever right, it is right with or after the `ShopAgent.ts` split, when there is a per-context object surface for the contracts to be the surface of. It can land in the same change as the object split; what decides it is the size of the model file once the object's production code is in its own file, and that number does not exist yet.

### E. A shape-families table in the map

Not a move. The map at the top of `Domain.ts` gains one table naming the five families: suffix, what it is, who decodes it, who owns it, the symbol that holds its rule. `pnpm spec check` verifies each row's rule symbol exists and that every export with the suffix lives where the row says (Production, Orders, Billing, Platform, or `src/routes/` for loader data after B). `pnpm vocab:audit` currently lists "loader" (12 uses) and "command" (8) as words without a row; this is the row, at the level the words are actually used, without pretending they are nouns of the business.

For: the families are already a rule several sites agree on (the naming on `OrdersIndexData` and `AdminShopLoaderData`, the wire rule on the member inputs), and AGENTS.md says such a rule is stated once and linked. Today it is stated three times on three symbols. Against: one more table to keep, and the families are a developer dialect, which the map otherwise keeps out.

### Comparison

|                                 | A leave      | B loader data to routes             | C commands to repository                  | D contracts file per context                       | E families table        |
| ------------------------------- | ------------ | ----------------------------------- | ----------------------------------------- | -------------------------------------------------- | ----------------------- |
| cross-context shape remains     | yes (barrel) | no                                  | yes                                       | yes (a contracts file for it)                      | yes                     |
| rule leaves its concept         | no           | ownership rule to `ShopAgentClient` | note and permission rules to a repository | absent-field and outcome rules to a contracts file | no                      |
| `{@link}` made cross-file       | 0            | 0 (the loader types link nothing)   | ~6                                        | ~29 plus 4 reverse                                 | 0                       |
| Production.ts size              | 3,452        | 3,380                               | 3,380                                     | ~2,800                                             | 3,452                   |
| readers touched                 | 0            | 12 routes, barrel, client, lint     | repository, object, one component         | object, client, barrel, every route                | `Domain.ts`, spec check |
| closes an open note in the code | no           | yes, the barrel's "until"           | no                                        | decision 5                                         | the vocab-audit words   |

## Recommendation, shapes alone

Read with Part 2 before deciding; the joint recommendation is at the end.

1. **Loader data leaves the domain for its route (B).** It is the one family whose own rule says the route owns it, the one family that spans contexts, and the reason the barrel defines a type. The ownership rule and the `getLoaderData` naming go on `ShopAgentClient`, which already holds the loader-versus-socket rule they belong with. `rules-lint` refuses a `LoaderData` export outside `src/routes/`. `OrderLoaderData`, unread, is deleted. One change, mostly moves.
2. **Commands, inputs, results and screen data stay in their context file (A for those).** They carry rules or sit beside the rules they answer, the model links to four of them, and they are interleaved by concept, not by layer, which the measurements say is what makes the file readable. Not C, not D.
3. **Add the families table to the map (E)**, with a `spec check` row check, so the five suffixes are stated once and the "loader" and "command" audit words have their answer.
4. **Revisit D only after `ShopAgent.ts` splits by context.** That split, not this one, is the next thing the map asks for, and a per-context contracts file is its natural companion. Until then a contracts file is a second axis with nothing on the other side of it.

Trade-off, stated plainly: B moves a rule out of the domain into a layer file, which round 1 was against. The rule in question is about routes and server functions, not about the business, and `ShopAgentClient` is where its other half already lives, so it is the exception the round-1 decision allows ("a site that follows a different rule says so and why"). If that exception feels wrong, the fallback is a `src/lib/LoaderData.ts` whose only content is the rule and a helper, which keeps the rule on a symbol of its own at the cost of a near-empty file.

# Part 2: splitting `ShopAgent.ts` by context

## What the object is

One Durable Object class per shop, 4,322 lines, 66 `@callable()` methods and about 20 plain RPC methods, over one private SQLite. Its JSDoc says what it is for: the `@callable()` set "is exactly what the browser may reach over the socket", the role guard runs before every decode, the identity comes off the connection and never off the wire, and "the Durable Object serialises callables so nothing interleaves", which the reconcile pass relies on. Those four facts are the object's own rules, and they are not about any one context. They are the reason a split has to keep one class.

Measured on 2026-09-30, by the order the methods appear in, which is already roughly by context:

| region                                                                                            | lines (approx.) | context                    | callables | reaches into                                                       |
| ------------------------------------------------------------------------------------------------- | --------------- | -------------------------- | --------- | ------------------------------------------------------------------ |
| imports, connection state, role guard, `callableEffect`, runtime                                  | 430             | platform                   |           |                                                                    |
| result mappers (`workflowResult` … `runResult`), actor and action helpers, seed helpers           | 480             | production                 |           |                                                                    |
| class JSDoc, constructor, `onConnect`, tags, connections, `publish`, revoke, `unsubscribe`        | 330             | platform                   | 1         |                                                                    |
| orders sync: `fetchAndUpsertOrder`, `syncOrders`, the stream handlers, `syncOrder`                | 530             | orders, calling production | 2         | `reconciler` (production), `publish`, `flushUsageEvents` (billing) |
| billing: `getUsage`, `setBillingCycle`, `recordMemberCount`, `reconcileUsage`, `flushUsageEvents` | 160             | billing                    | 1         | `OrderRepository` (billing's tables live there)                    |
| orders index: `resyncOrder`, `readOrders`, `listOrders`, `subscribeOrders`                        | 100             | production (reads orders)  | 2         | `fetchAndUpsertOrder`, `teams`, `publish`                          |
| workflows: create, duplicate, update, drafts, on/off, coverage date, delete                       | 475             | production                 | 12        | `reconcileAllNow`, `reconcileAllIfOn`, `teams`, `publish`          |
| reconcile: `teams`, `eligibleContext`, `reconcileAllNow`, `reconcileAllIfOn`, `reconciler`        | 130             | production                 |           | `Repository` (D1 teams), `flushUsageEvents`                        |
| order page and the merchant's run actions                                                         | 495             | production                 | 12        | `readOrderDetail`, `publishToTeams`, `teams`                       |
| the member's workflows list and run actions                                                       | 440             | production                 | 10        | `readRuns`, `readRunPage`, `publishToTeams`                        |
| tasks, teams, assign                                                                              | 355             | production                 | 9         | `teamExists`, `closeMemberConnections`, `publish`                  |
| seed                                                                                              | 345             | production (dev only)      | 2         | `reconciler`, `reconcileAllNow`, `teams`, `publish`                |
| team workflows, task counts                                                                       | 35              | production                 |           |                                                                    |

Production is about 2,800 lines of the 4,322, the same two-thirds as in the domain. Orders sync is 530, billing 160, platform 760.

Three things the table shows:

1. **The private members are the platform.** Every region reaches `publish`, `publishToTeams`, `teams`, `runEffect` and the connection set. Those are the object's fan-out and its runtime, not a context's. A split has to leave them in one place every context can reach.
2. **Orders sync calls production.** `syncOrders`, `onOrdersStream` and `syncOrder` store the order and then run `reconciler`, production's per-order pass, as the `afterWrite` of the upsert, then send billing's usage queue. That is the one place in the code where the map's direction (production reads orders, never the reverse) is inverted, and it is inverted on purpose: an order arriving is the event that starts production. The stream extraction already made it a parameter (`runShopAgentOrdersStream({ afterWrite })`), which is the shape a split keeps: orders storage takes a hook, and the caller that knows about production supplies it.
3. **The repositories are already per context.** `OrderRepository` (orders, plus billing's outbox and usage tables), `WorkflowRepository` and `RunRepository` (production), `Repository` (D1: sessions, members, teams). The object is the only file that holds all three.

## Options

### A. Leave the class as it is

For: the security surface is one file; `getCallableMethods` and the role table read top to bottom. Against: 4,322 lines that will keep growing at production's rate; a reader of the workflow callables scrolls past the sync stream; a change to a member action and a change to bulk import land in the same diff hunk neighbourhood.

### B. Separate Durable Objects per context

Ruled out. One SQLite is what makes "the repository owns the transaction" and "nothing interleaves" true; three objects would be three storages, no cross-context transaction, and a `publish` that has to reach connections another object holds. Cloudflare's unit of consistency is the object, and the shop is the unit Baton needs consistent.

### C. Mixins per context

`ShopAgent extends WithProduction(WithBilling(WithOrders(ShopAgentBase)))`, one file per mixin under `src/lib/agent/`, each declaring its `@callable()` methods. The agents SDK supports it: `callable` marks the method function in a `WeakMap` and `getCallableMethods` walks the whole prototype chain (`refs/agents/packages/agents/src/index.ts`, `getCallableMethods`), so a method declared on a mixin's prototype is reachable exactly as one declared on the class.

For: every method keeps `this`, the diff is a move, and the callables of one context are one file. Against: the mixin order becomes the import direction, and orders sync needs production's `reconciler`, so either orders is the outer mixin (against the map) or the base declares an abstract hook production fills; TypeScript mixin typing with the SDK's generic `Agent<Env, State>` and standard decorators is workable but noisy; and the security surface, which callables exist and with what role, is spread over four files that all have the decorator.

### D. One class, one module per context, the class delegates

`src/lib/agent/Production.ts`, `Orders.ts`, `Billing.ts` each export the effects the callables run, taking what they need from a small host interface (`name`, `publish`, `publishToTeams`, `teams`, the connection set) and from the runtime's services (the repositories, `Shopify`, `ShopifyAppEvents`). The class keeps every `@callable()` as a one-line delegation:

```ts
@callable()
merchantBlockRun(input: unknown) {
  return this.runEffect(production.merchantBlockRun(this.host)(input));
}
```

The JSDoc that explains a callable's rule moves with the effect, which is the symbol that enforces it; the method links it. The sync orchestration (`syncOrders`, `onOrdersStream`, `syncOrder`) stays in the class, because it is the one place that composes three contexts: store (orders), reconcile (production), flush (billing). The result mappers and actor helpers go to the production module; `flushUsageEvents`, already a module-level effect, goes to billing.

This is what the code has already started doing: `runShopAgentOrdersStream` and `flushUsageEvents` are effects outside the class that take what they need. D is that pattern applied to the rest.

For: one class, one decorator surface, one role table to audit; the class becomes roughly 1,600 lines that read as "what the browser may call, with what role, delegating where"; each context's application code is one file that `rules-lint` can hold to the map (`agent/Orders.ts` never imports `agent/Production.ts`); testable through the stub exactly as today. Against: 66 delegating one-liners are boilerplate; the host interface is a new seam to name and keep small; a rule that today reads on the method reads one hop away.

### E. Effect services per context

D's file layout, with each module a `Context.Service` (`ProductionAgent`, `OrdersAgent`, `BillingAgent`) and a layer, built into the runtime beside the repositories, and the host a service (`ShopAgentHost`: `name`, `publish`, `publishToTeams`, `closeMemberConnections`) made in the constructor. The runtime is already built per instance there (`makeRunEffect(env, ctx.storage)`), so the host is one more `Layer.succeed` with `this` in hand; the per-call problem `ShopifyAdmin` has does not arise, because nothing on the host rotates. A callable reads `this.runEffect(Effect.flatMap(ProductionAgent, (p) => p.merchantBlockRun(input)))`. The map's direction becomes the layers' requirements: `OrdersAgent.layer` requires `OrderRepository`, `Shopify` and the host, never `ProductionAgent`; `rules-lint` still checks the imports. This is the Effect form of D and the mirror of the RPC idiom from Part 1: the class is the group declaration, the services are the handler layers. For: everything D gives, plus the modules are services like every other seam in `src/lib/` (`Auth`, `Email`, the repositories) and can be tested against a stub host layer without a Durable Object. Against: everything D costs, plus one layer per module and a host service to name.

### Comparison

|                                      | A leave | B objects    | C mixins                     | D modules, class delegates    | E services                       |
| ------------------------------------ | ------- | ------------ | ---------------------------- | ----------------------------- | -------------------------------- |
| one class, one `@callable()` surface | yes     | no           | no, four files               | yes                           | yes                              |
| map direction enforced by lint       | no      | n/a          | by mixin order, backwards    | yes, on `src/lib/agent/`      | yes                              |
| orders sync calls production         | inline  | cross-object | abstract hook or wrong order | stays in the class, as wiring | same as D                        |
| rule stays on the enforcing symbol   | yes     | yes          | yes                          | yes, one hop from the method  | yes                              |
| `ShopAgent.ts` size after            | 4,322   |              | ~800 plus 3 mixins           | ~1,600 plus 3 modules         | ~1,600 plus 3 modules            |
| diff shape                           |         | rewrite      | move                         | move plus 66 delegations      | move plus layer work             |
| tests change                         | no      | yes          | no                           | no                            | no; a host stub becomes possible |

## The trade-offs, in detail

Why one class of delegations rather than mixins, and why services rather than a host object passed by hand.

**What the delegations cost.** The 61 callables average 46 lines each, 2,836 lines in all; almost all of that is the effect, which moves. What stays is the decorator, the signature and one `runEffect` line, about six lines each, so roughly 370 lines of the new class are delegation. Adding a callable touches two files (declare in the class, implement in the module) where today it touches one. Renaming one touches two. The rule that today sits on the method (the merchant-versus-member difference on `merchantAttachWorkflow`, say) sits on the module's effect, and the method carries a one-line `{@link}` to it: the reader who starts at the class is one hop from the reasoning. That is the whole cost, and it is the cost every Effect service in `src/lib/` already pays: `Auth`, `Email`, the repositories all declare an interface in one place and implement it in another.

**What the delegations buy.** The class becomes the thing its JSDoc says it is: "the `@callable()` set is exactly what the browser may reach over the socket". After the split, that set is one file, read top to bottom, each method showing its decorator, its role (`callableEffect(name, schema, { role })`) and where it goes. A security review (which methods exist, who may call each, what each decodes) reads one file of 1,600 lines instead of one of 4,322 with the effects inlined. `getCallableMethods` walks the prototype chain, so the SDK's answer to "what can the browser call" and a reader's answer from the file agree by construction. The lint that keeps the map's direction is the same import check the domain already has, run on `src/lib/agent/`, so it costs a path and a test. And each context's application code (`agent/Production.ts`, about 2,200 lines) is readable without the sync stream, the billing cycle or the connection plumbing in it, which is the reading the author does for the parts that tie the system together.

**What mixins cost that the comparison table does not show.** Each mixin is a function of a base constructor, and TypeScript requires the base to be typed as `new (...args: any[]) => Agent<Cloudflare.Env>` plus whatever members the mixin uses; a mixin cannot see its siblings, so `publish`, `publishToTeams`, `runEffect` and `name` have to be declared on an interface the base implements and every mixin's constraint names. Standard decorators inside a class expression compile, but the SDK's `callable` is typed against `ClassMethodDecoratorContext` and the `this` inside the effect closures (already captured by hand today as `const publish = () => this.publishToTeams(...)`) gets a mixin-shaped type that error messages spell out in full. The order of application is the import direction, and orders sync needs production's reconcile, so either orders is the outer mixin, which reads backwards against the map, or the base declares an abstract `reconciler` for production to fill, which is a hook by another name and puts a production word on the platform base. And the callable surface is four files each carrying decorators; the reader has to open all four to answer "what can the browser call". Mixins are the cheaper diff (a pure move) and the more expensive read.

**Why services and not a host object.** D as first written passes a host object into plain functions. That works, and `runShopAgentOrdersStream` already does it with a parameter. But it is not how the rest of `src/lib/` is written: every dependency there is a `Context.Service` provided by a layer, and the effects declare what they need in their requirements type rather than taking it as an argument. E keeps D's files and makes the modules services, which means a module's requirements are its context map (`OrdersAgent` requires `OrderRepository` and the host; `ProductionAgent` requires the three repositories, `Repository` for teams, and the host; `BillingAgent` requires `OrderRepository` and `ShopifyAppEvents`), checkable by the type system before the lint runs. It also means the modules are testable with `Layer.succeed(ShopAgentHost, stub)` and an in-memory `SqliteClient`, which the stub tests do not need today but the seam gives for free. The cost over D is a layer per module and one service for the host. That is the Effect idiom, and it is the same declaration-versus-handler split `Rpc` and `HttpApi` make.

**Why not leave it.** The class doubled with the domain: production grows by a screen at a time and every screen adds callables here. The next research doc that measures this file measures 6,000 lines, and the split is the same shape then as now, only larger.

## What the object split does to Part 1

With D or E, each context has two files: `domain/Production.ts` (the model, its rules, its matrices) and `agent/Production.ts` (what the object does with them). The inputs, results and screen data are what pass between the browser, the class and the agent module. That is the "other side" decision 5 was waiting for.

It does not change the answer. The agent module reads `Domain.MarkTaskDoneInput` exactly as the class does today, through the barrel; a contracts file would sit between two files that both already import the barrel. What the split does change is where a reader looks for "what can the browser send for this action": today the class; after D, the class for the role and the module for the rule, both one `{@link}` from the input in the domain. The domain stays the place the shape is defined, and the two-file pair is the place it is used. Loader data is untouched by the object split; the routes never call the object except through `ShopAgentClient`.

If Production's model file is still too long to scan after the object split, the contracts file is the next cut, and by then the sizes will say whether it is worth 29 cross-file links.

## Recommendation, both parts

1. **Loader data to its route, the ownership rule to `ShopAgentClient`, a lint on the suffix** (Part 1, B). Small and closes the barrel's "until".
2. **Inputs, commands, results and screen data stay in the context files** (Part 1, A for those). Not a contracts file, not the repository.
3. **The families table on the map, checked by `spec check`** (Part 1, E).
4. **Split the object by E**: D's layout (three modules under `src/lib/agent/`, one class of delegating callables and the sync wiring) with each module a `Context.Service` and a layer, the host a service, `rules-lint` extended to the new folder. This is the larger change and the one that pays: the class becomes the readable role table the JSDoc already describes, and the production code the author reads for the parts that tie things together is one file per layer.
5. **Order**: Part 1 first (one change, a day), then the object (one change per module, orders and billing first because they are small and prove the host service, production last). A contracts file per context is not planned in either; it is re-asked when the object's production module exists and the model file's size is known, and it may land in that same change.

The trade-off, in one line (the detail is in Part 2): 4 adds about 370 lines of delegation, three layers and a host service; what it buys is a class that is the whole browser surface in one readable file, modules whose requirements are the context map, and the same service idiom as the rest of `src/lib/`. Mixins avoid the delegation and cost the single surface and the map's direction.

## Questions

Each with the answer I would give, so you can confirm or redirect.

1. **Does loader data leave the domain for its route?** Recommend yes. If no, delete the map's "until" clause and re-file `AppIndexLoaderData` by owner, which needs an allowed edge.
2. **Where does the loader-data ownership rule live once the types are in routes?** Recommend `ShopAgentClient`, beside the loader-versus-socket rule. Alternative: a `src/lib/LoaderData.ts` holding the rule alone.
3. **Do the commands keep their rules, or do the rules move to `RunNote` and `Actor`?** Recommend keep: the command is the enforcing symbol, and `RunNote` linking down to it is the same pattern as a state predicate linking its matrix.
4. **Families table in the map, or keep the developer dialect out of it?** Recommend in: the naming rules already exist on three symbols and are a rule several sites agree on.
5. **Split the object, and by E (D's files, services)?** Recommend yes. If the delegations bother you more than a four-file callable surface, C is the alternative and the lint has to run on mixin order instead of imports. If not now, the object keeps growing at production's rate and the next research doc measures 6,000 lines.
6. **Does the sync orchestration stay in the class or become a fourth module?** Recommend the class: it is the one composition of three contexts and the class is the composition root. A fourth module (`agent/Sync.ts`) that imports all three is the alternative if the class is still long after the split.
7. **Contracts file per context: dropped, or re-asked after the object split?** Recommend re-asked after, with the sizes, and written into that change's plan rather than kept open here.

## Decisions, round 1

Reviewed 2026-09-30.

1. Loader data leaves the domain for its route. Accepted.
2. The ownership rule goes on `ShopAgentClient`. Accepted.
3. The commands keep their rules. Accepted.
4. The families table goes on the map. Accepted.
5. The object splits, by E: D's files, each module a service. Accepted, after the trade-offs were expanded above.
6. The sync orchestration stays in the class. Accepted.
7. The contracts file per context is re-asked after the object split. Accepted, on condition the follow-up is not lost; it is recorded below. The reviewer added that it can be done together with the object split; the plan for the split carries the checkpoint.

## Follow-ups

- **Contracts file per context** (Part 1, option D). Re-ask when `src/lib/agent/Production.ts` exists: measure `src/lib/domain/Production.ts`, count the `{@link}`s that would cross, and decide. The object-split plan names this as its last step, "decide the contracts file", so it cannot be dropped by omission.

## Status

Research reviewed once. No code changed. Two plans follow: one for Part 1 (loader data, families table, lint), one for the object split in three moves with the contracts checkpoint at the end.
