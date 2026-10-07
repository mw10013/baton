# Plan: the screenshot script, the help parts and the For members pages

The next stage on the roadmap in `docs/help-research.md`. Four parts: the two help parts
(screenshot and steps), the picture inventory and the screenshot script for member pictures, the
four For members pages, and a look at the result. The member side goes first because it has no
order positions on it, so it does not wait on `docs/order-not-started-research.md`.

Merchant pictures (the admin capture: title bar clip, overlays, modals in the frame) are not in this
plan. The script is built so they slot in later: its entries carry a `kind`, and only `member` is
implemented here.

## Before you start

- Read `docs/help-research.md`: "Page anatomy, by type", "Tone and naming rules for help",
  "Screenshots" (the spec every picture follows), "Decisions" and "Roadmap". Read the showcase's
  "Teams, members, workflows" and "Orders" in `docs/showcase-shop-research.md`; the data is
  `e2e/showcaseFixture.ts`.
- Read `AGENTS.md`: the parts table on `ScreenPart` and the copy table on `CopySlot` in
  `src/lib/Screen.ts` are the spec; a new part gets a row, then the part, then a kit entry
  (`src/routes/dev.kit.tsx`); routes and other components lay out nothing.
- The help skeleton: `src/lib/helpPages.ts` (the tree), `src/components/help/bodies.tsx`
  (`HELP_BODIES`, empty today), `src/routes/help.$section.$page.tsx`, and the help parts already in
  `src/components/screen/` (`HelpList`, `FootLine`). `StepList` there is a run's workflow steps,
  not the help's numbered steps; do not reuse or rename it.
- The member screens: `src/routes/shop.$shop.workflows.index.tsx` (the list) and
  `src/routes/shop.$shop.workflows.$runId.tsx` (an item's page). Their labels come from
  `WorkflowsListState` and `VERB_LABEL` in `src/lib/domain/ShopWork.ts`.
- The member sign-in for scripts: `signIn` in `e2e/member.ts` (demo mode, "Open your magic link").
- The dev server runs for this checkout (`pnpm dev:status`). Do not run the whole e2e suite: it
  replaces the dev store's data. Do not commit.

## Phase 1: the two help parts

1. **Rows first**, in the parts table on `ScreenPart`, template `help`:
   - **screenshot**: one picture in a help page. Fixes the width by kind: a member picture at
     390 CSS px, centred; a merchant picture at the column's width (`s-image inlineSize="fill"`,
     `objectFit="contain"`, `aspectRatio` from the file). Never a caption, border or annotation; the
     alt text is required.
   - **numbered list** (`NumberedList`): a numbered list of what to do, one action per item, a
     control's label in bold. An ordered list because it is one.
2. **The parts** under `src/components/screen/`, using only the distances and breakpoint in
   `layout.ts`.
3. **Kit entries** on `/dev/kit`: the screenshot part with a member picture and a merchant-width
   placeholder, the numbered list with a long item that wraps.

## Phase 2: the picture inventory and the screenshot script

1. **The inventory** (decision 3): `src/lib/helpPictures.ts`, one entry per picture:
   `{ file, kind, alt }` keyed by a name, `file` under `public/assets/help/<section>/<page>-<n>.png`.
   The script reads it to know what to shoot; the bodies read it to place a picture, so a body
   cannot name a picture the inventory lacks.
2. **`scripts/help-screenshots.ts`**, run as `pnpm help:screenshots`. Playwright's library API, not
   `playwright-cli`; Chromium, headless, light theme. In order:
   1. Refuse to start unless `pnpm dev:status` is healthy.
   2. `pnpm showcase:store` (a no-op on a ready store), then `pnpm seed --showcase`.
   3. Sign in as `ana@example.com` at 390 × 844, device scale factor 2.
   4. Shoot the member pictures below, whole screen, top bar included.
   5. `pnpm seed`, so the store is back on the dev fixture, also when a shot failed.
   6. Print what it wrote.
3. **The member pictures**, seven. Each names the screen state; the implementer picks the showcase
   item that gives it and says which in the entry's comment.

| file                                | screen and state                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `members/finding-your-work-1.png`   | the list's default, Started by you, ana on Engraving and Finishing                    |
| `members/finding-your-work-2.png`   | the list with the Team select set to Engraving, Ready chosen                          |
| `members/recording-your-work-1.png` | an item's page with a Ready task on ana's team: Start, Done, instructions, properties |
| `members/recording-your-work-2.png` | an item ana started: Done and Put back                                                |
| `members/recording-your-work-3.png` | the same item after Done: the Undo                                                    |
| `members/blocking-1.png`            | the Block modal, a reason typed                                                       |
| `members/blocking-2.png`            | an item's page with the block banner (the showcase's board ana's team blocked)        |

The third picture changes state (Done); it is shot last of the Recording pictures, and step 5's
reseed puts it back. 4. **Commit the PNGs** with the change; they are what the pages show.

## Phase 3: the four pages

Each body is a component under `src/components/help/members/<page>.tsx`, registered in
`HELP_BODIES`. Two to four short sections a page; second person, present tense, a control's label
in bold, the screen's own words (the vocabulary's screen columns). The copy lint reads
`src/components/`, so the retired words are refused as in any screen.

1. **Signing in** (`signing-in`), prose, no pictures: no password; enter the email the merchant
   added; the link comes by email and signs you in; Your stores when you are on more than one
   shop; Sign out; the lapsed sentence (decision 15 in `docs/help-research.md`).
2. **Finding your work** (`finding-your-work`): the list's states (Started by you, Started by
   others, Ready, Blocked, and the done state) and what each holds; the Team select appears when
   you are on more than one team; search; one sentence on Show more ("The list shows 25 at a time;
   **Show more** loads the next 25."). Pictures 1 and 2.
3. **Recording your work** (`recording-your-work`): a numbered list for Start and Done; Put back; Undo, who
   may press it and for how long, as the item page's JSDoc on the verbs says; the instructions and
   the properties on the task. Pictures 1 to 3.
4. **Blocking an item and leaving a note** (`blocking`): a numbered list for Block with a reason; Unblock;
   Edit note; one sentence on what the merchant sees (decision 2) (the order shows in Issues as Blocked), linked
   to Fixing an issue. Pictures 1 and 2.

Every claim about behaviour is checked against the route or the domain symbol that enforces it, not
written from the research.

## Phase 4: tests

1. Integration: every inventory entry's file exists; every file under `public/assets/help/` is in
   the inventory; every entry is placed by some body (the bodies' references are typed keys, so the
   test reads them off the registered bodies or a list they export, whichever is simpler).
2. Integration: every alt text is 30 to 60 words (the spec's rule).
3. E2E, the `public` project only (`npm run test:e2e -- --project=public`): each For members page
   renders its body, and each of its pictures loads (`naturalWidth > 0`). Then `pnpm seed`.

## Phase 5: run it and look

1. `pnpm help:screenshots`; then twice more to confirm a rerun writes the same pictures (the same
   size; byte equality is not expected).
2. Open the four pages headless at 390 × 844 and at 1280 × 800 with `pnpm playwright-cli`; save the
   shots in the scratchpad.
3. Report: what each page shows, any picture that reads wrong (a name, a state, a cut-off control),
   any sentence the screen contradicts.

## Checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` after each phase; `pnpm fmt` repo-wide at the end.
- The e2e `public` project passes; the dev store ends on the dev fixture.
- `pnpm help:screenshots` run twice leaves the same files.

## Decisions

Reviewed 2026-10-07 in Plannotator.

1. **The numbered list part is `NumberedList`**, row "numbered list": a generic numbered list,
   named for its shape. Not "steps", because "step" is a workflow's step and `StepList` already
   draws those.
2. **Blocking shows no merchant picture**: one sentence and a link to Fixing an issue.
3. **The picture inventory is a typed module**, `src/lib/helpPictures.ts`, imported by the script
   and the bodies.
