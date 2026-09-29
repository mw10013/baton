# A UI spec the way the domain has one: copy, controls, and how to audit what is there

## The case that prompted this

The member's Block modal shows the field label "Reason" and, inside the empty field, the placeholder "What is stopping this? Who needs to know?" (`src/components/RunTextModals.tsx`, `BlockModal`).

The placeholder was never asked for. The instruction was "a modal that blocks, with a reason field", and the placeholder is what the implementer filled in because a text field has a `placeholder` attribute and nothing said whether to use it. The modal's JSDoc explains the heading ("asks the question, naming the run as the member's row does") and the primary button, and says nothing about the placeholder, because no rule asked it to.

This is the shape of every case like it: **a slot existed, no rule said what goes in it or whether it stays empty, and the implementer filled it with its best guess.** The guess is local to one session, so the next session's guess for the next slot does not match it. The fix is not a better sentence in this one slot. It is a rule for slots, and a way of reading the guesses already made.

The domain went through the same thing and now has a working answer. This doc asks what the equivalent is for the screen.

## Why "screen", and the alternatives

The doc says "screen" because the glossary already does. `Domain.ts` uses it in three places that this spec has to agree with: the "screen tier" (the string literals, JSX text, headings and labels, as against the "domain tier" of identifiers and JSDoc), the "screen columns" of the glossary tables (what a screen calls a task state, a verb, an issue), and the "Screens table" that names every merchant and member page by a spec name. `scripts/lib/rules-lint.ts` calls its check "the glossary's screen rule" and `AGENTS.md` says "screen copy". So "screen" is the word the repo already uses for the thing this spec governs: what a person sees and reads, as distinct from what the code calls it.

The word is not about devices. Nothing here depends on phone or tablet layout, and the merchant side is always the Shopify admin in a desktop browser.

Alternatives, with what each would cost:

| word   | what it names well                                                 | what it names badly                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| screen | one thing a person looks at, and the tier of words they read on it | nothing in particular; the only cost is that it sounds like hardware to a reader who has not seen the glossary                                                                                                       |
| page   | one route: the orders index, the order page                        | a modal, a toast, a banner, and the tier itself: a "page tier" would exclude the Block modal, which is the case in hand. `Domain.ts` uses "page" 126 times, always for one route, and that meaning should stay exact |
| UI     | everything the person sees                                         | it is an acronym, the glossary is plain words, and "UI text" and "UI spec" read as the implementer's side of the line rather than the person's                                                                       |
| copy   | the words only                                                     | not the controls table, and not the tier                                                                                                                                                                             |

Recommendation: keep "screen" for the tier and the file (`Screen.ts`), keep "page" for one route, keep "copy" for the words. That is what the glossary means by each today, and it costs one sentence in the JSDoc on `Screen.ts` to say so: "screen" is the tier a person reads, a "page" is one route on it, "copy" is its words. Renaming the tier would touch the glossary, the lint, `AGENTS.md` and the spec check together, for a word that is not wrong.

## What we hold as fixed

- The implementation is the implementer's. The human reads specs and tests, not code paths. A spec is the human's lever on a black box.
- A spec is JSDoc in `src/`, short, tabular where it can be, linked with `{@link}` from the sites that follow it. Pages of prose mean the approach is wrong.
- `docs/` is scratch. This file will be deleted; what survives is what it changes in `src/`, `scripts/` and `AGENTS.md`.
- No per-string spec and no per-string test. "The Block placeholder reads X" as a test is duplication that goes stale and pins nothing worth pinning.
- The spec guides, it does not dictate. The implementer will still choose words. The spec says what kind of words, and which slots stay empty.

## Why the domain approach works, mechanism by mechanism

The domain side is not one thing. It is five mechanisms that each catch a different failure, and the screen side can copy them one by one.

| mechanism                                     | what it fixes                                  | domain instance                                                                                        | screen counterpart                                                                                  |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| a vocabulary with retired words               | two sessions naming one thing two ways         | the glossary; `RETIRED` in `scripts/lib/rules-lint.ts`                                                 | already exists for nouns and verbs; missing for copy words ("please", "successfully", "oops", "…")  |
| a rule stated once on the symbol that owns it | a second site inventing a stricter/looser rule | `runActions`, `taskActions`, `D1_TABLES`, `initializeSchema`                                           | a copy-slot table and a controls table on one symbol; components link to it                         |
| a table the human reads at a glance           | the human cannot review prose specs at scale   | the action matrices, the data-model rows                                                               | one row per slot: job, form, example, never                                                         |
| a mechanical check for the mechanical part    | drift the human will not notice in review      | `pnpm spec check` (labels equal glossary cells), `rules-lint` (no inline predicates, no retired words) | extend `rules-lint` with copy words; a spec check that the slot table parses and its examples exist |
| a test whose title is the rule                | a behaviour rule silently violated             | "is refused once downstream started"                                                                   | none for copy. Controls rules that are behaviour (a critical verb confirms) may get one             |

The one thing the domain has that copy cannot have is the last row. Copy has no behaviour to pin, so the check is the lint, the table, and the human's eye during the audit. That is acceptable because copy drift is cheap to fix and visible on screen; a domain rule drifting is neither.

## What the screen spec is about

Three layers, from the one that already exists to the one that should stay thin.

**1. Words.** Which nouns and verbs a screen says. Done: the glossary's screen columns and `RETIRED`. Not repeated here.

**2. Copy.** What each kind of text slot is for, what form it takes, and when it is left empty. This is where the Block placeholder went wrong and where most of the merchant's "this looks off" reactions will land. One table.

**3. Controls.** Which control does which job: when a change gets a modal and when it is inline, which verbs confirm, when a banner and when an empty state, whether links belong in body copy. This is where "different areas feel like different apps" comes from. One table.

Per-screen specs (what the orders index shows, in what order) are a fourth layer and the glossary's Screens table is the start of one. That layer is out of scope here; it is where the action matrices and the order-detail state model already live, and adding to it is a different research.

## Where the spec hangs

Four options were considered.

**A. A new `src/lib/Screen.ts` with one exported symbol.** The file that is to copy what `D1Schema.ts` is to D1: an export that has a real reader, and the JSDoc rides on it. The symbol is `CopySlot`, a `Schema.Literals` of the slot names (`heading`, `label`, `placeholder`, `help`, `empty`, `banner`, `toast`, `error`, `confirm`, `link`). Its readers are the audit script, which tags every string it extracts with a slot, and `pnpm spec check`, which parses the table and checks each slot row names a slot the literal has. Components `{@link Screen.CopySlot}` in the JSDoc sentence that explains their copy.

**B. Rules on the components that own the slot.** `TextModal` carries the placeholder rule, `SocketBanner` the banner rule, each empty state its own. This is where the reasoning for the Block heading already lives, and it is right for the reasoning behind one instance. It is wrong for the rule: there are three `s-text-area`s and eleven `s-text-field`s across seven files with no shared component, so a rule on one of them is not stated once.

**C. A section in `AGENTS.md`.** Short, always loaded. But not linkable from a JSDoc, not parseable, and it is instructions to the implementer rather than a spec the human reviews. `AGENTS.md` should get one line pointing at the symbol, the way it points at `runActions` and `D1_TABLES`.

**D. A markdown style guide in `docs/`.** Refused by the standing rule: `docs/` goes stale and `src/` may not cite it.

Recommendation: **A for the two tables, B for per-instance reasoning, C for the pointer.** This is the split the domain already uses: the rule on `Domain.runActions`, the reasoning on `BlockModal`, the pointer in `AGENTS.md`.

Name: `Screen.ts`, not `Copy.ts` or `Ui.ts`, because the controls table is not copy and "screen" is the glossary's word for the tier. The Screens table itself stays in `Domain.ts`; it is vocabulary.

## Format of the copy table

One row per slot. Columns: what the slot is for, what form the text takes, when it is empty, an example from the code, and what it never does. The example column is checked by `pnpm spec check` to exist somewhere in `src/` verbatim, so the table cannot cite copy that was since rewritten. A draft, to be replaced by what the audit teaches:

| slot        | job                                                            | form                                                                              | empty when                                                                        | never                                                        |
| ----------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| heading     | says what the page or modal is; a modal that asks, asks        | a noun, or a question ending in "?"                                               | (never)                                                                           | repeats the app nav; explains                                |
| label       | names the field                                                | one noun                                                                          | hidden when the heading is the same word                                          | a sentence; a question                                       |
| placeholder | shows the shape of a value the label cannot ("e.g. Engrave")   | "e.g." + a value, or a search target ("Search by email")                          | the label already says what goes in; free text (a note, a reason)                 | asks a question; instructs; fills space                      |
| help        | says a constraint the field enforces                           | one sentence, present tense, states the rule                                      | there is no constraint the person could trip on                                   | restates the label; says "please"                            |
| empty       | says why the list is empty and, if there is one, the one act   | one sentence of fact; a second sentence with the act only if it is on-page        | (never; a list with nothing shows the sentence)                                   | apologises; links to another page; more than two sentences   |
| banner      | says a fact about the page that changes what the person can do | fact, then effect on this page, then what clears it; no more than three sentences | the fact is already visible in the list (an Issues count is a view, not a banner) | says "attention"; carries a button that the page already has |
| toast       | confirms a write the person just made                          | the verb's label in past form, or the noun saved ("Note saved")                   | the screen already shows the result (a badge flipped)                             | "successfully"; an exclamation mark                          |
| error       | says what was refused and what to change                       | what happened, then the fix, one sentence each                                    | (never)                                                                           | a code; "invalid"; "something went wrong" without what       |
| confirm     | makes the person name the thing they are about to change       | heading names the thing ("Block <item> on <order>?"); primary is the verb         | the verb is reversible on the same screen                                         | "Are you sure?"; a primary labelled OK or Yes                |
| link        | takes the person to a named screen                             | the screen's heading as the text                                                  | inside empty copy or banner copy (see controls)                                   | "here"; "click"; a verb                                      |

Read the Block modal through it. The heading is a question naming the thing: right. The label is one noun: right. The placeholder: the field is free text, so the slot is empty. The sentence in it is a question and an instruction, both in the "never" column. The fix is deletion, not a better sentence, and the same rule decides the Note modal, which already has no placeholder. That is the point of a slot rule: one row settles two modals and every future one.

Tone rules sit above the table as a short list, not rows, because they apply to every slot. Draft:

- Plain words at the level of a shop's staff; the glossary's words for the domain.
- Facts, not feelings: no apology, no congratulation, no "oops", no "great".
- The person is "you"; the app has no name in copy except the home heading; nothing is "we".
- Present tense for state ("Nobody can work this"), past for a confirmation ("Note saved").
- One idea per sentence. Two sentences is the ceiling for anything in a list; three for a banner.
- A slot that has nothing to say is empty. Filling it is the failure mode.

Shopify's own guidance (`refs/shopify-docs/docs/apps/design/content/voice-and-tone.md`, "Everyday tasks and activities": "Don't add extra text just to fill space, such as 'Add a note…'") says the same about placeholders, and the Polaris grade-7 target is the reading level to aim at. The spec cites that file, not `docs/`.

## Format of the controls table

One row per job, naming the control. This is the layer that gives sessions in different corners of the app the same answer. Draft, to be corrected by the audit:

| job                                                 | control                                                                            | never                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| a verb that is reversible on the same screen        | a button; no confirm                                                               | a modal                                                      |
| a verb with a critical tone (block, cancel, delete) | a modal whose heading names the thing and whose primary is the verb                | a browser `confirm`; "Are you sure?"                         |
| free text on a run (note, reason)                   | one modal, one field, cursor at the end, dirty guard                               | inline editing                                               |
| a fact about the page that disables things          | a banner above the content, warning or critical                                    | a toast; a badge                                             |
| a count of items needing work                       | a view on the row, and a badge on each row                                         | a banner, unless the count disables something                |
| a list with nothing in it                           | one sentence in the list's place; the create button stays where it always is       | an `s-empty-state` with illustration; a link to another page |
| a write that changed one badge                      | the badge changes; no toast                                                        | a toast repeating the badge                                  |
| a write whose result is off-screen                  | a toast with the verb                                                              | a banner                                                     |
| a field that refuses a value                        | the field's own error, on submit                                                   | a banner; a toast                                            |
| going to another screen from body copy              | the screen's heading as a link, at the end of the sentence, only in help and error | a link in a list's empty sentence; "here"                    |

The last row is the open question the merchant raised about links in empty copy. "No teams yet. Create one on Teams." in `MemberTeamsFields.tsx` and "Create one." on the order page are the cases. Recommendation: a link is allowed when the person cannot act on the current screen and the link names exactly the screen where they can; the empty sentence itself stays a fact. That keeps `MemberTeamsFields` (the workflow editor cannot create a team) and drops nothing. The audit will show whether every link fits that rule.

## Enforcement

What is mechanical goes in the lint, what is structural goes in the spec check, and the rest is the audit plus review.

- **`rules-lint`, copy words.** Add a second table of retired copy words beside `RETIRED`: `please`, `successfully`, `oops`, `sorry`, `are you sure`, `click here`, `here` as link text, a trailing ellipsis in a placeholder, `!` in a toast. Same grep, same test.
- **`rules-lint`, placeholder on a text area.** `s-text-area` with `placeholder=` is refused: free text never has one. One regex.
- **`pnpm spec check`.** Parse the two tables on `Screen.ts`; each slot row names a `CopySlot` literal; each example string is found verbatim in `src/`. The table cannot rot past the copy it cites.
- **Review.** A component JSDoc that explains its copy names the slot it fills and links the table, the way it already links the action matrix. A new string in a slot with no sentence explaining it is what review looks for.
- **No tests on strings.** The controls rows that are behaviour ("a critical verb confirms") already have tests where they matter (the modal's dirty guard); those keep their titles and the row cites them, `pinned by` style, if the human wants that column. Recommendation: not yet. Add the column when a controls row is broken by a change and a test would have caught it.

## The audit: methodology

The audit is a separate research doc. This section is how it should be done so the spec above is written from evidence rather than from the drafts here.

**1. Extract.** A script, `scripts/copy-audit.ts`, run once, not a check. It reuses `literalsOf` from `scripts/lib/rules-lint.ts` and the same `COPY_FILES` list, and emits one row per string literal or JSX text that has two or more words. Each row: file and line, the screen (from the route file, via the Screens table), the slot, the text, and whether it contains an `s-link`. The slot is inferred from the nearest attribute or element (`placeholder=` is placeholder, `heading=` is heading, text inside `s-banner` is banner, a string returned next to `NotFound` or a `Match.when` on a view is empty, and so on); unknown is left blank for the human. It skips the lint's exclusions (`admin.*`, `api.*`, `index.tsx`, `privacy.tsx`) and skips comments.

Expected volume, from a rough count: fourteen placeholders, about thirty banner bodies, a dozen empty sentences, forty-odd toasts and errors, and headings. Around two hundred rows. That is one sitting for the human, in a table.

**2. Group.** The doc orders rows by slot, then by screen, so the human reads all placeholders together, all empties together. Reading by slot is what surfaces the inconsistency; reading by screen is how it was written and hides it.

**3. Annotate.** The human marks each row keep, cut, or rewrite, with the rewrite where there is one, and marks links keep or cut. Through plannotator, as with the other research docs.

**4. Derive.** With the annotated table, the implementer writes the two tables and the tone list on `Screen.ts` from what the annotations agree on, and lists the rows where the human's choices disagree with each other as questions. The drafts above are replaced, not merged.

**5. Apply.** One change per slot, not per screen, so a session rewrites every placeholder against one rule rather than every string on one page. Each change updates the JSDoc sentences for the copy it touched. `rules-lint` gains the retired copy words the annotations retired.

**6. Delete the audit doc.** What survives is `Screen.ts`, the lint rows, and the rewritten copy.

Prior art in the repo: `docs/page-banners-research.md` is this method applied to one slot by hand (an inventory table, then a per-banner reading), and `docs/column-audit-research.md` did it for table columns. Both ended in decisions that were applied and the docs are due for deletion. The audit generalises step 1 so the inventory is not hand-built.

## Recommendations, summarised

1. Create `src/lib/Screen.ts` exporting `CopySlot`, with the copy table, the tone list and the controls table in its JSDoc. Write it after the audit, not before; the drafts here are to make the format concrete.
2. Extend `scripts/lib/rules-lint.ts` with a retired copy-words table and the text-area placeholder rule.
3. Extend `pnpm spec check` to parse the two tables and check slot names and example strings.
4. Write `scripts/copy-audit.ts` and run the audit as the next research: extract, group by slot, annotate, derive, apply by slot, delete.
5. Fix the Block modal now by deleting the placeholder, since the rule that decides it will not change with the audit.
6. Add one line to `AGENTS.md` under the action-matrix bullet: the copy and controls tables on `Screen.ts` are the spec for the screen tier; a copy change starts at the row.

## Questions

Each with a recommendation, so the answer can be yes.

**Q1. Is the slot table the right grain?** The alternative is a rule per component (`s-text-field`, `s-banner`, ...), which follows Polaris's own docs more closely. Recommendation: slots. A slot is the job the text does, and the same component fills several (an `s-paragraph` is help, empty or banner body depending on where it sits). The audit tags by slot, so the spec should speak the same word.

**Q2. Should the spec be written before the audit or after?** Recommendation: after, with the drafts here as a format sample only. Writing it first means the audit checks copy against a guess; writing it after means the table is what the human's two hundred decisions agree on. The one exception is the placeholder row, which is decided by the Block case alone.

**Q3. Do links belong in empty copy?** Recommendation: only when the act is not on this screen, and the link is the target screen's heading. That keeps the workflow editor's "Create one on Teams" and would make the order page's "Create one." link read "on Workflows". The audit will list every link so the rule can be checked against all of them before it is written down.

**Q4. Should `CopySlot` be a real schema, or is a `const` array enough?** Recommendation: `Schema.Literals`, like `TaskState`, so the audit script decodes its tag column through it and a typo in the table or the script fails the same way. It is small either way.

**Q5. Which retired copy words go into the lint now?** Recommendation: only the ones that are wrong in every slot ("please", "successfully", "oops", "sorry", "click here", "are you sure"). Words that are wrong in one slot only ("?" in a placeholder) are the text-area rule and the audit, not a global grep.

**Q6. Does the controls table belong in this change, or is it a second research?** Recommendation: same file, same change, because the audit will surface control choices alongside copy (a modal that should be inline, a banner that should be a view) and separating them means a second pass over the same rows. Keep the table to ten rows; if the audit wants twenty, the controls layer needs its own research.

**Q7. Should the member and merchant sides share one tone list?** Recommendation: yes, one list, with the glossary's "you"/"the merchant" rule as the only side-specific line. The member screens are the same shop's people; a second voice is a second thing to keep aligned.

## Decisions (2026-09-28)

- Recommendations 1 to 6 accepted: `Screen.ts` with `CopySlot` and the two tables, written after the audit; the lint and spec-check extensions; `scripts/copy-audit.ts` and the audit as the next research; delete the Block placeholder now; one line in `AGENTS.md`.
- Follow Shopify's content guidance (`refs/shopify-docs/docs/apps/design/content/`) as closely as possible; the tone list is written against it.
- Q1 slots, not components. Q2 spec after the audit. Q3 links only when the act is off-screen, text is the target screen's heading. Q4 `Schema.Literals`. Q5 only the words wrong in every slot go in the lint now. Q6 controls in the same file and change, capped at ten rows. Q7 one tone list for both sides.
- "screen" stays the word for the tier, "page" for one route, "copy" for the words (see the section above).

## Done so far (2026-09-28)

- The Block modal's placeholder is deleted and `TextModal` no longer takes one; the JSDoc on `BlockModal` says why.
- `scripts/lib/rules-lint.ts` retires "please", "successfully", "oops", "sorry" and "click here" in screen copy and refuses a placeholder on any `s-text-area`, with tests in `test/integration/rules-lint.test.ts`. "Are you sure" is not retired yet: `DISCARD_BODY` in `workflowShared.ts` says it, and that rewrite is the audit's.
- The screen file list is shared through `scripts/lib/copy-files.ts`.
- `scripts/copy-audit.ts` exists and `docs/ui-copy-audit-research.md` is its output, ready to annotate.
- Still to do, after the audit: `Screen.ts` with `CopySlot` and the two tables, the `pnpm spec check` extension, the `AGENTS.md` pointer to `Screen.ts`.

## Decisions (2026-09-29)

The audit (`docs/ui-copy-audit-research.md`, 380 strings) was annotated and every recommendation accepted: 68 rewrites, 12 cuts. Applied by slot, with these rules now on `Screen.ts`:

- Contractions throughout; a failed write starts "Couldn't".
- Sign in and Sign out on the member side; "Log in" is gone.
- A one-phrase toast has no period.
- "Work" is not a screen word; the member reads "this workflow".
- "The merchant" to a member, never "your merchant" or "the shop owner".
- A link's text is the target screen's heading, or "<Verb> in Shopify".
- One shape for every limit: "A shop can have N workflows. Delete one to add another."
- The dismiss verb is Cancel; Keep workflow on the Cancel workflow modal is the one exception and its comment says why.
- A view's empty sentence echoes the view's label.
- An error says what to do ("Enter a name").
- A section with a heading has no separate accessibilityLabel.
- Help text states a constraint, never the next step.

Also done: `src/lib/Screen.ts` with `CopySlot` (tone list and copy table) and `Control` (controls table); `pnpm spec check` parses both and refuses an example no screen shows; "are you sure" joined the retired copy words; `scripts/copy-audit.ts` reads its slots from `CopySlot`; `AGENTS.md` points at `Screen.ts`. The full unit suite and the six E2E specs whose assertions changed pass.

Both research docs can be deleted once this is committed. What survives is `Screen.ts`, the lint, the spec check, the audit script and the rewritten copy.
