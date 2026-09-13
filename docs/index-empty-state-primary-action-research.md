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
} // src/routes/app.workflows.index.tsx:303
{
  teams.length > 0 && createButton(true);
} // src/routes/app.teams.index.tsx:217
{
  members.length > 0 && addButton(true);
} // src/routes/app.members.tsx:349
```

where `createButton(slotted)` renders the same `s-button` with `slot="primary-action"`
when `slotted` is true and unslotted (inside the card) when false.

The intro `s-box` above the search is _not_ guarded on any of the three pages, which
is why the empty card says the same thing twice: the intro paragraph and the
empty-state paragraph both explain what the resource is.

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

Two hazards that apply to all three pages:

- **Do not copy Shopify's `slot="primary-action"` onto the in-card button.** In the
  composition that slot belongs to the enclosing `s-button-group`, not the page. On a
  direct `s-page` descendant App Bridge hoists it into the title bar, which would give
  two title-bar buttons and no button in the card. Keep `createButton(false)`
  unslotted, exactly as it is today.
- **Playwright frame vs page scoping is what keeps the specs unambiguous.** App Bridge
  lifts the slotted button out of the iframe into the admin document, so a
  `frame.getByRole("button", { name: "Create team" })` sees only the in-card one and a
  `page.getByRole(...)` (via `clickHoisted`) sees only the hoisted one. Two visible
  buttons with the same name therefore do not trip strict mode — but this is an
  observation about App Bridge's DOM, not a guarantee, so watch for a strict-mode
  failure when the specs run.

### 1. Workflows index (`src/routes/app.workflows.index.tsx`)

- Change `{workflows.length > 0 && createButton(true)}` to `{createButton(true)}`
  (line 303).
- In `renderRows`, the `workflows.length === 0` branch becomes the empty-state
  composition: centred `s-grid`/`s-stack`, an `s-heading` "No item workflows yet",
  one `s-paragraph` carrying the rest of the existing sentence ("Each one is the
  ordered list of steps a line item passes through, each owned by a team. Each
  workflow has a tag; products carrying it follow that workflow."), then
  `createButton(false)`.
- Guard the intro `s-box` above the search with `workflows.length > 0`. Its sentence
  is a different one ("…chosen by its tag. Turn one off to stop new runs while open
  runs finish.") from the empty-state sentence, so nothing is lost either way.
- `e2e/workflows.spec.ts`: it seeds an existing workflow (`EXISTING`) before the
  first create, so it already clicks the hoisted button; no change expected. Run it
  to confirm.

### 2. Teams index (`src/routes/app.teams.index.tsx`)

- Same guard removal at the `{teams.length > 0 && createButton(true)}` line (217).
- Empty state: heading "No teams yet", paragraph carrying the rest of the existing
  sentence ("A team is who can work a step; assign one to each step in a workflow."),
  then `createButton(false)`. Guard the intro box with `teams.length > 0` — its copy
  is "Teams are who can work a step. Assign a team to each step in a workflow.",
  which is the same thing said twice on empty.
- `e2e/teams.spec.ts`: the first create clicks the in-frame button
  (`frame.getByRole("button", { name: "Create team" })`, line 58) and keeps working
  per the scoping note above. The `EMPTY_STATE` constant is `"No teams yet."` and
  must lose its full stop to match the heading. Run it.

### 3. Members index (`src/routes/app.members.tsx`)

- Same guard removal at the `{members.length > 0 && addButton(true)}` line (349).
- Empty state: heading "No members yet", paragraph "Add an email to grant access.
  Members sign in with it on the member area; put each one on a team, or they have
  nothing to do." — the second sentence is lifted from the intro box, which is
  guarded away on empty. Then `addButton(false)`.
- `e2e/members.spec.ts`: `EMPTY_STATE` is the full current sentence
  (`"No members yet. Add an email to grant access."`); `getByText` does not match
  across elements, so once the copy splits into a heading and a paragraph it must
  become just `"No members yet"`. The first add clicks the in-frame button
  (line 44). Run it.

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

## Outcome (2026-09-12)

Option A is implemented on all three pages. What the verification actually showed, on
an empty shop (`.wrangler` cleared, `pnpm d1:reset`, no seed):

- Each page renders the title-bar primary action top right _and_ a centred empty state
  with an `s-heading`, one `s-paragraph`, and the same button. The intro paragraph is
  gone on empty, so the card no longer says the same thing twice.
- The App Bridge hoist puts the title-bar button in the admin document as a **sibling
  of the app iframe**, confirmed in the accessibility tree. That is what keeps
  Playwright's frame-scoped and page-scoped locators disjoint, and
  `e2e/teams.spec.ts` + `e2e/members.spec.ts` pass unchanged apart from their
  `EMPTY_STATE` constants — no strict-mode ambiguity from the two same-named buttons.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (241 tests) all green; `pnpm fmt` run
  repo-wide.

Unrelated pre-existing failure, present on `d6167a5` with these changes stashed:
`e2e/workflows.spec.ts` tests 1 and 3 fail with `strict mode violation:
locator('iframe[src*="embedded=1"]') resolved to 2 elements`. The `s-app-window`
editor adds a second embedded iframe, which `appFrame` in `e2e/app.ts` does not
disambiguate. Not caused by this work; needs its own fix.

## Decisions already made (do not reopen)

- **"Add member", not "Create member".** Confirmed 2026-09-12. A member is an email
  being granted access, not a thing being created; teams and workflows are created,
  members are added and removed.
