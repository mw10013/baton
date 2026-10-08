import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Removing and deleting (`teams-and-members/removing-and-deleting`): Remove
 * from a team, Delete member, Delete team. Read against
 * `src/routes/app.teams.$teamId.tsx` (Remove on a row with no modal;
 * `setTeamMemberFn` revokes the member's connections; More actions, Delete,
 * the Delete <team>? modal whose body is `DELETE_CONFIRM` alone, its Delete
 * disabled until the socket has identified; the "Team deleted" toast and the
 * Teams page), `src/routes/app.members.$memberId.tsx` (Remove on a row with
 * no modal; Delete member, the Delete member? modal naming the email before
 * `DELETE_CONFIRM`; `deleteMemberFn` revokes the member's connections; the
 * "Member deleted" toast and the Members page), `DELETE_CONFIRM` and
 * `DELETED_TOAST` in `src/lib/teams.ts`, the record verbs table and the
 * JSDoc on `Member`, `Team`, `WorkflowTask` and `RunTask` in
 * `src/lib/domain/ShopWork.ts` (Remove takes a member off a team and both
 * still exist; a team delete nulls `teamId` on every task and a done task
 * keeps its `teamName`; `startedByEmail` and `doneByEmail` are snapshots
 * that outlive the member), `taskActions` (`putBack` is open to anyone on
 * the team once a task is started), `listStateOf` (a task started by
 * someone else is under Started by others), the member rows of `D1_TABLES`
 * in `src/lib/D1Schema.ts` (a re-added email is a new member), the
 * connection table on `ConnectionRole` in `src/lib/domain/Platform.ts`
 * (a membership change or a team delete closes the members' sockets),
 * `deleteTeam` and `merchantAssignRunTaskTeam` in
 * `src/lib/agent/ShopWork.ts` and `unassignTeam` in
 * `src/lib/WorkflowRepository.ts` (definitions, drafts and run tasks lose
 * the team, then every stored order is reconciled), `workflowIsEligible`
 * and the Delete team row of the triggers table on `reconcileItem`, the
 * Needs a team badge on the Workflows and Orders pages
 * (`WORKFLOW_FAULT_LABEL`, `ORDER_ISSUE_LABEL`), and the order page's
 * Assign team select beside an unassigned task.
 */
export function RemovingAndDeleting() {
  return (
    <>
      <s-section heading="Remove a member from a team">
        <Things>
          <s-paragraph>
            On the team&apos;s page or on the member&apos;s page, press{" "}
            <strong>Remove</strong> at the end of the row. There is no question
            first, since <strong>Add members</strong> or{" "}
            <strong>Add to teams</strong> puts them back. The member and the
            team both still exist. The member&apos;s list changes at once, even
            if they are signed in.
          </s-paragraph>
          <s-paragraph>
            A task they had started stays started under their email, and the
            team&apos;s other members find it under Started by others. Any of
            them can press <strong>Put back</strong> on it so someone else can
            start it.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Delete a member">
        <Things>
          <NumberedList
            items={[
              <>
                On the member&apos;s page, press <strong>Delete member</strong>.
              </>,
              <>
                The modal names the email and says this can&apos;t be undone.
                Press <strong>Delete</strong>.
              </>,
            ]}
          />
          <HelpPicture name="removingAndDeleting1" />
          <s-paragraph>
            The Members page opens, and a message says the member was deleted.
            They leave all their teams and can no longer sign in to this store.
            If they are signed in, they lose access at once. The history keeps
            their email on every task they started or did. Adding the same email
            again makes a new member, on no team.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Delete a team">
        <Things>
          <NumberedList
            items={[
              <>
                On the team&apos;s page, press <strong>More actions</strong>,
                then <strong>Delete</strong>.
              </>,
              <>
                The modal says this can&apos;t be undone. Press{" "}
                <strong>Delete</strong>. It is greyed for a moment while the
                page connects.
              </>,
            ]}
          />
          <HelpPicture name="removingAndDeleting2" />
          <s-paragraph>
            The Teams page opens, and a message says the team was deleted. Its
            members still exist and stay on their other teams.
          </s-paragraph>
          <s-paragraph>
            Nothing stops you deleting a team a workflow uses, so check the
            workflows first. Every task on the team, in every workflow, loses
            its team and reads <strong>Needs a team</strong>. A workflow with
            such a task starts on no new items until you give the task a team in
            the editor and apply the changes, as in{" "}
            <s-link href="/help/workflows/editing">
              Editing steps and tasks
            </s-link>
            .
          </s-paragraph>
          <s-paragraph>
            An open task on an order already in Baton loses its team too, and
            nobody can work it. The order shows <strong>Needs a team</strong> on
            the Orders page, and on the order page you choose a team for the
            task and press <strong>Assign</strong>. That is in{" "}
            <s-link href="/help/orders/fixing-issues">Fixing an issue</s-link>.
            A done task keeps the team&apos;s name. If an item matched two
            workflows and one of them now has a task with no team, the other
            starts on it. How that works is in{" "}
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
