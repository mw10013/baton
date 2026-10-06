# The workflow switch: On/Off or Active/Inactive, and what the title bar shows

Written 2026-10-06, after commit e71a653. The question: the merchant workflow page should read
like Shopify Flow's workflow page, since Flow is Shopify's own workflow product inside the same
admin and the same Polaris. Side by side, Baton's page says **On** in a green badge and **Turn
off** in a red button; Flow's says **Active** in a grey badge and **Turn off workflow** in a red
button. Which of these differences are Baton being right for its own reasons, and which are Baton
being different for no reason?

Sources: the live Flow app and the live Baton app on `sandbox-shop-00`, read 2026-10-06 (the Flow
workflow was turned off and back on to see both states); the Flow help center in
`refs/flow-manual/manage/manage.md` ("Deactivate a workflow"); the Polaris badge reference in
`refs/shopify-docs/docs/api/app-home/latest/web-components/feedback-and-status-indicators/badge.md`;
the vocabulary in `src/lib/domain/ShopWork.ts`, the reserved stems in `scripts/lib/rules-lint.ts`,
and the copy and controls tables in `src/lib/Screen.ts`.

## Short answers

- **Flow's verb is Turn on / Turn off; its state is Active / Inactive.** Baton already took the
  verbs from Flow and chose On / Off for the state because "active" was reserved. The reservation
  was made for an older model (`activatedAt`, a date), not for a badge word.
- **On / Off fails as a state word on first principles.** It works as a badge and as a predicate
  ("the workflow is on"), and nowhere else: not as an adjective ("only off workflows can be
  deleted"), not as a filter label ("Off" as a tab), not in a sentence about a set ("three
  inactive workflows"). Active / Inactive works in every slot. Recommendation: adopt it.
- **Flow is not uniformly muted.** Its title-bar badge is the default grey in both states; its
  index badge is green for Active and grey for Inactive. Polaris's own badge reference uses
  `tone="success"` for Active. Recommendation: grey in the title bar, where the primary button
  already carries the colour; green on index rows, where the badge is the only signal.
- **Flow's title-bar buttons carry the noun; its menu entries do not.** "Turn off workflow" and
  "Edit" in the title bar; Export, Duplicate, Rename, Manage tags, Delete in More actions.
  Recommendation: match it. The verb-alone rule from commit c627548 is about counts, not nouns.
- **Baton's modals are better than Flow's and should stay.** Flow: "Ready to turn on your
  automation workflow?" / "Turning on the workflow will activate the automation." Baton: "Turn on
  Clock assembly?" / "Every open order with an item tagged “wall-clock” starts this workflow on
  that item." Baton's say a fact.
- **The "Last updated" line sits on the card.** Baton leaves about 8px between the line and the
  card; Flow leaves about 24px and aligns the line with the page, not the card. Recommendation: a
  part with a row, since routes may not space things themselves.

## What the two pages show

Read 2026-10-06. The Flow workflow is a scheduled one with no runs; the Baton workflow is Clock
assembly, on, with three steps.

| place                | Flow                                                                                                                     | Baton                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| title badge, on      | Active, default tone (grey)                                                                                              | On, `tone="success"` (green)                                                                                                         |
| title badge, off     | Inactive, default tone                                                                                                   | Off, default tone                                                                                                                    |
| index badge, on      | Active, success (green)                                                                                                  | On, success                                                                                                                          |
| index badge, off     | Inactive, default tone                                                                                                   | Off, default tone                                                                                                                    |
| index column heading | Status                                                                                                                   | Status                                                                                                                               |
| index filter         | tabs All, Active, Inactive                                                                                               | buttons All, On, Off (`?state=on`, `?state=off`)                                                                                     |
| primary button, on   | Turn off workflow, critical                                                                                              | Turn off, critical                                                                                                                   |
| primary button, off  | Turn on workflow, primary                                                                                                | Turn on, primary                                                                                                                     |
| secondary buttons    | Edit; More actions                                                                                                       | Edit; More actions                                                                                                                   |
| More actions entries | Export, Duplicate, Rename, Manage tags, Delete                                                                           | Rename, Duplicate, Delete                                                                                                            |
| turn-off modal       | "Turn off workflow" / "If you turn this workflow off, the runs in progress will be cancelled." / Dismiss, Turn off       | "Turn off workflow?" / "New orders won't start this workflow. Items already on it keep going." / Cancel, Turn off                    |
| turn-on modal        | "Ready to turn on your automation workflow?" / "Turning on the workflow will activate the automation." / Cancel, Turn on | "Turn on Clock assembly?" / "Every open order with an item tagged “wall-clock” starts this workflow on that item." / Cancel, Turn on |
| last updated         | "Last updated on Oct 6, 2026 at 09:32 AM", page-aligned, ~24px above the card                                            | "Last updated on Oct 6, 3:34 PM", card-aligned, ~8px above the card                                                                  |
| below the line       | a card with tabs Active workflow / Version history, then the canvas                                                      | a card with the trigger and the steps                                                                                                |
| toast on switch      | none seen                                                                                                                | none (the badge changes; the controls table forbids a toast)                                                                         |

Two things Flow does that Baton should not copy:

- Flow cancels runs in progress when a workflow is turned off. Baton's open runs carry on; the
  vocabulary and the data-model table both say so, and the turn-off body says so to the merchant.
- Flow has versions. When the workflow is off, the card's first tab reads **Draft** instead of
  **Active workflow**: Flow treats the current version of an inactive workflow as a draft. Baton
  keeps the switch and the draft unrelated, so a workflow can be off with no draft or on with one.
  The Draft badge beside the state badge is the right shape for that and stays.

## The vocabulary question, from first principles

### What Baton has

`src/lib/domain/ShopWork.ts` holds the state table:

| word | meaning                                | stored | screen |
| ---- | -------------------------------------- | ------ | ------ |
| on   | new items get runs from it             | `on`   | On     |
| off  | it creates nothing; open runs carry on | `off`  | Off    |

Its JSDoc says: "The switch's screen words are Shopify Flow's (Turn on, Turn off); the badge says
On and Off where Flow says Active and Inactive, because 'active' is not a shop-work word here".
The verbs table has `turn on` and `turn off`. The predicate is `workflowIsOn`; the column is
`state text check (state in ('on', 'off'))`; the index filter is `WorkflowsIndexState`, keyed
`?state=`.

Why "active" is not a shop-work word: the reserved-stems table in `scripts/lib/rules-lint.ts`
refuses `active` ("a workflow is on, a run is open; 'active' is Shopify's word for an app
subscription") and `activated` ("nothing; the switch is `state`, `on` / `off`") in every exported
identifier under `src/lib/`. Both rows date from the reconcile work (`docs/reconcile-research.md`,
decision 18), which replaced a nullable `activatedAt` date with a stored `state` literal. The
problem that decision solved was a date standing in for a switch. It did not weigh On against
Active as a word; it reached for the switch's own words because the switch was the point.

The lint refuses the stem in identifiers only. Nothing refuses "Active" in screen copy, and
nothing in `Screen.ts` says what tone a state badge takes.

### What a state word has to do

A state word for a thing with two states is used in at least six places, and a word that works in
all six is stronger than one that works in two.

| use                       | On / Off                               | Active / Inactive                     |
| ------------------------- | -------------------------------------- | ------------------------------------- |
| badge                     | On, Off                                | Active, Inactive                      |
| predicate in a sentence   | "this workflow is on"                  | "this workflow is active"             |
| adjective before the noun | "an on workflow" (not English)         | "an active workflow"                  |
| filter label              | On, Off (reads as a toggle, not a set) | Active, Inactive                      |
| a set in a sentence       | "the workflows that are on"            | "the active workflows"                |
| the verb                  | turn on, turn off                      | turn on, turn off (Flow), or activate |

Flow's help center shows the pair working together: "You can turn off workflows that you no longer
need to actively run. Workflows that have been turned off change to an **Inactive** state and can
be turned back on at any time." And: "Only inactive workflows can be deleted. If you want to delete
an active workflow, then deactivate it first by clicking the workflow, and then clicking **Turn
off**." Try the same sentences with On / Off: "Only off workflows can be deleted" does not parse.
Baton's own JSDoc already strains at this: "a workflow that is on creates a run", "on implies at
least one task", "`unassigned` ... on and off alike". Every one of these is a sentence Baton would
write with "active" if the word were allowed.

Why Baton's merchants will meet the adjective form: the index filter (a set), any count or banner
about several workflows ("2 inactive workflows have open runs" is a plausible future line), and
the Help Center sentence a merchant reads about Flow and carries over.

### The case for On / Off, stated fairly

- **One pair for verb and state.** Turn on makes it On. The badge is the switch's position. With
  Active, the merchant presses Turn on and reads Active: the pair is Shopify's and merchants know
  it from Flow, but it is still two words for one fact.
- **No collision.** "Active" is already Shopify's word for an app subscription (Billing context)
  and would be a shared word travelling with its noun: active workflow, active subscription. The
  vocabulary allows that (the Shared words table) but it is one more row.
- **A run is open, not active.** The reserved-stem row protects the run vocabulary from "active
  run". That protection can stay as a narrower rule: active belongs to the workflow noun only.
- **Zero migration.** Everything is built and tested with on/off; the switch pair is the status
  quo.

### The case for Active / Inactive

- **Shopify's words for Shopify's pattern.** The vocabulary's rule is "Shopify's things get
  Shopify's words, unchanged. Baton's things get plain words." A workflow is Baton's thing, but
  the switch pattern (Turn on / Turn off, Active / Inactive) is Shopify's, and Baton already took
  half of it. Flow is the one Shopify surface a merchant will compare Baton's workflow page to.
- **Works in every slot** (the table above). This is the first-principles point and it would hold
  even if Flow did not exist.
- **The filter reads as a set.** "Active" and "Inactive" beside "All" name three sets of workflows.
  "On" and "Off" beside "All" read as a toggle with a third position.
- **The lint rows were about a column, not a word.** `activatedAt` was retired because a date is
  not a switch. `state in ('active','inactive')` is a switch. The row for `activated` can stay
  (there is still no activation date); the row for `active` goes.

### Recommendation

Adopt Active / Inactive as the state words and keep Turn on / Turn off as the verbs. The state
table becomes:

| word     | meaning                                | stored     | screen   |
| -------- | -------------------------------------- | ---------- | -------- |
| active   | new items get runs from it             | `active`   | Active   |
| inactive | it creates nothing; open runs carry on | `inactive` | Inactive |

The stored literal is the word, as the vocabulary requires. The predicate is `workflowIsActive`.
The index filter stays keyed `?state=` with values `active` and `inactive`. "Active" joins the
Shared words table as a workflow word (shop work) beside Shopify's app-subscription word
(billing), each travelling with its noun; the reserved-stem row for `active` is removed and the
row for `activated` stays. The JSDoc reasoning on the state table is rewritten: the words are
Flow's because the pattern is Flow's, and because the state word has to serve as an adjective.

What it costs. From a grep on 2026-10-06, counting files and hits across `src/`, `test/`, `e2e/`
and `scripts/`:

| symbol or string            | files  | hits | what changes                                         |
| --------------------------- | ------ | ---- | ---------------------------------------------------- |
| `workflowIsOn`              | 11     | 29   | rename to `workflowIsActive`                         |
| `setWorkflowOn`             | 14     | 68   | rename; the `on: boolean` argument becomes `state`   |
| `applyAndTurnOn`            | 10     | 26   | stays (the verb is still turn on)                    |
| `turnOn` / `turnOff` labels | 8 / 3  | 38   | stay                                                 |
| `WorkflowState` literals    | 3      | 7    | `on`/`off` to `active`/`inactive`                    |
| `WORKFLOW_STATE_LABEL`      | 6      | 13   | values On/Off to Active/Inactive                     |
| `WorkflowsIndexState`       | 3      | 12   | literals                                             |
| `'on'` SQL literals         | 4      | 9    | `WorkflowRepository.ts` mostly; the check constraint |
| "Turn on" / "Turn off" copy | 17 / 8 | 83   | stay                                                 |
| e2e "Off" seed comment      | 1      | 1    | wording                                              |

No D1 column holds the state. The Durable Object column is edited in line (no migration while
prototyping) and `pnpm dev:reset` reseeds. The vocabulary runbook's rename procedure applies: the
row, the literal, the predicate, the label constant, the spec checker's expectations, the tests
whose titles carry the words, in one change.

## Badge tone

Measured on the live pages. Flow's title-bar badge is `rgba(0,0,0,0.05)` on `rgb(74,74,74)` text in
both states: the default tone. Flow's index badge for Active is green; for Inactive it is the
default tone. Polaris's badge reference lists `tone="success"` as "Positive outcomes or successful
states" and its first example is `<s-badge tone="success">Active</s-badge>`.

So Flow's rule, read off the two screens, is: colour where the badge is the only signal (a table
cell), none where the page already signals (a title bar whose primary button is red or black
according to the state). That is also the copy table's "one fact, one place": a green badge beside
a red Turn off button says the same thing twice.

Recommendation: title-bar accessory badge in the default tone for both states; index badge
`success` for Active and default for Inactive, unchanged. The Draft badge stays `info` in both
places, since Polaris's reference gives Draft that tone and it is a different fact from the state.

Alternative, if the index should be muted too: default tone everywhere, and the index row's Active
reads as plain text in a badge. That is further than Flow goes and makes the Status column scan
worse; not recommended.

## Button labels

Flow's title bar: Edit, More actions, Turn off workflow. Its menu: Export, Duplicate, Rename, Manage
tags, Delete. The Shopify admin does the same on its own pages (Create order, Add product, Delete
product in a title bar; verb-alone entries in menus). The modal primary is the verb alone (Turn
off, Turn on, Delete).

Baton's title bar: Edit, More actions, Turn off. Its menu: Rename, Duplicate, Delete. The controls
table's delete row says "Delete on its page" for the button and "Delete" for the modal primary.
Commit c627548 made the add and go-to buttons the verb alone **without a count**; it did not take
a position on the noun.

Recommendation: the title-bar switch reads **Turn on workflow** / **Turn off workflow**; the modal
primaries stay **Turn on** / **Turn off**; menu entries stay verb alone. Add a controls-table row:
a title-bar button names its noun; a menu entry and a modal primary are the verb alone. Check the
row against Delete: Flow's Delete lives in the menu, Baton's too, so no change there.

The `turnOn` and `turnOff` rows of the vocabulary's verbs table have `Turn on` and `Turn off` in
the screen column, and `VERB_LABEL` is read by both the button and the modal. If the button gains
the noun, either the label constant gets a second form or the button composes "Turn off" + "
workflow". The vocabulary row should say which; the recommendation is one label per slot in the
constant (`merchant: "Turn off"`, `merchantTitleBar: "Turn off workflow"`) so the spec checker
still holds the screen column.

## The "Last updated" line

Baton renders it as an `s-paragraph color="subdued"` directly above the first `s-section` inside
`s-page inlineSize="base"`. The gap is whatever `s-page` puts between children, about 8px, and the
line is aligned with the card. Flow's line is about 24px above its card and aligned with the page
edge, with the card below spanning the page.

The route cannot add spacing (the layout lint refuses it outside `src/components/screen/`), and the
parts table has no row for a line between the title bar and the first card. Recommendation: a
part, **page note**, "a subdued line between the title bar and the first card: Last updated on the
workflow page", fixing `BETWEEN_THINGS` below it, used on the details template; a kit-page example;
a parts-table row. The date format is a separate question: Flow prints the year and "at"; Baton
prints "Oct 6, 3:34 PM". Baton's shorter form is the one `LocalDateTime` prints everywhere, and a
change there is a change to every date on every screen; not recommended here.

## Other differences, noted and left

- **Status column heading.** Both say Status. The vocabulary rule ("`status` is Shopify's word;
  `state` is Baton's") governs fields, literals and URL keys, not screen copy. Flow's heading is
  Status, so Baton's stays.
- **Modal copy.** Baton's is better and matches its own copy table (a fact, the verb, no
  rhetorical question). Flow's turn-on heading is a question with "your" and "automation". Leave.
- **Export, Manage tags.** Flow has them because its workflows are files and have tags. Baton's
  are not and do not. Leave.
- **Tabs for versions.** Flow's card starts with Active workflow / Version history. Baton has no
  versions; the vocabulary lists "version" as unused. Leave.
- **Turn off cancels runs in Flow.** Baton's keep going, by design. Leave.

## Decisions

Reviewed 2026-10-06; every recommendation accepted as written.

1. **State words.** Active / Inactive, stored as `active` / `inactive`, predicate
   `workflowIsActive`; Turn on / Turn off stay the verbs.
2. **Vocabulary placement.** "active" is a shop-work word on the Workflow state table and a Shared
   words row beside billing's app-subscription sense. The reserved-stem row for `active` is
   deleted; the row for `activated` stays, reworded to name `active` / `inactive`. A run stays
   open, never active.
3. **Title-bar badge tone.** Default tone in both states.
4. **Index badge tone.** `success` for Active, default for Inactive, unchanged.
5. **Title-bar button labels.** Turn on workflow / Turn off workflow in the title bar; Turn on /
   Turn off as modal primaries; menu entries verb alone; a controls-table row states the rule and
   `VERB_LABEL` gains a title-bar form.
6. **"Last updated" line.** A page-note part with `BETWEEN_THINGS` below it and a parts-table
   row; card alignment and the short date stay.
7. **Index filter labels.** All, Active, Inactive; URL `?state=active` / `?state=inactive`.
