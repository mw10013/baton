# Plan: merchant pictures and the Getting started pages

The next stage on the roadmap in `docs/help-research.md`, written 2026-10-07 after 1d7400e. Two
stages in one plan: the `merchant` picture kind in the screenshot script (the admin's title bar and
the app frame, modals, the editor window), and the five Getting started pages. They go together
because a picture must be placed by a body (the integration test holds that), and Getting started
is the section that exercises every capture shape once: a whole page, a modal in the app frame, the
editor window, a modal in the editor frame.

The plan was not reviewed before implementation; its decisions are at the end, and the review
comes after, on the Deviations section.

## Before you start

- Read `docs/help-research.md`: "Page anatomy, by type", "Tone and naming rules for help",
  "Screenshots" (the spec every picture follows, merchant column), "Decisions", "Roadmap".
  Read `docs/help-members-plan.md` whole: this plan has the same shape and builds on its parts,
  inventory and script. Read "Capture" and "What the pictures need" in
  `docs/showcase-shop-research.md`.
- The code this extends: `scripts/help-screenshots.ts`, `src/lib/helpPictures.ts`,
  `src/components/screen/HelpPicture.tsx`, `src/components/screen/NumberedList.tsx`,
  `src/components/help/bodies.tsx`, the four bodies under `src/components/help/members/`,
  `test/integration/help-pages.test.ts`, `e2e/help.public.spec.ts`.
- The admin drivers the script reuses, in `e2e/app.ts`: `gotoApp`, `appFrame`, `editorFrame`,
  `closeDevConsole`, `clickHoisted`, `hoistedEnabled`; `awaitHydration` and `awaitNavigated` in
  `e2e/hydration.ts`; `previewUrl` in `e2e/devStore.ts`; `storageStatePath` in
  `playwright.config.ts`; `adminSessionFresh`, `refreshShopifyAuth` and `CHROME_PROFILE` in
  `scripts/lib/shopify-playwright-auth.ts`, used as `e2e/shopify-admin.setup.ts` uses them.
  Importing `e2e/app.ts` loads `playwright.config.ts`, which reads `.env`; the script already
  runs under `--env-file=.env`. `expect` from `@playwright/test` works outside the runner with a
  5 s default; call `expect.configure({ timeout: 10_000 })` once in the script.
- The merchant screens the pages describe, and the labels on them, are in the routes:
  `src/routes/app.index.tsx`, `app.workflows.index.tsx`, `app.workflows.$workflowId.tsx`,
  `app.workflows.$workflowId_.edit.tsx`, `app.teams.index.tsx`, `app.teams.$teamId.tsx`,
  `app.members.index.tsx`, `app.members.$memberId.tsx`, `app.orders.index.tsx`,
  `app.orders.$orderId.tsx`; the words in `src/lib/domain/ShopWork.ts` and `Billing.ts`. Every
  claim a page makes is checked against the route or the Domain symbol, never written from a doc.
- The copy lint (`scripts/lib/rules-lint.ts`, `RETIRED`) reads `src/components/`, so a body may
  not say "run", "in progress", "finish", "view" (except "View in Shopify"), "tab", "import",
  "resync", "picker", "billing period", or join two ideas with a semicolon. The order page's
  badge `In progress` cannot be named in a body; these pages do not need to name it.
- Rules from `AGENTS.md` that bite here: a shape change starts at the parts table on `ScreenPart`,
  then the part, then the kit page; a JSDoc never cites `docs/`; `pnpm fmt` at the end and keep
  everything it touches; do not commit.
- The dev server must be healthy (`pnpm dev:status`). The admin storage state is
  `playwright/.auth/shopify-admin.json`; if it is older than a day the script refreshes it from
  Chrome, which may prompt for the Keychain. Do not run the whole e2e suite. The showcase store
  script and `pnpm seed --showcase` are idempotent and the run ends with `pnpm seed`.
- Record every departure from this plan, and every problem found, in
  [Deviations and issues](#deviations-and-issues) as you go.

## The pictures

Seven merchant pictures, all on the showcase shop. Two member pictures the section needs already
exist and are placed again (decision 3). Each merchant picture names its shape; the four shapes
are the script's whole merchant surface.

| name           | file                                    | shape        | screen and state                                                                                                                                                                                         |
| -------------- | --------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| howBatonWorks1 | `getting-started/how-baton-works-1.png` | page         | the order page for the maple board "Grandma Rose" (`orderWith("Grandma Rose")`, #1206): one item, Cut, engrave and oil, Step 2 of 3, Engrave started by `ana@example.com`                                |
| firstWorkflow1 | `getting-started/first-workflow-1.png`  | modal        | the Create workflow modal with Name `Engraved pen` and Tag `engraved-pen` typed, Create enabled                                                                                                          |
| firstWorkflow2 | `getting-started/first-workflow-2.png`  | window       | the editor on the new workflow, the New step form filled: Name `Engrave`, Team `Engraving`, Instructions `The text is in the properties. Check the spelling before running the laser.`, Add step enabled |
| firstWorkflow3 | `getting-started/first-workflow-3.png`  | editor modal | after Add step, the Turn on modal: "Turn on Engraved pen?" and its sentence about open orders                                                                                                            |
| firstTeam1     | `getting-started/first-team-1.png`      | page         | the team page right after Create team with Name `Assembly`: the "Nobody on this team yet" empty state with its Add members button                                                                        |
| firstTeam2     | `getting-started/first-team-2.png`      | modal        | the Add members to Assembly modal: the search field (seven candidates, so it shows) and the email checkboxes                                                                                             |
| firstOrder1    | `getting-started/first-order-1.png`     | page         | the order page for the maple board "Fresh bread" (#1210, done by `eli@example.com`): the Made banner "Every item is done. Fulfill in Shopify." and the item's Done badge                                 |

Placed again from the members section: `recordingYourWork2` on How Baton works (the member's
page for the same "Grandma Rose" item, so the two sides of one item sit on one page) and
`findingYourWork2` on Following an order (the member's list with Ready chosen).

No pictures on Installing Baton and choosing a plan (decision 2) and none of Home (deferred).

## Phase 1: the kind, the part and the kit

1. **`src/lib/helpPictures.ts`.** `HelpPictureKind = "member" | "merchant"`. A merchant entry
   carries `aspectRatio: "<w>/<h>"` in CSS px, the clip's size, which the part passes to
   `s-image` so the column reserves the picture's height before it loads; the integration test
   holds it equal to the file (phase 4). Add `MERCHANT_WINDOW = { width: 1280, height: 800 }`
   beside `MEMBER_SCREEN`. Add the seven entries above with their alt text (30 to 60 words, the
   screen's words, what matters named). Rewrite the JSDoc: both kinds, how each is shot and shown.
2. **The screenshot part.** `HelpPicture` switches on the kind: a member picture as today; a
   merchant picture `s-image inlineSize="fill" objectFit="contain"` with the entry's
   `aspectRatio`, no box around it, so it fills the column (about 970 CSS px for a 1056 px clip,
   never upscaled past 1:1 at 2x). Update its JSDoc and the screenshot row in the parts table on
   `ScreenPart` (`src/lib/Screen.ts`): drop "(not taken yet)".
3. **The kit page** (`src/routes/dev.kit.tsx`): add one merchant picture under the member one in
   the Screenshot section (`firstOrder1`).

## Phase 2: the script

Extend `scripts/help-screenshots.ts`. The member half stays as it is. The order of a run:

1. Gates: `pnpm dev:status --json` healthy, as today. Then the admin session: read the storage
   state, `adminSessionFresh(cookies, mtimeMs)` as `e2e/shopify-admin.setup.ts` does; if stale,
   `yield* refreshShopifyAuth({ output: storageStatePath, profile: CHROME_PROFILE })` and say so
   on the console. If the refresh fails, stop before touching the store.
2. `pnpm showcase:store`, `pnpm seed --showcase`, as today.
3. **Merchant pictures**, in a context of their own: `storageState: storageStatePath`,
   `baseURL: previewUrl()`, viewport `MERCHANT_WINDOW`, `deviceScaleFactor: 2`,
   `colorScheme: "light"`. Open the app with `gotoApp(page, "app/orders")` (which closes the Dev
   Console). If `page.url()` lands on `accounts.shopify.com`, fail with a message naming the
   storage state. Once per context, `page.addStyleTag` on the admin document hiding the dev mini
   console, the Sidekick composer and the admin toast viewport:
   `[class*="_Composer_"], [class*="_MiniConsole_"], #admin-next-toast-viewport { visibility: hidden !important; }`.
   Those class stems are Shopify's; the overlap check below is what holds when they change.
4. **Member pictures**, as today, in the member context.
5. `pnpm seed`, in `Effect.ensuring`, as today. Print what was written, and for each merchant
   picture its clip size in CSS px, so the inventory's `aspectRatio` can be set from the output.

The four shapes, as functions of the admin page. Each ends with `settle(page)`, then the overlap
check, then the shot:

- **page**: the title bar and the app frame. Find the frame's box (`iframe[src*="embedded=1"]:not([src*="chrome=window"])`);
  find the title bar as the ancestor of the element at `(frame.x + 300, 30)` whose width is within
  40 px of the frame's and whose top is under 20 px (the spike's rule; if nothing qualifies, fail
  and say so). Read the frame document's `scrollHeight`; set the viewport height to the frame's
  top plus that plus 20, wait for the frame to re-lay out (`settle`), re-read the boxes, then clip
  `{ x: frame.x, y: bar.y, width: frame.width, height: frame.bottom - bar.y }`. Restore the
  viewport after. Cap the height at 4000 CSS px and fail past it.
- **modal**: a modal open in the app frame. The panel is the `dialog` element inside the frame's
  `s-modal` that is open; take its `boundingBox()` through the frame locator (page coordinates)
  and clip to it, with no margin. If the box is empty, fail.
- **window**: the whole 1280 × 800 window (the editor is a full-window frame of its own). Grow
  nothing.
- **editor modal**: a modal open in the editor frame (`iframe[src*="chrome=window"]`); the same as
  modal, through `editorFrame`.

The **overlap check**, before every merchant shot: in the admin document, every element whose
computed `position` is `fixed` or `sticky`, that is visible (non-zero box, `visibility` not
hidden, `opacity` not 0), that is not the app iframe, the editor iframe, the title bar or an
ancestor of any of those, and whose box intersects the clip, is reported by tag and the first 60
characters of its class, and the shot is refused. Record in Deviations every stem the first runs
found so the style rule and this list agree.

The shots, in this order, each named for its inventory entry. Hoisted title-bar buttons go
through `clickHoisted` on a page-scoped locator; fields and modal buttons through the frame.

1. `howBatonWorks1`: `gotoApp(page, "app/orders/<id>")` is not possible by number alone; open
   the orders index, search `1206` (the number of `orderWith("Grandma Rose")`), press the order
   link, wait for `s-page[heading="#1206"]` and `awaitNavigated`. Shape page.
2. `firstOrder1`: the same for `orderWith("Fresh bread")`. Shape page.
3. `firstWorkflow1`: open Workflows through the app nav (`openScreen(page, "Workflows")`),
   `clickHoisted` Create workflow, fill Name `Engraved pen`; the Tag fills itself; shape modal.
4. `firstWorkflow2`: press Create; wait for the editor frame and its hydration; press Add step
   (in the editor frame); fill Name, choose Team `Engraving`, fill Instructions; shape window.
5. `firstWorkflow3`: press Add step; wait for `Step 1` on the canvas; `clickHoisted` Turn on
   workflow; wait for the modal's sentence; shape editor modal. Then press Cancel in the modal and
   Close in the window (`closeEditor`'s locator: the dialog's Close button), and wait for the
   editor frame to go.
6. `firstTeam1`: `openScreen(page, "Teams")`, `clickHoisted` Create team, Name `Assembly`,
   Create; wait for `s-page[heading="Assembly"]` and `awaitNavigated`; shape page.
7. `firstTeam2`: press Add members (in the frame); wait for the search field `Search by email`;
   shape modal. Then Cancel.

The workflow and the team the run makes are wiped by the closing `pnpm seed`. Nothing is synced
from Shopify (decision 4).

## Phase 3: the five pages

Each body is a component under `src/components/help/getting-started/<page>.tsx`, registered in
`HELP_BODIES` as `"getting-started/<slug>"`, with the members pages' shape: `s-section` per
sub-topic, `Things`, `s-paragraph`, `NumberedList`, `HelpPicture`, `s-link` by the target page's
title; a JSDoc naming the routes and Domain symbols the page was checked against. Two to four
sections a page, a control's label in bold and exact, a badge's label in bold and exact. Links to
pages that have no body yet are still links (the page shows its lead and foot list).

1. **How Baton works** (`how-baton-works`), concept. Sections: the words (an order and its
   items come from Shopify; a workflow is steps, a step holds tasks, a task is on a team, a member
   is on teams; the vocabulary's screen words only); how an item gets its workflow (the product's
   tag equals the workflow's tag, the workflow is Active, the order is paid; when two workflows
   match, the order shows **Multiple workflows match** and you choose on the order page; link
   Matching items by product tag); who does what (you set up workflows and teams in the admin
   and follow orders; a member signs in with their email on a phone, sees the tasks for their
   teams and presses Start and Done; link For members). Pictures `howBatonWorks1` after the words,
   `recordingYourWork2` after who does what, as the same item on both sides.
2. **Installing Baton and choosing a plan** (`installing`), task, no pictures. Sections: install
   (from the App Store listing, press Install; the admin shows Baton's plans; choose one and
   approve the charge; Baton opens on its home page); what the plans meter (each plan includes a
   number of orders a billing cycle and a number of members, and bills past them at the plan's
   rate; an order counts once, when work on it starts; a cycle's members are its highest count;
   **Manage plan** on the home page opens the plans again); the trial if the plan has one. Name
   no plan, price, count or trial length: those are set in the Partner Dashboard and change
   without a deploy (the home page's own rule), and the plan page shows them. Link Plans and
   billing.
3. **Creating your first workflow** (`first-workflow`), task. Sections: create it (on the
   Workflows page press **Create workflow**; Name; Tag, which fills from the name until you type
   it; **Create** opens the editor); add a step (a team must exist first, the editor says so;
   press **Add step**, Name, Team, Instructions, **Add step**; a second **Add step** is the next
   step; **Add task** under a selected task adds a task to its step); turn it on (**Turn on
   workflow**, the modal's sentence, **Turn on**; every open paid order with the tag starts it;
   the badge reads **Active**); the tag in Shopify (put the tag on the products, exactly as typed;
   link Matching items by product tag). Pictures `firstWorkflow1`, `firstWorkflow2`,
   `firstWorkflow3`.
4. **Creating a team and adding members** (`first-team`), task. Sections: create a team (on the
   Teams page press **Create team**, Name, **Create**; the team's page says nobody is on it yet);
   add members (on the team's page press **Add members**, tick emails, **Add**; a member who is
   not there yet is added on the Members page with **Add member** and an email, no Shopify
   account needed); what the member sees next (they sign in at Baton's sign-in page with that
   email and a link by email, and see their teams' tasks; link Signing in). Pictures `firstTeam1`,
   `firstTeam2`.
5. **Following an order through its workflow** (`first-order`), task. Sections: the order arrives
   (Baton reads new orders from Shopify; a paid order whose item carries the tag starts the
   workflow on that item; on the Orders page the order reads **Not started** until a member
   starts a task, then **Making**); a member does the work (the first step's tasks read Ready for
   their teams; Start, Done; the next step's tasks become Ready; the order page shows the step the
   item is on); made and fulfilled (when every item is done the order reads **Made** and its page
   shows **Fulfill in Shopify**; after you fulfill it in Shopify it reads **Fulfilled**; link
   Reading the orders list). Pictures `findingYourWork2` after a member does the work,
   `firstOrder1` after made and fulfilled.

Check every sentence against the screen: the label, the badge, the order of the buttons, the
condition. Where a sentence and the screen disagree, the screen wins and Deviations records it.

## Phase 4: tests

1. Integration, `test/integration/help-pages.test.ts`: "a merchant picture's aspect ratio is its
   file's": read each merchant file's PNG header (width and height are bytes 16 to 23 of a PNG,
   big-endian) and expect `aspectRatio` to equal `<width/2>/<height/2>`. Member entries are not
   checked (their size is `MEMBER_SCREEN`). The existing tests already cover the new entries and
   bodies.
2. E2E, `e2e/help.public.spec.ts`: generalize "each For members page renders its body and its
   pictures load" to every page with a registered body, reading the keys of `HELP_BODIES`, so a
   section with bodies is covered when it is added. Run with
   `pnpm exec playwright test --project=public`.

## Phase 5: run it and look

1. `pnpm help:screenshots`, then set each merchant entry's `aspectRatio` from the printed sizes,
   then run it again and confirm the sizes hold.
2. Open all five pages headless at 1280 × 800 and 390 × 844 with `pnpm playwright-cli` and save
   full-page shots in the scratchpad. Open each picture file and look at it.
3. Report, in Deviations: what each picture shows, anything that reads wrong (a cut control, an
   overlay, a toast, a stale name, a greyed button), any sentence a screen contradicts, and how
   long the merchant pass took.

## Checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` green after each phase; `pnpm fmt` repo-wide at the
  end.
- `pnpm exec playwright test --project=public` green; the dev store ends on the dev fixture
  (`pnpm seed` ran).
- `pnpm help:screenshots` run twice leaves the same sizes.

## Decisions

Taken 2026-10-07 while writing the plan, without review; the review is on the result.

1. **One plan for the kind and the section.** A picture must be placed by a body, and the kind is
   proven by real pictures, so the section that touches every shape once is the proof.
2. **Installing has no pictures.** The App Store listing does not exist until the app is listed,
   and the plan page is Shopify's and carries names and prices Baton does not know. The page is
   prose and names no plan, price, count or trial length.
3. **A picture is one file, placed where it helps.** How Baton works places the members section's
   `recordingYourWork2` and Following an order places `findingYourWork2`, rather than shooting the
   same screen twice under a second name. The file convention (`<section>/<page>-<n>`) names
   where a picture was first taken, not the only page that shows it.
4. **No real-order walk and no sync.** The Made picture is a seeded order (#1210); the first
   real order is not driven through its workflow by the script. It adds minutes, needs Sync open
   orders, and the seeded order shows the same screen.
5. **The merchant picture's size lives in the inventory** as `aspectRatio`, set by hand from the
   script's output, and a test holds it to the file. The part needs the ratio before the file
   loads, and a rewrite of source by the script is not worth the step it saves.
6. **Toasts are hidden by style**, with the two dev overlays, rather than waited out.
7. **The overlap check refuses the shot.** A new admin overlay fails the run rather than landing in
   a picture, as the spec says.

## Deviations and issues

(filled in by the implementation)

### Pages and tests

Phases 3 and 4, written against the routes and Domain symbols each body's JSDoc names.

- **An order counts when its first workflow starts, not "when work on it starts".** The plan's
  Installing section said an order counts once, when work on it starts. A counted order is one
  Baton created a run for (`ShopOrder.countedAt`, the "first run on an order" row on `ShopUsage`),
  which happens when a workflow matches, before any member presses Start. The page says "the first
  time a workflow starts on one of its items" and adds that an order with no workflow does not
  count.
- **Installing names no screen Baton does not draw.** "Install" on the App Store listing, the plan
  page and the charge approval are Shopify's screens; the code shows only that an unsubscribed
  shop is sent to `ShopifyPartner.planSelectionUrl` and that the return leg carries
  `plan_handle`. **Install** is bold on the strength of the App Store's button, unverified here.
  "Baton opens on its home page" after approval depends on the welcome link set in the Partner
  Dashboard, which the code cannot show. The plan page's controls are not named or bolded.
- **Installing says more than the plan listed, all from `Billing.ts`:** Baton needs a plan to
  open (the `/app` gate redirects an unsubscribed shop back to the plans); nothing is refused past
  an allowance, it is billed; a member you delete still counts until the cycle ends (the seat
  mark is the cycle's highest member count); a plan change starts a new billing cycle with both
  counts at zero (`AppSubscription`); nothing is billed in a trial and its usage does not carry
  over.
- **The concept page's lead is not a definition.** The lead is the page's `description` in
  `HELP_SECTIONS` ("Orders, items, workflows, steps, tasks, teams and members, and how they fit."),
  which this stage does not own, so the definitions sit in the body's first section, "The words".
  The rule "one definition per page, in the lead" holds only if the description is rewritten.
- **Following an order: the orders list opens on Making.** A new order reads Not started, which
  the default list does not show, so the page says to press **Not started** on the strip. It also
  says an unpaid order reads **Unpaid** and starts its workflow once paid (the creation gate on
  `reconcileItem`), and that fulfilling an order before its work is done ends its open workflows
  (the stop gate).
- **Made is "the last task of every item's workflow is done"**, not "every item is done": an item
  with no workflow does not hold an order back from Made (`orderPosition` reads runs only). The
  banner's own words ("Every item is done.") are reported, not quoted.
- **Creating your first workflow says to create a team first.** The editor shows "Create a team
  before adding steps." and no Add step while the shop has no teams, and Getting started lists the
  workflow page before the team page, so the Add a step section opens with that and links
  Creating a team and adding members. It also says **Turn on workflow** stays disabled until there
  is a step and every task has a team (`turnOnBlocker`), and that Turn on workflow on a new
  workflow saves the steps and turns it on in one go (`applyAndTurnOn`).
- **Screen sentences that are not controls or badges are reported in plain words, not bolded or
  quoted**: the team page's empty state, the editor's "Create a team before adding steps.", the Turn
  on modal's sentence, the Made banner. Bold is kept for control and badge labels.
- **The Creating a team page adds Add to teams.** After Add member the member's page opens, and
  **Add to teams** on it is the other way onto a team; the page names it in one sentence.
- **The e2e test checks every `s-image` a body places**, not the files the inventory files under
  the page's slug, because How Baton works and Following an order place member pictures. It
  imports `HELP_BODIES` (a `.tsx` module) into the Playwright run; that loads under the public
  project.
- **The aspect-ratio test reads the files through Vite's `?inline` query.** The integration
  project runs in workerd with no file system, so `import.meta.glob(..., { query: "?inline" })`
  hands each PNG over as a data URL and the test decodes bytes 16 to 23. Checked against a member
  file (780 × 1688 reads as 390/844) with a throwaway test, since deleted.
- **Runs at hand-off.** `pnpm typecheck` and `pnpm lint` green. `pnpm test`: 777 passed, 2 failed, both only because the
  merchant PNGs under `public/assets/help/getting-started/` did not exist yet ("every picture in
  the inventory is a file …" and "a merchant picture's aspect ratio is its file's"). `pnpm exec
playwright test --project=public`: five passed; "each page with a body renders it and its
  pictures load" failed on the first missing merchant picture, the same cause. Rerun all three once
  the pictures are written. `pnpm fmt` not run.

### Script, part and pictures

Phase 1 steps 2 and 3, phase 2 and phase 5.

**Departures from the plan**

- **The merchant picture shows at its own width, capped at the column's, centred.** The plan said
  `inlineSize="fill"` with no box. That draws a 620 CSS px modal panel at about 970, past 1:1 at
  2x, which the plan also forbids. The part now wraps a merchant picture the way it wraps a member
  one (`s-stack` centred, an `s-box` at the clip's CSS width from the first number of
  `aspectRatio`, `maxInlineSize="100%"`), so a page (1056) or the editor window (1212) fills the
  column and a modal keeps its size. No border is drawn. The `inlineSize` string needs one cast to
  Polaris's `${number}px` type.
- **`e2e/app.ts` and `playwright.config.ts` import with `.ts` extensions now.** Node runs the
  script with type stripping and resolves ESM imports literally, so `../playwright.config` and
  `./devStore` / `./hydration` failed with `ERR_MODULE_NOT_FOUND` the moment the script imported
  `e2e/app.ts`. Four import specifiers changed, nothing else; Playwright's runner takes either.
  These two files were outside my list; there was no way to import the drivers without it.
- **`expect.configure` does not reach the e2e helpers.** It returns a new instance, so the script's
  own waits get 10 s and `clickHoisted` and `openScreen` keep their 5 s. No wait timed out in the
  runs below.
- **The page shape fits the clip to the content, not to `scrollHeight`.** The frame document's
  `scrollHeight` is never less than the frame's own height, so every short page came out
  1056 × 808 with the window's empty lower half under it. The script measures the lowest bottom
  edge of any element in the frame's body, shadow roots included (without them the order page
  measured 160 px, because Polaris's cards and text live in shadow roots), and clips 20 px under
  it. The viewport still grows when the content is taller than the window, but never shrinks: in a
  shorter window the collapsed Dev Console (`_BottomBar_`, `_DevTool_`, `_MinimizeLine…`) rose
  into the frame and the overlap check refused the shot.
- **The title bar search keeps the spike's height bound.** The plan's rule (width within 40 px of
  the frame's, top under 20 px) also matches the box that holds both the bar and the frame; the
  bar is the outermost match under 120 px tall.
- **The window shape is the editor's window, not the whole 1280 × 800.** The editor window is
  inset: the admin's collapsed sidebar (icons) shows at its left and a strip of the app behind it
  at its top, and the overlap check refused the first window shot for `_Navigation_` and the
  window's own sticky title bar (`_Toolbar_1epaj_22`). The clip is now the admin `dialog` that
  holds the editor frame (1212 CSS px wide at x 64, y 16), marked as part of the picture, cut 20 px
  under the editor's content as the page shape is (1212 × 466; the whole window was 1212 × 780,
  half of it white).
- **Corners are squared while shooting.** The admin rounds the box around the app frame (`MAIN`,
  16 px; its content box, 12 px), the editor's window and every modal panel, and a clip to any of
  them kept the dark admin background or the dimmed backdrop in its four corners: black triangles
  against the help page. The screenshot's `style` (which Playwright applies inside frames and
  shadow roots for the shot only) sets `border-radius: 0` on every `dialog` and on every rounded
  ancestor of the two frames, which the script finds by computed style, not by class. A modal now
  reads as a panel with a hairline border.
- **The Tag is typed.** The Tag fills from the name as `engraved pen` (lowercase, the space kept),
  not `engraved-pen`. The script waits for the filled value, then types `engraved-pen`, as the
  plan's table asks. The body's sentence ("It fills in from the name, in lowercase, until you type
  in it") matches the screen.
- **Clips are whole CSS px**, rounded outward by under 1 px, so each file is exactly twice its
  `aspectRatio`.

**The overlap check, and the stems it found**

The plan's rule (fixed or sticky, visible, intersecting, not the frames or the bar) refused the
first shot on `div._Layer_1bu6z_1`: a fixed, transparent, `pointer-events: none` layer the admin
keeps over the whole frame (z-index 520) for toasts, whose only child has no height. The check now
also asks that the element, or something inside it, draw within the clip (a fill, an image, a
border, a shadow, text or a replaced element), and that it be on top at some sampled point of the
overlap by `elementsFromPoint`; an element the hit test never finds counts as on top, so a
click-through overlay is still refused. Descendants of the picture's own parts (the frames, the
marked title bar or window) count as the picture.

The check also takes `position: absolute`, because the first full run shipped a grey band at the
foot of every page shot and of the editor window: the Sidekick dock (`_Root_1pe7o_1`, holding
`_SidekickField_4oyh6_3` and its banner `_SidekickBanner_11zan_1`, background `rgb(247 247 247)`)
is positioned absolutely inside the admin's `MAIN`, not fixed, so the plan's rule never saw it and
the `_Composer_` rule hides only the composer inside it. With `absolute` in, the check refused the
next run on `_Root_1pe7o_1`, and the style rule now hides `[class*="_SidekickField_"]` too.

Stems found, for the style rule and this list to agree:

| stem                                                              | what                                     | handled by                 |
| ----------------------------------------------------------------- | ---------------------------------------- | -------------------------- |
| `_Composer_`                                                      | Sidekick composer                        | hidden by style (plan)     |
| `_MiniConsole_`                                                   | dev mini console                         | hidden by style (plan)     |
| `#admin-next-toast-viewport`                                      | toasts                                   | hidden by style (plan)     |
| `_SidekickField_` (in `_Root_1pe7o_`)                             | Sidekick dock and its grey banner        | hidden by style (added)    |
| `_Layer_1bu6z_1`                                                  | transparent toast layer over the frame   | passes: draws nothing      |
| `_Navigation_269o6_97`                                            | admin sidebar beside the editor window   | outside the window clip    |
| `_Toolbar_1epaj_22`                                               | the editor window's title bar            | part of the window, marked |
| `_BottomBar_ejstq_1`, `_DevTool_17ke3_1`, `_MinimizeLine…_17ke3_` | collapsed Dev Console                    | the viewport never shrinks |
| `_scrim_1eods_` (four)                                            | the admin's dimming around an open modal | outside every modal clip   |

**Runs and timing**

Thirteen runs in all while fixing the above. The last two, after the last change to a clip,
printed the same seven sizes, which are the inventory's `aspectRatio`. The merchant pass takes 14
to 18 s (one `gotoApp`, then nav clicks in one document). The whole run was not timed.
The admin session from 14:47 was fresh, so no refresh from Chrome ran and that path is untested.
Each run also retakes the seven member pictures, so their bytes changed (the seed's clock); the
frames are the same. The store ends on the development fixture (the closing `pnpm seed` ran after
every run, failed ones included).

**What each picture shows**

- `howBatonWorks1` (1056 × 374, page): the title bar with back, the app icon, Orders / #1206, Sync
  from Shopify, View in Shopify and the page's `…` menu; the item card "Engraved cutting board —
  Maple", × 1 · SKU CB-MAPLE, the blue `In progress` badge, Properties, Engraving text Grandma
  Rose, "Step 2 of 3 · Engrave · since <time>", Edit note, Manage; Order details (Placed, Paid,
  Unfulfilled); the foot line "Learn more in Reading an order." It does **not** show who started
  Engrave or the workflow's name: both are inside Manage, which is closed. The plan's table and the
  first alt text said "Cut, engrave and oil … started by ana@example.com"; the alt now says what is
  there. The member picture placed after it shows ana@example.com on the same item.
- `firstOrder1` (1056 × 442, page): #1210, the banner with a green check "Every item is done.
  Fulfill in Shopify.", the item with the `Done` badge, Engraving text Fresh bread, "Done · 3
  steps", Edit note, Manage, Order details (Paid, Unfulfilled), the foot line.
- `firstWorkflow1` (620 × 286, modal): Create workflow, Name `Engraved pen`, Tag `engraved-pen`
  focused (blue ring), the help line "In Shopify, put this tag on the products the workflow should
  build.", Cancel and Create, enabled.
- `firstWorkflow2` (1212 × 466, window): the editor window's title bar (app icon, Engraved pen, a
  `Draft` badge, More actions, a greyed Turn on workflow, Close) and the New step form filled:
  Engrave, Engraving, the instructions, Add step and Cancel, the foot line "Learn more in Editing
  steps and tasks." Instructions keep the focus ring. Turn on workflow is greyed because there is
  no step yet, which is the screen's state, not a capture fault. Shown at the column's width the
  text is drawn at about 0.78 of its size; on a 390 px phone it is too small to read.
- `firstWorkflow3` (620 × 158, editor modal): "Turn on Engraved pen?", "Every open order with an
  item tagged “engraved-pen” starts this workflow on that item.", Cancel and Turn on.
- `firstTeam1` (1056 × 302, page): Teams / Assembly with More actions and Add members in the title
  bar; the Members card "Nobody on this team yet" / "Nobody is on this team, so its tasks wait
  until a member joins." with an Add members button; Details, Members 0, Created <time>. The alt
  had said "Add members in its title bar" only; it now names More actions too.
- `firstTeam2` (620 × 386, modal): "Add members to Assembly", the search field "Search by email",
  seven unticked checkboxes ana@ to gus@example.com, Cancel, and Add greyed until a box is ticked.

No toast, overlay, stale name or cut control shows in any of them. The seven alt texts and entry
comments in `src/lib/helpPictures.ts` were rewritten from these pictures (40 to 59 words); the
order page alt says "a blue status badge" rather than naming `In progress`, which the copy rules
retire.

**The pages, looked at headless** (1280 × 800 and 390 × 844, full page, scratchpad only)

All five bodies were registered. At 1280 the page pictures fill the column, the modals sit centred
at 620, and the window fills the column. At 390 every merchant picture shrinks to the column (about
330 CSS px): the modals and the page pictures stay legible, the editor window does not. No sentence
on the five pages contradicts a picture: the Turn on modal's sentence, the Tag's fill rule, the
Made banner, the empty team state and the seven candidates all match. On the kit page the member
and merchant pictures sit one under the other with no space between them, since the part has no
margin of its own and the kit puts both in one section; in the bodies a paragraph always separates
two pictures.

**Checks at hand-off**

`pnpm typecheck` and `pnpm lint` green. `pnpm test`: 37 files, 779 tests passed, the other
agent's two picture tests included, now that the files exist. `pnpm exec playwright test
--project=public`: six passed. `pnpm fmt` not run (the coordinator's).

**Open**

- The window picture is unreadable on a phone. Cropping it to the New step card, or shooting it at
  a narrower window, would fix that; both change the spec's "the whole window for the workflow
  editor".
- The refresh-from-Chrome path in the script has not run, since the session was fresh.
- The overlap check's extra rules (draws something, on top by hit test, `absolute` included) are
  mine, not the plan's; the review should accept or cut them.

## Review (2026-10-07)

Read both Deviations sections, the seven pictures, the five bodies and the diffs outside the
plan's file lists; ran `pnpm fmt`, `pnpm typecheck`, `pnpm lint`, `pnpm test` (779) and the
`public` e2e project (6), all green; the store is back on the dev fixture. The pictures are clean:
no overlay, toast, black corner or cut control, and every sentence checked against its screen
holds. Nine findings, each with a recommendation.

1. **Accept the capture departures and move them into the spec.** The page clip cut 20 px under
   the content (not `scrollHeight`), the window shape as the editor's own dialog (1212 wide), the
   squared corners, the `absolute` position in the overlap check and its two leniency rules
   (draws something, on top by hit test) all came from what the admin does, and the pictures
   show they are right. The "Screenshots" table in `docs/help-research.md` still says
   `scrollHeight`, "the whole window", "fixed-position" and "column width"; its rows `window`,
   `crop`, `overlays` and `shown at` should be rewritten to what the script does, so the next
   section's plan reads the real rule.
2. **Accept the part's "own width, capped at the column".** A 620 px modal at 970 would be past
   1:1 and blurry. The parts-table row already says so.
3. **Accept the `.ts` import extensions** in `e2e/app.ts` and `playwright.config.ts`. Node needs
   them to load the drivers from a script and the runner takes either form.
4. **The editor-window picture is unreadable at phone width.** A merchant reads help beside the
   admin on a desktop, where it reads fine, so accept it. If it matters later, shoot the editor
   at a narrower window (about 1000 px) rather than crop it: the title bar's Turn on workflow is
   the point of the picture.
5. **`In progress` cannot be named in help prose or alt text**, so the order-page alt says "a
   blue status badge". The lint retires the phrase so that screens read it from
   `RUN_STATE_LABEL`, which is also the answer here: a body prints
   `<strong>{Domain.RUN_STATE_LABEL.open}</strong>` and an alt interpolates the constant. Do it in
   the Orders section's plan, where the badge is explained, and fix this alt then.
6. **How Baton works has no definition in its lead.** The lead is the tree's description, which
   this stage did not own. Rewrite it in `HELP_SECTIONS` to one defining sentence, for example
   "Baton takes each order's items through a workflow of steps, each step's tasks done by a team
   of members." One line, no code elsewhere.
7. **Installing names three Shopify screens nobody verified** (Install on the listing, the charge
   approval, landing on Home). The welcome link is `/app` in the README's plan table; the rest is
   Shopify's standard flow. Accept, and verify the page once the app is listed.
8. **The seven member pictures were re-shot**, so their bytes changed with the seed's clock
   while the frames did not. Either restore them from git before committing, or accept the churn;
   a `--section` flag on the script would stop it for good and is a small change for the next
   plan.
9. **"Capital letters included" appears on two pages** (How Baton works and Creating your first
   workflow), against "one fact, one place". Keep it on Creating your first workflow, where the
   tag is typed, and let How Baton works say "exactly" and link Matching items by product tag,
   which it already does.

Nothing else is open. Every other deviation the agents recorded is a fact the code forced and is
already reflected in the pages.
