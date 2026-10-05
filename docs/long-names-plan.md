# Plan: one UI across screens, and long names

Written 2026-10-05 from the decisions in `docs/long-names-research.md`. It is for an agent that has
not seen that research. Read its Part 1 ("What drifts, and why", "First principles", "Proposal"),
Part 2 ("The rule") and the Decisions first. This plan does not repeat the reasoning. It says what
to change, in what order, and how to check it.

## Before you start

- Read `AGENTS.md`. The rules that matter most here:
  - A rule is stated once, normatively, in the JSDoc on the symbol that enforces it. Other sites
    `{@link}` it, and the rule has a test whose title is the rule.
  - JSDoc never cites `docs/`.
  - Use the vocabulary's words, and name screens by the Screens table's spec names.
  - Run `pnpm fmt` and keep everything it touches.
  - Do not commit unless told to.
- Start with `git merge --ff-only main` in the worktree.
- Look at what you build. Every part and every moved screen is rendered and screenshotted at 375px
  and 1280px before the phase is called done. Use `pnpm playwright-cli` headless, signed in through
  the demo magic link (`e2e/member.ts`, `signIn`), and seed with `pnpm seed` or `pnpm dev:reset`.
  `docs/long-names-research/proposed-mock.js` is the mock of the target row and can be injected
  into the live page for comparison.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm spec check` and `pnpm test` at the end of every phase,
  and the member e2e project (`npm run test:e2e -- --project=member`) at the end of phases 2 and 4.
- Record every departure from this plan, and every problem found, in
  [Deviations and issues](#deviations-and-issues) as you go.

## The decisions, as work

| decision                                              | lands in                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. parts table, lint rule, kit page                   | `src/lib/Screen.ts`, `scripts/lib/spec.ts`, `scripts/lib/rules-lint.ts`, a dev-only route     |
| 2. strict lint: no layout in `src/routes/`            | `scripts/lib/rules-lint.ts`, an allowlist that shrinks to empty by phase 5                    |
| 3. three distances, one breakpoint                    | constants in `src/components/screen/`                                                         |
| 4. `template` column on the Screens table             | `src/lib/Domain.ts`, `checkScreens` in `scripts/lib/rules-lint.ts`                            |
| 5. phasing                                            | this plan's five phases                                                                       |
| 6. workflow name only when it differs from the item   | `runRowLines` in `src/lib/domain/ShopWork.ts`                                                 |
| 7. order number leads line one                        | `itemPiece` / the row part                                                                    |
| 8. no cap on parallel tasks                           | unchanged behaviour; the kit page shows a 20-task step                                        |
| 9. modal headings name the order                      | copy table heading row on `CopySlot`, `RunTextModals.tsx`, the order page and workflow modals |
| 10. tag as wrapping text                              | `app.workflows.index.tsx`, `app.workflows.$workflowId.tsx`, `WorkflowTag.tsx`                 |
| 11. `overflow-wrap: anywhere` on the member area root | `src/styles.css`, the member layout (`shop.tsx` or `shop.$shop.tsx`)                          |
| 12. line one's weight                                 | the row part; decided on the kit page                                                         |

## Phase 1: the parts, the table, the kit page

### 1.1 `src/components/screen/`

Create the folder and these parts. Each part's JSDoc states its rule and the reasoning, and links
the parts table. A part takes content (children, strings, data) and never takes a spacing or layout
prop. Build each from Polaris primitives in the arrangement the composition docs use
(`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/resource-list.md`,
`index-table.md`, `metrics-card.md`).

- `layout.ts`: the three distances (`small-300`, `base`, `none`) and the one container breakpoint
  (480px). These are the only spacing values the parts use. Name the constants in the vocabulary's
  words. `scripts/rules-lint.ts` refuses some stems ("slot", "tier", ...), so check names against
  `RESERVED_STEMS`.
- `IndexSection`: the list frame. `s-section padding="none"` with an accessibility label. It holds
  the strip or search line, the filter row and the list in that order, with `base` between them.
- `Strip`: the metrics strip. It takes cells (label, count, chosen, onSelect) and lays them out by
  one column rule. Decide the rule in phase 1 on the kit page by rendering both screens' labels
  (orders index: five; workflows list: five) at 375px and 1280px, inside both page widths (the
  member page is `inlineSize="small"`). Write the rule and why on `Strip`. Both current JSDocs
  (orders index strip, workflows list `strip`) say opposite things. Theirs go, and they link
  `Strip`.
- `FilterRow`: main filter, search (`ListSearchField`, existing), optional secondary filter. Side by
  side above the breakpoint, stacked below. Replaces the orders index's 560px grid and the
  workflows list's 480px grid.
- `SearchLine`: "N match <q>" and Clear search, replacing the filters under a search (the controls
  table's "a search is on" row).
- `ResourceRow`: the member's row. Head (one line, or a clamp) and the menu side by side; the body
  below spans the full width. The menu cell is one line tall. The row is an `s-clickable` link,
  with the menu rendered beside the clickable as today (keep `insideRow` and its JSDoc; it moves
  here). It takes `head`, `body`, `menu` (items or null), `href`, `onNavigate` and
  `accessibilityLabel`.
- `ShowMore`: the deeper read button ("Show 25 more of N").
- `EmptyLine`: one sentence in the list's place.
- Text fits: `Name` (wraps; for capped names), `Clamp` (an `s-paragraph` or `s-heading` with
  `lineClamp`, default 2), `Token` (wraps anywhere). Move `Prose` and `ClampedProse` from
  `MemberRun.tsx` into the folder and keep their behaviour. Fixed words need no component: they are
  plain `s-text` placed after a `Name` or ahead of a `Clamp`, and the table row says so.

Move the shared components that are really parts (`ListSearchField`) under the folder, or leave
them where they are and name them on the table. Pick one, apply it to all of them, and record the
choice.

### 1.2 The parts table on `Screen.ts`

Add a third table to the JSDoc in `src/lib/Screen.ts`, beside the copy and controls tables, on a
new exported literal union of the part names (as `CopySlot` is for the copy table). Columns:

- `part`
- `job`
- `component`
- `fixes`: what the part decides, e.g. "frame, padding none" or "columns, breakpoint"
- `used on`: template names
- `never`

Then add the text-fits rows from the research's Part 2 rule: capped name, Shopify text, free text,
token, fixed words. They take the same columns, with `fixes` saying "on a list / on its home / in a
cutting control". Each row names its component.

Add an "order of work" sentence to the table's JSDoc: a shape change starts at the row, then the
part, then the kit page, then the screens.

### 1.3 `pnpm spec check`

In `scripts/lib/spec.ts`, beside `parseCopyTable`, add a parser for the parts table and call it
from `scripts/spec.ts check`:

- every literal of the union has exactly one row and every row is a literal;
- every `component` cell names a file that exists under `src/components/screen/` or a Polaris tag
  (`s-table`, `s-section`);
- every `used on` cell uses the template words only.

Update the long description string in `scripts/spec.ts` and the `pnpm spec check` line in
`AGENTS.md`.

### 1.4 The `template` column

Add `template` to the Screens table in `src/lib/Domain.ts`, with values `index`, `details`,
`homepage`, `editor` and the shop list as `index`. `checkScreens` in `scripts/lib/rules-lint.ts`
(or the Screens parser in `spec.ts`, wherever the table is parsed) refuses any other word. Map
each screen:

- index: orders index, workflows index, teams index, members page, workflows list, shop list;
- details: order page, merchant's workflow page, team page, member's workflow page;
- homepage: home page;
- editor: workflow editor;
- the lapsed page: `details`, or record a better fit as a deviation.

### 1.5 The lint rule, warning

In `scripts/lib/rules-lint.ts`, add a check over `src/routes/**/*.tsx`. It refuses the elements
`s-grid`, `s-stack`, `s-box` and `s-query-container`, and the attributes `gap`, `padding`,
`paddingBlock*`, `paddingInline*`, `gridTemplateColumns`, `className` and `style`.

- Give it a file allowlist that starts with every route that has a hit today. Print the hits as
  warnings, not failures, while a file is on the allowlist.
- A file not on the allowlist fails.
- Admin routes (`admin.*`) go on the allowlist for now.
- Export the hit function and test it like the other rules-lint checks (find their tests and follow
  their form). Test titles are the rule: "a route lays out nothing: layout primitives and layout
  props are refused outside src/components/screen/".

### 1.6 The kit page

Add a dev-only route that renders every part once with the seed's worst cases:

- a 255-character item title with a long variant and `×12`;
- 64-character task and workflow names and a 32-character team;
- a 1000-character block reason;
- a 60-character email in `Started by`;
- a 20-task parallel step;
- `#WEB-1000234-EU` as an order number;
- a 255-character unspaced tag.

Gate it as `api.dev.seed.ts` is gated: `ENVIRONMENT !== "local"` returns not found, here in a
`beforeLoad` through a server function. Name the route and its screen in the vocabulary. If it
needs a Screens row, it gets one with spec name "the kit page"; record the choice. The page
renders static data only and reads nothing from the object.

Render the merchant's parts too (the index table frame, `FilterRow`, `Strip`) at 1280px. Check
whether Polaris components render outside the embedded admin without App Bridge. They do on the
member side; record what you find.

Check on the kit page, with screenshots at 375px and 1280px:

- decision 12: `s-heading lineClamp={2}` inside `s-clickable` in the member area. Compute the
  rendered font weight (the research measured `s-text type="strong"` at 450). If it renders at
  heading weight, the row uses it. If not, upgrade `@shopify/polaris-types` (1.1.0 is published),
  confirm it types `fontWeight` on `s-text`, and use `s-text fontWeight="semibold"` inside a
  `Clamp`. Record which;
- the `Strip` column rule (1.1);
- every text-fit row at its worst case.

Save the final screenshots under `docs/long-names-research/` with names starting `kit-`.

## Phase 2: the workflows list and the member's workflow page

### 2.1 Domain

`src/lib/domain/ShopWork.ts`:

- `runRowLines`:
  - `recipe` becomes `{ workflow: string | null; step: string }`. `workflow` is null when the
    workflow name equals the item title, compared trimmed and ignoring case. That rule goes in the
    JSDoc, normatively, with the reason (the simple setup names the workflow after its product;
    the name is news only when it differs, as for Rush or an item in two workflows).
  - Update the JSDoc's "The recipe line" paragraph.
- `itemPiece`: line one is now `#1008 · Signet ring · Gold` plus `×n` kept outside the clamp. Either
  add the order number to `itemPiece`'s output or have the row prepend it. The order number is the
  row's, not the piece's, so prefer the row and keep `itemPiece` the piece. `itemTitle` (the
  accessible label) is unchanged.
- The `RowLine` JSDoc's "short fixed words (a state, the step, who did it)" is wrong about who did
  it. The new rule is on the text-fit rows; the old JSDoc goes with `RowLine`.

Tests (integration project, where `runRowLines` is tested today):

- "the workflow name is on the row only when it differs from the item title";
- the comparison ignores case and surrounding spaces.

### 2.2 The workflows list

`src/routes/shop.$shop.workflows.index.tsx`:

- Rebuild on `IndexSection`, `Strip`, `FilterRow`, `SearchLine`, `ResourceRow`, `ShowMore`,
  `EmptyLine` and the text fits. Remove `PieceLine`, `RowLine`, `Clip` and `Keep`. A search's open
  and Done or closed lists become two `IndexSection`s, not two bordered boxes in one card.
- Open row:
  - head: `#order · piece` in a `Clamp`, `×n` after it;
  - body: one `Name`-wrapped line per task, `Task (Team) · <state>`, with the task in body colour
    and the rest subdued;
  - the block reason in a two-line `Clamp`;
  - `[workflow · ]Step k of n`.
- Done row: head as open; body `Task · Done by <who> · <time>`, wrapping; note after it in a `Clamp`
  if kept.
- Closed row: head as open; body `ClosedLine`; the workflow name when it differs.
- Remove `.run-title-clip`, `.run-order`, `.run-line`, `.run-line-clip` and `.run-line-keep` from
  `src/styles.css`, with their comments.
- Remove the route's `s-grid`, `s-stack` and `s-box` uses until the lint check passes for this file.
  Take it off the allowlist.

### 2.3 The member area root

Decision 11: `overflow-wrap: anywhere` on the member area's root element. Put it in `src/styles.css`
with a comment saying why (unspaced tokens in headings and bare text; the research's Part 2 token
row). Apply it on the member layout's root. Check that it does not break `s-table` or the strip's
labels at 375px.

### 2.4 The member's workflow page and its components

- `shop.$shop.workflows.$runId.tsx`, `MemberRun.tsx`, `RunSteps.tsx`: rebuild on the parts and
  text fits, and take the route off the allowlist.
- Fix the bugs from the research's Elsewhere table that live here:
  - task instructions in `RunSteps` become `Prose`;
  - `RunItem`'s SKU and property key are tokens;
  - the property key column becomes `minmax(0, max-content)` inside the part.
- Decision 9 for the member's modals (`RunTextModals.tsx`, the Block modal): heading
  `Block #1008?`, body's first line the item in a two-line `Clamp`.

### 2.5 Copy table

Decision 9 changes the heading row's form on `CopySlot`: "a noun phrase, or a question ending in
"?" that names the thing" names the order rather than the item. Update its form cell and keep its
example shown on a screen (`pnpm spec check` refuses an example no screen shows).

### 2.6 Tests

`e2e/member-runs.member.spec.ts`: update the row tests whose expectations change:

- "line one shows the variant title": line one now leads with the order number;
- "a parallel row has a line per task, each with its own state": lines now wrap rather than clip.

Add:

- "a 64-character task name is shown whole on the workflows list" (seed `#1030`);
- "a block reason shows two lines on the workflows list" (`#1026`);
- "an email in Started by does not widen the row". Assert the row's scroll width equals its client
  width. Seed a long member email if no fixture has one, and record it;
- "the workflow name is printed only when it differs from the item title".

Screenshot the Blocked, Ready and search (`#1030`) states at 375px and 1280px, compare them with
`proposed-375.png`, and save them as `docs/long-names-research/phase2-*.png`.

## Phase 3: the merchant's indexes

Orders index, workflows index, teams index, members page:

- Each uses `IndexSection`, `FilterRow`, `SearchLine`, `EmptyLine`, and `Strip` where it has one
  (orders index).
- Rows stay `s-table`.
- Decision 10: the workflows index's tag column prints the tag as a `Token`, not an `s-badge`.
- Emails in the members page and team page cells are tokens. Drop the team page's
  `overflow="hidden"` box if the `Token` makes it unnecessary, and record it.
- Take each route off the allowlist as it passes.
- Run the merchant e2e projects. Screenshot each index inside the embedded admin at the admin's
  width.

## Phase 4: the details pages and the workflow editor

Order page, merchant's workflow page, team page, home page, workflow editor:

- Each route's one-off layout becomes a part used once, under `src/components/screen/`, with a
  parts-table row. Name each in the vocabulary.
- `app.orders.$orderId.tsx` and the workflow editor are the largest. Split them by section, not by
  line count.
- Bugs from Elsewhere:
  - the order note becomes `Prose`;
  - task instructions in `WorkflowSteps` become `Prose`;
  - `itemTriggerLine`'s tag is a token;
  - the stale "64-character team name" in the JSDoc on `nowLine` becomes 32, or the sentence goes
    with the move.
- Decision 9 for the merchant's modals: Cancel, Delete, Turn on, Assign team. Headings name the
  order or the workflow as the copy table now says, and the item goes in the body. Check each
  against the updated heading row. A heading that names a capped workflow name (`Turn on <name>?`)
  may keep it, because capped names wrap. Record each call.
- Decision 10: the merchant's workflow page shows the tag as a `Token`. The title-bar badge and
  `WorkflowTag`'s chip go; `WorkflowTag` keeps its Edit flow.
- Decision 12 follow-up: every remaining `type="strong"` in `src/` either becomes the chosen
  weight or stays `type="strong"` with a one-line comment saying it wants only the semantic
  `<strong>`.

## Phase 5: the lint rule refuses

- The allowlist is empty except admin routes, if they are still on it. Either move the admin pages
  onto the parts (`.admin-field` becomes a `Token`) or keep them allowlisted with the reason on the
  allowlist's JSDoc. Record which.
- Switch the check from warning to failure.
- `AGENTS.md`:
  - add a bullet beside the copy-table bullet: the parts table on `Screen.ts` is the spec for
    shape; routes compose parts and lay out nothing; a shape change starts at the row, then the
    part, then the kit page, then the screens;
  - add `src/components/screen/` and the kit page to the Project section;
  - update the `pnpm spec check` and `pnpm lint` lines.
- `node scripts/copy-audit.ts` still runs. If the parts move copy around, check that it still finds
  every string.

## Deviations and issues

Record here, as you go:

- every place the implementation departs from this plan or from the research's decisions;
- every problem found, whether solved or left open.

One entry each: what, why, and what was done or is left for the user. Leave a subsection with "None"
rather than deleting it. An issue that needs the user's decision says so in bold.

### Deviations

1. **The kit page is `src/routes/dev.kit.tsx` at `/dev/kit`, with no Screens row.** It is not a
   merchant or member screen (`checkScreens` covers `app.*` and `shop.*`), so it is named "the kit
   page" on the parts table's JSDoc instead. `?width=large` renders it in the merchant's page width;
   the default is the member's. `scripts/lib/copy-files.ts` leaves `dev.*` out of screen copy, so
   the kit's worst-case strings are not checked as copy and cannot satisfy a copy-table example.
2. **Only `ListSearchField` moved into `src/components/screen/`.** It is the one shared component
   that is a part. The others (`MemberRun`, `RunSteps`, `WorkflowSteps`, `WorkflowTag`, ...) are
   content components; they stay where they are and are rebuilt on parts as their screens move.
3. **More parts than the plan listed.** The table gained `search field` (`ListSearchField`),
   `member area` (`MemberArea`, decision 11 needed a part because the member layout is a route),
   `page body`, `lines`, `inline row`, `framed list`, `step list` and `pairs`: the member's workflow
   page could not be built from the list parts alone.
4. **The filter row is never in `s-table`'s `filters` slot.** It always sits in the index
   section's head. The slot pads itself by half the card's padding, so the orders index had to
   correct the distance with a box; one place for the row removes the correction.
5. **`Clamp` has no `lines` prop** (always two), and `ClampedProse` lost its `lines` prop (always
   three, its one use). A clamp depth nobody can pass is one nobody can pass differently.
6. **Decision 12 resolved to `s-heading lineClamp={2}`.** Inside `s-clickable` in the member area
   it computes to font-weight 600 (`s-text type="strong"` computes to 450), so no
   `@shopify/polaris-types` upgrade was needed. `ResourceRow` takes a structured head
   (`{ lead, title, trail }`) so line one's shape lives in the part. The order number renders
   inside the heading, subdued, so it carries the heading's weight too; the mock had it at regular
   weight.
7. **The strip's column rule:** one column per cell when its container is wider than 480px, three
   below, each cell filling its track with the count at its foot. On the member page (under 600px
   wide at every viewport) that is five cells from about 560px of viewport up, where "Started by
   others" wraps to two lines and the counts still share a baseline. The workflows list's old
   "always three" argument went with the foot alignment that answers it.
8. **`EmptyLine` drops the merchant's `large-400` block padding**, a fourth distance. It is
   centred, `base` padded, at most 450px wide, on both sides.
9. **Row spacing changed.** Lines in a row are `small-300` apart (were `small-500`), a row is padded
   `small-300` block and `base` inline (was `small-100 base`), and every row has the rule above it,
   as in Shopify's resource-list composition.
10. **`.member-prose` is now `.prose`**, `.member-work` is `.page-body`: both are used by parts on
    either side.
11. **The lint rule refuses a stale allowlist entry**: a listed route with no hit fails, so the
    list only shrinks.
12. **A done row shows `Task · Done by <who> · <time>`** (was `... at <time>`), the note in a
    two-line clamp, and the workflow name only when it differs from the item, as on an open row.
    The plan did not say whether a done row keeps the workflow line; it keeps it under decision 6.
13. **Under a search, the Done or closed matches' section is headed "Done or closed"** (an
    `s-heading` in its head), so the second card says what it holds.
14. **The e2e long-name tests use a spec-local fixture** in `member-runs.member.spec.ts` (a
    60-character member email as the seed's first member, a 64-character task, a long block
    reason, a workflow named after its item in other case), not the dev seed's `#1026` and
    `#1030`, because the e2e seed replaces the shop's data.
15. **The teams index and the members page keep their live, client-side `s-search-field`** rather
    than `ListSearchField`, which submits on Enter and blur against a server read. Their "Showing N
    of M" line became the `SearchLine` ("2 teams match x" and Clear search), so the controls
    table's "a search is on" row now holds on every index. The search field sits in a `FilterRow`
    of its own.
16. **Merchant empty states are `EmptyLine`.** "No order matches #9999" is now the sentence, not a
    heading (`e2e/orders.spec.ts` reads it by text). The first-use states keep their heading
    ("No open orders", "No workflows yet", ...).
17. **More parts for the details pages and the editor**: `things`, `fields`, `panel` (card, drawer,
    draft), `select row`, `tiles`, `meter tile`, `table frame`, `end`, `empty aside`. Several are
    used once (the meter tile, the empty aside), as decision 2 asks. The home page's
    `CapacityTile` moved out of its route into `MeterTile` with its JSDoc. Generic stacks became
    `Lines` (the lines of one thing, `small-300`), `Things` (`base`) and `Inline`; the old
    `small-500`, `small-200` and `small-100` gaps collapsed into `small-300`, and the old
    `large-400` block padding is gone.
18. **The order page's Assign team row is a `Lines` stack**: the task's sentence over a
    `SelectRow`, where it was one inline row. The Assign team select is at most 20rem (was 16rem),
    the same as the Workflow select.
19. **Decision 9 on the merchant's modals:**
    - Cancel workflow: heading `Cancel <workflow>?` (a capped name, wraps), the item in a two-line
      `Clamp` as the body's first line, then the warning. Its toast is `<workflow> cancelled`: a
      toast cuts, and an item title is Shopify text that never goes in a cutting control.
    - Delete `<workflow>?`, Delete `<team>?` and Turn on `<workflow>?` keep their names: capped
      names wrap.
    - Assign team keeps `Assign team: <task>`: a capped name.
    - The members page's Edit teams modal was left as `Teams for <email>`, a token in a heading,
      because the plan did not name it. Changed in review (2026-10-05): headed `Teams`, the email
      as a `Token` in the body's first line. An email is uncapped and a modal heading is a cutting
      control, which the token row allows only the order number; an exemption for one heading
      would be a rule for one screen. `e2e/members.spec.ts` reads the email in the modal's body.
20. **Decision 12 follow-up**, each remaining `type="strong"`: task names on `RunSteps` and
    `WorkflowSteps`, the Manage drawer's workflow line, the editor's add-form title and the
    workflow page's Tag card title became `s-heading`; the member's workflow page's variant and
    quantity line, `MemberBar`'s shop, the login wordmark and the order page's "assign a team"
    sentence stay `type="strong"` with a comment saying they want only the semantic `<strong>`.
21. **The admin pages moved onto the parts** (`IndexSection` around their tables, `Tiles`,
    `Lines` and `Token` in the shop page's fields). `.admin-field` is gone; its fields wrap as
    tokens. So the lint rule needed no allowlist at the end, and **the allowlist and its warning
    mode were removed** rather than left empty: every hit fails.
22. **The lint rule covers `src/routes/` only**, as planned. Components outside
    `src/components/screen/` that were touched (`MemberRun`, `RunSteps`, `RunTextModals`,
    `WorkflowSteps`, `WorkflowTag`) now use parts; the others (`MemberBar`, `UsedByCard`,
    `WorkflowSwitch`, `MemberTeamsFields`, `QuotaBanners`, `DefaultErrorComponent`) still lay
    out with Polaris primitives. **Whether the rule should extend to `src/components/` is the
    user's call.** Decided and done: see [Follow-up](#follow-up-the-three-open-decisions), F2.
23. **The old row CSS was left in `src/styles.css`** (`.run-title-clip`, `.run-order`,
    `.run-line`, `.run-line-clip`, `.run-line-keep` and their comments, which phase 2.2 said to
    remove), with no user. Removed in review (2026-10-05), along with a comment for
    `.resource-row-menu` that had been left three rules away from it.

Reviewed 2026-10-05: deviation 6 (the order number at the heading's weight, where the mock had
it regular) is accepted as is. The subdued colour already sets the lead apart, and a regular
lead inside an `s-heading` would need a span fighting the heading's weight for a difference
nobody reads.

### Issues

Known before starting. Resolve each, or record what happened:

1. **Decision 12 is conditional.** `s-heading lineClamp={2}` inside `s-clickable` has not been
   rendered in the member area. Its weight decides between it and the `fontWeight` route, which
   needs a `@shopify/polaris-types` upgrade whose contents are unverified.
2. **The strip's column rule is undecided.** The orders index (five then three) and the workflows
   list (always three) disagree. Phase 1 decides it on the kit page. If neither works on both
   screens, that needs the user.
3. **Polaris outside the embedded admin.** The kit page renders merchant parts outside App Bridge.
   Some components (`s-table` pagination, title-bar hoisting) may behave differently there.
4. **A strict lint rule and the details pages.** Some one-off layouts may not split cleanly into
   parts used once. If a part ends up taking layout props to fit one screen, that defeats the rule.
   Record it rather than adding the prop.
5. **`overflow-wrap: anywhere` on the root** could break words in places that should not break (a
   badge, a number in the strip). Check at 375px and narrow it to the text fits if it does.
6. **No email length fixture.** The e2e test for a long email needs a member whose address is long.
   Adding one to `e2e/fixture.ts` may raise the seeded member count past `membersIncluded` (three).
   The fixture's JSDoc says why that matters. Use a spec-local member (`seedMembers`) instead.
7. **The order name's real length** is not verified against Shopify's prefix and suffix limits. The
   plan treats it as a token that wraps, which is safe at any length.

Add new issues below as they are found, numbered on.

Resolved:

- 1: see deviation 6.
- 2: see deviation 7; one rule works on both screens.
- 3: Polaris renders outside App Bridge on the kit page: `s-table`, `s-section`, `s-select`,
  `s-search-field` and `s-clickable` all render and lay out as in the admin. Pagination and
  title-bar hoisting were not exercised (the kit renders neither).
- 4: no one-off layout needed a layout prop on its part. Where a shape varied by kind it got a
  content variant (`Panel`'s `kind`) or an optional part of its content (`SelectRow`'s `label`),
  never a spacing value.
- 5: `overflow-wrap: anywhere` on the member root breaks nothing at 375px: the strip's labels
  wrap at spaces as before (`phase2-*.png`), and the member area has no badge text long enough to
  break.
- 6: see deviation 14.
- 7: the order number is printed as a token everywhere it appears, so any length wraps.

8. **The member's workflow page heading is cut to one line by `s-page`.** At 375px a long item
   title ends in an ellipsis in the page heading (`phase2-workflow-page-375.png`), so the page the
   research names as the title's home does not print it whole. Polaris truncates `s-page heading`
   itself; nothing in Baton clips it. **Needs the user's decision:** print the whole title in the
   page body under the heading (it would repeat the heading's start), or accept the cut.
   Decided and done: see [Follow-up](#follow-up-the-three-open-decisions), F1.
9. **The e2e seed replaces the dev shop's data.** After `npm run test:e2e`, `lead@m.com` is gone
   until `pnpm seed`. Not new, but every screenshot pass after an e2e run needs the reseed.
10. **The order page's "Every item is done" banner touches the first item card**
    (`phase4-order-page.png`). The banners sit in a `Things` stack in `s-page`'s main column, as
    they sat in an `s-stack` before, and `s-page` puts no gap between that stack and the next
    section. Not introduced here; left for a part that owns a page's banners. Decided and done:
    see [Follow-up](#follow-up-the-three-open-decisions), F3.

Screenshots: `kit-*.png` (phase 1), `phase2-*.png` (the workflows list and the member's workflow
page, signed in as `lead@m.com`), `phase4-*.png` (every merchant screen inside the embedded admin
at 1440px).

## Follow-up: the three open decisions

Written 2026-10-05, after the five phases above. The implementation left three items for the
user (issue 8, deviation 22, issue 10). For each, Claude recommended an option; the user accepted
all three recommendations and asked for them to be implemented. This section records, for a
later review, what each question was, what was decided and why, what changed, and how it was
checked.

### F1. The member's workflow page heading

**Question** (issue 8). `s-page` cuts its `heading` to one line with an ellipsis. The member's
workflow page was headed by the item title, which is Shopify text of up to 255 characters, so the
page the research names as the title's home did not print it whole.

**Options considered.**

1. Head the page with the order number and print the whole item title at the top of the body.
2. Keep the item as the heading and print the whole title again under it.
3. Accept the cut: the row's accessible label and the order page show the title whole.

**Decision: option 1.** Option 2 prints the start of the title twice, a stride apart, which reads
as a bug. Option 1 shows the title whole with no repeat, and it matches the rest of the work: the
order page is headed by its order number, decision 9 makes modal headings name the order, and
every row's line one leads with the order number. An order number is short in practice, so the
cut never bites it.

**Implemented.**

- `src/routes/shop.$shop.workflows.$runId.tsx`: `s-page heading={run.orderName}`. The body opens
  with a `Lines` part holding `s-heading` (the whole `run.lineItemTitle`, wrapping, no clamp) over
  the subdued `<workflow> workflow` line, which no longer carries `· #order` because the heading
  says it. The JSDoc at the `s-page` says why. The document title is now
  `<order> · <item title> — Baton`.
- `src/lib/Domain.ts`: the Screens table's heading cell for the member's workflow page changed
  from "the item's title" to "the order's name".
- `e2e/member-runs.member.spec.ts`: every `s-page[heading="<item>"]` lookup became
  `s-page[heading="<order>"]`. The long-name fixture's item title is now exactly 255 characters
  (`TITLE_255`), and a new test, "the member's workflow page is headed by the order and prints the
  item title whole", checks that the page heading is the order, the body heading is the whole
  title, and nothing clips it inside its shadow root.

**Checked.** Member e2e project 41/41.

### F2. The layout lint rule's scope

**Question** (deviation 22). The rule refused layout only in `src/routes/`. Six shared components
outside `src/components/screen/` still laid out with Polaris primitives, and nothing stopped a
route from moving its layout into a component beside it.

**Options considered.** Extend the rule to every `.tsx` under `src/components/` except
`src/components/screen/`, with no allowlist; or leave it on routes only.

**Decision: extend it, no allowlist.** With routes only, the easy way around the rule is a
component, and that is where drift would go next. The cost was small: about six components, most
of them simple stacks that already had a matching part.

**Implemented.**

- `scripts/lib/rules-lint.ts`: `routeLayoutHits` was renamed `layoutHits`, and its JSDoc now states
  the rule for routes and components: "Layout primitives and layout props are refused outside
  src/components/screen/". `scripts/rules-lint.ts` scans `src/routes/` and `src/components/`
  (less `screen/`) and fails on any hit. The test's describe title is now the rule's title.
- New parts, each with a row on the parts table (`ScreenPart` in `src/lib/Screen.ts`):
  - `TopBar` (top bar): the member bar's layout, its link home and its classes. `MemberBar` keeps
    the sign-out logic and passes the session end (email as a `Token`, Sign out).
  - `BatonMark` (mark): moved from `src/components/` into the folder; its inline `style` became the
    `.baton-mark` class in `styles.css`.
  - `SelectableCard` (selectable card): the editor's choosable task card, from `WorkflowSteps`.
    Its unselected border is now `base subdued solid`, the card `Panel`'s, so a card does not
    change border when the editor makes it choosable (it was `base base solid`).
  - `Connector` (connector): the arrow between stops of a step flow, from `WorkflowSteps`.
  - `CodeBlock` (code block): the error page's stack trace, from `DefaultErrorComponent`; its
    `pre` style became the `.code-block` class, which also lets a long line scroll inside the box.
- Components rebuilt on existing parts: `PlanCache` (`Inline`), `UsedByCard` (`Lines` of
  `Inline`), `WorkflowSwitch` (`Things` in the Turn on modal), `WorkflowSteps` (`Lines` for the
  step flow). `MemberBar`'s JSDoc keeps its "why" and links `TopBar` for the "how".
- `src/components/screen/layout.ts`, the parts table's intro in `Screen.ts` and `AGENTS.md` now
  say routes and the other components lay out nothing; the `pnpm lint` line in `AGENTS.md` says
  "no layout outside src/components/screen/".

**Checked.** `pnpm lint` (oxlint, rules-lint, spec check), `pnpm typecheck`, `pnpm test`, member
and merchant e2e projects (results below).

### F3. The order page's banner flush against the first card

**Question** (issue 10). The "Every item is done" banner touched the first item card.

**Options considered.** Take the banners out of their wrapping stack so they are direct children
of `s-page`, as on the workflows index, where the gap was right; or add a part that owns a page's
banners.

**Decision: unwrap first, a part only if that did not work.** The workflows index showed that
`s-page` spaces its direct children; the extra stack was the cause.

**Implemented.** `src/routes/app.orders.$orderId.tsx`: the two banners are direct children of
`s-page`, with the existing comment moved above them and a sentence saying why they are not
wrapped. No new part.

**Checked.** `followup-order-page-banner.png` (embedded admin, 1440px): a 16px gap between the
banner and the first card.

### Follow-up results

All on 2026-10-05, after the three changes together:

- `pnpm typecheck`, `pnpm lint` (oxlint, `scripts/rules-lint.ts` with the wider rule, and
  `pnpm spec check` with the five new part rows): clean.
- `pnpm test`: 36 files, 751 tests passed.
- `npm run test:e2e` projects `member` and `e2e` together: 74 passed. This includes the new F1
  test.
- `pnpm seed` afterwards, because the e2e seed replaces the dev shop's data (issue 9).
- Screenshots in `docs/long-names-research/`:
  - `followup-workflow-page-375.png` and `followup-workflow-page-1280.png`: the member's workflow
    page headed `#1026`, with the item title whole under it (F1).
  - `followup-workflows-list-375.png`: the workflows list with `MemberBar` on the `TopBar` part
    (F2).
  - `followup-order-page-banner.png`: the order page's banner with its gap (F3).

Nothing from the three items is left open. Issues 8 and 10 and deviation 22 above point here.
