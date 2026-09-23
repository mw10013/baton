# Stage and step concept research

What a row on the member page (`/shop/$shop`) actually is, why it is hard to parse, and whether the app's two-level model (stages that contain steps) is the right conceptual frame or needs to be embraced or replaced.

Written 2026-09-23.

## What a row is today

Each row is one **workflow run**, and a run is one **order line item** going through one **workflow**. Not an order. Order #2009 appears twice in the screenshot because it has two line items (a Leather journal and a Signet ring), each with its own run. The `RunListItem` schema in `Domain.ts` is `{ run, steps, stageCount }`, where `steps` is every step of that run that is _ready_ (open, nothing in an earlier stage still open) and on one of the member's teams.

The row renders:

| Slot               | Source                                | Example           |
| ------------------ | ------------------------------------- | ----------------- |
| Line 1, subdued    | `run.orderName`                       | `#1002`           |
| Line 1, strong     | `steps[0].name`                       | `Stamp monogram`  |
| Line 1, `+n`       | `steps.length - 1`                    | `+1`              |
| Line 2, item title | the line item's product title         | `Leather journal` |
| Line 2, position   | `Step ${step.stage} of ${stageCount}` | `Step 2 of 3`     |
| Line 2, team       | `step.teamName` when on several teams | `Engraving`       |

So the reading is: order → the first ready step's name → how many _more_ ready steps the run has for you → item → where the run is → which bench.

Three things go wrong:

1. **The `+1` counts ready steps, but the label says nothing about what is being counted.** It is the row's only hint that stage 2 of Leather journal has two parallel steps (Stamp monogram plus something else on the Engraving team). Nothing on the page says "steps" or "at the same time".
2. **"Step 2 of 3" is a stage number.** `stageCount` is the run's last stage and `step.stage` is the stage index. Leather journal has more than three steps but three stages. The word "step" is borrowed because "stage" is never introduced to a member.
3. **The workflow name is not on the row.** `RunListRun` omits `workflowName` deliberately (the row was cut down to the item's title). The member run page shows it as a badge. The row jumps from the order straight to one step's name, which is the lowest level of the model.

## Where "stage" is visible today

| Surface                | What the member or merchant sees                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflow detail/editor | `StageFlow` draws one block per stage with a subdued `Stage n` label; parallel steps sit under one label with no box. The add control reads "Add a step that runs at the same time". |
| Editor step panel      | `separateStep` / `joinStep` / `moveStep` mutations exist; the panel's verbs are the only place a stage is manipulated.                                                               |
| Member run page        | Each step is headed `${stage} · ${name}`, so parallel steps show the same number. A waiting step says `waiting on step n-1`, again using the stage index.                            |
| Member list row        | `Step k of n` and `+n`, both stage facts labelled as step facts.                                                                                                                     |
| Domain                 | `WorkflowStep.stage` is a dense non-decreasing integer along `position`; `WorkflowLayout` recomputes it on every edit. A stage of one step is the linear case.                       |

The pattern: the domain is built on stages, the editor half-says the word, and everything the member reads avoids it. The avoidance produces the `+1`, the same-number steps on the run page, and "step 2 of 3" meaning stages.

## The model, from first principles

What the app actually needs to express:

- A workflow is an ordered sequence of _waits_. Work in position k cannot start until everything in position k-1 is done.
- Within one position, there may be more than one unit of work, each with its own team, its own Done button, and its own start/complete actor. The note is on the run, not the unit.
- The linear case (one unit per position) must be the default reading, because that is what most shops have and what "a workflow has steps" already conveys.

Any two-level model has to name both levels. The current choice is **stage** (the wait) contains **step** (the unit of work). The user's alternative is **step** (the wait) contains _something_ (the unit of work). Both are the same shape. The question is which word lands on which level, and whether the inner name can be found at all.

### Option A: embrace stage/step as they are

Keep `stage` for the wait, `step` for the unit of work, and say "stage" everywhere a wait is meant.

- Member row line 2: `Stage 2 of 3` instead of `Step 2 of 3`.
- Member run page: group steps under a `Stage n` heading like `StageFlow` does, instead of prefixing every step with the same digit.
- `+1` becomes `· 2 steps` or `and 1 more step`, or the row lists both step names.
- Editor: keep "runs at the same time" but show the `Stage n` label consistently.

Pros: no domain rename; the editor is already half there. Cons: "stage" is a second noun every merchant must learn, and for the linear shop it is pure overhead: stage 1 is step 1, stage 2 is step 2. The `Stage n` labels in the linear case look like a bug (why two numbers?).

### Option B: step is the wait, and the inner thing gets a new name

Rename so the thing everyone already understands, the step, is the sequential unit. A step contains one or more of the inner thing. In the linear case the inner thing is invisible: the step _is_ its one unit.

Candidate inner names, with how they read in the UI:

| Name              | "Step 2 has two ___" | Button on step   | Reads well when parallel                         | Reads well when linear       |
| ----------------- | -------------------- | ---------------- | ------------------------------------------------ | ---------------------------- |
| task              | tasks                | Add a task       | yes                                              | yes (a step with one task)   |
| job               | jobs                 | Add a job        | yes, but "job" also means the order in shop talk | mixed                        |
| operation         | operations           | Add an operation | yes, manufacturing term                          | heavy                        |
| team / assignment | teams / assignments  | Add a team       | yes if every unit is "team X does this"          | odd if two units on one team |
| part              | parts                | Add a part       | collides with physical parts                     | no                           |
| lane / track      | lanes                | Add a lane       | visual, not verbal                               | no                           |

"Task" is the strongest: a step has one task by default, a parallel step has several, and each task is what a member starts and finishes. The note stays on the run. Route-to-ship, Kanbanify, and Makers Production View all use "step" or "stage" as the sequential unit and none of them have parallelism, so there is no competitor precedent for the inner name.

Pros: the member vocabulary is "step" for the thing they wait on and "task" for the thing they do, which matches how they already talk. "Step 2 of 3" becomes true. Cons: it is a domain rename (`WorkflowStep` → `WorkflowTask`, `stage` → `step`, every schema, table, test, and JSDoc), and the merchant editor becomes "add a step" vs "add a task to this step".

### Option C: hide the wait entirely

Steps are the unit of work; parallelism is expressed as a per-step flag "can start alongside the previous step" (or a dependency on a named earlier step). No second noun at all.

Pros: one noun. Cons: the wait is still real and still has to be displayed ("waiting on Cut and Stitch"), which just moves the concept from a name to a sentence; and "step 2 of 5" becomes ambiguous when steps 2 and 3 run together. This is the model that produces the current `+1`.

## Recommendation

Option B, with `task` as the inner name. Accepted 2026-09-23.

In Option B's vocabulary: a **workflow** is a sequence of **steps**; each step has one or more **tasks**; a task has a name and a team. In the linear case a step has exactly one task, and the task's name is what the merchant typed when adding the step, so nothing new shows. Steps are numbered, not named: "step 2" is a position, and what the member reads at that position is the task names.

The row, restated in those terms:

```
#1002  Leather journal                       ···
Stamp monogram · Engrave initials · Step 2 of 3
```

Line 1: order and item, which is what the row is. Line 2: the name of every task in the current step that is ready and on the member's teams, then the step position. The team goes on each task where it differs, since two tasks in a step can be on different teams:

```
Stamp monogram (Engraving) · Engrave initials (Finishing) · Step 2 of 3
```

When every listed task is on one team and the member is on several teams, the team prints once at the end as today. No `+1`: the second name replaces the count. The workflow name stays off the row.

Rollout: one implementation pass covering the domain rename, the schema (edited inline, no migration; all local state is reset from scratch), the member row and run page wording, the editor, the tests, and the JSDoc. See `docs/stage-step-implementation-plan.md`.

## Decisions

Decided 2026-09-23 by annotation.

1. **The row is the run.** One row per order line item's run. Two rows for `#2009` is correct once line 1 says the item.
2. **The inner unit is `task`.** A step has one task by default, several when parallel. Tasks have names and teams; steps are numbered positions.
3. **Design linear-first.** A one-task step prints as the task name alone; the word "task" never appears on the member page for a linear shop.
4. **No workflow name on the member row.** The item title carries it; the run page badge names it.
5. **Keep "Step k of n" on the row.** Under the new model it is true, and it is the row's only sense of progress.
6. **One implementation plan for everything.** Rename, wording, editor, tests, JSDoc together. Schema changes are made inline in the initial `create table` statements, with no SQL migration, because all local DO and D1 state is reset from scratch.
