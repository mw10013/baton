# Member run page: implementation plan

Hand-off plan for the layout decided in `docs/member-run-page-research.md` (Decisions 1 to 14, 2026-09-23). Read that doc's Decisions section and the "Proposed page" sketch first. This plan is self-contained otherwise.

One route file changes, `src/routes/shop.$shop.workflows.$runId.tsx`, plus the JSDoc and e2e assertions that describe it. No schema, no Domain rule, no server change. The seed is not touched (decision 14). The merchant order page (`app.orders.$orderId.tsx`) is out of scope; see "Out of scope" for the one place it disagrees with a decision.

## The change in one paragraph

Today the page is four cards: item (with workflow badge, age and the flag banner inside it), Note (heading plus `Add note` / `Edit`), Order note, and Steps (heading, `Step n` captions, one bordered card per task, a primary `Done`). After the change the page is: heading `#2009`; the flag banner and any mutation error banner at page level under the heading; the item, personalization and SKU as plain text with no border, badge or age; one prose block for the run note (placeholder `Note` when blank) with an `Edit` button, and the Shopify order note folded in under a `From the order:` prefix; then, per step, a subdued `Step n` caption over one bordered box whose parallel tasks are separated by rules. Task buttons are all secondary, ordered advancing action first. A waiting task shows only its team.

## Target render

```
#2009                                        [Block]

[Blocked banner, when flagged: heading, reason, who · when, Edit · Unblock]
[critical banner with actions.banner, when set]

Leather journal ×1
Engraving  M.E.B.
SKU LJ-A5

Waiting on gold foil, ETA Thursday. — K          [Edit]
   (blank: "Note" in subdued text               [Edit])
From the order: Gift, please no invoice.

Step 1
┌──────────────────────────────────────────────┐
│ Cut leather                       Done       │
│ Leather · lead@m.com · Sep 23, 2:11 PM        │
└──────────────────────────────────────────────┘

Step 2
┌──────────────────────────────────────────────┐
│ Stamp monogram                    Ready      │
│ Engraving                                    │
│ Initials in the personalization; centre.     │
│ [Start] [Done]                               │
├──────────────────────────────────────────────┤
│ Stitch spine                      In progress│
│ Leather · lead@m.com · since 2:11 PM          │
│ [Done] [Put back]                            │
└──────────────────────────────────────────────┘

Step 3
┌──────────────────────────────────────────────┐
│ Condition and inspect                        │
│ Leather                                      │
└──────────────────────────────────────────────┘
```

The Done / Cancelled run badge stays, beside the item line, because it is the only thing that tells a member the page is read-only.

## Order of work

Run `pnpm typecheck && pnpm lint && pnpm test` after phase 2 and after phase 3. Run the member e2e project after phase 3: `npm run test:e2e -- --project=member`. Run `pnpm fmt` at the end and keep every file it touches.

### Phase 1: the route

All in `src/routes/shop.$shop.workflows.$runId.tsx`.

1. **`taskState`.** In the waiting branch return `text: task.teamName` and drop the `waiting on step` sentence. Rewrite the JSDoc: the badge states the task's state and the line never repeats it; the line is the team, then who and when; a waiting task has no badge and its line is the team alone, because its position under a later step caption already says what it waits on. Delete the sentence about "the one state whose line carries the verb".
2. **Task buttons.** In `renderTask`, set `variant="secondary"` on `Done` (it is the only primary). Order the buttons `Start`, `Done`, `Put back`, `Undo`; `Domain.taskActions` never offers Start and Put back together, so this yields `Start · Done`, `Done · Put back`, `Undo`. Rewrite the JSDoc above `can`: buttons follow `Domain.taskActions`; none is primary, because Polaris allows one primary per card and per page (`refs/shopify-docs/docs/apps/design/layout.md`, "Cards that offer interactivity") and two ready tasks would draw two; the badge carries the state and the buttons are its exits, advancing one first. Keep the existing sentence about a blocked undo drawing nothing.
3. **Task row shape.** `renderTask` no longer returns an `s-box` with its own border. It returns the inner `s-stack` content, and the caller wraps each step's tasks in one bordered `s-box` with an `s-divider` (or `borderWidth="base none none none"` on every task but the first, as the run list does in `renderRow`) between tasks. Pick the run list's approach so the two screens draw a rule the same way.
4. **Steps.** Replace the `s-section heading="Steps"` with one `s-section` per step (no heading, `accessibilityLabel={`Step ${step}`}`), or one `s-section accessibilityLabel="Steps"` with no heading holding a stack of step groups. Prefer the latter: one section keeps the page's spacing rhythm and e2e can still scope to `Steps`. Each group is a `s-text color="subdued"` caption `Step n` over the bordered box from step 3. Rewrite the comment above it: one caption and one box per step; parallel tasks share the box, separated by rules, so a step reads as one stop before the caption is read; a single-task step is a caption over one row.
5. **Note block.** Replace the `Note` section. Render it when `hasNote || canNote || orderNote present`. Inside: an inline stack with the prose on the left and `Edit` (secondary, only when `canNote`) on the right. The prose is `Prose{run.note}` when `hasNote`, otherwise `s-text color="subdued"` with the text `Note`. Below it, when `view.orderNote` is non-empty, `s-text color="subdued"` `From the order:` followed by `Prose{view.orderNote}`. Delete the `Order note` section. The button label is always `Edit`. Rewrite the comment: the note is the run's one text field, always present and possibly blank, so its one verb is Edit and the blank state is the field's name rather than a call to add; the order note is Shopify's and read-only, folded under the same block so the page has one place for prose about the run.
6. **Item.** Drop the badge row (`run.workflowName` badge, `ordered` age). Keep the Done / Cancelled badge: put it on the item line, after `RunItem`, or as the first element of the item stack. Remove the border: render `RunItem` inside a plain `s-section` (no heading) or an `s-box` without `borderWidth`. Confirm in the browser that `s-section` without a heading draws no card border; if it does, use `s-box padding="none"` inside the page instead. Rewrite the comment above: item first because what to make is why the page was opened; no workflow name or age because a member cannot act on either and the run list carries the age; no border because two bordered blocks on one page compete.
7. **Banners.** Move `FlagBanner` and the `actions.banner` critical banner out of the item stack to page level, directly after `<SocketBanner />`. Polaris places page-wide banners outside sections (`refs/shopify-docs/docs/api/admin-extensions/latest/web-components/feedback-and-status-indicators/banner.md`, "Position contextually"). Write a one-line comment saying so.
8. **Not-found branch.** Unchanged.

### Phase 2: JSDoc alignment

The rule in `AGENTS.md`: a behaviour more than one site agrees on is stated once on the symbol that is the concept, and other sites link it. Read each of these and rewrite or link; a stale description of the old layout is a defect.

- `src/components/MemberRun.tsx`, module JSDoc and `FlagBanner` JSDoc: still true (both screens, one banner, actions in the slot). Add nothing about placement; placement is the route's choice and the route's comment says it.
- `src/components/MemberRun.tsx`, `RunItem`: unchanged.
- `src/routes/shop.$shop.index.tsx`, `menuItems` JSDoc: says "Primary and secondary are a page's hierarchy, held in `s-page`'s action slots; a row has neither." This is now the rule for the work page's task rows too. Move that sentence to a `Domain.taskActions` JSDoc paragraph (the symbol both screens read their verbs from) stated normatively: the verbs a task offers are the same on the run list and the work page, and neither screen styles one as primary. Have both the list's `menuItems` comment and the work page's `can` comment `{@link Domain.taskActions}` for it instead of restating.
- `src/lib/Domain.ts`, `taskActions` JSDoc: add the paragraph above. Check the existing text for any claim about `Done` being the primary or about button order and correct it.
- `src/components/RunTextModals.tsx`, `RunNoteModal` JSDoc: check for "Add note" and change to Edit. The modal heading `Note` and submit `Save` stay.
- `src/styles.css`, the print block: the sentence "The member work page prints as a job ticket" stays; it is a print metaphor, not product vocabulary. The `s-button` rule still hides every button.
- `src/lib/useMemberRunActions.ts`: check any comment naming the page's layout or the `Add note` verb.
- `src/routes/shop.$shop.workflows.$runId.tsx`, the comment above `s-page`: unchanged (no breadcrumb).

Grep for the strings `Add note`, `waiting on step`, `Steps` heading, and `variant="primary"` under `src/routes/shop.$shop.workflows.$runId.tsx` and `src/components/` when done; every hit must be a merchant-page hit or a deliberate one with a comment saying why.

### Phase 3: tests

`e2e/member-runs.member.spec.ts`:

- Around line 1187, the doc comment and test that say "One Note section under the item, with one `Add note`": change to the new shape. The note block has one `Edit`; the task rows have none. Locate the note block by its accessibility label (`s-section[accessibilityLabel="Note"]`, keep the label). Assert the blank state shows `Note` in subdued text and `Edit`; after saving, assert the prose and that `Edit` is still the label. Remove every `getByRole("button", { name: "Add note" })` on this page.
- Around line 1205, `s-section[accessibilityLabel="Steps"]` and `Step 1` caption: still valid if phase 1 step 4 keeps the `Steps` label. Add an assertion that a parallel step's two tasks sit inside one bordered box (`s-box[borderWidth="base"]` containing both task names) and that a single-task step has one box with one row.
- Around line 1275, `waiting on step 1`: delete the assertion. Replace with an assertion that the waiting task's line is the team name alone and that it has no badge.
- Around line 1304, `s-banner[heading="Blocked"]`: still valid. Add that the banner is not inside the item section (for example, that it precedes the item title in DOM order).
- Any assertion that `Done` has `variant="primary"`: delete. Assert button order on a Ready task: `Start` then `Done`; on an In progress task: `Done` then `Put back`.
- `e2e/orders.spec.ts` line 459 `Add note`: merchant page, untouched.

Rule-titled tests per `AGENTS.md`: the button-order and no-primary rule and the waiting-line rule each get a test whose title is the rule, in the member spec.

Unit tests: `taskState` is not exported; if it is exported to test the waiting branch, keep it a plain function and add a `src/routes/*.test.ts` only if a test file convention exists for routes. Otherwise cover it in e2e.

### Phase 4: look at it

Use Chrome MCP or `pnpm playwright-cli` against local dev (`pnpm port`; wait for `data-app-interactive`, see memory). Open the seeded run page as a member at three states: a run with a parallel step and one task in progress; a blocked run; a done run. Take a screenshot at phone width and at 640px. Check: no card border around the item; the banner above the item; the blank note shows `Note` and `Edit` on one line; each step is one box; no black button anywhere; the waiting task shows only its team.

## Text

| Where               | Before                     | After                            |
| ------------------- | -------------------------- | -------------------------------- |
| Note button         | `Add note` / `Edit`        | `Edit`                           |
| Note, blank         | (nothing)                  | `Note` subdued                   |
| Order note          | section heading            | `From the order:` subdued prefix |
| Steps               | `Steps` heading            | (none)                           |
| Waiting task line   | `Team · waiting on step n` | `Team`                           |
| Workflow badge, age | shown                      | (removed)                        |

## Out of scope

- The merchant order page still says `Add note` in its Manage menu (`app.orders.$orderId.tsx`) and only offers it while the note is blank. Decision 4's "no Add" was taken for the member page. Leave the merchant page alone and record it under Issues if the mismatch bothers the implementer; it is a separate decision.
- Seed data (decision 14).
- `RunTextModals` behaviour.

## Deviations and issues

The implementing agent records here anything that departed from the plan, and anything found that the plan did not anticipate. One bullet each: what, why, and what was done instead. Leave the heading in place even if empty.

- `s-section` draws a card at page level with or without a heading, so the item, the note and the steps render as three cards. The item, note and steps are now plain `s-stack`s inside one `s-stack gap="base"`, with the step boxes the only borders (decisions 11 and 13). `s-box` and `s-stack` take no `accessibilityLabel`, so e2e reaches the steps by `s-stack[accessibilityRole="ordered-list"]` (each step is a `list-item`) and the note block by `s-stack#note`. The item section's label and the `Steps` / `Note` labels are gone.
- Without sections, `s-page` pads its children 0.5rem below a 507px viewport while its heading sits at 1.5rem, so the text sat 16px left of the heading on a phone. A `.member-work` wrapper div in `src/styles.css` adds `padding-inline: 1rem` below 507px. The breakpoint is `s-page`'s own, measured; it exposes no hook.
- The Done / Cancelled badge sits above the item line (first element of the item stack), not after it.
- On a cancelled run with a blank note and an order note, the block shows the order note alone: the `Note` placeholder and `Edit` render only while `canNote`, per decision 10.
- The seed fixture has no parallel step, so the member spec seeds its own (`#9404`, two Cut tasks in step 1, Pack's Polish in step 2) for the three rule-titled tests.
