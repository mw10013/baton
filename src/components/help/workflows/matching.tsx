import { HelpPicture } from "@/components/screen/HelpPicture";
import { Things } from "@/components/screen/Things";

/**
 * Matching items by product tag (`workflows/matching`), a concept page: one
 * tag per workflow, matched exactly, what else a match needs, two matches,
 * and changing the tag. Read against `WorkflowTag`, `matchesTag`,
 * `workflowIsEligible`, `itemMatches` and `unitsToMake` in
 * `src/lib/domain/ShopWork.ts` (one tag, unique, trimmed, compared exactly;
 * one of the product's tags equal to it; units left to make; an active
 * workflow with a task and every task on a team, a team with no members
 * not blocking), the JSDoc and the triggers and actions tables on
 * `reconcileItem` (the paid creation gate; a run in any state holds its
 * item; two matches create nothing; Turn on, Turn off, Delete workflow and
 * the tag edit of an active workflow reconcile every stored open paid order,
 * however old; a product retagged in Shopify changes nothing until its order
 * syncs again), `ORDER_POSITION_LABEL` and `ORDER_ISSUE_LABEL`,
 * `lineItemState` (the Workflow select lists the matches first),
 * `src/routes/app.orders.$orderId.tsx` (`MULTI_MATCH_SENTENCE`, the Workflow
 * select and Attach), and `WorkflowTag` in `src/components/WorkflowTag.tsx`
 * with `UpdateWorkflowTagInput` (Edit tag, its paragraph, Save, the tag
 * saved trimmed and as typed, immediately and not through the draft; items
 * already on the workflow keep going).
 */
export function Matching() {
  return (
    <>
      <s-section heading="One tag, matched exactly">
        <Things>
          <s-paragraph>
            Each workflow has one tag, and no two workflows share one. When a
            product in Shopify carries a workflow&apos;s tag, the workflow
            starts on each item of that product. The product can carry other
            tags too. Baton looks only for the workflow&apos;s tag, and compares
            it letter for letter, capital letters included.
          </s-paragraph>
          <s-paragraph>
            A product whose tag differs by one letter matches nothing. If
            nothing else on the order matches, the order reads{" "}
            <strong>No workflow</strong> on the Orders page. You can still
            choose the workflow for the item on the order page. How is in{" "}
            <s-link href="/help/orders/attaching-a-workflow">
              Attaching or changing a workflow
            </s-link>
            . If you retag a product in Shopify, nothing changes for an order
            already in Baton until that order syncs again. When that is, is in{" "}
            <s-link href="/help/orders/syncing">Syncing from Shopify</s-link>.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="What else has to hold">
        <Things>
          <s-paragraph>
            A tag that matches starts the workflow when:
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              The workflow is <strong>Active</strong>, has a step, and has a
              team on every task. A team with no members does not stop it. Its
              tasks wait until someone joins the team.
            </s-list-item>
            <s-list-item>
              The order is paid. An unpaid order reads <strong>Unpaid</strong>{" "}
              and starts the workflow once it is paid.
            </s-list-item>
            <s-list-item>
              The item has something left to make. An item removed in Shopify,
              or refunded in full, starts nothing.
            </s-list-item>
            <s-list-item>
              The item is not on a workflow already. A match never moves an item
              to another workflow. A workflow you cancelled on an item never
              starts on it again by a match.
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            When you turn a workflow on, every open paid order with an item that
            carries its tag starts it, however old the order is.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="When two workflows match">
        <Things>
          <s-paragraph>
            If an item carries the tags of two workflows, neither starts. The
            order shows <strong>Multiple workflows match</strong> on the Orders
            page. On the order page, the item says more than one workflow
            matches it, and the <strong>Workflow</strong> select lists the
            matching workflows first. Choose one and press{" "}
            <strong>Attach</strong>. If you turn one of the two off or delete
            it, the other starts on the item.
          </s-paragraph>
          <HelpPicture name="matching1" />
        </Things>
      </s-section>
      <s-section heading="Change the tag">
        <Things>
          <s-paragraph>
            On the workflow&apos;s page, press <strong>Edit tag</strong>, type
            the new tag and press <strong>Save</strong>. The change is
            immediate, with no draft. Products that still have the old tag stop
            matching until you retag them in Shopify. Items already on the
            workflow keep going. On an active workflow, open paid orders whose
            items carry the new tag start it at once.
          </s-paragraph>
          <HelpPicture name="matching2" />
        </Things>
      </s-section>
    </>
  );
}
