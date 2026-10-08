import { Things } from "@/components/screen/Things";

/**
 * Syncing from Shopify (`orders/syncing`), a concept page: how orders
 * arrive, Sync open orders, Sync from Shopify, and the open-order limit.
 * Read against the order webhook topics in `shopify.app.toml`
 * (`orders/create`, `orders/paid`, `orders/cancelled`, `orders/fulfilled`,
 * `orders/edited`), the four tables on `syncOrder` in
 * `src/lib/domain/Orders.ts` (every source fetches the order whole, the
 * topic decides nothing; one open-orders sync at a time; its query is open,
 * unfulfilled, created in the last 30 days; an older copy never overwrites a
 * newer one; a sync never deletes an order, retention does; only a new
 * order is gated by the ceiling; Sync from Shopify answers Gone and keeps
 * the stored row; a failed sync leaves its error for the page),
 * `SyncOrderResult`, `OrdersSyncResult`, the triggers and actions tables on
 * `reconcileItem` in `src/lib/domain/ShopWork.ts` (paid creates; cancelled
 * and fulfilled close every open workflow; an edited quantity resizes or, at
 * zero, closes as removed; a partial fulfilment, an archive and a refund
 * that leaves the quantity are not stops; a product retagged in Shopify
 * changes nothing until its order syncs again), `unitsToMake`,
 * `src/routes/app.orders.index.tsx` (Sync open orders greyed while a sync
 * runs, the toast on a second press, the sync's error banner, the empty
 * state's sentence), `src/routes/app.orders.$orderId.tsx` (Sync from
 * Shopify and its Gone toast), `QuotaBanners` in
 * `src/components/QuotaBanners.tsx` (on the Orders page and the home page,
 * until Sync open orders starts), `ShopLimits.maxOpenOrders` in
 * `src/lib/domain/Platform.ts` and `openOrdersAtCeiling` in
 * `src/lib/domain/Billing.ts`. The limit's number is on Limits, not here.
 */
export function Syncing() {
  return (
    <>
      <s-section heading="How orders arrive">
        <Things>
          <s-paragraph>
            Baton keeps its own copy of each order, and Shopify tells it when
            one changes: when an order is created, paid, cancelled, fulfilled or
            edited. Each time, Baton reads the whole order from Shopify, so the
            newest copy wins whichever message arrives first.
          </s-paragraph>
          <s-paragraph>What Baton follows:</s-paragraph>
          <s-unordered-list>
            <s-list-item>
              A paid order starts the workflow whose tag an item&apos;s product
              carries, whether it arrives paid or is paid later.
            </s-list-item>
            <s-list-item>
              An order cancelled or fulfilled in Shopify ends every open
              workflow on it.
            </s-list-item>
            <s-list-item>
              An edit in Shopify that changes an item&apos;s quantity resizes
              its workflow. At zero, the workflow ends and the item reads{" "}
              <strong>Removed</strong>. A refund that lowers the quantity does
              the same the next time the order is read.
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>What Baton does not follow:</s-paragraph>
          <s-unordered-list>
            <s-list-item>
              A partial fulfilment. The work goes on until the whole order is
              fulfilled.
            </s-list-item>
            <s-list-item>An order archived in Shopify.</s-list-item>
            <s-list-item>
              A refund that leaves the quantity as it was.
            </s-list-item>
            <s-list-item>
              A product you retag in Shopify, until its order is read again. How
              tags match is in{" "}
              <s-link href="/help/workflows/matching">
                Matching items by product tag
              </s-link>
              .
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            Reading an order never removes one from Baton. Orders leave when
            they pass the age Baton keeps them for, which is in{" "}
            <s-link href="/help/reference/limits">Limits</s-link>.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Sync open orders">
        <Things>
          <s-paragraph>
            <strong>Sync open orders</strong> is at the top of the Orders page.
            It reads every open, unfulfilled order placed in the last 30 days
            and adds the ones Baton lacks. An order Baton already has is
            updated, never added twice. Workflows start on the paid orders whose
            items match.
          </s-paragraph>
          <s-paragraph>
            Press it after installing Baton, and when a banner says new orders
            stopped syncing. One sync goes at a time: the button is greyed while
            it works, and the list fills as orders arrive. If a sync fails, a
            red banner at the top of the list says what went wrong until the
            next sync starts.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Sync from Shopify on an order">
        <Things>
          <s-paragraph>
            <strong>Sync from Shopify</strong> at the top of an order&apos;s
            page reads that one order from Shopify now. Press it when Shopify
            shows the order fulfilled or cancelled and Baton still shows it
            open, or when an edit in Shopify has not reached Baton.
          </s-paragraph>
          <s-paragraph>
            If Shopify no longer has the order, a message says so, and Baton
            keeps its copy.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="The open-order limit">
        <Things>
          <s-paragraph>
            Baton holds a limited number of open orders. At the limit, it stores
            no new order. Orders it already has still take their changes from
            Shopify. A red banner on the Orders page and the home page says new
            orders stopped syncing.
          </s-paragraph>
          <s-paragraph>
            Fulfill or cancel orders in Shopify, then press{" "}
            <strong>Sync open orders</strong>. It brings in the orders that were
            not stored, if they are still open and from the last 30 days. The
            banner goes once the sync starts. If Baton is still at the limit,
            the sync does not start. The number is in{" "}
            <s-link href="/help/reference/limits">Limits</s-link>.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
