import { HelpTable } from "@/components/screen/HelpTable";
import { Things } from "@/components/screen/Things";
import * as Domain from "@/lib/Domain";

/**
 * Plans and billing (`reference/plans-and-billing`), a reference page. It
 * prints no plan name, price, included count, trial length or any other
 * plan number: those are set in the Partner Dashboard and change without a
 * deploy, which is the home page's own rule (the JSDoc on its component in
 * `src/routes/app.index.tsx`). The two hard limits, `ShopLimits.maxMembers`
 * and `ShopLimits.maxOpenOrders`, are the one exception: they are constants,
 * read here and on Limits, so they cannot drift, and a merchant reading
 * about metering learns here where it stops.
 * `test/integration/help-limits.test.ts` holds the page to no other digit.
 *
 * Read against the billing vocabulary on `src/lib/domain/Billing.ts` (a
 * billing cycle is one month of an app subscription; a counted order is one
 * unit, once; a cycle's seats are its highest member count; included is a
 * paid allowance), `Entitlements` (past an allowance the meter bills and
 * nothing refuses), the triggers table on `ShopUsage` (the first workflow on
 * an order counts it, another never does, and nothing decrements the count;
 * a new billing cycle recounts orders from its start and sets the seat mark
 * to the member count), `seatEventValue` (a removal never lowers the mark),
 * `AppSubscription` (a plan change is a new app subscription and a new
 * billing cycle; usage in a trial is not reported and does not carry over),
 * `PlanStatus` (a change applies at once, up or down), `src/routes/app.tsx`
 * (an unsubscribed shop is sent to Shopify's plan selection page, which
 * help calls the pricing page everywhere),
 * `src/routes/app.index.tsx` (the Orders this billing cycle and Members
 * tiles, "billed at your plan's rate", Resets with the cycle's end, the
 * Members tile's count is today's, Manage plan), `MemberAccess` and
 * `src/routes/shop.$shop_.lapsed.tsx` (a member of a lapsed shop gets the
 * Subscription inactive page), and the shop row on `D1_TABLES` in
 * `src/lib/D1Schema.ts` (uninstall deletes the shop's members and teams and
 * destroys its object; nothing else deletes on a lapse), and
 * `refs/shopify-docs/docs/apps/launch/billing.md` (app charges are added to
 * the merchant's Shopify invoice). It agrees with
 * `getting-started/installing.tsx` word for word on the trial.
 */
export function PlansAndBilling() {
  return (
    <>
      <s-section heading="The plans">
        <s-paragraph>
          You choose a plan on Shopify&apos;s pricing page when you install
          Baton, and change it from <strong>Manage plan</strong> on the home
          page. The pricing page shows each plan&apos;s price, the orders and
          members it includes, and the rate past them. Shopify bills your plan
          each billing cycle, which is a month, on your Shopify invoice.
        </s-paragraph>
      </s-section>
      <s-section heading="What counts">
        <HelpTable
          columns={["What", "Counts when", "Resets"]}
          rows={[
            [
              "Orders",
              <>
                An order counts once, the first time a workflow starts on one of
                its items, by a tag or by <strong>Attach</strong>. An order with
                no workflow does not count, and cancelling the workflow
                afterwards does not take the order back off your bill.
              </>,
              "Each billing cycle starts again at zero.",
            ],
            [
              "Members",
              "A billing cycle's members are the most members you had at any point in it. A member you delete still counts until the cycle ends.",
              "Each billing cycle starts from the members you have then.",
            ],
          ]}
        />
      </s-section>
      <s-section heading="Past what your plan includes">
        <s-paragraph>
          Going past what your plan includes never stops Baton working. Each
          extra order or member is billed at your plan&apos;s rate. On the home
          page, under <strong>Your plan</strong>,{" "}
          <strong>Orders this billing cycle</strong> and{" "}
          <strong>Members</strong> show where you stand against what your plan
          includes. Orders this billing cycle also says when the cycle resets,
          and Members shows how many members you have today. Every plan has two
          hard limits: {Domain.formatNumber(Domain.ShopLimits.maxMembers)}{" "}
          members and {Domain.formatNumber(Domain.ShopLimits.maxOpenOrders)}{" "}
          open orders. See <s-link href="/help/reference/limits">Limits</s-link>
          .
        </s-paragraph>
      </s-section>
      <s-section heading="Changing plans">
        <s-paragraph>
          Press <strong>Manage plan</strong> on the home page to open
          Shopify&apos;s pricing page. A new plan applies at once, up or down.
          It starts a new billing cycle. Orders this billing cycle starts again
          at zero, and the members count starts from the members you have.
        </s-paragraph>
      </s-section>
      <s-section heading="The trial">
        <s-paragraph>
          If a plan has a trial, the pricing page says how long it is. Nothing
          is billed during the trial, and what you use in it does not carry into
          your first billing cycle.
        </s-paragraph>
      </s-section>
      <s-section heading="If your subscription ends">
        <Things>
          <s-paragraph>
            When you open Baton without a plan, it sends you to the pricing
            page. Members who sign in see <strong>Subscription inactive</strong>
            , and their workflows are unavailable until you choose a plan again.
          </s-paragraph>
          <s-paragraph>
            Ending a subscription deletes nothing. Uninstalling Baton deletes
            everything it holds for your store, and installing it again starts
            with nothing.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
