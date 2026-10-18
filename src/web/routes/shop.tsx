import { createFileRoute, Outlet } from "@tanstack/react-router";
import MemberBar from "../components/MemberBar.tsx";
import { MemberArea } from "../components/screen/MemberArea.tsx";
import { requireRole } from "./-guards.ts";

/** The member area: {@link MemberArea}, with the {@link MemberBar} above every page. */
export const Route = createFileRoute("/shop")({
  beforeLoad: requireRole("user"),
  component: function MemberShell() {
    const { me } = Route.useRouteContext();
    return (
      <MemberArea>
        <MemberBar email={me.email} />
        <Outlet />
      </MemberArea>
    );
  },
});
