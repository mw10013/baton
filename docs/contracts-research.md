# Contracts: what they are, whether Baton needs them

Follows `docs/spec-location-research.md` (round-2 decision 5: "the API shapes stay in their context file; a contracts split is a later question"), `docs/api-shapes-location-research.md` (option D, "a contracts file per context", re-asked after the object split) and `docs/api-shapes-and-object-plan.md` (Phase 6 step 4, the checkpoint, answered "Not now" on 2026-09-30 with a trigger). This doc says what the word means, what a contracts file would buy, what it would cost on today's tree, and whether to do it. The context formerly called production is shop work; `src/lib/domain/ShopWork.ts` and `src/lib/agent/ShopWork.ts` are its two files.

## 1. What "contracts" means

The word has two senses, and the deferred item is the second. Both matter, because the second is how the first shows up in code.

### 1a. The DDD sense: the agreement between two bounded contexts

In Evans and in Khononov's _Learning Domain-Driven Design_, a contract is what two bounded contexts agree on so that they can integrate without sharing a model. Each context owns its words and rules. Where they meet, one of a few patterns holds:

| pattern               | who bends                                                     | Baton today                                                                               |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| shared kernel         | both; a small model is co-owned and changes only by agreement | none                                                                                      |
| conformist            | the downstream context adopts the upstream's model as is      | shop work uses orders' words unchanged (`OrderState`, `orderIsOpen`)                      |
| anti-corruption layer | the downstream translates the upstream's model into its own   | shop work's reading of an order: positions, issues, the item's card (`ShopWork.ts` ~1720) |
| open host service     | the upstream publishes a stable interface for any downstream  | the object's `@callable` surface and `ShopAgentClient`                                    |
| published language    | the interface's shapes, in a form both sides can decode       | the `Input`, `Command`, `Result` and screen-data schemas                                  |
| separate ways         | no integration                                                | platform reads nothing; orders never reads shop work                                      |

The map at the top of `src/lib/Domain.ts` already states Baton's contracts in this sense: shop work is downstream of orders, "conformist on words, a translation on model", crossing at five named symbols; billing is downstream of orders through one field, `countedAt`; every context uses the platform dialect. `scripts/rules-lint.ts` refuses an import against that direction. So in the DDD sense the contracts exist, are written once, and are enforced. There is nothing to add here except, later, a shared kernel if two contexts ever need to co-own a type, and the map's direction rule already makes that visible when it happens.

### 1b. The codebase's sense: the shapes that cross the object's boundary

The earlier research used "contracts" for the published language of the open host service: what the browser or the Worker sends the object (`…Input`), what the object does with it once the actor is joined on (`…Command`), what it answers (`…Result`, a tagged union of outcomes) and what one screen reads in one round trip (`…PageData`, `…IndexData`, `…ListData`). These are `effect` `Schema` values, decoded at the `callableEffect` gate on the way in and by `ShopAgentClient` on the way back, so they are runtime contracts already, not just types. The Shape families table on the map names the five families, where each lives and the symbol that holds its rule; `pnpm spec check` holds every export to its row.

"A contracts file per context" means moving those shapes out of `src/lib/domain/ShopWork.ts` (and the handful in `Orders.ts`, `Billing.ts`, `Platform.ts`) into a sibling file, with the model file keeping the nouns, states, predicates, matrices and rules, and the barrel re-exporting both. That is the whole of the deferred item.

## 2. What problem a contracts file would solve

Four candidate problems. Each is judged against today's tree, not the tree the earlier docs measured.

1. **Scannability.** `ShopWork.ts` is 3,384 lines and 329 export lines, of which 128 are shape exports (about 43 inputs, 4 commands, 12 results and 5 screen-data shapes, counting each `const`/`type` pair once). The Phase 6 measurement put the shapes at about 870 lines with their JSDoc. A split takes the model file to roughly 2,500 lines. That is a 25% cut, and it does not change the file from "long" to "short".
2. **A consumer that needs the shapes and not the model.** This is the trigger the checkpoint recorded. A public API package, an SDK, a second Worker, a Shopify Flow action or an admin UI extension that must decode the object's answers without carrying `runActions`, the matrices and the predicates would want the shapes alone. Today no such consumer exists. The browser bundle already carries the model: 19 route files and 10 components import `@/lib/Domain`, and components such as `MemberRun.tsx` read predicates and cite the matrices for copy. Separating the shapes would not shrink the client bundle unless the components stopped importing the model too, which they cannot.
3. **Layering.** A contracts file states "this is the wire, that is the business" as a file boundary instead of a suffix convention. The Shape families table already states it as a rule, and the checkpoint measured the dependency as one-way in code: shapes use 32 model symbols, no model symbol uses a shape. The layering exists; the file would only make it physical.
4. **A per-context object surface.** The earlier research said a contracts file is "the natural companion" of the object split, because `src/lib/agent/ShopWork.ts` would then be one file of handlers and one file of the shapes they decode. That split has landed (2,361 lines in `agent/ShopWork.ts`). The companion argument is now testable: does a reader of the agent module miss a contracts file? The agent module reads `Domain.MarkTaskDoneInput` through the barrel and links to the input's JSDoc for the rule; a contracts file would sit between two files that both already import the barrel, and change nothing the reader sees.

## 3. What it would cost

- **Cross-file links.** The checkpoint counted 18 `{@link}`s from a shape to a model symbol, 8 the other way, and 19 between shapes. After a split, 26 of those cross files. The reverse eight are the real cost: `TaskState` links three results, `RunNote` links `SetRunNoteCommand` for the note rule, `OrderCounts` links `ListOrdersInput`. A reader of the draft rules on `ApplyResult`'s neighbours has a second file open to see what the draft refuses with. AGENTS.md's rule-once principle is indifferent to file boundaries, but the co-location inside the file is what the round-1 measurements said makes it readable.
- **Rules that leave their concept.** `MarkTaskDoneInput`'s absent-fields rule (a member's `memberId` and `teamIds` come off the connection, never the wire) is a permission rule, and it lives on the input because the input is where the absence is. In a contracts file it is a permission rule in a wire file. Option C (commands to the repository) was rejected for exactly this; D repeats it for inputs and results.
- **The machinery.** The Shape families table gains a sixth `lives in` value, `checkShapeFamilies` learns it, `scripts/rules-lint.ts`'s import-direction check learns that a contracts file may import its own model file and nothing else in the other direction, and the vocabulary's "a symbol named here is an export of its context's file" sentence needs a clause.
- **A rename in flight.** The tree is mid-rename (production to shop work, uncommitted). A split on top of a rename doubles the review surface of one change.

## 4. Options

### A. Keep the checkpoint's answer

Nothing moves. The "Not now" paragraph in `docs/api-shapes-and-object-plan.md` stands, with its trigger. Cost: zero. Risk: the option silently closes if a future change makes a model symbol depend on a shape in code, because then the split is no longer mechanical.

### B. Keep the answer and pin the trigger

As A, plus one lint rule in `scripts/rules-lint.ts`: inside a context file, an export without a family suffix may not reference an export with one. That is the "no model symbol uses a shape" measurement turned into a rule, so the split stays mechanical for as long as the rule holds, and a change that would break it is refused at the change rather than discovered at the split. Cost: one AST check and one test whose title is the rule. The `{@link}`s are not covered (the reverse eight are JSDoc, not code) and do not need to be; they are what the split would re-point.

### C. The contracts file now

`src/lib/domain/ShopWorkContracts.ts` (and, for symmetry, one per context, though Orders has two shapes, Billing three and Platform three, which argues for shop work only). Barrel re-exports both. Cost as in section 3. Buys a 25% smaller model file and a physical layer boundary.

### D. Contracts as a package boundary

`src/lib/contracts/` as a directory the browser bundle and any future consumer may import without the model, with the model files importing nothing from it and `rules-lint` refusing the reverse. This is C with a consumer in mind. It only earns its place when the consumer exists, because until then the components' imports of the model make the boundary a fiction on the client side.

### Comparison

|                                 | A keep   | B keep and pin       | C contracts file                   | D contracts package               |
| ------------------------------- | -------- | -------------------- | ---------------------------------- | --------------------------------- |
| `ShopWork.ts` lines             | 3,384    | 3,384                | ~2,500                             | ~2,500                            |
| `{@link}` made cross-file       | 0        | 0                    | ~26                                | ~26                               |
| rule leaves its concept         | no       | no                   | absent-fields, outcomes            | absent-fields, outcomes           |
| split stays mechanical          | not held | held by lint         | done                               | done                              |
| serves a consumer without model | no       | no                   | no (client carries model)          | yes, once one exists              |
| machinery touched               | none     | `rules-lint`, 1 test | families table, spec, lint, barrel | as C plus a directory and its map |
| lands on the rename             | no       | no                   | yes                                | yes                               |

## 5. Recommendation

**B.** Do not split. The problem a contracts file solves in this codebase is file length, and the checkpoint measured that as a 25% cut that leaves the file long. The costs are the ones the project has already refused twice (rules leaving their concept, co-location undone). The trigger that would change the answer, a consumer of the shapes without the model, does not exist and is not on the roadmap that the research docs describe. What is worth doing is the one-line lint that keeps the option mechanical, so that when the trigger fires the split is a move and not a redesign.

If the length of `ShopWork.ts` is itself the pain, the cheaper cut is by feature, not by layer: the workflow-draft rules (`ApplyResult` and its neighbours) and the orders-index reading (positions, issues, `OrderRow`) are each a coherent block with its own vocabulary table, and either could be a sub-context file under the same map without any shape leaving its rule. That is a different research question and is not argued here.

## 6. Decisions

Reviewed 2026-09-30. Each recommendation in the earlier Questions section was accepted.

1. The deferred item was the file split (sense 1b). The DDD contracts (sense 1a) are on the map and enforced; nothing to add. This doc closes 1b.
2. No consumer of the shapes without the model is assumed for the next two quarters. If a Flow action, an admin UI extension, a second Worker or an SDK reaches the roadmap, re-ask, because that fact alone flips the answer to option D.
3. The length of `ShopWork.ts` is judged by how agents cope over the next few changes. If it hurts, the cut is by feature (workflow-draft rules, the orders-index reading), not by layer.
4. Add the lint from option B: inside a context file, an export without a family suffix may not reference an export with one. One rule, one test whose title is the rule, in the same change as committing the rename.
5. The decision sentence goes on the Shape families table's paragraph on the map in `Domain.ts`: the shapes stay in their context file; a contracts file is the move when a consumer needs the shapes without the model, and the lint keeps that move mechanical. The checkpoint paragraph in `docs/api-shapes-and-object-plan.md` stays as history.

Next: a short plan for items 4 and 5, or fold them into the shop-work rename change.
