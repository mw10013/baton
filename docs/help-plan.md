# Plan: the help skeleton, its parts, its tests and its entry points

Written 2026-10-06 from the sixteen decisions in `docs/help-research.md`, all accepted. It is for
an agent that has not seen that research. Read its "Short answers", "Structure: the skeleton" and
"Decisions" first. This plan does not repeat the reasoning. It says what to change, in what order,
and how to check it.

The skeleton is already in and uncommitted: `src/lib/helpPages.ts` (the tree), `src/components/HelpList.tsx`,
`src/routes/help.tsx`, `help.index.tsx`, `help.$section.index.tsx`, `help.$section.$page.tsx`, and
a Help link on `src/routes/index.tsx`. Every page renders breadcrumbs, a one-line lead and a foot
list; bodies are empty. This plan hardens that skeleton (spec rows, parts, tests), wires the place a
page body will go, and adds the entry points from the app on both sides. It does not write content
or take screenshots; those are a later plan, one section at a time.

## Before you start

- Read `AGENTS.md` and `docs/vocabulary-runbook.md`. The rules that matter most here:
  - A shape change starts at the parts table on `ScreenPart` in `src/lib/Screen.ts`, then the part
    under `src/components/screen/`, then the kit page (`src/routes/dev.kit.tsx`), then the screens.
    Routes and components outside `src/components/screen/` lay out nothing: no `s-stack`, `s-box`,
    `s-grid`, no `gap`, `padding*`, `className` or `style`. `pnpm lint` refuses them.
  - A copy change starts at the row in the copy table on `CopySlot`; a control change at the row
    in the controls table on `Control`. A link's text is the target screen's heading.
  - Help pages are screens: `scripts/rules-lint.ts` reads their copy and refuses the retired words
    ("run", "line item", "tab", "view", "staff", "in progress", "import", "please", "successfully",
    "click here", "are you sure", ...). Say "the item's workflow", "filter", "members".
  - `pnpm spec check` parses the parts table: every `ScreenPart` literal has one row; a row's
    `component` is a file under `src/components/screen/` or a Polaris element; its `used on` names
    `ScreenTemplate` words only. A new template word goes into the literals and the templates table
    together.
  - `help.*` routes are not merchant or member screens and get no row in the Screens table
    (`checkScreens` in `scripts/lib/spec.ts` reads `app.*` and `shop.*` only). Do not add one.
  - JSDoc never cites `docs/`. A JSDoc that needs the reasoning carries it inline.
  - Run `pnpm fmt` and keep everything it touches. Do not commit unless told to.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` at the end of every phase. Run the e2e specs
  this plan names after phase 3, then `pnpm seed`.
- Record every departure from this plan, and every problem found, in
  [Deviations and issues](#deviations-and-issues) as you go. Leave the section's heading in place
  even if it stays empty.

## The decisions, as work

| decision                                                     | phase           |
| ------------------------------------------------------------ | --------------- |
| 1 one help, "For members" a section of it                    | done            |
| 2 "For members"                                              | done            |
| 3 foot list on every page, section title a link              | done; part in 1 |
| 3a no "On this page"                                         | none            |
| 4 no next or previous                                        | none            |
| 5 breadcrumbs in `s-page`'s slot                             | done            |
| 6 gerund task titles, noun hubs and reference                | done            |
| 7 no product name in a title                                 | done            |
| 8 a `help` template row                                      | 1               |
| 9 the copy lint reads help, and later `src/components/help/` | 2               |
| 10 all five entry points                                     | 3               |
| 11 screenshots by script                                     | later plan      |
| 12 no search                                                 | none            |
| 13 three levels, held by the data shape                      | done            |
| 14 reference pages held to the vocabulary                    | later plan      |
| 15 the lapsed page is a sentence on Signing in               | later plan      |

The entry points go in now, before the content (decision 16): a link to a page that has only its
lead and its foot list is still a link to the right place, and the structure is to be seen end to
end. The screenshot spec is the "Screenshots" section of `docs/help-research.md`; this plan takes no
pictures.

## Phase 1: the template word and the parts

1. **The `help` template.** In `src/lib/Screen.ts`, add `"help"` to the `ScreenTemplate` literals
   and a row to the templates table in its JSDoc:

   | template | Shopify's | what it is                                                                                                    |
   | -------- | --------- | ------------------------------------------------------------------------------------------------------------- |
   | help     | (none)    | a page of prose that is read, not worked: breadcrumbs, a heading, sections, lists and images; the public help |

   The Screens table in `src/lib/Domain.ts` is unchanged (help has no rows there).

2. **The help list part.** Move `src/components/HelpList.tsx` to
   `src/components/screen/HelpList.tsx`. Its JSDoc names its row and keeps its reasoning (the
   current page unlinked so the foot list says where the reader is; the entry is a title link and a
   one-line description). Add the row:

   | part      | job                                                                        | component  | fixes                                           | used on | never                           |
   | --------- | -------------------------------------------------------------------------- | ---------- | ----------------------------------------------- | ------- | ------------------------------- |
   | help list | a hub's "In this section" and a page's foot list: a title link over a line | `HelpList` | the list; the current entry unlinked and strong | help    | a card per entry; a chevron row |

   Add `"help list"` to the `ScreenPart` literals. Update the four imports.

3. **The foot line part.** Phase 3 needs Polaris's footer-help composition (a centred one-sentence
   line of links at a page's foot), which is an `s-stack alignItems="center"`, so it is a part.
   Create `src/components/screen/FootLine.tsx`: `({ children })` renders
   `<s-stack alignItems="center"><s-text>{children}</s-text></s-stack>`. Row:

   | part      | job                                                             | component  | fixes             | used on                          | never                       |
   | --------- | --------------------------------------------------------------- | ---------- | ----------------- | -------------------------------- | --------------------------- |
   | foot line | one centred sentence of links at a page's foot: the way to help | `FootLine` | centred; one line | homepage, details, editor, index | a second sentence; a banner |

   Add `"foot line"` to the literals. The sentence's copy is a `link` slot: "Learn more in
   <target heading>." with the target's heading as the link text. Add that form to the `link` row's
   `form` cell in the copy table ("the target screen's heading, or "<Verb> in Shopify"; at a foot
   line, "Learn more in <heading>."") and a controls-table row:

   | job                           | control                                                                                               | never                             |
   | ----------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------- |
   | the way from a screen to help | a foot line, "Learn more in <help page heading>.", one per screen, `target="_blank"` inside the embed | a banner; a nav item; a help icon |

   `pnpm spec check` refuses a copy-table example no screen shows; the `link` row's example stays
   "Fulfill in Shopify", so nothing else changes there.

4. **The kit page.** In `src/routes/dev.kit.tsx` add one `HelpList` with three entries, the
   longest title in the tree ("Renaming, duplicating and deleting a workflow") among them and one
   marked current, and one `FootLine` with a link. Look at it at `/dev/kit?width=small` and at
   phone width.

5. Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`. `pnpm spec print` should list the two new
   parts.

## Phase 2: the body slot and the tests

1. **Where a body goes.** Create `src/components/help/bodies.tsx` exporting
   `HELP_BODIES: Readonly<Record<string, () => React.JSX.Element>>` keyed `"<section>/<page>"`,
   empty for now, with a JSDoc saying the content plan adds one component per page under
   `src/components/help/<section>/<page>.tsx` and registers it here. In
   `help.$section.$page.tsx`, render the body between the lead and the foot list when the map has
   the key; render nothing otherwise. The lead stays the description either way.

2. **The lint reads bodies.** In `scripts/rules-lint.ts`, add `src/components/help/` to the files
   `retiredCopyHits` reads, so a body's prose is held to the retired-word rule (decision 9). Check
   with a throwaway body containing the word "tab": `pnpm lint` must refuse it; then remove it.

3. **Integration test**, `test/integration/help-pages.test.ts`:
   - "every help page has a unique route and a title that is its heading": slugs unique within
     their section and section slugs unique; every title and description non-empty; no title ends
     in a period; no slug has a character outside `[a-z0-9-]`.
   - "help copy is free of the retired words": run `RETIRED` from `scripts/lib/rules-lint.ts` over
     every title and description in `HELP_SECTIONS` (the way `rules-lint.test.ts` does) and expect
     no hit. This pins the tree's copy even though the tree lives under `src/lib/`, which the lint
     does not read.
   - "a page body is registered only for a page the tree has": every key of `HELP_BODIES` resolves
     through `findHelpSection` and `findHelpPage`.

4. **E2E**, `e2e/help.public.spec.ts`. Add a `public` project to `playwright.config.ts` shaped like
   `member` (localhost base URL, empty storage state, no `setup` dependency; `testMatch:
["**/*.public.spec.ts"]`), and exclude `*.public.spec.ts` from the `e2e` project's match. The
   spec, after `awaitHydration`:
   - "the hub lists every section": at `/help`, an `s-page[heading="Help"]`, and a link for each
     `HELP_SECTIONS` title.
   - "a section hub lists its pages and a page's foot lists its siblings": for the first page of
     every section: open the section hub, expect its page links; open the page, expect
     `s-page[heading="<title>"]`, the breadcrumb link to the section, the foot's section link, the
     current title present and not a link, and every sibling a link.
   - "an unknown page is not found": `/help/workflows/nope` shows `s-page[heading="Page not found"]`
     with a link to `/help`.
   - "the landing page links to help": at `/`, the Help link goes to `/help`.

5. Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e -- --project=public`.

## Phase 3: the entry points

One per screen, at the foot, on the `foot line` part. The link text is the target page's title.
Inside the embed the link carries `target="_blank"`: App Bridge turns an iframe's blank target into
a top-frame redirect, so the admin stays and a tab opens (Bang verified this in
`refs/bang/e2e/help.spec.ts`). In the member area the link is same-tab; Back returns.

| screen                   | file                                             | sentence                                                | href                             |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------- | -------------------------------- |
| the public landing page  | `src/routes/index.tsx`                           | the Help link, already in                               | `/help`                          |
| the home page (merchant) | `src/routes/app.index.tsx`                       | Learn more in **Help**.                                 | `/help`, blank                   |
| the workflow editor      | `src/routes/app.workflows.$workflowId_.edit.tsx` | Learn more in **Editing steps and tasks**.              | `/help/workflows/editing`, blank |
| the order page           | `src/routes/app.orders.$orderId.tsx`             | Learn more in **Reading an order**.                     | `/help/orders/order-page`, blank |
| the member's top bar     | `src/components/MemberBar.tsx`                   | a tertiary `s-link` **Help** in `end`, before the email | `/help/members`                  |
| the sign-in page         | `src/routes/login.tsx`                           | Learn more in **Signing in**.                           | `/help/members/signing-in`       |

1. **The home page.** After the "Usage and capacity" section, as the last child of `s-page`:
   `<FootLine>Learn more in <s-link href="/help" target="_blank">Help</s-link>.</FootLine>`.
2. **The workflow editor.** Last child of its `s-page`, outside the editor's canvas and aside. If
   the editor's save bar or aside makes a foot line read wrong, put the line under the canvas and
   say so in Deviations.
3. **The order page.** Last child of its `s-page`.
4. **The member's top bar.** In `MemberBar`, add `<s-link href="/help/members">Help</s-link>` as
   the first thing in `end`. `TopBar`'s JSDoc already says `end` is the session; extend it to "the
   session and the way to help". The link's accessible name is "Help".
5. **The sign-in page.** Under the form, in the "Sign in" section's `Things`, as the section's last
   child: `<FootLine>Learn more in <s-link href="/help/members/signing-in">Signing in</s-link>.</FootLine>`.
   Not on the "Check your email" state: that screen's one job is the link in the email.
6. **No nav item.** `s-app-nav` in `src/routes/app.tsx` is unchanged.
7. **E2E.** In `e2e/home.spec.ts`: "home links to help in a new tab": click the foot line's link
   and await `page.context().waitForEvent("page")` as Bang's test does; expect the new page's URL
   to end in `/help`. In `e2e/member-area.member.spec.ts`: after a member signs in, the top bar has
   a Help link whose href is `/help/members`. In the `public` spec: the sign-in page's foot line
   links to `/help/members/signing-in`.
8. Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e -- home.spec.ts
member-area.member.spec.ts --project=e2e --project=member`, `npm run test:e2e --
--project=public`, then `pnpm seed`. Look at the home page in the embedded app and the member's
   list on a phone width.

## Checks

- `pnpm typecheck`, `pnpm lint`, `pnpm test` green.
- `pnpm spec print` lists `help list` and `foot line`; `pnpm spec check` passes with `help` in the
  templates table.
- `/help`, a section hub, a page and an unknown slug render as the research describes at 1280 and
  390 wide.
- Every entry point in the table above is present and goes where the table says.
- The Deviations section below is filled in, or says there were none.

## What the content plan will do (not this plan)

So the shapes here do not have to be revisited: one component per page under
`src/components/help/<section>/<page>.tsx`, registered in `HELP_BODIES`; a `steps` part (an
ordered list) and a `screenshot` part (`s-image` under `public/assets/help/<section>/<page>-<n>.png`,
`objectFit="contain"`), each with a row; the screenshot script against the seed; the reference pages
and the `pnpm spec check` rule that holds their tables to the vocabulary's screen columns; the
lapsed-page sentence on Signing in.

## Deviations and issues

(none yet)
