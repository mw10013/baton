import { HelpTable } from "../../screen/HelpTable.tsx";
import { Things } from "../../screen/Things.tsx";
import * as Platform from "../../../../domain/platform.ts";
import { HelpLink } from "../HelpLink.tsx";

/**
 * Limits (`reference/limits`), a reference page: the limits a merchant plans
 * around before reaching them. A limit the screen states when the merchant
 * reaches it (a field's length, the editor's tasks per workflow) is not on
 * the page, nor is one no small or medium shop comes near (items on an
 * order, properties on an item) or one that only matters to someone sharing
 * a login (connections and sign-ins per member). Those stay enforced and
 * documented on their constants. The unit test
 * holds the page to the five it carries.
 *
 * Every number is read from its constant and printed through
 * `Platform.formatNumber`, the formatter every screen uses, so a changed
 * constant changes the page with no edit.
 *
 * Read against `ShopLimits` (`maxMembers`,
 * `maxOpenOrders`, `maxTeams`, `orderRetentionDays`), `WorkflowLimits`
 * (`maxWorkflows`), `membersAtCeiling` and `openOrdersAtCeiling`, `retentionCutoff` (the age is from
 * `processedAt`, the date the Orders page prints as Placed), and the
 * create and duplicate actions on the Members, Teams and Workflows pages.
 *
 * The page gives no reason for a limit, names no banner and says nothing
 * of orders per billing cycle. How Sync open orders recovers the orders
 * not stored at the open-order limit is on Syncing from Shopify, not here.
 */
export function Limits() {
  const n = Platform.formatNumber;
  return (
    <>
      <s-section heading="Hard limits">
        <Things>
          <s-paragraph>
            These limits are the same on every plan. Going past the orders or members your plan
            includes is not a limit. Baton bills for the extra ones, as{" "}
            <HelpLink href="/help/reference/plans-and-billing">Plans and billing</HelpLink>{" "}
            explains.
          </s-paragraph>
          <HelpTable
            columns={["What", "Limit", "At the limit"]}
            rows={[
              ["Members", n(Platform.ShopLimits.maxMembers), "You can't add another member."],
              [
                "Open orders",
                n(Platform.ShopLimits.maxOpenOrders),
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
              n(Platform.WorkflowLimits.maxWorkflows),
              "You can't create or duplicate another workflow.",
            ],
            ["Teams", n(Platform.ShopLimits.maxTeams), "You can't create another team."],
            [
              "Order history",
              `${n(Platform.ShopLimits.orderRetentionDays)} days`,
              "Baton deletes orders older than this. Shopify still has them.",
            ],
          ]}
        />
      </s-section>
    </>
  );
}
