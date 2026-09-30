# The domain vocabulary: what it is for, why words collide, and how to run it

## What was asked

The reconcile research (`docs/reconcile-research.md`) found that the glossary in `Domain.ts` has
grown one table at a time and that its words now collide: "active" means three things, "start"
two, "roster" and "slot" appear in code with no row at all. The review asked for a separate
piece of work, before the reconcile spec: what a vocabulary like this is for, whether it should
be called a glossary, whether every word in the code base can be unique, how much of Shopify's
language to adopt, and where the rules about the vocabulary itself should live. This doc is that
work. It is written to teach as much as to recommend, because the review said so.

## What we have

The glossary is the JSDoc at the top of `src/lib/Domain.ts`: eleven tables, about 150 rows,
grouped by noun (nouns, billing, run states, task states, workflow states, order positions,
order issues, verbs, screens). Around it:

- **A two-words rule.** Identifiers, JSDoc, tests, logs and research speak the vocabulary word;
  screen strings speak the screen column. The header calls these "tiers", a word this doc
  retires below. `scripts/rules-lint.ts` refuses retired words ("run", "line
  item", "finished", "tab", "staff") in screen copy.
- **Checks.** `pnpm spec check` verifies that every symbol a row names exists and that the
  screen columns equal the label constants the screens read. A label change starts at the row.
- **A convention for rules.** A behavioural rule is written once, on the symbol that is the
  concept, and every other site links it. The glossary carries words; the symbols carry rules.

What it does not have: any statement of what a word is, how a word gets in, what happens when
two concepts want one word, or which of Shopify's words are adopted. Each table was coherent
when added; nothing checked a new word against the older tables. That is how "active" came to
mean a workflow that is on, a run that is open, and a live app subscription.

## What a ubiquitous language is

The idea comes from domain-driven design (Evans, _Domain-Driven Design_, 2003, chapter 2,
"Communication and the Use of Language"). Stripped of the book's vocabulary, it is four claims:

1. **One language, used everywhere.** The people who know the domain and the people who build
   the software use the same words, and the words in the code are those words. A translation
   layer between "what the merchant says" and "what the class is called" is where bugs hide,
   because nobody can check that the two agree.
2. **The language is a model.** Choosing a word is choosing a concept. If two people use the
   same word for different things, they hold different models and will build different
   software while believing they agree. The vocabulary is where the disagreement becomes
   visible, so it is where it gets resolved.
3. **The language evolves.** A word that turns out to be wrong is changed everywhere, at once.
   A vocabulary that cannot change is a vocabulary nobody trusts, and people start working
   around it.
4. **Meaning is bounded.** Evans's second big idea (chapter 14, "Bounded Context") is that a
   word has one meaning _inside a context_ and the boundary between contexts is explicit. The
   same word may mean something else on the other side, and that is fine as long as everyone
   knows where the line is and what crosses it. Global uniqueness of words is not the goal and
   was never claimed to be reachable; English does not have enough words.

Baton already does 1 through 3 by instinct. The AGENTS.md rules, the tier rule, and "update the
glossary in the same change as any rename" are exactly claims 1 and 3. What it lacks is claim 4,
and claim 4 is the answer to "can every word be unique". No. Every word is unique _within its
context_, and a word that crosses a boundary carries its context with it.

## Baton's contexts

Reading the glossary and the code, four contexts are already there, unnamed:

| context    | what it is about                     | its words                                                                             | whose words                   |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------- | ----------------------------- |
| production | what the shop makes and who makes it | workflow, step, task, team, member, run, block, note, ready, started, done, closed    | Baton's, and the shop floor's |
| orders     | what Shopify says about an order     | order, item, tag, placed, paid, cancelled, fulfilled, quantity, refund                | Shopify's                     |
| billing    | what the shop pays for               | plan, app subscription, billing cycle, trial, meter, seat, usage event, counted order | Shopify's Partner API words   |
| platform   | how the software runs                | shop, session, Durable Object, D1, import, sync, sweep, retention, ceiling            | Cloudflare's and Baton's      |

Reconcile is the seam between production and orders: it reads orders words (paid, cancelled,
fulfilled, units) and writes production words (run, closed, resized). That is why it is where
the collisions surfaced.

Now the collisions read differently:

- **active.** Billing: an app subscription is active (Shopify's word, Partner API). Production:
  a workflow is on; a run is open. The billing sense is in its own context and can stay. The two
  production senses are the real collision, and only one of them is in the glossary (the run's
  open state, stored as `active`). The workflow sense lives only in identifiers.
- **closed.** Orders: Shopify has ended it. Production: something other than a person's Done
  ended the run. Two contexts, one word, same shape of meaning ("over, not by the normal
  route"). Allowed, with the noun.
- **cancel.** Orders: Shopify's cancelled order. Production: the merchant's Cancel workflow.
  Two contexts, with the noun.
- **start.** Production only: a member starts a task; a workflow starts a run. Same context,
  two senses. A real collision.
- **open.** Orders: not cancelled, not fulfilled. Production: work can be recorded on the run.
  Two contexts, same shape of meaning. Allowed, with the noun.

So the rule that scales is: **one meaning per word per context, and the noun travels with any
word that two contexts share.** "Open order", "open run"; "closed order", "closed run". A bare
`isOpen` or `isActive` is the bug; `orderIsOpen`, `runIsOpen`, `workflowIsOn` are the fix, and
the code already does this for every predicate but the workflow ones.

## Shopify's words: how much to adopt

Baton is a Shopify app for merchants who already use the Shopify admin and, some of them,
Shopify Flow. Three rules follow, in order of strength:

1. **Shopify's things get Shopify's words, unchanged.** Order, item (the admin's word on the order page; "line item" is the API's), tag, fulfilled,
   cancelled, paid, refund, plan, app subscription, billing cycle. Never rename these: the
   merchant will read the same word in the admin an hour later. "App subscription" is Shopify's
   own type name (`AppSubscription` in the Partner API); "active subscription" is Shopify's field
   for the current one (`appInstallation.activeSubscriptions` in the Admin API). The code was
   renamed to `AppSubscription` in the metering change; `activeSubscription` remains as the name
   of the query and its field, which is Shopify's word for that field and stays.
2. **Where Baton's things resemble a Shopify thing, borrow the pattern and the screen words,
   and say where the borrowing stops.** The workflow's on and off, draft, Apply and Discard
   come from Shopify Flow. What Flow says, from `refs/flow-manual`: the buttons are **Turn on**
   and **Turn off**; the status badge is **Active** and **Inactive**; the prose says "activate
   the workflow" and "inactive workflows can't be run"; one execution is a **workflow run**, on
   screen. Baton's screens say On and Off for the badge and never say "run"; the JSDoc on
   `Workflow` records the decision to stop borrowing there ("run" is a production run a member
   works, not a Flow execution). That decision is right and should be written into the
   glossary, not left on one symbol.
3. **Baton's own things get plain words, and an invented word never reaches a screen.** Run,
   reconcile, coverage date. The merchant sees the effects.

The `active` question in this light: the _screen_ words are settled and Flow-shaped (On, Off,
Turn on, Turn off). The identifiers `isActive`, `setWorkflowActive`, `listActiveWorkflowDetails`
are also Flow's word, but they are in the production context where `active` is already the
run's stored open state. Rule 2 says borrow the screen words; it does not say the identifier
must be Flow's. The glossary's workflow-states table already says the word is "on"; the
identifiers should follow the glossary, as every run predicate does.

## Is it a glossary, a vocabulary, or a language?

From first principles: what is the thing, and what is it for? It is the set of words everyone
uses, with one meaning each, and its purpose is to be spoken: in code, in JSDoc, in tests, in
research, in chat, and, through the screen column, to the merchant. A thing whose purpose is to
be spoken is a vocabulary. A glossary is a list you consult; it describes a reference appendix,
not the words on everyone's tongue. "Language" names the practice of speaking it and never needs
to name a file or a block.

The review asked why we would keep two words for one thing, and the honest answer is that no
sentence in this repo needs to tell the set of words apart from the block that lists them. Every
sentence refers to the block ("add a row", "the glossary's words"). Two words for one referent is
the collision this whole doc is about.

Recommendation, reversing the first draft: **one word, "vocabulary"**. The JSDoc block heads
"Vocabulary.", AGENTS.md says "the vocabulary at the top of `Domain.ts`", and `pnpm spec check`
reports "vocabulary" in its messages. The cost is a grep-rename: "glossary" appears 51 times in
12 files under `src/`, `scripts/` and AGENTS.md, and the checker finds the block by its first line
(`/**\n * Glossary.` in `scripts/lib/spec.ts`, `checkGlossary` and `glossaryTables`), so the
anchor and the two function names move with it. Research docs are dated and are not rewritten.

## What a row is, and what a word must pass to get one

A glossary row is a word, a one-line meaning, the symbol that is the concept, and what the
screen says. That form is right and should not grow. What is missing is the entry test:

1. **It names a concept the domain has**, not a mechanism. "Run" passes; "slot" is a metaphor
   for a rule ("one run per item") and does not; "roster" is a synonym for a concept already
   named (members, teams) and does not.
2. **It has one meaning in its context.** Grep the stem across `src/`; every identifier that
   comes back must mean the same thing, or the word is taken. This is the check that would have
   caught "active" and "start".
3. **It is the merchant's or Shopify's word when it surfaces, and a plain word when it does
   not.** Rule 1 and 3 of the Shopify section.
4. **Its stored literal is its name where the store is ours.** The review is right that a
   literal that differs from the word is a standing invitation to the collision it caused. A run's
   open state is stored as `active` and named "open"; the fix is to store `open`. There is no
   migration cost while prototyping: the schema is edited in place and local state reset. The
   exception is a literal Shopify owns (`FULFILLED`, `active` on an app subscription), which is
   stored as Shopify sends it and read through a predicate.
5. **If it shares a word with another context, it always travels with its noun.** In
   identifiers that means `<noun>Is<State>`, never `is<State>`.

A word that fails is either mapped to the existing word (roster to members or teams), retired
(slot, in favour of the rule's plain statement), or split (start: a member starts a task; a
workflow creates a run).

## The words this pass found outside the glossary

An inventory of code words with no row, with a recommendation each. "JSDoc term" means the word
stays on its symbol's JSDoc and does not get a row, like "provisional cycle" today.

| word                                       | where                                                                                                                                             | meaning                                                                            | recommendation                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| roster                                     | `TeamRoster`, `recordRoster`, `rosterAtCeiling`, JSDoc                                                                                            | the shop's members, or its teams, by sentence                                      | retire: "members" / "member count" / "teams"; rename the four identifiers                                                                                                              |
| slot                                       | `RunStatus`, `reconcileOrder`, `insertRun` JSDoc                                                                                                  | the one-run-per-item rule                                                          | retire: state the rule, verb "holds"                                                                                                                                                   |
| reconcile                                  | `reconcileOrder`, `reconcileAll`, logs                                                                                                            | make an order's runs agree with the order and the on workflows                     | row (production); decided in the reconcile research                                                                                                                                    |
| match, ambiguous, coverage date, startable | reconcile code                                                                                                                                    | see the reconcile research                                                         | rows (production); "startable" depends on the `start` decision                                                                                                                         |
| draft                                      | `WorkflowDraft`, `createDraft`, `applyDraft`, screens                                                                                             | the workflow's edited copy, applied or discarded                                   | row (production, from Flow): draft; verbs apply, discard                                                                                                                               |
| apply, discard                             | callables, screens (Apply, Discard)                                                                                                               | promote or drop the draft                                                          | verb rows, on a workflow, merchant only                                                                                                                                                |
| turn on, turn off                          | callables (`setWorkflowActive`), screens                                                                                                          | the switch                                                                         | verb rows, on a workflow; the identifier follows the glossary word ("on")                                                                                                              |
| import                                     | `syncOrders`, "Import open orders"                                                                                                                | the bulk fetch of open orders                                                      | row (platform): import; screen "Import open orders"                                                                                                                                    |
| sync                                       | `syncOrder`, `OrderSync`, `SyncState`, "Resync"                                                                                                   | fetch one order from Shopify and store it                                          | row (platform): sync; never reconciles by itself                                                                                                                                       |
| sweep, retention                           | `sweepExpiredOrders`, `orderRetentionDays`                                                                                                        | delete orders older than a year, and what rides on it                              | JSDoc terms on `ShopLimits`; no screen, no rule anyone else states                                                                                                                     |
| ceiling                                    | `maxOpenRuns`, `maxOrdersPerCycle`, `rosterAtCeiling`, banners                                                                                    | a per-shop limit the object enforces                                               | row (platform): ceiling, with the three ceilings named; the banners are its screen words                                                                                               |
| gate                                       | `canStartRuns`, `getRunGate`, "creation gate", "stop gate"                                                                                        | a predicate that admits or refuses a write                                         | JSDoc term                                                                                                                                                                             |
| issue                                      | `OrderIssue`, screens                                                                                                                             | an undecided item on an open order                                                 | already a row                                                                                                                                                                          |
| tier                                       | the glossary header ("domain tier", "screen tier"); `RunTier`, `tierOf`, `byTier` (the member's workflows list); billing ("the $0.00 first tier") | three senses: which words a site speaks; a view of the member's list; a price band | retire the first two: the header says "vocabulary word" and "screen word"; the list's tiers are the glossary's **views** (`RunView`, `viewOf`, `byView`); billing keeps Shopify's word |
| position                                   | `ProductionState`                                                                                                                                 | where an order is in production                                                    | already a row; the identifier says "state", the glossary says "position": align to one                                                                                                 |

The last row is a small collision of the same kind as `active`: the glossary word and the
identifier disagree. It is listed because the test in "What a row is" catches it, and because it
shows the audit is mechanical enough to run again.

## Where the rules about the vocabulary live

Four places are possible, and each holds a different kind of thing:

| place                                    | holds                                                                 | why there                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| the glossary JSDoc                       | the contexts, the entry test, the shared-word rule                    | it is the one thing every reader of a word already has open; ten bullets, not a chapter         |
| AGENTS.md                                | one paragraph: use the glossary's words; the tier rule                | it is what the model reads first; it already says this                                          |
| a runbook (`docs/vocabulary-runbook.md`) | the procedure: grep, write the row, rename, retire; the audit command | procedures with commands do not belong in a JSDoc; `docs/worktrees-runbook.md` is the precedent |
| `scripts/rules-lint.ts`                  | the mechanical part: retired words; `<noun>Is<State>`                 | a rule a script can check should not be a rule a reviewer has to remember                       |

Not a skill. A skill is for a task an agent repeats with judgment (a review, a deploy). The
vocabulary procedure is five steps and a grep, which a runbook holds and a lint enforces; a skill
would restate the runbook and drift from it. If the audit turns out to be run often, the runbook's
command becomes a `pnpm` script, not a skill.

The one thing that must stay small is the glossary header. It carries the rules of the vocabulary
itself and nothing else; the moment it explains procedure it stops being read.

## What "unique" can mean here, concretely

Three levels, from the one that does not scale to the one that does:

1. **Every word unique across the code base.** Not reachable: open, closed, start, done, active
   are English's only words for those states, and Shopify uses them too. Rejected.
2. **Every word unique within its context, and shared words carry the noun.** Reachable. It is
   what the glossary's per-noun tables already do, and what `orderIsOpen` / `runIsOpen` already
   do. The lint can hold it: an exported predicate under `src/lib/` that is `is<Word>` with no
   noun prefix is refused; the stored literals are refused outside the schema and the glossary.
3. **A reserved list for the words that have already collided.** `active` (retired outside the
   schema and billing), `start` (a task only, if the split is taken), `roster`, `slot`. A
   substring check on exported identifiers, like the retired-copy check. Small and cheap, and it
   stops the same collision recurring.

Recommendation: 2 as the rule, 3 as the guard.

## How the vocabulary evolves without a rewrite

A word changes in one change: the row, every identifier, every JSDoc, every test title, every
research doc, and the retired list, together. This is already AGENTS.md's rule for renames. What
the review feared is that this "gets very involved". It does not have to:

- **The audit is a grep.** The inventory above took one command per stem. A `pnpm vocab audit`
  that lists exported identifiers whose stem is not in the glossary and not on an allowlist is an
  hour's script and turns the audit from a research task into a lint warning.
- **Most words never move.** Order, item, team, task, member, workflow, block have been stable
  since the first glossary. Churn is at the seams (reconcile, billing) and on invented words.
- **Retiring is a list entry.** The lint already has one for copy; the same list, applied to
  identifiers, is the whole mechanism.

## Decisions (reviewed 2026-09-29)

Every recommendation in the questions below was accepted as written, with these corrections and
additions from the review:

1. **One word: "vocabulary".** The first draft recommended keeping "glossary" for the block; the
   review asked for a first-principles answer and the section above gives it. The block, the
   checker and AGENTS.md all say "vocabulary".
2. **Stored literals line up with the vocabulary where the store is ours.** The run's stored
   `active` becomes `open`, in place, with a local reset. Shopify's literals stay Shopify's.
3. **"Tier" is retired** in the header and in the member's list (`RunTier` → `RunView`, `tierOf`
   → `viewOf`); billing keeps Shopify's "tier".
4. **"App subscription" stays**: it is Shopify's type name. `activeSubscription` stays as the
   name of Shopify's field.
5. **Every existing row is re-read against the entry test**, because the method has changed
   since the rows were written. The plan makes this a phase whose output is a list for the
   review, not silent edits.
6. The reconcile research is on hold until the vocabulary plan has been carried out.

The plan is `docs/domain-vocabulary-plan.md`, written for another model to carry out.

## Questions (answered; kept for the record)

**Q1. Adopt the four contexts (production, orders, billing, platform) as a glossary table?**
Recommendation: yes, as the first table, one row each: name, what it is about, whose words.
Every later table then belongs to a context, and a shared word is allowed only across contexts.
The alternative is to leave contexts implicit, which is how the collisions happened.

**Q2. Keep "glossary" for the tables, "vocabulary" for the words, "language" for the practice?**
Recommendation: yes. Change AGENTS.md's one sentence and nothing else. The alternative, one word
for all three, loses the distinction this doc needed to make its own argument.

**Q3. Rule for shared words: one meaning per context, noun always attached, `<noun>Is<State>`
in identifiers, enforced by the lint?** Recommendation: yes. It is what the code already does
everywhere but the workflow predicates. The alternative, global uniqueness, is not reachable.

**Q4. Follow Flow's screen words (Turn on, Turn off, On, Off, draft, Apply, Discard) and rename
the identifiers to the glossary word (`workflowIsOn`, `setWorkflowOn`,
`listOnWorkflowDetails`)?** Recommendation: yes. Screens stay as they are. Flow's own badge says
Active and Inactive, so "On" and "Off" are a deliberate departure; the glossary should say so in
one sentence. The alternative, keeping `isActive`, keeps the collision with the run's stored
`active` and leaves the glossary and the code disagreeing about a word the glossary already
settled.

**Q5. Split "start": a member starts a task, a workflow creates a run?** Recommendation: yes,
and it is the weakest recommendation here. For: the glossary's verb table lists `start` for a
task and `attach workflow` as "creates the run", and `ReconcileCounts.created` already says
"created". Against: `canStart`, `canStartRuns`, `StartContext` and the `Workflow` JSDoc's line
"`start` / `canStart` is creating a run" all chose "start", and "startable" reads better than
"eligible". If the split is refused, the fallback is a verb row `start | run | a workflow creates
it` so the glossary at least records the second sense.

**Q6. Retire "roster" (members, member count, teams) and "slot" (the rule "one run per item",
verb "holds")?** Recommendation: yes to both. Neither is a concept; each is a synonym or a
metaphor for something the glossary already names.

**Q7. Where do the rules live: contexts and entry test in the glossary header, procedure in
`docs/vocabulary-runbook.md`, mechanics in `rules-lint`, one paragraph in AGENTS.md, no
skill?** Recommendation: yes, as the table above. The alternative, everything in the JSDoc,
makes the header long enough that nobody reads it.

**Q8. Build the audit script (`pnpm vocab audit`) now?** Recommendation: yes, before the
reconcile spec, because the spec will add eight words and the audit is how we know they do not
collide. An hour's script; it lists exported identifier stems under `src/lib/` that are neither
glossary words nor allowlisted English.

**Q9. Order of work?** Recommendation: (1) the contexts table and the entry test in the glossary
header, with the Flow sentence; (2) the audit script; (3) the renames, one change each: `active`,
`roster`, `slot`, "position"; (4) the `start` split if taken; (5) the reconcile spec in the
settled words. The alternative, the spec first, writes eight new rows in words that then change.

## Status

Research done and reviewed. No code changed here; the work is in `docs/domain-vocabulary-plan.md`.
