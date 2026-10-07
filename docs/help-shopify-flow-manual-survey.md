# Shopify Help Center, Flow manual: structure survey

Surveyed 2026-10-06 in Chrome (DevTools MCP), signed in as a merchant. Start: `https://help.shopify.com/en/manual/shopify-flow`. Every URL below is under `https://help.shopify.com/en/manual/shopify-flow` unless it starts with `/en`.

Method and limits:

- 14 Flow pages plus the Help Center home and one search results page were opened. Each got an accessibility snapshot and a screenshot at a phone width. Eleven also got a desktop screenshot at 1280x900 (the landing page, create hub, create-workflow, triggers list, order-created, send-email, troubleshoot, understanding-triggers, test-workflow, workflow-editor, manage, getting-started, conditions; the reference hub was not re-shot at desktop).
- The phone pass ran at a 500 CSS px window (the browser would not shrink below that through the resize tool). One page (order-created) was re-checked with true 390x844 mobile emulation; the layout is the same, so the phone findings hold. The snapshot DOM did not differ between widths on the pages compared.
- Word counts are `main.innerText` word counts. They include about 40 words of chrome (Contents button, breadcrumb, feedback buttons, "Ask about this article"). Text inside collapsed accordions is not counted, so the troubleshooting page is understated.

## Pages visited

Depth is the number of levels below the Shopify Flow landing page (landing = 0). Breadcrumb depth on desktop is depth + 2 (Home, Shopify Flow, ...).

| URL                                       | Title (h1)                                     | Page type                           | Words (est.) | Images                                 | Depth |
| ----------------------------------------- | ---------------------------------------------- | ----------------------------------- | ------------ | -------------------------------------- | ----- |
| `/en`                                     | "How can we help?" (h2; no h1)                 | site home, search + topic index     | 400          | 1 banner                               | n/a   |
| `/` (landing)                             | Shopify Flow                                   | hub with intro                      | 230          | 1 app icon, 1 YouTube embed            | 0     |
| `/getting-started`                        | Getting started with Shopify Flow              | hub with concept intro              | 394          | 0                                      | 1     |
| `/getting-started/understanding-triggers` | Understanding triggers in Shopify Flow         | concept                             | 1,142        | 0                                      | 2     |
| `/create`                                 | Creating workflows in Shopify Flow             | hub with concept table              | 520          | 1 YouTube embed                        | 1     |
| `/create/create-workflow`                 | Creating workflows manually or from a template | task (three step lists)             | 1,147        | 1 YouTube embed, 0 screenshots         | 2     |
| `/create/workflow-editor`                 | Using the workflow editor in Shopify Flow      | task + feature tour                 | 1,866        | 6 screenshots                          | 2     |
| `/create/troubleshoot`                    | Troubleshooting errors in Shopify Flow         | troubleshooting                     | 962 visible  | 8-9 screenshots, all inside accordions | 2     |
| `/manage`                                 | Managing workflows in Shopify Flow             | hub with intro                      | 159          | 0                                      | 1     |
| `/manage/test-workflow`                   | Testing a workflow in Shopify Flow             | task                                | 1,638        | 0 (icon glyphs only)                   | 2     |
| `/reference`                              | Shopify Flow reference                         | hub with concept table              | 290          | 0                                      | 1     |
| `/reference/triggers`                     | Triggers in Shopify Flow                       | reference index (86 links)          | 346          | 0                                      | 2     |
| `/reference/conditions`                   | Conditions in Shopify Flow                     | reference + concept (one long page) | 2,356        | 7 screenshots                          | 2     |
| `/reference/triggers/order-created`       | Order created                                  | reference item                      | 2,553        | 0                                      | 3     |
| `/reference/actions/send-email`           | Send internal email                            | reference item                      | 1,751        | 0                                      | 3     |
| `/en/search/Tag-Orders-In-Flow...`        | "tag orders in Flow"                           | search results + AI answer          | 400          | 0                                      | n/a   |

Hierarchy seen: Home > Shopify Flow > {Getting started, Creating workflows, Managing workflows, Reference, Developing extensions} > section page > item page. Four levels below Home at most for the pages visited (Home, Flow, Reference, Triggers, then the item). Help Center URLs mirror the tree: the item URL is `/reference/triggers/order-created`.

## 1. Navigation with no sidebar

### The Help Center has no navigation sidebar

At 1280 wide the page is a single centered column about 760 px wide. There is no left tree and no right-hand table of contents. A fixed icon button at bottom-left (`data-component-name="app-navigation-toggle-button"`, hidden below its breakpoint) opens a left panel. The panel contains only an "Ask anything" link, which is the AI assistant and its history. It is not the section tree. At phone width the same toggle moves to the top-left of the header bar, beside the "Help" logo.

The section tree lives in a button above the title: `button "Contents" expandable haspopup="menu"`. It opens a `menu "Contents"` whose `menuitem` entries are the top-level topics ("Intro to Shopify", "Migrate to Shopify", ... "Customers", "Shopify Flow", ...). The current manual is expanded in place. For Flow the expanded items are: "Getting started with Shopify Flow", "Creating workflows" (children: "Create manually or from templates", "Previewing data", "Using the workflow editor in Shopify Flow", "Optimizing your Shopify Flow workflows", "Troubleshooting errors"), "Managing workflows", "Reference", "Developing extensions". The Contents button and the layout are identical at 1280 and 390. The tree is therefore a dropdown at every width, not a sidebar. Menu labels are shorter than page titles ("Troubleshooting errors" versus h1 "Troubleshooting errors in Shopify Flow").

### Landing page: intro text plus a short link list

`/` is not a card grid. It is: h1 "Shopify Flow"; an app card (icon, link "Shopify Flow", "Install Shopify Flow from the Shopify App Store."); two intro paragraphs whose first sentence defines the product and whose inline links name the three parts ("creating workflows" using "triggers", "conditions", and "actions"); an h4 callout "Plan requirement" with bullets; a YouTube embed; an h4 callout "Tip" ("To see more videos, visit our YouTube channel."); then h3 "In this section" with five links:

- Getting started with Shopify Flow
- Creating workflows in Shopify Flow
- Managing workflows in Shopify Flow
- Shopify Flow reference
- Developing extensions for Shopify Flow

The list is plain `<a>` items with no descriptions. The same prose-then-list shape repeats on every hub page (`/getting-started`, `/create`, `/manage`, `/reference`): intro and concept text first, then "In this section" last.

### Breadcrumbs

Placed directly under the header, on one row with the Contents button to its left. Text and links, no current-page crumb (the current page is the h1 below it):

- Landing: `Home`
- Hubs one level down (`/create`, `/manage`, `/reference`, `/getting-started`): `Home > Shopify Flow`
- `/reference/conditions`, desktop: `Home > Shopify Flow > Reference`
- `/reference/triggers/order-created`, desktop: `Home > Shopify Flow > Reference > Triggers`
- `/reference/actions/send-email`, desktop: `Home > Shopify Flow > Reference > Actions`
- `/create/troubleshoot`, desktop: `Home > Shopify Flow > Creating workflows`

When the trail is too long for the row, the middle collapses to a `...` that is a `span role="button"` (`data-testid="truncation"`): `Home > ... > Triggers` at phone width, and `Home > ... > Getting started with Shopify Flow` and `Home > ... > Managing workflows` even at 1280 on pages whose parent name is long. The accessibility snapshot lists the `...` as `button "..."` and the immediate parent as a link. I could not open the `...` with a click in this tool, so what it expands to is inferred (the hidden crumb is "Shopify Flow"). The breadcrumb always keeps Home and the immediate parent, so a leaf page always links to its parent hub in one tap.

### "In this section" and "On this page"

Two named lists, both in the main column, not in a rail:

- `In this section` (h3) sits at the bottom of hub and index pages. It lists the child pages. On `/reference/triggers` it lists all 86 trigger pages in a flat list, with no grouping headings.
- `On this page` (h2) sits near the top of any page with two or more h2 sections, after the intro paragraphs and before the first h2. It lists the h2 titles as `#anchor` links. Examples: order-created has "Data provided", "Testing the trigger", "Actions", "Templates". send-email has "Fields", "Triggers", "Templates". troubleshoot has six entries. It is not sticky and not floating at 1280 either. It exists at phone width and at desktop width in the same place.
- Pages with a single section (hubs, `/reference/triggers`) have no "On this page".

### Next and previous links

None. No page shows next/previous links. A reader moves sideways by: the breadcrumb parent (up), the parent's "In this section" list (to a sibling), the Contents menu (anywhere in the manual), or inline links in prose.

### Related links at the bottom

None as a block. Pages end with a `Leave feedback` button, then the fixed bottom bar `Ask about this article` (a text box that sends the question to the AI assistant scoped to the article) and a `Chat with a human` button (a round icon button at phone width). Related content is carried by inline links in prose and callouts (for example the h4 "Tip" on `/reference`: "Review some examples of workflows that you can use in Shopify Flow."), and by the h2 "Actions" and "Triggers" sections on reference item pages, which link to the other kind of item.

### Moving around without a tree

- Up: breadcrumb parent link.
- Sideways: parent hub's "In this section", or the Contents menu.
- Down: "In this section" on hubs; inline links in the intro; the table on `/create` and `/reference` whose first column links to Triggers, Conditions, Actions, Connectors.
- Within a page: "On this page" anchors, plus per-heading Helpful / Not helpful buttons (thumb icons at the right of each h2 on desktop and phone).
- Across items: a trigger page's "Actions" h2 links to actions that work with it (order-created lists Add order tags, Hold fulfillment order, For each, and others), and an action page's "Triggers" h2 says which triggers it works with ("The Send internal email action can be used in any workflow."). Both end in a "Templates" h2 of workflow templates with "View template" links into the Flow app.

## 2. Page anatomy

| Page type                                           | Headings                                                                                                                                   | Intro                                                                        | Lists                                                  | Callouts                                        | Tables                                             | Images                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------- | ----------------------------- |
| Landing                                             | h1, h4 "Plan requirement", h4 "Tip", h3 "In this section"                                                                                  | 2 paragraphs, ~85 words                                                      | 1 bullet list inside callout, 5-link section list      | 2                                               | 0                                                  | icon + video                  |
| Hub (`/create`)                                     | h1, h4 "Tip"/"Note", h3 "In this section"                                                                                                  | 2 sentences + table + 5 paragraphs                                           | 5-link section list                                    | 2 (Tip: videos; Note: hire a Partner)           | 1 (component, description, example)                | video                         |
| Hub (`/manage`)                                     | h1, h3 "In this section"                                                                                                                   | "You can do the following to manage your workflows:" then a 4-item link list | 7-link section list                                    | 0                                               | 0                                                  | 0                             |
| Task (`/create/create-workflow`)                    | h1, h2 "On this page", h2 x4, h4 "Steps:" x3, h4 "Tip", h4 "Note"                                                                          | 1 sentence + video + Tip, then "On this page"                                | 3 numbered lists (9, 9, 9 steps), several bullet lists | Tip x2, Note x1                                 | 0                                                  | 1 video                       |
| Concept (`/getting-started/understanding-triggers`) | h1, h2 "On this page", h2 x2, h3 x3, h4 "Sidekick", h4 "Note"                                                                              | 2 sentences, 45 words                                                        | bullets of links                                       | Sidekick, Note                                  | 1 (trigger, example use cases)                     | 0                             |
| Reference index                                     | h1, h3 "In this section"                                                                                                                   | 3 sentences                                                                  | 86 links                                               | 0                                               | 0                                                  | 0                             |
| Reference item (trigger/action)                     | h1, h2 "On this page", h2 x3-4 ("Data provided" or "Fields", "Testing the trigger", "Actions" or "Triggers", "Templates"), h3 per template | 1 sentence: "The **Order created** trigger starts a workflow when ..."       | bullet lists                                           | h4 "Note" only when a limit exists (send-email) | 1 (Data/Description or Field/Description)          | 0                             |
| Troubleshooting                                     | h1, h2 "On this page", h2 x6, h3 for sub-groups                                                                                            | 1 paragraph, 70 words, then Note                                             | 1 ordered list                                         | Note, Sidekick                                  | 0                                                  | screenshots inside accordions |
| Long reference + concept (`/reference/conditions`)  | h1, h2 "On this page", h2 x7, h3 x8                                                                                                        | 1 paragraph, 110 words, plus "Learn more about ..."                          | numbered and bulleted                                  | Note x2                                         | 4 (operators with Description and Example columns) | 7 screenshots                 |

Details with evidence:

- Heading levels: h1 is the page title. h2 are sections. h3 are subsections. h4 are the labels of callouts and of step lists ("Steps:", "Note", "Tip", "Sidekick", "Plan requirement"). There is no h4 used for ordinary subsections.
- "Steps:" is a literal h4 with a trailing colon, directly before an ordered list. `/create/create-workflow` has three, one per method.
- First step of nearly every task: "From your Shopify admin, go to **Apps** > Flow." The ">" is plain text between bold labels. Steps that are optional start with "Optional:".
- Step length: one action per step, 8 to 25 words. Sub-results ("The workflow highlights specific conditions and actions ...") sit as an unnumbered paragraph after the step they follow, followed by a bullet list of options.
- Callouts are `<aside>` blocks with a colored panel, an icon, and an h4 title: Tip (blue-grey), Note (blue-violet), Plan requirement (teal), Sidekick (violet). They hold one to three sentences, or a bullet list on the landing page.
- Screenshots: no captions (no `figcaption` on any page). Each has a 30-60 word alt text that describes the picture and what is highlighted ("Image of the Shopify Flow workflow editor, with an in-progress workflow. Two connections from the 'True' path of a conditions step are highlighted, each pointing to a different actions steps below. ..."). The images are annotated product screenshots (a highlight box, a grey overlay), sit directly after the paragraph that explains them, and are full column width at desktop. Small inline icon glyphs (trash, plus, redo, heart) are SVGs inside sentences with alt text such as "Delete".
- Videos: an embedded YouTube iframe near the top of the landing page, `/create`, and `/create/create-workflow`, always followed by the same h4 Tip.
- Accordions: `DisclosureTriangle` (button) rows hide each error entry on the troubleshooting page ("Workflow count exceeded", "Data not found", "5XX status", ...), and one step set on test-workflow ("Create event data manually" expanded, "Generate event data with Sidekick" collapsed). Error names are quoted as the product shows them.
- Feedback: each h2 has `button "Helpful — <section>"` and `button "Not helpful — <section>"`. One page-level `Leave feedback` button at the bottom.
- Lengths: hubs 160-520 words; leaf tasks 1,100-1,900; reference items 1,700-2,600 (mostly the template list: order-created has about 55 h3 template titles with one-sentence descriptions); concept pages around 1,100.

## 3. Tone

- Second person, imperative for steps, present tense, merchant addressed as "you" / "your store" / "your Shopify admin". The merchant is never named as "merchant" or "user" on the pages read. "Staff" is used for the merchant's team ("best used to send emails to staff"), and "customers" for the merchant's customers.
- Sentence length: about 18 to 22 words per sentence on average (test-workflow: 1,638 words, 82 sentence ends). Intro paragraphs of 40 to 110 words. Step sentences 8 to 25 words.
- UI names: bold, exact label, no quotes. In the DOM: `<li><p>Click <strong>Create workflow</strong>.</p></li>`. Verbs: "Click" for buttons and links, "select" for list choices and options ("select the trigger"), "go to" for navigation, "enter" for text, "hover over" for hover targets, "Hit **Enter**" for a key. "Tap" does not appear on the pages read, including on phone. Keyboard shortcuts are written "ctrl + C on a PC or command + C on a Mac". Navigation paths: **Apps** > Flow. Icon buttons are named with the icon inline plus the name: "click [trash icon] icon".
- Code and data names: monospace chip (`order`, `via shopifyemail.com`, `fulfillments_item.totalQuantity`). Product concepts introduced for the first time are italic (_triggers_, _conditions_, _actions_, _workflow_ on getting-started).
- Terms of the product in prose are lower case and unbolded ("a trigger", "the workflow editor"). Item names are bold when used as the subject of a reference sentence ("The **Order created** trigger ...").
- Modal verbs: "can" and "might" for options and risk ("you might encounter errors"), "must" for hard requirements ("You must be using a desktop device ..."), "don't" and "can't" as contractions.
- "Why this matters:" appears as a label inside concept sections (understanding-triggers uses it three times).
- First sentences (verbatim):
  - Landing: "Shopify Flow is an ecommerce automation platform that you can use to automate tasks and processes within your store and across your apps."
  - `/create`: "To use Shopify Flow, create a workflow."
  - `/manage`: "You can do the following to manage your workflows:"
  - `/reference/triggers`: "Triggers are events that start a workflow."
  - order-created: "The Order created trigger starts a workflow when an order is placed by a customer, or when a draft order is marked as paid and converted to an order."
  - send-email: "The Send internal email action sends an email from your sender email address."
  - test-workflow: "You can test a workflow before you activate it."
  - troubleshoot: "Shopify Flow helps you automate tasks and processes in your store, but you might encounter errors or reach certain limits when creating or editing workflows."
  - understanding-triggers: "A trigger is the event that starts the workflow, and represents the initial set of data that the workflow uses to inform the conditions of the workflow."

## 4. Page types

| Type                          | Example URL                                                          | Marks                                                                                                            |
| ----------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Hub / landing                 | `/` and `/manage`                                                    | h1, short prose, "In this section" last, breadcrumb of 1-2 crumbs                                                |
| Hub with concept table        | `/create`, `/reference`                                              | prose plus a 3-column table (Workflow component / Description / Example) whose first column links down           |
| Concept                       | `/getting-started/understanding-triggers`                            | definition in the first sentence, "Why this matters", a closing examples table                                   |
| Task / how-to                 | `/create/create-workflow`                                            | "Considerations" h2 first, then one h2 per method, each with an h4 "Steps:" numbered list                        |
| Feature tour (task + concept) | `/create/workflow-editor`                                            | h2 per UI area, screenshots, one list of steps per task                                                          |
| Reference index               | `/reference/triggers`                                                | one flat "In this section" list, alphabetical-ish, 86 items                                                      |
| Reference item                | `/reference/triggers/order-created`, `/reference/actions/send-email` | fixed h2 set: data or fields, testing, linked items, templates                                                   |
| Reference (long single page)  | `/reference/conditions`                                              | one page with `#anchors` for data types, operators, examples                                                     |
| Troubleshooting               | `/create/troubleshoot`                                               | h2 per phase (creating, editing, running), one accordion per error, h3 "Transient errors" and "Permanent errors" |
| FAQ                           | none found in the Flow manual                                        |                                                                                                                  |
| Search                        | `/en/search/<query>.<id>`                                            | results cards, then an AI "Answer"                                                                               |

## 5. Naming

- Page titles are mostly gerund phrases with a product suffix: "Creating workflows in Shopify Flow", "Managing workflows in Shopify Flow", "Testing a workflow in Shopify Flow", "Troubleshooting errors in Shopify Flow", "Using the workflow editor in Shopify Flow", "Understanding triggers in Shopify Flow", "Retrying workflow runs in Shopify Flow".
- Variations: noun plus suffix for lists and indexes ("Triggers in Shopify Flow", "Conditions in Shopify Flow", "Examples of workflows in Shopify Flow", "Shopify Flow reference"); a task title with a pair of alternatives ("Creating workflows manually or from a template"); an imperative-ish title only on the long management page ("Manage, duplicate, copy, import, export, or delete workflows in Shopify Flow").
- Reference item titles are the item's own UI name, with no suffix: "Order created", "Send internal email", "Customer abandons checkout". The trigger index label sometimes differs from the h1 (index "Product variant out of stock" links to a `variant-out-of-stock` URL).
- Hub titles under the manual carry the manual name. Section names in the breadcrumb and the Contents menu drop the suffix: "Creating workflows", "Managing workflows", "Reference", "Getting started with Shopify Flow".
- Section (h2) titles inside a page are sentence-case phrases, usually shorter than the page title and without the product name: "Considerations for creating a workflow", "Create a new workflow", "Create a workflow by using a template", "Generate a workflow with Sidekick", "Data provided", "Testing the trigger". Task h2 titles are imperative ("Create a new workflow"); reference h2 titles are nouns ("Fields", "Templates"). Some h2 repeat the product name ("Considerations for testing a workflow in Shopify Flow") and some are gerunds ("Adding a step to a workflow"), so the family is not uniform.
- Capitalization is sentence case everywhere; product feature names are capitalized (Sidekick, Shopify Flow).

## 6. Reference organization

- One page per item, grouped by kind, with one index page per kind: `/reference` (hub) lists four kinds: Triggers, Conditions, Actions, Connectors. `/reference/triggers` (86 items), `/reference/actions`, `/reference/connectors` are index pages, and each item has its own URL under the kind.
- Conditions are the exception: a single long page with seven `#anchor` sections, because conditions are a small fixed vocabulary (operators, data types) rather than a catalog.
- Ordering on the triggers index is roughly alphabetical by the item's name, with exceptions (for example "Customer joined segment" sits before "Customer abandons checkout"; "Fulfillment order ready to fulfill" is slotted between "Fulfillment order fulfillment request accepted" and "...rejected"). Items are not grouped under headings by object; the name prefix (Order, Customer, Fulfillment order, Product variant, Return, Subscription) does the grouping.
- Every item page has the same h2 skeleton, with the headings named after what the reader needs next: "Data provided" (triggers) or "Fields" (actions), "Testing the trigger", "Actions" (triggers) or "Triggers" (actions), "Templates". The item pages cross-link by object: a trigger lists the actions that can use its data, an action lists the triggers it can follow.
- Table columns: triggers use `Data | Description`; actions use `Field | Description`; operators use `Operator | Description | Example`. Variable names are in monospace.

## 7. Search

- Yes. The Help Center home has a single text box, `textbox "Ask anything"` with `button "Search"`, under the h2 "How can we help?" There is no separate keyword box. On every manual page the same pattern appears as a fixed bar at the bottom of the viewport, `textbox "Ask about this article"`, and the header has no search field of its own. The left panel toggle opens an "Ask anything" panel.
- What it does: submitting "tag orders in Flow" went to `/en/search/Tag-Orders-In-Flow.<id>` and showed a "Results" block with two cards ("Organizing and searching workflows in Shopify Flow", with breadcrumb "Shopify Flow › Organize Workflows", and "Tags", "Shopify Admin › Using Tags"), a "View more results" link, then an "Answer" generated from those sources ("Yes — you can tag orders automatically in Shopify Flow. How it works: ...", with the set-up steps as a numbered list, "Common examples" as links, and "You can also ask" chips). Result cards show title, one-sentence summary, and the manual's section path.
- Search results use the same column and the same bottom input ("Ask a follow up") at phone width.

## What transfers to an app with no sidebar

The Help Center has no sidebar either; six devices carry the navigation load:

1. A parent-only breadcrumb above the title (`Home > Shopify Flow > Reference`), always ending in the immediate parent, with the middle collapsing to "..." when narrow. A leaf page gets back to its hub in one tap.
2. A hub page per section that is intro prose plus an "In this section" list of links at the bottom, plain titles, no descriptions. The hub says what the section is for, then lists the pages.
3. An "On this page" list of anchors after the intro on any page with two or more h2 sections, in the main column at every width. No sticky rail.
4. A section tree behind a "Contents" dropdown button beside the breadcrumb, with the current section expanded and short labels. Same control at every width.
5. A fixed page template for each kind of item (reference items: data or fields, testing, linked items, templates), so the h2 names are the navigation, and items link to the items of the other kind that work with them.
6. Inline links in the first paragraph and in callouts as the only sideways links; no next/previous and no related-pages block. Plus per-section "Helpful / Not helpful" buttons and one search-or-ask box that returns matching pages and a short answer.
