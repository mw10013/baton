import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SubscriptionPlan } from "@/lib/SubscriptionPlan";
import { sessionShop } from "@/lib/teams";

/**
 * Tells the server that the merchant is about to change their plan.
 *
 * The plan selection page lives on `admin.shopify.com`, outside the app's
 * iframe, so the click is a one-way trip: the return leg carries `plan_handle`
 * and forces a revalidation, but it is a redirect that can be lost — a closed
 * tab, a dismissed navigation — and the only other signal is the 24-hour cache.
 * Shortening the cache deadline on the way out bounds that to minutes.
 */
const prepareManagePlanFn = createServerFn({ method: "POST" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        yield* (yield* SubscriptionPlan).expectChange(
          yield* sessionShop(session.shop),
        );
      }),
    ),
  );

/** How long the click waits for {@link prepareManagePlanFn} before opening the pricing page anyway. */
const PREPARE_MANAGE_PLAN_WAIT_MS = 1500;

/**
 * The Manage plan control, shared by the `/app` home, the orders index banner,
 * and the members page, because all three can reach the conclusion "upgrade" and
 * all three must shorten the cache the same way.
 *
 * The call is awaited before the navigation so the write lands while the tab is
 * still ours, and a failure still opens the page: the cache deadline is a
 * latency optimisation, never a gate on a merchant's ability to reach their
 * own billing. The failure is already logged server-side by the run seam, so
 * nothing is swallowed silently.
 */
export function ManagePlanButton({
  url,
  slot,
}: {
  readonly url: string;
  /** Set when the button is a title-bar action App Bridge hoists out of the iframe. */
  readonly slot?: "primary-action" | "secondary-actions";
}) {
  const prepare = useServerFn(prepareManagePlanFn);
  return (
    <s-button
      {...(slot === undefined ? {} : { slot })}
      variant="secondary"
      onClick={() => {
        /* The cache call is a latency optimisation, never a gate on the
           click: open on success, on failure, and after a bounded wait when
           the answer is slow (a lost session token can stall the request
           past any patience). A navigation that cancels the in-flight
           request costs only the shortened deadline. */
        let opened = false;
        const open = () => {
          if (opened) return;
          opened = true;
          window.open(url, "_top");
        };
        const timer = setTimeout(open, PREPARE_MANAGE_PLAN_WAIT_MS);
        void prepare()
          .then(open, open)
          .finally(() => {
            clearTimeout(timer);
          });
      }}
    >
      Manage plan
    </s-button>
  );
}
