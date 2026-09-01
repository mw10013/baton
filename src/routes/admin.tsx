import { Outlet, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { requireAdmin } from "@/lib/AdminServerFnMiddleware";

const authenticateAdminRoute = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) => runEffect(requireAdmin),
);

export const Route = createFileRoute("/admin")({
  beforeLoad: () => authenticateAdminRoute(),
  component: () => <Outlet />,
});
