# Help for Baton: the approach, the structure and the skeleton

Written 2026-10-06, after commit 4cae16b. The question: how should Baton do help? Not the content
yet, but where it lives, who it is for, how it is structured and laid out, what tone it takes, and
what the pages are. The model is the Shopify Flow manual on the Help Center
(https://help.shopify.com/en/manual/shopify-flow), because Flow is Shopify's own workflow product
and its manual is what a merchant who has used Flow already knows how to read. The constraint is
Polaris web components: `s-page` has no sidebar, so a documentation site with a left tree is not
available, and the help has to carry its navigation some other way.

Sources: the Flow manual mirrored in `refs/flow-manual/` (231 pages, read whole for structure and
sampled for anatomy and tone); the live Help Center, surveyed in a browser on 2026-10-06 and written
up separately in `docs/help-shopify-flow-manual-survey.md` (page anatomy, breadcrumbs, what the
sidebar does at desktop and phone width, tone); Bang's help in `refs/bang/src/routes/help.*.tsx`,
`refs/bang/e2e/help.spec.ts` and its in-app links; the Polaris `s-page` reference and the
footer-help and interstitial-nav compositions in `refs/shopify-docs/docs/api/app-home/latest/`;
Baton's vocabulary (`src/lib/Domain.ts`, `src/lib/domain/ShopWork.ts`, `src/lib/domain/Billing.ts`),
the copy, controls and parts tables in `src/lib/Screen.ts`, the retired words in
`scripts/lib/rules-lint.ts`, and the Screens check in `scripts/lib/spec.ts`.

## Short answers

- **Public, at `/help`, one help for both readers.** Help is a public route under the app's own
  origin, like `/privacy`, outside both the embedded `/app` frame and the member's `/shop` area. A
  merchant reaches it from the admin in a new tab; a member reaches it from the bench on a phone.
  One tree, not two: the member's pages are one section of it, named for the reader, and the member's
  Help link lands on that section rather than on the hub.
- **The Help Center has no sidebar either.** The survey settled this: at 1280 and at 390 the page
  is one centred column. The section tree is a "Contents" dropdown button beside the breadcrumbs,
  the same at every width. What carries a reader is a hub page per section with a lead paragraph
  and an "In this section" list; parent-only breadcrumbs above every heading; an "On this page"
  anchor list on long pages; and links in the prose. No next or previous, no related block. So the
  model fits Polaris as it is. The skeleton takes the hub, the breadcrumbs and the prose links, and
  adds one device in place of the Contents menu: the section's page list repeated at the foot of
  every page in it, with the current page unlinked.
- **Three levels, no more.** Help, section, page. Flow goes to four in two places (reference items,
  advanced concepts) and reads worse there. Baton has 33 pages in the skeleton: the hub, six sections,
  26 pages. No search: at this size the hub and the section lists are the search.
- **Flow's tone, held to Baton's copy rules.** Second person, imperative steps, bold for a control's
  label, present tense. Every help page is a screen under `src/routes/`, so `pnpm lint` already
  refuses "run", "tab", "view", "please", "click here" and the rest in its copy, and routes may lay
  out nothing: the help is built from parts. The copy table's tone list applies as written, with one
  addition for help: a page may explain, which a screen never does.
- **Page titles: gerunds for tasks, nouns for hubs and reference.** "Creating a workflow",
  "Turning a workflow on or off"; "Workflows", "States and badges". That is Flow's convention, minus
  its "in Shopify Flow" suffix, which exists because the Help Center hosts every product and Baton's
  help hosts one.
- **The skeleton is in: 33 pages, three route files and one tree.** `src/lib/helpPages.ts` holds
  the tree (slug, title, one-line description). `help.index.tsx`, `help.$section.index.tsx` and
  `help.$section.$page.tsx` render every page from it: breadcrumbs, heading, the section list, the
  foot. Bodies are empty. A later phase writes each page's body as a component and fills in
  screenshots. The public landing page links to Help. Nothing inside `/app` or `/shop` links to it
  yet; where those links go is a question below.

## What the Flow manual does

### Structure

The manual is one tree, five sections deep by one and shallow after that. From `refs/flow-manual/`:

| section         | hub page             | pages under it                                                                                     | depth            |
| --------------- | -------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| Getting started | `getting-started.md` | 5 (understanding triggers, conditions, actions; examples; advanced concepts, which has 6 under it) | 3, 4 at concepts |
| Creating        | `create.md`          | 5 (create, preview data, editor, optimize, troubleshoot)                                           | 3                |
| Managing        | `manage.md`          | 7 (manage, test, monitor, organize, retry, run manually, version history)                          | 3                |
| Reference       | `reference.md`       | 4 hubs (triggers, conditions, actions, connectors), then one page per item (~200)                  | 4                |
| Developing      | `develop.md`         | a pointer out to shopify.dev                                                                       | 2                |

Every hub has the same anatomy: a lead of one to four paragraphs that links its children and the
reference in prose, sometimes a table or a video, then a heading "In this section" over a plain list
of links, each link the child's full title. The landing page is the same shape with a product
definition as its lead. There is no next or previous link anywhere, and no "related" block.

The live site (`docs/help-shopify-flow-manual-survey.md`) adds what the mirror cannot show. There
is no left tree at any width: the page is one centred column about 760px wide. The tree is a
"Contents" button above the title that opens a menu of every manual with the current one expanded,
using shorter labels than the page titles ("Troubleshooting errors" for "Troubleshooting errors in
Shopify Flow"). Breadcrumbs sit on the same row and end at the parent, never the current page
("Home > Shopify Flow > Reference > Triggers"); the middle collapses to "…" when the row is narrow.
A page with two or more `##` sections gets an "On this page" anchor list after its lead, in the
main column, not a sticky rail. Every page ends with a feedback button and an "Ask about this
article" box; there is no page search beyond that.

### Page anatomy

Three page types recur:

- **Hub.** Lead, optional table, "In this section". `create.md`, `manage.md`, `reference.md`.
- **Task.** A lead that says what the page covers. Optional "Considerations" bullets before the
  steps. One `##` per task ("Create a new workflow", "Create a workflow by using a template"), each
  with a `#### Steps:` label and a numbered list. Step one is always the path from the admin ("From
  your Shopify admin, go to **Apps** > **Flow**"). Optional steps say "Optional:". Tips and notes are
  asides between tasks. `create/create-workflow.md`, `manage/monitor.md`.
- **Reference item.** A one-sentence definition in bold-led prose, then fixed `##` headings in a
  fixed order: Fields (a two-column table), Triggers, API details, Common issues, Templates.
  `reference/actions/add-order-tags.md`. The same headings on every item page, present or absent.

Numbered steps are short imperatives. A control is named in bold with its exact on-screen label
("Click **Create workflow**"). A value a merchant types is in `<kbd>`. A "Caution" aside carries a
fact with a consequence (runs are kept for 14 days). Pages are 300 to 900 words; reference items are
shorter plus their template list.

### Tone

- Second person throughout: "you can create", "your store", "your workflow".
- Imperative steps: "Click", "Select", "Enter", "Review".
- Definitions in the first sentence of a page, often with the term in italics on first use
  ("a log of what happened, called a _workflow run_").
- Plain and unhurried, with a sentence of why where it helps ("When possible, use a trigger that
  starts workflows when a condition is fulfilled other than the creation of an order. For example…").
- No humour, no apology, no exclamation.

### Naming

- Section hubs: gerund + object + product. "Creating workflows in Shopify Flow", "Managing
  workflows in Shopify Flow". The product suffix is on almost every title because the Help Center
  hosts hundreds of products and search results need it.
- Task pages: gerund phrase. "Creating workflows manually or from a template", "Finding and
  monitoring workflow runs".
- Concept pages: "Understanding triggers in Shopify Flow".
- Reference items: the thing's own name, as the product labels it. "Add order tags", "Order created".
- Headings inside a task page: imperative. "Create a new workflow".

## What Bang did, and what to keep

Bang (`refs/bang/src/routes/help.*.tsx`) put help at a public `/help` with the same four devices:
breadcrumbs in `s-page`'s `breadcrumb-actions` slot ("Bang > Help > Getting started"), a lead, an
"In this section" list (as a bordered box of clickable rows on the hub, a plain list elsewhere), and
a centred foot line linking two related pages (Polaris's footer-help composition). The embedded home
page linked out to the help sections with `target="_blank"` cards, and the Live and Memory pages
each ended with a "Learn more about…" line. Its one e2e test walked the whole tree. The reference
pages (`help.actions.$action.tsx`) were data-driven: one route, a table of actions, a loader that
finds the slug.

Keep: public `/help`; the breadcrumb slot; the data-driven route for pages that share a shape; the
new-tab link out of the embed (App Bridge turns an iframe's `target="_blank"` into a top-frame
redirect, so no popup blocker sees it; the test in `refs/bang/e2e/help.spec.ts` checks exactly
that); one e2e test that walks the tree.

Do not keep: layout in the routes (`s-stack`, `s-box`, `s-grid`, padding props), which Baton's lint
refuses; `<code>` for a control's label, where Flow uses bold; a prose list of "1. 2. 3." in
paragraphs instead of an ordered list; the hub's lead explaining the product in three paragraphs,
which Baton's copy rules would cut to one.

## First principles for Baton

### Two readers, three arrivals

| reader   | where they are              | device                     | what they want                                                                |
| -------- | --------------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| merchant | the Shopify admin, embedded | desktop, sometimes a phone | how to set up workflows and teams; what a badge or issue means; what it costs |
| member   | the bench, `/shop/$shop`    | a phone or a tablet        | how to sign in; where their work is; what Start, Done, Put back, Block do     |
| either   | a search engine or a link   | any                        | one page, then a way up                                                       |

The merchant has 20-odd screens and all the configuration; the member has three screens and no
configuration. The member's help is a quarter of the tree and has to work on a phone first. The
merchant's help is read in a new tab beside the admin.

### What carries the navigation with no sidebar

A sidebar does two jobs: it shows where the reader is, and it lets them move sideways to a sibling
without going up. The Help Center does both without one, and so can Baton. Each job needs a device
that is on every page at every width:

| job             | device                                                          | where                                            |
| --------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| where am I      | breadcrumbs: Baton > Help > Section                             | `s-page` `breadcrumb-actions`, above the heading |
| what is in here | "In this section": the section's pages with one line each       | a hub's last section                             |
| sideways        | the section's page list, current page unlinked                  | the foot of every page in a section              |
| up              | the breadcrumb, and the foot list's heading linking the section | both                                             |
| related         | links in the prose, by the target page's title                  | the lead and the body                            |
| back to the app | the "Baton" breadcrumb, which is the public landing page        | every page                                       |

One caution on the breadcrumb slot: under about 500px Polaris folds it into a "…" button beside the
heading (the member's workflow page chose a visible back link over it for that reason, see the JSDoc
in `src/routes/shop.$shop.workflows.$runId.tsx`). The Help Center's breadcrumb collapses the same
way on a phone, and its answer is the Contents menu, which is one tap at every width. Baton's
answer is the foot list on every page, not only on hubs: on a phone it is the visible way up and
sideways, and it needs no menu element.

### The repo's rules already reach help

- Help pages are route files under `src/routes/`, so `scripts/rules-lint.ts` reads their copy:
  the retired words ("run", "line item", "tab", "view", "staff", "in progress", "import"…) and the
  words wrong in every slot ("please", "successfully", "click here", "are you sure") are refused in
  help prose as on any screen. This is right: help that says "run" teaches a word no screen shows.
- Routes lay out nothing. `s-stack`, `s-box`, `s-grid` and every spacing prop are refused outside
  `src/components/screen/`, so a help page is `s-page`, `s-section`, the Polaris content elements
  (`s-paragraph`, `s-heading`, `s-ordered-list`, `s-unordered-list`, `s-list-item`, `s-link`,
  `s-image`, `s-table`) and Baton's parts (`Things`, `Lines`). A help shape no part has gets a part
  and a row in the parts table, like any screen.
- The Screens table in the vocabulary names merchant and member screens only: `app.*` and `shop.*`
  route files. `help.*` is exempt from that check, as `privacy` and `index` are, so the skeleton
  adds no Screens rows and `pnpm spec check` passes.
- The copy table's tone list applies: "you" for the reader, contractions, facts, present tense,
  sentence case, no "we". A member page says "the merchant"; a merchant page says "members".
- `pnpm spec check` refuses a copy-table example no screen shows; help copy is not an example
  source for it, and nothing in the help tables needs parsing by a script.

### What a help page is allowed that a screen is not

The copy table's `body` slot never explains the product beside content. Help is where that
explanation lives. Each page may:

- define a word the vocabulary has, in the vocabulary's screen word ("An item's workflow is the
  steps its team follows…"), never the code word;
- say why ("Turning a workflow off stops new orders starting it, and you can turn it back on");
- say what a badge, a count or an issue means, with the badge's exact label in bold;
- show a screenshot of the screen it describes.

And it stays under the same ceilings: one idea per sentence, a lead of one to three sentences, an
ordered list for steps, no filler.

## Structure: the skeleton

### The tree

Six sections. Five for the merchant, one for the member, in the order a merchant meets them. Flow's
"Getting started" is first for the same reason. Titles are the skeleton's; the body is a later
phase.

| route                                           | title                                         | type      | reader   | what the page says                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------- | --------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/help`                                         | Help                                          | hub       | both     | one sentence on Baton; the six sections                                                                                                                                                                                 |
| `/help/getting-started`                         | Getting started                               | hub       | merchant | the order of setup: install, workflow, team, first order                                                                                                                                                                |
| `/help/getting-started/how-baton-works`         | How Baton works                               | concept   | both     | order, item, workflow, step, task, team, member; how an item gets its workflow; who does what                                                                                                                           |
| `/help/getting-started/installing`              | Installing Baton and choosing a plan          | task      | merchant | install from the App Store; the plan page; the trial; the two meters                                                                                                                                                    |
| `/help/getting-started/first-workflow`          | Creating your first workflow                  | task      | merchant | Create workflow, name and tag, add a step and a task, assign a team, Apply, Turn on                                                                                                                                     |
| `/help/getting-started/first-team`              | Creating a team and adding members            | task      | merchant | Create team; Add member by email; what the member sees next                                                                                                                                                             |
| `/help/getting-started/first-order`             | Following an order through its workflow       | task      | merchant | an order arrives, its item matches a tag, a member starts it, Done, Made, Fulfill in Shopify                                                                                                                            |
| `/help/orders`                                  | Orders                                        | hub       | merchant | what the orders list and the order page are for                                                                                                                                                                         |
| `/help/orders/orders-list`                      | Reading the orders list                       | concept   | merchant | the strip (No workflow, Not started, Making, Made, Issues) in the order an order moves, Making the default; Open, Unpaid, Fulfilled, Cancelled and All in the Show select; the Team filter, search, what each row shows |
| `/help/orders/order-page`                       | Reading an order                              | concept   | merchant | each item's card: its workflow, step, team, badges; the order note; Open in Baton from Shopify's order page                                                                                                             |
| `/help/orders/attaching-a-workflow`             | Attaching or changing a workflow              | task      | merchant | the Workflow select on an item; Attach; Change workflow and what is lost; Cancel workflow                                                                                                                               |
| `/help/orders/fixing-issues`                    | Fixing an issue                               | task      | merchant | Multiple workflows match, Needs a team, Blocked: what each means, what clears it                                                                                                                                        |
| `/help/orders/syncing`                          | Syncing from Shopify                          | concept   | merchant | when Baton reads orders; Sync from Shopify on an order; the open-order ceiling                                                                                                                                          |
| `/help/workflows`                               | Workflows                                     | hub       | merchant | what a workflow is; create, edit, turn on                                                                                                                                                                               |
| `/help/workflows/creating`                      | Creating a workflow                           | task      | merchant | Create workflow; name; tag; the new workflow is inactive                                                                                                                                                                |
| `/help/workflows/editing`                       | Editing steps and tasks                       | task      | merchant | Edit; add a step, add a task, instructions, assign a team; Apply changes, Discard changes; the draft                                                                                                                    |
| `/help/workflows/matching`                      | Matching items by product tag                 | concept   | merchant | one tag per workflow; exact match; units to make; when two workflows match                                                                                                                                              |
| `/help/workflows/turning-on-and-off`            | Turning a workflow on or off                  | task      | merchant | Active and Inactive; what Turn off does to items already on it                                                                                                                                                          |
| `/help/workflows/managing`                      | Renaming, duplicating and deleting a workflow | task      | merchant | More actions: Rename, Duplicate, Delete; Delete leaves items already on it going, active or inactive                                                                                                                    |
| `/help/teams-and-members`                       | Teams and members                             | hub       | merchant | a team holds tasks; a member is on teams; Needs a team and No members                                                                                                                                                   |
| `/help/teams-and-members/creating-a-team`       | Creating a team                               | task      | merchant | Create team; Add members; Rename                                                                                                                                                                                        |
| `/help/teams-and-members/adding-a-member`       | Adding a member                               | task      | merchant | Add member by email; no Shopify account needed; Add to teams; what the member sees                                                                                                                                      |
| `/help/teams-and-members/removing-and-deleting` | Removing and deleting                         | task      | merchant | Remove from a team versus Delete member; Delete team; what happens to open tasks                                                                                                                                        |
| `/help/members`                                 | For members                                   | hub       | member   | you were added by the merchant; sign in, find your work, record it                                                                                                                                                      |
| `/help/members/signing-in`                      | Signing in                                    | task      | member   | the email link; Your stores; Sign out; the Subscription inactive page                                                                                                                                                   |
| `/help/members/finding-your-work`               | Finding your work                             | concept   | member   | the Workflows list: Started by you, Started by others, Ready, Blocked; the Team filter; search; Show more                                                                                                               |
| `/help/members/recording-your-work`             | Recording your work                           | task      | member   | the item's page: Start, Done, Put back, Undo; Step k of n; the note; printing the page                                                                                                                                  |
| `/help/members/blocking`                        | Blocking an item and leaving a note           | task      | member   | Block with a reason; Unblock; Edit note; what the merchant sees                                                                                                                                                         |
| `/help/reference`                               | Reference                                     | hub       | both     | the tables                                                                                                                                                                                                              |
| `/help/reference/states-and-badges`             | States and badges                             | reference | both     | the vocabulary's screen columns: task states, workflow states, order positions, issues, faults                                                                                                                          |
| `/help/reference/who-can-do-what`               | Who can do what                               | reference | both     | the verbs table: member and merchant columns                                                                                                                                                                            |
| `/help/reference/limits`                        | Limits                                        | reference | merchant | names, notes, instructions, members per team, workflows, open orders                                                                                                                                                    |
| `/help/reference/plans-and-billing`             | Plans and billing                             | reference | merchant | plans; the billing cycle; counted orders; seats; included allowances; Manage plan                                                                                                                                       |

33 pages. The reference pages are tables the vocabulary already holds; writing them is copying the
screen columns out of `src/lib/domain/ShopWork.ts` and `Billing.ts`, and a later check could hold
them equal.

### Page anatomy, by type

| type      | above the heading | lead                                    | body                                                                                                                 | foot                                                          |
| --------- | ----------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| hub       | breadcrumbs       | one to three sentences linking children | nothing, or one table                                                                                                | "In this section": each child's title as a link, its one line |
| task      | breadcrumbs       | what the page covers, one sentence      | one `s-section` per task, heading imperative; an ordered list of steps; a screenshot where the screen is not obvious | the section's page list, current page unlinked                |
| concept   | breadcrumbs       | the definition                          | `s-section`s by sub-topic; a screenshot of the screen described                                                      | same                                                          |
| reference | breadcrumbs       | one sentence                            | one `s-table` per table, headings the vocabulary's                                                                   | same                                                          |

A step says the control's label in bold, exactly as the screen prints it: "Press **Create
workflow**." Flow says "Click"; Baton's reader on a phone taps, so the verb is "press", which is
what the controls table already uses for a button. A value the reader types is in bold too ("enter
**wall-clock**"); there is no `<kbd>` element and `<code>` reads as code.

### Navigation on each page

```
Baton > Help > Workflows                 ← breadcrumbs (folds to "…" under 500px)
Creating a workflow                      ← heading
lead
[sections]
In Workflows                             ← foot list: the section link, then siblings
  Creating a workflow                    ← unlinked
  Editing steps and tasks
  Matching items by product tag
  Turning a workflow on or off
  Renaming, duplicating and deleting a workflow
```

The hub's foot is "In this section" and holds its children; a section hub's "In this section"
holds its pages; a page's foot is "In <section>" and holds the section's pages. One list part serves
all three.

## Tone and naming rules for help

- The copy table's tone list, as written. The reader is "you"; a member page says "the merchant"; a
  merchant page says "a member", "the team".
- Help may define and explain. One definition per page, in the lead. A reason where it changes what
  the reader does.
- Steps are an ordered list of short imperatives. Step one names the screen, not the admin path:
  "On the Workflows page, press **Create workflow**." A merchant reads help beside the admin and
  knows where Baton is; a member has three screens.
- A control's label is bold and exact. A badge's label is bold and exact. A state word is the
  vocabulary's screen word.
- Titles: gerund for a task page; noun for a hub, a concept and a reference page; no product name in
  a title; sentence case.
- The browser tab reads "<title> — Baton help".
- No "Note", "Tip", "Caution" asides. A fact with a consequence is a sentence in the body; a fault
  is its own sentence. Polaris has `s-banner` but a banner on a help page is a fact about the page,
  which help has none of.
- No videos. No "Need help? Email…" line; support is the landing page's and the privacy policy's.

## Entry points from the app

None are in the skeleton. The choices:

| from                               | device                                                                                                                                                                                                     | note                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| the public landing page `/`        | a Help link beside Sign in and Privacy policy                                                                                                                                                              | in the skeleton                                                                |
| the merchant's home page           | a footer-help line: "Learn more in **Help**", `target="_blank"`                                                                                                                                            | Polaris's footer-help composition; the Bang way; opens a tab outside the admin |
| a merchant screen with a hard idea | a footer-help line to the one page: the workflow editor to Editing steps and tasks; the order page to Reading an order (the skeleton's choice, `docs/help-plan.md`; this table first said Fixing an issue) | one line per screen, at the foot, never a banner                               |
| the member's top bar               | a Help link at the end, beside Sign out, to `/help/members`                                                                                                                                                | the member's one chrome; a phone reader lands on their section, not the hub    |
| the member's sign-in page          | a line under the form to Signing in                                                                                                                                                                        | the one page a member reads before they have access                            |

## Implementation shape

- **The tree is data.** `src/lib/helpPages.ts`: `HELP_SECTIONS`, each `{ slug, title, description,
pages: [{ slug, title, description }] }`, plus `findHelpSection` and `findHelpPage`. The hub, the
  section hubs and the pages read it, so a page's breadcrumbs, its foot list and the hub's list are
  one source and cannot drift.
- **Three routes under a layout.** `help.tsx` (layout, `Outlet`), `help.index.tsx` (the hub),
  `help.$section.index.tsx` (a section hub), `help.$section.$page.tsx` (a page). A slug the tree
  does not have is `notFound()` from the loader. Bang's reference route is the pattern.
- **Bodies are components.** A later phase adds `src/components/help/<section>/<page>.tsx`, one per
  page, and a map from slug to component that `help.$section.$page.tsx` renders between the lead and
  the foot. The route stays one file; the content stays one file per page, which is what a writer
  edits.
- **Parts.** The skeleton uses `s-page`, `s-section`, `Things`, `s-paragraph`, `s-unordered-list`,
  `s-list-item` and `s-link` only, so it needs no new part and passes the layout lint. The content
  phase will want: a `help list` part (title link over a one-line description, for the hub and the
  foot), a `steps` part (an ordered list with the right distances), a `screenshot` part (`s-image`
  with `aspectRatio` and `objectFit="contain"`, under `public/assets/help/<section>/<page>-<n>.png`,
  which is where Bang kept them). Each needs a row in the parts table, which means a template word
  for help; see the questions.
- **Tests.** One e2e that walks the tree the way Bang's does: the hub, every section hub, one page
  per section, the foot list, the breadcrumb up. One integration test that every page in the tree
  renders a heading equal to its title. Both can read `HELP_SECTIONS`, so adding a page adds its
  coverage.
- **Later: screenshots.** A script that drives the seeded dev store through `playwright-cli` and
  captures each screen the help names, at desktop width for merchant pages and phone width for
  member pages, into `public/assets/help/`. The seed's data is the help's data, so the screenshots
  and the examples agree.

## Screenshots

The spec for every picture in help, so the content phase takes them one way and a script can retake
them. Measured 2026-10-06 in Chrome at a 1280 × 800 window, device scale factor 2:

| what                                                         | CSS px                                | at 2x |
| ------------------------------------------------------------ | ------------------------------------- | ----- |
| a help page's column (`s-page inlineSize="base"`)            | about 970                             | 1940  |
| the app frame inside the admin (`iframe[name="app-iframe"]`) | 1056 wide, at x 220, y 59             | 2112  |
| a merchant index page's content (`inlineSize="large"`)       | about 990                             | 1980  |
| a merchant details page's content (`inlineSize="base"`)      | about 965: main column 640, aside 310 | 1930  |
| a member page (`inlineSize="small"`, phone)                  | 390, the screen                       | 780   |

So a whole merchant page shot at 1280 is the help column's width and shows at 1:1; a crop of the
main column's card is about 640 CSS px and shows at its natural width, never upscaled.

Revised 2026-10-07 after a capture test against the dev server (`docs/showcase-shop-research.md`,
"Capture"). The first version of this spec shot the element `s-page` inside the app frame. That
cannot work: the admin draws the page's heading, its primary action and its More actions menu in its
own title bar, outside the frame, and `s-page` has no box to capture. The title bar (54 CSS px)
sits directly above the frame, so a merchant page is a clip of the window from the title bar's top
to the frame's bottom, across the frame's width (1056 CSS px, 2112 at 2x). A modal's panel is drawn
inside the frame while the admin dims around it, so a modal is a clip to the panel. The workflow
editor is a full-window frame of its own and is shot as the window.

| rule         | merchant screens                                                                                                                                                                                                            | member screens                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| what is shot | Baton's page as the merchant sees it: the admin's title bar and the app frame below it, clipped to the frame's width; no admin sidebar, search bar or overlays                                                              | the whole phone screen, top bar included                             |
| window       | 1280 × 800, device scale factor 2; grown to the frame's top plus the frame body's `scrollHeight` for a page taller than the window                                                                                          | 390 × 844, device scale factor 2                                     |
| crop         | the whole page for a "Reading…" page; the one card, drawer or modal panel for a step; the whole window for the workflow editor                                                                                              | the whole screen; a modal when the step is the modal                 |
| overlays     | the Dev Console closed; the dev mini console and the Sidekick composer hidden by a style rule; the shot refused if anything fixed-position still overlaps the clip                                                          | none                                                                 |
| shown at     | column width (`s-image inlineSize="fill"`, `objectFit="contain"`, `aspectRatio` from the file)                                                                                                                              | 390 CSS px wide, centred, by the screenshot part; never column width |
| file         | PNG, 2x, `public/assets/help/<section>/<page>-<n>.png`, `<n>` the picture's order on the page                                                                                                                               | the same                                                             |
| data         | the showcase shop (`pnpm seed --showcase` and its store script, `docs/showcase-shop-research.md`): its names are the help's examples, so a name in the prose is a name in the picture                                       | the same, signed in as the showcase's member `ana@example.com`       |
| state        | the screen as the step leaves it: after Create team, the team page; a modal open for the step that fills it                                                                                                                 | the same                                                             |
| annotation   | none. A crop says where to look; a highlight box, arrow or blur is a second thing to keep current                                                                                                                           | none                                                                 |
| alt text     | 30 to 60 words saying what the picture shows and which control or badge matters, in the screen's words; no caption                                                                                                          | the same                                                             |
| exceptions   | Shopify's own screens (the App Store listing, the plan page, Open in Baton on an order) are shot as the whole 1280 window with the admin chrome, because the chrome is the point. No Home pictures until Home is redesigned | none                                                                 |
| browser      | Chrome through Playwright's API in the script (not `playwright-cli`), headless, light theme; the e2e setup's storage state for the admin                                                                                    | the same, a member session from the magic link read back locally     |
| when retaken | by the script, after any change to a screen the picture shows; a picture is never edited by hand                                                                                                                            | the same                                                             |

Why the title bar and the frame and not the whole admin: the admin's sidebar and search change
without Baton and would stale every picture, while the title bar carries Baton's heading and the
buttons the steps name. Why 2x and not 1x: Polaris text at 1x in a
downscaled picture is unreadable. Why no annotation: Flow's highlight boxes are what its screenshots
are most often out of date on. Why the phone is shot whole: a member's screen is the top bar, the
heading and the list, and a crop would lose the way back the prose names.

The screenshot script (`scripts/help-screenshots.ts`, the content plan) reads a list of
`{ file, url, element?, width, actions? }` entries, drives the seeded dev store, and writes the
files; a page's body names its pictures by file. The script's list is the inventory of pictures,
so a picture nobody references is found by a check and a reference to no file fails the build.

## Decisions

Reviewed 2026-10-06 in Plannotator. Every recommendation was accepted; decision 11 is accepted for
now and will be gone into in a later session. The plan is `docs/help-plan.md`.

1. **One help.** One tree; "For members" is a section of it; the member's Help link lands on that
   section.
2. **The member section is "For members".** It names the reader.
3. **The sideways device is the foot list.** The section's pages at the foot of every page, current
   page unlinked, under "In <section>" with the section's title a link. No Contents menu. Revisit
   if the tree doubles.
   3a. **No "On this page" list.** A page has two to four short sections; the ceiling is the fix.
4. **No next or previous links.** The foot list shows the order.
5. **Breadcrumbs above the heading**, in `s-page`'s slot. The foot list covers the phone, where
   the slot folds to "…".
6. **Titles are gerunds for task pages, nouns for hubs, concepts and reference.**
7. **No product name in a title.** The tab reads "<title> — Baton help".
8. **A `help` template row** in `ScreenTemplate`: a page of prose, read, not worked; the help parts
   name it.
9. **The copy lint reads help.** `scripts/rules-lint.ts` keeps refusing the retired words in help
   prose; when page bodies become components, its file list grows to `src/components/help/`.
10. **All five entry points**, after the content exists: the landing page (done), then the merchant
    home page's foot line and the member top bar's Help link, then one foot line each on the
    workflow editor and the order page. Never a Help item in `s-app-nav`.
11. **Screenshots by script against the seed**, desktop width for merchant pages and phone width for
    member pages. Accepted for now; the mechanics get their own session.
12. **No search.** Revisit at a hundred pages.
13. **Three levels**, held by the data shape.
14. **Reference pages held to the vocabulary** by a `pnpm spec check` rule, in the content phase,
    for States and badges and Who can do what; Limits reads the constants.
15. **The lapsed page is one sentence on Signing in**, not a page.
16. **The entry points go in now**, before the content, so the skeleton shows the structure end to
    end; decision 10's "after the content exists" is withdrawn. Taken 2026-10-06 on review.

## Roadmap

Where the help work stands, one line per stage, and the doc that carries it. This research stays
the umbrella; each stage's detail lives in its own research or plan. Updated 2026-10-07.

| stage                                          | status                                     | doc                                  |
| ---------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| Approach, tree, anatomy, tone, screenshot spec | decided 2026-10-06                         | this research                        |
| Skeleton: template row, help list, foot lines  | done 2026-10-06; the Syncing title is open | `docs/help-plan.md`                  |
| Showcase data: fixture, products, real orders  | done, closed 2026-10-07                    | `docs/showcase-shop-plan.md`         |
| Screenshot script, screenshot and steps parts  | next                                       | `docs/help-members-plan.md`          |
| For members content (four pages)               | next, with the stage above                 | `docs/help-members-plan.md`          |
| Order positions: what Not started means        | done 2026-10-07 (3579fda)                  | `docs/order-not-started-research.md` |
| Getting started content                        | later                                      | a plan of its own                    |
| Orders content                                 | later; order positions are settled         | a plan of its own                    |
| Workflows, Teams and members content           | later                                      | a plan per section                   |
| Reference pages and their vocabulary check     | later (decision 14)                        | a plan of its own                    |
| Home page pictures                             | deferred until Home is redesigned          | none yet                             |

Carried into the content stages, decided elsewhere:

- Signing in has no pictures; the page is prose (`docs/showcase-shop-research.md`).
- Finding your work describes Show more in a sentence, no picture (`docs/showcase-shop-plan.md`,
  second review, decision 2).
- Syncing from Shopify says when to press Sync from Shopify on an order: when Shopify shows the
  order closed and Baton shows it open (`docs/showcase-shop-plan.md`, "Found on the way").
- Reading the orders list writes to the seven positions and the five-cell strip
  (`docs/order-not-started-research.md`, decisions 1 to 10, implemented in 3579fda): Unpaid and
  No workflow are the two no-workflow cases split by payment; Not started is an order a member can
  Start; Making is an order with a started or done task; the strip reads No workflow · Not started
  · Making · Made · Issues in the order an order moves, Making the default; Open and Unpaid are
  Show values with no count; No workflow is a position, not an issue, so its Issues cell is empty
  and the badge is where the merchant sees it. Fixing an issue stays at three issues (Multiple
  workflows match, Needs a team, Blocked). Reading an order says the item's Not started badge and
  the order's Not started position now mean the same thing.
- A member is spelled as their email on every screen (`actorLabel`); a member has no name. Help
  prose and these docs write the email (`ana@example.com`), never a bare lowercase "ana", which
  is nothing a screen shows.
- The For members pages are unaffected: 3579fda changed no member screen, no member label and no
  member fixture data (checked 2026-10-07, `docs/help-members-plan.md`).
