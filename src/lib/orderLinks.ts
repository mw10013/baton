import type * as Domain from "@/lib/Domain";

import * as React from "react";

/**
 * App Bridge resolves the `shopify:` protocol to the right destination for
 * whichever surface the app is running on, so the link never hardcodes a store
 * handle and works embedded as well as in the mobile app.
 * `refs/shopify-docs/docs/api/app-home/latest/apis/user-interface-and-interactions/navigation-api.md:52`
 *
 * `legacyId` is `Order.legacyResourceId` — the REST id the admin routes on.
 * Stored as text because it exceeds the integers `SqlStorage.exec` round-trips
 * losslessly.
 */
export const adminOrderUrl = ({ legacyId }: Domain.ShopOrder) =>
  `shopify://admin/orders/${legacyId}`;

/**
 * Picks a navigation target that actually works for the current input mode:
 * mobile Safari rejects `shopify://admin/...` resource URLs opened through
 * `_blank`, so touch and hover-less browsers navigate in place instead.
 * Ported from `../motio/src/routes/app.scan.tsx`, where the failure was found.
 */
export const useResourceLinkTarget = () => {
  const [target, setTarget] = React.useState<"_self" | "_blank">("_self");

  React.useEffect(() => {
    const query = window.matchMedia("(pointer: coarse), (hover: none)");
    const updateTarget = () => {
      setTarget(query.matches ? "_self" : "_blank");
    };
    updateTarget();
    query.addEventListener("change", updateTarget);
    return () => {
      query.removeEventListener("change", updateTarget);
    };
  }, []);

  return target;
};
