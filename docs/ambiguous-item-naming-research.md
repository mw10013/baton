# Naming the ambiguous item: the vocabulary word and its screen label

Written 2026-10-01. The question: is "ambiguous" the right word for an item that two or more
eligible workflows match, and is its screen label, Needs a workflow, the right one? This doc
looks at both, with a recommendation on each and the questions that decide them.

## What the situation is

**A workflow's tag is unique.** `Workflow.tag` is `text not null unique` in the object's schema
(`src/lib/ShopAgentSchema.ts`), and the workflow row of the data-model table says it: "no two
workflows share either" tag or name. So two workflows never share a tag.

**The ambiguity is on the product.** An item matches a workflow when the item's product carries
the workflow's tag (`matchesTag` in `src/lib/domain/ShopWork.ts`). An item that two
eligible workflows match is an item whose product carries two tags, each of them a different
workflow's tag. For example, a product tagged `engrave` and `finish`, with an Engraving workflow
on `engrave` and a Finishing workflow on `finish`.

Baton makes one run per item, never the cross product, so it does not guess: it creates nothing,
the order shows the issue in the Issues view and the Issues column, and the order page's item
card shows the sentence "More than one workflow matches this item, so none was started." above
the workflow picker, which lists the matched workflows first.

An earlier draft of this analysis said the cause was "two workflows sharing a tag". That was
wrong, and the recommendation that rested on it ("Workflows overlap") is withdrawn below.

**Why a product carries two workflow tags.** Three possible reasons. Which ones occur affects
both the label and the remedy:

1. **Mistake.** Someone tagged the product twice, or a product was retagged and the old tag left
   behind. Remedy: remove a tag from the product in Shopify.
2. **The variant decides.** Shopify product tags are on the product, not the variant. A product
   with an Engraved and a Plain variant can only route by variant if it carries both tags, and
   the variant picks the workflow. Baton's match does not read the variant, so every order for
   that product is ambiguous. The remedy on each order is to choose; the lasting remedy is a
   different product setup (one product per variant that routes differently). Baton will not
   match on the variant (decision 1).
3. **The item needs both.** The product really goes through engraving and then finishing. Baton
   makes one run per item, so the merchant's real remedy is one workflow that has both steps,
   with its own tag, and the product retagged to it.

In every case the remedy on this order is the same: choose one workflow on the order page. The
lasting remedy, when there is one, is on the product in Shopify or in how the workflows are
built, never "pick between two workflows that collide".

One more fact about the lasting remedy: product tags are read with the order (`product { tags }`
in the order queries) and stored on the line item. Editing a product's tags in Shopify is not an
order event, so an order Baton already stored keeps its old tags, and its issue, until something
reads the order again (Sync from Shopify on the order page, or the next webhook for that order). Retagging fixes
new orders, not stored ones.

## What Baton knows about the variant

**Variants have no tags.** In the Admin GraphQL API, `tags` is a field of `Product`, not of
`ProductVariant`. A variant has a title, its selected options (Color: Brass), a SKU and
metafields, but no tags. So a tag can never say which variant goes to which workflow.

**What the line item carries, and what Baton stores.** The order queries read, per line item:
`title`, `variantTitle`, `sku`, `quantity`, `currentQuantity`, `customAttributes` (the item's
properties) and `product { tags }` (`OrderSync.ts`, `OrdersBulkRepository.ts`). All of it is
stored on `OrderLineItem`. The variant and product ids are not stored, by decision on
`OrderLineItem` ("nothing links to the product").

**What Baton shows.** The variant title is shown wherever the item is named:

| screen                          | how                                                         |
| ------------------------------- | ----------------------------------------------------------- |
| the order page, item card       | "Brass hinge — Large", then `× 2 · SKU ...` under it        |
| the order page, the run's lines | the same title with the variant                             |
| the member's workflow page      | "Large · Quantity 2" under the item title (`MemberRun.tsx`) |

The item's properties (`customAttributes`, such as an engraving text) are stored and shown on
the item card as Shopify sends them.

**What Baton does not capture.** The variant's selected options as separate name and value
pairs (`variant { selectedOptions { name value } }`), and the variant's id. `variantTitle` is
the options joined ("Large / Brass"). Baton only shows it; nothing matches on it.

So for case 2 the merchant already sees which variant was ordered, on the order page next to the
picker, and chooses by it. A match is a product tag equal to a workflow's tag and nothing else
(decision 1).

## Where the word shows today

| place                           | text                                                              |
| ------------------------------- | ----------------------------------------------------------------- |
| vocabulary word (shop work)     | ambiguous                                                         |
| code                            | `ambiguousItems`, `OrderIssue` `ambiguous`, `AMBIGUOUS_ITEM`, ... |
| order issue label, orders index | Needs a workflow (`ORDER_ISSUE_LABEL.ambiguous`)                  |
| item card sentence, order page  | More than one workflow matches this item, so none was started.    |
| picker placeholder, order page  | Choose workflow                                                   |

The merchant never sees "ambiguous". So there are two questions: the screen label, which the
merchant reads, and the code word, which only the code, JSDoc, tests and research read.

## The screen label

### What is wrong with Needs a workflow

It reads as "no workflow matches this order's items". That is the one case the issue definition
excludes: an unmatched item is not an issue (`OrderIssue` JSDoc, "An issue is an undecided
item"). The actual fault is the opposite: too many workflows match. A merchant who takes the
label at its word may create or tag another workflow, which adds a third match and makes the
fault worse.

It also sits next to Needs a team, which does mean "missing": an open task on no team. The two
labels have the same shape and opposite meanings.

### Candidates

| label                    | says the fact               | says what to do | notes                                                                                                                     |
| ------------------------ | --------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Needs a workflow (today) | no: implies zero matches    | vaguely         | the wrong cause, and the same shape as Needs a team                                                                       |
| Workflows overlap        | no                          | no              | withdrawn: workflows never overlap, tags are unique; the cause is the product                                             |
| Multiple workflows match | yes                         | no              | uses the vocabulary word "match"; agrees with the item card's sentence; no count to drift from the picker                 |
| More than one workflow   | yes                         | no              | the item card's own phrase; reads unfinished as a badge                                                                   |
| 2 workflows match        | yes, exactly                | no              | a count is a second source of truth beside the picker, which the item card's sentence avoids on purpose; variable text    |
| Choose a workflow        | no                          | yes             | the remedy, not the fault; the Issues view lists faults (Blocked, Team has no members), so it breaks the column's pattern |
| Too many tags            | yes, the product-side cause | partly          | names the cause, but blames the product even in case 2 and 3 above, where the tags are deliberate                         |

### Recommendation

**Multiple workflows match.** It states the fault in the vocabulary's own word, it cannot be
read as "none", it agrees with the sentence on the order page, and it does not decide for the
merchant whether the tags are a mistake. The order page's sentence and picker already carry the
rest: what Baton did (nothing started) and what to do (choose).

The label is a column cell on the orders index. "Multiple workflows match" on an order, not an
item, is slightly loose (it is one item that matches), but every issue label is the order's
summary of an item- or task-level fault, as Needs a team is.

## The code word

With the cause on the product, "overlap" no longer fits: it described the workflows, and the
workflows are not at fault.

| word              | for                                                                                   | against                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ambiguous (today) | accurate; one word; in place across code, SQL, tests and the reconcile outcomes table | abstract: names Baton's uncertainty, not the fact; shares nothing with the screen label |
| multi-match       | built on "match"; literal; shares its stem with the recommended label                 | a compound; identifiers read `multiMatchItems`, `OrderIssue` `multi_match`              |
| undecided         | the `OrderIssue` JSDoc already frames issues this way                                 | too broad: by that JSDoc every issue is an undecided item                               |
| unchosen          | names the missing act, the merchant's choice                                          | true of every attachable item, including an unmatched one; does not say why             |

### Recommendation

**Rename to multi-match**, if the screen label becomes Multiple workflows match. Then the code
and the screen say the same thing in the same word, which is what the vocabulary's screen
column is for, and the meaning cell stays as it is: "an item two or more eligible workflows
match, with no run". The rename follows `docs/vocabulary-runbook.md`: the vocabulary row, the
order-issues row, `OrderIssue`, `ORDER_ISSUE_LABEL`, `ambiguousItems`, `AMBIGUOUS_ITEM` and
`AMBIGUOUS` in `OrderRepository.ts`, `ReconcileCounts.ambiguous`, the reconcile outcomes table's
"nothing: ambiguous" cell, `lineItemState`'s `ambiguous` flag, `AMBIGUITY_SENTENCE`, the log
fields, and the tests titled with the word.

If the screen label stays something else, keep "ambiguous": it is correct, and a rename that
leaves code and screen in different words gains little for its cost.

The screen label matters more than the code word. If only one changes, change the label.

## Decisions

Answered 2026-10-01.

| #   | question                                           | decision                                                                                                                                                            |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | which reasons for two tags to plan for             | none specially: a match is a product tag equal to a workflow's tag, and that is all; Baton never matches on the variant; the variant title is shown, not matched on |
| 2   | point at a lasting remedy, or the per-order choice | the per-order choice only, for now; no hint to retag the product, because in the variant case the tags are deliberate                                               |
| 3   | a count on the label                               | no count; a count beside the picker's list is a second source of truth, and variable text is harder to scan                                                         |
| 4   | the code word follows the screen label             | yes: if the label becomes Multiple workflows match, the word becomes multi-match; otherwise it stays ambiguous                                                      |
| 5   | the picker placeholder                             | unchanged, Choose workflow; the sentence above says more than one matched and the list order shows which; `s-select` has no option groups                           |
| 6   | the screen label                                   | Multiple workflows match, replacing Needs a workflow; with decision 4, the code word becomes multi-match                                                            |
