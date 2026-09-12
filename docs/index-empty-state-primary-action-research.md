# Index pages: the primary action on an empty list

Research date: 2026-09-12. Scope: the three index pages (`/app/workflows`, `/app/teams`,
`/app/members`) hide their title-bar primary action while the list is empty and show
the same button inside the empty-state card instead. This doc says where that came
from, what the platform guidance is, and how to move forward. No application code
changed. A follow-up agent can pick this up cold.

## The situation

Screenshots taken 2026-09-12 on `sandbox-shop-01` show, on each empty index page:

- **No button in the title bar** next to the page heading.
- A card with two subdued sentences that say nearly the same thing (the intro line and
  the empty-state line), then a primary-styled **Create workflow** / **Create team** /
  **Add member** button inside the card.
- Once one row exists, the button appears in the title bar and the in-card one goes
  away.

The code is the same in all three routes:

```tsx
{
  workflows.length > 0 && createButton(true);
} // src/routes/app.workflows.index.tsx:283
{
  teams.length > 0 && createButton(true);
} // src/routes/app.teams.index.tsx:217
{
  members.length > 0 && addButton(true);
} // src/routes/app.members.tsx:349
```

where `createButton(slotted)` renders the same `s-button` with `slot="primary-action"`
when `slotted` is true and unslotted (inside the card) when false.

## Where it came from

- The workflows index got this shape in commit `b8e5780` ("the workflows list scans
  instead of asking"). The commit message explains why the create _form_ left the
  page (a modal, then the editor) but says nothing about hiding the title-bar button
  on empty. It reads as an unexamined choice, not a decision.
- `docs/teams-members-ux-research.md` (2026-09-12) told the implementing agent to
  "copy the Workflows pattern exactly", and named the line
  (`app.workflows.index.tsx:445-454` at the time). Teams and Members therefore
  inherited the conditional verbatim. Nobody chose it a second time either.

So the state of play is: one page did it without a stated reason, two pages copied it
by instruction. The e2e specs (`e2e/teams.spec.ts`, `e2e/members.spec.ts`,
`e2e/workflows.spec.ts`) drive the in-card button on empty and the hoisted title-bar
button afterwards, so they encode the current behaviour and will need a small change
whichever way this goes.

## What Shopify's guidance says

Source: `refs/shopify-docs/docs/api/app-home/latest/patterns/templates/resource-index.md`
and `.../patterns/compositions/empty-state.md` (App Home, Polaris web components).

The **resource index template** renders the title-bar primary action
**unconditionally**, outside both branches:

```tsx
<s-page heading="Puzzles">
  <s-button slot="primary-action" variant="primary">
    Create puzzle
  </s-button>
  {/* Empty state — only when no puzzles yet */}
  <s-section accessibilityLabel="Empty state section">
    ... <s-heading>Start creating puzzles</s-heading> ...
    <s-button-group>
      <s-button slot="secondary-actions">Learn more</s-button>
      <s-button slot="primary-action">Create puzzle</s-button>
    </s-button-group>
  </s-section>
  {/* Table — only when one or more puzzles */}
  ...
</s-page>
```

The **empty state composition** is centred content with a heading, one paragraph, and
a button group; it is explicitly _in addition to_ the page's primary action, not a
replacement for it. The **title-bar** doc says the primary action "appears prominently
on the right side of the title bar" and there should be one per page.

Two things follow:

1. Hiding the title-bar button on empty is a departure from the platform template.
   Merchants learn "the create button is top right" from every Shopify index page;
   ours moves it into the body for exactly the visit when they most need it.
2. Having the button in both places at once is what the template does. It is not a
   duplication bug; it is the pattern.

## Options

### A. Always show the title-bar primary action; keep an empty state in the card

The platform template. Drop the `length > 0 &&` guard on all three pages. The empty
state stays, but becomes the composition Shopify describes: a heading, one sentence,
and the button. The intro paragraph (the first subdued sentence in the card) goes away
on empty so the card does not say the same thing twice; it returns with the table.

- Cost: three one-line guard removals, copy edits in three routes, three e2e specs
  updated to click the hoisted button (they already know how: `clickHoisted`).
- Risk: none functional. Two visible create buttons on an empty page, which is what
  Shopify's own template ships.

### B. Always show the title-bar primary action; empty state is text only

Same guard removal, but the in-card button is removed and the empty state is a
sentence pointing up-right ("No teams yet. Create one to get started."). One button
on the page, always in the same place.

- Cost: as A, minus the in-card button; e2e specs click the hoisted button always.
- Risk: the empty card becomes a bare paragraph, which is what the pre-rework Teams
  and Members pages had and looked unfinished. Also departs from the template in the
  other direction (template keeps the in-card CTA).

### C. Keep as is, and write down why

Only defensible if there is a reason the title-bar button should be absent on empty.
None has been found in the commit history, the research doc, or the platform docs.
The one argument, "two buttons is redundant", is contradicted by Shopify's template.

## Recommendation

**Option A.** It is the platform's own template, it is the smallest change, and it
fixes the thing the screenshots make obvious: the merchant's first visit to each page
is the one where the title bar is empty. Do the copy trim at the same time so the empty
card carries a heading and one sentence rather than two near-identical paragraphs.

Not in scope: the illustration the template shows in its empty state. Text and a
button are enough for a three-row admin app; add an image later if the pages ever
get a visual pass.

## Implementation plan

For a follow-up agent. Read this whole doc first. Each step ends with `pnpm typecheck`,
`pnpm lint`, the named e2e spec green, and `pnpm fmt` run repo-wide with every touched
file kept. Do not commit.

### 1. Workflows index (`src/routes/app.workflows.index.tsx`)

- Change `{workflows.length > 0 && createButton(true)}` to `{createButton(true)}`.
- In `renderRows`, the `workflows.length === 0` branch becomes the empty-state
  composition: `s-grid`/`s-stack` centred, an `s-heading` "No item workflows yet",
  one `s-paragraph` (keep the existing sentence: "Each one is the ordered list of
  steps a line item passes through, each owned by a team. Each workflow has a tag;
  products carrying it follow that workflow."), then `createButton(false)`.
- The intro `s-box` above the search (the "Each one is the ordered list…" sentence)
  renders only when `workflows.length > 0`, so it is not repeated on empty.
- `e2e/workflows.spec.ts`: it seeds an existing workflow first, so it already clicks
  the hoisted button; no change expected. Run it to confirm.

### 2. Teams index (`src/routes/app.teams.index.tsx`)

- Same guard removal at the `{teams.length > 0 && createButton(true)}` line.
- Empty state: heading "No teams yet", paragraph "A team is who can work a step.
  Assign one to each step in a workflow.", then `createButton(false)`. Intro box
  only when `teams.length > 0`.
- `e2e/teams.spec.ts`: the first create currently clicks the in-frame button
  (`frame.getByRole("button", { name: "Create team" })`). With the title-bar button
  hoisted on empty too, that in-frame locator still resolves to the in-card one, so it
  keeps working; but the `EMPTY_STATE` constant is `"No teams yet."` and should become
  the new heading text. Run it.

### 3. Members index (`src/routes/app.members.tsx`)

- Same guard removal at the `{members.length > 0 && addButton(true)}` line.
- Empty state: heading "No members yet", paragraph "Add an email to grant access.
  Members sign in with it on the member area and see the work of their teams.", then
  `addButton(false)`. Intro box only when `members.length > 0`.
- `e2e/members.spec.ts`: `EMPTY_STATE` is the full current sentence; update it to the
  new heading. The first add clicks the in-frame button, which still resolves to the
  in-card one. Run it.

### 4. Verify

- `pnpm typecheck && pnpm lint && pnpm test`.
- `npm run test:e2e -- e2e/workflows.spec.ts e2e/teams.spec.ts e2e/members.spec.ts`.
- Manual or subagent-driven: with an empty shop (`seedMembers(config, [])` through
  `/api/dev/seed`, or `pnpm d1:reset`), open each of the three pages embedded and
  confirm a title-bar button top right plus the centred empty state, then create one
  row and confirm the table replaces the empty state and the intro sentence appears.
  Take screenshots with `pnpm playwright-cli --headed --session="$(pnpm port)-localdev"`.

### Files touched

| Area   | Files                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------- |
| Routes | `src/routes/app.workflows.index.tsx`, `src/routes/app.teams.index.tsx`, `src/routes/app.members.tsx` |
| Tests  | `e2e/workflows.spec.ts`, `e2e/teams.spec.ts`, `e2e/members.spec.ts`                                  |

## Decisions already made (do not reopen)

- **"Add member", not "Create member".** Confirmed 2026-09-12. A member is an email
  being granted access, not a thing being created; teams and workflows are created,
  members are added and removed.
