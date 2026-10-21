import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { hasShopChoice } from "../client/session.ts";
import { LapsedPage } from "../components/LapsedPage.tsx";

/**
 * Where a member loader sends a member of a shop whose app subscription lapsed (the gate's
 * `402`). Deliberately static: no loader, no gate, no socket. Whether to link Your stores comes
 * from the member area's own shop list. A loader would re-run the very
 * check that redirected here, and the `$key_` segment escapes the `/shop/$key` layout so this
 * page never opens the member socket: the gate answers the same refusal with `4402`, and the
 * holder would only send the browser here again.
 *
 * Rendering for any key discloses nothing: the page says the same thing whether the shop exists
 * or the viewer belongs to it, and the session guard on `/shop` still applies.
 */
const memberArea = getRouteApi("/shop");

export const Route = createFileRoute("/shop/$key_/lapsed")({
  head: () => ({ meta: [{ title: "Subscription inactive — Baton" }] }),
  component: function LapsedRoute() {
    const { key } = Route.useParams();
    const shops = memberArea.useLoaderData();
    return <LapsedPage shop={key} yourStores={hasShopChoice(shops)} />;
  },
});
