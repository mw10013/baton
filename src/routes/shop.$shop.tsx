import * as React from "react";

import {
  createFileRoute,
  Link,
  Outlet,
  retainSearchParams,
  stripSearchParams,
  useHydrated,
  useRouter,
} from "@tanstack/react-router";
import { Effect, Schema, SchemaGetter } from "effect";

import * as Domain from "@/lib/Domain";
import { ShopAgentSocketProvider } from "@/lib/ShopAgentSocketHost";

/**
 * **The member's context, and it travels.** `tab`, `team` and `limit` say
 * which list the member is looking at, narrowed to which of their teams, and
 * how far down it. They live here rather than on the index route, and
 * `retainSearchParams` copies them onto every link and navigation built to
 * `/shop/$shop` or anything under it, so the two ways home — the browser's
 * Back and the bar's mark (`MemberBar`) — land on the screen the member
 * left rather than on the default one. A row's link to the work page carries
 * them without the row knowing they exist, and so will any later child of this
 * layout. `limit` is one of them because a return that lands on page one is a
 * member scrolling back to the row they were standing on.
 *
 * Nothing here is a sharing risk: a bench tablet is one member's place, the
 * three keys name a screen rather than a person, and the object scopes every
 * read to the teams on the connection whatever the URL says.
 *
 * **No value of these keys fails.** They ride in a URL a member can edit and
 * can outlive a team they were taken off, so every one of them decodes to
 * something usable: an unreadable `tab` becomes the default tab, an
 * out-of-range `limit` clamps ({@link Domain.clampRunLimit}) and an unreadable
 * one becomes a page, and `team` is carried as plain text, because which ids
 * mean anything is the roster's answer and not this schema's — the screen
 * resolves it and reads an id the member is not on as All teams
 * (`shop.$shop.index.tsx`). Failing any of them would put the router's error
 * boundary over the whole member area, work page included, for a typo.
 *
 * **A recovery has to name a value, not drop the key.** Returning
 * `Option.none` from `catchDecoding` reads as "no such key", and the router
 * then hands the route the raw text that failed — so a bad `?tab=` would
 * arrive at the loader as the string a member typed. Every recovery here
 * answers with the default instead.
 *
 * `stripSearchParams` keeps the defaults out of the URL, so the bare
 * `/shop/$shop` stays the canonical way home.
 */
const MemberSearch = Schema.Struct({
  tab: Schema.optionalKey(
    Domain.RunTab.pipe(
      Schema.catchDecoding(() => Effect.succeedSome(Domain.DEFAULT_RUN_TAB)),
    ),
  ),
  team: Schema.optionalKey(
    Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.transform((team: string) =>
          team.slice(0, Domain.TEAM_SEARCH_MAX),
        ),
        encode: SchemaGetter.transform((team: string) => team),
      }),
      Schema.catchDecoding(() => Effect.succeedSome("")),
    ),
  ),
  limit: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.decode({
        decode: SchemaGetter.transform(Domain.clampRunLimit),
        encode: SchemaGetter.transform((limit: number) => limit),
      }),
      Schema.catchDecoding(() => Effect.succeedSome(Domain.RUN_PAGE)),
    ),
  ),
});

/**
 * Layout for one shop's member area. It owns the `$shop` URL segment and the
 * member's search context ({@link MemberSearch}) and nothing else: the landing
 * content lives in the index route and children such as the run list render as
 * full pages through the Outlet. Authorization is not here either; each
 * child's server fn calls `requireMember` itself, so a layout guard would only
 * duplicate the authoritative check.
 */
export const Route = createFileRoute("/shop/$shop")({
  validateSearch: Schema.toStandardSchemaV1(MemberSearch),
  search: {
    middlewares: [
      retainSearchParams(["tab", "team", "limit"]),
      stripSearchParams({
        tab: Domain.DEFAULT_RUN_TAB,
        limit: Domain.RUN_PAGE,
      }),
    ],
  },
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
 * (`src/lib/ShopAgentSocketHost.tsx`). One socket per shop tab: the run list's
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
