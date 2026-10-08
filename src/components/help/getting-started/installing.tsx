import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Installing Baton and choosing a plan (`getting-started/installing`). No
 * pictures, and no plan name, price, count or trial length: those are set
 * in the Partner Dashboard and change without a deploy, which is the home
 * page's own rule (the JSDoc on its component in `src/routes/app.index.tsx`).
 * Read against `src/routes/app.tsx` (an app subscription is required: an
 * unsubscribed shop is sent to Shopify's plan selection page, and the return
 * leg carries `plan_handle`), `ShopifyPartner.planSelectionUrl`,
 * `src/routes/app.index.tsx` (the Orders this billing cycle and Members
 * tiles, "billed at your plan's rate", Manage plan), `ManagePlanButton`, and
 * the billing vocabulary and `Entitlements`, `ShopUsage`, `AppSubscription`
 * in `src/lib/domain/Billing.ts` (a counted order is counted once, when its
 * first item's workflow starts; a cycle's seats are its highest member
 * count; nothing past an allowance is refused; a plan change starts a new
 * billing cycle with both meters at zero; nothing is billed in a trial and
 * its usage does not carry over).
 */
export function Installing() {
  return (
    <>
      <s-section heading="Install Baton">
        <Things>
          <NumberedList
            items={[
              <>
                On Baton&apos;s listing in the Shopify App Store, press{" "}
                <strong>Install</strong>.
              </>,
              <>Shopify shows Baton&apos;s plans. Choose one.</>,
              <>Approve the charge. Baton opens on its home page.</>,
            ]}
          />
          <s-paragraph>
            Baton needs a plan to open. Until you choose one, Baton sends you
            back to the plans.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="What a plan includes">
        <Things>
          <s-paragraph>
            Each plan includes a number of orders and a number of members for
            each billing cycle. Past either number, Baton keeps working, and
            each extra order or member is billed at your plan&apos;s rate. The
            plans show the numbers and the rates.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              An order counts once, the first time a workflow starts on one of
              its items. An order with no workflow does not count.
            </s-list-item>
            <s-list-item>
              A billing cycle&apos;s members are the most members you had at any
              point in it. A member you delete still counts until the cycle
              ends.
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            The home page shows <strong>Orders this billing cycle</strong> and{" "}
            <strong>Members</strong>, each against what your plan includes. The
            Members tile shows today&apos;s count. To change plans, press{" "}
            <strong>Manage plan</strong> on the home page. A new plan applies at
            once and starts a new billing cycle, with both counts at zero. The
            details are in{" "}
            <s-link href="/help/reference/plans-and-billing">
              Plans and billing
            </s-link>
            .
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="The trial">
        <s-paragraph>
          If a plan has a trial, the plans say how long it is. Nothing is billed
          during the trial, and what you use in it does not carry into your
          first billing cycle.
        </s-paragraph>
      </s-section>
    </>
  );
}
