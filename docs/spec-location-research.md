# Where the spec lives: JSDoc, separate files, or bounded contexts

Two rounds. Part 1 asked whether the specs should leave the JSDoc for separate files. Part 2, after the first review, asks whether splitting `Domain.ts` into bounded contexts, each with its own vocabulary at the top, answers the same strain without leaving the code.

# Part 1: JSDoc or separate files

## The question

The specs (vocabulary, rule tables, action matrices, data-model rows, copy and controls tables) live in JSDoc next to the symbols they govern. That has worked: an agent reading or grepping the code lands on the rule, `{@link}` ties rules together, `pnpm spec check` parses the tables, and tests read the matrices out of the source. Two things now strain it:

1. **Size.** The vocabulary block is the first 255 lines of `src/lib/Domain.ts`; the file is 4,790 lines and 56% comment. Seventeen tables sit in it.
2. **Audience.** The spec is the one artefact the merchant-side author (you) and the agent are meant to share and iterate on. It is buried inside files you no longer read, because the implementation has outgrown review.

The proposal on the table is to move some of it into `docs/spec-*.md`. The worry is that a separate file is not in the grep, not in the scan, and so not in the agent's context when it matters, and that `{@link}` is lost.

## What is there today

| block                                                | where                                | lines | checked by                                                      | read by a test        |
| ---------------------------------------------------- | ------------------------------------ | ----- | --------------------------------------------------------------- | --------------------- |
| vocabulary (contexts, nouns, states, verbs, screens) | top of `Domain.ts`, no owner symbol  | 220   | symbols exist, screen cells equal label constants, routes exist | no                    |
| run and task action matrices                         | `runActions`, `taskActions`          | 110   | parse, no overlapping fixtures                                  | yes, one `it` per row |
| usage triggers                                       | `ShopUsage`                          | 57    | cell words, pinned titles exist in a test                       | by title              |
| data model, object                                   | `initializeSchema`                   | 66    | pinned titles                                                   | by title              |
| data model, D1                                       | `D1_TABLES`                          | 61    | pinned titles                                                   | by title              |
| copy and controls                                    | `CopySlot`, `Control` in `Screen.ts` | 91    | every example appears on a screen                               | no                    |

About 600 lines are spec proper. The other ~2,000 comment lines in `Domain.ts` are per-symbol rule text ("stated once, on the owner, linked from readers"), which is a different thing and is not what would move.

Every parser in `scripts/lib/spec.ts` locates a table by "the JSDoc before `export const <name> =`" and then works on markdown rows. Pointing one at a `.md` file is a one-line change. The checks are already file-agnostic.

`{@link}` counts: 332 in `Domain.ts`, 55 in `ShopAgent.ts`, 49 files in `src/` carry one. tsserver resolves them: go-to-definition since TypeScript 4.3, and rename updates the link target (verified on 5.9; not verified on the TypeScript 7 this repo pins). Nothing resolves `{@link}` inside a standalone `.md` file. TypeDoc 0.26+ does resolve and validate `{@link}` in markdown it is told about (`@document`, `projectDocuments`), but only at doc-build time.

## What co-location buys, item by item

Separate the benefits, because a move loses some and not others:

| benefit           | how it happens today                                     | lost by moving to a file?                                         |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| found by scan     | the agent opens `Domain.ts` and hits the header          | yes, unless loaded another way                                    |
| found by grep     | a vocabulary word or a rule sentence matches in `src/`   | partly: `grep -r` over the repo still hits; `grep src/` does not  |
| in the diff       | a rule change and its code change are one hunk           | yes for rules; no for the vocabulary, which has no code beside it |
| links checked     | tsserver on `{@link}`; `pnpm spec check` on symbol names | tsserver yes; `spec check` no (it already checks names in prose)  |
| links navigable   | editor go-to-definition                                  | yes                                                               |
| table is the test | the test imports `Domain.ts?raw` and parses              | no: import the `.md` instead                                      |
| one place         | the rule is on the symbol that enforces it               | yes for rules; the vocabulary has no such symbol                  |

The last row is the split that matters. A **rule** has an owner symbol; co-location means "the owner's JSDoc", and moving it away breaks the thing that made it work (the reader linking the enforcer, the diff showing both). The **vocabulary** has no owner symbol. It sits at the top of `Domain.ts` because that was the nearest file, not because anything there enforces it. Its readers are every file in the repo, every test title, every screen string, and this research doc.

## Two kinds of document, and why the spec kits fail

Kiro, GitHub Spec Kit and OpenSpec all produce **feature-scoped, temporal** artefacts: `requirements.md`, `design.md`, `tasks.md` per feature, in a folder per feature, written before the code and kept afterwards. The critiques converge:

- Böckeler (martinfowler.com, 2025-10): "like using a sledgehammer to crack a nut"; "I'd rather review code than all these markdown files"; "just because the windows are larger, doesn't mean that AI will properly pick up on everything that's in there." <https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html>
- Zaninotto (Marmelab, 2025-11): "in practice, agents don't always follow the spec"; "as the application grows, the specs miss the point more often and slow development." <https://marmelab.com/blog/2025/11/12/spec-driven-development-waterfall-strikes-back.html>
- Eberhardt (Scott Logic, 2025-11): "a sea of markdown documents, long agent run-times and unexpected friction." <https://blog.scottlogic.com/2025/11/26/putting-spec-kit-through-its-paces-radical-idea-or-reinvented-waterfall.html>
- HN on the Marmelab post: "deep into the project, your spec is a total mess and the tiniest feature you want to add requires extremely complex manipulation of the spec." <https://news.ycombinator.com/item?id=45935763>

The failure is not "specs in files". It is keeping the _temporal_ document (what we decided to build in September) as if it were the _timeless_ one (what the system is). OpenSpec's answer is a merge step: a change's delta specs are folded into `specs/` on archive. That is a manual sync, and the critiques say it drifts.

Baton already makes this split, and makes it hard:

- **Temporal**: research and plans in `docs/`. Dated, deletable, never cited from `src/`. The AGENTS.md rule exists precisely so a stale plan cannot become a false spec.
- **Timeless**: the vocabulary, the rule tables, the data-model rows. Checked by `pnpm spec check`, pinned by test titles, changed at the row.

So the question is narrower than "spec-driven development or not". It is: does a timeless spec need to be inside a `.ts` file to stay timeless? The mechanisms that keep it honest (parse, pin, test) do not care which file they read. What they care about is that the file is a _system of record_ with a check, not a `docs/` note with a date.

The prior art that never drifts has one shape: the document is executed. Cucumber steps must bind to code; Rust and Python doctests run the examples; Concordion colours the document from the test run. Baton's "pinned by a test title" and "the test reads the matrix" are this shape. `docs/` notes, ADRs, arc42 are the other shape: they stay true by being dated and immutable, not by being checked.

## The real problem: one file is both the writing surface and the reading surface

You want to iterate with the agent on what the system does, at a level above the code, and review that level instead of the code. Today the workflow is:

1. research doc in `docs/` (you annotate, the agent revises);
2. the agent moves the outcome into JSDoc rows and tests;
3. the research doc is deleted.

After step 3 the durable spec exists only inside 4,790-line source files. You can read a row when a diff shows one, but you cannot open "the spec" and read it. The agent can, and does, because it reads source. The asymmetry is the problem, not the location.

Two ways to fix an asymmetry: move the writing surface to where you read (a file), or generate a reading surface from where the agent writes (render). They are not exclusive, and they fit different blocks.

## Approaches

### A. Leave everything in JSDoc; shrink the files

Split `Domain.ts` by context (`Domain/Production.ts`, `Orders.ts`, `Billing.ts`, `Platform.ts`), each with its context's vocabulary at the top. The header shrinks to what that file needs, the rules stay on their owners, nothing about discovery changes.

For: no new mechanism; every benefit in the table above survives. Against: does nothing for the reading surface; a four-way split of a 4,790-line file is a large mechanical change with import churn in 49 files; the shared-word rule and the contexts table still need one home.

### B. Render a reading surface from the JSDoc

Extend `pnpm spec print` to emit markdown: one file per table-bearing symbol, plus the vocabulary, into a committed folder (say `spec/rendered/` or `spec/*.gen.md`), with a check that it is up to date (the way `routeTree.gen.ts` is). TypeDoc with `typedoc-plugin-markdown` does the general version of this; the custom script is smaller and already parses the tables.

For: source stays the one writing surface, so nothing drifts; a PR's diff of `spec/*.md` is the spec-level diff you can review while treating the code as a black box; generated files are grep-able and in the repo, so they turn up for the agent too. Against: you annotate a generated file and the agent must map the annotation back to the JSDoc, which it can, but the file says "generated, do not edit" and that is a small friction; one more generator to keep.

### C. Move the vocabulary out; keep the rules in

`spec/vocabulary.md` (see naming below) holds what is now the 220-line header. `Domain.ts` keeps a ten-line stub: what the file is, and that every word in it has a row in `spec/vocabulary.md`. Rules stay on their owner symbols, action matrices stay on `runActions` and `taskActions`, data-model rows stay on the schemas.

Discovery, replacing the scan:

- **Every session**: AGENTS.md imports it with `@spec/vocabulary.md`. Imports load at startup, unconditionally, up to four hops (<https://code.claude.com/docs/en/memory.md>). The vocabulary is ~3,500 tokens, the one document every session should carry, because every identifier, test title and label it writes must speak it. This is _stronger_ than co-location, which only fires when the agent happens to open `Domain.ts`.
- **On demand** instead, if the per-session cost is not wanted: `.claude/rules/vocabulary.md` with `paths: ["src/**", "test/**", "e2e/**"]` loads when a matching file is read. Same doc, same source.
- **Grep**: a word still matches, in `spec/` rather than `src/`; the runbook's step 2 already greps `src scripts test e2e` and gains `spec`.

Links, replacing `{@link}`:

- Spec to code: backticked symbol names, as the tables already do. `checkVocabulary` already refuses a symbol that does not exist in `Domain.ts`; it keeps doing that on the new file. Editor navigation is lost; rename is lost (a rename must touch the row, which the runbook already demands).
- Code to spec: a JSDoc says "the vocabulary's `run`" or cites `spec/vocabulary.md`. The AGENTS.md rule "never reference `docs/`" stays, with `spec/` added to the acceptable list beside `refs/`, because `spec/` is checked and never deleted.
- Spec to spec: markdown anchors, checked by a link check in `spec check` (cheap: headings are known).

For: fixes the asymmetry for the block that has no owner symbol; makes the vocabulary present in every session; the contexts question gets a file to be answered in. Against: two link systems; a symbol renamed in the editor no longer updates its vocabulary row automatically (though `spec check` fails until it does).

### D. Move every table out

A `spec/` folder with the vocabulary, the matrices, the triggers, the data model, the copy tables, TypeDoc-`@document` style. The tests import the `.md` files.

Against, and decisive: the matrices and the triggers table are read by the callable that enforces them and by the page that renders the buttons; the JSDoc on `runActions` is the reader's first stop and the diff shows the cell beside the formula. Moving them re-creates the OpenSpec sync problem for the tables where co-location is doing the most work. The "note is never blank because a note is a record, not work" paragraphs are rule reasoning that belongs on the symbol.

### Comparison

|                            | A split files             | B render                          | C vocabulary out                           | D all out                 |
| -------------------------- | ------------------------- | --------------------------------- | ------------------------------------------ | ------------------------- |
| agent finds the vocabulary | on opening the right file | on opening `Domain.ts` or `spec/` | every session (import)                     | every session (import)    |
| agent finds a rule         | on the symbol             | on the symbol                     | on the symbol                              | in `spec/`, if it looks   |
| you can read the spec      | no                        | yes, generated                    | vocabulary yes; rules no                   | yes                       |
| you can review a spec diff | no                        | yes                               | vocabulary yes                             | yes                       |
| `{@link}` kept             | yes                       | yes                               | rules yes; vocabulary by name              | no                        |
| drift risk                 | none                      | none (generated)                  | none (checked)                             | sync step                 |
| cost                       | large mechanical          | one generator                     | one file move, parser path, AGENTS.md line | large, and the tests move |

## Bounded contexts

The vocabulary already names four contexts (production, orders, billing, platform) and every table names its context. The lumping you noticed is that the nouns table carries a `context` column while the billing words have their own table, and a shared word ("open", "closed", "cancel", "start") is explained in prose after whichever table it first appears in.

Options for the file:

1. **One file, one section per context.** A context map at the top (the table that exists now), then `## Production`, `## Orders`, `## Billing`, `## Platform`, each with its nouns, states and verbs, then `## Shared words` with the noun rule and one row per shared word saying which contexts share it and what the noun is. Screens stay a section of their own; they are a cross-context index.
2. **One file per context.** `spec/production.md`, and so on. Right when a context's section is longer than a screen; today production is ~80% of the words and the others are ten rows each.
3. **Keep the column.** Least change; keeps the lumping.

Evans's rule is one meaning per word per context and an explicit boundary. A section heading is the boundary; a column cell is not. Option 1 makes the boundary visible without four small files, and option 2 is the split to take when a section outgrows it.

A later question the sections raise: the code is not split by context (`Domain.ts` holds all four). The spec's sections are the map for a later `Domain/` split, if that is ever wanted. Not this change.

## Naming and the `docs/` rule

`docs/` is scratch by rule: dated, deletable, never cited. A durable spec cannot live there under a prefix without weakening the rule that protects `src/` from stale plans. Put it in a top-level `spec/`, beside `refs/`: both are citable from JSDoc because both are checked (`pnpm refs:check`, `pnpm spec check`). AGENTS.md's "never reference `docs/`" gains "`spec/` is acceptable; cite the file and a heading".

`spec/` also keeps the render output (approach B) if that is taken, as `spec/*.gen.md`, so one folder is "what the system is" and `docs/` stays "what we are thinking about".

## Recommendation

1. **Rules stay on their owners.** Action matrices, triggers, data-model rows, copy and controls tables, and every per-symbol rule paragraph do not move. This is where co-location earns its keep and where the spec kits' drift would come back.
2. **The vocabulary moves to `spec/vocabulary.md`**, one section per context plus a shared-words section, imported into every session from AGENTS.md. `Domain.ts` keeps a stub. `pnpm spec check` reads the new path; `checkVocabulary`, `checkScreenColumns`, `checkContexts`, `checkScreens` keep their jobs. The runbook's grep gains `spec`. This is the pilot: one file, the block with no owner symbol, the block every session needs.
3. **Then render the rest.** `pnpm spec print --md` writes `spec/actions.gen.md`, `spec/usage.gen.md`, `spec/data-model.gen.md`, `spec/copy.gen.md` from the JSDoc, committed, with an up-to-date check in `spec check`. That is your reading surface for the tables that must stay in the code, and a spec-level diff on every PR. Do this second, after the vocabulary move shows the folder works.
4. **Do not split `Domain.ts` for this.** It may be right later, guided by the spec's sections; it is not the fix for the reading problem.

What this does not solve: the ~2,000 lines of per-symbol rule text in `Domain.ts` remain readable only in the source. The test titles are the human-readable index of those rules ("a done run's last step is undoable"), and `pnpm test --reporter=verbose` or a rendered list of `it` titles is the reading surface for them. That is a separate, smaller question.

## Decisions, round 1

Reviewed 2026-09-30.

- **Rules stay on their owners.** Accepted. Action matrices, triggers, data-model rows, copy and controls tables, and per-symbol rule text do not leave the JSDoc.
- **Co-location is the preferred surface**, for the agent and for the author. Scannable, greppable, `{@link}`-navigable, and reading JSDoc in the source is acceptable, wanted even, for the parts that tie the system together (`runActions`, the boundaries). Approach B (render) and C (vocabulary to a file) are not taken now.
- **Loading the vocabulary into every session** is not adopted. Open, leaning no: the fear is that an always-loaded file grows, and most sessions do not need all of it.
- **Next**: explore bounded contexts. Split `Domain.ts` by context with each context's vocabulary at the top, and see how that feels before any separate spec artefact. That is Part 2.

# Part 2: bounded contexts and the ubiquitous language

Sources: Evans, _Domain-Driven Design_ (2003), chapters 2 and 14, and his _DDD Reference_ (2015, <https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf>), from which the short quotes below are taken; Fowler's bliki entries <https://martinfowler.com/bliki/UbiquitousLanguage.html> and <https://martinfowler.com/bliki/BoundedContext.html>; Brandolini, "Strategic Domain Driven Design with Context Mapping" <https://www.infoq.com/articles/ddd-contextmapping/>. Vernon (_Implementing DDD_) and Khononov (_Learning DDD_) are cited from secondary collections and marked so.

## The ubiquitous language

Evans's definition: "A language structured around the domain model and used by all team members within a bounded context to connect all the activities of the team with the software." Fowler: "a common, rigorous language between developers and users … based on the Domain Model used in the software, hence the need for it to be rigorous, since software doesn't cope well with ambiguity."

The problem it solves is translation. Evans: "The terminology of day-to-day discussions is disconnected from the terminology embedded in the code (ultimately the most important product of a software project)." And: "Translation blunts communication and makes knowledge crunching anemic." The fix is one language, used everywhere: "Commit the team to exercising that language relentlessly in all communication within the team and in the code. Within a bounded context, use the same language in diagrams, writing, and especially speech."

Three consequences Evans draws, each of which Baton already enforces:

| Evans                                                                                                                                                                   | Baton                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Recognize that a change in the language is a change to the model."                                                                                                     | The runbook: a rename touches the row, every identifier, test title, log message and label in one change; the old word goes on the retired list and `rules-lint` refuses it. |
| "Iron out difficulties by experimenting with alternative expressions … Then refactor the code, renaming classes, methods, and modules to conform to the new model."     | The vocabulary passes (`active`, `roster`, `slot`, `tier` retired; `run` kept in code, refused on screens).                                                                  |
| "Domain experts should object to terms or structures that are awkward or inadequate … developers should watch for ambiguity or inconsistency that will trip up design." | The entry test on the vocabulary: a concept not a mechanism, one meaning per context, Shopify's words unchanged, the noun travels with a shared word.                        |
| Developer jargon may extend the language, but "these dialects should not contain alternative vocabularies for the same domain that reflect distinct models."            | "Provisional cycle", "high-water mark" are JSDoc terms on their own symbols, not vocabulary rows; a word only one symbol uses gets no row.                                   |

So the language exists, and the machinery around it is more than most teams have. What Evans adds, and what Baton has not yet done, is in the first sentence of his definition: the language is scoped **within a bounded context**. There is one vocabulary with a `context` column. Evans's unit is one language per context, each with its own glossary. The DDD Crew's Bounded Context Canvas (<https://github.com/ddd-crew/bounded-context-canvas>) makes that concrete: every context gets a "Ubiquitous Language" section, "what are the key domain terms that exist within this context, and what do they mean?"

One caution, Khononov's (secondary): "Glossaries are best used in tandem with other tools that are better suited to capture the behavior." A glossary names things; the rules on the symbols and the tests titled with the rule are the behaviour. Baton's split between the vocabulary (words) and the rule-at-owner JSDoc (behaviour) is that pairing.

## The bounded context

Evans: "A description of a boundary (typically a subsystem, or the work of a particular team) within which a particular model is defined and applicable." His three-line summary of the whole discipline: "Speak a ubiquitous language within an explicitly bounded context."

**Why one model for everything fails.** "Total unification of the domain model for a large system will not be feasible or cost-effective." The symptom has two names, from linguistics.

- A **polyseme** is one word with several related meanings. "Paper" is the material, a newspaper and an academic article; "meter" at a utility is the device, the connection and the customer's point of supply. The meanings are cousins, which is why nobody notices the difference until a program has to store one of them.
- A **false cognate** is a pair of words that look the same and are taken to mean the same, but do not. In language learning it is Spanish "embarazada" (pregnant) read as "embarrassed". In software it is two people, or two modules, using one term for two different things and never finding out.

Both are one word, two meanings, each side sure they agree. Fowler's utility example: "meter" meant "the connection between the grid and a location, the grid and a customer, the physical meter itself"; "these subtle polysemes could be smoothed over in conversation but not in the precise world of computers." Evans calls them false cognates: "two people who are using the same term (or implemented object) think they are talking about the same thing, but really are not." Brandolini's small-app example: in a personal-finance app, "Account" is a container for money in one part and a login in another.

Baton has had every one of these: `active` (a Shopify app subscription; a workflow; a run), `open` (an order; a run), `closed`, `cancel`, `start` (a member starts a task; a workflow starts a run). The domain-vocabulary research resolved them with the shared-word rule, which is exactly Evans's move: recognise two contexts, let each keep its meaning, and make the boundary explicit in the name (`orderIsOpen`, `runIsOpen`).

**The boundary is explicit.** "Explicitly define the context within which a model applies. Explicitly set boundaries in terms of team organization, usage within specific parts of the application, and physical manifestations such as code bases and database schemas." A context is linguistic before it is anything else. Fowler: "since models act as Ubiquitous Language, you need a different model when the language changes." Evans says the early warning of a needed split "is usually a confusion of language." Vernon (secondary): "a Bounded Context is principally a linguistic boundary."

**A context is not a module.** Evans, in a sidebar: modules are "just an implementation mechanism for code separation of different models … MODULES are also used to organize the elements within one model, so they don't communicate an intention to separate models. The separate name-spaces they create can actually make it harder to spot accidental model divergences." Splitting a file is not drawing a context. The context is the decision that a word means one thing inside the line and may mean another outside it; the file split is how the code shows the line.

**How many contexts a small system needs.** Evans, directly: "It could be quite simple, a single BOUNDED CONTEXT for the entire system under design. For example, this would be the clear choice for a team of fewer than ten people working on a set of highly interrelated functionality." Typically the system "is probably going to get carved into one or two BOUNDED CONTEXTS … perhaps with another context or two in a supporting role." His forces for fewer contexts: "It is easier to understand one coherent model than two distinct ones plus mappings." For more: "Different models can cater to special needs or encompass the jargon of specialized groups of users." Khononov (secondary): "start with wider boundaries. If required, decompose the wide boundaries into smaller ones as you gain domain knowledge … Refactoring logical boundaries is considerably less expensive than refactoring physical boundaries." Fowler (<https://martinfowler.com/bliki/MonolithFirst.html>): "even experienced architects working in familiar domains have great difficulty getting boundaries right at the beginning."

The team force does not apply here: one author, one agent. Any split has to be justified by language alone, which is the honest test. Where does a word change meaning?

## Subdomains: what the business is made of

Vernon and Khononov separate the problem from the solution. A **subdomain** is a part of the business, discovered; a **bounded context** is a model boundary, designed. Three kinds (Microsoft's summary, <https://learn.microsoft.com/en-us/azure/architecture/microservices/model/domain-analysis>): core "provide a competitive advantage"; supporting "keep the business operational but don't differentiate"; generic "represent problems that the industry already solved." Evans: "Make the core small."

Baton's subdomains, read off the vocabulary:

| subdomain                                                            | kind       | why                                                                                                |
| -------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| production (workflows, runs, tasks, teams, members, blocks, notes)   | core       | what Baton sells; nothing in Shopify has these words                                               |
| the shop's orders as work to make (positions, issues, items to make) | supporting | Baton's reading of Shopify's orders; no competitor advantage, but Baton cannot run without it      |
| syncing orders from Shopify                                          | generic    | every Shopify app does it; the words are Shopify's                                                 |
| billing and usage metering                                           | generic    | Shopify's App Billing and Partner API; the words are Shopify's; Baton adds "counted order", "seat" |
| auth, sessions, the object, D1                                       | generic    | Better Auth, Cloudflare; not a model of the business at all                                        |

## The context map, and Baton's

Evans: "Identify each model in play on the project and define its bounded context. This includes the implicit models of non-object-oriented subsystems. Name each bounded context, and make the names part of the ubiquitous language." Then: "Map the existing terrain. Take up transformations later."

The relationships between two contexts, one line each:

| pattern              | meaning                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Shared Kernel        | a small subset of the model both sides own and neither changes alone                               |
| Customer/Supplier    | upstream plans with downstream's needs in view; joint acceptance tests                             |
| Conformist           | downstream "slavishly" adopts upstream's model and words; "enormously simplifies integration"      |
| Anticorruption Layer | downstream keeps its own model and translates at the boundary, "in terms of your own domain model" |
| Open Host Service    | upstream publishes a protocol for anyone to integrate with                                         |
| Published Language   | a documented shared language as the medium (often with an open host)                               |
| Separate Ways        | no connection at all                                                                               |
| Big Ball of Mud      | draw a line around the mess and do not model inside it                                             |

Against an external system you do not control, Evans says the choice is "between two extremes: CONFORMIST or ANTICORRUPTION LAYER." Conform when "your application is really an extension to the existing system and your interface with that system is going to be large"; build the layer "when the functionality of the system under design is going to be more involved than an extension to an existing system, where your interface to other system is small." And: "If you decide on a conformist design, you must do it wholeheartedly."

Baton's map, read off the vocabulary and the code:

```
Shopify Admin (orders, fulfillment)            Shopify Partner API (plans, subscriptions, usage)
        │ upstream                                        │ upstream
        │ webhooks, bulk import                           │ subscription query, usage events
        ▼                                                 ▼
   [orders]  ──── downstream, conforms on words ───►  [billing]
   ShopOrder, OrderLineItem                          Plan, AppSubscription, ShopUsage, UsageEvent
   orderIsOpen, unitsToMake  ◄── translation           counted order ── reads ShopOrder.countedAt
        │ upstream to production
        ▼
   [production]  core
   Workflow, Run, RunTask, Team, Member, block, note
   orderPosition, orderIssues, lineItemState   ◄── production's reading of an order
   runActions, taskActions

   [platform]  not a context: the technical dialect (Shop, ShopSession, Actor, ceiling, import, sync)
```

What the map says:

- **Orders is conformist on words and a thin anticorruption layer on model.** The vocabulary's rule "Shopify's things get Shopify's words, unchanged; Shopify's literals are stored as sent and read through a predicate" is Evans's conformist, done "wholeheartedly" for the language. The predicates (`orderIsOpen`, `orderIsFulfilled`, `unitsToMake`) and the sync (`OrderRepository`, `OrderSync`) are the translation: they turn Shopify's `displayFulfillmentStatus` and `cancelledAt` into the one word production needs, "open", and Shopify's quantities into "units to make". That is the right mix for a Shopify app: Evans's conformist case ("an extension to the existing system … interface large") fits the words, and the layer stays thin because production asks orders only four questions.
- **Production is downstream of orders, never the reverse.** Measured in `Domain.ts`: the run block references order symbols about 40 times (`OrderState`, `orderIsOpen`, `unitsToMake`, `ShopOrder`); the order block references production 8 times, and those are page-data shapes (`RunPageData`, `RunListItem`) and two `runActions` mentions in prose, not model. The direction is clean in the model and leaks only in the API shapes.
- **Positions and issues are production, not orders.** The vocabulary already says so (their tables are "production"). `orderPosition` and `orderIssues` read runs (`RunCounts` eight times, `runIsOpen`, `runIsBlocked`). They are production's reading of an order: "not started", "making", "made" are shop-floor words. This is the seam the domain-vocabulary research named ("reconcile is the seam between production and orders"), and it is where a split must be careful: the function takes an orders noun and returns a production word.
- **Billing touches orders through one field.** `ShopOrder.countedAt` is where "counted order" (a billing word) is stored on an orders row. Evans would call a field two contexts both own a shared kernel; keep it small and name it. Today it is one field and one rule ("an order is counted once, when its first run is created", pinned by a test), so it is fine, but it should be the one named crossing, not one of several.
- **Platform is not a bounded context.** "Shop", "session", "Durable Object", "D1", "import", "sync", "ceiling" are not a model of the business; they are the developer dialect Evans allows as an extension. Evans's own booking example has the context run "all the way down" to persistence: the schema is in bounds, it is not its own context. (Fowler disagrees for one case, an in-memory model vs a relational one; not this case.) The vocabulary can keep the "platform" row as "whose words", but it names a dialect, not a boundary, and it would not become a module of its own; its words stay with the code that uses them (`ShopSession` with auth, `ShopLimits` with the object).

So Baton has **one core context, production, one supporting context, orders, one generic context, billing, and a technical dialect**. Three contexts for a one-person app is within Evans's "one or two … perhaps with another context or two in a supporting role", and each is justified by a language change, not by size: "open" and "cancel" mean different things on either side of the orders line; "active" and "subscription" mean different things on either side of the billing line.

## What a split of `Domain.ts` would look like

### The file today

| block                                                                                                    | lines (approx.) | context                       |
| -------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------- |
| vocabulary header                                                                                        | 255             | all                           |
| labels (`TASK_STATE_LABEL` …)                                                                            | 160             | production                    |
| `Shop`, ids, `ShopSession`, `User`, `AuthSession`                                                        | 300             | platform                      |
| `Plan`, `Entitlements`, `AppSubscription`                                                                | 140             | billing                       |
| `Member`, `Team`, `WorkflowLimits`, `ShopLimits`                                                         | 220             | production (limits: platform) |
| `ShopUsage`, billing cycle, `UsageEvent`, meters                                                         | 220             | billing                       |
| names, `Workflow`, `WorkflowDraft`, tasks, inputs, results                                               | 720             | production                    |
| `ShopOrder`, `OrderLineItem`, predicates, seed, sync                                                     | 370             | orders                        |
| `OrderPosition`, `OrderIssue`, views, `OrderRow`, counts                                                 | 540             | production (reading orders)   |
| plan cache, loader data                                                                                  | 190             | platform / screens            |
| `Subscription`, `Actor`, connection state, messages                                                      | 190             | platform                      |
| `Run`, `RunTask`, states, lists, `runActions`, `taskActions`, `lineItemState`, inputs, commands, results | 1,430           | production                    |

Growth: 357 lines on 2026-08-31, 2,011 on 09-06, 3,611 on 09-20, 4,790 on 09-29. It doubled in the last two weeks.

Two facts shape the split:

1. **Production is two thirds of the file.** A context split peels off orders (~370), billing (~360) and platform (~700). Production stays at ~3,000 lines. A split by context alone does not make the core small; Evans's "make the core small" is about the model, and the model here is not what is large.
2. **What is large is the API shapes.** 178 of the 460 exports are `…Input`, `…Result`, `…LoaderData`, `…Command`, `…Page`, `…Data`, `…Row`: the contracts between the routes, the client and the object. They speak the vocabulary but they are not the model; they are the open host service, in Evans's terms, that the screens integrate through. That is a second axis, layer not context, and it is where most of the 4,400 added lines went.

### The mechanics

The split is cheap because of how `Domain.ts` is used: 88 files import it as a namespace (`import * as Domain from "@/lib/Domain"`) and read `Domain.runIsOpen`. `Domain.ts` can become a barrel:

```ts
export * from "./domain/Production";
export * from "./domain/Orders";
export * from "./domain/Billing";
export * from "./domain/Platform";
```

Every import in 88 files stays as it is. The barrel refuses a duplicate export name at typecheck, which is a polyseme detector for free: two contexts cannot both export `isOpen`, and the `<noun>Is<State>` rule already guarantees they do not.

Each context file opens with its own vocabulary (its nouns, states and verbs, in the shape the header has now), and `Domain.ts` keeps the map: the contexts table, the entry test, the shared-words rule, and the Screens table, ~60 lines. `pnpm spec check` reads four files instead of one; `checkVocabulary` checks a symbol against its own file. The rules and matrices move with their symbols and change nothing.

A context's dependencies follow the map, and `rules-lint` can refuse an import the map does not allow: `Orders` never imports `Production`; `Billing` imports `Orders` only for the counted-order field; everything may import `Platform`. That is the "explicit boundary" in the one place an agent cannot miss it, the import line.

### Where it gets hard, in order

1. **`orderPosition`, `orderIssues`, `OrderRow`, `lineItemState`.** They take orders nouns and return production words. They belong in `Production` (the words they return are production's), importing `ShopOrder` and the four predicates from `Orders`. That makes the one-way dependency visible and correct. The alternative, leaving them with the orders types, buries production's reading inside the upstream context, which is the confusion the map is meant to end.
2. **`ShopLimits` and the ceilings.** A platform word (`maxOpenRuns`, `maxMembers`, `maxOrdersPerCycle`) that names production and billing nouns. It stays in `Platform`; the values are enforced by the object, and the nouns it counts are read through the other contexts' predicates.
3. **The API shapes.** Leave them in their context file for the first cut (they speak that context's words), and treat "move `…Input`/`…Result`/`…LoaderData` into a contracts file per context" as the second cut, if the production file is still too big to scan. Splitting both axes at once is the change Khononov warns about: physical before logical.
4. **`ShopAgent.ts` (4,322 lines) hosts all three contexts in one class.** The Durable Object is the application layer for everything; a context split of the model with a single host is half a boundary. That is acceptable for now (Evans: one team can hold several contexts) and is the next thing the map would ask about, not this change.

### What this gives, against Part 1's strain

- The 255-line header becomes ~60 lines of map plus a header per context that an agent sees when it opens that file, which is when it needs those words. Nothing is always-loaded; the fear that an always-loaded file grows is met by not having one.
- Co-location, grep, `{@link}` and the diff all survive unchanged.
- Each context's vocabulary sits with its rules and its matrices, which is the DDD Crew canvas realised in code.
- The author reads the production context's file for the parts that tie things together (`runActions`, `lineItemState`, `currentTasks`) and can ignore orders sync and billing until they matter.
- The map at the top of `Domain.ts` is the thing to iterate on with the agent: three contexts, their relationships, the one named crossing per pair.

What it does not give: a smaller production model. That is the second-axis question.

## Recommendation, round 2

1. **Adopt the map**: production (core), orders (supporting, conformist on words, thin translation), billing (generic, conformist on words), and platform as a dialect not a context. Write it at the top of `Domain.ts` in place of the contexts table, with the relationship and the one named crossing per pair.
2. **Split `Domain.ts` into a barrel plus four context files**, vocabulary per file, rules and tables with their symbols, imports unchanged in the 88 readers. Add the import-direction check to `rules-lint`. One change, mostly moves.
3. **Move the production reading of orders (`orderPosition`, `orderIssues`, `OrderRow`, `lineItemState`) into `Production`**, importing from `Orders`, so the dependency is one-way and visible.
4. **Leave the API shapes where they land** and decide on the contracts split after living with the context split for a while.
5. **Leave `ShopAgent.ts` alone**; note it as the map's next question.

## Decisions, round 2

Reviewed 2026-09-30. Every recommendation accepted:

1. Three contexts: production (core), orders (supporting; conformist on words, thin translation), billing (generic; conformist on words). Platform is a dialect, not a context; its words stay in the vocabulary under "whose words".
2. `Domain.ts` becomes a barrel plus one file per context, each with its own vocabulary at the top; rules and tables move with their symbols; the 88 namespace importers do not change.
3. `orderPosition`, `orderIssues`, `OrderRow`, `lineItemState` live in production, importing from orders.
4. `rules-lint` refuses an import against the map's direction, in the same change.
5. The API shapes stay in their context file; a contracts split is a later question.
6. The map (contexts, relationships, one named crossing per pair, the entry test, the shared-word rule, the Screens table) replaces the contexts table at the top of `Domain.ts`; AGENTS.md points at it.
7. Nothing is always-loaded.
8. Order: map, then barrel and files, then the production reading of orders, then the import check.

## Status

Research done and reviewed twice. No code changed here; the work is in `docs/bounded-contexts-plan.md`.
