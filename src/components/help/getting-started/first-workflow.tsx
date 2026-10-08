import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Creating your first workflow (`getting-started/first-workflow`): Create
 * workflow, the editor's New step form, Add task, Turn on workflow, and the
 * tag in Shopify. Read against `src/routes/app.workflows.index.tsx` (Create
 * workflow, the Name and Tag fields, the tag mirroring the name in lowercase
 * until the Tag field is typed in, `TAG_HELP`, Create opening the editor,
 * the Active badge), `src/routes/app.workflows.$workflowId_.edit.tsx` (Add
 * step and its New step form with Name, Team and Instructions; Add task
 * only under the step of a selected task; "Create a team before adding
 * steps." with no teams; Turn on workflow on a never-applied workflow,
 * which applies and turns on at once), `WorkflowSwitch` and `turnOnBody`
 * and `turnOnBlocker` in `src/lib/workflowShared.ts` (the Turn on modal and
 * why the button is disabled), `SWITCH_TITLE_LABEL`, `VERB_LABEL.turnOn`,
 * `WORKFLOW_STATE_LABEL` and `WorkflowTag` and `itemMatches` in
 * `src/lib/domain/ShopWork.ts` (one tag per workflow, matched exactly; a
 * paid order is the creation gate on `reconcileItem`).
 */
export function FirstWorkflow() {
  return (
    <>
      <s-section heading="Create the workflow">
        <Things>
          <NumberedList
            items={[
              <>
                On the Workflows page, press <strong>Create workflow</strong>.
              </>,
              <>
                Enter a <strong>Name</strong>, such as Engraved pen.
              </>,
              <>
                Check the <strong>Tag</strong>. It fills in from the name, in
                lowercase, until you type in it.
              </>,
              <>
                Press <strong>Create</strong>. The workflow opens in the editor.
              </>,
            ]}
          />
          <HelpPicture name="firstWorkflow1" />
          <s-paragraph>
            The tag is how Baton finds the items the workflow builds. Each
            workflow has its own tag.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Add a step">
        <Things>
          <s-paragraph>
            Every task goes to a team, so create a team first. Until the shop
            has one, the editor says to create a team before adding steps. How
            is in{" "}
            <s-link href="/help/getting-started/first-team">
              Creating a team and adding members
            </s-link>
            .
          </s-paragraph>
          <NumberedList
            items={[
              <>
                In the editor, press <strong>Add step</strong>.
              </>,
              <>
                Enter a <strong>Name</strong>, such as Engrave.
              </>,
              <>
                Choose a <strong>Team</strong>.
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
          <HelpPicture name="firstWorkflow2" />
          <s-paragraph>
            Press <strong>Add step</strong> again for the next step. Steps are
            done in order. To add a task beside one in the same step, press the
            task, then press <strong>Add task</strong> under its step. Tasks in
            one step are done side by side.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Turn it on">
        <Things>
          <NumberedList
            items={[
              <>
                Press <strong>Turn on workflow</strong>. It saves your steps and
                turns the workflow on in one go.
              </>,
              <>
                The modal says every open order with an item that carries the
                tag starts this workflow on that item. Press{" "}
                <strong>Turn on</strong>.
              </>,
            ]}
          />
          <HelpPicture name="firstWorkflow3" />
          <s-paragraph>
            <strong>Turn on workflow</strong> stays disabled until the workflow
            has a step and every task has a team. Once it is on, the workflow
            reads <strong>Active</strong> on the Workflows page. Each paid order
            with an item that carries the tag starts it, open orders included.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Tag the products in Shopify">
        <s-paragraph>
          In Shopify, add the tag to each product the workflow should build.
          Type it exactly as the workflow has it, capital letters included. A
          product without the tag starts nothing. How the match works is in{" "}
          <s-link href="/help/workflows/matching">
            Matching items by product tag
          </s-link>
          .
        </s-paragraph>
      </s-section>
    </>
  );
}
