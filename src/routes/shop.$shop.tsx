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
import { lenientSearchKey, ListSearchParam } from "@/lib/searchParams";
import { ShopAgentSocketProvider } from "@/lib/ShopAgentSocketHost";

/**
 * **The member's context, and it travels.** `state`, `team`, `limit` and `q` say
 * which state of the workflows list the member is looking at ({@link Domain.WorkflowsListState}), narrowed to which of their teams,
 * how far down it, and what they searched for (`Domain.RunQuery`, whose
 * search ignores the state and the team). They live here rather than on the index route, and
 * `retainSearchParams` copies them onto every link and navigation built to
 * `/shop/$shop` or anything under it, so the two ways home — the browser's
 * Back and the bar's mark (`MemberBar`) — land on the screen the member
 * left rather than on the default one. A row's link to the workflow page carries
 * them without the row knowing they exist, and so will any later child of this
 * layout. `limit` is one of them because a return that lands on page one is a
 * member scrolling back to the row they were standing on. The embedded app's
 * lists follow the same rule on their own layouts: `OrdersSearch`
 * (`app.orders.tsx`) and `WorkflowsSearch` (`app.workflows.tsx`).
 *
 * Nothing here is a sharing risk: a bench tablet is one member's place, the
 * keys name a screen rather than a person, and the object narrows every
 * read to the teams on the connection whatever the URL says.
 *
 * **No value of these keys fails.** They ride in a URL a member can edit and
 * can outlive a team they were taken off, so every one of them decodes to
 * something usable: an unreadable `state` becomes the default, an unreadable
 * `q` reads as no search ({@link lenientSearchKey}), an
 * out-of-range `limit` clamps ({@link Domain.clampRunLimit}) and an unreadable
 * one becomes a page, and `team` is carried as plain text, because which ids
 * mean anything is the teams' answer and not this schema's — the screen
 * resolves it and reads an id the member is not on as Any team
 * (`shop.$shop.workflows.index.tsx`). Failing any of them would put the router's error
 * boundary over the whole member area, workflow page included, for a typo.
 *
 * **A recovery has to name a value, not drop the key.** Returning
 * `Option.none` from `catchDecoding` reads as "no such key", and the router
 * then hands the route the raw text that failed — so a bad `?state=` would
 * arrive at the loader as the string a member typed. Every recovery here
 * answers with the default instead. For `team` and `q` the default is
 * `undefined` ({@link lenientSearchKey}), which the router writes as no key:
 * choosing Any team navigates with `team: undefined`, and recovering that to
 * `""` would leave a `?team=` in the URL that reads as Any team but is not
 * the canonical address of it.
 *
 * `stripSearchParams` keeps the defaults out of the URL, so
 * `/shop/$shop/workflows` with no search stays the canonical way home. An old
 * `?view=` or `?tab=` is an unknown key and lands on the default, Started by
 * you.
 */
const MemberSearch = Schema.Struct({
  state: Schema.optionalKey(
    Domain.WorkflowsListState.pipe(
      Schema.catchDecoding(() =>
        Effect.succeedSome(Domain.DEFAULT_WORKFLOWS_LIST_STATE),
      ),
    ),
  ),
  team: lenientSearchKey(
    Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.transform((team: string) =>
          team.slice(0, Domain.TEAM_SEARCH_MAX),
        ),
        encode: SchemaGetter.transform((team: string) => team),
      }),
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
  q: lenientSearchKey(ListSearchParam),
});

/**
 * Layout for one shop's member area. It owns the `$shop` URL segment and the
 * member's search context ({@link MemberSearch}) and nothing else: the index
 * route redirects to the workflows list, and children such as the workflows
 * list and the workflow page render as full pages through the Outlet.
 * Authorization is not here either; each
 * child's server fn calls `requireMember` itself, so a layout guard would only
 * duplicate the authoritative check.
 */
export const Route = createFileRoute("/shop/$shop")({
  validateSearch: Schema.toStandardSchemaV1(MemberSearch),
  search: {
    middlewares: [
      retainSearchParams(["state", "team", "limit", "q"]),
      stripSearchParams({
        state: Domain.DEFAULT_WORKFLOWS_LIST_STATE,
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
            You no longer have access to this store.
          </s-paragraph>
          <Link to="/shop">Your stores</Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

/**
 * Opens the member's single `ShopAgent` socket for this shop and shares it
 * with every child, the same way `/app` does for merchants
 * (`src/lib/ShopAgentSocketHost.tsx`). One socket per shop tab: the workflows list's
 * actions and its live updates both ride it, and no child opens a second.
 *
 * No `query`: a member has no App Bridge and cannot mint an ID token. Their
 * credential is the better-auth cookie, which the browser attaches to a
 * same-origin upgrade on its own, and which the Worker's connect gate reads to
 * resolve the membership it forwards to the object.
 *
 * `enabled: hydrated` for the same reason as `/app`: the provider creates the
 * socket in an effect after hydration; there is no WebSocket on the server.
 * The page still server-renders — the loader, not the socket, is what paints
 * it.
 *
 * `Domain.CONNECTION_CLOSE_REVOKED` is the object saying this member's teams
 * or membership changed while they were connected. The socket comes back on its
 * own: 3401 is not a terminal close to the SDK, so partysocket reconnects
 * through the gate, which returns with the new membership; what this handler adds
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
