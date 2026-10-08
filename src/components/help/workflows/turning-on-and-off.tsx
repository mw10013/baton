import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Turning a workflow on or off (`workflows/turning-on-and-off`): Active and
 * Inactive, Turn on, Turn off. Read against `WorkflowSwitch` in
 * `src/components/WorkflowSwitch.tsx` (Turn on workflow and Turn off
 * workflow in the title bar, `SWITCH_TITLE_LABEL`; Turn on and Turn off as
 * the modal primaries, `VERB_LABEL`; Turn on disabled by `turnOnBlocker`;
 * the editor's Turn on on a never-applied workflow applying and turning on
 * in one call), `turnOnBody`, `TURN_OFF_HEADING`, `TURN_OFF_BODY` and
 * `unassignedLine` in `src/lib/workflowShared.ts`, the workflow page
 * `src/routes/app.workflows.$workflowId.tsx` (the Active or Inactive badge
 * by the heading; the switch hidden on a never-applied workflow and on an
 * inactive workflow with a draft), the editor
 * `src/routes/app.workflows.$workflowId_.edit.tsx` (the switch shown on a
 * never-applied workflow and on one with no draft), `setWorkflowState` in
 * `src/lib/WorkflowRepository.ts` (Turn off writes the state and touches
 * nothing else), `WORKFLOW_STATE_LABEL`, `workflowIsEligible`, and the Turn
 * on and Turn off rows of the triggers table on `reconcileItem` in
 * `src/lib/domain/ShopWork.ts` (every stored open paid order, however old;
 * turning one of two matching workflows off starts the other).
 */
export function TurningOnAndOff() {
  return (
    <>
      <s-section heading="Active and Inactive">
        <s-paragraph>
          An <strong>Active</strong> workflow starts on every new item that
          carries its tag. An <strong>Inactive</strong> workflow starts nothing,
          and items already on it keep going. The badge shows on the Workflows
          page and beside the workflow&apos;s name on its page.
        </s-paragraph>
      </s-section>
      <s-section heading="Turn a workflow on">
        <Things>
          <NumberedList
            items={[
              <>
                On the workflow&apos;s page or in the editor, press{" "}
                <strong>Turn on workflow</strong>.
              </>,
              <>
                The modal says every open order with an item that carries the
                tag starts this workflow on that item. Press{" "}
                <strong>Turn on</strong>.
              </>,
            ]}
          />
          <HelpPicture name="turningOnAndOff2" />
          <s-paragraph>
            An unpaid order starts the workflow once it is paid.{" "}
            <strong>Turn on workflow</strong> stays disabled until the workflow
            has a step and every task has a team. When a task has no team, the{" "}
            <strong>Needs a team</strong> banner names it.
          </s-paragraph>
          <s-paragraph>
            A new workflow&apos;s page has no switch. In the editor,{" "}
            <strong>Turn on workflow</strong> saves its steps and turns it on in
            one go. The page also hides the switch while an inactive workflow
            has changes not yet applied. Apply or discard them in the editor
            first, as{" "}
            <s-link href="/help/workflows/editing">
              Editing steps and tasks
            </s-link>{" "}
            says.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Turn a workflow off">
        <Things>
          <NumberedList
            items={[
              <>
                On the workflow&apos;s page, press{" "}
                <strong>Turn off workflow</strong>.
              </>,
              <>
                The modal says new orders won&apos;t start this workflow, and
                items already on it keep going. Press <strong>Turn off</strong>.
              </>,
            ]}
          />
          <HelpPicture name="turningOnAndOff1" />
          <s-paragraph>
            Turning a workflow off changes nothing else. Its steps, its tag and
            any draft stay as they are. If an item carries the tags of this
            workflow and another one, turning this one off starts the other on
            it. How is in{" "}
            <s-link href="/help/workflows/matching">
              Matching items by product tag
            </s-link>
            .
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
