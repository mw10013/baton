/**
 * The domain's map and its barrel: the four context files under
 * `src/lib/domain/`, where each behavioural rule is written down, re-exported
 * as one module, plus the one page shape that reads two contexts.
 *
 * - A rule is stated once, on the symbol that *is* the concept (a
 *   `Schema.Literals` such as `RunStatus` in Production) or the function that
 *   enforces it (`reopenBlockedBy`, `currentTasks` in Production). A concept with
 *   more than one rule carries a table naming each rule's predicate.
 * - Every other site calls the predicate (`runIsOpen`,
 *   `runIsBlocked` in Production, `userIsAdmin` in Platform, ...) rather than comparing a
 *   literal. `scripts/rules-lint.ts`, run by `pnpm lint`, refuses an inline
 *   `.status`, `.flag` or admin `.role` comparison anywhere else under `src/`.
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
 * vocabulary. This file re-exports the four by `export *` and defines one
 * thing of its own, `OrdersIndexLoaderData`, the one page shape that reads
 * two contexts, until the loader-data types leave the domain; nothing outside
 * `src/lib/domain/` imports a context file directly, and a context file
 * imports only what its `may import` cell names. `scripts/rules-lint.ts`
 * reads the cell and refuses both. Every vocabulary table
 * names its context, in its first line or in a `context` column:
 *
 * | context    | kind       | about                                                                 | whose words                  | file            | may import         |
 * | ---------- | ---------- | --------------------------------------------------------------------- | ---------------------------- | --------------- | ------------------ |
 * | production | core       | what the shop makes and who makes it                                  | Baton's and the shop floor's | `Production.ts` | orders, platform   |
 * | orders     | supporting | what Shopify says about an order                                      | Shopify's admin              | `Orders.ts`     | platform           |
 * | billing    | generic    | what the shop pays for                                                | Shopify's Partner API        | `Billing.ts`    | orders, platform   |
 * | platform   | dialect    | dialect, not a context: the technical words; no model of the business | Cloudflare's and Baton's     | `Platform.ts`   | (nothing)          |
 *
 * Production is downstream of orders: conformist on words, a translation on
 * model. It crosses at `OrderState`, `orderIsOpen`, `unitsToMake`,
 * `ShopOrder` and `OrderLineItem`, and what it makes of an order (positions,
 * issues, an item's card) is production's, not orders'. Billing is
 * downstream of orders through one shared field, `ShopOrder` field
 * `countedAt`, the counted order. Every context uses the platform dialect:
 * the ids (`Shop`, `ShopGid`, `EpochMillis`), `ShopLimits`, `ShopSession`
 * and the connection. Orders never reads production, and platform reads
 * none of the three.
 *
 * Shared words. A word two contexts share always travels with its noun,
 * in copy and in identifiers (`<noun>Is<State>`, never `is<State>`), so
 * each context keeps its meaning. "open" on an order is `orderIsOpen` in Orders,
 * not fulfilled and not cancelled: the orders index's default view,
 * labelled Open. One row per shared word:
 *
 * | word   | contexts           | noun form                                                                                                                  |
 * | ------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
 * | open   | orders, production | "open order" (`orderIsOpen`), "open run" (`runIsOpen`)                                                                     |
 * | closed | orders, production | "closed order" (the matrices' `order` column: cancelled or fulfilled), "closed run" (`runIsClosed`)                        |
 * | cancel | orders, production | "cancelled order" (`orderIsCancelled`, Shopify's), "Cancel workflow" (the run verb, `merchant_cancelled`)                  |
 * | start  | production         | two senses: a member starts a task (the verb, `StartTaskInput`); a workflow starts for an item, in merchant copy, and in identifiers a workflow creates a run (`workflowIsEligible`) |
 *
 * What a word must pass to get a row:
 *
 * - A word names a concept the domain has, not a mechanism or a metaphor.
 * - A word has one meaning in its context. A word two contexts share is a
 *   row of the Shared words table and always travels with its noun.
 * - Shopify's things get Shopify's words, unchanged. Baton's things get
 *   plain words, and an invented word never reaches a screen.
 * - A stored literal is the vocabulary word where the store is ours;
 *   Shopify's literals are stored as sent and read through a predicate.
 * - A word that fails is mapped to the existing word, retired, or split. A
 *   retired word goes on the retired list and `scripts/rules-lint.ts`
 *   refuses it.
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
 * The orders index's view row speaks the two order tables plus Open, Issues
 * and All (`ORDERS_INDEX_VIEW_LABEL` in Production); the member's workflows list's
 * view row reads its labels from `workflowsListViews.ts`.
 */
import type { ShopUsage } from "./domain/Billing.ts";
import type { OrdersIndexData } from "./domain/Production.ts";

export * from "./domain/Platform.ts";
export * from "./domain/Orders.ts";
export * from "./domain/Billing.ts";
export * from "./domain/Production.ts";

/**
 * `/app/orders` (`app.orders.index`): the first page, plus the usage the
 * page's limit banners need.
 *
 * `orders` is what the socket replaces on every order push; `usage` is
 * loader-only and deliberately does not move under the socket. It is a
 * billing-cycle fact, and refreshing it on every webhook would be a read per
 * push for a number that changes on a scale of days.
 */
export interface OrdersIndexLoaderData {
  readonly orders: OrdersIndexData;
  readonly usage: ShopUsage;
}
