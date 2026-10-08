# Plan: the Workflows help pages

The next row on the roadmap in `docs/help-research.md`, written 2026-10-07 after da2c37e. Five
page bodies under the Workflows section (the hub stays as the skeleton renders it: its
description and "In this section"), ten merchant pictures, and a `--section` flag on the
screenshot script (finding 8 of the last review). Run the way `docs/help-getting-started-plan.md`
was: two builders split by file, then the orchestrator's pass and review.

The plan was not reviewed before implementation; its decisions are at the end, and the review
comes after, on the Deviations section.

## Before you start

- Read `docs/help-research.md`: "Page anatomy, by type", "Tone and naming rules for help",
  "Screenshots" (the merchant column is what the script does now), "Decisions", "How a content
  cycle runs". Read `docs/help-getting-started-plan.md` whole: this plan has the same shape, and
  its Deviations and Review record what the admin forced on the script.
- The code this extends: `scripts/help-screenshots.ts` (`MERCHANT_SHOTS`, the four shapes, the
  overlap check, `openOrder`, `orderWith`), `src/lib/helpPictures.ts` (the ten Workflows entries
  are already in, with provisional `aspectRatio` and alt text), `src/components/help/bodies.tsx`,
  the five bodies under `src/components/help/getting-started/`, `test/integration/help-pages.test.ts`,
  `e2e/help.public.spec.ts`.
- The admin drivers: `e2e/app.ts` (`gotoApp`, `appFrame`, `editorFrame`, `openScreen`,
  `clickHoisted`, `hoistedEnabled`), `e2e/hydration.ts`, and `clickMenuItem` in
  `e2e/workflows.spec.ts` (a More actions item: the hoisted menu is unreachable, so the hidden
  in-frame `s-menu#workflow-actions s-button` is clicked natively; copy that function into the
  script, do not import a spec).
- The merchant screens the pages describe: `src/routes/app.workflows.index.tsx` (the list, the
  Create workflow modal, `TAG_HELP`, the badges in `stateBadges`), `app.workflows.$workflowId.tsx`
  (the page: Edit, More actions with Rename, Duplicate, Delete, the switch, the Tag card and Edit
  tag, the Rename, Duplicate and Delete modals), `app.workflows.$workflowId_.edit.tsx` (the editor:
  Add step, Add task, the New step form, the task panel with Move earlier, Move later, Move to its
  own step, Join the previous step, Delete, Save; Apply changes, Discard changes and their modals),
  `src/lib/workflowShared.ts` (`turnOnBody`, `turnOnBlocker`, `applyBlocker`, `APPLY_BODY`,
  `DISCARD_BODY`, `TURN_OFF_BODY`, `DELETE_WORKFLOW_BODY`, `copyName`), `src/components/WorkflowSwitch.tsx`,
  `WorkflowTag.tsx`; the words and rules in `src/lib/domain/ShopWork.ts` (`WORKFLOW_STATE_LABEL`,
  `WORKFLOW_FAULT_LABEL`, `WorkflowTag`, `itemMatches`, `matchesTag`, `workflowIsEligible`, the
  triggers table on `reconcileItem`, the JSDoc on `Workflow`, `DuplicateWorkflowInput`,
  `UpdateWorkflowTagInput`, `DiscardResult`, `NAME_MAX_LENGTH`, `TAG_MAX_LENGTH`,
  `TASK_INSTRUCTIONS_MAX_LENGTH`) and `WorkflowLimits` in `src/lib/domain/Platform.ts`. Every claim
  a page makes is checked against the route or the Domain symbol, never written from this plan.
- The copy lint reads `src/components/`: a body may not say "run", "in progress", "finish",
  "finished", "view" (except "View in Shopify"), "tab", "import", "resync", "picker", "billing
  period", start a sentence with "Saved", or join two ideas with a semicolon. "Finishing" (the
  team) passes.
- The dev server must be healthy (`pnpm dev:status`). The admin storage state is
  `playwright/.auth/shopify-admin.json`, from 14:47 today. Do not run the whole e2e suite. Every
  run of the script ends with `pnpm seed`.
- Do not run `pnpm fmt` and do not commit. Record every departure from this plan, every problem,
  and every sentence you could not verify, under your own heading in
  [Deviations and issues](#deviations-and-issues).

## The pictures

Ten merchant pictures, all on the showcase shop, none of which writes anything: every modal is
cancelled, the editor is closed with its draft untouched. `firstWorkflow1` (the Create workflow
modal) is placed again on Creating a workflow (decision 3 of the last plan).

| name             | file                                 | shape        | screen and state                                                                                                                                                                            |
| ---------------- | ------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| creating1        | `workflows/creating-1.png`           | page         | the Workflows page: All, Active, Inactive, the search field, the eight showcase workflows with Status, Tag, Steps, Updated; Frame and glaze Inactive, Weekend engraving Team has no members |
| editing1         | `workflows/editing-1.png`            | window       | the editor on Embroider and fold (it has a draft): Draft badge, More actions, Discard changes, Apply changes; the three draft steps on the canvas, nothing selected                         |
| editing2         | `workflows/editing-2.png`            | window       | the same editor with Sew in care label selected: the panel with Name, Team, Instructions, Move earlier, Move later, Delete, Save                                                            |
| editing3         | `workflows/editing-3.png`            | editor modal | after Apply changes: "Apply changes?" and `APPLY_BODY`                                                                                                                                      |
| matching2        | `workflows/matching-2.png`           | modal        | the Edit tag modal on Embroider and fold's page, the tag `embroidered-blanket` as it is                                                                                                     |
| turningOnAndOff1 | `workflows/turning-on-and-off-1.png` | modal        | the Turn off workflow modal on Cut, engrave and oil's page: "Turn off workflow?" and `TURN_OFF_BODY`                                                                                        |
| managing1        | `workflows/managing-1.png`           | modal        | the Duplicate workflow modal on the same page: Name `Cut, engrave and oil copy`, the Tag as it fills from the name                                                                          |
| managing2        | `workflows/managing-2.png`           | modal        | the Delete modal on the same page: "Delete Cut, engrave and oil?" and `DELETE_WORKFLOW_BODY`                                                                                                |
| turningOnAndOff2 | `workflows/turning-on-and-off-2.png` | page         | the page for Frame and glaze: Inactive badge, Turn on workflow in the title bar, the Tag card with Edit tag, Cut mat and Glaze and fit                                                      |
| matching1        | `workflows/matching-1.png`           | page         | the order page for the Black gift set order (the report's hand count says #1211, verify): Multiple workflows match, its sentence, the Workflow select listing both workflows                |

The rows are the shooting order. The Workflows block runs **before** the Getting started block in
`MERCHANT_SHOTS` (after `howBatonWorks1` and `firstOrder1`, which open orders and leave nothing
open), because Getting started creates Engraved pen and Assembly and leaves the Add members modal
open, and the Workflows list must not show them. Each block starts from a bare screen
(`openScreen` gets there from anywhere) and ends with every modal cancelled and the editor closed.

## Phase 1: the script (builder A)

Owns `scripts/help-screenshots.ts`, the ten PNGs, the `aspectRatio` and alt text of the ten
entries in `src/lib/helpPictures.ts`, and `package.json` if the flag needs it. Does not touch
bodies, the bodies map or the tests.

1. **`--section <slug>`.** `pnpm help:screenshots --section workflows` shoots only the entries
   whose `file` starts with `<slug>/`, merchant and member alike; no flag shoots everything, as
   today. The gates, the showcase seed and the closing `pnpm seed` run either way. Shots keep
   their array order. Document on the script's JSDoc that a block of shots for one section must
   start from a bare screen and leave nothing open, since a block may run alone.
2. **The ten shots**, as `take` functions, in the order of the table:
   - `creating1`: `openScreen(page, "Workflows")`; wait for the row link "Weekend engraving";
     shape page.
   - `editing1`: press the row link "Embroider and fold" in the frame; wait for
     `s-page[heading="Embroider and fold"]` and `awaitNavigated`; `clickHoisted` Edit; wait for the
     editor frame's `s-page[heading]` and `awaitHydration(editor)`; wait for the text "Sew in care
     label"; shape window.
   - `editing2`: in the editor press the card `getByLabel("Edit Sew in care label")` (the task
     card's `accessibilityLabel`); wait for the button "Move earlier"; shape window.
   - `editing3`: `clickHoisted` Apply changes; wait for the text "take effect now"; shape editor
     modal. Then Cancel in the modal, and Close in the window (the Getting started block's
     locator), and wait for the editor frame to go.
   - `matching2`: on the workflow page press "Edit tag" in the frame; wait for the modal heading
     "Edit tag"; shape modal; then Cancel.
   - `turningOnAndOff1`: `openScreen(page, "Workflows")`, press "Cut, engrave and oil", wait for
     its heading; `clickHoisted` Turn off workflow; wait for the text "keep going"; shape modal;
     Cancel.
   - `managing1`: `clickMenuItem(frame, "Duplicate")` (copied from `e2e/workflows.spec.ts`); wait
     for the heading "Duplicate workflow" and the Name value `Cut, engrave and oil copy`; shape
     modal; Cancel.
   - `managing2`: `clickMenuItem(frame, "Delete")`; wait for "This can't be undone."; shape modal;
     Cancel.
   - `turningOnAndOff2`: `openScreen(page, "Workflows")`, press "Frame and glaze", wait for its
     heading and `awaitNavigated`; shape page.
   - `matching1`: `openOrder(page, "#<n>")` for the Black gift set order. `orderWith` reads a
     property value and the gift set has none, so find the number first: on the orders page press
     Issues on the strip, or search by the product; the fixture's hand count says #1211. Verify,
     and record the number in Deviations. Shape page.
3. **Run it** with `--section workflows`, set the ten `aspectRatio` values from the printed
   sizes, run again and confirm the sizes hold. Then run it once with no flag to confirm the
   whole set still passes in one page (the Getting started block after the Workflows block). The
   member pictures that run re-shoots are restored with `git checkout -- public/assets/help/members`
   (the frames are the same; only the seed's clock differs).
4. **Look at each picture** and rewrite its entry comment and alt text (30 to 60 words, the
   screen's words, what matters named) from what is there, not from this plan.
5. Report in Deviations: what each picture shows, anything that reads wrong, every overlay stem the
   check met that the last plan's table does not list, how long the Workflows pass took, and the
   gift set order's number.

## Phase 2: the five pages (builder B)

Owns `src/components/help/workflows/*.tsx`, `src/components/help/bodies.tsx`,
`test/integration/help-pages.test.ts` and `e2e/help.public.spec.ts`. Does not touch the script, the
inventory or the PNGs.

Each body is a component under `src/components/help/workflows/<slug>.tsx`, registered in
`HELP_BODIES` as `"workflows/<slug>"`, in the Getting started bodies' shape: `s-section` per
sub-topic, `Things`, `s-paragraph`, `NumberedList`, `HelpPicture`, `s-link` by the target page's
title; a JSDoc naming the routes and Domain symbols the page was checked against. Two to four
sections a page; a control's label and a badge's label bold and exact; a screen sentence that is
not a control or badge reported in plain words, not quoted. Links to pages with no body yet are
still links.

1. **Creating a workflow** (`creating`), task. Sections: the Workflows page (what each row shows:
   the name, its status badge, **Active** or **Inactive**, with **No steps**, **Needs a team** or
   **Team has no members** beside it when so, the tag, the number of steps, when it was updated;
   the buttons **All**, **Active**, **Inactive**; search by name; picture `creating1`); create it
   (the numbered list as on Creating your first workflow, shorter, then `firstWorkflow1`; the
   walkthrough with a step and Turn on is in Creating your first workflow, link it); the name and
   the tag (a name is unique, the screen says so when it is taken; a tag is unique across
   workflows and the screen names the workflow that has it; the Tag fills from the name in
   lowercase until you type in it; what you type is kept as typed and matched exactly, link
   Matching items by product tag; the limits are not numbers here, Limits has them); what a new
   workflow is (it opens in the editor and reads **Draft** with no steps and no state; it starts
   nothing until it has a step on a team and is turned on, link Editing steps and tasks and
   Turning a workflow on or off).
2. **Editing steps and tasks** (`editing`), task. Sections: open the editor (on the workflow page
   press **Edit**; the editor is a window of its own; your first change starts a draft, the
   **Draft** badge shows and **Apply changes** and **Discard changes** replace the switch in the
   title bar; the workflow page and the members keep the applied steps until you apply; picture
   `editing1`); add a step or a task (**Add step** and the New step form: Name, Team, Instructions,
   **Add step**; a step needs a team, the editor says to create one first when the shop has none;
   press a task, then **Add task** under its step, for a task done side by side; steps are done in
   order; the editor says "step" for a step with one task and "task" only when a step has more
   than one); change a step or a task (press it; the panel: **Name**, **Team**, **Instructions**,
   **Save**; **Move earlier** and **Move later**; **Move to its own step** when it shares a step,
   **Join the previous step** when it is alone; **Delete** removes it at once, with no question,
   and Discard changes brings it back; Instructions up to 500 characters, the field counts down
   from 300; picture `editing2`); apply or discard (**Apply changes** replaces the workflow's steps
   with the draft; on an active workflow a modal says the changes take effect now and items
   already on it keep the tasks they started with, press **Apply**; on an inactive one it applies
   at once; it stays disabled until there is a step and every task has a team, and the Needs a
   team banner names the task; **Discard changes** asks, then drops the draft; picture `editing3`;
   Rename and Delete are also under More actions here, link Renaming, duplicating and deleting a
   workflow).
3. **Matching items by product tag** (`matching`), concept. Sections: one tag per workflow (each
   workflow has exactly one tag and no two share one; a product may carry other tags, Baton reads
   only the one the workflow names); an exact match (trimmed, compared exactly, capitals
   included; a product whose tag differs by a letter matches nothing, and its order shows under
   **No workflow** with the workflow in the Workflow select on the order page, link Attaching or
   changing a workflow; a product retagged in Shopify changes nothing until its order syncs again,
   link Syncing from Shopify); what else has to hold (the workflow is **Active** with a step and
   every task on a team, a team with no members does not stop it but its tasks wait; the order is
   paid, an unpaid order waits as **Unpaid**; the item has units left to make; an item already on
   a workflow is never moved by a match, and a cancelled workflow is never restarted by one; when
   a workflow is turned on, every open paid order with the tag starts it, however old); when two
   workflows match (nothing starts, the order shows **Multiple workflows match**, you choose on the
   order page, and turning one off or deleting it starts the other; picture `matching1`); changing
   the tag (**Edit tag** on the workflow page, its modal, **Save**; products with the old tag stop
   matching until you retag them; items already on the workflow keep going; the tag is saved in
   lowercase, which is what the modal does, say it plainly; picture `matching2`).
4. **Turning a workflow on or off** (`turning-on-and-off`), task. Sections: Active and Inactive
   (what each badge means: an **Active** workflow starts on new items that match; an **Inactive**
   one starts nothing and items already on it keep going); turn on (**Turn on workflow** on the
   workflow page or in the editor; the modal's sentence; **Turn on**; disabled until there is a
   step and every task has a team, the screen says which; on a never-applied workflow the page
   has no switch and the editor's Turn on workflow saves the steps and turns it on in one go;
   picture `turningOnAndOff2`); turn off (**Turn off workflow**; the modal says new orders won't
   start it and items already on it keep going; **Turn off**; the page hides the switch while an
   inactive workflow has unapplied changes, apply or discard first; picture `turningOnAndOff1`);
   one line that turning off one of two matching workflows starts the other, link Matching items
   by product tag.
5. **Renaming, duplicating and deleting a workflow** (`managing`), task. Sections: rename (More
   actions, **Rename**, **New name**, **Save**; the name rules as on create; an item already on the
   workflow keeps the name it started with; the tag does not change); duplicate (More actions on
   the workflow page, not in the editor, **Duplicate**; Name filled as the name plus " copy", the
   Tag filling from it; **Duplicate**; the copy has the applied steps, not unapplied changes, reads
   **Inactive**, and opens in the editor; picture `managing1`); delete (More actions, **Delete**;
   the modal's two sentences; **Delete**; back to the Workflows page; items already on it keep
   going under its name to the end; if it was one of two matching workflows, the other starts on
   those items; picture `managing2`).

Check every sentence against the screen and the Domain symbol. Where a sentence and the screen
disagree, the screen wins and Deviations records it.

### Tests

The existing tests cover the new entries and bodies (inventory equals files, every picture placed,
alt length, aspect ratio, the e2e walk over `HELP_BODIES`). Add nothing unless a body needs it;
run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm exec playwright test --project=public`
and record the result. Until builder A's pictures exist, three tests fail on the missing files;
say so rather than skipping.

## Checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` green; `pnpm exec playwright test --project=public`
  green; the dev store ends on the dev fixture.
- `pnpm help:screenshots --section workflows` run twice leaves the same sizes; a run with no flag
  passes.
- `pnpm fmt` repo-wide at the end, by the orchestrator.

## Decisions

Taken 2026-10-07 while writing the plan, without review; the review is on the result.

1. **The hub has no body.** The route renders a section hub from the tree alone, and the five
   pages carry the content the research's row gave the hub ("what a workflow is; create, edit,
   turn on"): the words are on How Baton works, the rest on the pages. No route change.
2. **The list is described on Creating a workflow.** There is no "Reading the workflows list"
   page, and the list is where creating starts.
3. **Ten pictures, none of which writes.** Every modal is cancelled and the editor is closed with
   the showcase draft untouched, so a run leaves the showcase as the seed made it and the shots
   can run in any order between the seed and the closing reseed.
4. **The Workflows block goes before the Getting started block**, so the list picture has no
   Engraved pen in it.
5. **`--section` filters by file prefix.** The file already says the section; no new field.
6. **The multi-match picture is on Matching items by product tag**, shot there first (so filed
   under `workflows/`), and the Orders section places it again on Fixing an issue later.
7. **"The tag is saved in lowercase" is stated**, since Edit tag does that and Create does not.
   The review decides whether the product should change instead.
8. **"Status" is the column's word on the list**, and the pages say "status badge" there once;
   elsewhere the pages say Active and Inactive and never "state".

## Deviations and issues

(filled in by the builders, one heading each)

### Pages and tests

Phase 2, the five bodies under `src/components/help/workflows/`, registered in `HELP_BODIES`.
Every sentence was checked against the route, component or Domain symbol named in its body's
JSDoc, not against this plan.

- **A new workflow has a state on the list.** The plan said a new workflow reads Draft "with no
  steps and no state". The editor and the workflow page show only **Draft** (`neverApplied`), but
  `createWorkflow` inserts it `inactive`, and the Workflows page shows **Inactive** and **No
  steps** (`stateBadges`). Creating a workflow says both.
- **Matching has four sections, not five.** The plan listed five (one tag, exact match, what else
  has to hold, two matches, changing the tag), past the two-to-four ceiling. "One tag per
  workflow" and "an exact match" are one section, "One tag, matched exactly".
- **No link to Syncing from Shopify.** `scripts/lib/rules-lint.ts` refuses `^\s*syncing\b`, and
  the link text `Syncing from Shopify` is a text node of its own between two tags, so the lint
  refuses the page's own title in a body. Matching says a retagged product changes nothing for an
  order already in Baton until that order syncs again, with no link. The integration test already
  exempts titles from the anchored patterns. The smallest fix is for the review to pick: a help
  link part that prints a page's title from `HELP_SECTIONS` given its href, so the title never
  sits in a body as a literal, or the same exemption in the lint for an `s-link` whose href is
  under `/help/`. The Orders section will meet this as well.
- **The e2e foot test looks in the foot only.** "a section hub lists its pages and a page's foot
  lists its siblings" looked for each sibling link anywhere on the first page. Creating a workflow
  links Editing steps and tasks and Turning a workflow on or off from its body, so the locator
  matched two elements and failed on strict mode. The test now takes the page's last `s-section`
  (the foot, `help.$section.$page.tsx`) and checks the section link, the unlinked current page and
  the siblings inside it. Nothing else in the tests changed.
- **Turn off is pressed on the page.** The page always shows Turn off workflow on an applied
  active workflow. The editor shows the switch only with no draft, so Turning a workflow on or off
  names the workflow page alone for Turn off. Turn on names "the workflow's page or the editor",
  then says when each hides it.
- **Delete in the panel and Discard changes.** The page says Discard changes brings a deleted task
  back and drops every other change in the draft too. On a never-applied workflow the editor shows
  Turn on workflow, not Discard changes (`showSwitch = fresh || !hasDraft`), so there is no
  undo there. The page does not say so. The Open the editor section says a new workflow keeps
  Turn on workflow in place of the two buttons.
- **The panel's heading, not the canvas, says Step or Task.** The plan said the editor says "step"
  for a step with one task. The canvas labels every group "Step n". Only the panel's heading
  switches (`sharesStep`), so Editing says the panel is headed Step when the task is alone in its
  step and Task when it shares one.
- **Move earlier and Move later are described by the order, not by steps.** A task alone moves
  past the neighbouring step, a shared task moves just outside its own step (`move` in
  `WorkflowLayout.ts`). Either way it ends alone, which is what the page says.
- **More than the plan listed, each from the code:** closing the editor keeps the draft
  (`workflowEditorWindow.ts`, and "Close leaves the draft alone" on the editor); Apply changes
  closes the editor and the page shows the new steps; Discard shows the steps in force again; a
  search on the Workflows page covers every workflow, whatever the filter; the Needs a team badge
  means a task's team was deleted (a task cannot be added without a team); an unpaid order starts
  the workflow once paid (the creation gate); Edit tag on an active workflow starts it on open
  paid orders whose items carry the new tag (the tag edit row of the triggers table); Turn off
  leaves the steps, the tag and any draft as they are (`setWorkflowState`).
- **Screen sentences reported, not quoted:** `APPLY_BODY`, `DISCARD_BODY`, `turnOnBody`,
  `TURN_OFF_BODY`, `DELETE_WORKFLOW_BODY`, `MULTI_MATCH_SENTENCE`, "Create a team before adding
  steps.", the name-taken and tag-taken errors. Bold is kept for controls and badges. The panel's
  Step and Task headings are not bold, since they are headings, not controls.
- **Limits.** Creating names no length and links Limits. Editing names 500 and 300 for
  Instructions, as the plan asked; that puts one number on a page and in Limits both, which the
  review may want to cut. No workflow count is named anywhere.
- **Unverified against a running screen:** none of the bodies' sentences. I read the pictures
  `creating1`, `editing2` and `matching1` once builder A had written them, and the prose agrees
  with them. The order in `matching1` is #1211. Its item card has no Multiple workflows match badge,
  only the sentence and the select. The badge is on the Orders page, which is where Matching puts
  it. Its alt text in `helpPictures.ts` says the item "carries the badge Multiple workflows match",
  which the picture does not show: builder A's entry, flagged here.
- **Runs at hand-off.** `pnpm typecheck` green. `pnpm lint` green (after the Syncing link above).
  `pnpm test`: 779 passed. Builder A's ten PNGs were already on disk, so the three tests expected
  to wait on them ("every picture in the inventory is a file under public/assets/help, and every
  file there is in the inventory", "a merchant picture's aspect ratio is its file's", and the e2e
  "each page with a body renders it and its pictures load") passed against the files as they stood
  at 23:21. They need a rerun after builder A's final pass. `pnpm exec playwright test
--project=public`: 6 passed after the foot-test fix. `pnpm seed` not run: the public project
  writes nothing to the store, and builder A's screenshot run was live at the time, which a seed
  would have broken. Their run ends with its own `pnpm seed`. `pnpm fmt` not run.

### Script and pictures

Phase 1, builder A. Files touched: `scripts/help-screenshots.ts`, `public/assets/help/workflows/*.png`
(ten, new), the ten `workflows/*` entries in `src/lib/helpPictures.ts`. Nothing else; `package.json`
needed no change (`pnpm help:screenshots --section workflows` passes the flag through).

**The script**

- `--section <slug>` filters both shot lists by `file` prefix, keeps array order, and skips the
  admin context or the member sign-in when its list is empty. A slug no picture has (or
  `--section` with no value) is refused before the store is touched. The gates, the showcase seed
  and the closing `pnpm seed` run either way. The JSDoc says a section's block starts from a bare
  screen and leaves nothing open.
- Helpers added: `clickMenuItem` (copied from `e2e/workflows.spec.ts`, verified there:
  `s-menu#workflow-actions s-button`, native click), `cancelModal`, `closeEditor` (the Getting
  started block's Close now uses it too), `openWorkflow`, and `orderOf(title, variant)`.
- **The gift set order is found from the fixture, not a hand count.** `orderOf("Journal and pen
gift set", "Black")` reads `orders` in `e2e/showcaseFixture.ts`, as `orderWith` does for property
  values. It resolves to **#1211**, and the picture shows `#1211` in the title bar, so the hand
  count was right. (The Tan gift set, #1241, is the one attached to Gift set assembly.)
- **A modal is cancelled at the start of the next shot**, not at the end of its own: `take` runs
  before the shape shoots, so the Cancel (and the editor's Close after `editing3`) sits in the
  following shot's `take`. The block still ends with nothing open (`matching1` is a page).
- **Edit is retried until the window opens**, as `openEditor` in `e2e/workflows.spec.ts` does; the
  plan said one `clickHoisted`.
- **`turningOnAndOff1` waits for "New orders won't start this workflow."**, not "keep going": the
  Delete modal's hidden body also says "Items already on it keep going", so "keep going" is not
  unique on that page.
- **`creating1` goes through Teams before Workflows.** In the full run (no flag) it timed out
  twice: the Workflows page read "No workflow matches 1210". Cause, traced with a probe: the orders
  layout and the workflows layout both `retainSearchParams` with a `q` key (`app.orders.tsx`,
  `app.workflows.tsx`), and the order page's URL keeps the index's `q` by design, so pressing
  Workflows in the nav from an order opened by searching its number carries `?q="1210"` onto the
  Workflows page and filters it. The admin URL showed `.../app/orders/seed-1210?q="1210"` and then
  `.../app/workflows?q="1210"`. **This is an app bug a merchant will meet**: search an order,
  open it, press Workflows, and the list is filtered by an order number. It is outside my files;
  the fix belongs in the routes (do not retain `q` across sections). `openScreen`'s
  `url.search === ""` assertion did not catch it, so it passes before the search lands.
  The Getting started block's `firstWorkflow1` has the same leak behind its modal, unseen.
- Fact checks: the task card's `accessibilityLabel` is `Edit <task name>`, but it is set in
  `TaskCard` in `src/components/WorkflowSteps.tsx`, not in `app.workflows.$workflowId_.edit.tsx`;
  the script presses it by role, as the e2e spec does. Edit tag and its modal (heading "Edit tag",
  `TAG_HELP` plus the retag sentence, Tag field, Cancel, Save) are in `WorkflowTag.tsx` as the plan
  says. `TURN_OFF_BODY` and `copyName` (name + " copy", trimmed to `NAME_MAX_LENGTH`) are as the
  plan says.

**Overlay stems not in the last plan's table**

| stem                                                   | what                             | handled by  |
| ------------------------------------------------------ | -------------------------------- | ----------- |
| `_glow_h6i84_131` with `_glow5_`, `_glow6_`, `_glow7_` | unknown admin glow, three layers | nothing yet |

It refused `firstOrder1` (a Getting started shot, before the Workflows block) in two of the first
four full runs, then never again in five more runs (two section runs, three full). A probe on
#1206 and #1210, sampled every 500 ms for 3 s, found no `_glow_` element at all, so I could not
tell what draws it (a Sidekick or notification animation is a guess). I did not add it to
`HIDE_OVERLAYS` without knowing what it is; a rerun passes. If it returns, hiding
`[class*="_glow_"]` is the likely fix. No other new stem met the check.

**Runs and timing**

`--section workflows`: two runs, the same ten sizes both times; the merchant pass took 19 s and
18 s, the whole command 30 s and 24 s (no member sign-in). Full runs: the first four failed (two on
`_glow_`, two on the `q` leak), then after the Teams detour the last two passed with all 24
pictures, the Workflows sizes unchanged and the seven Getting started sizes as committed; the
merchant pass took 27 to 28 s. Every run ended with the script's own `pnpm seed`, failed ones
included; `pnpm dev:status` is healthy after. The full runs re-shot the member and Getting started
pictures with only the seed's clock changed; I restored both with `git checkout --
public/assets/help/members public/assets/help/getting-started` (the plan named members only; the
Getting started pictures also show the clock and are outside my list).

**What each picture shows**

- `creating1` (1056 × 518, page): the title bar Workflows with Create workflow and `…`; All
  (selected), Active, Inactive and "Search by name"; the table Workflow, Status, Tag, Steps,
  Updated, eight rows. Every row reads Active except Frame and glaze (Inactive); Weekend engraving
  reads Active and Team has no members. Embroider and fold shows 2 steps (the applied ones; its
  draft has three). Every Updated cell is the seed's time.
- `editing1` (1212 × 680, window): Embroider and fold, a Draft badge, More actions, Discard
  changes, Apply changes, Close; Step 1 Embroider name (Textiles), Step 2 Sew in care label
  (Textiles), Step 3 Fold and wrap (Finishing), each with instructions, Add step, and the foot
  line "Learn more in Editing steps and tasks." A faint shadow sits under the title-bar buttons
  (the admin's own).
- `editing2` (1212 × 714, window): the same with Sew in care label shaded and **Add task** under
  it; the panel is headed **Step** (not Task), with Name, Team (Textiles), Instructions, Move
  earlier, Move later, **Join the previous step** (it is alone in its step, so no Move to its own
  step), Delete in red, Save.
- `editing3` (620 × 178, editor modal): "Apply changes?", `APPLY_BODY` on two lines, Cancel, Apply.
- `matching2` (620 × 250, modal): "Edit tag", `TAG_HELP` and the retag sentence, Tag
  `embroidered-blanket`, Cancel, and **Save greyed** (nothing changed).
- `turningOnAndOff1` (620 × 158, modal): "Turn off workflow?", `TURN_OFF_BODY`, Cancel, Turn off.
  The modal does not name the workflow.
- `managing1` (620 × 286, modal): "Duplicate workflow", Name `Cut, engrave and oil copy`, Tag
  `cut, engrave and oil copy`, the `TAG_HELP` line, Cancel, Duplicate. **Reads wrong:** the
  filled tag carries a comma and spaces. Shopify splits product tags on commas, so this tag can
  never be put on a product as one tag; a merchant who accepts it gets a workflow nothing matches.
  The same holds for Create with a comma in the name. A product question for the review (fill
  the tag as a slug, or refuse a comma); the body should at least not suggest keeping it.
- `managing2` (620 × 158, modal): "Delete Cut, engrave and oil?", "Items already on it keep going.
  This can't be undone.", Cancel, Delete in red.
- `turningOnAndOff2` (1056 × 632, page): Workflows / Frame and glaze, an Inactive badge, Edit,
  More actions, Turn on workflow, `…`; "Last updated on <time>"; the Tag card "Starts when an
  order contains a product tagged “photo-frame”." with Edit tag; Step 1 Cut mat (Woodshop), Step 2
  Glaze and fit (Finishing), each with instructions.
- `matching1` (1056 × 292, page): Orders / #1211, Sync from Shopify, View in Shopify; the item
  "Journal and pen gift set — Black", × 1 · SKU GS-BLACK, the sentence "More than one workflow
  matches this item, so none was started.", the Workflow select reading Choose workflow and a
  greyed Attach; Order details: Placed, Paid, Unfulfilled; the foot line "Learn more in Reading an
  order." **Departs from the plan in two ways:** the order page shows **no Multiple workflows
  match badge** (that label is the Issues badge on the orders list, `ORDER_ISSUE_LABEL.multi_match`;
  the order page shows only `MULTI_MATCH_SENTENCE`), and the select's options are not visible (a
  native select's list does not render in a headless screenshot, and choosing one would show only
  one name). The body should say the orders list shows Multiple workflows match and the order page
  says more than one workflow matches.

No toast, overlay or cut control shows in any of them. Alt texts rewritten from the pictures, 48
to 57 words each; entry comments say the shape and the state.

**Checks**

`pnpm typecheck` and `pnpm lint` green. `pnpm test` and the public e2e project not run (builder
B's). `pnpm fmt` not run.

**Unverified**

- What `_glow_` is.
- That the Workflow select on #1211 lists exactly Stamp and bind and Gift set assembly: not
  visible in the picture, and not claimed by the alt text.

## Review (2026-10-07)

Read both Deviations sections, the ten pictures, the five bodies and the diffs outside the plan's
file lists; ran `pnpm fmt`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (779) and the `public` e2e
project (6), all green; the store is back on the dev fixture. The pictures are clean: no overlay,
toast, black corner or cut control, and every sentence checked against its screen holds. Nine
findings, each with a recommendation.

1. **The filled tag can carry a comma** (`managing1` shows `cut, engrave and oil copy`; Create
   does the same for a name with a comma). Shopify splits product tags on commas, so that tag can
   never sit on a product and the workflow matches nothing. Recommend a product fix: the Tag
   mirror drops commas, and `WorkflowTag` refuses one with an error under the field ("A tag can't
   have a comma."). Then retake `managing1` and say in Creating a workflow that a tag has no
   comma.
2. **An order search leaks onto the Workflows page.** Search an order by number, open it, press
   Workflows in the nav: the list reads "No workflow matches 1210". The orders and workflows
   layouts both retain `q` and the nav link carries the current search. Recommend fixing it now
   in the nav (a section link starts with an empty search) and dropping the script's Teams detour
   on `creating1`; it is a merchant-facing bug and the fix is one link.
3. **Matching cannot link Syncing from Shopify** because the lint refuses copy starting with
   "Syncing", which was written for a status line. Recommend exempting the anchored patterns
   (`^\s*…`) for the text of an `s-link` whose href is under `/help/`, the exemption the
   integration test already makes for titles, and adding the link on Matching. The Orders section
   needs it too.
4. **Edit tag lowercases, Create keeps the case.** Two rules for one field. Recommend Edit tag
   keeps the tag as typed, like Create, so the rule is one ("trimmed, kept as typed, matched
   exactly"), and Matching drops "The tag is saved in lowercase."
5. **Instructions' 500 and 300 are on Editing and on Limits.** One fact, one place: recommend
   Editing says the field counts the characters left as you near the limit, and Limits keeps the
   numbers.
6. **Matching's first section is one ten-sentence paragraph.** Recommend splitting it in two: the
   tag and the exact match, then what a near miss looks like (No workflow, the Workflow select,
   retagging).
7. **Accept the builders' departures**: the e2e foot test looking in the foot only, `closeEditor`
   and `cancelModal` shared with the Getting started block, a modal cancelled at the start of the
   next shot, Edit retried until the window opens, the Getting started pictures restored from
   git, and the `--section` flag as built. All forced by the code or the admin.
8. **The `_glow_` overlay is unknown and intermittent** (two refusals in nine runs, never
   reproduced by a probe). Recommend leaving it: a refusal is a rerun, and hiding a stem nobody
   has seen could hide a real overlay.
9. **Accept the content departures recorded by builder B**: a new workflow reads Inactive and No
   steps on the list, Matching at four sections, Turn off on the page alone, the panel's Step or
   Task heading, Move earlier and Move later by order. Each was checked against the code.

Nothing else is open.

## Follow-ups (2026-10-08)

All nine recommendations accepted; the follow-ups are in, uncommitted, with `pnpm typecheck`,
`pnpm lint`, `pnpm test` (781), the `public` e2e project (6), `e2e/workflows.spec.ts` (10) and
the orders search test green, and the store on the dev fixture.

1. **A tag has no comma.** `Domain.WorkflowTag` refuses one; `suggestedTag` in
   `src/lib/workflowShared.ts` is the one prefill rule (commas dropped, trimmed, lowercased) for
   Create and Duplicate; `tagCommaError` is the submit error under the three tag fields.
   `managing1` retaken: the Tag reads `cut engrave and oil copy`. Creating a workflow says it.
2. **The search stays in its section.** `retainSearchParamsUnder` in `src/lib/searchParams.ts`
   retains only when the page the navigation leaves is under the layout's path; both layouts use
   it. The orders search e2e test pins it, and the script's Teams detour is gone.
3. **A help link's text is held to the unanchored patterns** (`retiredCopyHits`, with a test).
   Matching links Syncing from Shopify.
4. **Edit tag keeps the case**, like Create; Matching no longer says the tag is lowercased.
5. **Editing names no number** for Instructions and links Limits.
6. **Matching's first section is two paragraphs.**
   7, 8, 9. Accepted as built; nothing changed.
