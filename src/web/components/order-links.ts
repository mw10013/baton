import { useEffect, useState } from "react";
import type { ShopOrder } from "../../domain/orders.ts";

/**
 * The order in the Shopify admin. App Bridge resolves the `shopify:` protocol to the right
 * destination for whichever surface the app is running on, so the link never hardcodes a store
 * handle and works embedded as well as in the mobile app. `legacyId` is the REST id the admin
 * routes on.
 *
 * @see refs/shopify-docs/docs/api/app-home/latest/apis/user-interface-and-interactions/navigation-api.md
 */
export const adminOrderUrl = ({ legacyId }: Pick<ShopOrder, "legacyId">) =>
  `shopify://admin/orders/${legacyId}`;

/**
 * A navigation target that works for the current input mode: mobile Safari rejects
 * `shopify://admin/...` resource URLs opened through `_blank`, so touch and hover-less browsers
 * navigate in place instead. `_self` until the effect has read the media query, so the server's
 * markup and the first client render agree.
 */
export const useResourceLinkTarget = () => {
  const [target, setTarget] = useState<"_self" | "_blank">("_self");
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse), (hover: none)");
    const update = () => {
      setTarget(query.matches ? "_self" : "_blank");
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, []);
  return target;
};
