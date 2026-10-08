import { HelpPicture } from "@/components/screen/HelpPicture";
import { Things } from "@/components/screen/Things";

/**
 * How Baton works (`getting-started/how-baton-works`), a concept page: the
 * vocabulary's nouns in their screen words, how an item gets its workflow,
 * and who does what. Read against the noun table and `itemMatches`,
 * `matchesTag`, `workflowIsEligible` and `WorkflowTag` in
 * `src/lib/domain/ShopWork.ts` (an exact tag, an Active workflow with a task
 * and every task on a team, and the paid-order creation gate on
 * `reconcileItem`; two matches start nothing and raise the issue
 * `ORDER_ISSUE_LABEL.multi_match`), `src/routes/app.orders.$orderId.tsx`
 * (the item's Step k of n line, `MULTI_MATCH_SENTENCE`, the Workflow select
 * and Attach), the app nav in `src/routes/app.tsx`, and the member's item
 * page `src/routes/shop.$shop.workflows.$runId.tsx` (Start and Done).
 */
export function HowBatonWorks() {
  return (
    <>
      <s-section heading="The words">
        <Things>
          <s-paragraph>
            An order comes from Shopify. Each product on it is an item.
          </s-paragraph>
          <s-paragraph>
            A workflow is the work an item goes through, as steps in order. A
            step holds one or more tasks, done side by side. Each task is
            assigned to a team. A team is a group of members, and a member is a
            person who does the work. A member can be on more than one team.
          </s-paragraph>
          <s-paragraph>
            The order page shows each item and the step its workflow is on, such
            as Step 2 of 3 and the task&apos;s name.
          </s-paragraph>
          <HelpPicture name="howBatonWorks1" />
        </Things>
      </s-section>
      <s-section heading="How an item gets its workflow">
        <s-paragraph>
          Each workflow has a tag. When an item&apos;s product carries that tag
          in Shopify, the workflow starts on the item. The tag has to match
          exactly. The workflow has to be <strong>Active</strong>, with at least
          one step and a team on every task. The order has to be paid. If two
          workflows match one item, neither starts. The order shows{" "}
          <strong>Multiple workflows match</strong>, and you choose one on the
          order page. The details are in{" "}
          <s-link href="/help/workflows/matching">
            Matching items by product tag
          </s-link>
          .
        </s-paragraph>
      </s-section>
      <s-section heading="Who does what">
        <Things>
          <s-paragraph>
            You set up workflows and teams in Baton in the Shopify admin, and
            follow orders on the Orders page. A member signs in to Baton with
            their email, on a phone or a tablet, with no Shopify account. They
            see the tasks for their teams and press <strong>Start</strong> and{" "}
            <strong>Done</strong> as they work. When every task in a step is
            done, the next step&apos;s tasks are ready for their teams.
          </s-paragraph>
          <s-paragraph>
            Here is the same item as the member sees it, with the task started:
          </s-paragraph>
          <HelpPicture name="recordingYourWork2" />
          <s-paragraph>
            What a member sees and does is in{" "}
            <s-link href="/help/members">For members</s-link>.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
