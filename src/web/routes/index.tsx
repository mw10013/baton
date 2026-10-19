import { createFileRoute, redirect } from "@tanstack/react-router";
import HomePage from "../components/HomePage";
import { getMe } from "../server/session.ts";

export const Route = createFileRoute("/")({
  // The admin loads the app's root URL with `shop=`: an embedded launch, so on into the App Home.
  beforeLoad: ({ location }) => {
    if (new URLSearchParams(location.searchStr).has("shop"))
      throw redirect({ href: `/app${location.searchStr}` });
  },
  head: () => ({ meta: [{ title: "Baton | Made-to-order production workflows" }] }),
  loader: async () => ({ me: (await getMe()) ?? undefined }),
  component: function HomeRoute() {
    return <HomePage me={Route.useLoaderData().me} />;
  },
});
