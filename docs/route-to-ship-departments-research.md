# Route to Ship departments and task templates — research

Research date: 2026-09-02. Research only, not a Baton spec.

Scope: Route to Ship's department model, the tasks/steps configured inside a department, and the two distinct forms of parallelism. This answers whether Baton should put steps on teams or on workflows.

## Evidence and confidence

This report combines three sources:

| Source                                                                                           | What it establishes                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Logged-in Route to Ship app: Settings > Departments, Pipeline Dashboard, Pipeline Flow, and Help | Current UI controls and the product's own in-app descriptions. Strongest evidence.                            |
| Downloaded Route to Ship site in `refs/route-to-ship/`                                           | Public claims and operational context. Useful corroboration, but marketing copy is not a data-model contract. |
| Existing Baton research                                                                          | The already-decided Baton terminology and current proposed model.                                             |

The live app was inspected in `sandbox-shop-01` on 2026-09-02. The help pages expose their complete answer text as control descriptions, so quoted behavior below is product documentation, not guesswork. Two department toggles, `Count units` and `Confirm each unit`, are visible in the editor but are not described by the help content inspected; they remain unverified.

## Short answer

Route to Ship has **three layers**, not one:

```text
Pipeline                     route and release policy
  -> department occurrence  one operational station in this pipeline
       -> task/step runs     the department's reusable task template
            -> worker action accept / complete / approve / etc.
```

- A **department** is a reusable production station: people, manager, description, work-unit behavior, and a reusable ordered task template. The app itself says it is "a team or workstation".
- **Task** and **step** are two labels for the same configured child of a department. The department editor title is `Tasks (steps)`; its cards say `Step Type`; the help says "Each task in a department has a Step Type."
- A **pipeline** selects departments, orders them or releases them together, and is selected by Shopify product tags. It does **not** define its own task template.
- There are two independent concurrency mechanisms: pipeline-level **Parallel** releases departments together; step-level **Parallel Group ID** releases tasks in the same department together.

This is a station-template model. Reusing a department in multiple pipelines reuses its task list and department policies. That is the central constraint Baton avoids by making a workflow step own the team assignment rather than making a team own the steps.

## Route to Ship configuration model

### Department

The in-app definition is:

> "A department represents a team or workstation in your production process. Each department has members (workers), a manager, and a set of tasks (steps) that define the work to be done."

The creation wizard has four stages:

1. **Basic info**: name; optional parent department; department manager; description shown on the customer tracking portal.
2. **Assign users**: a multi-select list. A user may belong to more than one department; assigned users see that department's work in My Work.
3. **Configure steps**: task name, type, ordering by drag-and-drop, and required flag.
4. **Review**: review and save. Editing reopens the wizard with existing values.

The live department editor also exposes a generated/displayed **slug**, manager, assigned users, task list, and department-level work-mode switches. It allows editing and deletion. The list screen supports top-level departments and nested sub-departments.

### Department properties

| Property                                 | Observed/documented semantics                                                                                                                                                             | Confidence |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Name                                     | Department's display name. Example names: Engraving, Assembly, Dispatch.                                                                                                                  | High       |
| Slug                                     | Visible read-only-like value in the editor (`department-01`). Exact generation/edit rules not researched.                                                                                 | Medium     |
| Parent department                        | Optional. Creates a sub-department. It inherits its parent's _position in the pipeline_, but keeps its own members and tasks. Example: `Engraving > Fine Detail` and `Engraving > Bulk`.  | High       |
| Description                              | Set in Basic Info; shown to customers on the tracking portal.                                                                                                                             | High       |
| Members                                  | Determines who sees the department's tasks in My Work. Many-to-many: one user may be in several departments.                                                                              | High       |
| Manager                                  | Selected in Basic Info. Receives Manager Dashboard visibility for that department and can handle escalations.                                                                             | High       |
| Complete once per order (`workPerOrder`) | Off: each line item is a separate task. On: all an order's line items are grouped into one task for this department. Intended example: Dispatch, which processes an entire order at once. | High       |
| Allow print                              | Shows Print on task cards. A worker must print before Done is enabled. Intended example: printed proof at a Print department.                                                             | High       |
| Count units                              | Visible department toggle. Its exact unit source and effect were not described in inspected help.                                                                                         | Unverified |
| Confirm each unit                        | Visible department toggle. Its exact relationship to Count units and completion was not described in inspected help.                                                                      | Unverified |

The screenshot supplied for this research shows `Count units` enabled while the other four visible work-mode switches are off. That establishes the control exists, not its runtime behavior.

### Tasks (steps) within a department

Every configured child has:

- A free-text task name.
- An order, shown as `#1`, `#2`, etc.; the creation wizard says the merchant can drag to set order.
- A `Step Type`.
- A `Must complete` required checkbox.
- Add and remove controls. The editor saves the task list together with `Save all tasks`.

The app documents five step types:

| Type              | Worker interaction and use                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start/Stop**    | Standard timed work. Worker clicks **Accept** to claim/start it, then **Done**. Best when elapsed time matters.                                                            |
| **Checklist**     | Direct check-off; no Accept step. Intended for quick verification such as quality or packaging checks.                                                                     |
| **Auto-Complete** | Completes automatically when the previous step finishes. Intended for non-human logging or a handoff such as "Notify next department."                                     |
| **Approval**      | Requires sign-off. Configurable approver scope: any department member, line managers only, any admin, or one specified user. The order cannot move forward until approval. |
| **Parallel**      | Tasks sharing a Parallel Group ID run at the same time within the department.                                                                                              |

`Required` clearly applies to each task, but the exact behavior when an optional task is left incomplete was not spelled out in the inspected help. Pipeline-level `Require All Steps` is a separate control, discussed below.

Task execution is queue-based. My Work contains pending tasks from the worker's assigned departments, grouped by order. Standard view provides full order details, notes, and actions; Production/Tablet view emphasizes large Accept/Done controls. Workers can add/view step-specific notes. Past Work records start and completion timestamps and the latest note.

### Pipeline

Route to Ship says a pipeline is "the sequence of departments an order passes through from start to finish." Its pipeline builder configures:

- Name.
- Comma-separated Shopify **product tags**.
- Pipeline mode: **Sequential** or **Parallel**.
- `Require All Steps`.
- A set of departments selected from existing department templates.
- Department ordering in sequential mode.

At order sync, Route to Ship examines **each line item's product tags**. Any matching pipeline tag routes that line item to the pipeline. A line item may match multiple pipelines through multiple tags; each matching pipeline is independently applied. This agrees with `docs/route-to-ship-tag-routing-research.md` and the public integration copy in `refs/route-to-ship/integrations/shopify.md:23`.

The pipeline builder's `Require All Steps` is documented as: "if every step in every department must be completed." Exact interaction with a task's individual `Must complete` flag is not explained, so Baton should not infer a truth table from the labels alone.

## Ordering and concurrency

### Pipeline-level sequential vs parallel

These modes govern **departments**, not the tasks inside a department:

| Mode       | Release rule                                                                                                                  | Appropriate when                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Sequential | Departments run in configured order. The next department unlocks only after the preceding department completes all its tasks. | Work has a physical/information dependency: print -> engrave -> QC -> pack. |
| Parallel   | All pipeline departments can work on the order simultaneously.                                                                | Departments are independent aspects of an order.                            |

Route to Ship explicitly advises that most production flows use sequential and that parallel is only for genuinely independent departments. The live Pipeline Dashboard labels the configured pipeline `SEQUENTIAL`; the live Pipeline Flow renders a department node with a step count and current progress, confirming the displayed execution unit is the department with aggregated steps.

### Step-level parallel groups

`Parallel` is also a step type, but this is a different scope: tasks with the same Parallel Group ID run simultaneously **within one department**. The documentation does not state how a department mixes one or more parallel groups with ordinary ordered steps, whether group IDs are surfaced in the editor shown here, or how an optional member of a group affects release. Treat these as open behavior, not a reusable Baton design.

### Example: why the layers matter

```text
Pipeline: custom necklace, sequential

1. Print department
   - Print work slip             Start/Stop
   - Print proof                 Checklist

2. Engraving department
   - Engrave front               Parallel, group A
   - Engrave back                Parallel, group A
   - Quality sign-off            Approval

3. Dispatch department, complete once per order
   - Pack all line items         Start/Stop
   - Print shipping proof        Start/Stop; print required
```

The pipeline only says `Print -> Engraving -> Dispatch`. Each department supplies the reusable work template and its work-unit policy. With parallel pipeline mode, all three departments would be released immediately; the two engraving tasks could still be parallel within their own department.

## Consequences of placing steps on departments

### What Route to Ship gains

- **Station SOP reuse.** Every pipeline that includes Engraving uses the same task template, approval checkpoints, print rule, and line-item/order grouping behavior.
- **Fast configuration for stable shops.** A merchant creates stations and people once, then assembles pipelines from them.
- **One operational home.** Manager dashboards, queue depth, personnel, task metrics, and the work card all group naturally by department.
- **Consistent worker experience.** A worker sees a department queue with the same task convention regardless of the product pipeline that supplied it.
- **Sub-department specialization.** The model has an escape hatch: create a nested department with different people/tasks while retaining its parent's pipeline position.

### What it costs

- **A team/station has one reusable canonical process.** If an Engraving team needs different tasks for rings versus tumblers, the merchant must either compromise on a shared template, add irrelevant/optional tasks, or create specialized departments/sub-departments.
- **Operational identity and work definition are coupled.** Altering a department's task template changes every pipeline that refers to it, not just one product flow.
- **Department proliferation.** Product-specific SOP variants produce `Engraving - Rings`, `Engraving - Tumblers`, etc., even when the same people/machines do the work.
- **Cross-cutting policies are awkward.** `Complete once per order` and `Allow print` attach to the department. A reused department cannot naturally be per-line-item in one workflow and per-order in another.
- **Two axes of concurrency increase cognitive load.** Merchants must distinguish parallel departments from parallel steps, plus required-task and require-all-steps controls.

The help copy calls departments "building blocks" and pipelines a "recipe." This is intentional template reuse, not accidental terminology. It is a good fit when physical stations have stable SOPs; it is less good when the workflow is the thing that varies most.

## Baton comparison

Current Baton research proposes:

```text
Team (members / who can work)
Workflow (product-tag-selected production definition)
  -> ordered workflow steps
       -> each step names work and references exactly one team
```

See `docs/team-research.md:150-153` and `docs/workflow-definition-research.md:9-23`. That deliberately collapses Route to Ship's department plus task-template layers into a workflow step.

| Question                                                 | Route to Ship                                                                            | Baton's current model                                      |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Who can do work?                                         | Department members                                                                       | Team members                                               |
| What repeats?                                            | Department task template                                                                 | Workflow step definition                                   |
| What does a pipeline/workflow compose?                   | Departments                                                                              | Steps directly                                             |
| Can same people be used with different work sequences?   | Yes, but typically via another department/sub-department or a shared template compromise | Yes, reference the same team from different workflow steps |
| Where does per-order versus per-line-item behavior live? | Department (`workPerOrder`)                                                              | Not designed yet; can be workflow-step-specific            |
| Where does task type/instruction/approval live?          | Department task                                                                          | Not designed yet; can be workflow-step-specific            |
| Main optimization                                        | Stable stations and their SOPs                                                           | Product/process-specific flows without duplicating teams   |

The existing Baton decision therefore remains sound for the stated goal: **keep teams as people/authorization and keep workflow steps as work definitions.** A team should not acquire Route to Ship-style task templates by default. Doing so would recreate the coupling Baton is trying to avoid.

### Recommended Baton direction

1. Keep `Team` member-only. Do not put task/step templates, product routing, or work-unit policy on it.
2. Keep each `WorkflowStep` as the work-definition boundary: name, owning team, position, and eventually task kind, instructions, approval policy, completion scope, and quantity behavior.
3. Keep sequential execution first. This matches the existing decision in `docs/workflow-definition-research.md:150-159` and Route to Ship's own recommendation that most production flows are sequential.
4. When parallelism is needed, model it on the workflow graph/step release relationship, not as a property of a team. A `parallelGroup` on workflow steps is an additive route from the current dense positions.
5. Design a reusable **step template/SOP library** only if merchants actually repeat detailed work definitions across workflows. It should be a separate optional reference/copy mechanism, never a mandatory property of a team. Copy-on-use avoids a shared template edit silently changing multiple workflows.
6. Make completion scope explicit on the workflow step when instantiation is designed: `perLineItem`, `perOrder`, and potentially `perUnit`. Route to Ship demonstrates that Dispatch has a real per-order use case. Do not adopt `Count units`/`Confirm each unit` until their behavior has been experimentally verified.

### Future parallelism conclusion

Baton will probably need limited within-workflow parallelism eventually, but not a pipeline-wide switch that releases every team at once. Use a staged model:

```text
Stage 1: Prepare artwork, Pick materials       parallel
Stage 2: Produce                               after Stage 1
Stage 3: QC, Prepare packaging                 parallel
Stage 4: Dispatch                              after Stage 3
```

An optional `parallelGroup` (or stage) on `WorkflowStep` is sufficient for that first version. Required steps in a group form a join: all must complete before the next group becomes available. This keeps the merchant model ordered by default, makes the completion rule visible, and avoids prematurely supporting arbitrary graphs, branch failure, rework paths, or team-level parallelism.

Line items already run independently when they match separate workflow instances. That is useful concurrency without workflow-step parallelism. Add parallel groups only after a real single-line-item workflow has independent work that must later join.

This delivers Route to Ship's useful separation of people from queue eligibility while avoiding its forced reuse of a department's SOP. It also preserves a future option to share a step template where standardization is truly desired.

## Open questions before Baton copies any advanced behavior

1. What does Route to Ship's `Must complete` do when pipeline `Require All Steps` is off? Is it a per-task override, or only UI guidance?
2. What exact conditions complete a department in the presence of optional tasks, auto-complete tasks, and parallel groups?
3. What are the data and UI semantics of `Count units` and `Confirm each unit`? Is a unit a line-item quantity, a manually entered count, or something else?
4. Does a reused Route to Ship department's task edit affect in-flight work, only new work, or a snapshotted department occurrence? The app's help does not say.
5. Can one department appear multiple times in one pipeline? The builder help does not specify.
6. How does an approval step identify a line manager when department manager and user role are separate concepts?

These are questions to answer by creating throwaway departments/pipelines and running test orders, not by making Baton schema assumptions.

## Live experiment note

On 2026-09-02, the logged-in Route to Ship `My Work` screen was inspected to test unit and per-order behavior. It reported `0 tasks across 0 orders`, so there was no existing executable task to observe. A conclusive experiment would require creating a throwaway product, tagged pipeline, department, and Shopify order with quantity greater than one. That work is intentionally deferred: it would not change the current Baton POC, which should instantiate sequential work per line item first.

## Source excerpts

- In-app Help > Departments > "What is a department?": "Each department has members (workers), a manager, and a set of tasks (steps) that define the work to be done."
- In-app Help > Departments > "Step types explained in detail": "Parallel — Steps with the same Parallel Group ID run simultaneously."
- In-app Help > Departments > "Work mode settings": "When enabled, all line items in an order are grouped into a single task for this department. When disabled, each line item is a separate task."
- In-app Help > Pipelines > "Sequential vs Parallel modes": "Each department must complete all steps before the next department is unlocked" versus "All departments can work on the order simultaneously."
- In-app Help > Pipelines > "Shopify tag routing explained": each matching pipeline routes the line item independently.
- `refs/route-to-ship/demo.md:33-35`: "Sequential or parallel. Custom step types: start/stop, checklist, approval."
- `refs/route-to-ship/support.md:33-35`: create departments first, then build a pipeline that chains them together.
- `refs/route-to-ship/blog/sops-for-scaling-custom-shopify-products.md:126-128`: describes checklist-type steps "inside each department's workflow" alongside start/stop and approval.
- `docs/workflow-definition-research.md:34`: Baton previously recorded the competitor's department template shape; this research verifies and materially expands it from the logged-in application.
