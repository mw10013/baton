import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * The public help: `/help`, the hub; `/help/$section`, a section hub;
 * `/help/$section/$page`, a page. Outside the embedded `/app` frame and the
 * member's `/shop` area, like `/privacy`, so a merchant reads it in a tab
 * beside the admin and a member reads it on a phone. The tree is
 * `HELP_SECTIONS` in `src/lib/helpPages.ts`. Its pages are the `help`
 * template (`ScreenTemplate` in `src/lib/Screen.ts`). Not a merchant or
 * member screen, so it has no Screens row (`checkScreens` in
 * `scripts/lib/spec.ts`).
 */
export const Route = createFileRoute("/help")({
  component: () => <Outlet />,
});
