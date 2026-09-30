/**
 * Vocabulary, platform. The dialect, not a context: the technical words
 * every context uses; no model of the business.
 *
 * Nouns, platform. "(none)" means no screen says the word; the
 * cell says what a screen shows instead:
 *
 * | word    | meaning                                                                                                | symbol                | screen                                                  |
 * | ------- | ------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------- |
 * | shop    | one Shopify store, the tenant                                                                          | `ShopSession`, `Shop` | store (Shopify's merchant word); its domain as the name |
 * | ceiling | a per-shop limit the object enforces: `maxOpenRuns`, `maxOrdersPerCycle`, `maxMembers` on `ShopLimits` | `ShopLimits`          | the banner that names what stopped                      |
 */
import { Schema, SchemaGetter, Struct } from "effect";

export const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((n) => n === 1),
    encode: SchemaGetter.transform((b) => (b ? 1 : 0)),
  }),
);

export const Shop = Schema.NonEmptyString.pipe(Schema.brand("Shop"));
export type Shop = typeof Shop.Type;

export const ShopGid = Schema.NonEmptyString.pipe(Schema.brand("ShopGid"));
export type ShopGid = typeof ShopGid.Type;

export const ShopAgentId = Schema.NonEmptyString.pipe(
  Schema.brand("ShopAgentId"),
);
export type ShopAgentId = typeof ShopAgentId.Type;

export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

export const ShopSession = Schema.Struct({
  shop: Shop,
  shopGid: ShopGid,
  shopAgentId: ShopAgentId,
  scope: Schema.NullOr(Schema.String),
  accessTokenExpiresAt: Schema.NullOr(Schema.Number),
  accessToken: Schema.NullOr(Schema.String),
  refreshToken: Schema.NullOr(Schema.String),
  refreshTokenExpiresAt: Schema.NullOr(Schema.Number),
  /**
   * Cached plan handle and the instant that cache entry stops being fresh.
   *
   * `planHandle` is `Schema.String`, deliberately not `PlanHandle` in Billing: this
   * schema decodes every `ShopSession` row on the authentication path, so a stored
   * handle that falls outside the allowlist — after a catalog change, a rename,
   * or a rollback — must degrade to a cache miss, never to a row that fails to
   * decode and takes admin authentication down with it. Validation happens when
   * the handle is read as a plan, not when the row is loaded.
   *
   * Both null on insert, which reads as "never fetched" and forces a
   * revalidation on first access. A null `planHandle` under a future
   * `planHandleExpiresAt` is the distinct case of a verified absence of any
   * subscription.
   */
  planHandle: Schema.NullOr(Schema.String),
  planHandleExpiresAt: Schema.NullOr(Schema.Number),
  /**
   * The app subscription's boundary, cached beside the handle and written only
   * by `Repository.updateShopSessionPlan`, so a cache hit answers "when does
   * this expire" without a second Partner call. Null means none or unknown, and
   * it is only meaningful while `planHandleExpiresAt` is in the future — a
   * stale row's date is as untrustworthy as its handle. The cycle start is not
   * cached: nothing reads it off the row.
   */
  planBoundaryAt: Schema.NullOr(Schema.Number),
});
export type ShopSession = typeof ShopSession.Type;

/**
 * A `ShopSession` as the authentication path knows it: everything except the
 * plan cache columns, which `Repository.updateShopSessionPlan` owns alone.
 *
 * A named schema rather than an inline omit because two places have to agree
 * about the boundary — the decode in `Shopify.ts` that turns a library session
 * into a row, and `upsertShopSession`'s parameter — and the whole reason the
 * split exists is that re-authentication must not disturb a cached plan.
 */
export const ShopSessionUpsert = Schema.Struct(
  Struct.omit(ShopSession.fields, [
    "planHandle",
    "planHandleExpiresAt",
    "planBoundaryAt",
  ]),
);
export type ShopSessionUpsert = typeof ShopSessionUpsert.Type;

export const ShopSessionRedacted = Schema.Struct({
  ...Struct.omit(ShopSession.fields, ["accessToken", "refreshToken"]),
  hasAccessToken: SqliteBoolean,
  hasRefreshToken: SqliteBoolean,
});
export type ShopSessionRedacted = typeof ShopSessionRedacted.Type;

/**
 * Normalization is structural: decoding trims and lowercases, so an
 * un-normalized `Email` value cannot be constructed. Membership, the magic-link
 * sign-in gate, and the member-area guard all compare emails across systems
 * (D1 `Member` rows vs the better-auth session email), and better-auth is not
 * trusted to lowercase — every boundary decodes through this schema instead.
 * Deliberately not handled: provider aliasing (Gmail dots/plus) and
 * unicode/IDN domains — distinct strings are distinct members.
 */
export const Email = Schema.String.pipe(
  Schema.decodeTo(Schema.NonEmptyString.pipe(Schema.brand("Email")), {
    decode: SchemaGetter.transform((s) => s.trim().toLowerCase()),
    encode: SchemaGetter.transform((s) => s),
  }),
);
export type Email = typeof Email.Type;

export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

/**
 * Mirrors the FK-backed `UserRole` lookup table in `migrations/0001_init.sql`
 * and better-auth 1.7.2's admin-plugin defaults: without custom access control
 * only `user`/`admin` exist. `admin` = site operators (us) once `/admin`
 * migrates onto better-auth in phase 2; per-shop access is always a `Member`
 * row, never a role.
 */
export const UserRole = Schema.Literals(["user", "admin"]);
export type UserRole = typeof UserRole.Type;

/**
 * The one rule on {@link UserRole}: an admin is a site operator and lives
 * under `/admin`; everyone else is a member and lives under `/shop`. The
 * Worker gate, both server-fn middlewares and the sign-in callback all
 * decide with this and nothing else; per-shop access is a `Member` row.
 */
export const userIsAdmin = (user: { readonly role?: string | null }) =>
  user.role === "admin";

/**
 * A `User` row: encoded side is the D1 row (ISO text dates, 0/1 booleans),
 * decoded side the branded domain shape. Better-auth's `getSession` returns
 * the decoded side already (its adapter coerced the row), so the auth boundary
 * validates through `Schema.toType(User)` instead of re-running these
 * transforms.
 */
export const User = Schema.Struct({
  id: UserId,
  name: Schema.String,
  email: Email,
  emailVerified: SqliteBoolean,
  image: Schema.NullishOr(Schema.String),
  role: UserRole,
  banned: SqliteBoolean,
  banReason: Schema.NullishOr(Schema.String),
  banExpires: Schema.NullishOr(Schema.DateFromString),
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
});
export type User = typeof User.Type;

export const AuthSession = Schema.Struct({
  id: SessionId,
  expiresAt: Schema.DateFromString,
  token: Schema.NonEmptyString,
  createdAt: Schema.DateFromString,
  updatedAt: Schema.DateFromString,
  ipAddress: Schema.NullishOr(Schema.String),
  userAgent: Schema.NullishOr(Schema.String),
  userId: UserId,
  impersonatedBy: Schema.NullishOr(UserId),
});
export type AuthSession = typeof AuthSession.Type;

export interface SessionContext {
  readonly user: User;
  readonly session: AuthSession;
}

export const LoginInput = Schema.Struct({ email: Email });
export type LoginInput = typeof LoginInput.Type;

/**
 * Arbitrary ceilings, enforced in the schemas below and re-checked by
 * `WorkflowRepository` before every insert, so the Durable Object never stores
 * an oversize row and the reorder UI stays a short list. Raise freely; they
 * exist so `position` loops are bounded, not to model a plan tier.
 */
export const WorkflowLimits = {
  maxWorkflows: 50,
  maxTasks: 20,
} as const;

/**
 * Plan-independent ceilings and retention windows for one shop's Durable
 * Object, and the batch sizes the sweeps that enforce them run at.
 *
 * Provisional in exactly the sense `Entitlements` in Billing is: working proposals,
 * nothing measured. Unlike an entitlement these are not a product promise — a
 * merchant never sees them unless something has gone wrong — so they exist to
 * bound the object's storage and per-request row counts, not to price a tier.
 */
export const ShopLimits = {
  /** `Team` rows per shop. */
  maxTeams: 25,
  /** `Run` rows that are `runIsOpen` in Production per shop; a safety valve, not a product limit. A `done` run still holds its item but no longer counts here. */
  maxOpenRuns: 5000,
  /** `ShopUsage.ordersThisCycle` in Billing at which syncing of *new* orders stops for the rest of the cycle. Provisional; enterprise fencing, not a tier — see `cycleAtOrderCeiling` in Billing. */
  maxOrdersPerCycle: 100,
  /** Members per shop on any plan; see `membersAtCeiling` in Billing. Provisional; enterprise fencing, not a tier. */
  maxMembers: 12,
  /** Line items kept per order on the bulk path; the rest are dropped and the order flagged. */
  maxLineItemsPerOrder: 250,
  /**
   * An order whose `processedAt` is older than this is deleted on the next
   * sweep, open or closed, with or without runs; its runs go with it, deleted
   * in the same transaction and not flagged first, because a flag on a row
   * the next statement deletes is read by nobody. An expired order is also
   * never stored again: `OrderRepository.upsertOrder` refuses a new row for
   * one, since a webhook for a year-old order would otherwise bring it back
   * with no `countedAt`, and its first run would count it a second time.
   * Both sites read the cutoff from {@link retentionCutoff}. Baton is a
   * working set, not an archive — Shopify keeps every order — so one rule
   * replaces asking what "closed" or "untouched" means.
   *
   * The sweep rides the import and, at most every {@link
   * ShopLimits.sweepIntervalMs}, the webhook path. There is no alarm: a shop
   * receiving no webhooks is not growing, and an alarm would add a schedule,
   * a test surface and a failure mode for a shop that has stopped trading.
   */
  orderRetentionDays: 365,
  /** `WebhookDelivery` rows older than this are deleted; Shopify retries for at most 4 hours. */
  webhookDeliveryRetentionDays: 7,
  /** An expired usage event (`usageEventIsExpired` in Billing) dated longer ago than this is deleted by the retention sweep; `OrderRepository.sweepExpiredOrders` says why 60. */
  expiredUsageEventRetentionDays: 60,
  /** `syncOrders` refuses to start a bulk import when the object's SQLite is past this. */
  storageSoftLimitBytes: 2_000_000_000,
  /** Rows deleted per sweep pass, so no carrier request pays for more than this. */
  sweepBatch: 200,
  /** Minimum gap between retention passes triggered from the webhook path. */
  sweepIntervalMs: 6 * 60 * 60 * 1000,
} as const;

/**
 * The `processedAt` below which an order has expired at `now`
 * ({@link ShopLimits.orderRetentionDays} is the rule). The sweep deletes
 * orders under it and `upsertOrder` refuses to insert one.
 */
export const retentionCutoff = (now: number) =>
  now - ShopLimits.orderRetentionDays * 86_400_000;

export const BoundedId = Schema.NonEmptyString.check(Schema.isMaxLength(128));

export const ShopSessionRedactedPage = Schema.Struct({
  shopSessions: Schema.Array(ShopSessionRedacted),
  limit: Schema.Number,
  startCursor: Schema.NullOr(Schema.String),
  endCursor: Schema.NullOr(Schema.String),
  hasPreviousPage: Schema.Boolean,
  hasNextPage: Schema.Boolean,
});
export type ShopSessionRedactedPage = typeof ShopSessionRedactedPage.Type;

/**
 * A Shopify `DateTime` (ISO 8601) as the epoch milliseconds every stored
 * timestamp uses, matching `ShopSession.*ExpiresAt`.
 *
 * Routed through {@link Schema.DateFromString}, whose target rejects an
 * invalid `Date`, so an unparseable timestamp fails the decode rather than
 * storing `NaN` — which would silently defeat the `updatedAt` upsert guard
 * that makes the webhook and bulk paths safe to interleave.
 */
export const EpochMillis = Schema.DateFromString.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((date) => date.getTime()),
    encode: SchemaGetter.transform((millis) => new Date(millis)),
  }),
);

/**
 * The subscribe pattern — the socket half of the loader-versus-socket rule on
 * `ShopAgentClient`, for a page whose data other actors change underneath it.
 * One cycle, named the same on both sides:
 *
 * 1. **Subscribe.** The page's read is a `subscribe<Feature>` RPC on
 *    `ShopAgent` (`subscribeOrders`, `subscribeOrder`) that returns the page's data
 *    *and* stores this `Subscription` as the connection's state, in one round
 *    trip so a write between two calls cannot be missed. Each has a plain
 *    twin without the subscription (`listOrders`, `getOrderDetail`) that the
 *    route loader reads through `ShopAgentClient` for SSR paint. The page
 *    calls the RPC through `useSubscribedQuery`, which owns the client half.
 * 2. **Publish.** A write on the object ends with `ShopAgent.publish`, which
 *    sends `InvalidatedMessage` to every connection whose subscription the
 *    write touched — a hint that the data is stale, never the new value.
 * 3. **Invalidate.** The hook decodes the message and invalidates its query
 *    (throttled), which re-runs the `subscribe<Feature>` read and so also
 *    renews the subscription.
 * 4. **Unsubscribe.** On unmount the hook calls `unsubscribe` with its
 *    `subscriberId`; the object clears the state only if the id still
 *    matches, so a stale unsubscribe from a previous mount on the same shared
 *    socket cannot clear a newer mount's subscription. A reconnect is a fresh
 *    connection with no subscription, which is why the hook re-subscribes on
 *    every identify.
 *
 * A connection with no subscription receives nothing. A socket `useQuery`
 * outside this cycle is a mistake — it never refetches — and belongs on a
 * loader instead.
 *
 * `orderId` is the subscription's scope: `null` is the orders index, which
 * wants every order-state change; a GID is one detail page, which wants only
 * its own order. `publish` takes the set of orders a write touched (or `"all"`
 * for the bulk sync and for the run mutations, whose repository does not
 * report the order yet) and skips a detail subscription whose order is not in
 * it. Only order state is ever published — workflow configuration is loader
 * data and changes on navigation.
 */
export const Subscription = Schema.Struct({
  subscriberId: Schema.String,
  orderId: Schema.NullOr(Schema.String),
});
export type Subscription = typeof Subscription.Type;

export const SubscriptionState = Schema.NullOr(Subscription);

/**
 * Who is on a `ShopAgent` WebSocket connection. Two populations reach the
 * object over the same socket and must not reach the same methods:
 * **merchants** (Shopify staff inside the embedded admin, proved by an App
 * Bridge session token) and **members** (a Baton login with no Shopify
 * account, proved by a better-auth cookie). Only the Worker can tell them
 * apart — the object never sees a cookie or a token — so the Worker's connect
 * gate resolves identity once and forwards it as `x-baton-*` headers on the
 * rewritten upgrade request; `ShopAgent.onConnect` decodes those headers into
 * this value and stores it with the connection.
 *
 * Read from the connection, never from a message: a callable's arguments are
 * browser-supplied, and `memberId` / `teamIds` are exactly the privileged
 * inputs a member must not be able to name for themselves. Every `@callable()`
 * checks the role here first (see `callableEffect` on `ShopAgent`).
 *
 * Identity is a connect-time snapshot, persisted with the hibernatable socket
 * (`serializeAttachment`), so it survives the object hibernating but does not
 * follow later team edits. Those edits close the affected member connections
 * (`ShopAgent.revokeMemberConnections`) and the reconnect re-runs the gate;
 * Cloudflare's ~300s idle close is the backstop, as it already is for the
 * merchant subscription check.
 *
 * {@link Subscription} moves inside this value rather than being the whole
 * connection state: a subscribe must not be able to erase the identity that
 * authorizes it, so the subscribe sites write `{ ...state, subscription }`.
 */
export const ConnectionRole = Schema.Literals(["merchant", "member"]);
export type ConnectionRole = typeof ConnectionRole.Type;

/**
 * The headers the Worker's connect gate writes onto the request it forwards to
 * the object, and the only channel by which identity crosses that boundary.
 * Named here so the gate and `ShopAgent.onConnect` cannot drift apart.
 *
 * `teamIds` is comma-separated because a header is a string and a team id is a
 * ULID-shaped token with no commas in it.
 */
export const CONNECTION_ROLE_HEADER = "x-baton-role";
export const CONNECTION_MEMBER_ID_HEADER = "x-baton-member-id";
export const CONNECTION_MEMBER_EMAIL_HEADER = "x-baton-member-email";
export const CONNECTION_TEAM_IDS_HEADER = "x-baton-team-ids";

/**
 * Close codes the object sends on a connection it will not serve. Both are in
 * the 4000-4999 application range, so the browser sees them verbatim.
 *
 * `4403` is a gate failure: the forwarded request carried no decodable
 * identity, which can only mean the Worker forwarded something malformed (a
 * browser cannot set these headers on an upgrade). `4401` is revocation: what
 * the gate answered at connect no longer holds — the member's teams or
 * membership changed, or the shop's subscription lapsed — so the snapshot on
 * the connection is stale and the client must reconnect through the gate,
 * which now gives the current answer (a new identity, `404`, or `402`).
 */
export const CONNECTION_CLOSE_FORBIDDEN = 4403;
export const CONNECTION_CLOSE_REVOKED = 4401;

/**
 * The member ids whose open sockets a membership change has invalidated. Plain
 * RPC input — the Worker sends it after its own D1 write, and no browser can
 * reach it.
 */
export const RevokeMemberConnectionsInput = Schema.Struct({
  memberIds: Schema.Array(BoundedId),
});
export type RevokeMemberConnectionsInput =
  typeof RevokeMemberConnectionsInput.Type;

export const SubscriberIdInput = Schema.Struct({
  subscriberId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type SubscriberIdInput = typeof SubscriberIdInput.Type;

/**
 * The one server push: "your loader data is stale, refetch". Deliberately not
 * the new value — the Durable Object never learns what any tab is rendering,
 * and a refetch re-runs the same authenticated loader the tab already trusts.
 */
export const InvalidatedMessage = Schema.Struct({
  type: Schema.Literal("invalidated"),
});
export type InvalidatedMessage = typeof InvalidatedMessage.Type;

export const AgentMessage = InvalidatedMessage;
export type AgentMessage = typeof AgentMessage.Type;

/**
 * Keep-alive frame pair for the `/app` ShopAgent WebSocket. The client pings
 * under the edge's ~300s idle-close window (`SOCKET_KEEPALIVE_MS`,
 * `ShopAgentContext.tsx`); the Durable Object registers the pair via
 * `ctx.setWebSocketAutoResponse` (`ShopAgent.ts`), so the Cloudflare runtime
 * answers without waking a hibernated object or billing duration
 * (refs/cloudflare-docs/src/content/partials/durable-objects/durable-objects-pricing.mdx)
 * and the ping never reaches `webSocketMessage`. Shared here because both
 * sides must agree byte-for-byte: a mismatch fails silently — no pong, so the
 * socket degrades to the pre-keepalive ~5-minute edge-close reconnect cycle.
 */
export const SocketKeepalivePing = "ping";
export const SocketKeepalivePong = "pong";
