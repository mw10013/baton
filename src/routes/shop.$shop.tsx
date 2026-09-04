import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Layout for one shop's member area. It owns the `$shop` URL segment and
 * nothing else: the landing content lives in the index route and children
 * such as the queue render as full pages through the Outlet. Authorization
 * is not here either; each child's server fn calls `requireMember` itself,
 * so a layout guard would only duplicate the authoritative check.
 */
export const Route = createFileRoute("/shop/$shop")({
  component: Outlet,
});
