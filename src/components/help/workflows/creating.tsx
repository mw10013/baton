import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Creating a workflow (`workflows/creating`): the Workflows page, Create
 * workflow, the name and the tag, and what a new workflow is. Read against
 * `src/routes/app.workflows.index.tsx` (the Workflow, Status, Tag, Steps and
 * Updated columns; `stateBadges`: Active toned success, Inactive with no
 * tone, No steps toned warning, and the two `WORKFLOW_FAULT_LABEL` badges
 * toned `ORDER_ISSUE_TONE`; All, Active and Inactive; "Search by name",
 * which ignores the state filter; the Create workflow modal with Name and
 * Tag, the tag mirroring the name trimmed and lowercased until the Tag field
 * is typed in, `TAG_HELP`; Create opening the editor, and closing it landing
 * on the new workflow's page), `nameTakenMessage` and `tagTakenMessage` in
 * `src/lib/workflowShared.ts` (the tag refusal names the workflow that has
 * it), `WorkflowName` and `WorkflowTag` in `src/lib/domain/ShopWork.ts`
 * (trimmed, kept as typed, no comma, unique, compared exactly),
 * `createWorkflow` in
 * `src/lib/WorkflowRepository.ts` (inactive, no tasks, no draft), the
 * editor's and the workflow page's Draft badge on a never-applied workflow
 * (`neverApplied`), and `workflowIsEligible` (a workflow creates nothing
 * until it is active with a task and every task on a team). No limit is
 * named here: the Limits page has them, and `WorkflowLimits.maxWorkflows`
 * is a guard, not a promise.
 */
export function Creating() {
  return (
    <>
      <s-section heading="The Workflows page">
        <Things>
          <s-paragraph>
            Each row is a workflow: its name, its status badge, its tag, its
            number of steps and when it was last updated. The badge reads{" "}
            <strong>Active</strong> for a workflow that starts on new items, or{" "}
            <strong>Inactive</strong> for one that starts nothing. A second
            badge shows when something stops it:
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              <strong>No steps</strong>: the workflow has no steps yet.
            </s-list-item>
            <s-list-item>
              <strong>Needs a team</strong>: a task&apos;s team was deleted, and
              the workflow starts nothing until the task has a team again.
            </s-list-item>
            <s-list-item>
              <strong>Team has no members</strong>: a task&apos;s team has
              nobody on it. The workflow still starts, and the task waits until
              someone joins the team.
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            Press <strong>All</strong>, <strong>Active</strong> or{" "}
            <strong>Inactive</strong> to show those workflows. To find one
            workflow, search by name. A search looks at every workflow, active
            or inactive.
          </s-paragraph>
          <HelpPicture name="creating1" />
        </Things>
      </s-section>
      <s-section heading="Create a workflow">
        <Things>
          <NumberedList
            items={[
              <>
                On the Workflows page, press <strong>Create workflow</strong>.
              </>,
              <>
                Enter a <strong>Name</strong> and check the <strong>Tag</strong>
                .
              </>,
              <>
                Press <strong>Create</strong>.
              </>,
            ]}
          />
          <HelpPicture name="firstWorkflow1" />
          <s-paragraph>
            A walk through a first workflow, from its first step to turning it
            on, is in{" "}
            <s-link href="/help/getting-started/first-workflow">
              Creating your first workflow
            </s-link>
            .
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="The name and the tag">
        <s-paragraph>
          No two workflows share a name. If another workflow has the name, the
          screen says so under <strong>Name</strong>. No two workflows share a
          tag either. If another workflow has the tag, the screen names that
          workflow under <strong>Tag</strong>. The tag fills in from the name,
          in lowercase, until you type in it. What you type is kept as you typed
          it, and Baton matches it exactly. A tag has no comma, since Shopify
          splits a product&apos;s tags on commas. How the match works is in{" "}
          <s-link href="/help/workflows/matching">
            Matching items by product tag
          </s-link>
          . How long a name or a tag can be is in{" "}
          <s-link href="/help/reference/limits">Limits</s-link>.
        </s-paragraph>
      </s-section>
      <s-section heading="What a new workflow is">
        <s-paragraph>
          The new workflow opens in the editor with a <strong>Draft</strong>{" "}
          badge and no steps. When you close the editor, its page opens. On the
          Workflows page it reads <strong>Inactive</strong> and{" "}
          <strong>No steps</strong>. It starts nothing until it has a step,
          every task has a team, and you turn it on. Steps are in{" "}
          <s-link href="/help/workflows/editing">
            Editing steps and tasks
          </s-link>
          , and turning it on is in{" "}
          <s-link href="/help/workflows/turning-on-and-off">
            Turning a workflow on or off
          </s-link>
          .
        </s-paragraph>
      </s-section>
    </>
  );
}
