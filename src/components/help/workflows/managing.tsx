import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Renaming, duplicating and deleting a workflow (`workflows/managing`): the
 * More actions menu. Read against `src/routes/app.workflows.$workflowId.tsx`
 * (More actions with Rename, Duplicate and Delete; the Rename modal with New
 * name and Save; the Duplicate workflow modal with Name and Tag, prefilled
 * by `copyName` and the tag mirroring it lowercased until the Tag field is
 * typed in, and its Duplicate primary, which opens the copy in the editor;
 * the Delete modal with `DELETE_WORKFLOW_BODY` and its Delete primary, then
 * the Workflows page), `src/routes/app.workflows.$workflowId_.edit.tsx`
 * (the editor's More actions has Rename and Delete only),
 * `RENAME_HEADING`, `RENAME_FIELD_LABEL`, `nameTakenMessage` and
 * `tagTakenMessage` in `src/lib/workflowShared.ts`, `duplicateWorkflow` and
 * `deleteWorkflow` in `src/lib/WorkflowRepository.ts` (the copy has the
 * tasks in force under new ids, is inactive and has no draft; a delete
 * removes the definition only), the JSDoc on `Workflow` and
 * `DuplicateWorkflowInput` in `src/lib/domain/ShopWork.ts` (a rename is
 * immediate and cosmetic because items snapshot the name and the tag; a
 * delete removes the workflow, its tasks and its draft, and items already
 * on it carry on), and the Delete workflow row of the triggers table on
 * `reconcileItem` (deleting one of two matching workflows starts the other).
 */
export function Managing() {
  return (
    <>
      <s-section heading="Rename a workflow">
        <Things>
          <NumberedList
            items={[
              <>
                On the workflow&apos;s page or in the editor, press{" "}
                <strong>More actions</strong>, then <strong>Rename</strong>.
              </>,
              <>
                Enter the <strong>New name</strong>.
              </>,
              <>
                Press <strong>Save</strong>.
              </>,
            ]}
          />
          <s-paragraph>
            No two workflows share a name. If another workflow has it, the
            screen says so under the field. Items already on the workflow keep
            the name they started with. The tag stays the same, so products keep
            matching.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Duplicate a workflow">
        <Things>
          <NumberedList
            items={[
              <>
                On the workflow&apos;s page, press <strong>More actions</strong>
                , then <strong>Duplicate</strong>.
              </>,
              <>
                Check the <strong>Name</strong>. It reads the workflow&apos;s
                name with &ldquo;copy&rdquo; after it.
              </>,
              <>
                Check the <strong>Tag</strong>. It fills in from the name, in
                lowercase, until you type in it.
              </>,
              <>
                Press <strong>Duplicate</strong>.
              </>,
            ]}
          />
          <HelpPicture name="managing1" />
          <s-paragraph>
            The copy has the steps in force, without any changes not yet
            applied. It is inactive, and it opens in the editor. Duplicate is on
            the workflow&apos;s page only, not in the editor.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Delete a workflow">
        <Things>
          <NumberedList
            items={[
              <>
                On the workflow&apos;s page or in the editor, press{" "}
                <strong>More actions</strong>, then <strong>Delete</strong>.
              </>,
              <>
                The modal says items already on the workflow keep going, and
                that this can&apos;t be undone. Press <strong>Delete</strong>.
              </>,
            ]}
          />
          <HelpPicture name="managing2" />
          <s-paragraph>
            The Workflows page opens. The workflow, its steps and its draft are
            gone. Items already on it keep going under its name until their last
            task is done. If an item carries the tags of this workflow and
            another one, the other starts on it.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
