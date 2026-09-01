import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";

const requireUserFn = createServerFn({ method: "GET" })
  .middleware([memberServerFnMiddleware])
  .handler(({ context: { user } }) => ({ email: user.email }));

/**
 * Layout guard for the member area: any `/shop/*` document load or client
 * navigation must present a live better-auth session or bounce to `/login`.
 * Per-shop authorization is not here — `beforeLoad` runs before child loaders,
 * but the shop is a child URL param asserted by `requireMember` in each server
 * fn, which stays authoritative regardless of this guard.
 */
export const Route = createFileRoute("/shop")({
  beforeLoad: () => requireUserFn(),
  head: () => ({ meta: [{ title: "Your shops — Baton" }] }),
  component: () => <Outlet />,
});
