# Adopting Shopify Flow's workflow UX in Baton, and whether workflow names need to be unique

Research date: 2026-09-17. Reviewed and accepted the same day; the implementation plan is
`shopify-flow-patterns-for-baton-plan.md`. Builds on `shopify-flow-workflow-lifecycle-research.md` (2026-09-17)
and `shopify-flow-ux-research.md` (2026-09-06); every Flow observation below is taken from those
two passes and their screenshots (`docs/shopify-flow-lifecycle/`, `docs/shopify-flow-ux/`). No
new live session against Flow. Baton behaviour is read from `src/routes/app.workflows*.tsx`,
`src/lib/workflowShared.ts`, `src/lib/ShopAgent.ts`.

Two questions:

1. Which of Flow's badges, button sets, menu items and dialog copy should Baton take as-is, which
   should it adapt, and which do not apply because Baton has no versions.
2. Why Flow lets two workflows share a name, and whether Baton should drop its unique-name rule.

---

## Part 1 — What to bring over from Flow

### 1.1 The ground rule: Baton has a live + draft pair, not versions

Flow's chrome is driven by two bits, **is it on** and **is there a draft**. Baton has exactly the
same two bits: `Workflow` is on or off, and it either has a pending draft or it does not. That is
why most of Flow's badge and button logic transfers directly.

What does not transfer is anything that exists because Flow keeps _every_ version:

| Flow feature                                                       | Why it exists              | Baton |
| ------------------------------------------------------------------ | -------------------------- | ----- |
| `Version history` tab, per-version `Draft`/`Active`/blank badges   | there are many versions    | skip  |
| Read-only version preview (`workflow-version-preview/…`)           | any version can be opened  | skip  |
| `Recent history` actor timeline per version                        | events attach to a version | skip  |
| `Draft discarded by <name>` rows                                   | discarded drafts are kept  | skip  |
| Version id in the editor URL as the unit of editing                | one URL per version        | skip  |
| Always ≥ 2 overview tabs (Version history keeps the tab row alive) | follows from the above     | adapt |

Everything else in Flow's lifecycle is about the live thing and the draft, and Baton has both.

### 1.2 Editor header — adopt Flow's state matrix

Flow ([lifecycle §2](shopify-flow-workflow-lifecycle-research.md)):

| State                    | Badge   | Buttons, left → right                                          |
| ------------------------ | ------- | -------------------------------------------------------------- |
| Never activated          | `Draft` | `More actions ⌄` · **Turn on workflow** · `✕`                  |
| On, no draft             | none    | `More actions ⌄` · **Turn off workflow** (red) · `✕`           |
| Off, once applied, clean | none    | `More actions ⌄` · **Turn on workflow** · `✕`                  |
| Draft exists             | `Draft` | `More actions ⌄` · `Discard changes` · **Apply changes** · `✕` |

Baton today: `Draft` badge always; `Discard changes` in critical tone; `Apply changes` disabled
when there is nothing to apply; no activation control in the editor.

Adopt:

- **Badge is state, not chrome.** Show `Draft` only while unapplied changes exist. A clean editor
  has no badge.
- **Swap the button set instead of disabling.** Clean editor shows the activation button; dirty
  editor shows Discard/Apply and hides activation. This removes Baton's disabled `Apply changes`,
  which reads as broken rather than as "nothing to apply".
- **Activation from the editor** when no draft is pending. Turn on and Turn off become reachable
  from both surfaces, as in Flow.
- **Discard is a plain secondary in the header**; the red lives on the dialog's confirm button.
- **Turn off is a red primary.** Same on the detail page.

Baton-specific: a never-activated workflow is the one state where Baton and Flow currently
disagree on what "live" means. Flow treats it as draft-only (nothing has ever been applied). Baton
shows an empty live workflow. Adopting Flow's first row means Baton needs a "never applied" state,
whose editor shows `Draft` + `Turn on workflow`, and whose Turn on both applies and activates in
one step (lifecycle §4, "Turn on as a shortcut for Apply").

### 1.3 Detail page header — adopt Flow's order and primary

Flow: `✏ Edit` · `More actions ⌄` · **Turn on workflow / Turn off workflow** (primary, red when it
says Turn off). Baton: `Turn off` (plain secondary) · `More actions ⌄` · **Edit** (primary).

Adopt Flow's order and make activation the primary. The primary action on a workflow's page is
the one that changes whether it runs; editing is a secondary path that opens another surface.

Flow's asymmetry is also worth keeping: **off + draft** hides the activation button entirely (you
may not start a workflow whose pending edit is unresolved), **on + draft** keeps `Turn off`.

Status pill next to the h1: Flow shows a subdued `Active` / `Inactive` pill in the title slot,
distinct from the green success badge in the list. Baton already has an accessory badge here.

### 1.4 Detail page tabs — adopt the renaming, adapt the row

Flow renames the first tab by state:

| State                    | Flow tabs                                       | Baton, proposed              |
| ------------------------ | ----------------------------------------------- | ---------------------------- |
| Never activated          | `Draft` · `Version history`                     | no tabs; canvas is the draft |
| On, clean                | `Active workflow` · `Version history`           | no tabs                      |
| Off, once applied, clean | `Saved workflow` · `Version history`            | no tabs                      |
| On + draft               | `Active workflow` · `Draft` · `Version history` | `Active workflow` · `Draft`  |
| Off + draft              | `Saved workflow` · `Draft` · `Version history`  | `Saved workflow` · `Draft`   |

Baton's existing choice (tabs only when a draft exists) stands, because Version history is the
only reason Flow always has a tab row. What changes is the label: Baton's fixed `Live workflow`
becomes Flow's `Active workflow` / `Saved workflow`, so the tab tells the merchant whether what
they are looking at is running.

Flow's Draft-tab body is a read-only canvas. Baton's Draft tab carries an info banner _"Not
running yet — These changes take effect when you apply them in the editor."_ Flow has no such
banner; the `Draft` tab label carries the meaning. Keep or drop is a taste call; the banner is
not something Flow does.

`Last updated on <date>`: Flow puts it as a plain line above the tab card. Baton has it inside
the card under the tabs. Low stakes; Flow's placement keeps the card about the workflow content.

### 1.5 Dialogs — adopt the copy, fix Flow's drift

Flow's dialogs, with Baton's current equivalent and the proposal. Flow is inconsistent about title
case and dismiss verbs (lifecycle §9); Baton is already consistent (sentence case, `Cancel`
everywhere) and should stay that way while taking Flow's sentences.

**Apply changes** (only when the workflow is on; Baton already matches this rule)

> **Apply changes?**
> This workflow is turned on. Once you apply changes, they'll take effect immediately.
> `Cancel` · `Apply`

Adopt verbatim.

**Discard changes**

> **Discard changes?**
> Are you sure you want to discard these changes?
> `Cancel` · `Discard` (red)

Adopt, with sentence case in the title (Flow has `Discard Changes?`).

**Turn on**

> Flow: **Ready to turn on your automation workflow?** / Turning on the workflow will activate
> the automation. / `Cancel` · `Turn on`

Baton's dialog is `Turn on <name>?` with a body naming the tag rule and an optional `Include them`
checkbox for earlier unfulfilled orders. Baton's is the better dialog: Flow's body says nothing a
merchant does not already know, while Baton's says which orders will start. Keep Baton's body and
checkbox. Take Flow's button label `Turn on`.

**Turn off**

> Flow: **Turn off workflow** / If you turn this workflow off, the runs in progress will be
> cancelled. / `Dismiss` · `Turn off`

Baton has no confirmation. Adopt a confirmation. The body must state Baton's real consequence,
not Flow's: in Baton a run copies its steps at start and lives on the order, so turning off stops
_new_ runs and does not cancel in-progress ones. Something like _"New orders won't start this
workflow. Runs already in progress keep going."_ Use `Cancel`, not Flow's `Dismiss`.

**Delete**

> Flow: **Delete `<workflow name>`?** / This workflow will be permanently deleted. Only its
> recent run history will be retained. / `Cancel` · `Delete` (red)

Baton: `This can't be undone.` Adopt Flow's shape, which names the workflow in the heading and
says what survives. Baton's truthful version: _"This workflow will be permanently deleted. Runs
already on orders are kept."_ (`DELETE_WORKFLOW_WARNING`'s JSDoc already records that no runs
are lost.) Toast on success: `Workflow deleted`.

**Rename**

> **Rename workflow** / field `New name` / live counter `12/100` / `Cancel` · `Save` / toast
> `Workflow renamed`

Adopt the modal, labels, counter and toast. Baton's limit is 64, Flow's 100; the counter matters
more than the number.

### 1.6 More actions — adopt the order, skip what Baton lacks

Flow editor menu: Rename · Add note · Export · Duplicate · Manage Tags · **Delete**.
Flow overview menu: Export · Duplicate · Rename · Manage tags · **Delete**.
Baton editor: Rename · Delete. Baton detail: Rename · Duplicate · Delete.

- Baton's current items are a subset of Flow's; nothing Baton has is missing from Flow.
- Use **one** order on both surfaces (Flow's two menus disagree; that is drift, not design).
  Editor order `Rename · Duplicate · Delete` fits Baton's set.
- `Export` / `Import` / `Manage tags` (Flow's organisational tags on workflows, unrelated to
  Baton's product tag) do not exist in Baton. Skip.
- `Add note` is not a versioning feature (lifecycle §4: a note produced no draft and no `Last
changed` bump). It is adoptable later as workflow metadata; out of scope here.
- Delete is red and last, on both.

### 1.7 List page — adopt the vocabulary, keep Baton's draft badge

Flow: tabs `All` / `Active` / `Inactive`; Status column badge `Active` / `Inactive`; columns
Workflow · Status · Last run · Trigger · Tags; **no draft indication**.

Baton: pills `All` / `Active` / `Off`; Status cell stacks `Active`/`Off`, `Draft`, `No steps`,
`Needs attention`; columns Workflow · Status · Tag · Steps · Updated.

- Adopt `Inactive` in place of `Off` for the state word (the verb stays `Turn off`). Flow uses the
  noun/adjective pair Active/Inactive for state and Turn on/Turn off for the action; Baton
  currently mixes the action word into the state.
- Keep Baton's `Draft` badge in the list. Flow hides it, but a JSDoc on `statusBadges` argues for
  it and nothing in Flow's design suggests hiding it is deliberate rather than a consequence of
  drafts being a per-version concern.
- Keep Baton's `No steps` / `Needs attention` badges; Flow has no equivalent because Flow does
  not validate until you try to turn on (§1.8).

### 1.8 Validation — keep Baton's approach, borrow Flow's list

Flow validates _after_ confirm: a floating critical card on the canvas lists what is missing
(`Add a trigger to this workflow`, `Add an action to this workflow`), then disables the button.
Baton validates _before_: `turnOnBlocker` / `applyBlocker` disable the button and show a banner
(`Turn on is unavailable`, `Not ready to apply`).

Keep Baton's pre-emptive model. Borrow Flow's imperative bullet phrasing for the banner body: each
blocker as a verb-first instruction (`Add a step to this workflow`), not a description of what is
wrong.

### 1.9 Autosave affordance — adopt

Flow's canvas footer shows `✓ Saved · Last changed on Sep 17, 2026, 01:43 PM`, flipping to a
`Saving` spinner mid-write. Baton has none. Not tied to versions; adopt.

### 1.10 Creating a workflow

Flow asks for nothing; `Select a trigger` creates the object with the default name `New Workflow`,
and naming is a later `Rename`. Baton's modal asks for **Name** and **Tag**.

Baton must collect a tag before the workflow can do anything, so a pre-editor step is justified.
Whether it should also collect a name is exactly the Part 2 question. If names stop being unique,
the modal can either drop the name field (default `New workflow`, rename later, as Flow) or keep
it as optional. If names stay unique, the modal has to keep the field and its collision error.

### 1.11 Summary table

| Surface                    | Take from Flow                                                       | Baton keeps                            | Skip (versions)                               |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| Editor header              | badge-as-state; button-set swap; activation when clean; red Turn off | right-hand aside panel                 | version id in URL                             |
| Detail header              | `Edit · More actions · Turn on/off` with activation primary          | tag rule + backfill in Turn on dialog  |                                               |
| Detail tabs                | `Active workflow` / `Saved workflow` / `Draft` labels                | tabs only when a draft exists          | `Version history`                             |
| Apply / Discard dialogs    | copy verbatim (sentence-cased)                                       | confirm-only-when-on rule              |                                               |
| Turn on / Turn off dialogs | button labels; a Turn off confirmation                               | Turn on body; `Cancel` everywhere      |                                               |
| Delete dialog              | name in heading; "what survives" sentence; `Workflow deleted` toast  |                                        |                                               |
| Rename dialog              | modal, `New name`, counter, `Workflow renamed` toast                 | 64-char limit                          |                                               |
| More actions               | one order, Delete red and last                                       | Rename · Duplicate · Delete            | Export, Import, Manage tags, Add note (later) |
| List                       | `Active` / `Inactive`                                                | `Draft`, `No steps`, `Needs attention` | hiding drafts                                 |
| Validation                 | imperative bullet copy                                               | pre-emptive disable + banner           | confirm-then-fail                             |
| Autosave                   | `✓ Saved · Last changed on …`                                        |                                        |                                               |
| Create                     | (depends on Part 2)                                                  | Tag collected up front                 | AI prompt, templates                          |

---

## Part 2 — Why Flow lets names collide, and whether Baton should

### 2.1 Where Flow's identity actually lives

Everything in Flow that needs to identify a workflow uses the ULID: the list row's href, the
overview and editor routes, the run history. The name appears in exactly three places — the list
column, the h1, and the `Delete <name>?` heading — and in all three it is a label for a human, never
a key. Flow has no feature that resolves a name to a workflow.

Four Flow behaviours would break under a unique-name rule, and each is load-bearing:

1. **Create-by-gesture.** `Select a trigger` creates the object with the name `New Workflow`
   before the merchant has typed anything (lifecycle §3). A second create would collide on the
   default name. Uniqueness would force a name prompt back into the create path, which is the
   thing Flow removed.
2. **Templates.** `Browse templates` installs a workflow under the template's title (the sandbox
   has `Tag orders that include specific products` from a template). Merchants install the same
   template several times with different values; uniqueness would demand a rename at install.
3. **Duplicate and Import.** A copy or an imported export carries the source name. Prompting for
   a fresh name is friction on a path whose whole point is "give me the same thing again".
4. **Autosave with no synchronous validation.** Flow's editor never blocks on a save. A rename
   that can fail on collision is the one write that would need a round trip and an error state.

The wider Shopify convention matches: human-facing titles are non-unique (products, collections,
discounts, customers, Flow workflows), and the unique thing is a separate machine key (product
handle, discount code, tag). Flow is following the platform, not making a special decision.

### 2.2 How Flow copes with collisions

It mostly does not have to. The list carries `Trigger` and `Tags` columns next to the name, the
search box searches by name and returns all matches, and each row links by id. Two rows with the
same name are two rows; the merchant tells them apart by trigger, tags or by opening them. Flow
accepts occasional ambiguity in exchange for never showing "that name is taken".

### 2.3 Baton's position

Baton has a machine key Flow lacks: the **tag**, which is required, unique (`unique` constraint on
`Workflow.tag`), and is what a product resolves to. The tag already plays the role Flow's ULID
plays plus the role a product handle plays. Baton's name is, structurally, the same thing as
Flow's name: a label.

Yet Baton also enforces name uniqueness (`Workflow_name_uidx`, case-insensitive), and that rule
produces a set of UX that Flow does not have:

- a `NameTaken` error and its message on Create, Rename and Duplicate;
- the Duplicate dialog's `<name> copy`, `<name> copy 2`, … search for a free name (`copyName`);
- a Create modal that must ask for a name and can fail before the merchant has seen the editor;
- a rename that can be refused.

None of these exist to protect a lookup. Nothing in Baton resolves a workflow by name; the index
and routes use the id, and runs use the tag.

### 2.4 What relaxing it costs

Two surfaces currently lean on the name being a sufficient identifier, and both would need the
tag added to stay unambiguous:

- `tagTakenMessage`: _"“<tag>” is already <workflowName>'s tag."_ With duplicate names the
  merchant cannot tell which workflow is meant. The message should link the holder or show
  something unique about it. Since the tag _is_ the unique thing and is what is being reported,
  the fix is a link to the holder, not more text.
- Anything on the order side that labels a run by workflow name (an order's run history, member
  queues) becomes ambiguous if two workflows share a name. The run already copies its steps; it
  should show or keep the tag alongside the name.

Also affected, in a good way: the Delete heading `Delete <name>?` is fine as-is because the
merchant opened this specific workflow to get there.

The index would show two identical names. Baton's list already has a `Tag` column, so the
disambiguator is on screen without change, which is more than Flow offers.

### 2.5 Recommendation

**Decision 2026-09-17: accepted.** Names are no longer unique, and the name column needs no
index at all (nothing orders or looks up by name other than the list sort, which is small).
Implementation plan: `shopify-flow-patterns-for-baton-plan.md`.

Drop the unique-name rule. Identity is the id, uniqueness is the tag, and the name is a label, as
in Flow and the rest of Shopify's admin. The concrete simplifications:

- Create asks for the tag; the name can default to `New workflow` (Flow's pattern) or stay an
  optional field. Either removes the collision path from Create.
- Rename never fails for a name reason. Adopt Flow's dialog unchanged.
- Duplicate prefills `<name> copy` (or Flow's convention, not verified) without searching for a
  free suffix; `copyName`'s numbering and its "always one free" reasoning go away.
- `NameTaken` disappears from `WorkflowResult`; `TagTaken` remains the one collision error, and
  it is already the better message because it names the holder.

Conditions on the recommendation:

- Every place a run or an error names a workflow must also carry the tag or a link to the
  workflow. Two identical names with no tag beside them is the one situation Flow tolerates that
  Baton should not, because Baton's runs outlive the workflow definition on the order.
- Keep the case-insensitive collation only if some other feature relies on it; with no unique
  index there is no reason for the name column to have it.

### 2.6 The counter-argument, for the record

The case for keeping uniqueness: Baton shops are small, a workflow count in the tens, and a
unique name is a cheap guard against a merchant creating `Rush orders` twice by accident and
running two workflows they meant to be one. Flow does not need this guard because a Flow workflow
runs on a trigger, and two workflows on the same trigger are a normal thing to want. In Baton, two
workflows cannot claim the same tag, so the accidental-duplicate risk is already caught at the
point that matters. The guard on the name is redundant with the guard on the tag.

---

## Not covered

- Flow's `Duplicate` dialog and the name it proposes for the copy (never opened in either pass).
- Whether Flow's `Import` renames on collision with an existing name.
- Flow's `Manage tags`, `Export`, templates, AI create, `Test your workflow`.
- Code-level inventory of every Baton read of the name unique index; this doc stays at the UX
  level by request.
