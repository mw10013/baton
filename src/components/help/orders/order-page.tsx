import { HelpPicture } from "@/components/screen/HelpPicture";
import { Things } from "@/components/screen/Things";

/**
 * Reading an order (`orders/order-page`), a concept page: the title bar and
 * the ways in, an item's card, Manage, and the aside and the end of the
 * work. Read against `src/routes/app.orders.$orderId.tsx` (the Orders
 * breadcrumb; View in Shopify as the primary action and Sync from Shopify
 * as the secondary; the Order not found page and its 30-day sentence;
 * `renderLineItem`: the title and variant, the units line with "to make"
 * against "ordered", SKU, the Removed badge, Properties; `runBadges` and
 * `RUN_STATE_BADGE`: Not started, the `RUN_STATE_LABEL.open` badge (Making),
 * Done, Closed, and Blocked beside any of them; `nowLine`: Step k of n with
 * the task's name or a count of tasks, "since" a time once a task is
 * started, Done with its step count; `RunNote` and Edit note; Manage and
 * `manageRows`: the workflow's name, `RunSteps`, Done, Put back, Reopen and
 * Assign team per task, then Block, Cancel workflow and Change workflow;
 * the Made banner with Fulfill in Shopify; the Order note and Order details
 * asides), `RunSteps` in `src/components/RunSteps.tsx` (the task badges
 * Ready, Started and Done; the line team, who, when; a waiting task has no
 * badge), `ClosedLine` and `closedReasonText` in
 * `src/components/MemberRun.tsx` with `ClosedReason`, `VERB_LABEL`,
 * `runActions` and `taskActions` in `src/lib/domain/ShopWork.ts` (a closed
 * order or a closed workflow offers the note and nothing else; a done
 * workflow offers Reopen on its last task and Change workflow),
 * `actorLabel` (the merchant reads Merchant, a member their email),
 * `extensions/baton-order-link/shopify.extension.toml` (Open in Baton under
 * More actions on Shopify's order page) and
 * `src/routes/app.orders.from-shopify.tsx` (it lands on this page).
 */
export function OrderPage() {
  return (
    <>
      <s-section heading="Getting to an order">
        <Things>
          <s-paragraph>
            An order&apos;s page shows each item on the order, the workflow on
            it and where the work stands. Open it from its number on the Orders
            page. The <strong>Orders</strong> link at the top goes back to the
            list as you left it.
          </s-paragraph>
          <s-paragraph>
            <strong>View in Shopify</strong> opens the order in Shopify, where
            you take payment and fulfill it. <strong>Sync from Shopify</strong>{" "}
            reads the order from Shopify again. When to press it is in{" "}
            <s-link href="/help/orders/syncing">Syncing from Shopify</s-link>.
          </s-paragraph>
          <s-paragraph>
            From the order&apos;s page in Shopify, press{" "}
            <strong>More actions</strong>, then <strong>Open in Baton</strong>,
            to come straight here. If Baton does not have the order, the page
            says so: the order may be older than 30 days, or deleted in Shopify.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Each item">
        <Things>
          <s-paragraph>
            Each item has a card headed by its title and variant. The line under
            the title gives its units and SKU. When an edit or a refund has
            lowered the units, it shows the units to make beside the units
            ordered. A <strong>Removed</strong> badge means the item was removed
            from the order in Shopify, or refunded in full. Under Properties are
            the details the customer entered, such as an engraving.
          </s-paragraph>
          <s-paragraph>
            The badge after the units says where the item&apos;s workflow
            stands: <strong>Not started</strong> until someone starts a task,
            then <strong>Making</strong> while the work goes on, then{" "}
            <strong>Done</strong>. <strong>Closed</strong> means something else
            ended it, and a line under the card says what. A red{" "}
            <strong>Blocked</strong> badge shows beside any of them while the
            item is blocked. An item&apos;s Not started and Making mean what the
            order&apos;s Not started and Making mean on the Orders page.
          </s-paragraph>
          <s-paragraph>
            A line under the badges says where the work is: the step out of how
            many, the task&apos;s name, and since when once someone has started
            it. On a step with several tasks it gives their number instead. A
            done workflow reads Done with its number of steps.
          </s-paragraph>
          <HelpPicture name="orderPage1" />
          <s-paragraph>
            The item&apos;s note is under that line, with{" "}
            <strong>Edit note</strong>. Members on the item&apos;s teams read
            and write the same note.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Manage">
        <Things>
          <s-paragraph>
            Press <strong>Manage</strong> on an item to open its workflow under
            it. It shows the workflow&apos;s name and each step with its tasks.
            A task reads <strong>Ready</strong>, <strong>Started</strong> or{" "}
            <strong>Done</strong>, with its team, who started or did it, and
            when. A task in a later step has no badge yet. Your own presses read
            Merchant, and a member&apos;s read their email.
          </s-paragraph>
          <HelpPicture name="orderPage2" />
          <s-paragraph>
            Each task has the buttons it allows: <strong>Done</strong> and{" "}
            <strong>Put back</strong>, as a member has, and{" "}
            <strong>Reopen</strong>, which is the member&apos;s Undo. Use them
            when the bench cannot, such as for a member who is away. Who can
            press what is in{" "}
            <s-link href="/help/reference/who-can-do-what">
              Who can do what
            </s-link>
            . <strong>Assign team</strong> moves a task that is not done to
            another team.
          </s-paragraph>
          <s-paragraph>
            Under the steps, <strong>Block</strong> stops the work,{" "}
            <strong>Cancel workflow</strong> takes the workflow off the item,
            and <strong>Change workflow</strong> puts another on it. Block is in{" "}
            <s-link href="/help/orders/fixing-issues">Fixing an issue</s-link>,
            and the other two in{" "}
            <s-link href="/help/orders/attaching-a-workflow">
              Attaching or changing a workflow
            </s-link>
            .
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Order details and the end of the work">
        <Things>
          <s-paragraph>
            Beside the items, <strong>Order note</strong> holds the note from
            Shopify, when the order has one. <strong>Order details</strong>{" "}
            gives when it was placed, its payment, its fulfillment and, if it
            was cancelled, when.
          </s-paragraph>
          <s-paragraph>
            When every item&apos;s workflow is done, a banner at the top says
            so, with a <strong>Fulfill in Shopify</strong> link. Once you
            fulfill the order, Baton reads it as Fulfilled.
          </s-paragraph>
          <s-paragraph>
            When Shopify closes the order while an item&apos;s workflow is still
            open, or you cancel a workflow, the item reads{" "}
            <strong>Closed</strong> and the line under it says why: fulfilled in
            Shopify, order cancelled in Shopify, item removed or refunded in
            Shopify, or cancelled by you. Its tasks stay in Manage as the
            record, without buttons. <strong>Edit note</strong> stays.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
