# Workflow naming, from first principles — research

Research date: 2026-09-06. Research only, not a spec. No rename map here by request: this is reasoning, candidates, trade-offs, and a recommendation.

Scope, as agreed:

- **In**: the root noun (`workflow`), the two kinds and how they are named, the internal discriminant currently called `scope`, and the definition-side verbs (Edit / Draft / Apply / Discard).
- **In, because the naming depends on it**: whether the order-level workflow should stay a finishing pass, or start when the order is paid.
- **In**: whether the store owner and the shop-floor worker should share one vocabulary.
- **Out for now**: `run`, `step`, `stage`, `queue`, `team`, `member`, and the run-side status words. They are named well enough and touching them widens the blast radius past what the question needs.

Everything existing is treated as revisable. Where the recommendation lands on the status quo, that is a conclusion, not an inheritance.

## Decisions taken, 2026-09-06

Recorded after the first read of this document, so a later reader knows which sections are settled and which are still live.

| Question                                                                         | Status                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — root noun stays `workflow`                                                   | **Settled.**                                                                                                                                                                                                                                                                                                                                    |
| 2 — unqualified `workflow` is the default; `item workflow` only when contrasting | **Settled.** "Product workflow" is off the table entirely; the reasoning is kept below only so the decision does not get relitigated.                                                                                                                                                                                                           |
| 3 — how the two kinds are presented                                              | **Settled: one nav entry, two stacked sections on `/app/workflows`** (option B in the companion artifact). The order workflow gets its own compact section above the item-workflow list and shares no table, filter or create button with it. Not yet built.                                                                                    |
| 4 — the order workflow keeps the after-items rule                                | **Settled and shipped** (`7b7ab34`). The copy and behaviour fixes it implied are specified and implemented per `order-workflow-trigger-truth-research.md`.                                                                                                                                                                                      |
| 5 — replacing `scope`                                                            | **Settled as `type`.** The original recommendation here was `runsOn`; it was rejected as obscure and the section below rewritten. **Not yet done** — `scope` is still the field name as of `7b7ab34`, and its JSDoc has since grown to carry the whole order-run trigger rule, so the rename touches a larger comment block than it would have. |
| 6 — Edit / Draft / Apply / Discard / Turn on / Turn off                          | **Settled, unchanged.**                                                                                                                                                                                                                                                                                                                         |
| 7 — one vocabulary across the owner and worker surfaces                          | **Settled in principle**, with one concrete consequence identified below. The queue badge is not yet changed.                                                                                                                                                                                                                                   |

Made-to-order (MTO), used throughout: a shop that makes each item after the order arrives rather than picking it off a shelf. It is the shop Baton is for.

## The test a name has to pass

Four criteria, in priority order. They are used consistently below.

1. **Recognition.** A Shopify merchant should already own the word. Baton is a production app bought by people who make things, not by people who model workflows.
2. **Truth.** The name should describe what the thing actually does, so that reading the name and reading the behaviour never disagree. A name that has to be corrected by a tooltip has failed.
3. **No new concepts.** Every noun the merchant has to learn is a tax. Adding a second noun for a thing that is mechanically the same thing is the most expensive mistake available here.
4. **Cost.** Migration and churn matter, but they are the tiebreaker, never the argument.

## What the merchant already knows

| Word                                      | Where the merchant met it                                                                                                     | Consequence for us                                                                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**                              | Shopify Flow. There, a workflow is _trigger → conditions → actions_, fully automated, no humans.                              | Highest-recognition word available, and the collision is real. Baton's workflow is a list of things **people** do. Mitigation is to never borrow Flow's sub-vocabulary (`trigger`, `condition`, `action`) as UI nouns; Baton already doesn't. |
| **Item**                                  | The Shopify order page says _Items_, _Unfulfilled items_. "Line item" is developer vocabulary; "item" is merchant vocabulary. | "Item" is a free word. It costs the merchant nothing to learn because they read it on every order.                                                                                                                                            |
| **Product**                               | The catalog. A product is a thing you sell, managed on its own page, with its own tags.                                       | Loaded. "Product X" is a catalog entity, not a thing on an order.                                                                                                                                                                             |
| **Order**                                 | Everywhere.                                                                                                                   | Free, but so broad it can fail criterion 2 — see below.                                                                                                                                                                                       |
| **Fulfillment**                           | A specific Shopify object with locations, fulfillment orders and holds.                                                       | Do not reuse. Any Baton noun containing "fulfillment" will be read as the Shopify object.                                                                                                                                                     |
| **Stage / pipeline / department / batch** | Competitor apps (Route to Ship uses _pipeline_ + _department_; others use _stage_, _batch_, _job_).                           | Available, but each carries a competitor's data model. `stage` is already used inside Baton for parallel step grouping and should not be spent on anything else.                                                                              |

Competitor scan (`refs/route-to-ship`, `refs/kanbanify`, `refs/makers-production-view`, `refs/benchcue`, `refs/makerbatch`): the marketing pages lean on **order** (84 mentions) far more than on any structural noun; `department`, `stage`, `workflow`, `pipeline`, `step`, `job`, `batch` all appear in single digits and none dominates. There is no settled industry word to inherit. Merchants recognise the _problem_ vocabulary (orders, items, who's making it), not the _model_ vocabulary.

## Question 1 — is "workflow" the right root noun?

| Candidate                          | For                                                                                                                       | Against                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**                       | Highest recognition. Generic enough to cover both kinds. Already the app's whole vocabulary and the merchant-facing copy. | Collides with Shopify Flow, where it means automation. Slightly abstract: it names the shape, not the purpose.                                                                    |
| **Process**                        | Truthful and neutral: "our packing process". No Shopify collision.                                                        | Lower recognition as a configurable object. "Create a process" reads like consulting. Merchants say "workflow" out loud more often.                                               |
| **Checklist**                      | Warmest, most concrete, needs zero explanation.                                                                           | Undersells the model badly: checklists have no teams, no ordering guarantees, no parallel stages. Would have to be walked back the moment a merchant asks who does step 3.        |
| **Recipe**                         | Good fit for makers.                                                                                                      | Implies ingredients / a bill of materials that Baton does not have and should not imply.                                                                                          |
| **Build / build sheet / traveler** | Genuine shop-floor words for made-to-order. A "traveler" is exactly the paper Baton replaces.                             | "Build" is narrow (wrong for prints, services, embroidery-as-service). "Traveler" is unknown outside manufacturing.                                                               |
| **Routing**                        | The correct manufacturing term for an ordered list of operations.                                                         | Unknown to Shopify merchants, and already banned in this codebase (`Domain.ts` vocabulary block excludes route/routing/routable) partly because it collides with TanStack routes. |

**Recommendation: keep `workflow`.** It wins criterion 1 outright and loses nothing on criteria 2 or 3 that a better word actually recovers. The Flow collision is survivable because the two never share a surface, and because Baton's copy describes human work ("assign a team", "mark done") in a way Flow's never does. Nothing else on the list is enough of an improvement to be worth retraining every merchant, every doc, and every support answer.

## Question 2 — naming the item kind

The thing: one run per **line item** on an order, selected by matching the product's tags. Two of the same product on one order is **one** run with `quantity: 2`, not two runs (`unique (lineItemId, workflowId)`).

| Candidate                 | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**, unqualified | Correct as the _default_. This kind is the bulk of what a merchant creates; making the common case carry an adjective demotes it.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Item workflow**         | Best qualifier. "Item" is Shopify's own merchant-facing word for the thing on the order, so it costs nothing to learn, and it is literally true — one run per item.                                                                                                                                                                                                                                                                                                                                                                                  |
| **Product workflow**      | **Rejected, and off the table (decided 2026-09-06).** It fails criterion 2 in a way that will actively mislead. It suggests the workflow is a property of the product, managed on the product page, which is exactly what a merchant will then go looking for. It is also wrong about cardinality: nothing runs per product, it runs per item on an order. The only thing "product" is right about is the _selector_ (product tags) — and the trigger copy already says that in a full sentence: "Starts when an order contains a product tagged X." |
| **Line item workflow**    | Accurate but developer-flavoured; "line item" is not a word the Shopify admin says to merchants.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Order line workflow**   | Most precise, worst to say. Also puts "order" in the name of the kind that is _not_ the order-level one — actively confusing next to "order workflow".                                                                                                                                                                                                                                                                                                                                                                                               |

**Recommendation: the default name is `workflow`, unqualified. The qualifier, used only when contrasting with the order-level kind, is `item workflow`.**

The important half of that recommendation is the second sentence. A qualifier is only ever needed in contrastive contexts — the nav, the create dialog, docs, this file. On a workflow's own detail page, in a run card, on the team page, in a delete dialog, there is nothing to contrast with and the adjective is noise. Most naming schemes fail by qualifying everywhere.

## Question 3 — naming the order kind

> **Status: settled.** The noun stays `order workflow`. The presentation is **option B**: one `Workflows` nav entry, one index page, two sections — a compact order-workflow section above the item-workflow list, sharing no table, no filter and no create button with it. An earlier iteration of Baton combined the two kinds on one page and it was confusing enough to be split back out; the note at the end of this section is why B is not a repeat of that.

The thing today: at most one per shop, no tags, one run per order, and it starts only after every item run on that order is done.

The problem with "order workflow" is criterion 2, and it is worse than it looks: **every** workflow in Baton is for an order. Nothing about the phrase tells a merchant that this one runs on the order _as a whole_, that there is only one, or — most importantly — that it **waits**. Sitting in the nav next to "Workflows", it also invites the wrong inference: _so the other ones aren't for orders?_

| Candidate                                | For                                                                                                              | Against                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Order workflow** (status quo)          | Structural and stable. Survives a change to the timing rule. Reads correctly once the merchant knows the model.  | Says nothing about waiting, or about being a singleton. Ambiguous next to "Workflows".                                                                                                                                                                                                       |
| **Finishing steps / Finishing workflow** | States the most important fact (it comes last) in a word every merchant owns. Kills the nav ambiguity instantly. | Becomes a lie the moment the timing rule changes (Question 4). And it is a **second noun for the same machine** — the merchant would meet "workflows" and "finishing steps" on the Teams page, in run cards, and in the queue, and have to learn they behave identically. Fails criterion 3. |
| **Final steps / Last steps**             | Same virtue, plainer.                                                                                            | Same two defects.                                                                                                                                                                                                                                                                            |
| **Packing workflow / Pack & ship**       | Most concrete of all.                                                                                            | Too prescriptive. Merchants will put invoicing, QC, photography, gift notes and customer follow-up here.                                                                                                                                                                                     |
| **Fulfillment workflow**                 | —                                                                                                                | Reject: collides with the Shopify object.                                                                                                                                                                                                                                                    |
| **Whole-order workflow**                 | Unambiguous about scope, and cheap: it is "order workflow" with one clarifying word.                             | Clunky in a nav item; fine in a sentence.                                                                                                                                                                                                                                                    |
| **Order-level workflow**                 | Clearer than "order workflow".                                                                                   | Introduces "level", a modelling word, into merchant copy.                                                                                                                                                                                                                                    |

**Recommendation: keep `order workflow` as the noun, and fix the comprehension problem with structure and copy rather than with a new noun.**

Two concrete moves carry the meaning that the adjective cannot:

1. **Teach the taxonomy by layout, not by adjective.** Today `/app/workflows` and `/app/order-workflow` are sibling nav items, which gives a shop-wide singleton the same weight as the entire list of item workflows and forces the merchant to infer the relationship. One "Workflows" nav entry, one index, two sections — the item workflows, then a section for the order workflow that says it is one per shop — teaches the model for free, in the place where the contrast is actually visible. This is the single highest-value change in this document.
2. **Make the trigger line state the wait.** "Finishing" should be the _description_, not the noun.

There is a live truth bug here today. `ORDER_WORKFLOW_TRIGGER` is the bare string `"Starts for every paid order."`, and `WorkflowDetail.tsx` renders exactly that on the order workflow's detail page. It is false: `startOrderRunIfReady` additionally requires at least one item run `done`, no item run open, an order workflow older than the order (unless an item was attached by hand), and no existing run for that pair. The index page patches it with a second sentence; the detail page does not. Whatever else is decided, that string should say what happens.

### Answering the earlier combined page

A previous iteration of Baton put both kinds on one page and it was confusing enough to be split apart; the split is what let `/app/workflows` and the shared detail editor get as good as they are. That is real evidence and the proposal has to survive it, so it is worth being precise about what was wrong then and what the proposal does differently.

The failure mode of a combined page is **heterogeneous rows in one table**. There is one order workflow and many item workflows; the item table has a Product tags column the order workflow can never fill, filters and a tag chip row that mean nothing for it, a search box it does not belong in, and a "Create workflow" button that becomes ambiguous the moment two things can be created. Every one of those is a defect of putting a singleton in a list, not of putting both kinds on one page.

The proposal is therefore explicitly **not** one list. The item workflows keep the page they have now — same table, same filters, same search, same tag chips, same Create button, untouched. The order workflow appears as a **single card in its own region**, never as a row, with its own name link, its own status badges, its own trigger line and its own create/empty state. The two never share a table, a filter or a button.

A correction to an earlier draft of this document, which claimed both kinds already share one detail editor. They did; they no longer do. As of `d13f89a` item workflows have a read-only detail page (`/app/workflows/$workflowId`) plus a separate editor route (`/app/workflows/$workflowId/edit`), both built on `src/components/WorkflowStages.tsx`, while the order workflow still renders the older combined `src/components/WorkflowDetail.tsx` — a component nothing else imports any more. So the drill-down the workflows page is liked for is **not** yet what the order workflow gets.

The order-workflow **index** is separately a mess, and for reasons unrelated to being its own page: an always-visible inline create form for a thing that already exists and can only exist once, a five-column table rendering a single row with a delete column, and two explanatory paragraphs in two cards (`src/routes/app.order-workflow.index.tsx:219-296`).

Which means there are **three** independent pieces of work, and they should not be bundled:

1. **The index.** Rebuild it to the quality of the workflows index — uncontroversial whichever nav shape wins.
2. **Placement.** Its own page, or a region on the Workflows page? This was the open question, and it is about discovery and teaching the taxonomy, not about quality. **Decided: option B**, a stacked section.
3. **The detail pair.** Bring the order workflow onto the read-only-detail + separate-editor pattern that item workflows already have, and retire `WorkflowDetail.tsx`. Independent of 1 and 2, larger than either, and worth doing regardless.

The mockups in the companion artifact show three shapes for piece 2 — an aside card, a stacked section, and a rebuilt standalone page under two nav entries — with the same content in each, so the comparison was about placement only. Four consequences of B are settled there: the order-workflow section sits **above** the item list and is **one compact row** rather than a card; the list gains the heading **Item workflows**, which is the only place the qualifier appears anywhere in the app; `/app/order-workflow` folds into `/app/workflows` while the detail route keeps working, because the order-page blocker copy shipped in `7b7ab34` links to it from three messages; and **Create workflow** creates an item workflow only, with the order workflow created from its own section's empty state — one button that has to ask "which kind?" is the specific defect that made the old combined page confusing.

## Question 4 — should the order workflow still wait for the items?

Raised as an open design question, because Question 3's answer partly depends on it. Today's rule, from `WorkflowRunRepository.startOrderRunIfReady`:

- order is paid and not cancelled;
- the order workflow can start (active, has steps, every step assigned);
- **at least one item run is `done`**;
- **no item run is still open**;
- no order run for that workflow already exists in any status (a cancelled one keeps its key);
- the order workflow predates the order — unless an item run was attached manually, which opts the order in.

Two consequences a merchant is never told about: an order whose items are all stock (no item workflow matched anything) **never** gets an order workflow, and the wait itself is invisible — there is no "waiting" state to look at, just nothing happening.

**The case for starting at paid.** Real made-to-order shops have head work: check the shipping address, confirm a delivery slot, chase a proof approval, order materials, print the job sheet. None of it can be expressed at order level today. To get it, the merchant duplicates a step into every item workflow, which is exactly the sort of copy-paste the app exists to remove. Starting at paid also makes the existing copy true, and gives stock-only orders somewhere to go.

**The case against.** Most head work in a personalisation shop is genuinely _per item_, not per order — spelling confirmation, proof approval and material selection all belong to the item being made, and item workflows already express them correctly and at the right granularity. The genuinely per-order head work (address check, delivery slot) is a thin set with no demand behind it yet. And "start at paid" only becomes useful alongside a way to say _this stage waits for the items_, which means either a self-completing step with no team (which collides with "a step with no team is unassigned and needs attention") or a stage-level wait property (a new concept, failing criterion 3). Starting at paid would also put every stock-only order into someone's queue, which is noise for a made-to-order shop.

**Recommendation: keep the order workflow as a pass that runs after the items, and do not build a wait gate yet.** The actual defect today is not the timing rule, it is that the timing rule is invisible and mis-stated. That is fixed with a sentence, not with machinery. Revisit the moment a merchant asks for order-level work that must happen _before_ the items are made — that request is the trigger, and it should be recorded as such rather than pre-built.

If it is ever revisited, the merchant-comprehensible form is a step named **"Wait for all items"** — a step, not a new kind of object, so the merchant learns nothing new and can see the wait sitting in the list. That is the cheapest possible expression and the one to reach for.

### Outcome (`7b7ab34`)

The recommendation was taken and implemented, with three corrections from review that are worth carrying back here:

- **The wait is not actually invisible.** The trigger runs inside the same transaction as the last item step's completion, so there is no observable gap between "last item done" and "order run exists"; while items are open, `Domain.productionState` resolves the order to `in_production`, which _is_ the wait's representation. The only genuinely unrepresented states were the dead-ends.
- **The dead-ends now name themselves.** The order page states the outcome in every case — off, no steps, unassigned step, too old, no item has a workflow, every item run cancelled — instead of hiding the section, and `ORDER_WORKFLOW_TRIGGER` is now one three-sentence string every surface renders unmodified.
- **A stranded order no longer needs a merchant to guess.** Turning the order workflow on, or applying a draft that makes it startable, now sweeps the orders already waiting for it. The manual "Start order workflow" escape hatch this document floated was rejected: Resync already existed, and a manual start invites routine bypassing of the wait.

The design questions this raised were all settled the conservative way — keep the `anyDone` condition, no order workflow for an all-cancelled order, no `waiting` run status. Details in `order-workflow-trigger-truth-research.md` §5.

## Question 5 — replacing `scope`

`scope` is an internal field on `Workflow` with values `"item" | "order"`. The objection to it is right: "scope" is a modelling word that promises a containment hierarchy the code does not have, and it reads as heavier than a two-valued discriminant deserves.

The decisive argument is one this document originally missed. Question 2 settled the merchant vocabulary as **an adjective on a noun** — an _item_ workflow, an _order_ workflow. An adjective on a noun is what a **type** is. So `type: "item" | "order"` maps one-to-one onto the words the merchant reads, and a developer moving between the copy and the code never has to translate. Any field name that introduces a _second_ framing — however precise — makes the code and the UI describe the same distinction two different ways.

| Candidate       | Reads as                        | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`type`**      | `workflow.type === "order"`     | **Recommended.** Conventional, instantly legible, and it mirrors the merchant vocabulary exactly. The generic objection to `type` — that every discriminant is a "type", so the word carries no information — is fair and does not matter here: the _values_ carry the information, and they are already the right words. A name that needs no explanation is worth more than a name that is 10% more precise and costs the reader a pause. |
| **`kind`**      | `workflow.kind === "order"`     | Semantically identical to `type`. Choose it only if `type` collides with something; nothing here does. It is a synonym, not an improvement, and picking the less common synonym is itself a small speed bump.                                                                                                                                                                                                                               |
| **`runsOn`**    | `workflow.runsOn === "order"`   | **Rejected.** It was the original recommendation, on the grounds that it states the field's exact effect: one run per item, or one per order. That is true, and it is not enough. It reads as a puzzle on first encounter ("runs on… a server?"), and it describes a run-side consequence on a definition-side field, which is a second framing the UI never uses. Precision that has to be explained is not precision the reader gets.     |
| **`appliesTo`** | `workflow.appliesTo === "item"` | Same defect as `runsOn`, less acute. Reads as plain English but still frames the distinction as a relationship rather than as a kind.                                                                                                                                                                                                                                                                                                       |
| **`level`**     | `workflow.level === "order"`    | Would pair with "order-level workflow" in copy, but reintroduces exactly the hierarchy implication that made `scope` wrong.                                                                                                                                                                                                                                                                                                                 |
| **`_tag`**      | `workflow._tag === "order"`     | The Effect-idiomatic discriminant, and used elsewhere in `Domain.ts` for result unions. Wrong here: this field is a stored SQLite column, and `_tag` as a column name exports a library convention into the schema for no benefit.                                                                                                                                                                                                          |

**Recommendation: `type`, values unchanged (`"item"` and `"order"`).**

On cost: none worth weighing. The field is a column in the ShopAgent Durable Object's private SQLite, and the app is still prototyping — the schema is recreated from `initializeSchema` rather than migrated, so this is an in-line rename of the DDL, the schema literals, the eleven read sites listed in `workflow-scope-tables-research.md`, and the seed fixtures. No migration file, no compatibility window.

The values themselves should not change. They are already the merchant's words, and churning them would touch the seed fixtures, the e2e selectors and the run trigger for no gain.

## Question 6 — the definition-side verbs

**Edit → Draft → Apply changes / Discard changes**, with **Turn on / Turn off** as an independent switch.

This vocabulary is already good and should be kept. It passes all four criteria: every word is one a merchant owns, each says exactly what it does, there are no synonyms competing for the same action, and the existing `Domain.Workflow` vocabulary block explicitly bans the alternatives that would muddy it (`version`, `live`, `saved`, `published`, `retired`, `applied` as a state). Two properties worth protecting deliberately:

- **"Draft" is a noun the merchant can point at**, not a state adjective. There is at most one, it exists or it doesn't, and the workflow that starts runs is untouched while it exists. Calling it a "version" or a "revision" would imply history the model does not keep.
- **Turn on / Turn off is not part of the draft cycle.** Keeping the switch verbs lexically distinct from the draft verbs is what stops a merchant from expecting Apply to also activate.

The one gap: there is no merchant-facing noun for _the workflow as opposed to its draft_. The code says "the workflow" and the copy says "what starts runs today". That is acceptable — inventing a word for it ("the live one", "the published one") would import exactly the versioning implication the vocabulary block bans.

## Question 7 — one vocabulary, or two?

The instinct that one shared vocabulary is better is right. The useful version of that answer is more specific than "use the same words", because the two surfaces are not doing the same job.

| Surface                                 | Who                   | What they can do                                                                                           |
| --------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/app/…`, embedded in the Shopify admin | The store owner       | Configure workflows, teams and members; supervise orders                                                   |
| `/shop/$shop/queue`                     | The shop-floor worker | Start a step, finish a step, leave a note. Nothing else. There is no configuration on this surface at all. |

**The rule: one vocabulary, split into two halves, and the worker only ever meets one of them.**

| Half                                        | Words                                                                                                               | Who meets them | Why                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Definition words** — what _should_ happen | workflow, item workflow, order workflow, draft, Apply, Discard, Turn on / Turn off, product tag, step-as-configured | The owner only | A worker cannot open, change or act on any of these. Putting one in front of them names a thing they have no access to.                                              |
| **Work words** — what _is_ happening        | the order, the item, the step in front of you, your team, started, done, note, needs attention                      | Both roles     | The owner and the worker stand in the same building and talk about these out loud. They must mean the same thing to both, or every conversation needs a translation. |

Two separate dialects would be worse than either alternative: it would add a translation layer between two people who work together, for no gain. But teaching the worker the definition half is also a cost with no return — a worker cannot act on a workflow, only on a step.

Baton already gets most of this right. The worker's page is headed "Your work" and shows steps, items and statuses; the words `draft`, `Apply`, `product tag` and `Turn on` never appear on it.

### The one concrete consequence

There is a single place where a definition word reaches the worker, and because it is a _workflow_ word it is in scope for this document. On the queue, an order run's card renders the order's line items, and any item with no item run gets `<s-badge>No workflow</s-badge>` (`src/routes/shop.$shop.queue.tsx:456`). The card itself is also badged with the workflow's name (`:440`).

"No workflow" fails the rule twice over: it names a definition the worker cannot see, and it reports an _absence_ in a system they have no access to. What a packer standing at the bench actually needs to know about that line item is whether anything was made for it — and the answer, phrased in work words, is that nothing was.

| Option                | Assessment                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **"No steps"**        | Recommended. True, in work vocabulary, and it answers the packer's real question — there was nothing to do for this item. |
| **"Nothing to make"** | Warmer and equally true; slightly long next to the other status badges.                                                   |
| Show no badge at all  | Cheapest, and ambiguous: silence reads as "status unknown" rather than "nothing was made".                                |
| Keep "No workflow"    | Only defensible if workers are expected to learn the configuration model, which they are not.                             |

The workflow-name badge on the card (`:440`) is a closer call and should stay: it is a proper noun the worker hears out loud ("that's the Engraved Ring one"), not a concept they have to understand.

**Recommendation: one vocabulary, two halves, with a standing rule that no definition word appears on the worker's surface — and "No workflow" on the queue replaced with a work word.**

## Summary of recommendations

| #   | Decision          | Recommendation                                                                                                                                                                                                           | Confidence                      |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 1   | Root noun         | Keep **workflow**. Never borrow Flow's `trigger`/`condition`/`action` as nouns.                                                                                                                                          | High                            |
| 2   | Item kind         | Default name is **workflow**, unqualified. Qualifier **item workflow**, used only when contrasting. Reject "product workflow".                                                                                           | High                            |
| 3   | Order kind        | Keep **order workflow** (settled). How the two kinds are presented is **open** — see the companion mockup artifact and the note at the end of Question 3.                                                                | Name: high. Presentation: open. |
| 4   | Order-kind timing | Keep the after-items rule. Fix the invisible/mis-stated wait with copy. Revisit when a merchant asks for pre-item order work; the form to reach for then is a **"Wait for all items"** step.                             | Medium                          |
| 5   | `scope`           | Rename to **`type`**. Keep the literals `"item"` and `"order"`. In-line rename; no migration while prototyping.                                                                                                          | High                            |
| 6   | Definition verbs  | Keep Edit / Draft / Apply changes / Discard changes / Turn on / Turn off unchanged.                                                                                                                                      | High                            |
| 7   | Two surfaces      | One vocabulary, two halves: definition words (owner only) and work words (both). Standing rule: no definition word on the worker's surface. Concretely, replace the queue's **"No workflow"** badge with **"No steps"**. | Medium-high                     |

## Loose ends worth fixing regardless of the naming decisions

Found while researching; each was a truth problem rather than a taste problem. They are written up in full, with line references and fixes, in `order-workflow-trigger-truth-research.md` — that document supersedes this list. Status as of `7b7ab34`:

| Loose end                                                                                                            | Status                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDER_WORKFLOW_TRIGGER` said "Starts for every paid order." on the detail page while the real rule was far narrower | **Fixed.** One three-sentence constant, rendered unmodified by every surface that describes the trigger.                                        |
| An order with no matching item workflow never gets an order workflow, and nothing said so                            | **Fixed.** The order page names that outcome instead of hiding the section.                                                                     |
| The age rule was explained on the order detail page only                                                             | **Fixed.** It is a clause in the shared trigger string, so it appears wherever the trigger does.                                                |
| Orders stranded when the order workflow was off or had an unassigned step                                            | **Fixed.** `startReadyOrderRuns` sweeps them when the workflow is turned on or applied; the order page names the blocker with a link to fix it. |
| The nav gives a shop-wide singleton the same weight as every item workflow combined                                  | **Open.** This is Question 3's option B, decided but not built.                                                                                 |
