import * as React from "react";

import {
  createFileRoute,
  Link,
  Outlet,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";

import * as Domain from "@/lib/Domain";
import { ShopAgentSocketProvider } from "@/lib/ShopAgentSocketHost";

/**
 * Layout for one shop's member area. It owns the `$shop` URL segment and
 * nothing else: the landing content lives in the index route and children
 * such as the queue render as full pages through the Outlet. Authorization
 * is not here either; each child's server fn calls `requireMember` itself,
 * so a layout guard would only duplicate the authoritative check.
 */
export const Route = createFileRoute("/shop/$shop")({
  component: RouteComponent,
  notFoundComponent: NotFoundComponent,
});

/**
 * What a child loader's `notFound` renders: `requireMember` answers it for a
 * shop the member is not (or no longer) part of. Said in the member's terms —
 * they were removed, or the link is wrong — with the way back to the shops
 * they still have. No shop name: the guard does not disclose whether the
 * shop exists.
 */
function NotFoundComponent() {
  return (
    <s-page heading="No access" inlineSize="small">
      <s-section accessibilityLabel="No access">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            You no longer have access to this shop.
          </s-paragraph>
          <Link to="/shop">Your shops</Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

/**
 * Opens the member's single `ShopAgent` socket for this shop and shares it
 * with every child, the same way `/app` does for merchants
 * (`src/lib/ShopAgentSocketHost.tsx`). One socket per shop tab: the queue's
 * actions and its live updates both ride it, and no child opens a second.
 *
 * No `query`: a member has no App Bridge and cannot mint an ID token. Their
 * credential is the better-auth cookie, which the browser attaches to a
 * same-origin upgrade on its own, and which the Worker's connect gate reads to
 * resolve the membership it forwards to the object.
 *
 * `enabled: hydrated` for the same reason as `/app`: `useAgent` evaluates its
 * connection during render, including SSR, where there is no WebSocket to
 * open. The page still server-renders — the loader, not the socket, is what
 * paints it.
 *
 * `Domain.CONNECTION_CLOSE_REVOKED` is the object saying this member's teams
 * or membership changed while they were connected. The socket comes back —
 * `ShopAgentSocketHost` re-arms it on that code, because `agents` treats a
 * 4000-range close as terminal and will not reconnect on its own — which
 * re-runs the gate and returns with the new membership; what this handler adds
 * is invalidating the router, because the page's loader data was resolved from
 * the *old* membership and nothing else would refetch it. The loader is also
 * where a revoked member finds out they are gone: `requireMember` answers
 * `notFound` and the route renders its not-found state, so the socket's
 * reconnect never has to be interpreted as an authorization answer.
 */
function RouteComponent() {
  const { shop } = Route.useParams();
  const hydrated = useHydrated();
  const router = useRouter();
  const onSocketClose = React.useCallback(
    (event: CloseEvent) => {
      if (event.code === Domain.CONNECTION_CLOSE_REVOKED)
        void router.invalidate();
    },
    [router],
  );
  return (
    <ShopAgentSocketProvider
      shop={shop}
      query={undefined}
      enabled={hydrated}
      onSocketClose={onSocketClose}
    >
      <Outlet />
    </ShopAgentSocketProvider>
  );
}
