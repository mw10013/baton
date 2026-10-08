import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Fixing an issue (`orders/fixing-issues`), a task page: what an issue is,
 * and the three, each with its remedy. Read against `OrderIssue` (its
 * table: one remedy per issue, open orders only), `orderIssues`,
 * `ORDER_ISSUE_LABEL`, `multiMatchItems` and `itemMatches` (two or more
 * eligible workflows, units to make, no workflow on the item in any state),
 * `OrderRow.unassigned` (an open task on any step whose team is gone),
 * `WORKFLOW_FAULT_LABEL`, `runActions` (Block on an open item, Unblock
 * while blocked, both cleared by Cancel workflow and Change workflow),
 * `taskActions` (Done and Put back stop under a block; Assign team does
 * not; a done task keeps its team) and the triggers table on
 * `reconcileItem` (Turn off and Delete workflow create the other match's
 * workflow; Apply changes creates nothing on items already on a workflow,
 * since an item's tasks are copies) in `src/lib/domain/ShopWork.ts`;
 * `orderPosition` (a block does not move the order); and
 * `src/routes/app.orders.$orderId.tsx` (`MULTI_MATCH_SENTENCE` and the
 * Workflow select; `unassignedRows`: the line naming the task with "assign
 * a team", the Assign team select and Assign, and no Needs a team badge on
 * this page; `BlockBanner` with the reason, who and when, and Unblock; the
 * Block modal's Reason and Block, from `BlockModal` in
 * `src/components/RunTextModals.tsx`).
 */
export function FixingIssues() {
  return (
    <>
      <s-section heading="What an issue is">
        <Things>
          <s-paragraph>
            An issue is an item on an open order that will not move until you
            act. On the Orders page, show <strong>Issues</strong> to list every
            order that has one. Each row carries one red badge per issue:{" "}
            <strong>Multiple workflows match</strong>,{" "}
            <strong>Needs a team</strong> or <strong>Blocked</strong>. An order
            can have several.
          </s-paragraph>
          <HelpPicture name="fixingIssues1" />
          <s-paragraph>
            An order with no workflow is not an issue. It reads{" "}
            <strong>No workflow</strong> as its position, since many products
            are not made to order.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Multiple workflows match">
        <Things>
          <s-paragraph>
            The item carries the tags of two or more active workflows, so none
            started. On the order&apos;s page, the item says more than one
            workflow matches it, and the <strong>Workflow</strong> select lists
            the matching workflows first.
          </s-paragraph>
          <NumberedList
            items={[
              <>
                Choose one in the <strong>Workflow</strong> select.
              </>,
              <>
                Press <strong>Attach</strong>.
              </>,
            ]}
          />
          <HelpPicture name="matching1" />
          <s-paragraph>
            Or turn off or delete the workflows that should not match. When one
            is left, it starts on the item. Why two workflows can match is in{" "}
            <s-link href="/help/workflows/matching">
              Matching items by product tag
            </s-link>
            .
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Needs a team">
        <Things>
          <s-paragraph>
            A task on the item has no team, because its team was deleted. Nobody
            can work it. The order page shows no badge for it. Under the item, a
            line names the task and says to assign a team, with an{" "}
            <strong>Assign team</strong> select beside it.
          </s-paragraph>
          <NumberedList
            items={[
              <>
                Choose a team in the <strong>Assign team</strong> select.
              </>,
              <>
                Press <strong>Assign</strong>.
              </>,
            ]}
          />
          <HelpPicture name="fixingIssues3" />
          <s-paragraph>
            The workflow shows <strong>Needs a team</strong> on the Workflows
            page too, and starts on no new item until you give the task a team
            in the editor and apply the changes, as in{" "}
            <s-link href="/help/workflows/editing">
              Editing steps and tasks
            </s-link>
            . That fixes the workflow for new items. Each item already on it
            keeps its own copy of the tasks, so assign a team on each
            order&apos;s page as well. A task someone already did keeps the
            team&apos;s name and needs nothing.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Blocked">
        <Things>
          <s-paragraph>
            A member on the team of the current task, or you, blocked the item.
            Its card shows <strong>Blocked</strong> beside its other badge, and
            a red banner with the reason, who blocked it and when. Nobody can
            press Done on it until the block is lifted. How members block is in{" "}
            <s-link href="/help/members/blocking">
              Blocking an item and leaving a note
            </s-link>
            .
          </s-paragraph>
          <HelpPicture name="fixingIssues2" />
          <s-paragraph>
            Once the cause is dealt with, press <strong>Unblock</strong> in the
            banner. To block an item yourself:
          </s-paragraph>
          <NumberedList
            items={[
              <>
                On the item&apos;s card, press <strong>Manage</strong>, then{" "}
                <strong>Block</strong>.
              </>,
              <>
                Under <strong>Reason</strong>, say what stopped the work.
              </>,
              <>
                Press <strong>Block</strong>.
              </>,
            ]}
          />
          <s-paragraph>
            A block does not change the order&apos;s position on the Orders
            page. Cancelling or changing the workflow clears the block with it.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
