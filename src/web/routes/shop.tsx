import { createFileRoute, Outlet } from "@tanstack/react-router";
import MemberBar from "../components/MemberBar.tsx";
import { MemberArea } from "../components/screen/MemberArea.tsx";
import { listMyShops } from "../server/shop.ts";
import { requireRole } from "./-guards.ts";

/**
 * The member area: {@link MemberArea}, with the {@link MemberBar} above every page. The loader
 * reads the member's shops once per document load, not per navigation (`staleTime`), only so the
 * chrome knows whether the member has a choice of shop; Your stores reads its own fresh list. A
 * router invalidation (sign-out, a membership change) reads it again.
 */
export const Route = createFileRoute("/shop")({
  beforeLoad: requireRole("user"),
  loader: () => listMyShops(),
  staleTime: Infinity,
  component: function MemberShell() {
    const { me } = Route.useRouteContext();
    return (
      <MemberArea>
        <MemberBar email={me.email} shops={Route.useLoaderData()} />
        <Outlet />
      </MemberArea>
    );
  },
});
