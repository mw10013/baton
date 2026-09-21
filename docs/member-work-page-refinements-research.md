# Member Work Page Refinements Research

Research date: 2026-09-21. Reviewed and decided the same day. Nothing here is open.

Subject: the member work page, `src/routes/shop.$shop.work.$runId.tsx`, as it stands after `b34bf74 Refine member queue interactions`. Eight review notes taken from two screenshots, each weighed and decided. All eight are settled; nothing about the eight is parked.

Companion to `docs/member-queue-refinements-research.md`, which covered the queue screen this page is opened from. Several of its decisions set precedent here and are cited where they do.

## What the page is

Confirmed: the page renders **one `WorkflowRun`**, which is one workflow attached to **one order line item**. `view.steps` are that run's steps and no others. An order with three line items, each with a workflow, has three runs and three of these pages; the run's own line item is the card at the top, and the other items on the order are the "Also on this order" section (item 2).

In the screenshot the workflow badge reads `Signet ring` and the item is also `Signet ring`. That is the seed data naming a workflow after the product, not a duplicated field.

## Scope

Only this route and the pieces it owns in `src/components/MemberRun.tsx`. Item 2 reaches into `Domain` and `WorkflowRunRepository` because the cut removes a loader field and the SQL behind it. Nothing else touches the object or the socket.

## The screen now

```
+--------------------------------------------------------------+
| [B] sandbox-shop-01.myshopify.com        m1@m.com  [Sign out] |  MemberBar
+--------------------------------------------------------------+
| Queue > #1002                                                 |  s-page
+--------------------------------------------------------------+
| Signet ring x1                                                |
| Size   9                                                      |
| Metal  Sterling silver                                        |
| [Signet ring]  ordered 23m ago                                |
+--------------------------------------------------------------+
| Steps                                                         |
| +----------------------------------------------------------+ |
| | 1 - Cast  Jewelry  [Done]                                | |
| | Done by lead@m.com - Sep 21, 3:52 AM                     | |
| | Can't undo: Engrave crest (Engraving) already started    | |
| | Ring size and metal are in the personalization.          | |
| | [Undo]  [Add note]            <- Undo disabled           | |
| +----------------------------------------------------------+ |
| | 2 - Engrave crest  Engraving  [In progress]   <- subdued | |
| | In progress since 3:52 AM by lead@m.com                  | |
| | Crest file is named after the order number.              | |
| | [Done]  [Add note]                                       | |
| +----------------------------------------------------------+ |
| | 3 - Polish  Jewelry                                      | |
| | Waiting on step 2                                        | |
| | High polish unless the order says brushed.               | |
| | [Add note]                                               | |
| +----------------------------------------------------------+ |
+--------------------------------------------------------------+
| Also on this order                                            |
| Leather journal x1  [In progress]                             |
| Initials  J.R.M.                                              |
+--------------------------------------------------------------+
| Block this work                                               |
| [ What is stopping this? Who needs to know?                 ] |
| [Block]                                                       |
+--------------------------------------------------------------+
```

Code map:

| Piece                      | Where                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Queue >` breadcrumb       | `shop.$shop.work.$runId.tsx:137` (`QueueBreadcrumb`)                                                   |
| state line and badge       | `shop.$shop.work.$runId.tsx:68` (`stepState`)                                                          |
| step card                  | `shop.$shop.work.$runId.tsx:198` (`renderStep`)                                                        |
| step card header line      | `shop.$shop.work.$runId.tsx:216`                                                                       |
| actionable tint            | `shop.$shop.work.$runId.tsx:213` (`background=`)                                                       |
| `Can't undo:` line         | `shop.$shop.work.$runId.tsx:228`                                                                       |
| note editor                | `shop.$shop.work.$runId.tsx:244`                                                                       |
| step action row            | `shop.$shop.work.$runId.tsx:288`                                                                       |
| disabled Undo              | `shop.$shop.work.$runId.tsx:323`                                                                       |
| item card                  | `shop.$shop.work.$runId.tsx:462`, `MemberRun.tsx:166`                                                  |
| flag banner and its editor | `shop.$shop.work.$runId.tsx:411`, `481`                                                                |
| Also on this order         | `shop.$shop.work.$runId.tsx:489`, `MemberRun.tsx:189`                                                  |
| Block this work            | `shop.$shop.work.$runId.tsx:505`                                                                       |
| which buttons a step gets  | `src/lib/Domain.ts:3363` (`Domain.stepActions`)                                                        |
| undo blocker wording       | `src/lib/Domain.ts:3238` (`Domain.undoBlockerLine`) — since inlined into the merchant route, see below |
| the loader's shape         | `src/lib/Domain.ts:3401` (`Domain.RunView`)                                                            |
| the other items' SQL       | `WorkflowRunRepository.ts:894` (`orderItems`)                                                          |
| print rules                | `src/styles.css:161`                                                                                   |

Two facts that decide several items below:

- **The tint does not mean "in progress".** `background={can.done ? "subdued" : "base"}` is `Domain.stepActions().done`, which is true when the step is ready, on one of the member's teams, the run is open and unflagged, and the step is unfinished. It means **"you can act on this"**. In the screenshot that step happens also to be in progress, which is why it reads as a progress cue.
- **Every state line repeats its badge's word.** `stepState` returns `Done` + "Done by …", `In progress` + "In progress since …", `Ready` + "Ready". The badge and the first words of the line under it always say the same thing.

---

## 1. The `Queue >` breadcrumb

**Now.** `QueueBreadcrumb` renders an `s-link` reading `Queue` into `s-page`'s `breadcrumb-actions` slot, with a real `href` built from the router and a click handler that converts it to a client navigation.

**The note.** The word `Queue` is not wanted; an app icon was suggested instead.

**If it were deleted.** Nothing is lost that is not already on screen. `MemberBar` sits directly above it on every member route and its Baton mark plus shop name is a `Link to="/shop/$shop"` — which **is** the queue. The breadcrumb is a second link to the same destination, about 30px below the first.

**What "app icon" would mean.** There is no Polaris app-icon placeholder that is Baton's. The nearest things are `s-icon type="apps"` / `"app-extension"` (generic admin glyphs), `s-thumbnail` and `s-avatar` placeholders (generic image and person glyphs). The actual Baton mark is the inline SVG in `MemberBar.tsx:62`, duplicated from `public/favicon.svg`. So "use the app icon" means either lifting that SVG into a shared component and putting a second copy of it in the breadcrumb slot — two identical marks stacked — or a generic Polaris glyph that is not Baton's mark.

**Decision: delete `QueueBreadcrumb`.** The mark in the bar already is the back link, and one link back beats two. Deleting it also removes the `styles.css` print rule written specifically for it (`s-link[slot="breadcrumb-actions"]`, `styles.css:163`) and the JSDoc that explains why that rule could not be a `.print-hide` wrapper.

An icon-only back link (`<s-link slot="breadcrumb-actions" accessibilityLabel="Queue"><s-icon type="arrow-left" /></s-link>`) was offered as the alternative and declined in review: the page keeps no breadcrumb at all. An app icon in a breadcrumb would read as "home", and the mark in the bar above already is that.

**Cost.** Two e2e steps navigate by this link: `member-queue.member.spec.ts:904` and `:938`, both `page.getByRole("link", { name: "Queue", exact: true }).click()`. They become a click on the bar's mark.

---

## 2. "Also on this order"

**Now.** Every other live line item on the order, each with its make status badge and its personalization rows (`OrderItems`, `MemberRun.tsx:189`).

**The note.** It does not scale — an order with a hundred line items renders a hundred of them — and the page is about one line item.

**If it were deleted.** A maker loses sight of what else ships with the piece. That matters at one bench only, the last one, where someone boxing an order wants to know the other half is made. It does not matter at the bench where the piece is cast, engraved or polished, which is every other row in the queue.

**Decision: accepted, and the data path goes with it.** The list is unbounded, it is on the page a member opens most, and the section is below the fold on a phone anyway. The deletion is clean and reaches further than the route:

| Deleted                                        | Where                                                        |
| ---------------------------------------------- | ------------------------------------------------------------ |
| the section                                    | `shop.$shop.work.$runId.tsx:489`                             |
| `OrderItems`                                   | `MemberRun.tsx:189`                                          |
| `ITEM_STATUS`                                  | `MemberRun.tsx:119` — no other reader                        |
| `RunView.items`                                | `Domain.ts:3405`                                             |
| `QueueOrderItem`                               | `Domain.ts:3046` — despite the name, only this page reads it |
| `orderItems`, `worstStatus`, `RUN_STATUS_RANK` | `WorkflowRunRepository.ts:868`, `876`, `894`                 |
| the `items` read in `getRunView`               | `WorkflowRunRepository.ts:1824`                              |

`Personalization` and `itemLabel` stay — `RunItem` uses both for the card at the top.

**Cost.** The printed job ticket loses the rest of the order. The page prints as a ticket for one item (`styles.css:161`), so that is consistent. Reviewed and accepted: printing is not a constraint on this page. No print-only variant of the section is kept.

---

## 3. "Block this work"

**Now.** A bottom section with a permanently mounted `s-text-area` and a critical `Block` button, rendered when the run is open and unflagged. Once blocked, the section disappears and the banner at the top carries `Unblock` and `Edit reason`.

**The note.** It is at the bottom to keep it out of the way, but it is still in the main view and still takes vertical space, and a member blocks work rarely.

**If it were deleted.** Blocking would only be possible from the queue row's menu — but there is no block item there either; the queue's menu offers `Unblock` and `Dismiss`, never `Block`. So deleting it removes the only way a member can stop a job, which is the point of the feature. It stays.

**Decision: the trigger moves into the page's action slot; the field appears where the block banner will appear. No modal.**

```tsx
<s-button
  slot="secondary-actions"
  variant="secondary"
  onClick={() => setBlocking(true)}
>
  Block
</s-button>
```

`s-page`'s `secondary-actions` slot "Only accepts button group and button components with a `variant` of `secondary` or `auto`", which this is. Pressing it renders the reason editor in the first section, in the slot `FlagBanner` occupies once the hold exists — so the editor appears exactly where its result will appear, and on save the editor is replaced in place by the `Blocked` banner it produced. Cancel puts it away.

That slot already holds a reason editor of the same shape: `Edit reason` in the banner swaps the banner's body for `reasonEditor` (`:411`). The new one is the same component with `Block` instead of `Save reason`, so the two paths into a hold's text look identical.

This is a cut, not a relocation: the bottom section, its heading, the always-mounted field and the `.print-hide` wrapper around it all go, and nothing is mounted until a member asks for it. A button in `s-page`'s action slot needs no print rule — `@media print { s-button { display: none } }` already covers every button on the page.

A modal was considered and rejected in review. Polaris would have supported it (data entry with save and cancel is a listed modal use case, and the modal doc says to prefer a modal over a popover for a form with a destructive commit), but `s-modal` in the member area drags in `src/lib/polarisModal.ts` — the backdrop-dismiss guard and the dirty handling written for the two merchant-side modals — and the `useModalBackdropDismissGuard` half of that applies here even though the App Bridge half does not. An overlay is not worth that on a bench tablet for a field a toggle can reveal.

Nothing else belongs in a menu today (the only other page-level verbs are `Unblock` / `Dismiss` / `Edit reason`, and those live in the flag banner by an existing decision), so this is one button, not a kebab.

**Cost.** One piece of route state (`blocking`), and the existing `reason` / `reasonDraft` pair collapses toward one editor used twice. `member-queue.member.spec.ts:885` fills `Reason` and clicks `Block` with the field already on screen; it grows a press-Block-first step.

---

## 4. `Cast Jewelry` on the step card header

**Now.** One inline stack: strong `1 · Cast`, subdued `Jewelry`, then the badge. Step name and team name are adjacent with only a weight change between them, so `Cast Jewelry` reads as one noun phrase. Both names are merchant-authored and unbounded.

**Decision: take the team off line one and put it at the head of the meta line.**

```
1 - Cast                                        [Done]
Jewelry - lead@m.com - Sep 21, 3:52 AM
```

Line one becomes step number, step name, status badge — the same shape as a queue row. The team joins the other metadata, where it is a subdued sentence that wraps instead of a column that pushes the badge off the row. One unbounded name per line, and the two that collided are no longer adjacent.

**Decision: accepted.** The alternative raised in review was right-aligning the team on line one (`1 · Cast [Done] ........ Jewelry`). Declined: it separates the names but makes the header a `1fr auto` grid whose right cell holds unbounded text, so a long team name squeezes the step name and the badge sits between two variable-width things.

**The verb.** Moving the team makes the badge-and-line repetition visible: `[Done]` over `Jewelry · Done by lead@m.com`. Since the badge is what states the state — the same argument that removes the tint in item 8 — the line can drop the verb and be attribution only:

| State       | Badge         | Meta line                                |
| ----------- | ------------- | ---------------------------------------- |
| Done        | `Done`        | `Jewelry · lead@m.com · Sep 21, 3:52 AM` |
| In progress | `In progress` | `Jewelry · lead@m.com · since 3:52 AM`   |
| Ready       | `Ready`       | `Jewelry`                                |
| Waiting     | none          | `Jewelry · waiting on step 2`            |

Waiting keeps its words because it has no badge. **Decision: accepted.** This is a rewrite of `stepState` rather than a move, so it is the larger half of this item.

**Cost.** `stepState` (`:68`) and the header stack (`:216`). If the verb is trimmed, `member-queue.member.spec.ts:787` and `:935` (`Done by ${MAKER}`), plus the `Merchant` actor assertions in the test at `:962` change.

---

## 5. `Can't undo:` and the disabled Undo button

**Now.** A finished step whose successor has started renders a subdued line naming the blocker and a disabled `Undo` button beside `Add note`.

**The note.** The explanation is clumsy, and on a page that lists every step in order it is not needed; neither is the disabled button.

**Decision: accepted. Offer `Undo` only when it is allowed, and delete the line.**

This is the queue's decision 8 applied to the page it deferred to. The argument is stronger here: the queue dropped the disabled button and the line on the grounds that the work page would state the refusal in full, but the work page is the one screen where the refusal is self-evident — step 2 is on screen with an `In progress` badge, directly under the step you cannot undo. A sentence explaining that is the page arguing with itself.

```
before:
  1 - Cast  Jewelry  [Done]
  Done by lead@m.com - Sep 21, 3:52 AM
  Can't undo: Engrave crest (Engraving) already started
  [Undo (disabled)]  [Add note]

after:
  1 - Cast                                        [Done]
  Jewelry - lead@m.com - Sep 21, 3:52 AM
  [Add note]
```

`Domain.stepActions` does not change — `can.undo.blockedBy` is still computed and is still the thing the page branches on; the branch renders nothing instead of a disabled button.

**Cost.** `Domain.undoBlockerLine` loses one of its two render callers, leaving one: `app.orders.$orderId.tsx` renders the merchant's `Can't reopen: … — reopen it first`, a different audience with a different next action (a merchant can reopen the blocker; a member cannot).

**Followed through after the build.** With one caller the symbol had nothing left to keep in agreement — its own JSDoc justified it as "one sentence with three callers, so the screens cannot drift" — so the wording was inlined into that route with its garden-path reasoning as a comment, and `Domain.undoBlockerLine` deleted. `Domain.undoBlockedBy` and the `UndoBlocker` type stay: those are the rule and its shape, and they have several readers. This also matches how the codebase already places shared display strings — `flagHeading`, `flagBody` and `flagTone` live in `MemberRun.tsx`, not `Domain`.

Its unit test went with it. The title was "the undo blocker is named the same way on every screen", which had stopped being true; the full sentence is asserted end to end by `the merchant cannot reopen a step whose next stage is done` in `e2e/orders.spec.ts`, so the wording is still pinned by a test whose title is a rule.

`member-queue.member.spec.ts:815`, "a blocked undo drops the row's menu and names the blocker on the work page", is a rule test whose rule this reverses. Its title, JSDoc and final assertion become: the work page offers no Undo and says nothing about why.

---

## 6. Two primary buttons while a note is open

**Now.** Opening the note editor on the in-progress step leaves the step's action row mounted below it, so `Save note` (primary) and `Done` (primary) are two black buttons stacked, with `Cancel` between them.

**Decision: hide the step's action row while that step's note editor is open.**

The editor already takes over the card — one editor at a time across the page (`noteDraft` is a single slot) — so the card's buttons while editing should be the editor's: `Save note`, `Cancel`. `Done` comes back when the note is saved or cancelled. No second primary can exist because only one button row is mounted at a time.

A modal would also solve it, and was raised in review. **Rejected, here and for Block (item 3): no modal on this page.** The note is the per-step, routine action, and an overlay over the card you are reading is a worse trade on a bench tablet than a card that grows by one field. It would also pull `polarisModal.ts` — the backdrop-dismiss guard written for the merchant-side modals — onto the member area's routine path.

**Consequence.** If the action row is hidden, the `Add note` button that gave the field its context is hidden too, and the field's label is `labelAccessibilityVisibility="exclusive"`. So the label must become visible — which is also the answer to item 7.

**Cost.** `renderStep`'s `anyAction` branch (`:288`) gains `&& !editingNote`.

---

## 7. The `Note about this step` placeholder

**Now.** `placeholder="Note about this step"` on the step note field, with the label hidden.

**Decision: accepted. Delete the placeholder and show the label as `Note`.**

The placeholder restates the button that opened the field. Deleting it alone would leave an unlabelled box, because the visible label is suppressed and (per item 6) the `Add note` button is hidden while editing. A visible `Note` label is one short line, is what the field actually is, and does not vanish when the reader starts typing — which is the standing objection to placeholders as labels.

**Also fixed: the merchant's step note.** `app.orders.$orderId.tsx` carried the identical `placeholder="Note about this step"` over a hidden label, and that page already unmounts its `Add note` button while the editor is open — so the placeholder was the field's only name and stopped being one at the first keystroke. Same two-line fix, and `noteEditor`'s JSDoc there already ties the two fields together ("the same text is typed into both"), so leaving one fixed was the drift that doc guards against.

**Not touched: the block reason placeholder.** `What is stopping this? Who needs to know?` is a prompt for something a member writes rarely and has to get right, not a restatement of its label. It stays, in the modal from item 3 and in the banner's `Edit reason` editor.

**Cost.** `:248`. `member-queue.member.spec.ts` uses `page.getByLabel("Note")`, which works either way.

---

## 8. The subdued background on the actionable step

**Now.** `background={can.done ? "subdued" : "base"}` (`:213`).

**The note.** It is subtle, and the `In progress` badge already marks that card.

**Correction to the reading.** The tint is not "in progress" — it is `Domain.stepActions().done`, "you can act on this step now". In the screenshot the two coincide. A step that is ready but not started is also tinted, and carries a `Ready` badge and a `Start` button; a step someone else's team has in progress is **not** tinted.

**Proposal: accepted, delete it.** The cue it carries is already carried by the strongest possible signal — the `Done` (or `Start`) button, which is the only primary button on the page and appears on exactly the steps the tint marks. A background tint that duplicates a black button is not adding a distinction.

This also matches the queue's decision 7 and the comment quoted there: a surface tint that fires on most of what is on screen tints the view and separates nothing. Here the run has one actionable step at a time, so the tint is one card in three or four, which is a weaker version of the same failure — the button is doing the work either way.

**Cost.** One prop.

---

## The screen after all of it

```
+--------------------------------------------------------------+
| [B] sandbox-shop-01.myshopify.com        m1@m.com  [Sign out] |
+--------------------------------------------------------------+
| #1002                                             [  Block  ] |
+--------------------------------------------------------------+
| Signet ring x1                                                |
| Size   9                                                      |
| Metal  Sterling silver                                        |
| [Signet ring]  ordered 23m ago                                |
+--------------------------------------------------------------+
| Steps                                                         |
| +----------------------------------------------------------+ |
| | 1 - Cast                                          [Done] | |
| | Jewelry - lead@m.com - Sep 21, 3:52 AM                   | |
| | Ring size and metal are in the personalization.          | |
| | [Add note]                                               | |
| +----------------------------------------------------------+ |
| | 2 - Engrave crest                          [In progress] | |
| | Engraving - lead@m.com - since 3:52 AM                   | |
| | Crest file is named after the order number.              | |
| | [Done]  [Add note]                                       | |
| +----------------------------------------------------------+ |
| | 3 - Polish                                               | |
| | Jewelry - waiting on step 2                              | |
| | High polish unless the order says brushed.               | |
| | [Add note]                                               | |
| +----------------------------------------------------------+ |
+--------------------------------------------------------------+

While a note is open on step 2:

| +----------------------------------------------------------+ |
| | 2 - Engrave crest                          [In progress] | |
| | Engraving - lead@m.com - since 3:52 AM                   | |
| | Crest file is named after the order number.              | |
| | Note                                                     | |
| | [                                                      ] | |
| | [Save note]  Cancel                                      | |
| +----------------------------------------------------------+ |
```

## Change summary

| #   | Change                                                    | Files                                                           | Rule tests touched                     |
| --- | --------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| 1   | Delete `QueueBreadcrumb` and its print rule               | route, `styles.css`                                             | two navigation steps in the queue spec |
| 2   | Delete "Also on this order" and its whole data path       | route, `MemberRun.tsx`, `Domain.ts`, `WorkflowRunRepository.ts` | none                                   |
| 3   | `Block` becomes a page action revealing the editor inline | route                                                           | the block half of the work-page spec   |
| 4   | Team moves to the meta line; the badge's verb is trimmed  | route                                                           | actor assertions                       |
| 5   | Undo only where allowed; no `Can't undo:` line            | route, `Domain.ts` JSDoc                                        | `a blocked undo…` is reversed          |
| 6   | Step action row hidden while its note editor is open      | route                                                           | none                                   |
| 7   | Note placeholder deleted, label made visible              | route                                                           | none                                   |
| 8   | Actionable tint deleted                                   | route                                                           | none                                   |

Every item is presentation except item 2, which deletes a loader field, a schema and a query. No modal is added and `src/lib/polarisModal.ts` stays where it is. Nothing changes what a member is allowed to do: `Domain.stepActions` is untouched.

---

## Decisions

All eight items are decided; the review resolved every choice that was open.

| Was open                      | Decided                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Breadcrumb: cut or icon link  | Cut. No back affordance on the page; the bar's mark is the link.                                                     |
| Notes and Block: modal or not | **No modal anywhere on this page.** Notes take the card over; Block reveals its editor where the banner will appear. |
| Team name's place             | Head of the meta line.                                                                                               |
| The badge's verb              | Trimmed. The badge states the state, the line attributes it.                                                         |
| The printed ticket            | Accepted as-is. Printing is not a constraint here.                                                                   |

## Why item 2 is a complete deletion, not a gap

Raised in review and settled: **Baton has no order workflow and no packer.** A workflow is attached to a _product_, by the tag the product carries, and runs once per matching order line item — `Domain.ts:931`, "A workflow: chosen by its tag, running once per matching line item", with the tag rule written out at `Domain.ts:819`. An order-level workflow was considered and dropped; whatever happens to an order as a whole happens outside this application.

So "Also on this order" was answering a question the app does not ask. There is no bench whose job is the order rather than the line item, which means the section had no reader to lose and item 2 leaves nothing to fill in later. The scope of a member's attention is one line item and its steps, which is what this page already is.

Nothing in this document is open.
