import * as Cause from "effect/Cause";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { OrdersSyncFailure } from "../../contract/shopify.ts";
import { formatNumber, ShopLimits } from "../../domain/platform.ts";
import { toast } from "../client/app-bridge.ts";
import { thrownCopy } from "./form.ts";

/**
 * The order ceiling's sentence, as the quota banner words it. Sync open orders answers `Refused`
 * at the ceiling, and until the billing slice brings that banner, a toast is the only place the
 * merchant learns why the press did nothing.
 */
export const CEILING = `New orders stopped syncing at ${formatNumber(ShopLimits.maxOpenOrders)} open orders. Fulfill or cancel orders in Shopify, then Sync open orders.`;

/** Why a sync press could not act, as the toast says it; `what` names the press. */
export const failureCopy = (reason: OrdersSyncFailure["_tag"], what: string) =>
  Match.value(reason).pipe(
    Match.when(
      "ReauthorizationRequired",
      () => "Couldn't reach Shopify. Reload Baton to reconnect.",
    ),
    Match.when("ShopifyUnavailable", () => "Couldn't reach Shopify. Try again."),
    Match.orElse(() => `Couldn't ${what}: Baton isn't installed on this shop.`),
  );

const isSyncFailure = Schema.is(OrdersSyncFailure);

/**
 * A sync press that failed, as its error toast: a session failure in `syncFailure`'s words,
 * anything else (a lost socket, a defect) in `thrownCopy`'s.
 */
export const toastSyncFailure = (
  cause: Cause.Cause<unknown>,
  syncFailure: (failure: OrdersSyncFailure) => string,
  fallback: string,
) => {
  const error = Cause.squash(cause);
  toast(isSyncFailure(error) ? syncFailure(error) : thrownCopy(error, fallback), {
    isError: true,
  });
};
