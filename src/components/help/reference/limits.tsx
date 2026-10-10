import { HelpTable } from "@/components/screen/HelpTable";
import { Things } from "@/components/screen/Things";
import * as Domain from "@/lib/Domain";

/**
 * Limits (`reference/limits`), a reference page: the limits a merchant plans
 * around before reaching them. A limit the screen states when the merchant
 * reaches it (a field's length, the editor's tasks per workflow) is not on
 * the page, nor is one no small or medium shop comes near (items on an
 * order, properties on an item) or one that only matters to someone sharing
 * a login (connections and sign-ins per member). Those stay enforced and
 * documented on their constants. `test/integration/help-limits.test.ts`
 * holds the page to the five it carries.
 *
 * Every number is read from its constant and printed through
 * `Domain.formatNumber`, the formatter every screen uses, so a changed
 * constant changes the page with no edit.
 *
 * Read against `ShopLimits` in `src/lib/domain/Platform.ts` (`maxMembers`,
 * `maxOpenOrders`, `maxTeams`, `orderRetentionDays`), `WorkflowLimits`
 * (`maxWorkflows`), `membersAtCeiling` and `openOrdersAtCeiling` in
 * `src/lib/domain/Billing.ts`, `retentionCutoff` (the age is from
 * `processedAt`, the date the Orders page prints as Placed), and the
 * create and duplicate actions on the Members, Teams and Workflows pages.
 *
 * The page gives no reason for a limit, names no banner and says nothing
 * of orders per billing cycle. How Sync open orders recovers the orders
 * not stored at the open-order limit is on Syncing from Shopify, not here.
 */
export function Limits() {
  const n = Domain.formatNumber;
  return (
    <>
      <s-section heading="Hard limits">
        <Things>
          <s-paragraph>
            These limits are the same on every plan. Going past the orders or
            members your plan includes is not a limit. Baton bills for the extra
            ones, as{" "}
            <s-link href="/help/reference/plans-and-billing">
              Plans and billing
            </s-link>{" "}
            explains.
          </s-paragraph>
          <HelpTable
            columns={["What", "Limit", "At the limit"]}
            rows={[
              [
                "Members",
                n(Domain.ShopLimits.maxMembers),
                "You can't add another member.",
              ],
              [
                "Open orders",
                n(Domain.ShopLimits.maxOpenOrders),
                "New orders don't come into Baton until some are fulfilled or cancelled.",
              ],
            ]}
          />
        </Things>
      </s-section>
      <s-section heading="Other limits">
        <HelpTable
          columns={["What", "Limit", "At the limit"]}
          rows={[
            [
              "Workflows",
              n(Domain.WorkflowLimits.maxWorkflows),
              "You can't create or duplicate another workflow.",
            ],
            [
              "Teams",
              n(Domain.ShopLimits.maxTeams),
              "You can't create another team.",
            ],
            [
              "Order history",
              `${n(Domain.ShopLimits.orderRetentionDays)} days`,
              "Baton deletes orders older than this. Shopify still has them.",
            ],
          ]}
        />
      </s-section>
    </>
  );
}
