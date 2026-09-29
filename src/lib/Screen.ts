/**
 * The screen tier's spec: what each kind of text slot is for and which
 * control does which job. The glossary in `Domain.ts` owns the words; this
 * file owns the sentences and the controls around them. Two tables and a
 * tone list, in the shape of the action matrices on `Domain.runActions` and
 * the data-model rows on `D1_TABLES`: a copy change starts at the row, and a
 * component whose JSDoc explains its copy names the slot it fills and links
 * here rather than restating the rule. A site that follows a different rule
 * says so and why in its own JSDoc (the Cancel workflow modal's dismiss on
 * the order page).
 *
 * "screen" is the tier a person reads: string literals, JSX text, headings
 * and labels. A "page" is one route on it, a "modal" is a dialog over one,
 * and "copy" is its words.
 *
 * `pnpm spec check` parses both tables: every {@link CopySlot} literal has
 * one row, and each row's example is found verbatim in a merchant or member
 * screen, so the table cannot cite copy that was since rewritten.
 * `scripts/copy-audit.ts` inventories the screens by these slots.
 * `scripts/lib/rules-lint.ts` holds the mechanical half: the retired words,
 * the copy words wrong in every slot, and no placeholder on a text area.
 *
 */
import { Schema } from "effect";

/**
 * The kinds of text slot a screen has, and what goes in each.
 * `scripts/copy-audit.ts` tags every string it finds with one.
 *
 * Tone, every slot:
 *
 * - Plain words at the level of the shop's staff, and the glossary's nouns
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
 *
 * Copy, one row per slot. `example` is a string a screen shows today:
 *
 * | slot        | job                                                                                             | form                                                                                                         | empty when                                                             | example                                     | never                                                          |
 * | ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
 * | heading     | says what the page or modal is; a modal that asks, asks                                         | a noun phrase, or a question ending in "?" that names the thing ("Block <item> on <order>?")                 | (never)                                                                | Change workflow?                            | repeats the nav; explains                                      |
 * | label       | names the field                                                                                 | a noun                                                                                                       | hidden when the heading or the placeholder already says it             | Reason                                      | a sentence; a question                                         |
 * | placeholder | shows the shape of a value, names a search's target, or is a select's unselected option         | "e.g." + a value; "Search by <field>"; "Choose <noun>"                                                       | the field is free text; the label already says what goes in           | e.g. Engrave                                | a question; an instruction; filler                             |
 * | help        | states a constraint or consequence the person can trip on                                       | one or two sentences, present tense                                                                          | there is none                                                          | Optional. A member with no team has nothing to do yet. | tells the future ("You'll add X next"); restates the label |
 * | empty       | says why the list is empty; for a view, echoes the view's label                                 | one sentence of fact; a second names the act only when it is off-screen, with the screen's heading as a link | (never)                                                                | Nothing is blocked.                         | apologises; links to an act on this screen; more than two sentences |
 * | banner      | a fact about the page that changes what the person can do                                       | fact, then effect on this page, then what clears it; three sentences at most                                 | the fact is already a view or a badge                                  | Turn on is unavailable                      | carries a button the page already has                          |
 * | toast       | confirms a write                                                                                | the verb in past form, or "<noun> saved"; no period unless it is two sentences                               | the result is visible where the person is looking                      | Note saved                                  | an exclamation mark; a period on one phrase                    |
 * | error       | says what was refused and what to do                                                            | what to do ("Enter a name"), or what happened then the fix; a failed write starts "Couldn't"                 | (never)                                                                | Enter a name                                | "invalid"; "required"; a code; "something went wrong" alone    |
 * | confirm     | the body of a modal that asks: the consequence of the verb                                      | one or two sentences saying what happens and what survives                                                   | the verb is reversible on the same screen (then there is no modal)    | Your unsaved changes will be lost.          | "Are you sure"; restating the heading                          |
 * | link        | takes the person to a named place                                                               | the target screen's heading, or "<Verb> in Shopify"                                                          | the act is on this screen                                              | Fulfill in Shopify                           | "here"; "click"; a sentence                                    |
 * | button      | names the act                                                                                   | the glossary's verb label, or verb + noun ("Add step")                                                       | (never)                                                                | Add step                                    | an article ("Add a step"); a sentence                          |
 * | badge       | one state word                                                                                  | the glossary's screen word for the state                                                                     | (never)                                                                | No members                                  | a sentence                                                     |
 * | body        | a fact the screen has to say that no other slot carries                                         | one or two sentences                                                                                         | it restates a heading, badge, button or label                          | Each order synced from Shopify counts once. | idioms; "we"; a code word                                      |
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
 * | job                                                    | control                                                                                                   | never                                                      |
 * | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
 * | a verb that is reversible on the same screen           | a button; no confirm                                                                                      | a modal                                                    |
 * | a verb with no undo (block, cancel, delete, remove, discard) | a modal: heading "<Verb> <thing>?", body the consequence, primary the verb, dismiss Cancel          | a browser confirm; "Are you sure?"; Yes or OK              |
 * | free text on a run (note, reason)                      | one modal, one text area, no placeholder, cursor at the end, dirty guard                                  | inline editing                                             |
 * | a fact about the page that disables things             | a banner above the content, warning or critical                                                           | a toast; a badge                                           |
 * | a count of items needing work                          | a view on the row, and a badge on each row                                                                | a banner, unless the count disables something              |
 * | a list with nothing in it                              | one sentence in the list's place; the create button stays where it always is                              | an illustration; a link to an act on this screen           |
 * | a search with nothing matching                         | one sentence and a Clear search button                                                                    | an empty state                                             |
 * | a write whose result changes a badge on this screen    | the badge changes; no toast                                                                               | a toast repeating the badge                                |
 * | a write whose result is off-screen or closed a modal   | a toast with the verb                                                                                     | a banner                                                   |
 * | a field that refuses a value                           | the field's own error, on submit                                                                          | a banner; a toast                                          |
 * | leaving for another screen from body copy              | a link whose text is the screen's heading, only when the act is not on this screen                        | "here"; a link inside an empty sentence for an on-screen act |
 */
export const Control = Schema.Literals([
  "button",
  "modal",
  "banner",
  "view",
  "badge",
  "toast",
  "field error",
  "sentence",
  "link",
]);
export type Control = typeof Control.Type;
