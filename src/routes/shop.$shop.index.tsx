import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The shop root is the member's home, and home is the workflows list.
 * A redirect rather than the list itself so the URL a member reads
 * says the noun (`/shop/$shop/workflows`). The search (`MemberSearch`
 * in `shop.$shop.tsx`) is carried across, so a bookmarked
 * `/shop/x?state=blocked` still lands on Blocked.
 */
export const Route = createFileRoute("/shop/$shop/")({
  beforeLoad: ({ params, search }) => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({
      to: "/shop/$shop/workflows",
      params,
      search,
    });
  },
});
