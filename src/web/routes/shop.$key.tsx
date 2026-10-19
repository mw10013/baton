import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  createFileRoute,
  Link,
  Outlet,
  retainSearchParams,
  stripSearchParams,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useContext, useEffect, useRef } from "react";
import { ShopKey } from "../../domain/platform.ts";
import { DEFAULT_WORKFLOWS_LIST_STATE, RUN_PAGE } from "../../domain/shop-work.ts";
import { membershipChangedAtom } from "../client/actor-connection.ts";
import { reloadFromServer } from "../client/live-load.ts";
import { ShopSocket } from "../components/ShopSocket.tsx";
import { Things } from "../components/screen/Things.tsx";
import { getShopAccess } from "../server/workflows-list.ts";
import { MemberSearch } from "./-member-search.ts";

/** A key that does not decode is no route at all, so it is 404 and never reaches the Backend. */
const decodeShopKey = Schema.decodeUnknownOption(ShopKey);

/**
 * A member's shop: the layout of every page under `/shop/$key`. It owns the `$key` segment, the
 * member's search context ({@link MemberSearch}) and the member's socket ({@link ShopSocket}),
 * one per shop tab, shared by every page under it. The loader is the gate alone
 * (`getShopAccess`): a member the gate no longer admits gets the not-found page ("No access"),
 * and one no longer signed in goes to sign-in. Each page's own loader reads its data, and is
 * gated again by the Backend.
 */
export const Route = createFileRoute("/shop/$key")({
  params: {
    parse: ({ key }) =>
      Option.match(decodeShopKey(key), { onNone: () => false, onSome: (key) => ({ key }) }),
    stringify: ({ key }) => ({ key }),
  },
  validateSearch: Schema.toStandardSchemaV1(MemberSearch),
  search: {
    middlewares: [
      retainSearchParams(["state", "team", "q"]),
      stripSearchParams({ state: DEFAULT_WORKFLOWS_LIST_STATE, limit: RUN_PAGE }),
    ],
  },
  loader: ({ params }) => getShopAccess({ data: { key: params.key } }),
  component: function MemberShopLayout() {
    const { key } = Route.useParams();
    const hydrated = useHydrated();
    return (
      <ShopSocket shop={key} merchantToken={Option.none()}>
        {hydrated && <MembershipWatch />}
        <Outlet />
      </ShopSocket>
    );
  },
  notFoundComponent: NoAccess,
});

/**
 * Reruns the router's loaders when the socket learns the member's membership changed
 * ({@link membershipChangedAtom}): the pages' loader data was resolved from the old membership
 * and nothing else would refetch it, so they read over HTTP ({@link reloadFromServer}). The loader is also where a removed member finds out they are
 * gone: the gate answers not found and the layout renders {@link NoAccess}, so the socket's own
 * close never has to be read as an authorization answer. Rendered once hydrated: the socket is
 * the browser's.
 */
function MembershipWatch() {
  const changed = useAtomValue(membershipChangedAtom);
  const registry = useContext(RegistryContext);
  const router = useRouter();
  const seen = useRef(changed);
  useEffect(() => {
    if (changed === seen.current) return;
    seen.current = changed;
    void reloadFromServer(registry, router);
  }, [changed, registry, router]);
  return null;
}

/**
 * What the gate's refusal renders: a shop the member is not (or no longer) part of. Said in the
 * member's terms (they were removed, or the link is wrong) with the way back to the shops they
 * still have. No shop name: the gate does not disclose whether the shop exists.
 */
function NoAccess() {
  return (
    <s-page heading="No access" inlineSize="small">
      <s-section accessibilityLabel="No access">
        <Things>
          <s-paragraph color="subdued">You no longer have access to this store.</s-paragraph>
          <Link to="/shop">Your stores</Link>
        </Things>
      </s-section>
    </s-page>
  );
}
