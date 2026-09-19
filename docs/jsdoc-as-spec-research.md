# JSDoc as specification: how much rule belongs next to the code

## The case that prompted this

The work page hid Undo on a `done` run. The rule it violated was already
written down, in the JSDoc on `WorkflowRunRepository.uncompleteStep`:

> A `done` run is *not* terminal here — undoing its last step is the point —
> only a cancelled one is.

The write enforced it. `Domain.undoBlockedBy` existed precisely so "the
button and the refusal cannot disagree", and two of its three UI readers
(the queue's Done tier, the merchant's Reopen) followed it. The third reader
wrapped every action in its own inline predicate, `status === "pending" ||
status === "active"`, with no comment claiming that as a rule.

So the failure was not "the spec was missing". It was:

1. The rule lived at the write site only. The reader that broke it never
   linked to it, so nothing in the diff pointed at the contradiction.
2. The reader re-derived a status predicate inline instead of calling a
   Domain function. Once a rule is re-derived it can drift.
3. No test pinned "a done run's last step is undoable" from the UI's point
   of view. The repository test covers the write, not the gate.

This is the shape most spec-vs-code bugs will take here: the rule is known,
stated once, and a second site quietly invents a stricter or looser version.

## What we hold as fixed

- Source is primary. It is what runs. It can be wrong, and when it is, the
  fix is to the source.
- `docs/` is scratch. Research and plans go stale and get deleted, so nothing
  in `src/` may depend on or cite them. This file will be deleted too; what
  survives is whatever it changes in `src/` and `AGENTS.md`.
- A full spec in JSDoc is wrong. It would be long, it would duplicate the
  code, and duplication is the thing that goes stale.

## The middle ground: rules at their owner, links everywhere else

A rule is a sentence about behaviour that more than one place must agree on.
"Undo is allowed unless a later stage has started" is a rule. "This filter
drops rows with null teamId" is not; the code shows it.

Proposal:

**Every rule has exactly one owner, and the owner's JSDoc states it as a
rule.** The owner is the symbol that enforces it: usually a `Domain` function
or a repository method. The statement is normative ("allowed while…",
"refused when…", "only `cancelled` is terminal here"), not narrative about
the implementation. The existing `undoBlockedBy` and `uncompleteStep` docs
are already this.

**Readers do not restate the rule. They link to it.** A UI gate or a second
write path carries `{@link Domain.undoBlockedBy}` or a one-line "follows the
rule on `uncompleteStep`". A reader that needs a *different* rule says so and
says why, in its own JSDoc. That is the sentence that was missing on the
work page's `open`: either "same rule as the write" or "stricter than the
write because …". Either would have made the bug visible in review.

**Readers do not re-derive status predicates.** Where a rule is a predicate
on domain rows, it is a `Domain` function and the UI calls it. The codebase
already argues for this in `undoBlockedBy`'s doc: "a second copy of this rule
is exactly the drift to avoid". Apply the same standard to run status. Today
three routes each write `status === "pending" || status === "active"`; a
`Domain.runIsOpen` (or a per-action predicate) would give the rule one home
and one doc.

**Every owner rule has a test that names it.** The test title is the rule in
plain words, as `workflow-run-repository.test.ts` already does ("is refused
once downstream started"). Tests are the one form of spec that cannot go
stale silently. Where the rule is enforced in two layers (write and gate), the
gate gets its own test, because that is the layer that broke.

**Lifecycle rules that span several symbols get a module-level JSDoc.** Run
status, terminal-ness per action, and the undo rule together are about a
page of prose. That belongs at the top of the `WorkflowRun` section of
`Domain.ts`, not in `docs/`, because it moves with the code it governs and a
reviewer sees it in the same diff. It is a table of rules with owners, not a
narrative:

```
Terminal-ness is per action, not per status:
  start / complete / note / block   refused on done, cancelled   (RunTerminalError)
  uncomplete                        refused on cancelled only    (uncompleteStep)
  uncancel                          allowed on cancelled only    (uncancelRun)
Undo is blocked by downstream work, never by status: undoBlockedBy.
```

That is the whole "spec". Anything longer is either code or a research doc.

## Why this beats the alternatives

- **Spec in `docs/`**: goes stale, gets deleted, and nobody reads it while
  editing `src/`. The rule has to be in the diff to be reviewed.
- **Spec fully in JSDoc**: duplicates the code, goes stale in the same way,
  and buries the few real rules in narration.
- **No spec, code only**: exactly the bug above. Code shows *what*, and two
  sites can each show a different *what* with no signal that one is wrong.
- **Rules at the owner, linked, tested, with a short lifecycle table**: each
  rule is written once, has a symbol to grep for, a test to fail, and a place
  a reviewer will see it next to a change.

## What changes in `AGENTS.md`

Current wording: JSDoc is "for complex and subtle behavior the code cannot
show". Keep that, and add:

> JSDoc also carries *rules*: any behaviour more than one site must agree on
> is stated once, normatively, on the symbol that enforces it. Other sites
> `{@link}` it rather than restate it, and a site that follows a different
> rule says so and why. Status and readiness predicates are `Domain`
> functions, never inline comparisons in routes. Each rule has a test whose
> title is the rule.

## Trade-offs to accept

- Slightly more JSDoc on `Domain` and repository symbols. Bounded, because
  only rules qualify and most functions have none.
- A few more small `Domain` predicates. Each is a line of code and a doc; the
  gain is one grep to find every reader.
- Linking creates coupling in prose. A renamed symbol breaks a `{@link}`, but
  TypeScript-aware editors flag that, which is the staleness signal `docs/`
  never had.

## Recommendations, with examples

### 1. Predicates: uniform, not per action

Recommendation: two Domain predicates, not one per action and not case by
case.

The evidence is already in the tree. The repository has a private
`isTerminal` (done or cancelled). `ShopAgent` has a private `isOpen`
(pending or active). Routes inline the same two comparisons about a dozen
times, and every one of them is one of exactly two shapes:

| shape | meaning | used by |
| --- | --- | --- |
| `pending \|\| active` | run is **open**: work can still be recorded | start, complete, note, block, assign team, ready-step gates, "open" counts |
| `!== cancelled` | run is **live**: it still counts for its line item | undo, uncancel's inverse, "which run is this item's" lookups |

Every action in the system is gated by one of those two. Per-action
predicates (`runAcceptsUndo`, `runAcceptsNote`, …) would be six names for two
functions, and the naming would hide the fact that they collapse. Case by
case is what produced the bug: the work page picked "open" for undo because
nothing said undo is a "live" rule.

So:

```ts
// Domain.ts, next to RunStatus
/** Work can still be recorded: Start, Done, notes, Block, team assignment. */
export const runIsOpen = (run: { status: RunStatus }) =>
  run.status === "pending" || run.status === "active";

/**
 * The run still stands for its line item. Only `cancelled` is out, because
 * only `cancelled` was chosen; `done` is the last step's Done and is undone
 * the same way. Undo and the "which run is this item's" lookups use this.
 */
export const runIsLive = (run: { status: RunStatus }) =>
  run.status !== "cancelled";
```

The repository's `isTerminal` becomes `!runIsOpen`, `ShopAgent`'s `isOpen`
is deleted, and the routes call the Domain functions. An inline status
comparison in a route then reads as a smell in review.

### 2. Tests: unit, over a lifted helper

Recommendation: unit tests. The work page's gate is a pure function of the
view and the member's teams once it is lifted out of the component:

```ts
// Domain.ts or a small lib module
export const stepActions = (
  view: RunView,
  step: RunStepView,
  teamIds: readonly TeamId[],
) => {
  const mine = step.teamId !== null && teamIds.includes(step.teamId);
  const calm = view.run.flag === null;
  return {
    start: mine && calm && runIsOpen(view.run) && step.ready && step.startedAt === null,
    done: mine && calm && runIsOpen(view.run) && step.ready && step.completedAt === null,
    undo: mine && calm && runIsLive(view.run) && step.completedAt !== null && step.undoBlockedBy === null,
    note: mine && runIsOpen(view.run),
  };
};
```

and the test whose title is the rule:

```ts
it("a done run's last step is undoable while nothing downstream started", …)
it("a cancelled run offers no actions", …)
it("a flag hides Start, Done and Undo but not the note", …)
```

The same helper can serve the queue's Done tier, so the two member surfaces
cannot disagree by construction. E2E stays for the socket and the render,
not for the rule.

### 3. Where the rules live: table at the concept's owner, links from readers

You asked for examples of each. Here are both, on the real symbols.

**(A) Per-symbol rule plus link.** This is what the tree does today. The
owner:

```ts
/**
 * Undo: clears the completed slot … Allowed for the step's team while
 * nothing downstream has started (`StepUndoBlockedError` otherwise, naming
 * the blocker). A `done` run is *not* terminal here — undoing its last step
 * is the point — only a cancelled one is.
 */
readonly uncompleteStep: …
```

and a reader, the sentence the work page was missing and now has:

```ts
/**
 * Undo outlives `open`. A `done` run is only the last step's Done, and
 * `WorkflowRunRepository.uncompleteStep` accepts it … Start, Done, notes and
 * Block stay on `open`: the repository treats `done` as terminal for all of
 * them.
 */
const undoable = …
```

It is precise and lives where the enforcement is. Its weakness is the one
you named: to check that the seven writes are coherent you open seven
JSDocs. Nothing shows you the whole.

**(B) A table at the owner of the concept.** `RunStatus` is where every
status rule is about, so its JSDoc carries the table:

```ts
/**
 * Derived from the run's steps and stored for querying; every step write
 * recomputes it in the same transaction. `cancelled` is the one value steps
 * cannot produce …
 *
 * What each status permits. Two predicates cover every action; a route
 * never compares `status` inline.
 *
 * | action                                   | gate           | refusal            |
 * | ---------------------------------------- | -------------- | ------------------ |
 * | start, complete, note, block, assign team | {@link runIsOpen} | `RunTerminalError` |
 * | uncomplete (Undo / Reopen)               | {@link runIsLive} | `RunTerminalError` |
 * | uncancel                                 | `cancelled` only | `RunTerminalError` |
 * | cancel                                   | {@link runIsOpen} | `RunTerminalError` |
 *
 * Undo is additionally blocked by downstream work, never by status:
 * {@link undoBlockedBy}. `done` is not a lock; it is the last step's Done,
 * and is undone the same way.
 */
export const RunStatus = …
```

Each write's JSDoc then shrinks to one line: "Gate: `runIsOpen`, see
`RunStatus`." The reader on the work page says "Undo is a `runIsLive` rule,
see `RunStatus`."

**Recommendation: (B), with (A) kept as one-liners.** They are not
competing. The table is the index and the coherence check; the per-symbol
line is the pointer that keeps a reader from re-deriving. The scatter you
are worried about is real under (A) alone, and the fix is not more prose at
each site but fewer rules: once `runIsOpen` and `runIsLive` exist, the
table has four rows and every site names one of two functions. That is
small enough to stay true.

Where a table belongs: on the symbol that *is* the concept, usually a
`Schema.Literals` or a branded type, not on a function. Status, flag,
readiness are the three candidates today. A table on a function is a sign
the concept has no symbol yet.

Maintenance cost: a row changes when a gate changes, and the gate is a
`Domain` function the table already links to, so the diff that changes one
touches the other's file. That is the co-location `docs/` never had.

## Decisions (reviewed 2026-09-19)

All three recommendations accepted:

1. Uniform predicates `runIsOpen` / `runIsLive` in `Domain`, no per-action
   predicates.
2. Unit tests over a lifted pure helper, preferred over e2e. Backend code,
   including the helper if it lands in `Domain` or a repository, follows
   Effect idioms. Pure Domain tests already live in
   `test/integration/domain.test.ts`; the gate tests go beside them.
3. Rule table on the concept's symbol (`RunStatus`), with one-line
   `{@link}` pointers from each enforcing and reading site.

Correction found while drafting the table: `cancelRun` refuses `done` as
well as `cancelled`, so cancel's gate is `runIsOpen`, matching the
`RunStatus` doc ("from anywhere but `done`"). The table above is corrected.

## Scope, measured

Inline `status` / `flag` comparisons outside `Domain` today:

| file | count |
| --- | --- |
| `app.orders.$orderId.tsx` | 20 |
| `WorkflowRunRepository.ts` | 9 |
| `shop.$shop.work.$runId.tsx` | 7 |
| `shop.$shop.index.tsx` | 2 |
| `ShopAgent.ts`, `OrdersSyncWorkflow.ts` | 1 each |

Concept symbols (`Schema.Literals`) in `Domain.ts`: 15. Of those, the ones
with rules more than one site enforces: `RunStatus`, `RunFlag`,
`ProductionState`, `BulkOperationStatus`, `UserRole`, `ConnectionRole`.

The run-status refactor is the pilot. The pattern then applies concept by
concept; see the follow-on research on doing this across the codebase.

## Status

Done. Superseded by the codebase-wide plan once that exists; delete then.
