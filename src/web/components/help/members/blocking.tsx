import { HelpPicture } from "../../screen/HelpPicture.tsx";
import { NumberedList } from "../../screen/NumberedList.tsx";
import { Things } from "../../screen/Things.tsx";
import { HelpLink } from "../HelpLink.tsx";

/**
 * Blocking an item and leaving a note (`members/blocking`): Block with a
 * reason, Unblock, Edit note, and what the merchant sees. Read against
 * `MemberWorkflowPage`, `BlockModal` and
 * `RunNoteModal`, `BlockBanner` and
 * `RunNote`, `runActions` (Block
 * and Unblock are the current task's team's, on an open item; the note is
 * anyone's on the item's teams), `taskActions` (Start, Done and Put
 * back stop under a block), `orderIssues` (Blocked) and
 * `orderPosition` (a block does not move the order).
 */
export function Blocking() {
  return (
    <>
      <s-section heading="Block an item">
        <Things>
          <s-paragraph>
            Block an item when its work cannot go on, such as a damaged part or a question for the
            customer. Anyone on the team of its current task can block it.
          </s-paragraph>
          <NumberedList
            items={[
              <>
                On the item&apos;s page, press <strong>Block</strong> beside the order number. On a
                phone it is under the <strong>…</strong> button there.
              </>,
              <>
                Under <strong>Reason</strong>, say what stopped the work and what it is waiting for.
              </>,
              <>
                Press <strong>Block</strong>.
              </>,
            ]}
          />
          <HelpPicture name="blocking1" />
          <s-paragraph>
            While the item is blocked, its tasks cannot be started, done or put back. The merchant
            sees the order under <strong>Issues</strong> as <strong>Blocked</strong>. The block does
            not move the order&apos;s position, so an order nobody has started stays{" "}
            <strong>Not started</strong>. What the merchant does next is in{" "}
            <HelpLink href="/help/orders/fixing-issues">Fixing an issue</HelpLink>.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Unblock an item">
        <Things>
          <s-paragraph>
            The item&apos;s page shows a <strong>Blocked</strong> banner with the reason, who
            blocked it and when. When the work can go on, press <strong>Unblock</strong> in the
            banner. Anyone on the current task&apos;s team can, not only who blocked it. The tasks
            go back to how they were.
          </s-paragraph>
          <HelpPicture name="blocking2" />
          <s-paragraph>
            To change the reason, press Unblock, then Block again with the new one.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Leave a note">
        <s-paragraph>
          A note is for anything the next person should know about the item. On the item&apos;s
          page, press <strong>Edit note</strong>, write the note and press <strong>Save</strong>.
          Every team with a task on the item reads it, and so does the merchant. Under it, after{" "}
          <strong>From the order:</strong>, is the order&apos;s own note from Shopify.
        </s-paragraph>
      </s-section>
    </>
  );
}
