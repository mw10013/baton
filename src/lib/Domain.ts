/**
 * The domain's map and its barrel: the four context files under
 * `src/lib/domain/`, where each behavioural rule is written down, re-exported
 * as one module.
 *
 * - A rule is stated once, on the symbol that *is* the concept (a
 *   `Schema.Literals` such as `RunState` in ShopWork) or the function that
 *   enforces it (`reopenBlockedBy`, `currentTasks` in ShopWork). A concept with
 *   more than one rule carries a table naming each rule's predicate.
 * - Every other site calls the predicate (`runIsOpen`,
 *   `runIsBlocked` in ShopWork, `userIsAdmin` in Platform, ...) rather than comparing a
 *   literal. `scripts/rules-lint.ts`, run by `pnpm lint`, refuses an inline
 *   `.status`, `.state`, `.flag` or admin `.role` comparison anywhere else under `src/`.
 * - A site that follows a different rule from its siblings says so and why,
 *   in its own JSDoc, and links the rule it departs from.
 * - Each rule is pinned by a test whose title is the rule in plain words.
 * - Which word a site speaks. Identifiers, types, callables, route
 *   parameters (`$runId`), log messages, JSDoc, tests and research speak
 *   the vocabulary word: "run" is the word there. Route segments, string
 *   literals, JSX text, headings and labels speak the screen word: the
 *   vocabulary's screen columns, and `scripts/rules-lint.ts` refuses the
 *   retired words in them. A JSDoc that explains copy quotes the copy.
 *   A JSDoc that names a screen uses the Screens table's spec name.
 */

/**
 * Vocabulary. These are the words for code, JSDoc, tests, research and screen; a
 * symbol named here is an export of its context's file, or a field of one. A row
 * says what a word means, where it lives, and what a screen calls it; the
 * rule stays on the symbol.
 *
 * Contexts. The map: a word means one thing inside its context, and each
 * context is one file under `src/lib/domain/`, opening with its own
 * vocabulary. This file re-exports the four by `export *` and defines nothing
 * of its own: a page shape that reads two contexts is loader data, and loader
 * data lives in its route. Nothing outside
 * `src/lib/domain/` imports a context file directly, and a context file
 * imports only what its `may import` cell names. `scripts/rules-lint.ts`
 * reads the cell and refuses both. Every vocabulary table
 * names its context, in its first line or in a `context` column:
 *
 * | context   | kind       | about                                                                                      | whose words                              | file          | may import       |
 * | --------- | ---------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------- | ---------------- |
 * | shop work | core       | the work of making what the shop sold: who does it, in what steps, and how far along it is | Baton's, the merchant's and the members' | `ShopWork.ts` | orders, platform |
 * | orders    | supporting | what Shopify says about an order                                                           | Shopify's admin                          | `Orders.ts`   | platform         |
 * | billing   | generic    | what the shop pays for                                                                     | Shopify's Partner API                    | `Billing.ts`  | orders, platform |
 * | platform  | dialect    | dialect, not a context: the technical words; no model of the business                      | Cloudflare's and Baton's                 | `Platform.ts` | (nothing)        |
 *
 * Shop work is downstream of orders: conformist on words, a translation on
 * model. It crosses at `OrderState`, `orderIsOpen`,
 * `OrderLineItem.currentQuantity`, `ShopOrder` and `OrderLineItem`, and what it makes of an order (positions,
 * issues, an item's card) is shop work's, not orders'. Billing is
 * downstream of orders through one shared field, `ShopOrder` field
 * `countedAt`, the counted order. Every context uses the platform dialect:
 * the ids (`Shop`, `ShopGid`, `EpochMillis`), `ShopLimits`, `ShopSession`
 * and the connection. Orders never reads shop work, and platform reads
 * none of the three.
 *
 * Shared words. A word two contexts share always travels with its noun,
 * in copy and in identifiers (`<noun>Is<State>`, never `is<State>`), so
 * each context keeps its meaning. "open" on an order is `orderIsOpen` in Orders,
 * not fulfilled and not cancelled: the orders index's default,
 * labelled Open. One row per shared word:
 *
 * | word   | contexts          | noun form                                                                                                                  |
 * | ------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
 * | open   | orders, shop work | "open order" (`orderIsOpen`), "open run" (`runIsOpen`)                                                                     |
 * | closed | orders, shop work | "closed order" (the matrices' `order` column: cancelled or fulfilled), "closed run" (`runIsClosed`)                        |
 * | cancel | orders, shop work | "cancelled order" (`orderIsCancelled`, Shopify's), "Cancel workflow" (the run verb, `merchant_cancelled`)                  |
 * | start  | shop work         | two senses: a member starts a task (the verb, `StartTaskInput`); a workflow starts for an item, in merchant copy, and in identifiers a workflow creates a run (`workflowIsEligible`) |
 *
 * Shape families. These are the developer dialect's suffixes for what
 * crosses a boundary, not vocabulary words: a word here gets no nouns row,
 * and the rule for each family is on the symbol its row names. The shapes
 * stay in their context file beside the rules they answer; a contracts file
 * (the shapes in a sibling file, the barrel re-exporting both) is the move
 * when a consumer needs the shapes without the model, and none does today.
 * Shapes read the model and the model never reads a shape, so that move
 * stays mechanical; `scripts/rules-lint.ts` refuses the reverse.
 *
 * | family      | suffix                              | what it is                                                     | decoded by                                  | lives in                       | rule on                                       |
 * | ----------- | ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------- | ------------------------------ | --------------------------------------------- |
 * | input       | `Input`                             | what the browser or the Worker sends, and nothing more         | the object's `@callable()` gate             | its context file               | `MarkTaskDoneInput`                           |
 * | command     | `Command`                           | the whole write, input joined to the actor from the connection | nothing; assembled from decoded values      | `ShopWork.ts`                  | `StartTaskCommand`                            |
 * | result      | `Result`                            | the outcomes of one write, a tagged union                      | `ShopAgentClient` on the way back           | its context file               | `ApplyResult`                                 |
 * | screen data | `PageData`, `IndexData`, `ListData` | everything one screen reads, in one round trip                 | `ShopAgentClient`                           | `ShopWork.ts`                  | `OrdersIndexData`                             |
 * | loader data | `LoaderData`                        | a route's loader contract, owned by the route                  | nothing; `satisfies` on the server function | the route, under `src/routes/` | `ShopAgentClient` (its loader-data paragraph) |
 *
 * What a word must pass to get a row:
 *
 * - A word names a concept the domain has, not a mechanism or a metaphor.
 * - A word has one meaning in its context. A word two contexts share is a
 *   row of the Shared words table and always travels with its noun.
 * - Shopify's things get Shopify's words, unchanged. Baton's things get
 *   plain words, and an invented word never reaches a screen. In
 *   particular, `status` is Shopify's and the platform's word
 *   (`fulfillmentStatus`, `BulkOperationStatus`, an HTTP status) and `state`
 *   is Baton's (`RunState`, the state tables); a Baton field, literal or
 *   URL key is never named `status`.
 * - A stored literal is the vocabulary word where the store is ours;
 *   Shopify's literals are stored as sent and read through a predicate. A
 *   state table's `stored` column says how each word is held, in one of
 *   three forms, the data-model table's derivation words: a bare literal in
 *   backticks (`open`) is stored, never derived, and the literal is the
 *   word, so renaming the word renames the literal; a column with `set` or
 *   `null` (`blockedAt` set) means the word is derived, never stored, from
 *   that column, and lives in its predicate (`runIsBlocked`); a table whose
 *   words are derived from other rows has no `stored` column and its intro
 *   names the derivation. `pnpm spec check` holds every `stored` cell to a
 *   column or literal of `initializeSchema`.
 * - A word that fails is mapped to the existing word, retired, or split. A
 *   retired word goes on the retired list and `scripts/rules-lint.ts`
 *   refuses it.
 *
 * Where a stored name is not the word, and why:
 *
 * - A foreign vocabulary's table, field or literal keeps its owner's name
 *   and is read through a predicate: Shopify's (`fulfillmentStatus`,
 *   `FULFILLED`, `eventHandle`) and better-auth's tables (User, Session,
 *   Account, Verification, in D1).
 * - A SQL reserved word takes the noun's symbol form: `ShopOrder`, because
 *   `Order` collides with `order by` in every hand-written query.
 * - A mechanism column (idempotencyKey, attempts, webhookId, lastError,
 *   syncedAt) names no concept, has no row, and is named plainly.
 *
 * Screens. A JSDoc, a test or a research doc names a screen by its spec
 * name, never by its route segment and never with "run". The heading is
 * what the person sees on the page. Two screens share the spec name
 * "workflow page", one per side; a JSDoc that mentions both sides
 * qualifies with "the merchant's" or "the member's".
 *
 * | side     | route file                        | heading                      | spec name                   |
 * | -------- | --------------------------------- | ---------------------------- | --------------------------- |
 * | merchant | `app.index`                       | Baton                        | the home page               |
 * | merchant | `app.orders.index`                | Orders                       | the orders index            |
 * | merchant | `app.orders.$orderId`             | the order's name             | the order page              |
 * | merchant | `app.workflows.index`             | Workflows                    | the workflows index         |
 * | merchant | `app.workflows.$workflowId`       | the workflow's name          | the workflow page           |
 * | merchant | `app.workflows.$workflowId_.edit` | the workflow's name          | the workflow editor         |
 * | merchant | `app.teams.index`                 | Teams                        | the teams index             |
 * | merchant | `app.teams.$teamId`               | the team's name              | the team page               |
 * | merchant | `app.members`                     | Members                      | the members page            |
 * | member   | `shop.index`                      | Your stores                  | the shop picker             |
 * | member   | `shop.$shop.workflows.index`      | Workflows                    | the workflows list          |
 * | member   | `shop.$shop.workflows.$runId`     | the item's title             | the workflow page           |
 * | member   | `shop.$shop_.lapsed`              | the shop's domain            | the lapsed page             |
 *
 * The orders index's strip and Status select speak the two order tables plus
 * Open, Issues and All (`ORDERS_FILTER_LABEL` in ShopWork); the member's
 * workflows list's state row reads its labels from `workflowsListStates.ts`.
 */
export * from "./domain/Platform.ts";
export * from "./domain/Orders.ts";
export * from "./domain/Billing.ts";
export * from "./domain/ShopWork.ts";
