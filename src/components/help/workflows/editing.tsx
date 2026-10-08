import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Editing steps and tasks (`workflows/editing`): the editor, its draft, the
 * New step form, the task panel, and Apply changes and Discard changes.
 * Read against `src/routes/app.workflows.$workflowId_.edit.tsx` (opening it
 * writes nothing and the first change makes the draft; the Draft badge;
 * Discard changes and Apply changes in place of the switch on an applied
 * workflow with a draft; Add step and its New step form with Name, Team and
 * Instructions; "Create a team before adding steps." with no teams; Add
 * task under the step of the selected task and its "New task in step n"
 * form; the panel headed Step or Task by whether the task shares its step,
 * with Name, Team, Instructions, Move earlier, Move later, Move to its own
 * step or Join the previous step, Delete with no confirm, and Save; Apply
 * changes confirming only on an active workflow, with Apply as the modal
 * primary; Apply disabled by `applyBlocker`; the Discard modal and its
 * Discard primary; More actions with Rename and Delete), the editor window
 * in `src/lib/workflowEditorWindow.ts` (an apply closes the window; closing
 * leaves the draft), `APPLY_HEADING`, `APPLY_BODY`, `DISCARD_BODY` and
 * `unassignedLine` in `src/lib/workflowShared.ts`, `TeamFaultBanners` in
 * `src/components/WorkflowSteps.tsx`, `move`, `join` and `separate` in
 * `src/lib/WorkflowLayout.ts` (a moved task ends alone in its step), the
 * JSDoc on `Workflow` and `WorkflowTask` in `src/lib/domain/ShopWork.ts`
 * (only Apply writes the tasks in force; new items copy those), and
 * `TASK_INSTRUCTIONS_MAX_LENGTH` with `noteCountFrom` (the field counts down
 * near the limit; the number is on the Limits page, not here).
 */
export function Editing() {
  return (
    <>
      <s-section heading="Open the editor">
        <Things>
          <s-paragraph>
            On the workflow&apos;s page, press <strong>Edit</strong>. The editor
            opens as a window of its own, and opening it changes nothing. Your
            first change starts a draft. The <strong>Draft</strong> badge shows,
            and <strong>Discard changes</strong> and{" "}
            <strong>Apply changes</strong> take the place of the switch in the
            title bar. On a new workflow, <strong>Turn on workflow</strong>{" "}
            stays there instead.
          </s-paragraph>
          <HelpPicture name="editing1" />
          <s-paragraph>
            Until you apply, the workflow&apos;s page shows the steps in force,
            and new items start with those steps. Closing the editor keeps the
            draft for next time.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Add a step or a task">
        <Things>
          <NumberedList
            items={[
              <>
                In the editor, press <strong>Add step</strong>.
              </>,
              <>
                Enter a <strong>Name</strong> and choose a <strong>Team</strong>
                .
              </>,
              <>
                Under <strong>Instructions</strong>, write what the member
                should know, if anything.
              </>,
              <>
                Press <strong>Add step</strong>.
              </>,
            ]}
          />
          <s-paragraph>
            Steps are done in order. Every step needs a team, so until the shop
            has one, the editor says to create a team first. How is in{" "}
            <s-link href="/help/teams-and-members/creating-a-team">
              Creating a team
            </s-link>
            .
          </s-paragraph>
          <s-paragraph>
            To add a task to a step, press a task in it, then press{" "}
            <strong>Add task</strong> under the step. Fill in the same fields
            and press <strong>Add task</strong>. Tasks in one step are done side
            by side, and the next step waits until all of them are done.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Change a step or a task">
        <Things>
          <s-paragraph>
            Press a step or a task. The panel beside the steps shows its{" "}
            <strong>Name</strong>, <strong>Team</strong> and{" "}
            <strong>Instructions</strong>. Change them and press{" "}
            <strong>Save</strong>. The panel is headed Step when the task is
            alone in its step, and Task when it shares one.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              <strong>Move earlier</strong> and <strong>Move later</strong> move
              it earlier or later in the order. It always ends up alone in a
              step.
            </s-list-item>
            <s-list-item>
              <strong>Move to its own step</strong> takes a task out of a shared
              step into a new step just after it.
            </s-list-item>
            <s-list-item>
              <strong>Join the previous step</strong> puts a task that is alone
              in its step into the step before it, to be done side by side.
            </s-list-item>
            <s-list-item>
              <strong>Delete</strong> removes it at once, without asking.{" "}
              <strong>Discard changes</strong> brings it back, and drops every
              other change in the draft too.
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            Instructions have a limit, and the field counts the characters left
            as you near it. The limit is in{" "}
            <s-link href="/help/reference/limits">Limits</s-link>.
          </s-paragraph>
          <HelpPicture name="editing2" />
        </Things>
      </s-section>
      <s-section heading="Apply or discard the changes">
        <Things>
          <s-paragraph>
            <strong>Apply changes</strong> replaces the workflow&apos;s steps
            with the draft. On an active workflow, a modal says the changes take
            effect now, and items already on it keep the tasks they started
            with. Press <strong>Apply</strong>. On an inactive workflow, the
            changes apply at once. The editor then closes and the
            workflow&apos;s page shows the new steps.
          </s-paragraph>
          <HelpPicture name="editing3" />
          <s-paragraph>
            <strong>Apply changes</strong> stays disabled until the draft has a
            step and every task has a team. When a task has no team, the{" "}
            <strong>Needs a team</strong> banner names it.
          </s-paragraph>
          <s-paragraph>
            <strong>Discard changes</strong> drops the draft. A modal says your
            changes will be lost. Press <strong>Discard</strong>, and the editor
            shows the steps in force again.
          </s-paragraph>
          <s-paragraph>
            <strong>More actions</strong> in the editor has{" "}
            <strong>Rename</strong> and <strong>Delete</strong>, the same as on
            the workflow&apos;s page. Both are in{" "}
            <s-link href="/help/workflows/managing">
              Renaming, duplicating and deleting a workflow
            </s-link>
            .
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
