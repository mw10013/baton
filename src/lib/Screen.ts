/**
 * The screens' spec: what each kind of text slot is for, which control does
 * which job, and which part draws each shape. The vocabulary in `Domain.ts`
 * owns the words; this file owns the sentences, the controls around them
 * and the shapes they sit in. Three tables and a tone list, in the shape of the action matrices on `Domain.runActions` and
 * the data-model rows on `D1_TABLES`: a copy change starts at the row, and a
 * component whose JSDoc explains its copy names the slot it fills and links
 * here rather than restating the rule. A site that follows a different rule
 * says so and why in its own JSDoc (the Cancel workflow modal's dismiss on
 * the order page).
 *
 * A "screen" is what a person reads: string literals, JSX text, headings
 * and labels. A "page" is one route on it, a "modal" is a dialog over one,
 * and "copy" is its words.
 *
 * `pnpm spec check` parses the three tables: every {@link CopySlot} literal
 * has one row, and each row's example is found verbatim in a merchant or
 * member screen, so the table cannot cite copy that was since rewritten;
 * every {@link ScreenPart} literal has one row, naming a component that
 * exists and only {@link ScreenTemplate} words.
 * `scripts/copy-audit.ts` inventories the screens by these slots.
 * `scripts/lib/rules-lint.ts` holds the mechanical half: the retired words,
 * the copy words wrong in every slot, no placeholder on a text area, and no
 * layout in a route (`layoutHits`).
 *
 */
import { Schema } from "effect";

/**
 * The kinds of text slot a screen has, and what goes in each.
 * `scripts/copy-audit.ts` tags every string it finds with one.
 *
 * Tone, every slot:
 *
 * - Plain words at the level of the shop's staff, and the vocabulary's nouns
 *   and verbs. No code word reaches a screen: "work", "run", "stored",
 *   "sync window", "unassigned" are the implementer's.
 * - Contractions, as Shopify's grammar guide asks
 *   (`refs/shopify-docs/docs/apps/design/content/grammar-and-mechanics.md`):
 *   "Couldn't load orders", "You don't have access", "it's off".
 * - Facts, not feelings: no apology, no congratulation, no "oops", no
 *   "great", no "successfully".
 * - The person is "you". A member reads "the merchant", never "your
 *   merchant" or "the shop owner". Nothing is "we". Baton names itself only
 *   in a page title, the home heading, and when it is the one refusing (a
 *   limit it set).
 * - Present tense for a state ("Nobody can work this"), past for a
 *   confirmation ("Note saved").
 * - One idea per sentence. Two sentences is the ceiling for anything in a
 *   list or under a field; three for a banner or a modal body.
 * - Sentence case everywhere; "·" between facts on one line ("Brass hinge
 *   ×2 · Finishing"); no dash inside a sentence.
 * - A slot with nothing to say is empty. Filling it is the failure mode
 *   (Shopify, `voice-and-tone.md`, "Don't add extra text just to fill
 *   space").
 * - One fact, one place. A disabled control, an empty canvas, an open form
 *   and a badge each state a fact, and nothing restates one of them: not a
 *   banner over them, not a line under them.
 *
 * Copy, one row per slot. `example` is a string a screen shows today:
 *
 * | slot        | job                                                                                             | form                                                                                                         | empty when                                                             | example                                     | never                                                          |
 * | ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
 * | heading     | says what the page or modal is; a modal that asks, asks                                         | a noun phrase, or a question ending in "?" that names the order or the record ("Block <order>?"); an item goes in the body; a modal that asks names a capped name or the order number in its heading and puts any other token in its body ("Delete member?") | (never)                                                                | Change workflow?                            | repeats the nav; explains                                      |
 * | label       | names the field                                                                                 | a noun                                                                                                       | hidden when the heading or the placeholder already says it             | Reason                                      | a sentence; a question                                         |
 * | placeholder | shows the shape of a value, names a search's target, or is a select's unselected option         | "e.g." + a value; "Search by <field>"; "Choose <noun>"                                                       | the field is free text; the label already says what goes in           | e.g. Engrave                                | a question; an instruction; filler                             |
 * | help        | states a constraint or consequence the person can trip on                                       | one or two sentences, present tense                                                                          | there is none; the field or its neighbours already say it              | They sign in with this email. No Shopify account needed. | tells the future ("You'll add X next"); restates the label; states a number the field enforces; names the reader when the form does |
 * | empty       | says why the list is empty; for a filter value, echoes its label                                | one sentence of fact; a second names the act only when it is off-screen, with the screen's heading as a link | (never)                                                                | Nothing is blocked.                         | apologises; links to an act on this screen; more than two sentences |
 * | banner      | a fact about the page that changes what the person can do                                       | fact, then effect on this page, then what clears it; three sentences at most; critical or warning for a fault, success for a state that ends the page's work and carries its one act, off-screen; never info | a disabled control, an empty canvas, an open form, a badge or another banner on the page already states the fact | Every item is done.                         | carries a button the page already has; restates a disabled control |
 * | toast       | confirms a write, or says why a press did nothing                                               | the verb in past form, or "<noun> saved"; a fact in the present tense; no period unless it is two sentences  | the result is visible where the person is looking                      | Note saved                                  | an exclamation mark; a period on one phrase                    |
 * | error       | says what was refused and what to do                                                            | what to do ("Enter a name"), or what happened then the fix; a failed write starts "Couldn't"                 | (never)                                                                | Enter a name                                | "invalid"; "required"; a code; "something went wrong" alone    |
 * | confirm     | the body of a modal that asks: the consequence of the verb                                      | for a delete, "This can't be undone.", after a sentence naming the record when the heading cannot ("Delete <email>?"); for another verb, one or two sentences saying what happens and what survives | the verb is reversible on the same screen (then there is no modal)    | This can't be undone.                       | for a delete, explains what the product does; "Are you sure"; restating the heading |
 * | link        | takes the person to a named place                                                               | the target screen's heading, or "<Verb> in Shopify"                                                          | the act is on this screen                                              | Fulfill in Shopify                           | "here"; "click"; a sentence                                    |
 * | button      | names the act                                                                                   | the vocabulary's verb label, or verb + noun ("Add step")                                                       | (never)                                                                | Add step                                    | an article ("Add a step"); a sentence                          |
 * | badge       | one state word                                                                                  | the vocabulary's screen word for the state                                                                     | (never)                                                                | No members                                  | a sentence                                                     |
 * | body        | a fact the screen has to say that no other slot carries                                         | one or two sentences                                                                                         | it restates a heading, badge, button or label; it explains the product beside content (the explanation is the empty state's) | Nobody is on this team, so its tasks wait until a member joins. | idioms; "we"; a code word; a sentence about the product above a list that has rows |
 *
 */
export const CopySlot = Schema.Literals([
  "heading",
  "label",
  "placeholder",
  "help",
  "empty",
  "banner",
  "toast",
  "error",
  "confirm",
  "link",
  "button",
  "badge",
  "body",
]);
export type CopySlot = typeof CopySlot.Type;

/**
 * The controls the controls table hands out: a hang point for the table, the
 * way `D1_TABLES` is for D1's rows; nothing reads it yet.
 *
 * Controls, one row per job. The control is the same wherever the job
 * recurs, so two corners of the app answer one question the same way:
 *
 * | job                                                                               | control                                                                                                           | never                                                        |
 * | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
 * | a verb that is reversible on the same screen                                      | a button; no confirm                                                                                              | a modal                                                      |
 * | a verb with no undo (block, cancel, delete, discard)                              | a modal: heading "<Verb> <thing>?", body the `confirm` slot, primary the verb, dismiss Cancel                     | a browser confirm; "Are you sure?"; Yes or OK                |
 * | free text on a run (note, reason)                                                 | one modal, one text area, no placeholder, cursor at the end, dirty guard                                          | inline editing                                               |
 * | a fact about the page that disables things                                        | a banner above the content: critical or warning for a fault, success for a state that ends the page's work and carries its one act, off-screen ("Every item is done. Fulfill in Shopify"); never info, because a fact that only informs is a line or a badge, and Baton never dismisses a banner while Polaris's info banner is the dismissible kind | a toast; a badge; a banner for a fault that disables nothing (that is a badge on the thing) |
 * | a write in flight                                                                 | `loading` on the pressed button                                                                                   | a status line; a Saved, Saving or Syncing sentence           |
 * | a text limit                                                                      | free text (note, reason, instructions) counts down in its `details` from `noteCountFrom` (`ShopWork.ts`), "N characters left"; a one-line field shows nothing; both refuse on submit with the field's own error, "Up to N characters" (the `TextLimit` part) | `maxLength` on the element (Polaris draws `n/max` on an empty field); a hand-made counter; a limit in help text |
 * | a choice among records                                                            | a select of names                                                                                                 | a count or state in the option label                         |
 * | a date on a table row                                                             | only when the list is ordered by it (Placed on orders) or a recent change is a reason to open the row (Updated on workflows) | Created; On team since                                       |
 * | a count of items needing work                                                     | a cell on the strip, or a value of the main filter, with its count; and a badge on each row                       | a banner, unless the count disables something                |
 * | a list with nothing in it                                                         | one sentence in the list's place; the create button stays where it always is                                      | an illustration; a link to an act on this screen             |
 * | a search with nothing matching                                                    | one sentence and a Clear search button                                                                            | an empty state                                               |
 * | a search is on                                                                    | the filters are replaced by one line saying how many rows match and a Clear search button; the search field stays | filters that look set but do nothing                         |
 * | a write whose result changes a badge on this screen                               | the badge changes; no toast                                                                                       | a toast repeating the badge                                  |
 * | a write whose result is off-screen or closed a modal, or a press that did nothing | a toast with the verb, or with the fact that made the press do nothing                                            | a banner                                                     |
 * | a field that refuses a value                                                      | the field's own error, on submit                                                                                  | a banner; a toast                                            |
 * | leaving for another screen from body copy                                         | a link whose text is the screen's heading, only when the act is not on this screen                                | "here"; a link inside an empty sentence for an on-screen act |
 * | a verb that replaces a run with a record on it (started, done, blocked, or a note) | the verb's modal carries the consequence as its `confirm` slot: what is lost; nothing when the run is untouched   | a second modal; a warning on an untouched run                |
 * | a filter that can be off                                                          | a select whose first option is "Any <noun>" with {@link ANY_OPTION_VALUE} as its value                            | an option with an empty value                                |
 * | a filter beside a search                                                          | a select with its label hidden on screen and kept for screen readers; the main filter left of the search          | a visible label over the row                                 |
 * | a member list cut at a depth                                                      | a tertiary button "Show <n> more of <m>" under the rows; at the deepest read, one sentence saying how many show and what narrows the list | a disabled button; pages                                     |
 * | a list of things the merchant creates | an index page: a table, one row per thing, the thing's name a link to its page; no buttons on a row | row buttons that edit or delete |
 * | creating a thing | Create <noun> in the title bar; a modal that asks only for what identifies the thing; on success, the thing's page | asking for its relations in the create modal |
 * | everything about one thing | its details page: the heading is its name, printed whole again in its Details card when it is a token; its edits and its delete are there and nowhere else | a second place that edits it |
 * | a field of the thing (its name) | Rename in More actions; a modal with one field | inline editing |
 * | a set the thing holds (a team's members, a member's teams) | a section on the details page, one row per related thing, its name a link; an Add button (Add members, Add to teams) opens a modal of candidates only, with a search from six; Remove on each row | a checklist of everything, saved whole |
 * | a related set on an index row | a count; a badge when it is zero and that is a fault (No members, No teams) | the names; chips; `+N` |
 * | deleting a thing | Delete on its page; the modal: heading "Delete <name>?" for a capped name, "Delete <noun>?" with the name in the body when it is a token; body the `confirm` slot; primary Delete (critical), dismiss Cancel; on success, the index and a toast "<Noun> deleted" | a delete on an index row; a body that explains the product |
 * | taking a thing out of a set | Remove, on the row in the set; no modal and no toast, because Add puts it back on the same screen | "Remove" for a delete |
 * | More actions with one entry | the entry as a secondary button in the title bar | a menu with one item |
 * | a merchant table with more rows than its page | `s-table paginate`, read from the server a page at a time, the page in the URL; 25 rows on an index, 10 on a details page; the controls only when there is another page; Previous is the browser's Back when that table's Next pushed the entry, else page one | Show more; loading every row and hiding some; a Back that moves another table's page |
 * | going back from a member page to the list that opened it                          | a back-arrow link named for the list on its own line above the heading; a history step back when the list opened the page, so its depth and scroll return | the app's mark as the only way back; a breadcrumb slot a phone folds into a menu |
 */
export const Control = Schema.Literals([
  "button",
  "modal",
  "banner",
  "filter",
  "badge",
  "toast",
  "field error",
  "sentence",
  "link",
]);
export type Control = typeof Control.Type;

/**
 * The value of a select's "Any <noun>" option, the one that turns the filter
 * off. Not `""`: an `s-option` with an empty value reports its label as its
 * value, as a native option does, so a select whose `value` is `""` matches
 * no option and shows the first one only by the browser's fallback. With a
 * value every option can be matched, the chosen option is the select's
 * answer rather than the browser's, and a test reads the value instead of
 * the checked option's text. The screen maps it to `null` on change and back
 * on render; it never reaches a URL or a read.
 */
export const ANY_OPTION_VALUE = "any";

/**
 * The template a screen is an instance of: Shopify's App Home templates
 * (`refs/shopify-docs/docs/api/app-home/latest/patterns/templates/`), so a
 * merchant moving from the Shopify admin to Baton, and a member moving
 * between Baton's screens, meet the same anatomy each time. The Screens table
 * in `Domain.ts` gives every screen one in its `template` column, and the
 * parts table's `used on` column names these words only.
 *
 * | template | Shopify's        | what it is                                                                   |
 * | -------- | ---------------- | ---------------------------------------------------------------------------- |
 * | index    | Index            | a list of one kind of record: a frame, its filters and its rows              |
 * | details  | Details          | one record: a heading that names it and cards of its facts                   |
 * | homepage | Homepage         | the app's landing page: what needs the merchant, and where to go             |
 * | editor   | Details, editing | one record being changed, with a save bar: the workflow editor               |
 */
export const ScreenTemplate = Schema.Literals([
  "index",
  "details",
  "homepage",
  "editor",
]);
export type ScreenTemplate = typeof ScreenTemplate.Type;

/**
 * The parts: the spec for shape, beside the copy table (words) and the
 * controls table (jobs). A part is a component under
 * `src/components/screen/`, or a Polaris element where Polaris has the shape;
 * it takes content (children, strings, data) and never a spacing or layout
 * prop, and it uses only the three distances and the one breakpoint in
 * `src/components/screen/layout.ts`. Routes and the other components
 * compose parts and lay out nothing: `scripts/lib/rules-lint.ts` refuses a
 * layout primitive or a layout prop in `src/routes/` and in
 * `src/components/` outside `src/components/screen/` (`layoutHits`). So a
 * screen cannot choose a different gap, because it cannot choose a gap, and
 * two screens that show the same kind of thing render the same component
 * rather than agree to build it alike.
 *
 * Order of work: a shape change starts at the row, then the part, then the
 * kit page (`/dev/kit`, every part once with the seed's worst cases), then
 * the screens. A screen that needs a shape no part has gets a new part and a
 * row, the way a new word gets a vocabulary row. A part's JSDoc holds its
 * reasoning and names its row.
 *
 * Parts, one row per part. `component` names a file under
 * `src/components/screen/` or a Polaris element; `used on` names
 * {@link ScreenTemplate} words:
 *
 * | part           | job                                                                                  | component                           | fixes                                                                                                      | used on                           | never                                               |
 * | -------------- | ------------------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------- |
 * | index section  | the list's frame: one card holding its head (banners, strip or search line, filter row) and the list | `IndexSection`  | frame, padding none; `base` around and between the head's things                                           | index                             | a card in a card; a second list in one card         |
 * | strip          | counts that are also the main filter                                                 | `Strip`                             | one column per cell above the breakpoint and three below; cell padding; the count at the cell's foot      | index                             | a red cell; a cell that comes and goes with the data |
 * | filter row     | the main filter, the search and a secondary filter                                   | `FilterRow`                         | columns (10rem, the rest, 12rem) above the breakpoint, stacked below                                      | index                             | a visible label over the row; the table's filters slot |
 * | search field   | the list's search                                                                    | `ListSearchField`                   | submits on Enter and blur                                                                                  | index                             | a debounce; a character counter                     |
 * | search line    | how many rows a search matches, and Clear search, in the filters' place              | `SearchLine`                        | the sentence's form; `base` to its button                                                                  | index                             | filters that look set but do nothing                |
 * | index table    | the merchant's rows                                                                  | `s-table`                           | columns, pagination, the list slots on a phone                                                             | index                             | a resource row                                      |
 * | resource row   | the member's row: line one and the menu side by side, the lines below the full width | `ResourceRow`                       | line one's clamp and weight; the menu cell one line tall; `small-300` between lines; the rule above       | index                             | a second link; a verb outside the menu              |
 * | show more      | the deeper read at a list's foot                                                     | `ShowMore`                          | padding; the rule above; "Show n more of N"                                                               | index                             | revealing rows the page already holds               |
 * | empty line     | one sentence in the list's place, and at most one way out                            | `EmptyLine`                         | centred; at most 450px wide                                                                                | index                             | an illustration; a link to an act on this screen    |
 * | details card   | a section of a details page                                                          | `s-section`                         | Polaris's card padding                                                                                     | details, homepage, editor         | a card inside a card                                |
 * | member area    | the member area's root: every member screen inside it                               | `MemberArea`                        | `overflow-wrap: anywhere` for every token on a member screen                                               | index, details                    | a table or badge a mid-word break would spoil       |
 * | page body      | a page of plain content rather than cards: the member's workflow page                | `PageBody`                          | `base` between things; the phone inset that lines text up with the heading                                | details                           | a card around the content                           |
 * | lines          | the lines of one thing: a label over its value, a note over its button              | `Lines`                             | `small-300` between lines                                                                                  | index, details, homepage, editor  | two things that do not belong together              |
 * | inline row     | things side by side, wrapping: a name and its badge, a row of buttons               | `Inline`                            | `small-300` between things; centred on the line                                                            | index, details, homepage, editor  | a column layout                                     |
 * | framed list    | entries that make one stop, in one bordered box with a rule between them             | `FramedList`                        | the border, the rules, `small-300` padding                                                                 | details                           | a box per entry                                     |
 * | step list      | a run's steps in order: a caption over each step's framed list                       | `StepList`                          | an ordered list; `base` between steps, `small-300` from caption to box                                     | details                           | a step without its caption                          |
 * | pairs          | label / value pairs in two aligned columns: an item's properties                     | `Pairs`                             | the label column `minmax(0, max-content)`; the label a token                                              | details                           | a label column wider than the screen                |
 * | things         | things in one place that are not one thing's lines: a section's banners and content    | `Things`                            | `base` between things                                                                                      | index, details, homepage, editor  | the lines of one thing                              |
 * | fields         | a form's fields, stacked                                                             | `Fields`                            | `base` between fields, so one field's error never runs into the next label                               | index, details, editor            | a field beside a field                              |
 * | panel          | a box inside a card: a task card, the order page's Manage drawer, the editor's add form | `Panel`                           | `base` padding; a solid border, a subdued fill or a dashed border by kind                                  | details, editor                   | a box inside a panel                                |
 * | select row     | a select and the button that submits it, side by side                                | `SelectRow`                         | the select at most 20rem and shrinking; the button beside it at every width                               | details                           | a select that pushes its button to the next line    |
 * | tiles          | tiles side by side where there is room, one column where there is not               | `Tiles`                             | `repeat(auto-fit, minmax(300px, 1fr))`; `base` between tiles                                              | homepage, details                 | a breakpoint                                        |
 * | meter tile     | one capacity meter as a link: dimension, number, bar, sentence                       | `MeterTile`                         | `base` padding, the border, `small-300` between lines                                                      | homepage                          | a bar rescaled past its limit                       |
 * | table frame    | a table inside a details card, framed                                               | `TableFrame`                        | the border and its rounded corners                                                                         | details                           | a table floating in a padded card                   |
 * | end            | content set at the end of its cell: a table's action column                          | `End`                               | the end edge                                                                                               | details                           | a column of buttons at ragged positions             |
 * | empty aside    | an aside with nothing in it, holding the page's aside column open                    | `EmptyAside`                        | the aside column's width while nothing is selected                                                         | editor                            | a card with nothing in it                           |
 * | back link      | the way back to the list a page was opened from, on its own line above the heading   | `BackLink`                          | lined up with the page's column, the arrow on its edge                                                     | details                           | a breadcrumb slot a phone folds into a menu         |
 * | top bar        | the member area's bar above the page: the mark and shop as the link home, the session at the end | `TopBar`  | the bar's border and padding; start and end, wrapping on a narrow phone                                    | index, details                    | anything that belongs to the screen below it        |
 * | mark           | the Baton mark                                                                       | `BatonMark`                         | a block that never shrinks in a row                                                                        | index, details                    | text beside it inside the svg                       |
 * | selectable card | a card that can be chosen: a task card in the workflow editor                       | `SelectableCard`                    | the card's padding; the chosen card filled with a strong border                                            | editor                            | a card that moves when it becomes choosable         |
 * | connector      | the arrow between two stops of a step flow                                           | `Connector`                         | centred on the column                                                                                      | details, editor                   | an arrow before the first stop                      |
 * | code block     | preformatted text in a subdued box: a stack trace                                    | `CodeBlock`                         | `base` padding; a long line scrolls inside the box                                                         | details                           | a line that widens the page                         |
 * | text limit     | the countdown and the submit error of a field with a cap                             | `TextLimit`                         | nothing; props only: `details` from `noteCountFrom`, the error "Up to N characters" | index, details, editor | `maxLength`; a counter on an empty field |
 * | capped name    | a team, task or workflow name                                                        | `Name`                              | on a list: whole, wraps; on its home: whole, wraps; in a cutting control: allowed                         | index, details, homepage, editor  | an ellipsis on a list                               |
 * | Shopify text   | an item title, a variant, an item property                                           | `Clamp`                             | on a list: two lines and an ellipsis; on its home: whole, wraps; in a cutting control: never              | index, details, homepage, editor  | a badge, chip or select option                      |
 * | free text      | a block reason, a note, task instructions, an order note                             | `Clamp`, `Prose`, `ClampedProse`    | on a list: two lines; on its home: `Prose`, a block reason `ClampedProse`; in a cutting control: never   | index, details, homepage, editor  | collapsed line breaks                               |
 * | token          | a SKU, a tag, an order number, an email, a shop domain                               | `Token`                             | on a list: whole, wraps anywhere, a link when it names a page; on its home: the same; in a cutting control: the order number; a title bar, when the same page prints the token whole in a field | index, details, homepage, editor  | a box wider than the screen                         |
 * | fixed words    | a state, the step, a count, a time                                                   | `s-text`                            | after a name that wraps, or ahead of a clamp                                                               | index, details, homepage, editor  | inside a clamp, or after one on its line            |
 *
 * The text-fit rows (capped name to fixed words) sort every printed value by
 * where it comes from and whether it is capped. Baton chose the caps on a
 * capped name, so its worst case is known and it is shown whole. Shopify text
 * and free text are uncapped or long, so a list clamps them, and each has one
 * home where it prints whole (the member's workflow page and the order page;
 * a tag's is the merchant's workflow page). A cutting control (a badge, chip,
 * select option, title bar or toast) cuts to one line with no way to read the
 * rest, so it takes only a capped value.
 */
export const ScreenPart = Schema.Literals([
  "index section",
  "strip",
  "filter row",
  "search field",
  "search line",
  "index table",
  "resource row",
  "show more",
  "empty line",
  "details card",
  "member area",
  "page body",
  "lines",
  "inline row",
  "framed list",
  "step list",
  "pairs",
  "things",
  "fields",
  "panel",
  "select row",
  "tiles",
  "meter tile",
  "table frame",
  "end",
  "empty aside",
  "back link",
  "top bar",
  "mark",
  "selectable card",
  "connector",
  "code block",
  "text limit",
  "capped name",
  "Shopify text",
  "free text",
  "token",
  "fixed words",
]);
export type ScreenPart = typeof ScreenPart.Type;
