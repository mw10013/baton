import { HelpTable } from "@/components/screen/HelpTable";
import { Things } from "@/components/screen/Things";
import * as Domain from "@/lib/Domain";
import { ORDER_SYNC_WINDOW_DAYS } from "@/lib/orderSyncConstants";

/**
 * Limits (`reference/limits`), a reference page: every number Baton holds a
 * shop to, and what the screen does there. Every number is read from its
 * constant and printed through `Domain.formatNumber`, the formatter every
 * screen uses, so 2,500 reads as the banner prints it; a changed constant
 * changes the page with no edit (decision 14 in the help research, and
 * `test/integration/help-limits.test.ts` holds it).
 *
 * Read against `NAME_MAX_LENGTH`, `TEAM_NAME_MAX_LENGTH`, `TAG_MAX_LENGTH`,
 * `TASK_INSTRUCTIONS_MAX_LENGTH`, `RUN_NOTE_MAX_LENGTH`,
 * `BLOCK_REASON_MAX_LENGTH`, `noteCountFrom` and `DONE_WINDOW_MS` in
 * `src/lib/domain/ShopWork.ts`; `EMAIL_MAX_LENGTH`, `WorkflowLimits` and
 * `ShopLimits` in `src/lib/domain/Platform.ts`; `ORDER_SYNC_WINDOW_DAYS`;
 * `textLimitError` and `textLimitProps` in `src/components/screen/TextLimit.tsx`
 * ("Up to N characters" on submit, "N characters left" from `noteCountFrom`)
 * and their callers (the workflow name and tag on the Workflows page and the
 * workflow page, `WorkflowTag`, the team name on the Teams page and the
 * team's page, the email on the Members page, instructions in the editor, the
 * note and the block reason in `RunTextModals`, the task name on both of the
 * editor's forms); `tagCommaError` in `src/lib/workflowShared.ts`;
 * `MEMBER_CEILING` in `src/routes/app.members.index.tsx`, the teams and
 * workflows "A shop can have N …. Delete one to add another.", the editor's
 * "A workflow can have N tasks."; `maxLineItemsPerOrder` (the rest are not
 * stored, and only a log says so); `QuotaBanners` and `openOrdersAtCeiling`;
 * `retentionCutoff` (the age is from `processedAt`, the date the Orders page
 * prints as Placed).
 *
 * Nothing here says why a limit is the number it is, and nothing names one
 * a guard or a ceiling: a limit is a number and what the screen does there.
 */
export function Limits() {
  const n = Domain.formatNumber;
  const countdown = (maxLength: number) =>
    `A count of the characters left appears under the field when ${n(maxLength - Domain.noteCountFrom(maxLength))} remain. Past the limit, the field says “Up to ${n(maxLength)} characters” when you save.`;
  const oneLine = (maxLength: number) =>
    `The field says “Up to ${n(maxLength)} characters” when you save.`;
  const characters = (maxLength: number) => `${n(maxLength)} characters`;
  return (
    <>
      <s-section heading="Text">
        <HelpTable
          columns={["What", "Limit", "What the screen does"]}
          rows={[
            [
              "Workflow name",
              characters(Domain.NAME_MAX_LENGTH),
              oneLine(Domain.NAME_MAX_LENGTH),
            ],
            [
              "Task name",
              characters(Domain.NAME_MAX_LENGTH),
              oneLine(Domain.NAME_MAX_LENGTH),
            ],
            [
              "Team name",
              characters(Domain.TEAM_NAME_MAX_LENGTH),
              oneLine(Domain.TEAM_NAME_MAX_LENGTH),
            ],
            [
              "Tag",
              `${characters(Domain.TAG_MAX_LENGTH)}, and no comma`,
              `The field says “Up to ${n(Domain.TAG_MAX_LENGTH)} characters” or “A tag can't have a comma.” when you save.`,
            ],
            [
              "Task instructions",
              characters(Domain.TASK_INSTRUCTIONS_MAX_LENGTH),
              countdown(Domain.TASK_INSTRUCTIONS_MAX_LENGTH),
            ],
            [
              "Note on an item",
              characters(Domain.RUN_NOTE_MAX_LENGTH),
              countdown(Domain.RUN_NOTE_MAX_LENGTH),
            ],
            [
              "Block reason",
              characters(Domain.BLOCK_REASON_MAX_LENGTH),
              countdown(Domain.BLOCK_REASON_MAX_LENGTH),
            ],
            [
              "Member email",
              characters(Domain.EMAIL_MAX_LENGTH),
              oneLine(Domain.EMAIL_MAX_LENGTH),
            ],
          ]}
        />
      </s-section>
      <s-section heading="Things in the shop">
        <HelpTable
          columns={["What", "Limit", "At the limit"]}
          rows={[
            [
              "Members",
              n(Domain.ShopLimits.maxMembers),
              <>
                <strong>Add member</strong> refuses another and says to contact
                support to raise the limit.
              </>,
            ],
            [
              "Teams",
              n(Domain.ShopLimits.maxTeams),
              <>
                <strong>Create team</strong> refuses another. Delete a team to
                add one.
              </>,
            ],
            [
              "Workflows",
              n(Domain.WorkflowLimits.maxWorkflows),
              <>
                <strong>Create workflow</strong> and <strong>Duplicate</strong>{" "}
                refuse another. Delete a workflow to add one.
              </>,
            ],
            [
              "Tasks in a workflow",
              n(Domain.WorkflowLimits.maxTasks),
              "The editor refuses another task and says how many a workflow can have.",
            ],
            [
              "Items on an order",
              n(Domain.ShopLimits.maxLineItemsPerOrder),
              `Baton keeps ${n(Domain.ShopLimits.maxLineItemsPerOrder)} of the order's items and leaves out the rest.`,
            ],
          ]}
        />
      </s-section>
      <s-section heading="Orders">
        <Things>
          <HelpTable
            columns={["What", "Limit", "What happens"]}
            rows={[
              [
                "Open orders",
                n(Domain.ShopLimits.maxOpenOrders),
                "Baton stores no new order. A red banner on the home page and the Orders page says new orders stopped syncing.",
              ],
              [
                "Sync open orders",
                `${n(ORDER_SYNC_WINDOW_DAYS)} days`,
                `It reads the open, unfulfilled orders placed in the last ${n(ORDER_SYNC_WINDOW_DAYS)} days.`,
              ],
              [
                "How long Baton keeps an order",
                `${n(Domain.ShopLimits.orderRetentionDays)} days`,
                "An order leaves Baton that long after it was placed, with its workflows, open or not. Shopify keeps every order.",
              ],
              [
                "Done or closed",
                `${n(Domain.DONE_WINDOW_MS / 3_600_000)} hours`,
                "A member's Done or closed list holds their teams' done tasks and ended workflows for that long.",
              ],
            ]}
          />
          <s-paragraph>
            At the open-order limit, fulfill or cancel orders in Shopify, then
            press <strong>Sync open orders</strong>. How it brings in the orders
            that were not stored is in{" "}
            <s-link href="/help/orders/syncing">Syncing from Shopify</s-link>.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
