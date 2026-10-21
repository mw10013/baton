import { createFileRoute, redirect } from "@tanstack/react-router";
import { memberLanding } from "../client/session.ts";
import MemberHomePage from "../components/MemberHomePage.tsx";
import { listMyShops } from "../server/shop.ts";

/**
 * Your stores, for a member who has a choice to make: one who belongs to exactly one shop never
 * sees it, and is sent to {@link memberLanding} however they arrive (a magic link that remembered
 * `/shop`, a typed URL, the admin side's redirect).
 */
export const Route = createFileRoute("/shop/")({
  loader: async () => {
    const shops = await listMyShops();
    const landing = memberLanding(shops);
    if (landing !== "/shop") throw redirect({ href: landing });
    return shops;
  },
  component: function MemberHome() {
    return <MemberHomePage shops={Route.useLoaderData()} />;
  },
});
