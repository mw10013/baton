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
 * | ceiling | a per-shop limit the object enforces: `maxOpenOrders`, `maxMembers` on `ShopLimits` | `ShopLimits`          | the banner that names what stopped                      |
 * | memo    | a list read's last answer, kept in the object's memory until the next publish | the Cache values in ShopWorkAgent | (none)                                                  |
 * | socket       | a tab's one WebSocket to its shop's object, for the life of the tab; a series of connections                                                | `ShopAgentSocket`, `ShopAgentSocketProvider`       | (none): Connecting |
 * | connection   | the object's end of one socket, from identify to close; carries who is on it                                                                | `ConnectionState` in ShopWork, `ConnectionRole`    | (none)             |
 * | identify     | the object learns who is on a connection from the gate's headers, once, at connect; the tab learns the handshake landed                     | `ShopAgent.onConnect`, `identified`                | (none): Connecting |
 * | publish      | a write that succeeded telling every connection to re-read; the sites table on `ShopAgent.publish` lists the writes                         | `ShopAgent.publish`, `ShopAgentHost.publish`       | (none)             |
 * | invalidation | the one message the object sends: re-read; never the data                                                                                   | `InvalidatedMessage`, `INVALIDATION_THROTTLE_MS`   | (none)             |
 * | live         | a screen whose rows other actors change and the object re-reads on every publish: the orders index, the order page, the workflows list, the member's workflow page | `useLiveQuery`                                     | (none)             |
 * | revoke       | the object closing a connection whose identity no longer holds (membership, team, app subscription), so the tab reconnects through the gate | `CONNECTION_CLOSE_REVOKED`, `revokeAllConnections` | (none): Connecting |
 * | displace     | the object closing a member's oldest connection because a newer one took the last of `maxConnectionsPerMember`; the screen stays closed      | `CONNECTION_CLOSE_DISPLACED`, `displaceConnections` | (none): Signed in elsewhere |
 */
import { Schema, SchemaGetter, Struct } from "effect";

/**
 * A count as every screen prints one: digits grouped the en-US way
 * ("1,200"), no fraction. One rule for every number a screen shows, so the
 * orders strip, the quotas and a row's `×n` agree; the row's `×n`
 * ({@link itemPiece}) is the one the domain itself prints.
 */
export const formatNumber = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * A size in bytes as a screen prints it: whole kilobytes of 1,024 bytes,
 * through {@link formatNumber} ("8 KB"). The Limits help page prints
 * {@link ShopLimits.maxPropertiesBytesPerItem} with it.
 */
export const formatKilobytes = (bytes: number) =>
  `${formatNumber(bytes / 1024)} KB`;

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
 * The longest email a member can have: 254 characters, the mail standard's
 * own ceiling (RFC 5321: a path is 256 octets with its angle brackets). The
 * Add member field's `maxLength` reads this. See {@link Email}.
 */
export const EMAIL_MAX_LENGTH = 254;

/** The field error for an address over {@link EMAIL_MAX_LENGTH}. */
export const EMAIL_TOO_LONG = "Enter an email of 254 characters or fewer";

/**
 * Normalization is structural: decoding trims and lowercases, so an
 * un-normalized `Email` value cannot be constructed. Membership, the magic-link
 * sign-in gate, and the member-area guard all compare emails across systems
 * (D1 `Member` rows vs the better-auth session email), and better-auth is not
 * trusted to lowercase — every boundary decodes through this schema instead.
 * Deliberately not handled: provider aliasing (Gmail dots/plus) and
 * unicode/IDN domains — distinct strings are distinct members.
 *
 * An address over {@link EMAIL_MAX_LENGTH} is refused with
 * {@link EMAIL_TOO_LONG}, after the trim, and never truncated: a cut address
 * is a different address, and sign-in would match nobody. The D1 check on
 * `Member.email` refuses the same length, so no row holds one.
 */
export const Email = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(
      Schema.isMaxLength(EMAIL_MAX_LENGTH, { message: EMAIL_TOO_LONG }),
    ).pipe(Schema.brand("Email")),
    {
      decode: SchemaGetter.transform((s) => s.trim().toLowerCase()),
      encode: SchemaGetter.transform((s) => s),
    },
  ),
);
export type Email = typeof Email.Type;

export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

/**
 * Mirrors the FK-backed `UserRole` lookup table in `migrations/0001_init.sql`
 * and better-auth 1.7.7's admin-plugin defaults: without custom access control
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
 * Ceilings on a shop's workflow definitions, checked by `WorkflowRepository`
 * before every insert, and `maxTasks` by `WorkflowTasks` on every read and
 * write of a task list.
 *
 * `maxWorkflows` is a guard against a runaway seed or script, not a product
 * promise and not a plan tier. Nothing that runs per order depends on it:
 * run creation, reconcile, the order page and the orders index's counts all
 * find workflows by an item's tags (the rule on `itemMatches` in ShopWork),
 * so their cost is the same at one workflow or two hundred. Only the
 * workflows index reads every workflow, and it pages.
 *
 * 200 is what the workflows index carries: eight pages of 25 with search. A
 * shop near it has a tag design problem (a workflow per product where one
 * tag would do), not a size problem, so the ceiling stays a guard and is not
 * a reason to page further.
 *
 * `maxTasks` keeps a task list a short document read and written whole, and
 * the editor's reorder a short list.
 */
export const WorkflowLimits = {
  maxWorkflows: 200,
  maxTasks: 20,
} as const;

/**
 * Plan-independent ceilings and retention windows for one shop's Durable
 * Object, and the batch sizes the sweeps that enforce them run at.
 *
 * The ceilings were set 2026-10-08 from the Cloudflare cost model (`Shop`
 * and `EventCost` in `scripts/lib/cost.ts`) and from what the screens carry.
 * Plan-independent because the object never sees the plan (the reasoning on
 * `ENTITLEMENTS` in Billing): a per-plan ceiling would put plan state in the
 * object to fall out of sync. The meters differentiate
 * the plans; the ceilings fence the app. Unlike an entitlement these are not a
 * product promise (a merchant never sees them unless something has gone
 * wrong), so they exist to bound the object's single thread, its storage and
 * its per-request row counts, not to price a tier.
 */
export const ShopLimits = {
  /**
   * `Team` rows per shop. A team is a D1 row and a name copied onto run
   * tasks; no read is linear in teams, so the number is a screen number,
   * not a load one. 50 is what the orders index's team filter (a select) and
   * the member page's team checklist carry; if a shop reaches it, the UI is
   * the thing to change (a search in the filter), not the ceiling.
   */
  maxTeams: 50,
  /**
   * Open orders (`orderIsOpen` in Orders) stored at one moment, past which no
   * *new* order is stored until one closes. The quantity that loads the
   * object: every orders index read and every member read is linear in it,
   * whatever cycle the orders arrived in. Enterprise fencing, not
   * a tier, and plan-independent like `maxMembers`; the first long-turnaround
   * merchant who meets it is the reason to raise it. See
   * `openOrdersAtCeiling` in Billing.
   */
  maxOpenOrders: 2500,
  /**
   * Members per shop on any plan; see `membersAtCeiling` in Billing. A
   * member is one live screen per publish, so members load the object's
   * single thread (one short read per live screen after every publish), not
   * its storage. At 50 members and 5,000 orders a month the cost model puts
   * the busiest hour at 17% busy; at 100 members and 10,000 a month, 52%,
   * where reads queue. A Durable Object's latency is its weak point, so the
   * fence is set where the busiest hour stays under 20%: 50, which is also
   * two pages of the members index. Plan-independent because the object
   * never sees the plan; seats past the plan's included count are billed,
   * not refused, up to this.
   */
  maxMembers: 50,
  /**
   * Live connections one member may hold on the shop at once; a member's
   * connect past it displaces the oldest (`ShopAgent.displaceConnections`,
   * the connection table on {@link ConnectionRole}). A member is a person
   * with at most a bench computer and a phone: each is one connection, and
   * each connection is one live screen re-read on every publish. A sign-in
   * shared across a floor is many connections on one member id, five seats
   * of load for one seat of revenue; this cap, with
   * {@link ShopLimits.maxSessionsPerMember}, is what makes a member one
   * person. Neither cap identifies a device, so two phones sharing a sign-in
   * look the same as one worker's phone and bench computer: the cap is the
   * control, not detection.
   *
   * Newest wins: the worker who just opened the app is the one at the bench,
   * and refusing the new connection would lock them out of the device in
   * their hand. Merchants are not capped: Shopify's staff-account limits
   * bound them, and a merchant has no seat to share. At {@link
   * ShopLimits.maxMembers} this bounds the shop at 100 member connections,
   * which the cost model puts at 25% busy at 5,000 orders a month.
   */
  maxConnectionsPerMember: 2,
  /**
   * Sign-in sessions one person may hold at once, the other half of the
   * one-person rule on {@link ShopLimits.maxConnectionsPerMember}. A
   * magic-link sign-in creates a better-auth session per device it is opened
   * on; `Auth`'s `session.create.after` hook keeps the newest two
   * (`Repository.keepNewestSessions`) and deletes the rest, so a sign-in
   * shared across a floor signs the others out. The deleted device's open
   * sockets are revoked on every shop the email is a member of
   * (`ShopAgent.revokeMemberConnections`, 3401): each device reconnects
   * through the gate, where the deleted session's cookie no longer resolves
   * and is refused, and the kept devices come back. Without the revoke the
   * signed-out device would keep a live socket under its old identity until
   * it reloaded.
   *
   * Why the pair: a connection cap alone is beaten by taking turns (five
   * workers, two connections, each reconnecting when a verb is needed); a
   * session cap alone is beaten by one device with many windows, which the
   * connection cap bounds. Why delete rather than refuse: refusing the new
   * sign-in locks the person out of the device in their hand; deleting the
   * oldest signs out the one they are not using. Applies to every user,
   * operators included, since a sign-in is the same row whoever holds it.
   */
  maxSessionsPerMember: 2,
  /** Line items fetched per order on either path; the rest are not stored. */
  maxLineItemsPerOrder: 250,
  /**
   * Bytes of `properties` JSON one item keeps (8 KB), on either sync path;
   * `capProperties` in Orders applies it. `properties` is whatever the
   * storefront attached, and a storefront app can attach kilobytes (a design
   * proof as a data URL would do it); it is stored on the item and copied
   * onto every run of it, the object's row limit is 2 MB and a statement's
   * 100 KB, and the stream holds an order whole. The properties are kept in
   * order while the encoded JSON stays within the cap and the rest are
   * dropped, logged once per order. Truncated, not refused: the order still
   * syncs and the merchant still sees the properties that fit.
   */
  maxPropertiesBytesPerItem: 8192,
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
   * The sweep rides the open-orders sync and, at most every {@link
   * ShopLimits.sweepIntervalMs}, the webhook path. There is no alarm: a shop
   * receiving no webhooks is not growing, and an alarm would add a schedule,
   * a test surface and a failure mode for a shop that has stopped trading.
   */
  orderRetentionDays: 365,
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
 * Baton stores every time as epoch-ms integers in a column whose name ends in At.
 *
 * "Baton" means the tables Baton writes the DDL for: {@link D1_TABLES} in D1
 * and every table in {@link initializeSchema}. A vendor's table stores time as
 * the vendor writes it, and Baton reads it through the vendor's API or a
 * decoding schema: better-auth writes ISO 8601 text through its adapter
 * (`refs/better-auth/packages/core/src/db/adapter/factory.ts`, the
 * `supportsDates` branch), and the `agents` SDK writes epoch seconds in its
 * `cf_agents_*` tables.
 *
 * Milliseconds because the source is milliseconds (`Clock.currentTimeMillis`,
 * `Date.now()`, this schema's decode); an integer compares correctly with no
 * format discipline; and seconds would lose order within a second, where a
 * shop can place several orders (the `ShopOrder_processedAt` index sorts on
 * `processedAt` with `id` as the tiebreak for the same millisecond).
 *
 * The schema itself decodes a Shopify `DateTime` (ISO 8601) to that number.
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
 * Who is on a `ShopAgent` WebSocket connection. Two populations reach the
 * object over the same socket (`ShopAgentSocket`, mounted by
 * `ShopAgentSocketProvider` on both sides) and must not reach the same methods:
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
 * From connect to close. `side` is where the answer is given: the Worker's
 * gate (`authorizeShopAgentRequest`), the object, or the tab.
 *
 * | event                                          | side   | answer                                                                           | pinned by                                                                                                |
 * | ---------------------------------------------- | ------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
 * | upgrade with a valid App Bridge token          | Worker | forwards `merchant`                                                              | forwards a merchant role for a valid session token                                                       |
 * | upgrade with a member cookie for this shop     | Worker | forwards `member`, the id, the email, the team ids                               | forwards the member identity resolved from the cookie                                                    |
 * | a member past the plan's included seats        | Worker | forwards `member`; the seat rule is the triggers table on `ShopUsage`            | forwards a member past the plan's included seats                                                         |
 * | upgrade carrying a forged `x-baton-*` header   | Worker | the header is dropped; the gate's own answer is forwarded                        | strips a forged role header from a member upgrade                                                        |
 * | cookie of a signed-in non-member of the shop   | Worker | 404                                                                              | 404s a signed-in non-member of that shop                                                                 |
 * | cookie of an operator                          | Worker | 403                                                                              | 403s an operator cookie                                                                                  |
 * | member of a shop whose app subscription lapsed | Worker | 402                                                                              | 402s a member of a shop whose app subscription lapsed                                                    |
 * | neither token nor cookie                       | Worker | 401                                                                              | 401s an upgrade with neither a token nor a session                                                       |
 * | connect with decodable headers                 | object | identity stored on the connection, tagged by role and member id                  | stores a merchant identity and tags the connection; stores a member identity, its teams, and the revocation tag |
 * | connect with undecodable headers               | object | closed 4403                                                                      | closes a connection with undecodable headers with 4403                                                   |
 * | a member's teams or membership change          | object | that member's connections closed 3401                                            | revokes only the named member's connections                                                              |
 * | a team is deleted                              | object | its members' connections closed 3401                                             | closes the sockets of everyone who was on the deleted team                                               |
 * | the shop's app subscription lapses             | object | every connection closed 3401                                                     | revokes every connection on the shop for a lapse                                                         |
 * | close 3401 (revoked)                           | tab    | reconnects through the gate on its own; close 4403 (forbidden) stays closed      | the tab reconnects on 3401 and not on 4403                                                               |
 * | a member's connect past `maxConnectionsPerMember` | object | the member's oldest connections closed 4409 until the cap holds; the new one stays | displaces the oldest connection past the member's cap |
 * | close 4409 (displaced)                         | tab    | stays closed; the screen says Signed in elsewhere and offers Reconnect             | the tab stays closed on 4409 and shows signed in elsewhere |
 *
 * Identity is a connect-time snapshot, persisted with the hibernatable socket
 * (`serializeAttachment`), so it survives the object hibernating but does not
 * follow later team edits; the three 3401 rows are why, and the reconnect
 * re-runs the gate, which gives the current answer (a new identity, `404`,
 * or `402`). Cloudflare's ~300s idle close is the backstop. On a 3401 the
 * merchant's and the member's shells also invalidate the router, so the
 * loaders re-run against what the gate now says.
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
 * Close codes the object sends on a connection it will not serve. `4403`
 * is a gate failure: the forwarded request carried no decodable identity,
 * which can only mean the Worker forwarded something malformed (a browser
 * cannot set these headers on an upgrade). `3401` is revocation, sent by
 * `closeMemberConnections` and `revokeAllConnections`. When each is sent and
 * what the tab does with it is the table on {@link ConnectionRole}.
 *
 * The ranges carry the tab's answer. RFC 6455 §7.4.2 gives 3000-3999 to
 * libraries, frameworks and applications and 4000-4999 to private use, and
 * the browser sees both verbatim. The `agents` client treats 1008 and every
 * 4000-4999 close as terminal and stops reconnecting
 * (`isTerminalCloseEvent` in `refs/agents/packages/agents/src/client.ts`),
 * so `4403` stays closed, which is right: a reconnect cannot fix a malformed
 * forward. A 3xxx close is not terminal to it, so after a revocation
 * partysocket reconnects through the gate on its own backoff.
 */
export const CONNECTION_CLOSE_FORBIDDEN = 4403;
export const CONNECTION_CLOSE_REVOKED = 3401;

/**
 * The close code for a displaced connection: a member's connect took the last
 * of {@link ShopLimits.maxConnectionsPerMember}, and the object closed the
 * member's oldest connection to keep the cap (`ShopAgent.displaceConnections`).
 *
 * A 4xxx code on purpose, terminal to the socket like
 * {@link CONNECTION_CLOSE_FORBIDDEN}: a displaced screen that reconnected on
 * its own would displace the newer screen back, and the two would close each
 * other in turn for as long as both were open. So the displaced screen stays
 * closed and says so ("Signed in elsewhere"), and only the person's Reconnect
 * opens a new socket, which displaces the other screen in its turn. 4409
 * reads as HTTP's 409 Conflict in the private-use range, as 4403 reads 403.
 */
export const CONNECTION_CLOSE_DISPLACED = 4409;

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

/**
 * The invalidation, the one message the object sends: "re-read". Deliberately
 * not the new value: the Durable Object never learns what any tab is
 * rendering, and a re-read runs the same authenticated read the tab already
 * trusts. The tab throttles them (`INVALIDATION_THROTTLE_MS`).
 *
 * The cycle, both sides. `side` is where the step runs: the object or the
 * tab.
 *
 * | step       | side   | symbol                | rule                                                                                                | pinned by                                          |
 * | ---------- | ------ | --------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
 * | identify   | object | `ShopAgent.onConnect` | a connection carries the gate's identity; the tab's `identified` flip runs the first read           | stores a merchant identity and tags the connection |
 * | publish    | object | `ShopAgent.publish`   | a write that succeeded sends the invalidation to every connection; the sites table lists the writes | every connection receives every publish            |
 * | invalidate | tab    | `useLiveQuery`        | a mounted live screen re-reads, throttled, deferred while hidden; the events table is on the hook   | a visible tab refetches on an invalidation         |
 *
 * A live screen reads one method twice: through `ShopAgentClient` in its
 * loader for the SSR paint, and through `useLiveQuery` over the socket
 * after. A socket `useQuery` outside the hook never re-reads and belongs on
 * a loader. Workflow configuration is loader data and changes on
 * navigation, except where an order page shows it; the sites table on
 * `ShopAgent.publish` names every write that publishes.
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
