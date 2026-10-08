import { HelpPicture } from "@/components/screen/HelpPicture";
import { Things } from "@/components/screen/Things";

/**
 * Following an order through its workflow (`getting-started/first-order`):
 * the order arriving, a member working its tasks, Made and Fulfilled. Read
 * against `orderPosition` and `ORDER_POSITION_LABEL` in
 * `src/lib/domain/ShopWork.ts` (Unpaid, Not started, Making and Made over
 * the order's workflows; Fulfilled when Shopify says so), `reconcileItem`
 * there (a paid order is the creation gate; a fulfilled order ends every
 * open workflow on it), `taskStateOf` and `currentTasks` (a step's tasks
 * read Ready once every task before it is done),
 * `src/routes/app.orders.index.tsx` (the Status column's badge, the strip
 * with Not started, Making and Made, Making as the list's default),
 * `src/routes/app.orders.$orderId.tsx` (the Step k of n line, the Made
 * banner "Every item is done." with its Fulfill in Shopify link, the item's
 * Done badge), and the member's Workflows list and item page
 * (`src/routes/shop.$shop.workflows.index.tsx`, Start and Done).
 */
export function FirstOrder() {
  return (
    <>
      <s-section heading="The order arrives">
        <s-paragraph>
          Baton reads each new order from Shopify as it is placed. When the
          order is paid and an item&apos;s product carries the tag of an active
          workflow, the workflow starts on that item. On the Orders page, the
          order&apos;s status reads <strong>Not started</strong>. The list opens
          on Making, so press <strong>Not started</strong> on the strip to find
          it. An order that is not paid yet reads <strong>Unpaid</strong>, and
          its workflow starts once it is paid.
        </s-paragraph>
      </s-section>
      <s-section heading="A member does the work">
        <Things>
          <s-paragraph>
            Each task whose step is current shows on the Workflows list of every
            member on its team, and reads <strong>Ready</strong>.
          </s-paragraph>
          <HelpPicture name="findingYourWork2" />
          <s-paragraph>
            When a member presses <strong>Start</strong> on a task, the order
            reads <strong>Making</strong>. When they press <strong>Done</strong>
            , and every task in the step is done, the next step&apos;s tasks
            read <strong>Ready</strong>. The order page shows the step each item
            is on, such as Step 2 of 3 and the task&apos;s name.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Made and fulfilled">
        <Things>
          <s-paragraph>
            When no item&apos;s workflow is still open and at least one is done,
            the order reads <strong>Made</strong>. Its page says every item is
            done, with a <strong>Fulfill in Shopify</strong> link. Each item
            shows a <strong>Done</strong> badge.
          </s-paragraph>
          <HelpPicture name="firstOrder1" />
          <s-paragraph>
            Fulfill the order in Shopify as usual. Baton then reads it as{" "}
            <strong>Fulfilled</strong>. If you fulfill an order before its work
            is done, Baton ends its open workflows. Every status on the Orders
            page is in{" "}
            <s-link href="/help/orders/orders-list">
              Reading the orders list
            </s-link>
            .
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
