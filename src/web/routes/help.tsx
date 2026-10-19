import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * The public help: `/help`, the hub; `/help/$section`, a section hub; `/help/$section/$page`, a
 * page. Outside the embedded `/app` frame and the member's `/shop` area, like `/privacy`, so a
 * merchant reads it in a tab beside the Shopify admin and a member reads it on a phone. The tree is
 * `HELP_SECTIONS`.
 */
export const Route = createFileRoute("/help")({
  component: () => <Outlet />,
});
