import { Outlet, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { AdminAuth } from "@/lib/AdminAuth";

const authenticateAdminRoute = createServerFn({ method: "GET" }).handler(
  async ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const auth = yield* AdminAuth;
        yield* auth.requireSession();
      }),
    ),
);

export const Route = createFileRoute("/admin")({
  beforeLoad: async ({ location }) => {
    if (location.pathname !== "/admin/login") await authenticateAdminRoute();
  },
  component: () => <Outlet />,
});
