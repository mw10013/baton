import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * The public help: `/help`, the hub; `/help/$section`, a section hub;
 * `/help/$section/$page`, a page. Outside the embedded `/app` frame and the
 * member's `/shop` area, like `/privacy`, so a merchant reads it in a tab
 * beside the admin and a member reads it on a phone. The tree is
 * `HELP_SECTIONS` in `src/lib/helpPages.ts`; the approach, the structure and
 * the open questions are in `docs/help-research.md`. Not a merchant or
 * member screen, so it has no Screens row (`checkScreens` in
 * `scripts/lib/spec.ts`).
 */
export const Route = createFileRoute("/help")({
  component: () => <Outlet />,
});
