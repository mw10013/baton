import { HelpPicture } from "@/components/screen/HelpPicture";
import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Attaching or changing a workflow (`orders/attaching-a-workflow`), a task
 * page: attach, change and cancel. Read against
 * `src/routes/app.orders.$orderId.tsx` (`workflowSelect`: the Workflow
 * select with Choose workflow, the matches first and a rule before the rest,
 * Attach greyed until a choice, hidden on a closed order; the unmatched
 * item's sentence pointing to Workflows; the Change workflow modal with its
 * Workflow select, the `changeWarning` paragraph, Cancel and Change
 * workflow, offered in Manage on an open or done item that has another
 * workflow to choose and left out under a closed one; the Cancel workflow
 * modal with `cancelHeading`, the item line, `CANCEL_WARNING`, Keep workflow
 * and Cancel workflow; the toasts; the Workflow select under a closed
 * item), `changeWarning` and `runHasRecord` (empty with no task started or
 * done, no block and no note; else names the steps done or started, the
 * block and the note that do not carry over), `lineItemState` (options are
 * active workflows with steps; an item with nothing left to make takes
 * none), `runActions` (`cancel` on an open item only, `changeWorkflow`
 * needing units to make) and `taskActions` (Reopen on a done workflow's
 * last task), `orderPosition` (no open or done workflow reads No workflow
 * or Unpaid), the Attach, Change workflow row of the triggers table on
 * `reconcileItem` (refused on a cancelled or fulfilled order, allowed on an
 * unpaid one) and its note that a manual attach counts the order,
 * `orderIsOpen` in `src/lib/domain/Orders.ts`, and `RunState` (a closed
 * item is never given a workflow by a tag match).
 */
export function AttachingAWorkflow() {
  return (
    <>
      <s-section heading="Attach a workflow">
        <Things>
          <s-paragraph>
            An item with no workflow on it has a <strong>Workflow</strong>{" "}
            select on its card, on the order&apos;s page.
          </s-paragraph>
          <NumberedList
            items={[
              <>
                Open the <strong>Workflow</strong> select. The workflows whose
                tag the item&apos;s product carries come first, then the other
                active workflows.
              </>,
              <>Choose a workflow.</>,
              <>
                Press <strong>Attach</strong>.
              </>,
            ]}
          />
          <HelpPicture name="attachingAWorkflow1" />
          <s-paragraph>
            The item reads <strong>Not started</strong> and its tasks reach the
            members of their teams. You can attach a workflow to an unpaid
            order. You cannot attach one to a cancelled or fulfilled order, or
            to an item with nothing left to make. If the shop has no active
            workflow with a step, the item says no workflow matches it and
            points you to the Workflows page.
          </s-paragraph>
          <s-paragraph>
            Attaching counts the order on your plan, as a workflow started by a
            tag does. How orders are counted is in{" "}
            <s-link href="/help/reference/plans-and-billing">
              Plans and billing
            </s-link>
            .
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Change a workflow">
        <Things>
          <NumberedList
            items={[
              <>
                On the item&apos;s card, press <strong>Manage</strong>, then{" "}
                <strong>Change workflow</strong>.
              </>,
              <>
                Choose a workflow in the <strong>Workflow</strong> select.
              </>,
              <>
                Read what will not carry over, then press{" "}
                <strong>Change workflow</strong>.
              </>,
            ]}
          />
          <HelpPicture name="attachingAWorkflow2" />
          <s-paragraph>
            The new workflow starts from its first step. Nothing carries over
            from the old one: steps done or started, a block, or a note. The
            modal names what the item has of these. When the item has none of
            them, the modal says nothing more, since nothing is lost.
          </s-paragraph>
          <s-paragraph>
            An item whose workflow is done can be changed the same way. An item
            whose workflow you cancelled has the <strong>Workflow</strong>{" "}
            select under its card instead, the cancelled workflow among the
            choices. Choose one and press <strong>Attach</strong>, with no
            modal, since that work is over.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Cancel a workflow">
        <Things>
          <NumberedList
            items={[
              <>
                On the item&apos;s card, press <strong>Manage</strong>, then{" "}
                <strong>Cancel workflow</strong>.
              </>,
              <>
                The modal names the workflow and the item. It says work on the
                item stops, steps already done stay on record, and you can
                attach another workflow afterwards. Press{" "}
                <strong>Cancel workflow</strong>, or{" "}
                <strong>Keep workflow</strong> to leave it.
              </>,
            ]}
          />
          <HelpPicture name="attachingAWorkflow3" />
          <s-paragraph>
            The item reads <strong>Closed</strong>, and the line under it says
            you cancelled it. When no other item on the order has a workflow,
            the order reads <strong>No workflow</strong> on the Orders page, or{" "}
            <strong>Unpaid</strong> if it is not paid. A matching tag never puts
            the workflow back. To start work on the item again, attach a
            workflow by hand.
          </s-paragraph>
          <s-paragraph>
            A done workflow has no Cancel workflow. To take back its last Done,
            press <strong>Reopen</strong> on its last task in Manage.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
