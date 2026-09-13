# Member access: how a signed-in member reaches the shop's object and the Admin API

Research date: 2026-09-12. Written for a fresh session to take up. Scope: the trust
boundary on the member side of Baton (`/login`, `/shop/*`): what a member's request
carries, what checks it, what it may call on the `ShopAgent` Durable Object, whether and
how the Admin API gets called on a member's behalf, and what a member-side WebSocket
would need. Ends with the open decisions and a recommended shape. The member UI work in
`docs/member-ux-research.md` is parked on this.

Every claim below about the codebase is from the code as of this date; every claim
about Shopify is from `refs/shopify-docs/` and `refs/shopify-app-js/`, cited by path.
Where the refs were silent it says so.

## The short version

1. **Members already call the Admin API today, and it is already the offline token.**
   The member shop page (`src/routes/shop.$shop.index.tsx`) calls
   `ShopAgentClient.getShopInfo`, which runs `ShopAgent.getShopInfo`, which does
   `ensureShopSession(shop)` and a GraphQL `shop { name }` with the shop's stored
   offline session. No App Bridge, no merchant in the loop. That is the whole model,
   and it is the same one webhooks and the orders sync use.
2. **There are two tokens with two jobs, and the member side only ever sees one.** The
   App Bridge _session token_ (a 60-second JWT) proves "this request comes from this
   shop's admin, from this staff user, right now". The _offline access token_ (the row
   in D1 `ShopSession`) proves "this app is installed on this shop" and is what calls
   the Admin API. The session token is only ever exchanged for the access token; it is
   never itself sent to the Admin API by this app. Members have no session token and
   cannot get one. They do not need one: the access token is the shop's, not the
   user's.
3. **What members lack is not Admin API access. It is a way onto the socket.** The
   Durable Object's WebSocket is gated once, at connect, by verifying an App Bridge
   session token in the Worker (`authorizeShopAgentRequest` in `src/worker.ts`). After
   that, every `@callable()` method on the object trusts the connection completely:
   there is no role on a connection and no per-method authorization. So a member
   socket is not "let members through the gate"; it is "give connections a role and
   make the object enforce it", which the object has never had to do.
4. **Recommended shape.** Keep the Worker as the only place that knows who a member
   is. For server functions, that is what exists. For a socket, the Worker's
   `onBeforeConnect` verifies the better-auth cookie, resolves membership and teams,
   and forwards a rewritten request whose headers carry `role=member`, `memberId`,
   `memberEmail`, `teamIds`; the object copies them into `connection.state` in
   `onConnect` and every callable checks the role. Merchant connections get
   `role=merchant` the same way. The Admin API is called from the object with the
   offline token exactly as now; nothing about tokens changes.

## Vocabulary

- **Merchant**: a Shopify staff user inside the embedded admin (`/app/*`). Authenticated
  by App Bridge session tokens.
- **Member**: a person with a Baton login and no Shopify account (`/shop/*`).
  Authenticated by a better-auth session cookie obtained through a magic link.
- **Operator**: Baton's own admin (`/admin/*`, `ADMIN_EMAILS`). Out of scope here.
- **Session token / id token**: the JWT App Bridge mints in the browser
  (`shopify.idToken()`); ~60 s lifetime, signed with the app's API secret, `dest` is the
  shop, `sub` is the staff user id. Sent as `Authorization: Bearer` on server-function
  requests and as `?token=` on the socket URL.
- **Access token**: what the Admin API accepts. Obtained by _token exchange_ from a
  session token. Online tokens are per staff user and short lived; offline tokens are
  per shop, and in this app they are the expiring kind with a refresh token.
- **ShopSession**: the D1 row per shop (`migrations/0001_init.sql`): `accessToken`,
  `accessTokenExpiresAt`, `refreshToken`, `refreshTokenExpiresAt`, scope, plan. One row,
  offline only. `Member` and `Team` FK to it.

## What the code does today

### Merchant side (`/app/*`), for contrast

- Document requests: `isShopifyAppDocumentRequest` → `shopify.authenticateAdmin`
  (`src/lib/Shopify.ts`). It reads the session token (header or `id_token` param),
  verifies it, and if D1 has no usable offline session, or the token was minted for a
  different scope, performs a **token exchange** with
  `RequestedTokenType.OfflineAccessToken` (`src/lib/Shopify.ts:1321`) and stores the
  result in `ShopSession` via `storeShopSession`. The offline session is the only kind
  ever requested; the app never asks for an online token.
- Server functions: `shopifyServerFnMiddleware` verifies the bearer session token per
  call. Admin calls made by the Worker for a merchant go through the same stored
  offline session.
- Socket: `src/routes/app.tsx` mounts `useAgent` with `query: () => shopify.idToken()`.
  The Worker's `routeAgentRequest` hooks (`onBeforeConnect`, `onBeforeRequest`) run
  `authorizeShopAgentRequest`: decode the token, check the URL's instance name equals
  the token's `dest` host, check the subscription, and let the request through. The
  object sees nothing about the user; `getCurrentAgent().connection` is used only to
  store subscription state (`connection.setState({ subscriberId, orderId })`).

### Member side (`/shop/*`)

- `/login` → `auth.signInMagicLink` (better-auth). The link is only issued if
  `repository.listMemberShops(email)` is non-empty (or the email is an operator).
- Every member server function uses `memberServerFnMiddleware` (validates the cookie,
  bounces admins) and then `requireMember({ shop, email })`, which returns
  `MemberAccess = { shop, memberId, teams }` from D1 or `notFound`.
- The handler then calls the object over plain RPC through `ShopAgentClient`
  (`env.SHOP_AGENT.getByName(shop)`), passing `teamIds`, `memberId`, `memberEmail` as
  arguments. The object's member methods (`listQueue`, `startStep`, `completeStep`,
  `setStepNote`, `blockRun`, `dismissFlag`) are deliberately **not** `@callable()`; the
  comment above `listQueue` in `src/lib/ShopAgent.ts` says why: "the member area has no
  socket, and `teamIds` / `memberId` are privileged inputs the Worker resolves from the
  session". The object trusts these arguments because only the Worker can make RPC
  calls.
- Admin API from a member path: `getShopInfo`, as above. It works because the object
  resolves the shop's offline session itself (`ensureShopSession`), refreshing it if
  the access token is within five minutes of expiry
  (`BACKGROUND_ACCESS_TOKEN_REFRESH_BUFFER_MS`) with the `refresh_token` grant
  (`refreshShopSession`). If the refresh token itself has lapsed (about 90 days idle,
  per the comment on `REFRESH_TOKEN_EXPIRY_BUFFER_MS`), the call fails with
  `RefreshTokenExpiredError` and nothing on the member side can fix it: a merchant has
  to open the app so `authenticateAdmin` performs a new token exchange.

So the answer to "when the server calls the Admin API for a member, is it the offline
token?" is yes, and it is already the case, and it is the same path a webhook or the
orders sync takes. The member is a reason to make the call, not a party to it.

## The Shopify token model, grounded

See the "Shopify facts" section at the end for the refs-cited details. The conceptual
picture:

```
browser (embedded admin)                 Worker                         D1 ShopSession
  App Bridge mints session token  ───►  verify JWT (API secret)
  (60 s, per staff user, per shop)        │
                                          ├── have a valid offline session?  ──► read row
                                          │     yes: use it
                                          │     no / scope changed: token exchange
                                          │            session token ──► Shopify ──► offline access token
                                          │                                          + refresh token
                                          └── store ───────────────────────────────► write row

anything else (webhook, sync, DO alarm, MEMBER request)
  no session token; only the shop name  ───►  ensureShopSession(shop) ──► read row
                                                 access token near expiry? refresh_token grant, rotate, write
                                                 refresh token lapsed?    fail; a merchant visit re-exchanges
```

Three consequences:

- A member can never trigger a token exchange. The exchange needs a session token,
  and only App Bridge inside the admin iframe can mint one. Members are therefore
  always downstream of some merchant visit having installed the app and filled the
  row. That is already guaranteed structurally: `Member.shop` FKs to `ShopSession`.
- A member can trigger a **refresh**. `ensureShopSession` runs from the object
  regardless of who caused the call, and refreshes rotate both tokens forward. A shop
  whose merchant never opens the admin but whose members work every day keeps its
  offline session alive through member activity. (The refresh race handling in
  `recoverRefreshRace` already covers a member call and a webhook refreshing at once.)
- A shop idle for ~90 days with no merchant visit loses its refresh token and the next
  member action that needs the Admin API fails. Today that is only `getShopInfo` on
  the shop page; the queue and step actions never touch Shopify. The parked UI plan
  moves `getShopInfo` into a top bar on every member page, which would make this
  failure visible on every screen; cache the shop name in the object (or in D1 beside
  the session) so the member area never depends on a live Admin call for chrome.

## The socket question

### What the socket is for

The merchant pages use the socket for two things: pushes (the orders index and order
page re-read on `publish`) and `@callable()` RPC for every mutation in the workflow
editor. The member area would want only the first: a queue that moves when a teammate
presses Done. Mutations can stay as server functions.

### Why members cannot use the current socket

`authorizeShopAgentRequest` requires a session token, and a member has none. Even if
the gate admitted a cookie, the object would then treat the connection like a
merchant's: every `@callable()` (`createWorkflow`, `removeWorkflow`, `deleteTeam`,
`seedOrders`, …) would be reachable from a member's browser. Connection identity is
the missing primitive.

### What the agents SDK allows

`routeAgentRequest(request, env, { onBeforeConnect, onBeforeRequest })`: each hook may
return a `Response` (reject), nothing (pass through), or a **new `Request`** that
replaces the one forwarded to the object (`refs/partykit/packages/partyserver/src/index.ts`,
around line 391 for the types and 550 for the `instanceof Request` branch). The object's
`onConnect(connection, ctx)` receives `ctx.request`, so headers set by the Worker are
readable at connect, and `connection.setState(...)` persists a small JSON object on the
connection for the life of the socket (already used for subscriptions). Inside a
callable, `getCurrentAgent().connection` gives the calling connection.

That is enough to build a role on the connection without the object ever seeing a
cookie or a session token.

### Options

**A. Poll.** The member queue re-fetches its loader every 15 s and on window focus.
No new trust boundary; the object stays RPC-only for members. Costs one D1 membership
read plus one object RPC per member per interval. Fine for a bench; not live.

**B. Member socket with connection roles (recommended for later).**

1. Worker `onBeforeConnect`: if the URL carries `?token=`, run the existing merchant
   gate and, on success, return a new `Request` with `x-baton-role: merchant` (strip
   any incoming `x-baton-*` first, so a browser cannot spoof one). Otherwise read the
   better-auth cookie (the socket upgrade is a same-origin request, so the cookie is
   sent), `auth.getSession`, `requireMember({ shop: <instance name>, email })`, and
   return a new `Request` with `x-baton-role: member`, `x-baton-member-id`,
   `x-baton-member-email`, `x-baton-team-ids`. Reject everything else.
2. Object `onConnect`: copy those headers into `connection.setState({ role, ... })`.
   Extend `Domain.SubscriptionState` (or a new `ConnectionState`) so subscription
   fields and identity live together; the existing `subscription()` decoder becomes
   the identity decoder.
3. Every `@callable()` starts with a role check: merchant-only ones fail for a member
   connection; new member callables (`subscribeQueue`, read-only) derive `teamIds`
   from the connection, never from the message. Do this with one helper
   (`requireRole(connection, "merchant")`) so the check cannot be forgotten, and add a
   Vitest that walks every callable name and asserts it is in one of the two lists.
4. Client: a second socket host for `/shop/$shop` that calls `useAgent` without a
   token query. The `ShopAgentContext` machinery (identified flag, stale reconnect) is
   reusable as is.
5. Teams change while a socket is open: `requireMember` runs at connect only, so a
   member removed from a team keeps receiving pushes until reconnect (Cloudflare closes
   idle sockets after ~300 s, which bounds it, exactly as the merchant subscription
   check is bounded today). Pushes carry no data the member could not read a moment
   ago; mutations still go through server functions, which re-check per call.

**C. Server-sent events or long-poll from the Worker.** Rejected: the pushes originate
in the object, and the object's fan-out is the socket.

### What the Admin API has to do with the socket

Nothing. The socket never carries an access token, and the object calls Shopify with
the offline session whether the trigger was a socket callable, an RPC, an alarm, or a
webhook. The socket question is purely "who is on this connection".

## Decisions to make in the next session

1. **Poll first, or build the member socket now?** Recommendation: poll now (Phase 3
   of the parked plan), build B when the queue is in daily use by more than one bench.
   B is roughly a day plus a security review, and it is easier to review against a
   working polling page.
2. **Where the shop name (and any other chrome data) comes from for members.**
   Recommendation: store `shopName` in the object's own SQLite when
   `getShopInfo` succeeds, and have the member pages read the cached value. Members
   should never fail on a lapsed refresh token.
3. **Should any member action ever need the Admin API?** Nothing in the parked UI does.
   Possible future ones: showing a product image on the work page (better solved by
   syncing `featuredImage` with the line item), marking a fulfilment (a merchant-side
   decision; a packer's "Hand to carrier" should not create a fulfilment without an
   explicit merchant setting). Recommendation: treat "member action calls Shopify" as a
   product decision to make per feature, and when it happens, do it from the object
   with the offline session, exactly like `getShopInfo`, never from the Worker on the
   member's request path.
4. **Scopes.** The offline token carries the app's scopes, so a member-triggered call
   has the same power as a webhook. No per-user scoping is possible on the member side
   (there is no Shopify user). Authorization for what a member may do is Baton's
   (teams and steps), not Shopify's.

## Shopify facts, with sources

Paths are under `refs/`.

**Token kinds** (`shopify-docs/docs/apps/build/authentication-authorization/access-tokens.md`)

- Online: tied to the staff member; expires after 24 hours or when that user logs out
  of the admin. No refresh token; renewed only by another token exchange. Baton never
  requests one.
- Non-expiring offline: no expiry; new public apps cannot use them for the Admin API
  and existing ones are cut off on 2027-01-01
  (`…/migrate-to-expiring-offline-access-tokens.md`).
- Expiring offline, which is what Baton stores: access token lives 1 hour
  (`expires_in: 3600`), refresh token lives 90 days (`refresh_token_expires_in:
7776000`). Requested by `expiring=1` on the exchange.

**Refresh** (`shopify-app-js/packages/apps/shopify-api/lib/auth/oauth/refresh-token.ts`)

- `POST /admin/oauth/access_token` with `grant_type=refresh_token`, client id, client
  secret, and the refresh token. Every refresh returns a new pair (rotation). The
  presented refresh token stays usable until the newer one is used, a new token is
  obtained by exchange, 30 days after first use, or its own 90-day expiry. Shopify
  keeps one current expiring offline token per app and store. Do not acquire and
  refresh concurrently for the same shop (Baton's `recoverRefreshRace` exists for
  this).
- Expired, replaced, or invalid refresh token → `401 {"error":"invalid_request"}`; the
  merchant must open the app so a new exchange can happen.

**Token exchange** (`shopify-docs/…/implement-token-exchange.md`,
`shopify-api/lib/auth/oauth/token-exchange.ts`,
`shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts`)

- The browser sends the App Bridge ID token as `Authorization: Bearer`; the backend
  verifies it and POSTs `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
  with `subject_token=<id token>` and
  `requested_token_type=…:offline-access-token`, `expiring=1`.
- A stale ID token gets `400` from Shopify; the app answers `401` with
  `X-Shopify-Retry-Invalid-Session-Request` and App Bridge retries once with a fresh
  token.
- The resulting offline token is explicitly for use with no browser present:
  "background jobs, webhooks, and scheduled work". The tutorial's own background
  `/refresh` route authenticates its caller with a shared secret and passes `shop`
  directly. That is the shape Baton's member path already has, with the better-auth
  cookie in place of the shared secret.

**The ID token** (`shopify-docs/…/id-tokens.md`,
`docs/api/app-home/latest/apis/authentication-and-data/id-token-api.md`)

- An OpenID Connect ID token (the docs' new name for "session token"): HS256 JWT
  signed with the client secret; `aud` is the client id, `dest`/`iss` name the shop,
  `sub` is the staff user, `sid` a per-user-per-app session id. Expires one minute
  after issue; fetch per request, never cache.
- Only App Bridge mints one (`shopify.idToken()` in App Home, `auth.idToken()` in admin
  UI extensions). Standalone apps outside the admin cannot get one and use the
  authorization-code grant instead. Nothing Baton's member area could do produces an
  ID token, which is why the member socket cannot reuse the merchant gate.

**Requests that do not come from Shopify**
(`shopify-app-react-router/src/server/unauthenticated/admin/factory.ts`,
`src/server/types.ts` around line 401)

- `authenticate.admin` with no token on a document request redirects to the App
  Bridge bounce page; on an XHR it returns `401` with the retry header.
- `unauthenticated.admin(shop)` does no request authentication at all: it loads the
  stored offline session for the shop, refreshes it when within five minutes of expiry
  and a refresh token exists, and throws `SessionNotFoundError` if there is none. The
  library documents it as the way to serve "requests that do not originate from
  Shopify" after the app has authenticated the caller itself. Baton's
  `ensureShopSession` is the same function in Effect form.

**Apps with their own users.** Not found. No doc in the refs discusses a separate,
non-Shopify login for merchant-facing apps; the only sanctioned path for a request
Shopify did not originate is the one above. Rate limits (`shopify-docs/docs/api/usage/limits.md`)
are per app and store, leaky bucket by query cost; nothing is per end user, so member
traffic shares the shop's bucket with webhooks and the sync.
