import { Struct } from "effect";

import { closedReasonText } from "@/components/MemberRun";
import { HelpTable } from "@/components/screen/HelpTable";
import { Things } from "@/components/screen/Things";
import * as Domain from "@/lib/Domain";
import {
  ITEM_BADGE_ROWS,
  ITEM_WORKFLOW_ROWS,
  LIST_FILTER_ROWS,
  ORDER_ISSUE_ROWS,
  ORDER_POSITION_ROWS,
  TASK_STATE_ROWS,
  TEAM_MEMBER_BADGE_ROWS,
  WORKFLOW_BADGE_ROWS,
  WORKFLOW_FAULT_ROWS,
  WORKFLOW_STATE_ROWS,
} from "@/lib/helpReference";
import { STATE_LABEL, STATES } from "@/lib/workflowsListStates";

/** The item workflow badge's label: {@link Domain.RUN_UNSTARTED_LABEL} for `unstarted`, else {@link Domain.RUN_STATE_LABEL}. */
const itemWorkflowLabel = (key: keyof typeof ITEM_WORKFLOW_ROWS) =>
  key === "unstarted"
    ? Domain.RUN_UNSTARTED_LABEL
    : Domain.RUN_STATE_LABEL[key];

/** The merchant's card lines for a closed workflow, in `ClosedReason` order: "A, B, C or D". */
const closedReasons = (viewer: Domain.ConnectionRole) => {
  const reasons = Domain.ClosedReason.literals.map((reason) =>
    closedReasonText(reason, viewer),
  );
  return `${reasons.slice(0, -1).join(", ")} or ${reasons.at(-1) ?? ""}.`;
};

/**
 * States and badges (`reference/states-and-badges`), a reference page: one
 * table per thing that has a state, in the order a merchant meets them, and
 * the member's list filters last. Every first-column word is read from its
 * label constant and every other cell from `src/lib/helpReference.ts`, whose
 * JSDoc names what each row set was checked against: the positions table
 * and `orderPosition`, the table on `OrderIssue`, `RUN_STATE_LABEL`,
 * `RUN_UNSTARTED_LABEL`, `ClosedReason`, `TASK_STATE_LABEL`,
 * `WORKFLOW_STATE_LABEL`, `WORKFLOW_FAULT_LABEL` in
 * `src/lib/domain/ShopWork.ts`; `STRIP` and the Status, Payment and Issues
 * columns in `src/routes/app.orders.index.tsx`; `runBadges`,
 * `RUN_STATE_BADGE`, `NOT_STARTED_BADGE` and the Removed badge in
 * `src/routes/app.orders.$orderId.tsx`; `ClosedLine` and `closedReasonText`
 * in `src/components/MemberRun.tsx` (the merchant reads Cancelled by you, a
 * member Cancelled by the merchant, with Closed · in front); the member's
 * workflow page in `src/routes/shop.$shop.workflows.$runId.tsx` (a Done
 * badge on a done workflow, the closed line, no Not started or Making);
 * `RunSteps` (a waiting task has no badge); `stateBadges` in
 * `src/routes/app.workflows.index.tsx`; the Draft badge in
 * `src/routes/app.workflows.$workflowId.tsx` and the editor;
 * `TeamFaultBanners` and `TeamLine` in `src/components/WorkflowSteps.tsx`;
 * the No members and No teams badges on the teams and members indexes; and
 * `STATE_LABEL` in `src/lib/workflowsListStates.ts`.
 *
 * No colour column (the plan's decision 7): a cell names a colour only where
 * another body already does ("a red banner"). The Paid and Unpaid payment
 * badges are named in the positions section's paragraph, not a table: they
 * are Shopify's payment fact, and Unpaid is already a row.
 */
export function StatesAndBadges() {
  return (
    <>
      <s-section heading="An order's position">
        <Things>
          <s-paragraph>
            Each order is in one position, shown as the badge in its Status
            column on the Orders page. The <strong>Show</strong> select lists
            each one, and the strip counts No workflow, Not started, Making and
            Made.
          </s-paragraph>
          <HelpTable
            columns={["Badge", "Where", "Meaning"]}
            rows={Domain.OrderPosition.literals.map((position) => [
              <strong key="label">
                {Domain.ORDER_POSITION_LABEL[position]}
              </strong>,
              ORDER_POSITION_ROWS[position].where,
              ORDER_POSITION_ROWS[position].meaning,
            ])}
          />
          <s-paragraph>
            The Payment column&apos;s <strong>Paid</strong> and{" "}
            <strong>Unpaid</strong> badges say whether Shopify has the full
            payment, whatever the position.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="An order's issues">
        <Things>
          <s-paragraph>
            An issue is an item on an open order that will not move until you
            act. Each one is a red badge in the Issues column on the Orders
            page, and <strong>Issues</strong> in the strip lists every order
            that has one. An order can have several. How to fix each is in{" "}
            <s-link href="/help/orders/fixing-issues">Fixing an issue</s-link>.
          </s-paragraph>
          <HelpTable
            columns={["Badge", "Meaning", "What clears it"]}
            rows={Domain.OrderIssue.literals.map((issue) => [
              <strong key="label">{Domain.ORDER_ISSUE_LABEL[issue]}</strong>,
              ORDER_ISSUE_ROWS[issue].meaning,
              ORDER_ISSUE_ROWS[issue].clears,
            ])}
          />
        </Things>
      </s-section>
      <s-section heading="An item's workflow">
        <Things>
          <s-paragraph>
            On the order&apos;s page, the badges after an item&apos;s units say
            where its workflow stands.
          </s-paragraph>
          <HelpTable
            columns={["Badge", "Meaning"]}
            rows={[
              ...Struct.keys(ITEM_WORKFLOW_ROWS).map((key) => [
                <strong key="label">{itemWorkflowLabel(key)}</strong>,
                key === "closed"
                  ? `${ITEM_WORKFLOW_ROWS[key].meaning} ${closedReasons("merchant")}`
                  : ITEM_WORKFLOW_ROWS[key].meaning,
              ]),
              [
                <strong key="label">{ITEM_BADGE_ROWS.removed.label}</strong>,
                ITEM_BADGE_ROWS.removed.meaning,
              ],
            ]}
          />
          <s-paragraph>
            A member&apos;s item page has no Not started or Making badge. It
            shows <strong>{Domain.RUN_STATE_LABEL.done}</strong> on a done
            workflow, and a closed one reads Closed and the reason in one line,
            such as &ldquo;Closed ·{" "}
            {closedReasonText("merchant_cancelled", "member")}&rdquo;.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="A task">
        <Things>
          <s-paragraph>
            Each task shows its badge under Manage on the order&apos;s page and
            on a member&apos;s item page. A task in a later step has no badge
            until its step is current.
          </s-paragraph>
          <HelpTable
            columns={["Badge", "Meaning"]}
            rows={Struct.keys(TASK_STATE_ROWS).map((state) => [
              <strong key="label">{Domain.TASK_STATE_LABEL[state]}</strong>,
              TASK_STATE_ROWS[state].meaning,
            ])}
          />
        </Things>
      </s-section>
      <s-section heading="A workflow">
        <Things>
          <s-paragraph>
            The Workflows page shows each workflow&apos;s state, and a second
            badge when something stops it or is missing.
          </s-paragraph>
          <HelpTable
            columns={["Badge", "Where", "Meaning"]}
            rows={[
              ...Domain.WorkflowState.literals.map((state) => [
                <strong key="label">
                  {Domain.WORKFLOW_STATE_LABEL[state]}
                </strong>,
                WORKFLOW_STATE_ROWS[state].where,
                WORKFLOW_STATE_ROWS[state].meaning,
              ]),
              ...Domain.WorkflowFault.literals.map((fault) => [
                <strong key="label">
                  {Domain.WORKFLOW_FAULT_LABEL[fault]}
                </strong>,
                WORKFLOW_FAULT_ROWS[fault].where,
                WORKFLOW_FAULT_ROWS[fault].meaning,
              ]),
              ...Object.values(WORKFLOW_BADGE_ROWS).map((row) => [
                <strong key="label">{row.label}</strong>,
                row.where,
                row.meaning,
              ]),
            ]}
          />
        </Things>
      </s-section>
      <s-section heading="A team or a member">
        <HelpTable
          columns={["Badge", "Where", "Meaning"]}
          rows={Object.values(TEAM_MEMBER_BADGE_ROWS).map((row) => [
            <strong key="label">{row.label}</strong>,
            row.where,
            row.meaning,
          ])}
        />
      </s-section>
      <s-section heading="The Workflows list's filters">
        <Things>
          <s-paragraph>
            A member&apos;s Workflows list holds the items whose current task is
            on one of their teams. These are the values of the strip at its top,
            not badges: press one to list its items.
          </s-paragraph>
          <HelpTable
            columns={["Filter", "Holds"]}
            rows={STATES.map((state) => [
              <strong key="label">{STATE_LABEL[state]}</strong>,
              LIST_FILTER_ROWS[state].holds,
            ])}
          />
        </Things>
      </s-section>
    </>
  );
}
