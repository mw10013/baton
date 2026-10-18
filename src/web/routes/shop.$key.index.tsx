import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The shop root is the member's home, and home is the workflows list. A redirect rather than the
 * list itself, so the URL a member reads says the noun (`/shop/$key/workflows`). The search
 * (`MemberSearch`) is carried across, so a bookmarked `/shop/<key>?state=blocked` still lands on
 * Blocked.
 */
export const Route = createFileRoute("/shop/$key/")({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/shop/$key/workflows", params, search });
  },
});
