/**
 * The domain vocabulary, and the one place a behavioural rule is written
 * down.
 *
 * - A rule is stated once, on the symbol that *is* the concept (a
 *   `Schema.Literals` such as {@link RunStatus}) or the function that
 *   enforces it ({@link undoBlockedBy}, {@link readyTasks}). A concept with
 *   more than one rule carries a table naming each rule's predicate.
 * - Every other site calls the predicate ({@link runIsOpen},
 *   {@link runIsFlagged}, {@link userIsAdmin}, ...) rather than comparing a
 *   literal. `scripts/rules-lint.ts`, run by `pnpm lint`, refuses an inline
 *   `.status`, `.flag` or admin `.role` comparison anywhere else under `src/`.
 * - A site that follows a different rule from its siblings says so and why,
 *   in its own JSDoc, and links the rule it departs from.
 * - Each rule is pinned by a test whose title is the rule in plain words.
 *
 * Rules spelled out at every reader drifted: Undo was allowed by the write
 * and hidden by one of three pages, and "live" meant not-cancelled to the
 * line item index but pending-or-active to the shop ceiling, so a `done`
 * run was refused where it should have been offered. {@link runIsLive} and
 * {@link runIsOpen} are two names for two rules, one definition each.
 */
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
 * Two handles, two tiers, and no private `-test` variants: a development store
 * in the same Partner organization is granted every public plan at $0, which
 * is the whole thing a store-restricted private plan would have bought.
 *
 * The allowlist is total and identical in every environment: a handle outside
 * it means the catalog changed under us, which must resolve to no access rather
 * than a guess.
 *
 * The literals are the plan handles configured in the Partner Dashboard for
 * every environment's app, so renaming a plan there is a rename here.
 */
export const PlanHandle = Schema.Literals(["baton-basic", "baton-pro"]);
export type PlanHandle = typeof PlanHandle.Type;

export const Plan = Schema.Literals(["basic", "pro"]);
export type Plan = typeof Plan.Type;

/**
 * Normalization, not entitlement. The mapping exists so nothing downstream has
 * to learn Shopify's plan handles ({@link PlanHandle}); what each tier
 * *grants* is {@link entitlementsOfPlan}.
 */
export const planOfHandle = (handle: PlanHandle): Plan =>
  handle === "baton-pro" ? "pro" : "basic";

export interface Entitlements {
  /** Orders ({@link ShopUsage.ordersThisCycle}) included per billing cycle. Past this the usage meter bills; nothing blocks until {@link ShopLimits.maxOrdersPerCycle}. */
  readonly ordersPerCycle: number;
  /**
   * Seats included; members past this many are billed by the
   * {@link USAGE_METER_MEMBER} meter, never refused. Nothing in the app
   * compares the roster to this number except the home page's Members tile:
   * the meter's $0.00 band absorbs the included seats, so the object sends the
   * roster size and Shopify prices it. The only refusal is
   * {@link ShopLimits.maxMembers}, which is plan-independent.
   */
  readonly membersIncluded: number;
}

/**
 * What each tier grants. The Worker owns this table and the Durable Object
 * never sees it, but the split is *compare here, count there*, not "pass the
 * number in": `ordersPerCycle` is compared in the Worker against the
 * {@link ShopUsage} row the object keeps and reports, and `membersIncluded` is
 * compared nowhere but the home page's Members tile; the roster size reaches
 * the object as a number to send ({@link RecordRosterInput}), not to compare.
 * Neither entitlement reaches `ShopAgent`, so the object stores no plan state
 * to fall out of sync, and an upgrade or downgrade lands on the very next page
 * view with nothing to invalidate. The one plan-adjacent fact the
 * object does hold is the billing *cycle* (see {@link ShopUsage}), which is a
 * period, not an entitlement.
 *
 * `satisfies Record<Plan, Entitlements>` makes the lookup total by
 * construction — a new `Plan` literal fails to compile here.
 *
 * Provisional. Working proposals, not tuned figures: nothing was measured to
 * arrive at them and nothing should be derived from them. Change freely, and
 * move the Partner Dashboard plan copy (and the table in `README.md`) with
 * them. `ordersPerCycle` must equal tier 1 of the {@link USAGE_METER_ORDER}
 * meter on that plan — the **included allowance**, the band priced at $0.00 —
 * or the merchant is billed for an order the app calls included; the same
 * holds for `membersIncluded` and tier 1 of {@link USAGE_METER_MEMBER}. It is not a
 * "free tier": the allowance is what the subscription already paid for.
 * Nothing verifies the two agree; it is operator discipline, because the meter
 * lives in the Partner Dashboard and the app cannot read its tiers.
 *
 * Raising a limit is always safe; lowering one is not, with no grandfathering:
 * a cut applies to existing shops immediately. A cut to `membersIncluded`
 * only moves the $0.00 band; nobody loses access.
 */
const ENTITLEMENTS = {
  basic: { ordersPerCycle: 20, membersIncluded: 3 },
  pro: { ordersPerCycle: 30, membersIncluded: 10 },
} as const satisfies Record<Plan, Entitlements>;

export const entitlementsOfPlan = (plan: Plan): Entitlements =>
  ENTITLEMENTS[plan];

/**
 * The widest tier, for callers that need a ceiling rather than a particular
 * shop's grant — e.g. a local-only e2e fixture with no merchant and no plan to
 * resolve.
 */
export const MAX_ENTITLEMENTS: Entitlements = ENTITLEMENTS.pro;

/**
 * The App Pricing usage meter handle for a counted order, identical on every
 * plan. Case-sensitive; must match the Partner Dashboard exactly, because the
 * App Events API answers `202` to a handle that matches no meter and the event
 * is then silently non-billable. Each meter is one handle across tiers so the
 * meter's own graduated tiers — not the event — decide what a unit costs.
 */
export const USAGE_METER_ORDER = "production-orders";

/** The App Pricing usage meter handle for seats; same rules as {@link USAGE_METER_ORDER}. The value sent is {@link seatEventValue}. */
export const USAGE_METER_MEMBER = "members";

/**
 * What the shop's contract grants right now. Nothing is scheduled: a plan
 * change on Shopify's pricing page applies at once, up or down, and lands on
 * the revalidation the billing redirect forces. App Pricing defers only a
 * downgrade to a free plan, and Baton has none
 * (https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-subscription-charges#proration-logic).
 */
export const PlanStatus = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Subscribed"),
    handle: PlanHandle,
    plan: Plan,
    /** The next contract boundary as epoch milliseconds: cycle end, or trial end during a trial. */
    boundaryAt: Schema.NullOr(Schema.Number),
  }),
  Schema.Struct({ _tag: Schema.Literal("Unsubscribed") }),
]);
export type PlanStatus = typeof PlanStatus.Type;

/**
 * A resolved App Pricing contract: the one allowlisted plan handle it carries,
 * the cycle it is in, and what Shopify has metered this cycle.
 *
 * `boundaryAt` collapses two Shopify fields that never coexist —
 * `currentBillingCycle.endTime` is null during a trial, where `trialEndsAt`
 * takes over. Both denote the same thing to a cache: the next instant at which
 * the contract may legitimately change without any notification, since App
 * Pricing sends no webhooks.
 *
 * A plan change is a new contract: a new cycle starting at the switch moment,
 * with every meter at zero. Usage sent during a trial is not reported and does
 * not carry into the paid cycle. Accepted usage shows on the meter within
 * about 30 s. Measured on the dev store on 2026-09-22. This is why the seat
 * meter is sent the whole roster at each new cycle
 * (`OrderRepository.setBillingCycle`) rather than an overage: the plan's tiers
 * price it, so a switch needs no app-side arithmetic.
 */
export const ActiveSubscription = Schema.Struct({
  handle: PlanHandle,
  boundaryAt: Schema.NullOr(Schema.Number),
  /** `currentBillingCycle.startTime`; null during a trial, which has no cycle. */
  cycleStartAt: Schema.NullOr(Schema.Number),
  /** Shopify's own quantity per meter this cycle, null when the contract lacks that meter's item; the figures local counting is reconciled against. */
  usage: Schema.Struct({
    orders: Schema.NullOr(Schema.Number),
    members: Schema.NullOr(Schema.Number),
  }),
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
  /**
   * The contract's boundary and period, cached beside the handle and written
   * only by `Repository.updateShopSessionPlan`, so a cache hit answers "when
   * does this expire" without a second Partner call. Null means none or
   * unknown, and both are only meaningful while `planHandleExpiresAt` is in the
   * future — a stale row's dates are as untrustworthy as its handle.
   */
  planBoundaryAt: Schema.NullOr(Schema.Number),
  planCycleStartAt: Schema.NullOr(Schema.Number),
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
    "planCycleStartAt",
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
 * Deliberately email-keyed with no userId: the owner grants access by adding an
 * email before any better-auth `User` row exists (there is no invite-accept
 * task), so a `User` FK cannot hold. Sign-in is magic-link-only, which makes the
 * email itself the identity; guards match the session user's email against this
 * table. No role column: membership is binary (a row = access) — member
 * management lives only in the embedded app behind Shopify auth, and the member
 * area does not differ per member.
 */
export const MemberId = Schema.NonEmptyString.pipe(Schema.brand("MemberId"));
export type MemberId = typeof MemberId.Type;

/**
 * Merchant copy: **delete a member and they leave their teams.**
 * `TeamMember` cascades; nothing else structural points here.
 * Run history survives the delete because `WorkflowRunTask` snapshots the
 * actor's email (`startedByEmail` / `completedByEmail`, and the block flag's
 * `by`) at the moment of the action, so no live join is ever needed. The
 * bare `startedBy` / `completedBy` ids stay as text with no foreign key and
 * simply stop resolving. Re-adding the same email mints a new id; history
 * keeps the old email as text.
 */
export const Member = Schema.Struct({
  id: MemberId,
  shop: Shop,
  email: Email,
  createdAt: Schema.String,
});
export type Member = typeof Member.Type;

export const TeamId = Schema.NonEmptyString.pipe(Schema.brand("TeamId"));
export type TeamId = typeof TeamId.Type;

/**
 * Trimmed on decode for the same structural reason as {@link Email}: the
 * `Team.name` check constraint rejects untrimmed text, and uniqueness is
 * `collate nocase`, so a leading space would otherwise be the difference
 * between a duplicate the database refuses and one it silently accepts.
 * Case is *not* folded — merchants name teams "Cut & Sew", not "cut & sew".
 */
export const TeamName = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(64)).pipe(
      Schema.brand("TeamName"),
    ),
    {
      decode: SchemaGetter.transform((s) => s.trim()),
      encode: SchemaGetter.transform((s) => s),
    },
  ),
);
export type TeamName = typeof TeamName.Type;

/**
 * A shop-scoped grouping of members. Merchant copy: **delete a team and
 * its tasks become unassigned until you assign a team.**
 * Every `WorkflowTask`, `WorkflowDraftTask`, and *open* `WorkflowRunTask`
 * that pointed at the team gets `teamId = null`; finished run tasks keep the
 * id and their `teamName` snapshot, which is why history never needs the row.
 * A team with nobody on it is valid and shows **No members**: its tasks can
 * still start runs, nobody can work them until someone joins, and adding one
 * member fixes everything with no data change.
 */
export const Team = Schema.Struct({
  id: TeamId,
  shop: Shop,
  name: TeamName,
  createdAt: Schema.String,
});
export type Team = typeof Team.Type;

export const TeamSummary = Schema.Struct({
  ...Team.fields,
  memberCount: Schema.Number,
});
export type TeamSummary = typeof TeamSummary.Type;

/**
 * The live D1 roster as the Durable Object hands it to pages: what the team
 * pickers list and what the derived attention state is computed against.
 * `memberCount` is here so "No members on <team>" needs no second read.
 */
export const TeamRoster = Schema.Struct({
  id: TeamId,
  name: TeamName,
  memberCount: Schema.Number,
});
export type TeamRoster = typeof TeamRoster.Type;

/**
 * The team plus every member of its shop, each flagged with whether they are on
 * it — the detail screen toggles membership against the whole roster, so the
 * non-members are as much a part of the view as the members.
 */
export const TeamDetail = Schema.Struct({
  team: Team,
  members: Schema.Array(
    Schema.Struct({
      ...Member.fields,
      inTeam: SqliteBoolean,
      /** The `TeamMember.createdAt` of the edge; `null` when `inTeam` is false. */
      inTeamSince: Schema.NullOr(Schema.String),
    }),
  ),
});
export type TeamDetail = typeof TeamDetail.Type;

/**
 * What the member-area guard resolves in one query: proof of membership plus
 * the active teams that membership carries. Teams are what scope work, so every
 * `/shop/*` handler wants them and none of them should pay a second round trip;
 * an empty `teams` is the ordinary "member with nothing to do yet" state, not an
 * error.
 */
export const MemberAccess = Schema.Struct({
  shop: Shop,
  memberId: MemberId,
  teams: Schema.Array(Schema.Struct({ id: TeamId, name: TeamName })),
});
export type MemberAccess = typeof MemberAccess.Type;

/**
 * One row per `(member, team)` edge in a shop, with the team's total member
 * count riding along: the members page paints its Teams column from it, the
 * edit-teams modal seeds its checklist from it, and a sole membership — the
 * team a delete would empty — is simply `teamMemberCount === 1`, so no second
 * read over the same join exists to drift from this one.
 */
export const MemberTeam = Schema.Struct({
  memberId: MemberId,
  teamId: TeamId,
  teamName: TeamName,
  teamMemberCount: Schema.Number,
});
export type MemberTeam = typeof MemberTeam.Type;

export const WorkflowId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowId"),
);
export type WorkflowId = typeof WorkflowId.Type;

export const WorkflowTaskId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowTaskId"),
);
export type WorkflowTaskId = typeof WorkflowTaskId.Type;

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
 * Provisional in exactly the sense {@link Entitlements} is: working proposals,
 * nothing measured. Unlike an entitlement these are not a product promise — a
 * merchant never sees them unless something has gone wrong — so they exist to
 * bound the object's storage and per-request row counts, not to price a tier.
 */
export const ShopLimits = {
  /** `Team` rows per shop. */
  maxTeams: 25,
  /** `WorkflowRun` rows that are {@link runIsOpen} per shop; a safety valve, not a product limit. "Open", not "live": a `done` run is live for its line item but frees this slot. */
  maxOpenRuns: 5000,
  /** {@link ShopUsage.ordersThisCycle} at which syncing of *new* orders stops for the rest of the cycle. Provisional; enterprise fencing, not a tier — see {@link cycleAtOrderCeiling}. */
  maxOrdersPerCycle: 100,
  /** Members per shop on any plan; see {@link rosterAtCeiling}. Provisional; enterprise fencing, not a tier. */
  maxMembers: 12,
  /** Line items kept per order on the bulk path; the rest are dropped and the order flagged. */
  maxLineItemsPerOrder: 250,
  /**
   * An order whose `processedAt` is older than this is deleted on the next
   * sweep, open or closed, with or without runs; its runs go with it, deleted
   * in the same transaction and not flagged first, because a flag on a row
   * the next statement deletes is read by nobody. The rule is one `where` clause in
   * `OrderRepository.sweepExpiredOrders`, which is its only enforcer and its
   * only reader — no TypeScript site asks whether an order has expired, so
   * there is no predicate here to drift from the SQL. Baton is a working
   * set, not an archive — Shopify keeps every order — so one rule replaces
   * asking what "closed" or "untouched" means.
   *
   * The sweep rides the import and, at most every {@link
   * ShopLimits.sweepIntervalMs}, the webhook path. There is no alarm: a shop
   * receiving no webhooks is not growing, and an alarm would add a schedule,
   * a test surface and a failure mode for a shop that has stopped trading.
   */
  orderRetentionDays: 365,
  /** `WebhookDelivery` rows older than this are deleted; Shopify retries for at most 4 hours. */
  webhookDeliveryRetentionDays: 7,
  /** `syncOrders` refuses to start a bulk import when the object's SQLite is past this. */
  storageSoftLimitBytes: 2_000_000_000,
  /** Rows deleted per sweep pass, so no carrier request pays for more than this. */
  sweepBatch: 200,
  /** Minimum gap between retention passes triggered from the webhook path. */
  sweepIntervalMs: 6 * 60 * 60 * 1000,
} as const;

/**
 * What one shop has consumed, as the Durable Object counts it. The Worker
 * compares this against {@link Entitlements}; the object itself enforces
 * nothing from it beyond {@link ShopLimits}.
 *
 * The count is keyed by *billing cycle*, not by calendar month, because the
 * same count is what the merchant is billed for: the home page and the Shopify
 * invoice have to agree about which orders fall in a period, and only Shopify
 * knows where the period starts. `OrderRepository.countOrder` is the rule —
 * one unit the first time Baton creates a run for an order, never reversed —
 * and `countedAt` on `ShopOrder` is the per-order marker that makes it fire
 * once.
 */
export const ShopUsage = Schema.Struct({
  /**
   * The billing cycle the count belongs to. Both null until the Worker has
   * pushed one ({@link BillingCycleInput}), in which case the object opens a
   * cycle at the first order it stores and rolls forward on its own — a shop
   * must keep metering before its first plan revalidation, not after.
   */
  cycleStartAt: Schema.NullOr(Schema.Number),
  cycleEndAt: Schema.NullOr(Schema.Number),
  /**
   * Orders Baton created a run for this cycle, and nothing else:
   * `OrderRepository.countOrder` is the rule. Not orders stored — a shop can
   * hold any number of orders no workflow matches and this stays at zero —
   * and never decremented, because the count is what the merchant is billed
   * for and the bill is never reversed. It is also what
   * {@link cycleAtOrderCeiling} reads, so the ceiling bounds work started,
   * which is the billable quantity, rather than rows.
   */
  ordersThisCycle: Schema.Number,
  /** Set when a new order was refused because of {@link ShopLimits.maxOrdersPerCycle}; null once the cycle rolls, or once `OrderRepository.deleteSeedOrders` gives the refused seed's count back. */
  ordersLimitedAt: Schema.NullOr(Schema.Number),
  /** Set when reconcile declined to auto-start a run because of `ShopLimits.maxOpenRuns`; null once under the ceiling again. */
  openRunsLimitedAt: Schema.NullOr(Schema.Number),
  /** `ctx.storage.sql.databaseSize` at read time. */
  databaseSize: Schema.Number,
  lastSweepAt: Schema.NullOr(Schema.Number),
  /** Usage events queued for the current cycle and not yet accepted by Shopify. Non-zero for long is an operator signal, not a merchant-facing number. */
  pendingUsageEvents: Schema.Number,
  /** Usage events that missed their cycle and can no longer be sent; see {@link usageEventIsDead}. Each is a unit carried and never billed. */
  deadUsageEvents: Schema.Number,
  /** The {@link USAGE_METER_ORDER} share of {@link pendingUsageEvents}, as units; the tolerance of the orders drift check. */
  pendingOrderUnits: Schema.Number,
  /** The {@link USAGE_METER_MEMBER} share of {@link pendingUsageEvents}, as units; the tolerance of the members drift check. */
  pendingMemberUnits: Schema.Number,
  /**
   * The cycle's billable seat quantity: its high-water mark, as
   * {@link seatEventValue} defines it. Everything sent to
   * {@link USAGE_METER_MEMBER} this cycle sums to this number once the
   * outbox drains. Never lowered by a removal; reset only by a new cycle
   * (`OrderRepository.setBillingCycle`).
   */
  membersHighWater: Schema.Number,
  /**
   * Shopify's own {@link USAGE_METER_ORDER} reading at the last revalidation;
   * null until one has reported it. Diagnostic only — nothing is corrected
   * from it.
   *
   * Null can also mean the contract cannot report at all. Shopify reports the
   * quantity on the meter's *subscription item*, and an App Pricing contract
   * carries the item set it was created with: a shop that subscribed before
   * the meter was configured on its plan has no meter item and never will,
   * however many events are accepted. Only a new contract — any plan switch —
   * brings the item, which then reports from zero. Measured on 2026-09-19: the
   * pre-meter contract listed one `FlatRatePrice` item after seven accepted
   * events; the replacement listed the meter at `quantity: 0` before any.
   */
  lastReconciledOrders: Schema.NullOr(Schema.Number),
  /** Shopify's own {@link USAGE_METER_MEMBER} reading at the last revalidation; null under the same conditions as {@link lastReconciledOrders}. */
  lastReconciledMembers: Schema.NullOr(Schema.Number),
});
export type ShopUsage = typeof ShopUsage.Type;

/**
 * The billing cycle the Worker pushes into the object after a plan
 * revalidation. Plain RPC input: a browser has no business naming a shop's
 * billing period, and the object has no way to learn it on its own.
 *
 * `shopGid` rides along because the object needs it to address a usage event
 * at Shopify and has no other source for it — it lives on the D1 `ShopSession`
 * row, which is the Worker's.
 */
export const BillingCycleInput = Schema.Struct({
  shopGid: ShopGid,
  cycleStartAt: Schema.Number,
  cycleEndAt: Schema.NullOr(Schema.Number),
  /** The D1 roster size, read by the Worker just before the push; the seat mark a new cycle starts from. */
  memberCount: Schema.Number,
});
export type BillingCycleInput = typeof BillingCycleInput.Type;

/**
 * The cycle a shop counts against before the Worker has ever pushed a real
 * billing period: the first instant of `now`'s UTC month.
 *
 * A shop opens its cycle at its first order, which can land before its first
 * plan revalidation — a webhook arrives on the install's heels, and the
 * revalidation is a separate request that may be minutes behind. Opening a
 * provisional cycle is what lets a run started then count; `setBillingCycle`
 * replaces it with Shopify's period as soon as one is known.
 *
 * UTC, not the shop's timezone: the object has no locale, and a boundary that
 * moved with the merchant's would make a stored cycle ambiguous.
 */
export const provisionalCycleStart = (now: number) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/** Shopify's meter readings for the current cycle, pushed in for the divergence checks on {@link ShopUsage.lastReconciledOrders} and {@link ShopUsage.lastReconciledMembers}; null where the contract lacks the meter. */
export const ReconcileUsageInput = Schema.Struct({
  orders: Schema.NullOr(Schema.Number),
  members: Schema.NullOr(Schema.Number),
});
export type ReconcileUsageInput = typeof ReconcileUsageInput.Type;

/**
 * One App Events billing event: one counted order, or seats past the cycle's
 * high-water mark.
 *
 * `idempotencyKey` is permanent at Shopify and capped at 64 characters, which
 * is why it is derived from the order id or the cycle and mark rather than
 * from a clock: replaying a flush must not bill twice.
 */
export const UsageEvent = Schema.Struct({
  shopGid: ShopGid,
  eventHandle: Schema.NonEmptyString,
  /** When the order was counted, not when the event is sent: Shopify rejects a timestamp outside the merchant's current cycle. */
  occurredAt: Schema.Number,
  idempotencyKey: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  /**
   * A positive integer: `1` for an order, and for seats the roster size at a
   * new cycle or the rise over the high-water mark ({@link seatEventValue}).
   * Positive because both meters only count up — an order is billed the first
   * time Baton creates a run for it (`OrderRepository.countOrder`), a seat
   * mark is never lowered by a removal — and nothing is ever reversed, so zero
   * or a negative could only be a bug.
   */
  value: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
export type UsageEvent = typeof UsageEvent.Type;

/**
 * A queued usage event is dead once the cycle that dated it has ended: Shopify
 * refuses an event whose timestamp falls in a closed period, so retrying it can
 * only fail. Dead rows are kept, skipped by the flush, and reported apart from
 * the live queue ({@link ShopUsage.deadUsageEvents}) — a count of orders the
 * merchant carried and was never billed for is an operator signal, not
 * something to retry into or hide inside the reconcile tolerance.
 */
export const usageEventIsDead = (occurredAt: number, cycleStartAt: number) =>
  occurredAt < cycleStartAt;

/**
 * The cycle is at its ceiling when {@link ShopUsage.ordersThisCycle} — orders
 * Baton started work on, not orders stored — has reached
 * {@link ShopLimits.maxOrdersPerCycle}, past which no *new* order is stored for
 * the rest of the cycle.
 *
 * The one hard stop on orders, and it is positioning rather than protection:
 * storage is nowhere near its limit at this volume, but a shop above it is
 * outside what Baton is built for, and saying so with a number the merchant can
 * read beats letting an import fail late inside a stream. Updates to orders
 * already stored keep flowing — the production floor must not lose the work it
 * is already carrying.
 *
 * **An order refused here is lost to Baton for the rest of the cycle.** The
 * webhook path answers Shopify 2xx without storing it, because a 5xx would
 * only have Shopify retry for four hours against a condition that four hours
 * cannot clear; Shopify does not redeliver afterwards, and nothing re-reads
 * the gap. What recovers it is the merchant: once the cycle rolls over,
 * Import open orders re-fetches whatever is still open
 * (`ShopAgent.syncOrders`). `ShopUsage.ordersLimitedAt` is what raises the
 * banner saying so.
 */
export const cycleAtOrderCeiling = (ordersThisCycle: number) =>
  ordersThisCycle >= ShopLimits.maxOrdersPerCycle;

/**
 * A shop's roster is at its ceiling when it holds
 * {@link ShopLimits.maxMembers} members, on any plan. `Repository.addMember`
 * refuses a new email there, and the merchant is told to contact support. It
 * is the one refusal on the roster: {@link Entitlements.membersIncluded} bills,
 * it does not block.
 */
export const rosterAtCeiling = (count: number) =>
  count >= ShopLimits.maxMembers;

/**
 * The seat units to queue when the roster reaches `rosterSize`: the rise over
 * the cycle's high-water mark, or `0` when not past it.
 *
 * The billable seat quantity for a cycle is its high-water mark: the roster
 * size at cycle start, plus one for each add that raises the mark. A removal
 * never lowers it, so remove-then-add inside a cycle bills once, and nothing
 * sent is ever reversed. The arithmetic, not the constant `1`, is the rule: a
 * roster that grew by more than one between reports still sends exactly the
 * rise.
 */
export const seatEventValue = (rosterSize: number, highWater: number) =>
  Math.max(rosterSize - highWater, 0);

/**
 * A usage meter diverges when Shopify's reading and the local figure differ by
 * more than the units still queued for that meter. Pending units are a gap
 * the next flush closes; dead ones ({@link usageEventIsDead}) never close, so
 * they are not tolerated, and a tolerance that grew with every lost event
 * would hide the loss it exists to show. Each meter tolerates only its own
 * pending units ({@link ShopUsage.pendingOrderUnits},
 * {@link ShopUsage.pendingMemberUnits}).
 */
export const meterDiverges = (input: {
  readonly local: number;
  readonly shopify: number;
  readonly pending: number;
}) => Math.abs(input.local - input.shopify) > input.pending;

/**
 * The roster size the Worker reports after an add (`ShopAgent.recordRoster`).
 * Plain RPC input: the roster is D1's, and the object cannot count it.
 */
export const RecordRosterInput = Schema.Struct({ size: Schema.Number });
export type RecordRosterInput = typeof RecordRosterInput.Type;

/** The length of every trimmed name: the schema check, the field `maxLength`, and the rename dialog's counter all read this. */
export const NAME_MAX_LENGTH = 64;

const trimmedName = <B extends string>(brand: B) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.NonEmptyString.check(Schema.isMaxLength(NAME_MAX_LENGTH)).pipe(
        Schema.brand(brand),
      ),
      {
        decode: SchemaGetter.transform((s) => s.trim()),
        encode: SchemaGetter.transform((s) => s),
      },
    ),
  );

/**
 * Same shape and reasoning as {@link TeamName}: trimmed, case preserved.
 * Unlike {@link TeamName} it is **not** unique — see {@link Workflow}, where
 * the tag is the one key and the name is a label.
 */
export const WorkflowName = trimmedName("WorkflowName");
export type WorkflowName = typeof WorkflowName.Type;

export const TaskName = trimmedName("TaskName");
export type TaskName = typeof TaskName.Type;

const trimmedText = <B extends string>(brand: B, maxLength: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.NonEmptyString.check(Schema.isMaxLength(maxLength)).pipe(
        Schema.brand(brand),
      ),
      {
        decode: SchemaGetter.transform((s) => s.trim()),
        encode: SchemaGetter.transform((s) => s),
      },
    ),
  );

/** Merchant-written how-to for a task, copied onto every run. Trimmed like {@link TaskName}; a blank field is sent as `null`, never as an empty string. */
export const TaskInstructions = trimmedText("TaskInstructions", 2000);
export type TaskInstructions = typeof TaskInstructions.Type;

/**
 * The caps {@link RunNote} and {@link BlockReason} enforce, exported so a
 * field can count down to them. A decode failure mid-paragraph is the failure
 * mode: the writer has typed a page before anything refuses it. The run note
 * gets twice the room because it accumulates: people append to it over the
 * life of the job, where a block reason describes one hold.
 */
export const RUN_NOTE_MAX_LENGTH = 2000;
export const BLOCK_REASON_MAX_LENGTH = 1000;

/**
 * Where a note or reason field starts counting down to its cap: 200
 * characters before it. Late, because a counter on an empty field is a rule
 * nobody asked about; early enough that the cap announces itself while there
 * is still a paragraph's room to land in. One rule for every free-text field,
 * whatever its cap.
 */
export const noteCountFrom = (maxLength: number) => maxLength - 200;

/**
 * The run's free-text note: one field per run, anyone with access may write
 * it, appended to by convention. Trimmed like {@link TaskName}; `null` clears.
 * The write rule is on {@link SetRunNoteCommand}.
 */
export const RunNote = trimmedText("RunNote", RUN_NOTE_MAX_LENGTH);
export type RunNote = typeof RunNote.Type;

/** Why a run is blocked, in `RunFlagDetail.reason`. Same trimming; `null` blocks without one. */
export const BlockReason = trimmedText("BlockReason", BLOCK_REASON_MAX_LENGTH);
export type BlockReason = typeof BlockReason.Type;

/**
 * The workflow's one tag: its identity in a form a product can carry. Every
 * workflow has exactly one, from birth, and no two workflows share one. Baton
 * mints it (the create dialog prefills it from the workflow name) and the
 * merchant puts it on products in Shopify; a line item whose product carries
 * it follows the workflow. It is not a *product* tag — that is
 * `OrderLineItem.productTags`, the product's own merchandising facets, which
 * this is matched against.
 *
 * Trimmed *and* lowercased, unlike the names: merchants type `Engraving` and
 * `engraving` interchangeably and Shopify's own admin search is
 * case-insensitive, so folding once at the boundary keeps storage canonical
 * and makes matching plain equality. 255 is Shopify's tag length limit; Baton
 * adds no character rules of its own beyond what Shopify allows in a tag.
 */
export const WorkflowTag = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(255)).pipe(
      Schema.brand("WorkflowTag"),
    ),
    {
      decode: SchemaGetter.transform((s) => s.trim().toLowerCase()),
      encode: SchemaGetter.transform((s) => s),
    },
  ),
);
export type WorkflowTag = typeof WorkflowTag.Type;

/**
 * Vocabulary. A workflow definition has two nouns and the merchant never
 * meets a third:
 *
 * - **Workflow**: name, type, tag, tasks, Active / Off. This is what
 *   starts runs. Runs copy it wholesale and never look back at it.
 * - **Draft**: a private copy of the workflow's **tasks**, created by
 *   Edit and living until Apply or Discard. Every edit writes to the draft
 *   immediately; there is no unsaved state anywhere.
 *
 * Verbs: **Edit** creates the draft. **Apply changes** replaces the
 * workflow's tasks with the draft's and deletes the draft.
 * **Discard changes** deletes the draft. **Turn on** / **Turn off** set and
 * clear `activatedAt`; the switch and the draft are unrelated.
 *
 * How a workflow is chosen for work, in merchant copy. Every workflow **has
 * exactly one tag**, no two workflows share one, and the tag is edited like
 * the name: immediately, never through the draft. The product **carries
 * product tags**; a **match** is one of the product's tags equalling the
 * workflow's tag. The workflow's field is never called a "product tag": that
 * name points the arrow the wrong way, since Baton mints the string and the
 * merchant carries it out to Shopify.
 *
 * - a workflow **starts when** an order **contains** a product **tagged with**
 *   its tag;
 * - an order or line item that no workflow's tag **matches** shows
 *   **"No workflow"**;
 * - the order page says a workflow **started for** N items;
 * - a workflow **applies to orders placed since** it was turned on; the
 *   word for an order's date is **placed**, never a field name.
 *
 * In identifiers: `match` is the tag test, `start` / `canStart` is creating
 * a run. Not used, in code or copy: version, live, saved, published,
 * retired, applied (as a state), route, routing, routable, pause, and
 * "product tag" for the workflow's own field.
 *
 * Merchant copy, the whole model in five sentences: **delete a
 * workflow and its runs stay on their orders**, open ones finish; **turn
 * off** stops new runs and open ones finish; **a workflow needs at least one task before it
 * can be applied or turned on**, so zero tasks is the state before the first
 * Apply and only that; **any open task on a run can be assigned to another
 * team**, a finished task is history; **deleting configuration never deletes
 * work**. Delete removes the definition, its tasks, and its draft, nothing
 * else — a run is self-sufficient, so it needs no confirm counts and the
 * dialog says only what survives. The id is identity, the tag is the one
 * unique key, and the name is a label two workflows may share — so everything
 * that shows a workflow to the merchant outside its own page shows the tag
 * beside the name. A rename is immediate and cosmetic because runs snapshot
 * `workflowName`.
 *
 * `activatedAt` is the on/off switch and the coverage date in one column,
 * stored and never derived: null is off; Turn on sets it to now, or to an
 * earlier date the merchant chose to include waiting orders; the merchant
 * can move it on the workflow page; Turn off clears it; Apply never touches
 * it, because an unpaid order placed while the workflow was on is still that
 * workflow's business when it pays. A workflow starts a run on an order only
 * if the order was placed (`ShopOrder.processedAt`) on or after
 * `activatedAt`, on every path — new-order webhook, edit webhook, sync,
 * resync — so an old order Baton meets late is never touched. A workflow can
 * start runs when `activatedAt is not null and it has tasks and every task
 * is assigned to a team that exists`; `activatedAt` not null implies at
 * least one task, every one assigned at the moment of Turn on.
 * A task whose team was deleted is **unassigned** (`teamId` null, or an id
 * no D1 row carries — read as null everywhere). **Needs attention** is the
 * badge for a workflow, run, or team with an unassigned task or a team with
 * no members (on the orders index, the `team` {@link OrderNeed}, whose badge
 * reads **Needs a team**); it is derived on every read, never stored, and the
 * fix is always **assign a team** or add a member. Unassigned refuses Apply and
 * Turn on; an empty team is a warning only. Tasks change only through Apply,
 * so an order arriving between two edits sees a whole definition, never a
 * half one; the tag and the name are immediate, because runs snapshot both at
 * start. Encoded side is the Durable Object row
 * (epoch-ms integers).
 */
const WorkflowFields = {
  id: WorkflowId,
  name: WorkflowName,
  activatedAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
};

/** On: `activatedAt` is set. The one read of the switch, so no caller compares the column to null on its own. */
export const isActive = (workflow: { readonly activatedAt: number | null }) =>
  workflow.activatedAt !== null;

/** A workflow: chosen by its tag, running once per matching line item. */
export const Workflow = Schema.Struct({
  ...WorkflowFields,
  tag: WorkflowTag,
});
export type Workflow = typeof Workflow.Type;

/**
 * The draft side of {@link Workflow}: at most one per workflow (`workflowId`
 * is the primary key), holding the tasks being edited as `WorkflowDraftTask`
 * rows. The tag is not drafted; it lives on the workflow row. Nothing that
 * starts runs ever reads the draft.
 */
export const WorkflowDraft = Schema.Struct({
  workflowId: WorkflowId,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;

/**
 * `teamId` is a live pointer to a D1 `Team`, not a snapshot: renaming a team
 * renames every task it owns, and a task can only be *applied* against a
 * team that exists. `null` is **unassigned** — what a team delete leaves
 * behind — and an id no D1 row carries reads the same way. It carries no
 * `teamName`: the name is joined at read time, and only the eventual
 * instance rows snapshot it.
 *
 * Workflow tasks and draft tasks have the same shape but live in two tables
 * (`WorkflowTask`, `WorkflowDraftTask`), so a task-id write can never be
 * ambiguous about which side it targets and `unique (workflowId, position)`
 * holds on each side independently. Only `applyDraft` writes `WorkflowTask`;
 * every editor write targets the draft. Apply carries draft task ids over to
 * the workflow; Edit copies workflow tasks into the draft under new ids.
 *
 * A workflow is a sequence of numbered steps. Each step holds one or more
 * tasks, and a task is the unit a team starts and finishes: it has a name, a
 * team, and instructions. Along `position` the `step` values are dense `1..m`
 * and non-decreasing (`1 1 2 3 3`), so every task belongs to exactly one step,
 * and a step of one task is the plain linear case. Step k is ready when every
 * task of step k-1 is done. The invariant is owned by `WorkflowLayout`, which
 * recomputes the whole layout on every edit. The two nouns exist because
 * parallel work needs a wait that is not a task; the member and merchant UI
 * print "task" only when a step has more than one, so a linear shop reads
 * steps alone.
 */
export const WorkflowTask = Schema.Struct({
  id: WorkflowTaskId,
  workflowId: WorkflowId,
  position: Schema.Number,
  step: Schema.Number,
  name: TaskName,
  teamId: Schema.NullOr(TeamId),
  instructions: Schema.NullOr(TaskInstructions),
});
export type WorkflowTask = typeof WorkflowTask.Type;

export const WorkflowDraftTask = WorkflowTask;
export type WorkflowDraftTask = typeof WorkflowDraftTask.Type;

/**
 * List row. `tag` and `stepCount` describe the workflow. `needsAttention` is the
 * derived badge from {@link Workflow}: a task unassigned or on a team with no
 * members, computed against the live roster on every list read.
 */
const WorkflowSummaryRowFields = {
  stepCount: Schema.Number,
};
/** The stored half of {@link WorkflowSummary}: what one list query returns before the roster join. */
export const WorkflowSummaryRow = Schema.Struct({
  ...Workflow.fields,
  ...WorkflowSummaryRowFields,
});
export type WorkflowSummaryRow = typeof WorkflowSummaryRow.Type;

/** What the workflows page lists. */
export const WorkflowSummary = Schema.Struct({
  ...Workflow.fields,
  ...WorkflowSummaryRowFields,
  needsAttention: Schema.Boolean,
});
export type WorkflowSummary = typeof WorkflowSummary.Type;

/** The shape run creation reads: a workflow with its tasks. Drafts never appear here. */
export const WorkflowDetail = Schema.Struct({
  workflow: Workflow,
  tasks: Schema.Array(WorkflowTask),
});
export type WorkflowDetail = typeof WorkflowDetail.Type;

export const WorkflowDraftTasks = Schema.Struct({
  draft: WorkflowDraft,
  tasks: Schema.Array(WorkflowDraftTask),
});
export type WorkflowDraftTasks = typeof WorkflowDraftTasks.Type;

/** What `WorkflowRepository.getWorkflow` returns: the workflow with its tasks, and the draft with its tasks when one exists. */
export const WorkflowWithDraft = Schema.Struct({
  ...WorkflowDetail.fields,
  draft: Schema.NullOr(WorkflowDraftTasks),
});
export type WorkflowWithDraft = typeof WorkflowWithDraft.Type;

/**
 * What the detail page renders, in one socket round trip: the workflow
 * (read-only, what starts runs) and the draft (what the editor writes), each
 * with its tasks. Both attention states are derived here against the live
 * roster and never stored: `teamName` is `null` when the task is unassigned
 * (`teamId` null, or an id no team carries) — a flag, not a block in the
 * editor; the task renders with an empty picker and everything else stays
 * editable. `memberCount` is the team's live headcount (`null` when
 * unassigned) so the page can warn "No members on <team>". `teams` rides
 * along so the team picker needs no second call.
 */
const TaskWithTeamName = Schema.Struct({
  ...WorkflowTask.fields,
  teamName: Schema.NullOr(TeamName),
  memberCount: Schema.NullOr(Schema.Number),
});
export type TaskWithTeamName = typeof TaskWithTeamName.Type;

export const WorkflowDraftView = Schema.Struct({
  draft: WorkflowDraft,
  tasks: Schema.Array(TaskWithTeamName),
});
export type WorkflowDraftView = typeof WorkflowDraftView.Type;

export const WorkflowDetailView = Schema.Struct({
  workflow: Workflow,
  tasks: Schema.Array(TaskWithTeamName),
  draft: Schema.NullOr(WorkflowDraftView),
  teams: Schema.Array(TeamRoster),
});
export type WorkflowDetailView = typeof WorkflowDetailView.Type;

/** A task is unassigned when its team is null or resolves to no team; the name is the tell after the roster join. */
export const isUnassigned = (task: TaskWithTeamName) => task.teamName === null;

/** Assigned to a team nobody is on: a warning, never a blocker. */
export const hasEmptyTeam = (task: TaskWithTeamName) =>
  task.teamName !== null && task.memberCount === 0;

const BoundedId = Schema.NonEmptyString.check(Schema.isMaxLength(128));

export const WorkflowIdInput = Schema.Struct({ workflowId: BoundedId });
export type WorkflowIdInput = typeof WorkflowIdInput.Type;

export const DeleteWorkflowInput = WorkflowIdInput;
export type DeleteWorkflowInput = typeof DeleteWorkflowInput.Type;

export const CreateWorkflowInput = Schema.Struct({
  name: WorkflowName,
  tag: WorkflowTag,
});
export type CreateWorkflowInput = typeof CreateWorkflowInput.Type;

/** Name only: a rename is immediate. The tag has its own input ({@link UpdateWorkflowTagInput}) and is also immediate. */
export const UpdateWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  name: WorkflowName,
});
export type UpdateWorkflowInput = typeof UpdateWorkflowInput.Type;

/**
 * Lands on the workflow row, never on the draft: the tag is envelope state
 * like the name. Runs snapshot the tag at start, so work in flight is
 * untouched; the next order to arrive is matched against the new tag.
 */
export const UpdateWorkflowTagInput = Schema.Struct({
  workflowId: BoundedId,
  tag: WorkflowTag,
});
export type UpdateWorkflowTagInput = typeof UpdateWorkflowTagInput.Type;

/**
 * The copy's name and tag are the merchant's, prefilled by the Duplicate
 * dialog; the repository copies tasks and steps and leaves the copy off with
 * no draft ({@link WorkflowResult} carries the copy).
 */
export const DuplicateWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  name: WorkflowName,
  tag: WorkflowTag,
});
export type DuplicateWorkflowInput = typeof DuplicateWorkflowInput.Type;

export const CreateDraftInput = WorkflowIdInput;
export type CreateDraftInput = typeof CreateDraftInput.Type;

export const ApplyDraftInput = WorkflowIdInput;
export type ApplyDraftInput = typeof ApplyDraftInput.Type;

export const DiscardDraftInput = WorkflowIdInput;
export type DiscardDraftInput = typeof DiscardDraftInput.Type;

/**
 * `activatedAt` is honoured only with `active: true`: the Turn on dialog's
 * "Include them" sends the earliest waiting order's placed date so those
 * orders qualify; omitted, Turn on means now. Off always clears the date.
 */
export const SetWorkflowActiveInput = Schema.Struct({
  workflowId: BoundedId,
  active: Schema.Boolean,
  activatedAt: Schema.optionalKey(Schema.Number),
});
export type SetWorkflowActiveInput = typeof SetWorkflowActiveInput.Type;

/**
 * The editor's Turn on for a workflow that has never been applied: one click
 * that promotes the draft and turns the switch on, so the merchant is not
 * asked to Apply tasks that have never run and then turn on the thing they
 * just applied. `activatedAt` means what it means on
 * {@link SetWorkflowActiveInput}.
 */
export const ApplyAndActivateInput = Schema.Struct({
  workflowId: BoundedId,
  activatedAt: Schema.optionalKey(Schema.Number),
});
export type ApplyAndActivateInput = typeof ApplyAndActivateInput.Type;

/** The workflow page's Change control: moves the coverage date of an on workflow. */
export const SetWorkflowActivatedAtInput = Schema.Struct({
  workflowId: BoundedId,
  activatedAt: Schema.Number,
});
export type SetWorkflowActivatedAtInput =
  typeof SetWorkflowActivatedAtInput.Type;

export const AddStepInput = Schema.Struct({
  workflowId: BoundedId,
  name: TaskName,
  teamId: BoundedId,
  instructions: Schema.optionalKey(TaskInstructions),
});
export type AddStepInput = typeof AddStepInput.Type;

/** Same as {@link AddStepInput} but into an existing step: the new task lands after that step's last task and is ready together with it. */
export const AddTaskInput = Schema.Struct({
  workflowId: BoundedId,
  step: Schema.Number,
  name: TaskName,
  teamId: BoundedId,
  instructions: Schema.optionalKey(TaskInstructions),
});
export type AddTaskInput = typeof AddTaskInput.Type;

/** `instructions: null` clears; the UI maps a blank field to `null` before sending. */
export const UpdateTaskInput = Schema.Struct({
  taskId: BoundedId,
  name: TaskName,
  teamId: BoundedId,
  instructions: Schema.NullOr(TaskInstructions),
});
export type UpdateTaskInput = typeof UpdateTaskInput.Type;

/**
 * The whole workflow fixture for `ShopAgent.seedWorkflows`, tasks inline: one
 * declarative payload written in one transaction, rather than a
 * `createWorkflow` + `addStep`-per-task conversation whose failure midway
 * leaves a half-built definition. `position` is array order; `teamId` is a D1
 * `Team.id` the caller has already created, so the team check `AddStepInput`
 * exists to trigger has nothing left to catch — or `null`, which seeds the
 * task **unassigned** so the needs-attention state is visible after
 * `pnpm seed`. A task with no `step` gets the previous task's step + 1
 * (linear); the repository validates the step invariant before writing.
 *
 * `tasks` become the workflow's tasks; a fixture with no tasks and no
 * `draft` has no draft, the state the ordinary path produces for a fresh
 * workflow. `active` is the fixture's word for the switch and defaults to
 * `true` when the entry has tasks and every task is assigned; the
 * repository stores it as `activatedAt = now`, so seeded orders qualify.
 * `draft` seeds a pending draft (tasks) for fixtures that show the draft UI.
 */
const SeedWorkflowTask = Schema.Struct({
  name: TaskName,
  teamId: Schema.NullOr(TeamId),
  step: Schema.optionalKey(Schema.Number),
  instructions: Schema.optionalKey(TaskInstructions),
});

export const SeedWorkflowsInput = Schema.Struct({
  workflows: Schema.Array(
    Schema.Struct({
      name: WorkflowName,
      active: Schema.optionalKey(Schema.Boolean),
      tag: WorkflowTag,
      tasks: Schema.Array(SeedWorkflowTask),
      draft: Schema.optionalKey(
        Schema.Struct({ tasks: Schema.Array(SeedWorkflowTask) }),
      ),
    }),
  ),
});
export type SeedWorkflowsInput = typeof SeedWorkflowsInput.Type;

export const TaskDirection = Schema.Literals(["up", "down"]);
export type TaskDirection = typeof TaskDirection.Type;

/**
 * `moveTask`: the task takes a step of its own past the neighbouring
 * boundary (`WorkflowLayout.move`). Reordering never makes a task parallel
 * with another; that is `joinTask`.
 */
export const MoveTaskInput = Schema.Struct({
  taskId: BoundedId,
  direction: TaskDirection,
});
export type MoveTaskInput = typeof MoveTaskInput.Type;

export const TaskIdInput = Schema.Struct({ taskId: BoundedId });
export type TaskIdInput = typeof TaskIdInput.Type;

/** `separateTask`: the task leaves its step into a new step of its own immediately after it. */
export const SeparateTaskInput = TaskIdInput;
export type SeparateTaskInput = typeof SeparateTaskInput.Type;

/** `joinTask`: the task merges into the previous step, after that step's last member. */
export const JoinTaskInput = TaskIdInput;
export type JoinTaskInput = typeof JoinTaskInput.Type;

export const TeamIdInput = Schema.Struct({ teamId: BoundedId });
export type TeamIdInput = typeof TeamIdInput.Type;

/**
 * Expected failures cross the socket as values, not throws: `runEffect`
 * collapses every failure into one `Error(message)` at the RPC seam, which is
 * fine for faults but loses the tag the page needs to put "tag taken" on the
 * tag field rather than in a banner.
 *
 * `TagTaken` carries the holder's `workflowId` as well as its name because a
 * name no longer identifies a workflow: two may share one, so the refusal
 * links to the holder rather than naming it and leaving the merchant to guess
 * which of two rows it meant.
 */
export const WorkflowResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({
    _tag: Schema.Literal("TagTaken"),
    tag: WorkflowTag,
    workflowId: WorkflowId,
    workflowName: WorkflowName,
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Limit"), limit: Schema.Number }),
]);
export type WorkflowResult = typeof WorkflowResult.Type;

/** `TaskUnassigned` names the offending tasks so the page can say which to assign. Apply is about tasks only; the tag never reaches it. */
export const ApplyResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NoDraft") }),
  Schema.Struct({ _tag: Schema.Literal("NoTasks") }),
  Schema.Struct({
    _tag: Schema.Literal("TaskUnassigned"),
    taskNames: Schema.Array(TaskName),
  }),
]);
export type ApplyResult = typeof ApplyResult.Type;

/** Discard is always allowed; on a never-applied workflow it leaves zero tasks and no draft. */
export const DiscardResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NoDraft") }),
]);
export type DiscardResult = typeof DiscardResult.Type;

/** Edit. Idempotent: an existing draft is returned as `Ok`, so a merchant resuming is the same click. */
export const DraftResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), draft: WorkflowDraft }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type DraftResult = typeof DraftResult.Type;

/**
 * `started` is how many runs the reconcile-all after the switch created. Turn
 * on starts runs on waiting orders; Turn **off** can start them too, because
 * removing one of two matching workflows resolves an ambiguity and the
 * survivor's runs begin — so the toast must read for both directions.
 */
export const ActivateResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    workflow: Workflow,
    started: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NoTasks") }),
  Schema.Struct({
    _tag: Schema.Literal("TaskUnassigned"),
    taskNames: Schema.Array(TaskName),
  }),
]);
export type ActivateResult = typeof ActivateResult.Type;

/** `Off`: the workflow is not on, so there is no coverage date to move. */
export const ChangeActivatedAtResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    workflow: Workflow,
    started: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Off") }),
]);
export type ChangeActivatedAtResult = typeof ChangeActivatedAtResult.Type;

/**
 * What the Turn on dialog asks about: orders already stored, unfulfilled and
 * not cancelled, that would match the workflow if its date allowed them —
 * paid or not, because an unpaid one qualifies the day it pays.
 * `earliestProcessedAt` is what "Include them" sends as `activatedAt`.
 */
export const WaitingOrders = Schema.Struct({
  count: Schema.Number,
  earliestProcessedAt: Schema.NullOr(Schema.Number),
});
export type WaitingOrders = typeof WaitingOrders.Type;

export const CountWaitingOrdersInput = WorkflowIdInput;
export type CountWaitingOrdersInput = typeof CountWaitingOrdersInput.Type;

export const TaskResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    task: Schema.NullOr(WorkflowTask),
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Limit"), limit: Schema.Number }),
  /** The picked team no longer exists in D1: it was deleted under the editor. */
  Schema.Struct({ _tag: Schema.Literal("TeamNotFound") }),
]);
export type TaskResult = typeof TaskResult.Type;

/** Delete a workflow and its runs stay on their orders. */
export const DeleteWorkflowResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Deleted") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type DeleteWorkflowResult = typeof DeleteWorkflowResult.Type;

/**
 * Delete a team and its tasks become unassigned; nothing refuses. `Deleted`
 * is "the D1 row was removed in this call"; a retry after a partial failure
 * still nulls every pointer and reports `NotFound`.
 */
export const DeleteTeamResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Deleted") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type DeleteTeamResult = typeof DeleteTeamResult.Type;

export const DeleteTeamInput = TeamIdInput;
export type DeleteTeamInput = typeof DeleteTeamInput.Type;

/**
 * What the team delete dialog states: every pointer the delete will null.
 * Workflow and draft tasks are configuration; `openRunTasks` are work in
 * progress that will wait until someone assigns a team.
 */
export const TeamDeleteCounts = Schema.Struct({
  workflowTasks: Schema.Number,
  draftTasks: Schema.Number,
  openRunTasks: Schema.Number,
});
export type TeamDeleteCounts = typeof TeamDeleteCounts.Type;

/** One row per team that owns anything; a team absent from the list owns nothing. */
export const TeamTaskCounts = Schema.Struct({
  teamId: TeamId,
  ...TeamDeleteCounts.fields,
});
export type TeamTaskCounts = typeof TeamTaskCounts.Type;

/** A workflow that uses a team: a task of the workflow or of its draft points at it. The team pages' "Used by" lists. */
export const TeamWorkflow = Schema.Struct({
  workflowId: WorkflowId,
  workflowName: WorkflowName,
});
export type TeamWorkflow = typeof TeamWorkflow.Type;

/** {@link TeamWorkflow} for every team at once, keyed by team: the teams index's "Used by" column in one object read. */
export const TeamWorkflowByTeam = Schema.Struct({
  teamId: TeamId,
  ...TeamWorkflow.fields,
});
export type TeamWorkflowByTeam = typeof TeamWorkflowByTeam.Type;

/** Assign a team to any open run task: the remedy that makes team delete safe, and the merchant's way to move work between teams. */
export const AssignRunTaskTeamInput = Schema.Struct({
  runTaskId: BoundedId,
  teamId: BoundedId,
});
export type AssignRunTaskTeamInput = typeof AssignRunTaskTeamInput.Type;

/**
 * Any open task reassigns, started or not: only `teamId` / `teamName` move,
 * so `startedBy` / `startedByEmail` stay and history keeps whoever began it.
 * `TaskFinished` refuses a completed task because the write would overwrite
 * `teamName`, the record of which team completed it.
 */
export const AssignRunTaskTeamResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Assigned") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("TeamNotFound") }),
  Schema.Struct({ _tag: Schema.Literal("TaskFinished") }),
  /** The task's run is not {@link runIsOpen}; see the {@link RunStatus} table. */
  Schema.Struct({ _tag: Schema.Literal("RunNotOpen") }),
]);
export type AssignRunTaskTeamResult = typeof AssignRunTaskTeamResult.Type;

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
 * Which ingestion path last wrote a `ShopOrder` row. Diagnostic, not control
 * flow: every path runs the same `updatedAt`-guarded upsert, so the value
 * only answers "how did this row get here" when a sync looks wrong.
 */
export const OrderSyncSource = Schema.Literals(["webhook", "bulk", "manual"]);
export type OrderSyncSource = typeof OrderSyncSource.Type;

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
 */
export const ShopOrder = Schema.Struct({
  id: Schema.String,
  legacyId: Schema.String,
  name: Schema.String,
  /**
   * Shopify's `processedAt`: the date shown under the order number in the
   * admin, the one importers back-date, and the only date Baton compares
   * (against `Workflow.activatedAt`). Shopify's `createdAt` (the row
   * timestamp) is deliberately not persisted so nobody has to ask which one
   * matters.
   */
  processedAt: Schema.Number,
  updatedAt: Schema.Number,
  cancelledAt: Schema.NullOr(Schema.Number),
  closedAt: Schema.NullOr(Schema.Number),
  financialStatus: Schema.NullOr(Schema.String),
  fulfillmentStatus: Schema.String,
  fullyPaid: SqliteBoolean,
  note: Schema.NullOr(Schema.String),
  customAttributes: Schema.fromJsonString(Schema.Array(OrderAttribute)),
  /**
   * Whether line items were **dropped** on the way in, past
   * {@link ShopLimits.maxLineItemsPerOrder}. Both paths ask Shopify for that
   * many and neither pages, so this is the whole of "the stored set is short
   * of the order" — see {@link OrderRepository.upsertOrder}, which states the
   * rule. The order page warns on it; nothing else reads it.
   */
  lineItemsTruncated: SqliteBoolean,
  syncedAt: Schema.Number,
  syncSource: OrderSyncSource,
});
export type ShopOrder = typeof ShopOrder.Type;

/**
 * `productTags` is a **snapshot** taken at sync time, not a live read: a
 * resync overwrites it. A run copies the definition it started from, so a
 * merchant retagging a product cannot silently rewrite history.
 *
 * `currentQuantity` is the number of units still to be made
 * ({@link unitsToMake}): Shopify lowers it on a merchant edit and on a refund,
 * and on nothing else. Fulfillment does not move it, which is why a line
 * shipped early still reads as work until the whole order is `FULFILLED`
 * ({@link isFulfilled}). `quantity` stays as "ordered" for display.
 *
 * `matchedWorkflowIds` is the active, startable workflows whose tag matched
 * this item at the last reconcile, whether or not a run was started. Two or
 * more with no live run is an **ambiguity** the merchant resolves from the
 * order page; the picker there offers these first, then every other active
 * workflow. Written by reconcile
 * only — the order sync writes `[]`, because matching happens after the write,
 * inside `afterWrite`.
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
  productTags: Schema.fromJsonString(Schema.Array(Schema.String)),
  matchedWorkflowIds: Schema.fromJsonString(Schema.Array(WorkflowId)),
  customAttributes: Schema.fromJsonString(Schema.Array(OrderAttribute)),
  requiresShipping: SqliteBoolean,
});
export type OrderLineItem = typeof OrderLineItem.Type;

/**
 * The creation gate, and only that: whether reconcile may *start* new runs on
 * the order. Deliberately not the stop gate — an edit that pushes a paid order
 * back to `fullyPaid = false` must leave work in progress alone, so only
 * {@link isCancelled} cancels or flags existing runs. `AUTHORIZED` is not
 * treated as paid; manual-capture shops would need a clause here.
 */
export const canStartRuns = (order: ShopOrder) =>
  order.fullyPaid && order.cancelledAt === null;

/** The stop gate: the one order state that cancels pending runs and flags active ones. */
export const isCancelled = (order: ShopOrder) => order.cancelledAt !== null;

/** Shopify reported every fulfillable unit shipped; nothing is left to make or pack. */
export const isFulfilled = (order: ShopOrder) =>
  order.fulfillmentStatus === "FULFILLED";

/**
 * Whether the merchant may attach a workflow to one of this order's line
 * items by hand (`ShopAgent.attachWorkflow`).
 *
 * Manual attach is the merchant overriding the tag, activation-date and
 * payment gates on purpose; it is not an override of the order being over. A
 * cancelled or fully fulfilled order has no work left, so attach is refused —
 * reconcile would only cancel or flag the run on its next pass. Unpaid is
 * deliberately allowed: the merchant may start work on a deposit, which is
 * the same judgement {@link canStartRuns} withholds from *automatic* starts.
 * Attaching is starting work, so it bills the order like any first run
 * (`OrderRepository.countOrder`) — the one way an order Shopify has not been
 * paid for is metered, and the merchant chose it.
 */
export const canAttachRun = (order: ShopOrder) =>
  !isCancelled(order) && !isFulfilled(order);

/**
 * Units a maker should see and a run should snapshot. `currentQuantity`, not
 * `quantity`: an edit or a refund lowers it, and neither leaves work a maker
 * should still do. Fulfillment is deliberately not in it — Shopify leaves
 * `currentQuantity` alone when a unit ships, so a line shipped ahead of the
 * rest of the order stays open work until the order reaches `FULFILLED`, which
 * is the one fulfillment state Baton acts on ({@link isFulfilled}).
 */
export const unitsToMake = (lineItem: OrderLineItem) =>
  lineItem.currentQuantity;

export const OrderDetail = Schema.Struct({
  order: ShopOrder,
  lineItems: Schema.Array(OrderLineItem),
});
export type OrderDetail = typeof OrderDetail.Type;

/** Ids of seeded orders carry this prefix so a reseed replaces only fixture rows and never a synced order. */
export const SEED_ORDER_ID_PREFIX = "gid://shopify/Order/seed-";

/**
 * A fixture order, by its id. Seeded orders still count toward
 * {@link ShopUsage.ordersThisCycle} — that is what lets a prototyping shop
 * exercise the quota banner — but they must never reach Shopify's usage meter,
 * because a fixture that bills is a fixture that costs money. The counter is
 * local and reversible (`OrderRepository.deleteSeedOrders` subtracts on the
 * next reseed); a billing event is neither, since Shopify enforces idempotency
 * keys permanently.
 */
export const orderIsSeeded = (orderId: string) =>
  orderId.startsWith(SEED_ORDER_ID_PREFIX);

/**
 * Progress for one seeded run: `done` completes every task; `advance`
 * completes that many rounds of ready tasks; `started` then Starts what is
 * ready; `blocked` flags the run.
 */
const SeedProgressFields = {
  done: Schema.optionalKey(Schema.Boolean),
  /**
   * Rounds of progress before the run is left alone: each round completes
   * every task that was *ready* when the round began, and what that makes
   * ready waits for the next. `advance: 1` on a three-step item is "step 1
   * done, step 2 up next". `done` is the limit of this.
   */
  advance: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  /** After `advance`, Start what is ready so the run list shows "In progress since … by <seed member>". */
  started: Schema.optionalKey(Schema.Boolean),
  /**
   * Record the `done` / `advance` / `blocked` progress as the **merchant**
   * rather than the seed member, for a fixture of a merchant intervention
   * ("Done by Merchant", "Blocked by Merchant"). `started` stays the
   * member's whatever this says: there is no merchant Start — the merchant
   * records work, they do not claim it.
   */
  byMerchant: Schema.optionalKey(Schema.Boolean),
  /** After `advance`, flag the run `blocked` with this reason, the state a worker's Block leaves. */
  blocked: Schema.optionalKey(BlockReason),
} as const;

/**
 * `done` and `advance` are exclusive rather than merely undocumented
 * together: the seed runs `done` first, which leaves nothing ready, so
 * `advance` beside it is a silent no-op and the fixture row would read as
 * something it is not.
 */
const doneAndAdvanceExclusive = Schema.makeFilter(
  (progress: {
    readonly done?: boolean | undefined;
    readonly advance?: number | undefined;
  }) =>
    progress.done !== true ||
    progress.advance === undefined ||
    "done and advance are exclusive",
);

export const SeedProgress = Schema.Struct(SeedProgressFields).check(
  doneAndAdvanceExclusive,
);
export type SeedProgress = typeof SeedProgress.Type;

/**
 * A second state for an order, applied by the seed after progress: see `after`
 * on {@link SeedOrdersInput} for why it is a phase of its own.
 */
export const SeedOrderChange = Schema.Struct({
  cancelled: Schema.optionalKey(Schema.Boolean),
  fulfillmentStatus: Schema.optionalKey(Schema.String),
  /** By 1-based position in `lineItems`; a quantity left out keeps what the first write gave it. */
  lineItems: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        position: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
        currentQuantity: Schema.optionalKey(Schema.Number),
      }),
    ),
  ),
});
export type SeedOrderChange = typeof SeedOrderChange.Type;

/**
 * Local-only order fixture, written through the ordinary upsert-and-reconcile
 * path so runs start exactly as they would for a webhook. `currentQuantity`
 * defaults to `quantity`; lowering it seeds an edit or a refund.
 *
 * Each order is written in four phases, in this order, and the order is what
 * makes the interesting states reachable: upsert + reconcile, then each item's
 * `workflowId`, then progress, then `after`. Progress is per run — an item with
 * its own `progress` uses that, every other run of the order uses the order's
 * own keys — which is what puts one order's items in different states.
 */
export const SeedOrdersInput = Schema.Struct({
  memberId: MemberId,
  memberEmail: Email,
  orders: Schema.Array(
    Schema.Struct({
      /** Numeric suffix: the id becomes `SEED_ORDER_ID_PREFIX + n` and the name `#<n>`. */
      n: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      fulfillmentStatus: Schema.optionalKey(Schema.String),
      /** `PENDING`, `fullyPaid: false`: no runs are created, and the row reads as unpaid rather than "No workflow". */
      unpaid: Schema.optionalKey(Schema.Boolean),
      /** The progress every run of this order takes unless its own item overrides it. */
      ...SeedProgressFields,
      note: Schema.optionalKey(Schema.String),
      lineItems: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          quantity: Schema.Number,
          currentQuantity: Schema.optionalKey(Schema.Number),
          tags: Schema.Array(Schema.String),
          customAttributes: Schema.optionalKey(Schema.Array(OrderAttribute)),
          /** This item's run alone; the order's own progress keys are ignored for it. */
          progress: Schema.optionalKey(SeedProgress),
          /**
           * A workflow to set on this item after reconcile, exactly as the
           * merchant's Choose / Change does (`setRun`, source `manual`):
           * resolves an ambiguous item, or attaches where no tag matched.
           * Applied before progress so the run it creates is one the rounds
           * below then advance. Callers above this schema name the workflow
           * instead — ids are minted by the seed moments earlier — and
           * `api.dev.seed.ts` maps the name to the id.
           */
          workflowId: Schema.optionalKey(Schema.String),
        }),
      ),
      /**
       * A second state for the order, written after progress as another
       * `upsertOrder` with `afterWrite: reconcile`, so its runs come to carry
       * the flags a webhook would produce: `order_cancelled`,
       * `order_fulfilled`, `quantity_changed`, `item_removed`. Second on
       * purpose — reconcile on an already-cancelled or already-fulfilled
       * order returns before creating anything, so the first write has to be
       * the order as it stood when the work started.
       */
      after: Schema.optionalKey(SeedOrderChange),
    }).check(doneAndAdvanceExclusive),
  ),
});
export type SeedOrdersInput = typeof SeedOrdersInput.Type;

/**
 * The single `SyncState` row: what the last import left behind, and nothing
 * else. Whether one is running now is not stored — the Agents SDK's own
 * `cf_agents_workflows` row is the only run tracker ({@link
 * OrdersSyncStatus.inFlight}) — because two records of the same fact drift
 * the moment a workflow dies without reporting.
 *
 * `lastError` is the banner on the orders index and survives until the next
 * import starts; `lastCompletedAt` is "Last imported" and is written by
 * `onWorkflowComplete`, not by the stream, so a file that streams halfway and
 * then fails never claims a completed import.
 */
export const SyncState = Schema.Struct({
  lastError: Schema.NullOr(Schema.String),
  lastCompletedAt: Schema.NullOr(Schema.Number),
});
export type SyncState = typeof SyncState.Type;

/** {@link SyncState} as the orders view carries it, plus whether an import is tracked as running right now. */
export const OrdersSyncStatus = Schema.Struct({
  inFlight: Schema.Boolean,
  ...SyncState.fields,
});
export type OrdersSyncStatus = typeof OrdersSyncStatus.Type;

/**
 * An order's lifecycle position: one per order, derived from the order row
 * and its run counts on every read and never stored. `null` (no value) is an
 * open order with no runs — not started — which shows under Open and All
 * only. Problems are not positions: an order in production can also be
 * blocked or waiting on a workflow choice, so those live on {@link OrderNeed}
 * and an order carries any number of them beside its one position.
 *
 * Never stored is what makes the packer's round trip automatic — fulfil in
 * Shopify, `orders/fulfilled` stores `FULFILLED`, the next read says
 * `shipped`, and the order leaves the Ready-to-ship list without anyone
 * touching Baton.
 *
 * The rule is a function, not a table: {@link productionState} is the one
 * definition, and the SQL filters in `OrderRepository.listOrders` restate its
 * branches and must move with it. Readers (`app.orders.index.tsx`) switch on
 * the value for labels and filters only; no site decides anything by
 * comparing it inline.
 */
export const ProductionState = Schema.Literals([
  "in_production",
  "ready_to_ship",
  "shipped",
  "cancelled",
]);
export type ProductionState = typeof ProductionState.Type;

/**
 * The orders index's Status row, which is {@link ProductionState} plus one
 * value that is not a position.
 *
 * `null` is **open work**: everything except `shipped` and `cancelled`,
 * not-started orders included. It is the default because retention keeps a
 * year of orders ({@link ShopLimits.orderRetentionDays}) and a merchant
 * opening Orders is looking at the bench, not at the year. `"all"` is the
 * escape hatch that shows the closed ones too, and is the only value here
 * that crosses the open and closed sets — which is why it is not a
 * `ProductionState`: nothing derives it from an order, and `productionState`
 * must never return it. `"cancelled"` is a legal value with no button.
 */
export const OrdersStatus = Schema.Union([
  ProductionState,
  Schema.Literal("all"),
]);
export type OrdersStatus = typeof OrdersStatus.Type;

/**
 * A problem on an open order that the merchant has a remedy for: the orders
 * index's Needs row, in the order of that row. The one definition is
 * {@link orderNeeds}; the SQL predicates in `OrderRepository.listOrders`
 * restate each element and must move with it.
 *
 * | Need              | Rule                                                                                         | Remedy                                              |
 * | ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
 * | `no_workflow`     | paid, uncancelled, unfulfilled, no live run on any item, and no ambiguous item                | attach a workflow on the order page                 |
 * | `choose_workflow` | `ambiguousItems > 0` and the order can start runs ({@link canStartRuns})                      | choose a workflow on the order page                 |
 * | `team`            | {@link OrderRow} `attention`                                                                  | assign a team on the order page, or staff the team  |
 * | `blocked`         | `runs.blocked > 0`                                                                            | the order page                                      |
 * | `changed`         | `runs.flagged > 0`                                                                            | accept the change on the order page                 |
 *
 * An unpaid order with an ambiguous item is not choosing: reconcile would not
 * start a run on it whichever workflow was chosen, so there is no decision
 * waiting yet.
 *
 * A need is only ever on an open order (uncancelled, unfulfilled): a closed
 * order has no work left, and a stale flag on it is not a to-do. Needs are
 * independent of each other and of the {@link ProductionState}: one order can
 * carry several, and an order in production can be waiting on a choice for
 * another item at the same time.
 */
export const OrderNeed = Schema.Literals([
  "no_workflow",
  "choose_workflow",
  "team",
  "blocked",
  "changed",
]);
export type OrderNeed = typeof OrderNeed.Type;

/**
 * Keyset cursor over `(processedAt desc, id desc)`, encoded as
 * `<processedAt>:<id>`. Not an offset: the bulk stream and webhooks both insert
 * while a merchant pages, and `limit/offset` would drop or repeat rows under
 * those writes.
 *
 * The shape is checked, not just the length: the cursor rides the orders URL
 * as `?after=` (`OrdersSearch` in `app.orders.tsx`), where a value that does
 * not decode reads as page one. Text that is not a cursor at all would
 * otherwise pass, be read as page one by the repository, and still light
 * Previous, because the page is "not page one" whenever `after` is present.
 */
export const OrdersCursor = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^\d+:.+$/u),
);

/**
 * What the merchant types into the order-number field. Trimmed and capped
 * because it reaches SQL as a `like` pattern: an order name is `#` plus a
 * handful of digits, so anything past 32 characters is not a search anyone
 * can satisfy, and letting it through would only widen the scan. `#` alone
 * (or `##`) is refused too: {@link normaliseOrderSearch} would reduce it to
 * `#`, a prefix every order name shares, and a chip reading `Order #` over
 * the whole list is not a search either.
 */
export const OrderSearch = trimmedText("OrderSearch", 32).check(
  Schema.makeFilter(
    (q) => q.replace(/^#+/u, "").length > 0 || "an order number, not just #",
  ),
);
export type OrderSearch = typeof OrderSearch.Type;

/**
 * `1001`, `#1001`, ` #1001 ` all mean the order named `#1001`. Shopify writes
 * `ShopOrder.name` with the `#`, the merchant reads the number off the admin
 * and may or may not type it, so the one normalisation lives here and both the
 * SQL and the route's chip call it — a chip that said `1001` while the query
 * matched `#1001` would be two facts where there is one.
 */
export const normaliseOrderSearch = (q: string): string =>
  `#${q.trim().replace(/^#+/u, "")}`;

/**
 * `subscriberId` is what subscribes the calling connection to invalidations —
 * the `subscribe<Feature>` convention documented on `ShopAgent.subscribeOrders`.
 * A page that only reads is a page that never hears about a write: the Durable
 * Object publishes to subscribed connections only, and the `/app` socket is
 * shared, so a route that read without subscribing would go silent the moment
 * another route's unmount unsubscribed the connection.
 */
export const ListOrdersInput = Schema.Struct({
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 50 }),
  ),
  cursor: Schema.NullOr(OrdersCursor),
  /**
   * Order-number search, matched against `ShopOrder.name` after
   * {@link normaliseOrderSearch}: `null` is no search.
   *
   * Always send the key, for the same reason as `team`.
   */
  q: Schema.NullOr(OrderSearch),
  /**
   * {@link OrdersStatus}: `null` is open work, `"all"` is every order, and
   * each position has a SQL form in `OrderRepository.listOrders` that
   * restates `productionState`. Always send the key, for the same reason as
   * `team`.
   */
  status: Schema.NullOr(OrdersStatus),
  /**
   * {@link OrderNeed}: `null` is any ("Anything"); a need keeps only open
   * orders {@link orderNeeds} gives it, under any status, `"all"` included.
   * Always send the key, for the same reason as `team`.
   */
  need: Schema.NullOr(OrderNeed),
  /**
   * `null` is any team; an id keeps only orders waiting on that team
   * ({@link OrderRow} `waitingOn`, open orders only) — the run list's own
   * readiness predicate, not "owns a task somewhere in the run". The looser reading pulls in orders the team
   * finished days ago and orders it will not touch for two more steps, so
   * the label carries the predicate.
   *
   * Always send the key. `subscribeOrders` parses with
   * `onExcessProperty: "error"`, and an omitted key is a different failure
   * than a null one.
   */
  team: Schema.NullOr(TeamId),
});
export type ListOrdersInput = typeof ListOrdersInput.Type;

export const SubscribeOrdersInput = Schema.Struct({
  ...ListOrdersInput.fields,
  subscriberId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type SubscribeOrdersInput = typeof SubscribeOrdersInput.Type;

export const ResyncOrderInput = Schema.Struct({
  orderId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type ResyncOrderInput = typeof ResyncOrderInput.Type;

/**
 * Per-order production state for the index table, aggregated from
 * `WorkflowRun` rows in the same read. Counts every run on the order.
 * `open` counts `pending` and `active`
 * runs; cancelled runs count nowhere, so an order whose only runs were
 * cancelled reads as "No workflow" — which is what an admin has to act on.
 *
 * `flagged` and `blocked` are disjoint because `WorkflowRun.flag` is a single
 * column, and they are two counters rather than one because the merchant's
 * next click differs: `blocked` is a person waiting on them right now, so the
 * remedy is the order page and probably an intervention, while a reconcile
 * flag is Shopify having moved under a live run and the remedy is usually to
 * accept it and move on.
 */
export const RunCounts = Schema.Struct({
  open: Schema.Number,
  done: Schema.Number,
  /** Open runs carrying a reconcile flag (`RunFlag` other than `blocked`): the order moved under a live run. */
  flagged: Schema.Number,
  /** Open runs a worker or the merchant blocked. Disjoint from `flagged`: a run has one flag. */
  blocked: Schema.Number,
});
export type RunCounts = typeof RunCounts.Type;

/**
 * One index row. `itemUnits` is the sum of `currentQuantity`, not the number
 * of line-item rows: a cancelled or edited-down order keeps its line items and
 * drops their current quantity to zero, and the admin shows those as
 * "0 items". Line items themselves are not carried; the detail page reads them.
 */
export const OrderRow = Schema.Struct({
  order: ShopOrder,
  itemUnits: Schema.Number,
  runs: RunCounts,
  /**
   * **Needs a team**, derived at read time against the live D1 roster and
   * never stored: an open run has an open task that is unassigned (`teamId`
   * null or no longer in the roster) or a ready task on a team with no
   * members. The order page's "Assign team" picker and the members screen
   * are the remedies; either clears this with no further write.
   *
   * It is the `team` element of {@link orderNeeds}, and the row badge reads
   * "Needs a team".
   */
  attention: Schema.Boolean,
  /**
   * Teams with a ready task on an open run of this order, distinct, as ids:
   * "who is holding it", answered at the altitude the list grows with — a
   * shop has a handful of teams, while its runs are a cross product of line
   * items and matching workflows.
   *
   * **Only an open order waits on a team**: a shipped or cancelled order's
   * list is empty. Its open runs are the leftovers reconcile flagged
   * (`order_fulfilled`, `order_cancelled`); a flag refuses Start and Done, so
   * the team cannot move them, and the only action left is the worker's
   * Dismiss on their own run list. Naming the team on the order would read as
   * a hold-up on work that is over. This is the same line
   * {@link OrderNeed} draws: needs are open-only too.
   *
   * Unassigned ready tasks contribute nothing, and neither does a team that
   * has left the roster: both are `attention`, and rendering one fault in two
   * cells makes it look like two alarms. A blocked run contributes nothing
   * either: its team cannot move it, and `RunCounts.blocked` is its alarm. A
   * team still on the roster but with
   * no members does contribute: it is `attention` too, but the badge names
   * the team the merchant has to staff. So an order in production with an
   * empty list is exactly an order whose every ready task is unassigned or
   * on a deleted team, which is when the critical badge is showing.
   *
   * Ids, not names: the Durable Object has no team names. The route resolves
   * them through `OrdersView.teams`, the roster the page was read against.
   */
  waitingOn: Schema.Array(TeamId),
  /**
   * How many of the order's line items are **ambiguous**: two or more
   * `matchedWorkflowIds`, units still to make, and no live run. Derived per
   * read like {@link RunCounts}, never stored, so a cancel that leaves an item
   * with two matches and no run reads as ambiguous again without another
   * reconcile. See {@link ambiguousItems} for the shared definition.
   */
  ambiguousItems: Schema.Number,
});
export type OrderRow = typeof OrderRow.Type;

/**
 * The {@link ProductionState} of an order. `null` is an open order with no
 * runs, paid or not: not started. Whether that is a problem is
 * {@link orderNeeds}' question (`no_workflow`), not this one's.
 *
 * Cancelled wins over everything because it is the only stop gate; `shipped`
 * is checked next, before the run counts, so an order fulfilled with runs
 * still open reads as shipped (the runs carry the `order_fulfilled` flag) and
 * an order fulfilled with no runs at all — every historical order the window
 * sync pulls in — reads as shipped. The open positions then follow the run
 * counts alone: any open run is `in_production`, only finished runs is
 * `ready_to_ship`. The SQL forms in `OrderRepository.listOrders` restate these
 * branches and must move with them.
 *
 * Takes the two fields it reads rather than a whole `OrderRow`, so the order
 * page — which rebuilds the aggregate from its own run list — does not have
 * to invent a value for every row field the index adds later.
 */
export const productionState = ({
  order,
  runs,
}: Pick<OrderRow, "order" | "runs">): ProductionState | null =>
  Match.value({
    cancelled: isCancelled(order),
    fulfilled: isFulfilled(order),
    none: runs.open === 0 && runs.done === 0,
    open: runs.open > 0,
  }).pipe(
    Match.withReturnType<ProductionState | null>(),
    Match.when({ cancelled: true }, () => "cancelled"),
    Match.when({ fulfilled: true }, () => "shipped"),
    Match.when({ none: true }, () => null),
    Match.when({ open: true }, () => "in_production"),
    Match.orElse(() => "ready_to_ship"),
  );

/**
 * The {@link OrderNeed}s of one order, in `OrderNeed` order; `[]` for a
 * cancelled or fulfilled order. The row badges render this result and the
 * Needs filter restates each element in SQL.
 *
 * `no_workflow` tests fulfilment itself because {@link canStartRuns} reads
 * paid and uncancelled only: a fulfilled order with no runs is every
 * historical order the window sync pulled in, and is not a to-do.
 */
export const orderNeeds = ({
  order,
  runs,
  attention,
  ambiguousItems,
}: Pick<
  OrderRow,
  "order" | "runs" | "attention" | "ambiguousItems"
>): readonly OrderNeed[] => {
  if (isCancelled(order) || isFulfilled(order)) return [];
  const need: Record<OrderNeed, boolean> = {
    no_workflow:
      canStartRuns(order) &&
      runs.open === 0 &&
      runs.done === 0 &&
      ambiguousItems === 0,
    choose_workflow: canStartRuns(order) && ambiguousItems > 0,
    team: attention,
    blocked: runs.blocked > 0,
    changed: runs.flagged > 0,
  };
  return OrderNeed.literals.filter((literal) => need[literal]);
};

/**
 * The index's per-order ambiguity count, recomputed from a detail page's line
 * items and run list so both pages share one definition — the SQL in
 * `OrderRepository.listOrders` restates it and must move with it.
 *
 * "Live" is {@link runIsLive}: a `done` run means the item was routed and
 * finished, and a finished item does not get a second route.
 */
export const ambiguousItems = (
  lineItems: readonly OrderLineItem[],
  runs: readonly WorkflowRun[],
): number =>
  lineItems.filter(
    (lineItem) =>
      lineItem.matchedWorkflowIds.length >= 2 &&
      unitsToMake(lineItem) > 0 &&
      !runs.some((run) => run.lineItemId === lineItem.id && runIsLive(run)),
  ).length;

/** The index's per-order aggregate, recomputed from a detail page's run list so both pages share one definition. */
export const runCounts = (runs: readonly WorkflowRun[]): RunCounts =>
  runs.reduce<RunCounts>(
    (counts, run) => {
      const open = runIsOpen(run);
      return {
        open: counts.open + (open ? 1 : 0),
        done: counts.done + (run.status === "done" ? 1 : 0),
        flagged:
          counts.flagged +
          (open && run.flag !== null && run.flag !== "blocked" ? 1 : 0),
        blocked: counts.blocked + (open && run.flag === "blocked" ? 1 : 0),
      };
    },
    { open: 0, done: 0, flagged: 0, blocked: 0 },
  );

/**
 * The counts on the orders index's Status and Needs buttons.
 *
 * **A count is what pressing that button would show, given every other
 * filter.** A status count honours the selected need, the team and the
 * search; a need count honours the selected status, the team and the search.
 * Neither honours its own row, or pressing a button would read "0" on every
 * sibling of the pressed one.
 *
 * Both are computed over open orders only. They are read through the partial
 * index over unfulfilled, uncancelled orders, so a count costs one row per
 * open order, not one per order ever stored. So `shipped` and `all` carry no
 * status count — on a shop with years of history that would be a full-table
 * read on every refresh of a subscribed page — and under status `shipped` (or
 * `cancelled`) the need counts are all zero and the route hides the row,
 * while the status counts still read as the open positions they would show.
 *
 * Refreshes are bounded by the subscribed page's invalidation throttle,
 * `INVALIDATION_THROTTLE_MS` in `useSubscribedQuery` (2 s), not by anything
 * here.
 */
export const OrderCounts = Schema.Struct({
  in_production: Schema.Number,
  ready_to_ship: Schema.Number,
  no_workflow: Schema.Number,
  choose_workflow: Schema.Number,
  team: Schema.Number,
  blocked: Schema.Number,
  changed: Schema.Number,
});
export type OrderCounts = typeof OrderCounts.Type;

export const OrdersPage = Schema.Struct({
  orders: Schema.Array(OrderRow),
  limit: Schema.Number,
  nextCursor: Schema.NullOr(OrdersCursor),
  counts: OrderCounts,
});
export type OrdersPage = typeof OrdersPage.Type;

/**
 * The detail page is addressed by `legacyId`, not the GID: the GID contains
 * slashes, and the legacy id is what the Shopify admin puts in its own URL.
 */
export const GetOrderDetailInput = Schema.Struct({
  legacyId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type GetOrderDetailInput = typeof GetOrderDetailInput.Type;

export const SubscribeOrderInput = Schema.Struct({
  ...GetOrderDetailInput.fields,
  /** Subscribes the connection to pushes; see `SubscribeOrdersInput`. */
  subscriberId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type SubscribeOrderInput = typeof SubscribeOrderInput.Type;

/**
 * A Shopify bulk operation as the sync workflow observes it.
 *
 * `objectCount` and `fileSize` are `UnsignedInt64`, which Shopify serializes as
 * a string in some responses and a number in others; both are accepted rather
 * than guessing, and the value is only ever logged or compared against zero.
 *
 * Crosses a `step.do` boundary, so every field must survive JSON.
 */
/**
 * Shopify's enum, stored as read. The one rule on it: only `COMPLETED` has
 * a result to download ({@link bulkOperationCompleted}); every other value
 * is a failure or still running, and `OrdersSyncWorkflow` fails the step.
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

/** See {@link BulkOperationStatus}. */
export const bulkOperationCompleted = (operation: {
  readonly status: BulkOperationStatus;
}) => operation.status === "COMPLETED";

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
 * What the Import open orders button is told it did. `in_flight` is an import
 * already tracked as running, `refused` is a refusal recorded on
 * {@link SyncState.lastError} for the banner to carry; neither is an error,
 * and in all three cases the page re-reads the view.
 */
export const OrdersSyncResult = Schema.Struct({
  status: Schema.Literals(["started", "in_flight", "refused"]),
});
export type OrdersSyncResult = typeof OrdersSyncResult.Type;

/** Everything `/app/orders` renders, in one socket round trip. */
export const OrdersView = Schema.Struct({
  page: OrdersPage,
  syncState: OrdersSyncStatus,
  /**
   * The live D1 roster the page was read against — the same list `attention`
   * and `OrderRow.waitingOn` were derived from, carried so the route can name
   * the waiting-on ids and fill the team filter without a second read.
   */
  teams: Schema.Array(TeamRoster),
});
export type OrdersView = typeof OrdersView.Type;

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

/**
 * `<RoutePrefix>LoaderData` names the data contract for a route's loader,
 * owned by that route. The prefix derives mechanically from the route id —
 * tail segment (`admin.shop.$shop` → `AdminShop`), parent + `Index` for index
 * routes (`app.index` → `AppIndex`), extended leftward on collision — never
 * from UX vocabulary. Ownership, not exclusivity: socket refetches, api
 * routes, and tests may consume a contract as-is, but only the owning route
 * drives its shape; the route's server fn binds to it as the module-private
 * `getLoaderData`, one fixed name per route so nobody has to coin a fetch
 * name per page. When another consumer needs the shape to change, promote
 * the contract to a domain-named type instead of bending it. Loader-vs-socket
 * placement is documented on `ShopAgentClient`.
 */
export type AdminShopLoaderData =
  | { readonly _tag: "NotFound" }
  | {
      readonly _tag: "Found";
      readonly shopSession: ShopSessionRedacted;
      readonly plan: AdminShopPlanCache;
      readonly entitlements: Entitlements | null;
      /** Read from the shop's Durable Object; the counters the plan is compared against. */
      readonly usage: ShopUsage;
      /** `Member` rows in D1, so this page reads used-of-granted like `/app` does. */
      readonly memberCount: number;
      readonly derivedShopAgentId: string;
    };

/**
 * `/app` home (`app.index`).
 *
 * The entitlements and the boundary come from the resolved {@link PlanStatus} rather
 * than from route context for the reason `resolveEntitlements` documents: this
 * loader is isomorphic, and taking the tier from context would mean the browser
 * naming it on every in-app navigation.
 */
export interface AppIndexLoaderData {
  readonly entitlements: Entitlements;
  readonly usage: ShopUsage;
  /** `Member` rows in D1, against `Entitlements.membersIncluded`. */
  readonly memberCount: number;
  /** The next contract boundary. */
  readonly planBoundaryAt: number | null;
}

/** `/login` (`login`). */
export interface LoginLoaderData {
  readonly isDemoMode: boolean;
}

/**
 * `/app/orders` (`app.orders.index`): the first page, plus the usage the
 * page's limit banners need.
 *
 * `view` is what the socket replaces on every order push; `usage` is
 * loader-only and deliberately does not move under the socket. It is a
 * billing-period fact, and refreshing it on every webhook would be a read per
 * push for a number that changes on a scale of days.
 */
export interface OrdersIndexLoaderData {
  readonly view: OrdersView;
  readonly usage: ShopUsage;
}

/** `/app/orders/$orderId` (`app.orders.$orderId`); `null` is not stored. */
export type OrderLoaderData = OrderDetailView | null;

/** `/app/workflows` (`app.workflows.index`). */
export interface WorkflowsIndexLoaderData {
  readonly workflows: readonly WorkflowSummary[];
}

/** `/app/workflows/$workflowId` (`app.workflows.$workflowId`) and its `/edit`; `null` is not found. */
export type WorkflowLoaderData = WorkflowDetailView | null;

/**
 * `/app/members` (`app.members`). `teams` feeds the team checklist in the add
 * and edit-teams modals; `memberTeams` paints the Teams column and carries the
 * sole-membership warning (`teamMemberCount === 1`) for the remove dialog.
 */
export interface MembersLoaderData {
  readonly members: readonly Member[];
  readonly teams: readonly TeamRoster[];
  readonly memberTeams: readonly MemberTeam[];
}

/**
 * `/app/teams` (`app.teams.index`). `teamWorkflows` is Durable Object data
 * joined into a D1 page by the loader (the loader-versus-socket rule on
 * `ShopAgentClient`), grouped per team into the "Used by" column.
 */
export interface TeamsIndexLoaderData {
  readonly teams: readonly TeamSummary[];
  readonly teamWorkflows: readonly TeamWorkflowByTeam[];
}

/**
 * `/app/teams/$teamId` (`app.teams.$teamId`; a param tail contributes its
 * noun, `Team`). `teamWorkflows` and `taskCounts` are Durable Object data joined
 * into a D1 page by the loader — see the loader-versus-socket rule on
 * `ShopAgentClient`. `memberTeams` is the hint the Add members
 * dialog shows beside each candidate: where they already work.
 */
export interface TeamLoaderData extends TeamDetail {
  readonly memberTeams: readonly MemberTeam[];
  readonly teamWorkflows: readonly TeamWorkflow[];
  readonly taskCounts: TeamDeleteCounts;
}

/**
 * `/shop/$shop` (`shop.$shop.index`): the member's run list, which is the
 * member area's landing page. `view` is the read of `query` — the tab from the URL, every
 * team, one page deep — which is why `memberEmail` is here to be *sent* on
 * the socket's later reads rather than to group rows the page holds; it and
 * `memberId` come out of the same `requireMember` that resolved `teams`.
 * `query` travels with the view so the page can tell whether the socket is
 * about to ask for the same read ({@link sameRunQuery}) and hand these rows
 * over as `initialData`. `shop` is the `myshopify.com` domain — the Admin
 * API's display name is not stored anywhere in Baton, and the domain is what
 * the URL and every membership row key on.
 */
export interface RunListLoaderData {
  readonly shop: Shop;
  readonly memberId: MemberId;
  readonly memberEmail: Email;
  readonly teams: MemberAccess["teams"];
  readonly query: RunQuery;
  readonly view: RunListView;
}

/** `/shop/$shop/workflows/$runId` (`shop.$shop.workflows.$runId`). `view` is null when the run is not the member's to see. */
export interface RunLoaderData {
  readonly shop: Shop;
  readonly memberId: MemberId;
  readonly memberEmail: Email;
  readonly teams: MemberAccess["teams"];
  readonly view: RunView | null;
}

/**
 * The subscribe pattern — the socket half of the loader-versus-socket rule on
 * `ShopAgentClient`, for a page whose data other actors change underneath it.
 * One cycle, named the same on both sides:
 *
 * 1. **Subscribe.** The page's read is a `subscribe<Feature>` RPC on
 *    `ShopAgent` (`subscribeOrders`, `subscribeOrder`) that returns the view
 *    *and* stores this `Subscription` as the connection's state, in one round
 *    trip so a write between two calls cannot be missed. Each has a plain
 *    twin without the subscription (`listOrders`, `getOrderDetail`) that the
 *    route loader reads through `ShopAgentClient` for SSR paint. The page
 *    calls the RPC through `useSubscribedQuery`, which owns the client half.
 * 2. **Publish.** A write on the object ends with `ShopAgent.publish`, which
 *    sends `InvalidatedMessage` to every connection whose subscription the
 *    write touched — a hint that the view is stale, never the new value.
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
 * Who did a task action, as a closed union rather than a set of nullable
 * columns read together. The merchant has no member id and no email — they
 * act through the embedded admin, where identity is the Shopify session, not
 * a `Member` row — so inferring "merchant" from a null email would make every
 * reader re-derive the same rule and would collide with a member row whose
 * email columns are legitimately null (a task nobody has touched). The role
 * discriminator is stored beside the id and email on the row, and the
 * accessors below ({@link taskStartedBy} and friends) are the only place the
 * three columns are reassembled.
 */
export const Actor = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("member"),
    memberId: MemberId,
    email: Email,
  }),
  Schema.Struct({ role: Schema.Literal("merchant") }),
]);
export type Actor = typeof Actor.Type;

export type MemberActor = Extract<Actor, { readonly role: "member" }>;

/**
 * The part of an {@link Actor} a page displays. Separate from `Actor` because
 * the `reopened` slot stores no member id and so cannot produce a full actor,
 * yet reads the same way on the page ({@link taskReopenedBy}).
 */
export type ActorDisplay =
  | { readonly role: "merchant" }
  | { readonly role: "member"; readonly email: Email };

/** How every page spells an actor: the merchant is `Merchant`, a member is their email. */
export const actorLabel = (actor: ActorDisplay) =>
  actor.role === "merchant" ? "Merchant" : actor.email;

/**
 * Whether an actor slot is this member, by email: the durable identity, since
 * a removed and re-added member mints a new id but keeps the address (the
 * same reason {@link tierOf} matches Mine by email). The merchant has no email
 * and is never "you" on a member page.
 */
export const actorIsMember = (actor: Actor, email: Email) =>
  actor.role === "member" && actor.email === email;

export const MerchantConnectionState = Schema.Struct({
  role: Schema.Literal("merchant"),
  subscription: Schema.NullOr(Subscription),
});
export type MerchantConnectionState = typeof MerchantConnectionState.Type;

export const MemberConnectionState = Schema.Struct({
  role: Schema.Literal("member"),
  memberId: MemberId,
  memberEmail: Email,
  teamIds: Schema.Array(TeamId),
  subscription: Schema.NullOr(Subscription),
});
export type MemberConnectionState = typeof MemberConnectionState.Type;

export const ConnectionState = Schema.Union([
  MerchantConnectionState,
  MemberConnectionState,
]);
export type ConnectionState = typeof ConnectionState.Type;

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

export const WorkflowRunId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowRunId"),
);
export type WorkflowRunId = typeof WorkflowRunId.Type;

export const WorkflowRunTaskId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowRunTaskId"),
);
export type WorkflowRunTaskId = typeof WorkflowRunTaskId.Type;

/** How a run came to exist: a tag match during an order upsert, or an admin attaching by hand. */
export const RunSource = Schema.Literals(["tag", "manual"]);
export type RunSource = typeof RunSource.Type;

/**
 * Derived from the run's tasks and stored for querying; every task write
 * recomputes it in the same transaction. `cancelled` is the one value tasks
 * cannot produce — reconcile sets it on a `pending` run whose work vanished,
 * a person sets it from anywhere but `done`, and un-cancel recomputes from
 * the tasks again.
 *
 * What each status allows. The gate column is the rule; the enforcing write
 * refuses with `RunTerminalError` when it fails, and every page that offers
 * a button reads the same predicate rather than restating it.
 *
 * | action                          | gate                                  |
 * | ------------------------------- | ------------------------------------- |
 * | Start, Done                     | {@link runIsOpen}, and the task ready |
 * | note on the run                 | {@link runIsLive}: a note is a record, not work |
 * | Block                           | {@link runIsOpen}, and a ready task   |
 * | Put back (clear a task's Start) | {@link runIsOpen}, and the task started and ready |
 * | assign a task's team            | {@link runIsOpen}, and the task open  |
 * | Cancel                          | {@link runIsOpen}                     |
 * | Undo (reopen a finished task)   | {@link runIsLive}, see {@link undoBlockedBy} |
 * | Un-cancel                       | the inverse of {@link runIsLive}: only `cancelled` |
 * | reconcile adjusts the run       | {@link runIsOpen}; silently if {@link runIsUnstarted}, flagged otherwise |
 * | reconcile flags a quantity change | {@link runIsOpen} or {@link runIsDone}; a `done` run keeps its quantity |
 * | holds the line item's one slot  | {@link runIsLive}                     |
 * | replaced by a manual attach     | {@link runIsOpen}: a `done` run is a record, `RunFinishedError` |
 * | counts against the shop ceiling | {@link runIsOpen}                     |
 *
 * "Live" and "open" are two rules on purpose. A `done` run is live for its
 * line item — a finished item is not rerouted — but not open: finished work
 * does not count against `ShopLimits.maxOpenRuns`, and nothing on it can be
 * started, so what is left is Undo and a note.
 */
export const RunStatus = Schema.Literals([
  "pending",
  "active",
  "done",
  "cancelled",
]);
export type RunStatus = typeof RunStatus.Type;

/**
 * Nobody has touched it: no task started or finished. Reconcile treats such
 * a run as free to cancel or resize silently when the order moves under it,
 * where a started run is flagged instead, because "someone has started
 * work" is exactly what should protect a run from a silent cancel.
 */
export const runIsUnstarted = (run: { readonly status: RunStatus }) =>
  run.status === "pending";

/** Work can still be recorded: Start, Done, Block, team assignment, cancel. */
export const runIsOpen = (run: { readonly status: RunStatus }) =>
  run.status === "pending" || run.status === "active";

/** The last task's Done: no work is recorded on it again unless Undo reopens it. */
export const runIsDone = (run: { readonly status: RunStatus }) =>
  run.status === "done";

/**
 * The run still stands for its line item. Only `cancelled` is out, because
 * only `cancelled` was chosen; `done` is the last task's Done and is undone
 * the same way. Undo and every "which run is this item's" lookup use this,
 * and `WorkflowRun_live_item_uidx` (partial over `status <> 'cancelled'`) is
 * the same rule as a database constraint.
 */
export const runIsLive = (run: { readonly status: RunStatus }) =>
  run.status !== "cancelled";

/**
 * Attention markers reconcile leaves on a run when the order under it changed.
 * A `pending` run is cancelled or updated silently instead — no one has
 * started it. A later flag overwrites an earlier one; a person clears it from
 * the run list.
 *
 * A `done` run keeps its quantity, and a later change to its line item's
 * {@link unitsToMake} flags it `quantity_changed` so the merchant sees it on
 * the order page and in the run list. Reopening is the merchant's call
 * through Undo ({@link undoBlockedBy}), after which the run is active again
 * and ordinary quantity handling applies. Nothing else touches a `done` run:
 * it is not resized, not cancelled, and no second run is ever created for a
 * line item that already has one, `done` included. A line whose units reach
 * zero under a `done` run is the ordinary end of that work — the line was
 * edited away or refunded — so it is left alone rather than read as
 * `item_removed`.
 *
 * Dismissing that flag **accepts** the change ({@link dismissAcceptsQuantity}):
 * the run's `quantity` becomes the units the flag reported, so the next
 * reconcile finds them equal and the flag does not return. An active run is
 * resized by reconcile itself; a `done` run is resized only by this
 * acknowledgement, because until then the merchant has not looked. Reconcile
 * also leaves a `done` run alone when it already carries this flag for the
 * same units, so a webhook that changed nothing does not restamp `flagAt`.
 *
 * `blocked` is the one flag a person sets rather than reconcile: a worker
 * marking the run as needing attention, with an optional reason. A later
 * reconcile flag overwrites it like any other.
 *
 * `order_fulfilled` is set by reconcile alone when the stored order reaches
 * exactly `FULFILLED` while runs are open: active runs get it, pending runs
 * are cancelled instead. A partial fulfilment sets nothing at all: shipping a
 * line does not move its {@link unitsToMake}, so no run sees a change.
 *
 * `item_removed` is set when a line's `currentQuantity` reaches zero — an edit
 * that dropped the line, or a full refund.
 *
 * What a flag changes. Every site reads a predicate, never the literal.
 *
 * | rule                                      | predicate / enforcer                        |
 * | ----------------------------------------- | ------------------------------------------- |
 * | Start, Done and Put back are refused; Undo and the note are not | {@link runIsFlagged}, `RunFlaggedError` |
 * | the flag's one action is Unblock or Dismiss | {@link runIsBlocked} picks the word       |
 * | the block reason is editable              | {@link runIsBlocked}, `setBlockReason`      |
 * | a blocked run holds no team ("waiting on") and shows no Now line | {@link runIsBlocked} |
 * | counted as `blocked` or `flagged`, open runs only | {@link runCounts}                   |
 * | reconcile flags active runs, cancels pending | `flagActive`, `cancelPending` |
 * | a quantity change flags an active or a `done` run | `flagQuantityChanged` |
 * | Dismiss on a `done` run's quantity flag resizes it | {@link dismissAcceptsQuantity} |
 * | a flag puts the run's row in Attention    | {@link tierOf}                              |
 */
export const RunFlag = Schema.Literals([
  "item_removed",
  "quantity_changed",
  "order_cancelled",
  "blocked",
  "order_fulfilled",
]);
export type RunFlag = typeof RunFlag.Type;

/**
 * A flag means stop: Start, Done and Put back are refused (`RunFlaggedError`)
 * and the pages hide them. Undo and the note are not stopped — Undo takes
 * work back rather than doing more, and a held run is the one somebody needs
 * to write on. Put back is refused for the reason on
 * `WorkflowRunRepository.unstartTask`. The one action a flag itself allows is lifting it: Unblock for
 * {@link runIsBlocked}, Dismiss for a reconcile flag ({@link flagIsReconcile}).
 */
export const runIsFlagged = (run: { readonly flag: RunFlag | null }) =>
  run.flag !== null;

/**
 * Whether Dismiss should also write the flagged units into the run's
 * `quantity` — a `done` run carrying `quantity_changed` with a `to`, and only
 * that. Rule and reasoning on {@link RunFlag}.
 */
export const dismissAcceptsQuantity = (run: {
  readonly status: RunStatus;
  readonly flag: RunFlag | null;
  readonly flagDetail: RunFlagDetail | null;
}): run is typeof run & { readonly flagDetail: { readonly to: number } } =>
  runIsDone(run) &&
  run.flag === "quantity_changed" &&
  run.flagDetail?.to !== undefined;

/** Reconcile's "already told": the run carries `quantity_changed` reporting exactly these units ({@link RunFlag}). */
export const alreadyFlaggedQuantity = (
  run: {
    readonly flag: RunFlag | null;
    readonly flagDetail: RunFlagDetail | null;
  },
  units: number,
) => run.flag === "quantity_changed" && run.flagDetail?.to === units;

/** A person set the hold; the block reason is editable and the button reads Unblock. */
export const runIsBlocked = (run: { readonly flag: RunFlag | null }) =>
  run.flag === "blocked";

/**
 * Reconcile set it: Shopify moved under a live run. The remedy is to read it
 * and Dismiss; there is no reason to edit and nobody to attribute it to.
 */
export const flagIsReconcile = (flag: RunFlag) => flag !== "blocked";

export const RunFlagDetail = Schema.Struct({
  from: Schema.optionalKey(Schema.Number),
  to: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(BlockReason),
  /**
   * Who blocked the run. Snapshotted like the task actors, so a deleted
   * member still reads as who; absent on reconcile flags, which have nobody.
   */
  by: Schema.optionalKey(Actor),
  /** The line item title behind an `item_removed`. */
  item: Schema.optionalKey(Schema.String),
});
export type RunFlagDetail = typeof RunFlagDetail.Type;

/**
 * One workflow applied to one line item. Every display field
 * is a snapshot taken at creation — `workflowName`, `orderName`, the line
 * item's title and personalization — so a run's row reads only this row
 * and the run outlives an order delete, a definition rename, or a line item
 * dropped from the order. No foreign keys to `ShopOrder`, `OrderLineItem`, or
 * `Workflow` for that reason. `unique (lineItemId, workflowId)` spans every
 * status, so a cancelled run keeps its key and the only way back is un-cancel.
 *
 * A second index, partial over `status <> 'cancelled'`, holds the cardinality
 * rule: **one live run per line item**. `pending`, `active` and `done` are all
 * live — a finished item does not get a second route — so replacing a
 * workflow means cancelling the incumbent in the same transaction.
 */
export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  workflowId: WorkflowId,
  workflowName: WorkflowName,
  orderId: Schema.String,
  orderName: Schema.String,
  /**
   * `ShopOrder.processedAt` snapshotted at creation, like `orderName`: the
   * run list sorts every tier oldest-order-first and must not join `ShopOrder`
   * (which an order delete removes) to do it.
   */
  orderProcessedAt: Schema.Number,
  lineItemId: Schema.String,
  lineItemTitle: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  sku: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  customAttributes: Schema.fromJsonString(Schema.Array(OrderAttribute)),
  source: RunSource,
  status: RunStatus,
  flag: Schema.NullOr(RunFlag),
  flagAt: Schema.NullOr(Schema.Number),
  flagDetail: Schema.NullOr(Schema.fromJsonString(RunFlagDetail)),
  note: Schema.NullOr(RunNote),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  cancelledAt: Schema.NullOr(Schema.Number),
});
export type WorkflowRun = typeof WorkflowRun.Type;

/**
 * A task copied from the definition at run creation. `teamName` is
 * snapshotted alongside `teamId` so the run list never joins D1. `teamId` is
 * the live pointer that puts the task on a team's list; a team delete nulls
 * it on *open* tasks only (**unassigned**: red on the order page, on nobody's
 * list, waiting for **assign a team**), while a finished task keeps both the
 * id and the name. `startedBy` / `completedBy` are D1 `Member.id`s,
 * cross-store and unreferenced; `startedByEmail` / `completedByEmail` are
 * the snapshots taken at the action that keep history readable after the
 * member is deleted.
 *
 * Each of the three actor slots carries a `*ByRole` column, and that column
 * is the discriminator: the merchant leaves the id and email null (they have
 * no `Member` row), a member fills all three. Read them through
 * {@link taskStartedBy} / {@link taskCompletedBy} / {@link taskReopenedBy}
 * rather than by hand, and see {@link Actor} for why the role is stored
 * rather than inferred from a null email.
 *
 * `reopened*` is a *last-actor slot*, not a history: it records the most
 * recent Undo and the next `completeTask` clears it, so the line only shows
 * while the task is genuinely back open. There is no `reopenedBy` id
 * column — the reopener is only ever displayed, never joined. Undo also
 * clears the whole Start slot, so a reopened task reads Ready. Put back
 * clears the Start slot with no slot of its own: a put-back task is plain
 * Ready and the next Start writes a fresh record.
 *
 * A task is *ready* by {@link readyTasks}; several tasks of one run can be
 * ready at once. `startedAt` is set by Start (and backfilled by a Done without
 * Start) and marks the run `active`.
 */
export const WorkflowRunTask = Schema.Struct({
  id: WorkflowRunTaskId,
  runId: WorkflowRunId,
  position: Schema.Number,
  step: Schema.Number,
  name: TaskName,
  teamId: Schema.NullOr(TeamId),
  teamName: TeamName,
  instructions: Schema.NullOr(TaskInstructions),
  startedAt: Schema.NullOr(Schema.Number),
  startedBy: Schema.NullOr(MemberId),
  startedByEmail: Schema.NullOr(Email),
  completedAt: Schema.NullOr(Schema.Number),
  completedBy: Schema.NullOr(MemberId),
  completedByEmail: Schema.NullOr(Email),
  startedByRole: Schema.NullOr(ConnectionRole),
  completedByRole: Schema.NullOr(ConnectionRole),
  reopenedAt: Schema.NullOr(Schema.Number),
  reopenedByRole: Schema.NullOr(ConnectionRole),
  reopenedByEmail: Schema.NullOr(Email),
});
export type WorkflowRunTask = typeof WorkflowRunTask.Type;

/**
 * The three actor slots, reassembled from their role column and its
 * companions. `null` when the action has not happened; a `member` role with a
 * missing id or email cannot occur (the writes set the three together) and
 * reads as nobody rather than throwing, because a display path is the wrong
 * place to fail.
 */
const actorFrom = (
  role: ConnectionRole | null,
  memberId: MemberId | null,
  email: Email | null,
): Actor | null => {
  if (role === null) return null;
  if (role === "merchant") return { role: "merchant" };
  return memberId === null || email === null
    ? null
    : { role: "member", memberId, email };
};

/**
 * Each of these takes the slot it reads rather than a whole
 * {@link WorkflowRunTask}, so a {@link RunListTask} — which carries no
 * `completed*` slot at all — is as good an argument as a finished one.
 */
export const taskStartedBy = (
  task: Pick<WorkflowRunTask, "startedByRole" | "startedBy" | "startedByEmail">,
) => actorFrom(task.startedByRole, task.startedBy, task.startedByEmail);

export const taskCompletedBy = (task: WorkflowRunTask) =>
  actorFrom(task.completedByRole, task.completedBy, task.completedByEmail);

/**
 * The reopener. Narrower than the other two: the `reopened` slot has no id
 * column (see {@link WorkflowRunTask}), so this is an {@link ActorDisplay} —
 * enough for {@link actorLabel}, which is all anything does with it.
 */
export const taskReopenedBy = (
  task: Pick<WorkflowRunTask, "reopenedByRole" | "reopenedByEmail">,
): ActorDisplay | null => {
  if (task.reopenedByRole === null) return null;
  if (task.reopenedByRole === "merchant") return { role: "merchant" };
  return task.reopenedByEmail === null
    ? null
    : { role: "member", email: task.reopenedByEmail };
};

/** An open run task whose team is gone: `teamId` null, or an id the roster no longer carries. */
export const isRunTaskUnassigned = (
  task: WorkflowRunTask,
  teams: readonly { readonly id: TeamId }[],
) =>
  task.completedAt === null &&
  (task.teamId === null || !teams.some((team) => team.id === task.teamId));

/**
 * The task is on one of the caller's teams. An unassigned task (`teamId`
 * null) is on nobody's list, so no member's teams match it. The merchant
 * never asks: their `teamIds` is undefined and every guard skips this.
 */
export const taskIsOnTeams = (
  task: { readonly teamId: string | null },
  teamIds: readonly string[],
) => task.teamId !== null && teamIds.includes(task.teamId);

/**
 * **A member's access to a run is any task of it on one of their teams**,
 * ready or not, done or not. It is what shows them the run page
 * (`WorkflowRunRepository.getRunView`) and what lets them write the run's
 * note (`setRunNote`), the one write that is not about a particular task.
 * Acting on a task needs that task's team ({@link taskIsOnTeams}); Block
 * needs a ready one, because a hold is placed by whoever is stuck.
 */
export const runIsVisibleTo = (
  tasks: readonly { readonly teamId: string | null }[],
  teamIds: readonly string[],
) => tasks.some((task) => taskIsOnTeams(task, teamIds));

/** A run is complete in itself: its tasks are copies, and nothing here refers back to the definition. */
export const WorkflowRunDetail = Schema.Struct({
  run: WorkflowRun,
  tasks: Schema.Array(WorkflowRunTask),
});
export type WorkflowRunDetail = typeof WorkflowRunDetail.Type;

/**
 * One ready task the member may act on, cut to what a run's row renders.
 * `startedByEmail` is read off the row — the snapshot taken at Start, never a
 * live join — and it is load-bearing beyond display: {@link tierOf} decides
 * "Mine" with it.
 *
 * Two groups of columns are omitted rather than carried as nulls. The four
 * `completed*` ones can never say anything here: readiness is `completedAt is
 * null` (`readyWhere`) and Undo clears the whole slot, so on a list task
 * every one of them is null by construction. The rest — instructions and the
 * reopened slot — say something, but only on the work
 * page: a row shows the task's name and one state clause, and everything
 * behind that is one tap away. Either way they are fields per task on every
 * SSR paint and every refetch.
 *
 * A finished task is a {@link DoneItem}, which carries the whole
 * {@link WorkflowRunTask} because there the slot is the point.
 */
export const RunListTask = Schema.Struct(
  Struct.omit(WorkflowRunTask.fields, [
    "completedAt",
    "completedBy",
    "completedByEmail",
    "completedByRole",
    "instructions",
    "reopenedAt",
    "reopenedByRole",
    "reopenedByEmail",
  ]),
);
export type RunListTask = typeof RunListTask.Type;

/**
 * The run behind a row, cut the same way. `orderProcessedAt` and
 * `lineItemId` stay although nothing prints them: they are two thirds of
 * {@link byAge}, which is the order every tier is in. `quantity` stays
 * because `flagBody` falls back to it when a `quantity_changed` flag carries
 * no `to`, and that clause is line two of a flagged row.
 *
 * What goes is everything only the work page reads — the workflow's name,
 * the order id, the variant, the SKU, the timestamps, and
 * `customAttributes`, which is the one that matters: a JSON blob on every row
 * of every read, parsed on arrival, to render nothing. The run `note` stays:
 * the row prints it.
 */
export const RunListRun = Schema.Struct(
  Struct.omit(WorkflowRun.fields, [
    "workflowId",
    "workflowName",
    "orderId",
    "variantTitle",
    "sku",
    "customAttributes",
    "source",
    "createdAt",
    "updatedAt",
    "cancelledAt",
  ]),
);
export type RunListRun = typeof RunListRun.Type;

/**
 * One row of a member's run list: a run with every *ready* task
 * ({@link readyTasks}) that belongs to one of the member's teams. `stepCount` is the run's last step, for "Step k of n" ({@link runRowLine}).
 *
 * The order's live note is not here. It is the work page's, along with the
 * task instructions and the item's attributes: the row is a list entry that
 * names the piece and its state, and the page one tap behind it is where a
 * maker reads anything.
 */
export const RunListItem = Schema.Struct({
  run: RunListRun,
  tasks: Schema.NonEmptyArray(RunListTask),
  stepCount: Schema.Number,
});
export type RunListItem = typeof RunListItem.Type;

/**
 * Line two of a member's run row, in two parts so the row can swap the second
 * for a flag or "In progress" and keep the first. `names` is every ready task
 * in `position` order, so a parallel step shows all of its tasks rather than
 * one name and a count. `step` is `Step k of n`, where k is the step the ready
 * tasks share and n is {@link RunListItem}'s `stepCount`.
 *
 * The team is printed only where it tells the reader something. When the
 * listed tasks are on different teams each name carries its team in
 * parentheses and `step` carries none. When they share one team it follows
 * `step`, and only if `showTeam`: the row decides that from the member's team
 * count and filter.
 */
export const runRowLine = (
  { tasks, stepCount }: RunListItem,
  showTeam: boolean,
): { readonly names: string; readonly step: string } => {
  const [first] = tasks;
  const teams = new Set(tasks.map((task) => task.teamName));
  const names = tasks
    .map((task) =>
      teams.size > 1 ? `${task.name} (${task.teamName})` : task.name,
    )
    .join(" · ");
  const position = `Step ${String(first.step)} of ${String(stepCount)}`;
  return {
    names,
    step:
      showTeam && teams.size === 1
        ? `${position} · ${first.teamName}`
        : position,
  };
};

/**
 * The four tiers a waiting row can fall in. Four of the five tabs
 * ({@link RunTab}) are these; `done` is not a tier because it is a window
 * over finished tasks rather than a grouping of the list. The labels the
 * member reads are the route's (`runTabs.ts`); the object only needs the
 * keys, because it is the side that groups, sorts, and caps.
 */
export const RunTier = Schema.Literals([
  "attention",
  "mine",
  "inProgress",
  "upNext",
]);
export type RunTier = typeof RunTier.Type;

/**
 * The five screens of the member's run list, in strip order: what I am finishing,
 * what I can start, what a teammate is holding, what has stopped, what can be
 * undone. Four are the tiers of {@link tierOf}; `done` is the finished-tasks
 * window. The tab is the unit of a read: one read returns every tab's count
 * and one tab's rows.
 */
export const RunTab = Schema.Literals([
  "mine",
  "upNext",
  "inProgress",
  "attention",
  "done",
]);
export type RunTab = typeof RunTab.Type;
export const DEFAULT_RUN_TAB: RunTab = "mine";

/**
 * Which tier a row belongs in: a flag wins; else a task the viewer
 * started; else any started task; else up next.
 *
 * "Mine" is by `startedByEmail`, not by the `startedBy` member id. Removing a
 * member and re-adding the same address mints a **new** `Member.id`
 * (`migrations/0001_init.sql`), so the id on a row taken before that stops
 * matching the person still standing at the bench, while the email — the
 * snapshot the migration calls the durable one — keeps matching. A merchant's
 * task has no email at all and so is nobody's, which is right: `Merchant` is
 * not a member of this shop.
 *
 * Put back and Undo both clear `startedByEmail`, so they are the two ways a
 * run leaves Mine without being finished.
 *
 * Here rather than beside the route's labels because the object tiers the
 * rows now: one read counts every tier and returns one of them, so the
 * grouping has to happen on the side that decides what leaves.
 */
export const tierOf = (
  { run, tasks }: RunListItem,
  memberEmail: Email,
): RunTier => {
  if (run.flag !== null) return "attention";
  if (tasks.some((task) => task.startedByEmail === memberEmail)) return "mine";
  if (tasks.some((task) => task.startedAt !== null)) return "inProgress";
  return "upNext";
};

/**
 * Within a tier, oldest order first by `run.orderProcessedAt` (the snapshot
 * on the run, so no join), then by line item, then by run id. Two runs of one
 * order share the first key, and `createdAt` would not split them either (one
 * reconcile inserts them in the same millisecond), so the line item id is the
 * tiebreak: Shopify mints them in the order the customer added the lines, and
 * it is the order `listRunsForOrder` already uses. The run id only separates
 * two workflows on one line. The triple is a key an index can serve and a
 * cursor could later resume from — which the order name would not be.
 */
export const byAge = (a: RunListItem, b: RunListItem) =>
  a.run.orderProcessedAt - b.run.orderProcessedAt ||
  a.run.lineItemId.localeCompare(b.run.lineItemId) ||
  a.run.id.localeCompare(b.run.id);

/**
 * What stands between a finished task and Undo ({@link undoBlockedBy}). Once
 * downstream has moved the fix is a conversation, so the page names who to
 * ask rather than offering a button that would pull work out from under them.
 */
export const UndoBlocker = Schema.Struct({
  taskName: TaskName,
  teamName: TeamName,
});
export type UndoBlocker = typeof UndoBlocker.Type;

/**
 * The lowest step with an open task — where the run is — or `null` once
 * every task is done.
 */
export const lowestOpenStep = (tasks: readonly WorkflowRunTask[]) =>
  tasks
    .filter((task) => task.completedAt === null)
    .reduce<number | null>(
      (lowest, task) =>
        lowest === null ? task.step : Math.min(lowest, task.step),
      null,
    );

/**
 * The readiness rule on rows already in hand: step k is ready when every task
 * of step k-1 is done ({@link WorkflowTask}), so a task is ready when its run
 * is {@link runIsOpen}, it is open, and its step is the lowest with an open
 * task. Several are ready at once on a step of several tasks, so this is a
 * list and every caller copes with more than one. `readyWhere.ts`
 * is the same rule as SQL for the run list and the task guards; this is the one
 * TypeScript copy, for the merchant's order page (which holds every task of
 * the order) and the dev seeder (which walks runs a step at a time), and the
 * test on it pins that the two agree.
 */
export const readyTasks = (
  run: { readonly status: RunStatus },
  tasks: readonly WorkflowRunTask[],
): WorkflowRunTask[] => {
  if (!runIsOpen(run)) return [];
  const lowest = lowestOpenStep(tasks);
  return tasks.filter(
    (task) => task.completedAt === null && task.step === lowest,
  );
};

const firstStarted = (tasks: readonly WorkflowRunTask[]) =>
  tasks
    .filter((other) => other.startedAt !== null)
    .toSorted((a, b) => a.step - b.step || a.position - b.position)[0];

/**
 * The undo rule, on rows already in hand: the first task in a later step of
 * the same run that anyone has started. A `startedAt` test covers finished
 * tasks too, because Done backfills `startedAt`.
 *
 * Pure and here rather than in `WorkflowRunRepository` so the three readers
 * cannot disagree: the repository's own write, the verdicts it precomputes for
 * the member pages, and the merchant's order page, which holds every task of
 * every run on the order and decides client-side whether to offer Reopen. A
 * browser cannot import the repository module — it carries the SQL service —
 * and a second copy of this rule is exactly the drift to avoid.
 */
export const undoBlockedBy = (
  task: WorkflowRunTask,
  runTasks: readonly WorkflowRunTask[],
): UndoBlocker | null => {
  const blocker = firstStarted(
    runTasks.filter(
      (other) => other.runId === task.runId && other.step > task.step,
    ),
  );
  return blocker === undefined
    ? null
    : { taskName: blocker.name, teamName: blocker.teamName };
};

/**
 * One entry of the run list's "Done today" tier: a task one of the member's
 * teams completed inside the window, with its run for the card line and the
 * undo verdict precomputed by the object, which is the only side that can see
 * the downstream tasks.
 */
export const DoneItem = Schema.Struct({
  run: WorkflowRun,
  task: WorkflowRunTask,
  undoBlockedBy: Schema.NullOr(UndoBlocker),
});
export type DoneItem = typeof DoneItem.Type;

/**
 * Provisional. The rows one tab returns before it offers "Show more", and the
 * size of each "more". One number for every tab: a member's own tab (Mine) is
 * the one they scroll least and the one that must fit, and at ~50 px a row 25
 * is under two phone screens. A proposal, not a tuned figure.
 */
export const RUN_PAGE = 25;
/** Provisional: the most rows one tab may be expanded to in a single read. */
export const RUN_LIMIT_MAX = 100;

/**
 * How deep one read of a tab goes, as the object accepts it: a whole number
 * of rows from 1 to {@link RUN_LIMIT_MAX}.
 *
 * **The object refuses a depth out of range; the URL clamps one into it.**
 * Depth is in the member's URL (`MemberSearch` in `src/routes/shop.$shop.tsx`),
 * so `?limit=1000` is a thing a person can type into the address bar of a page
 * they are standing on, and a typed URL is not a bug report — the router's
 * error boundary over a whole shop's work is a worse answer than a hundred
 * rows. The two halves cannot be one rule: this schema is the wire between the
 * page and the object, where a depth out of range is a caller's mistake worth
 * failing on, while the URL is text a person edits. {@link clampRunLimit} is
 * the URL's half, applied where the search schema decodes, so everything
 * downstream of it — the query key, the loader, this schema — is handed a
 * depth already in range.
 */
export const RunLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: RUN_LIMIT_MAX }),
);

/**
 * How much of a `?team=` the URL's schema keeps. The id it carries is a UUID
 * and the roster is what decides whether it means anything, so this is only
 * the bound that stops a pasted essay travelling to the object.
 */
export const TEAM_SEARCH_MAX = 128;

/**
 * The URL's half of {@link RunLimit}: whatever number the address bar carried,
 * as a whole number of rows in range. A value that is not finite falls back to
 * {@link RUN_PAGE} rather than clamping to an edge, because it names no depth
 * at all.
 */
export const clampRunLimit = (value: number) =>
  Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), 1), RUN_LIMIT_MAX)
    : RUN_PAGE;

/**
 * What the browser may choose about its run list: one of its own teams to narrow
 * to (`null` is every team on the connection), which tab, and how many rows of
 * that tab. `team` is validated against the connection's `teamIds` by the
 * object; a team the member is not on reads as an empty list, never as an
 * error. The screen resolves a URL's team against the roster before it gets
 * here (`shop.$shop.index.tsx`), so that empty list is reserved for a caller
 * that ignored the roster. The counts of every tab come back regardless of
 * `tab`, so the strip is always current.
 */
export const RunQuery = Schema.Struct({
  team: Schema.NullOr(TeamId),
  tab: RunTab,
  limit: RunLimit,
});
export type RunQuery = typeof RunQuery.Type;

/**
 * Structural equality, for deciding whether the loader's rows may serve as
 * the socket query's `initialData`: the route rebuilds the value on every
 * press, and the loader's own query is built from the URL.
 */
export const sameRunQuery = (a: RunQuery, b: RunQuery) =>
  a.team === b.team && a.tab === b.tab && a.limit === b.limit;

export const RunListTeamCount = Schema.Struct({
  teamId: TeamId,
  count: Schema.Number,
});
export type RunListTeamCount = typeof RunListTeamCount.Type;

/**
 * The strip. `mine`, `upNext`, `inProgress`, `attention` and `done` are the
 * counts of the five tabs **after** `query.team` narrows them, because they
 * describe the lists the member can switch to. `total` and `teamCounts` are
 * over every team on the connection regardless of `query.team`, so the team
 * select does not move under the finger.
 */
export const RunListCounts = Schema.Struct({
  mine: Schema.Number,
  upNext: Schema.Number,
  inProgress: Schema.Number,
  attention: Schema.Number,
  done: Schema.Number,
  total: Schema.Number,
  teamCounts: Schema.Array(RunListTeamCount),
});
export type RunListCounts = typeof RunListCounts.Type;

/**
 * One read of the member's run list: every tab's count and one tab's rows. Exactly
 * one of `items` and `done` is populated: `items` when `query.tab` is a tier,
 * `done` when it is "done". The selected tab's total is `counts[query.tab]`.
 * One value rather than two reads so the loader and the socket paint the same
 * snapshot and the strip never disagrees with the list under it.
 */
export const RunListView = Schema.Struct({
  counts: RunListCounts,
  items: Schema.Array(RunListItem),
  done: Schema.Array(DoneItem),
});
export type RunListView = typeof RunListView.Type;

/**
 * How far back "Done today" reaches. A day, not a shift: a mistake is
 * noticed when the next card looks wrong, which can be after lunch or the
 * next morning, and a longer window would make the tier a history view the
 * merchant's order page already is.
 */
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A run task on the work page, decorated with what the page needs to offer
 * the right button: `ready` is the run list's readiness rule evaluated for this
 * task, and `undoBlockedBy` is the undo verdict for a finished one. Both are
 * facts about *other* rows (earlier and later steps of the run), which is
 * why the object computes them rather than the page.
 */
export const RunTaskView = Schema.Struct({
  ...WorkflowRunTask.fields,
  ready: Schema.Boolean,
  undoBlockedBy: Schema.NullOr(UndoBlocker),
});
export type RunTaskView = typeof RunTaskView.Type;

/**
 * What a member may do to a task, in one place for the work page and the
 * run list's Done tier so the buttons and the writes cannot disagree. Rules: the
 * {@link RunStatus} table for status (Start, Done and Put back need
 * {@link runIsOpen}; Undo needs {@link runIsLive}); the task's
 * team must be one of `teamIds`, as `WorkflowRunRepository.requireActionable`
 * requires; a flag stops Start, Done and Put back but not Undo
 * ({@link runIsFlagged}); Undo is offered on a finished task and carries its
 * downstream blocker ({@link undoBlockedBy}) when there is one.
 *
 * Put back is offered wherever Done is, and only on a started task
 * (`WorkflowRunRepository.unstartTask`). It shares Done's team gate, so every
 * member of the task's team sees it, not only the starter.
 *
 * **The verbs a task offers are the same on the run list and the work page,
 * and neither screen styles one as primary.** Primary and secondary are a
 * page's hierarchy, held in `s-page`'s action slots; a task has neither.
 * Polaris allows one primary per card and per page
 * (`refs/shopify-docs/docs/apps/design/layout.md`, "Cards that offer
 * interactivity"), and a step with two ready tasks would draw two.
 *
 * **Nothing on a member screen renders that blocker.** The run list drops the
 * row's menu and the work page lists the whole run, so the started task
 * standing in the way is already on screen wearing its own badge, and a
 * sentence naming it is the page arguing with itself. The merchant's order
 * page is the one screen that puts it in words, because it can reopen that
 * task and so has an instruction to give; the wording lives there, next to
 * the only thing that renders it.
 */
export const taskActions = (
  run: { readonly status: RunStatus; readonly flag: RunFlag | null },
  task: Pick<
    RunTaskView,
    "teamId" | "ready" | "startedAt" | "completedAt" | "undoBlockedBy"
  >,
  teamIds: readonly string[],
): {
  readonly start: boolean;
  readonly done: boolean;
  readonly putBack: boolean;
  /** `null` when Undo is not offered; otherwise the blocker, `null` meaning the button. */
  readonly undo: { readonly blockedBy: UndoBlocker | null } | null;
} => {
  const mine = taskIsOnTeams(task, teamIds);
  const live = mine && runIsLive(run);
  const ready =
    live &&
    runIsOpen(run) &&
    !runIsFlagged(run) &&
    task.ready &&
    task.completedAt === null;
  return {
    start: ready && task.startedAt === null,
    done: ready,
    putBack: ready && task.startedAt !== null,
    undo:
      live && task.completedAt !== null
        ? { blockedBy: task.undoBlockedBy }
        : null,
  };
};

/**
 * Everything `/shop/$shop/workflows/$runId` renders: one run, its tasks, and the
 * order's live note.
 *
 * The other line items on the order are deliberately **not** here. A workflow
 * is attached to a product and runs once per matching line item
 * ({@link Workflow}), so a member's unit of work is the line item and its
 * tasks. Nothing on this page acts on the order as a whole, and an order can
 * carry an unbounded number of lines to render.
 */
export const RunView = Schema.Struct({
  run: WorkflowRun,
  tasks: Schema.Array(RunTaskView),
  /** Shopify's order note, read-only here; the run's own note is `run.note`. */
  orderNote: Schema.NullOr(Schema.String),
});
export type RunView = typeof RunView.Type;

export const ListRunsForOrderInput = Schema.Struct({ orderId: BoundedId });
export type ListRunsForOrderInput = typeof ListRunsForOrderInput.Type;

export const AttachWorkflowInput = Schema.Struct({
  lineItemId: BoundedId,
  workflowId: BoundedId,
});
export type AttachWorkflowInput = typeof AttachWorkflowInput.Type;

export const RunIdInput = Schema.Struct({ runId: BoundedId });
export type RunIdInput = typeof RunIdInput.Type;

/** Everything `/app/orders/$orderId` renders, in one socket round trip. */
export const OrderDetailView = Schema.Struct({
  order: ShopOrder,
  lineItems: Schema.Array(OrderLineItem),
  runs: Schema.Array(WorkflowRunDetail),
  /**
   * Active workflows with at least one task — the manual-attach picker's
   * choices. Carried in the view rather than read by a second socket query so
   * the page has exactly one read, one key, and one push.
   */
  itemWorkflows: Schema.Array(Workflow),
  /** The live roster: the "Assign team" picker's choices, and what decides which open tasks are unassigned or on an empty team. */
  teams: Schema.Array(TeamRoster),
});
export type OrderDetailView = typeof OrderDetailView.Type;

/**
 * The member run list's loader read. Still Worker-resolved: `teamIds` comes
 * from `requireMember`, and the list's first paint is SSR, where there is no socket
 * to carry an identity — so this one stays plain RPC through `ShopAgentClient`
 * while the mutations below moved onto the socket.
 */
export const ListRunsInput = Schema.Struct({
  teamIds: Schema.Array(TeamId),
  memberEmail: Email,
  query: RunQuery,
});
export type ListRunsInput = typeof ListRunsInput.Type;

/**
 * The socket half of the member run list's read: the same rows `listRuns`
 * returns, plus a subscription registered on the connection in the same round
 * trip. `teamIds` and `memberEmail` are absent on purpose — the list is
 * scoped by the membership on the connection, which the member cannot name
 * for themselves. `query` is theirs to name: it chooses among their own teams,
 * which tab, and how far that tab is expanded, and the object bounds all three.
 */
export const SubscribeRunsInput = Schema.Struct({
  ...SubscriberIdInput.fields,
  query: RunQuery,
});
export type SubscribeRunsInput = typeof SubscribeRunsInput.Type;

/**
 * The work page's loader read, Worker-resolved for the same reason as
 * {@link ListRunsInput}. The guard is "any task of the run on one of my
 * teams", not "a ready task": a member may open work they have finished.
 */
export const GetRunForMemberInput = Schema.Struct({
  runId: BoundedId,
  teamIds: Schema.Array(BoundedId),
});
export type GetRunForMemberInput = typeof GetRunForMemberInput.Type;

/** The socket twin of {@link GetRunForMemberInput}; `teamIds` comes off the connection. */
export const SubscribeRunInput = Schema.Struct({
  ...SubscriberIdInput.fields,
  runId: BoundedId,
});
export type SubscribeRunInput = typeof SubscribeRunInput.Type;

/**
 * Member-area mutation inputs: **what the browser sends, and nothing more.**
 * Each is the id of the thing that was clicked plus, where there is one, the
 * text that was typed.
 *
 * `memberId`, `memberEmail`, and `teamIds` are deliberately absent. They are
 * what decides whether the write is allowed and who history records, so they
 * come off the connection the Worker's gate authorized
 * ({@link ConnectionState}), never off the wire — a member who could name their
 * own `teamIds` could act on any team's work, and one who could name their own
 * `memberEmail` could sign someone else's name to it. The object pairs the two
 * halves into the `*Command` shapes below before touching the repository.
 */
export const CompleteTaskInput = Schema.Struct({
  runTaskId: BoundedId,
});
export type CompleteTaskInput = typeof CompleteTaskInput.Type;

export const DismissFlagInput = Schema.Struct({
  runId: BoundedId,
});
export type DismissFlagInput = typeof DismissFlagInput.Type;

export const StartTaskInput = CompleteTaskInput;
export type StartTaskInput = typeof StartTaskInput.Type;

/** Undo: re-opens a finished task. Same shape; the rule is on `WorkflowRunRepository.uncompleteTask`. */
export const UncompleteTaskInput = CompleteTaskInput;
export type UncompleteTaskInput = typeof UncompleteTaskInput.Type;

/** Put back: clears a started task's Start record. Same shape; the rule is on `WorkflowRunRepository.unstartTask`. */
export const UnstartTaskInput = CompleteTaskInput;
export type UnstartTaskInput = typeof UnstartTaskInput.Type;

/** `note: null` clears. The rule is on {@link SetRunNoteCommand}. */
export const SetRunNoteInput = Schema.Struct({
  runId: BoundedId,
  note: Schema.NullOr(RunNote),
});
export type SetRunNoteInput = typeof SetRunNoteInput.Type;

/** `reason: null` blocks without a reason. */
export const BlockRunInput = Schema.Struct({
  runId: BoundedId,
  reason: Schema.NullOr(BlockReason),
});
export type BlockRunInput = typeof BlockRunInput.Type;

/**
 * Rewrites the reason on a run that is *already* blocked; `reason: null`
 * clears the text and keeps the hold. Separate from {@link BlockRunInput}
 * because blocking and correcting what the block says are different acts: a
 * block records who and when, and an edit must not restate either — the
 * mistake this exists for ("typo", "I wrote the wrong thing") is not a new
 * hold by a new person.
 */
export const SetBlockReasonInput = Schema.Struct({
  runId: BoundedId,
  reason: Schema.NullOr(BlockReason),
});
export type SetBlockReasonInput = typeof SetBlockReasonInput.Type;

/**
 * The whole write, as the run repository takes it: the wire input above joined
 * to the acting member's identity from the connection. Types rather than
 * schemas because nothing decodes them — they are assembled inside the object
 * from two values that were each already validated, and naming them is what
 * keeps "which fields are the browser's" answerable at a glance.
 *
 * Identity is one {@link Actor}, not a loose `memberId` / `memberEmail` pair,
 * because the merchant acts through these same commands from the order page
 * and has neither. `teamIds` is *optional* and that is the whole permission
 * difference: present, it is the member's membership and the task's team must
 * be in it; absent, the caller is the merchant and the team clause is skipped
 * entirely. Every other rule — step order, terminal runs, the downstream
 * undo guard — applies to both.
 */
export interface StartTaskCommand {
  readonly runTaskId: string;
  /** Member-only: there is no merchant Start — the merchant never claims work. */
  readonly actor: MemberActor;
  readonly teamIds?: readonly string[] | undefined;
}

export interface CompleteTaskCommand {
  readonly runTaskId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No `actor`: the run note is one field anyone with access may write, last
 * write wins, and nothing records who wrote it. Recording the editor would be
 * an attribution the UI never shows; people who want their lines attributed
 * sign them, which is enough for a shop where everyone knows everyone. Every
 * free-text field on a run follows this rule ({@link SetBlockReasonCommand}).
 */
export interface SetRunNoteCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
  readonly note: RunNote | null;
}

export interface BlockRunCommand {
  readonly runId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
  readonly reason: BlockReason | null;
}

export interface DismissFlagCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No `actor`, by the rule on {@link SetRunNoteCommand}. `flagDetail.by` stays
 * whoever set the hold.
 */
export interface SetBlockReasonCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
  readonly reason: BlockReason | null;
}

/** The actor lands in the task's `reopened` slot: undo is a fact worth showing, and the next Done clears it. */
export interface UncompleteTaskCommand {
  readonly runTaskId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No slot records the actor: the task is plain Ready again
 * ({@link WorkflowRunTask}). `actor` is taken for the log line and for
 * symmetry with the other task commands.
 */
export interface UnstartTaskCommand {
  readonly runTaskId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * `WorkflowCannotStart` = off, zero tasks, or an unassigned task (see
 * {@link Workflow}).
 *
 * `replaced` is the run that was cancelled to make room, or null. An item
 * holds at most one live run, so attaching over one is a *replace*: the server
 * decides that from the item's state rather than from a separate input, and
 * the page uses `replaced` to say which workflow it took the item off.
 */
export const AttachResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    run: WorkflowRun,
    replaced: Schema.NullOr(WorkflowRun),
  }),
  Schema.Struct({ _tag: Schema.Literal("AlreadyExists") }),
  Schema.Struct({ _tag: Schema.Literal("LineItemNotFound") }),
  Schema.Struct({ _tag: Schema.Literal("WorkflowCannotStart") }),
  /** The shop is at `ShopLimits.maxOpenRuns`; the attach started nothing. */
  Schema.Struct({ _tag: Schema.Literal("RunLimit"), limit: Schema.Number }),
  /** The item's live run is `done`; finished work is not replaced. Names it. */
  Schema.Struct({
    _tag: Schema.Literal("ItemDone"),
    workflowName: WorkflowName,
  }),
  /** The order is cancelled or fully fulfilled, so there is nothing to attach work to ({@link canAttachRun}). */
  Schema.Struct({ _tag: Schema.Literal("OrderClosed") }),
]);
export type AttachResult = typeof AttachResult.Type;

/**
 * `NotAllowed` = the task's team is not among the caller's; `NotReady` = the
 * task is not ready ({@link readyTasks}) or is already done (for undo, not
 * yet done; for put back, not yet started or already done); `Terminal` = the
 * run's status refuses the action, see the table on {@link RunStatus} (or, for un-cancel, the run is not
 * cancelled); `UndoBlocked` = someone downstream has
 * started, and names them ({@link UndoBlocker}).
 *
 * `ItemHasRun` = un-cancel refused because another live run now occupies the
 * line item. One live run per item is a database invariant, so the only way
 * back for this one is to cancel the occupant first; the variant names it.
 *
 * `NotBlocked` = a write that only a standing block admits (rewriting its
 * reason) found no block. Separate from `NotAllowed` because the cause is a
 * race, not a permission: the hold was lifted while the editor was open, and
 * "this belongs to another team" would send the reader after the wrong thing.
 */
export const RunResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NotAllowed") }),
  Schema.Struct({ _tag: Schema.Literal("NotBlocked") }),
  Schema.Struct({ _tag: Schema.Literal("NotReady") }),
  Schema.Struct({ _tag: Schema.Literal("Terminal") }),
  /** Start or Done on a flagged run; the flag says which kind ({@link runIsFlagged}). */
  Schema.Struct({ _tag: Schema.Literal("Flagged"), flag: RunFlag }),
  Schema.Struct({ _tag: Schema.Literal("UndoBlocked"), ...UndoBlocker.fields }),
  Schema.Struct({
    _tag: Schema.Literal("ItemHasRun"),
    workflowName: WorkflowName,
  }),
]);
export type RunResult = typeof RunResult.Type;
