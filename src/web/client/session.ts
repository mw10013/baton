import type { AnyRouter } from "@tanstack/react-router";
import type { Role } from "../../contract/auth.ts";
import type { ShopKey } from "../../domain/platform.ts";

/** Each role has its own side of the site. */
export const homeFor = (role: Role) => (role === "admin" ? "/admin" : "/shop");

/**
 * Where a signed-in member lands, from the shops they belong to: a member of exactly one shop
 * lands on that shop's workflows list, because Your stores would be a page with one link on it
 * and a bench wants the work, not a menu; none or several land on Your stores (`/shop`), which is
 * also where a member with no shops reads why. Most members belong to one shop, so for them
 * shops are invisible: Your stores sends them here too, and no screen links to it
 * ({@link hasShopChoice}).
 */
export const memberLanding = (shops: ReadonlyArray<ShopKey>) => {
  const [only] = shops;
  return only !== undefined && shops.length === 1 ? `/shop/${only}/workflows` : "/shop";
};

/** Whether a link to Your stores is worth showing: only a member of several shops has a choice there. */
export const hasShopChoice = (shops: ReadonlyArray<ShopKey>) => shops.length > 1;

/**
 * Ends the Better Auth session through the Website's auth proxy, then reruns the current
 * route's guards and loaders, which ask the Backend again and now find no session.
 */
export const signOut = async (router: Pick<AnyRouter, "invalidate">): Promise<void> => {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`Sign-out failed with status ${response.status}`);
  await router.invalidate();
};
