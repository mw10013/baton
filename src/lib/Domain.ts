import { Match, Option, Schema, SchemaGetter, Struct } from "effect";

const SqliteBoolean = Schema.Number.pipe(
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

/**
 * The plan handles Shopify may report for an active App Pricing contract.
 *
 * Four handles, two tiers: the `-test` variants are private plans restricted to
 * named development stores, which is the only mechanism Shopify offers for
 * limiting a plan to specific shops. They are the same product tier as their
 * public counterparts, so the split never reaches business logic — it stops at
 * {@link planOfHandle}.
 *
 * The allowlist is total and identical in every environment: a handle outside
 * it means the catalog changed under us, which must resolve to no access rather
 * than a guess.
 *
 * No plan exists in Partners yet — `BILLING_ENABLED` is `false`, so
 * `SubscriptionPlan` short-circuits every shop to `DEFAULT_PLAN_HANDLE` and
 * these literals are never matched against a real contract. Rename them to the
 * real handles before flipping that var on.
 */
export const PlanHandle = Schema.Literals([
  "baton-basic",
  "baton-pro",
  "baton-basic-test",
  "baton-pro-test",
]);
export type PlanHandle = typeof PlanHandle.Type;

/**
 * The handle every shop is granted while `BILLING_ENABLED` is `false`. The
 * widest tier, so a disabled billing gate never doubles as a hidden
 * entitlement cut.
 */
export const DEFAULT_PLAN_HANDLE: PlanHandle = "baton-pro";

export const Plan = Schema.Literals(["basic", "pro"]);
export type Plan = typeof Plan.Type;

/**
 * Normalization, not entitlement. The mapping exists so nothing downstream has
 * to learn about Shopify's four-handle catalog; what each tier *grants* is
 * {@link entitlementsOfPlan}.
 */
export const planOfHandle = (handle: PlanHandle): Plan =>
  handle === "baton-pro" || handle === "baton-pro-test" ? "pro" : "basic";

export interface Entitlements {
  readonly dailyActionLimit: number;
}

/**
 * What each tier grants. The Worker owns this table and the Durable Object
 * never sees it: every limit reaches `ShopAgent` as a required RPC argument
 * resolved from D1 at that moment, so an upgrade grants headroom on the very
 * next action and a downgrade tightens on the very next action, with nothing
 * to invalidate and no plan state in the object to fall out of sync.
 *
 * Passing the integer rather than the plan handle is what keeps that true: a
 * handle would put this table inside the DO, duplicating the catalog and
 * pushing an unrecognized-handle failure deep inside a SQLite transaction.
 *
 * `satisfies Record<Plan, Entitlements>` makes the lookup total by
 * construction — a new `Plan` literal fails to compile here.
 *
 * `dailyActionLimit` is a placeholder: the skeleton displays it and enforces
 * nothing. Whatever the real product meters goes here, and the enforcement
 * site passes it into the Durable Object per call.
 *
 * Raising a limit is always safe; lowering one is not, if the eventual
 * comparison is per-call with no grandfathering: a cut applies to existing
 * shops immediately.
 */
const ENTITLEMENTS = {
  basic: { dailyActionLimit: 2000 },
  pro: { dailyActionLimit: 10_000 },
} as const satisfies Record<Plan, Entitlements>;

export const entitlementsOfPlan = (plan: Plan): Entitlements =>
  ENTITLEMENTS[plan];

/**
 * The widest tier, for callers that need a ceiling rather than a particular
 * shop's grant — e.g. a local-only e2e fixture with no merchant and no plan to
 * resolve.
 */
export const MAX_ENTITLEMENTS: Entitlements = ENTITLEMENTS.pro;

export const PlanStatus = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Subscribed"),
    handle: PlanHandle,
    plan: Plan,
  }),
  Schema.Struct({ _tag: Schema.Literal("Unsubscribed") }),
]);
export type PlanStatus = typeof PlanStatus.Type;

/**
 * A resolved App Pricing contract: the one allowlisted plan handle it carries,
 * plus the next scheduled contract boundary as epoch milliseconds.
 *
 * `boundaryAt` collapses two Shopify fields that never coexist —
 * `currentBillingCycle.endTime` is null during a trial, where `trialEndsAt`
 * takes over. Both denote the same thing to a cache: the next instant at which
 * the contract may legitimately change without any notification, since App
 * Pricing sends no webhooks.
 */
export const ActiveSubscription = Schema.Struct({
  handle: PlanHandle,
  boundaryAt: Schema.NullOr(Schema.Number),
});
export type ActiveSubscription = typeof ActiveSubscription.Type;

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
   * `planHandle` is `Schema.String`, deliberately not {@link PlanHandle}: this
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
});
export type ShopSession = typeof ShopSession.Type;

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
 * Deliberately email-keyed with no userId: the owner grants access by adding an
 * email before any better-auth `User` row exists (there is no invite-accept
 * step), so a `User` FK cannot hold. Sign-in is magic-link-only, which makes the
 * email itself the identity; guards match the session user's email against this
 * table. No role column: membership is binary (a row = access) — member
 * management lives only in the embedded app behind Shopify auth, and the member
 * area does not differ per member.
 */
export const Member = Schema.Struct({
  id: Schema.String,
  shop: Shop,
  email: Email,
  createdAt: Schema.String,
});
export type Member = typeof Member.Type;

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
 * The demo counter the skeleton's home page reads and bumps.
 *
 * Its only job is to prove the full write path end to end — browser →
 * WebSocket RPC → Durable Object → its private SQLite → broadcast
 * invalidation → every open tab refetches. Replace it with the real domain;
 * the surrounding machinery is what is meant to survive.
 */
export const Counter = Schema.Struct({
  count: Schema.Number,
  updatedAt: Schema.NullOr(Schema.Number),
});
export type Counter = typeof Counter.Type;

/**
 * What the Durable Object reads back from the Shopify Admin API using the
 * shop's offline session. Exists to prove that path end to end — D1 session
 * lookup, token refresh if due, Admin GraphQL, schema decode — from inside the
 * object rather than from a Worker request.
 */
export const ShopInfo = Schema.Struct({
  name: Schema.String,
  myshopifyDomain: Schema.String,
});
export type ShopInfo = typeof ShopInfo.Type;

/**
 * Which ingestion path last wrote a `ShopOrder` row. Diagnostic, not control
 * flow: every path runs the same guarded upsert, so the value only answers
 * "how did this row get here" while the policies in
 * `docs/shop-agent-orders-sync-research.md` are still being decided.
 */
export const OrderSyncSource = Schema.Literals(["webhook", "bulk", "manual"]);
export type OrderSyncSource = typeof OrderSyncSource.Type;

/**
 * A Shopify `DateTime` (ISO 8601) as the epoch milliseconds every stored
 * timestamp uses, matching `Counter.updatedAt` and `ShopSession.*ExpiresAt`.
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

/** Shopify's `Attribute` — order `customAttributes` and line-item personalization. */
export const OrderAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.NullOr(Schema.String),
});
export type OrderAttribute = typeof OrderAttribute.Type;

/**
 * One order in the shop's Durable Object SQLite. Encoded side is the row
 * (epoch-ms integers, `0`/`1` booleans, JSON text); decoded side is what the
 * page renders.
 *
 * Deliberately carries no customer identity: no `customer`, `shippingAddress`,
 * email, or phone. Baton is a production-floor view, so the buyer never needs
 * naming, and staying off those fields keeps the app clear of Level 2 protected
 * customer data. `note` and `customAttributes` stay because they carry the
 * personalization text a maker works from.
 *
 * `financialStatus` is nullable because `Order.displayFinancialStatus` is —
 * `displayFulfillmentStatus` is the non-null one of the pair.
 *
 * The `raw` column is not part of this shape: it exists so a new order-level
 * field can be promoted to a column via `json_extract` without a resync, and
 * nothing renders it. Both ingestion paths write the same thing there — the
 * order node's own fields, never its line items — because the bulk NDJSON
 * flattens connections onto separate lines and would otherwise produce a
 * differently-shaped blob for the same order.
 */
export const ShopOrder = Schema.Struct({
  id: Schema.String,
  legacyId: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  processedAt: Schema.Number,
  updatedAt: Schema.Number,
  cancelledAt: Schema.NullOr(Schema.Number),
  closedAt: Schema.NullOr(Schema.Number),
  financialStatus: Schema.NullOr(Schema.String),
  fulfillmentStatus: Schema.String,
  fullyPaid: SqliteBoolean,
  tags: Schema.fromJsonString(Schema.Array(Schema.String)),
  note: Schema.NullOr(Schema.String),
  customAttributes: Schema.fromJsonString(Schema.Array(OrderAttribute)),
  /**
   * Whether the stored line-item set is the whole set. False only when a
   * single-order fetch hit `ORDER_SYNC_LINE_ITEMS` and reported another page,
   * in which case the write merges instead of replacing so the unseen tail is
   * not deleted. The bulk path is always complete — flattened connections are
   * not paginated.
   */
  lineItemsComplete: SqliteBoolean,
  syncedAt: Schema.Number,
  syncSource: OrderSyncSource,
});
export type ShopOrder = typeof ShopOrder.Type;

/**
 * `productTags` is a **snapshot** taken at sync time, not a live read: a
 * resync overwrites it. Once tag-based routing exists, the routing row must
 * copy the tags it actually matched, so that a merchant retagging a product
 * cannot silently rewrite history.
 */
export const OrderLineItem = Schema.Struct({
  id: Schema.String,
  orderId: Schema.String,
  productId: Schema.NullOr(Schema.String),
  variantId: Schema.NullOr(Schema.String),
  title: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  sku: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  currentQuantity: Schema.Number,
  unfulfilledQuantity: Schema.Number,
  nonFulfillableQuantity: Schema.Number,
  productTags: Schema.fromJsonString(Schema.Array(Schema.String)),
  customAttributes: Schema.fromJsonString(Schema.Array(OrderAttribute)),
  requiresShipping: SqliteBoolean,
});
export type OrderLineItem = typeof OrderLineItem.Type;

export const OrderDetail = Schema.Struct({
  order: ShopOrder,
  lineItems: Schema.Array(OrderLineItem),
});
export type OrderDetail = typeof OrderDetail.Type;

/**
 * The single `SyncState` row: the reservation held while a window sync is in
 * flight, plus what the last one achieved.
 *
 * `workflowId` non-null *is* the "a sync is running" flag, and it is written
 * before `runWorkflow` is called rather than after. The Agents SDK creates the
 * Cloudflare instance and only then inserts its tracking row, two steps that
 * cannot be one transaction; reserving first means a throw between them leaves
 * a claim we can verify against `status()` instead of a running workflow with
 * a re-enabled button in front of it.
 *
 * `startedAt` doubles as the run's identity. Workflow completion callbacks
 * carry it back, so a late callback from a superseded run cannot clear a newer
 * reservation.
 */
export const SyncState = Schema.Struct({
  workflowId: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.Number),
  lastFullSyncAt: Schema.NullOr(Schema.Number),
  lastFullSyncWindowStart: Schema.NullOr(Schema.Number),
  lastError: Schema.NullOr(Schema.String),
});
export type SyncState = typeof SyncState.Type;

/**
 * Keyset cursor over `(processedAt desc, id desc)`, encoded as
 * `<processedAt>:<id>`. Not an offset: the bulk stream and webhooks both insert
 * while a merchant pages, and `limit/offset` would drop or repeat rows under
 * those writes.
 */
export const OrdersCursor = Schema.String.check(Schema.isMaxLength(128));

export const GetOrdersInput = Schema.Struct({
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 50 }),
  ),
  cursor: Schema.NullOr(OrdersCursor),
});
export type GetOrdersInput = typeof GetOrdersInput.Type;

export const ResyncOrderInput = Schema.Struct({
  orderId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type ResyncOrderInput = typeof ResyncOrderInput.Type;

export const OrdersPage = Schema.Struct({
  orders: Schema.Array(OrderDetail),
  limit: Schema.Number,
  nextCursor: Schema.NullOr(OrdersCursor),
  orderCount: Schema.Number,
});
export type OrdersPage = typeof OrdersPage.Type;

/**
 * A Shopify bulk operation as the sync workflow observes it.
 *
 * `objectCount` and `fileSize` are `UnsignedInt64`, which Shopify serializes as
 * a string in some responses and a number in others; both are accepted rather
 * than guessing, and the value is only ever logged or compared against zero.
 *
 * Crosses a `step.do` boundary, so every field must survive JSON.
 */
export const BulkOperationStatus = Schema.Literals([
  "CANCELED",
  "CANCELING",
  "COMPLETED",
  "CREATED",
  "EXPIRED",
  "FAILED",
  "RUNNING",
]);
export type BulkOperationStatus = typeof BulkOperationStatus.Type;

export const BulkOperation = Schema.Struct({
  id: Schema.String,
  status: BulkOperationStatus,
  errorCode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
  objectCount: Schema.Union([Schema.Number, Schema.String]),
  fileSize: Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
  url: Schema.NullOr(Schema.String),
  partialDataUrl: Schema.NullOr(Schema.String),
});
export type BulkOperation = typeof BulkOperation.Type;

/**
 * Which timestamp the window sync filters on. The first run has nothing stored
 * and asks for orders *placed* in the window; every later run asks for orders
 * *touched* since the last one, which also picks up an old order that was just
 * edited — exactly the reconciliation Shopify recommends webhooks be backed by.
 */
export const OrderSyncField = Schema.Literals(["created_at", "updated_at"]);
export type OrderSyncField = typeof OrderSyncField.Type;

/**
 * What `step.reportComplete` carries back to the agent. `startedAt` identifies
 * the run so `completeSync` cannot release a reservation a later run took out.
 * Crosses a workflow callback boundary as JSON, hence the re-decode.
 */
export const OrdersSyncResult = Schema.Struct({
  shop: Schema.String,
  startedAt: Schema.Number,
});
export type OrdersSyncResult = typeof OrdersSyncResult.Type;

/** Everything `/app/orders` renders, in one socket round trip. */
export const OrdersView = Schema.Struct({
  page: OrdersPage,
  syncState: SyncState,
});
export type OrdersView = typeof OrdersView.Type;

export interface HomeLoaderData {
  readonly counter: Counter;
  readonly plan: Plan;
  readonly entitlements: Entitlements;
}

/**
 * Everything the admin drill-down reads out of one shop's Durable Object, in a
 * single RPC.
 *
 * Stored rows only — no limits: the ceilings these would be displayed against
 * derive from the shop's plan, which lives in D1, so the route's server
 * function attaches them. An admin page that echoed a limit back out of the
 * object would be reporting the object's guess rather than the plan's grant.
 */
export const AdminShopAgentSnapshot = Schema.Struct({
  counter: Counter,
});
export type AdminShopAgentSnapshot = typeof AdminShopAgentSnapshot.Type;

/**
 * Why the shop's cached plan entry reads the way it does.
 *
 * Deliberately finer-grained than `SubscriptionPlan`'s internal `cachedStatus`,
 * which collapses every reason for distrusting the entry into a single
 * `Option.none()` and revalidates. That is the right shape for the enforcement
 * path, which only needs to know *whether* to call Shopify; it is the wrong
 * shape for an admin diagnosing why a shop is being treated the way it is,
 * where "never fetched", "expired an hour ago", and "handle this build no
 * longer recognizes" have three different remedies.
 *
 * `Unrecognized` is the case the `ShopSession.planHandle` column exists in its
 * `Schema.String` form to survive, so the admin page shows the stored string
 * rather than hiding it behind a decode failure.
 */
export type AdminShopPlanCache =
  | { readonly _tag: "NeverFetched" }
  | { readonly _tag: "Unsubscribed" }
  | {
      readonly _tag: "Subscribed";
      readonly handle: PlanHandle;
      readonly plan: Plan;
    }
  | { readonly _tag: "Stale"; readonly handle: string | null }
  | { readonly _tag: "Unrecognized"; readonly handle: string };

export const adminShopPlanCache = (
  {
    planHandle,
    planHandleExpiresAt,
  }: Pick<ShopSessionRedacted, "planHandle" | "planHandleExpiresAt">,
  now: number,
): AdminShopPlanCache => {
  if (planHandleExpiresAt === null)
    return planHandle === null
      ? { _tag: "NeverFetched" }
      : { _tag: "Stale", handle: planHandle };
  if (now >= planHandleExpiresAt) return { _tag: "Stale", handle: planHandle };
  if (planHandle === null) return { _tag: "Unsubscribed" };
  return Option.match(Schema.decodeUnknownOption(PlanHandle)(planHandle), {
    onNone: (): AdminShopPlanCache => ({
      _tag: "Unrecognized",
      handle: planHandle,
    }),
    onSome: (handle) => ({
      _tag: "Subscribed",
      handle,
      plan: planOfHandle(handle),
    }),
  });
};

/**
 * What the cached entry grants, or `null` when it grants nothing. Every
 * non-`Subscribed` state — including `Stale`, which may well hold a handle —
 * yields `null` rather than the handle's tier: a deadline that has passed is
 * exactly the case where the stored handle is not evidence of anything, and an
 * admin page must not render a ceiling the enforcement path would refuse to
 * honor.
 */
export const adminShopEntitlements = Match.typeTags<
  AdminShopPlanCache,
  Entitlements | null
>()({
  Subscribed: ({ plan }) => entitlementsOfPlan(plan),
  Unsubscribed: () => null,
  Stale: () => null,
  NeverFetched: () => null,
  Unrecognized: () => null,
});

export type AdminShopLoaderData =
  | { readonly _tag: "NotFound" }
  | {
      readonly _tag: "Found";
      readonly shopSession: ShopSessionRedacted;
      readonly plan: AdminShopPlanCache;
      readonly entitlements: Entitlements | null;
      readonly derivedShopAgentId: string;
      readonly snapshot: AdminShopAgentSnapshot;
    };

/**
 * Per-connection attachment: the mount-scoped `sessionToken` that guards a
 * stale `deactivate` from a previous route mount on the same shared socket.
 * A connection with no attachment receives no pushes — attaching is what
 * subscribes a tab to invalidations.
 *
 * The struct exists rather than a bare boolean because this is the seam where
 * per-connection subscription detail goes (which records a tab is watching,
 * which filters it has applied); the skeleton keeps the shape and carries only
 * the guard.
 */
export const ConnectionState = Schema.Struct({
  sessionToken: Schema.String,
});
export type ConnectionState = typeof ConnectionState.Type;

export const ConnectionAttachment = Schema.NullOr(ConnectionState);

export const SessionTokenInput = Schema.Struct({
  sessionToken: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type SessionTokenInput = typeof SessionTokenInput.Type;

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
