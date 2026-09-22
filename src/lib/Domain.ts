/**
 * The domain vocabulary, and the one place a behavioural rule is written
 * down.
 *
 * - A rule is stated once, on the symbol that *is* the concept (a
 *   `Schema.Literals` such as {@link RunStatus}) or the function that
 *   enforces it ({@link undoBlockedBy}, {@link readySteps}). A concept with
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
  /** Seats. Members past this many, ordered by `createdAt` then `email`, are refused by `requireMember`; see {@link memberHasSeat}. */
  readonly maxMembers: number;
}

/**
 * What each tier grants. The Worker owns this table and the Durable Object
 * never sees it, but the split is *compare here, count there*, not "pass the
 * number in": `ordersPerCycle` is compared in the Worker against the
 * {@link ShopUsage} row the object keeps and reports, and `maxMembers` against
 * a D1 seat rank. Neither number reaches `ShopAgent`, so the object stores no
 * plan state to fall out of sync, and an upgrade or downgrade lands on the very
 * next page view with nothing to invalidate. The one plan-adjacent fact the
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
 * or the merchant is billed for an order the app calls included. It is not a
 * "free tier": the allowance is what the subscription already paid for.
 * Nothing verifies the two agree; it is operator discipline, because the meter
 * lives in the Partner Dashboard and the app cannot read its tiers.
 *
 * Raising a limit is always safe; lowering one is not, with no grandfathering:
 * a cut applies to existing shops immediately. A cut to `maxMembers` takes
 * seats away from the newest members the moment it lands — nothing is written,
 * and {@link memberHasSeat} is where that is decided.
 */
const ENTITLEMENTS = {
  basic: { ordersPerCycle: 20, maxMembers: 3 },
  pro: { ordersPerCycle: 30, maxMembers: 10 },
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
 * is then silently non-billable. It is one handle across tiers so the meter's
 * own graduated tiers — not the event — decide what an order costs.
 */
export const USAGE_METER_ORDER = "production-orders";

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
 */
export const ActiveSubscription = Schema.Struct({
  handle: PlanHandle,
  boundaryAt: Schema.NullOr(Schema.Number),
  /** `currentBillingCycle.startTime`; null during a trial, which has no cycle. */
  cycleStartAt: Schema.NullOr(Schema.Number),
  /** Shopify's own count for {@link USAGE_METER_ORDER} this cycle, when the contract carries the meter; the figure local counting is reconciled against. */
  usageQuantity: Schema.NullOr(Schema.Number),
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
 * step), so a `User` FK cannot hold. Sign-in is magic-link-only, which makes the
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
 * Run history survives the delete because `WorkflowRunStep` snapshots the
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
 * its steps become unassigned until you assign a team.**
 * Every `WorkflowStep`, `WorkflowDraftStep`, and *open* `WorkflowRunStep`
 * that pointed at the team gets `teamId = null`; finished run steps keep the
 * id and their `teamName` snapshot, which is why history never needs the row.
 * A team with nobody on it is valid and shows **No members**: its steps can
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
  /** How many members of the shop were added before this one, 0-based; the input to {@link memberHasSeat}. */
  seatRank: Schema.Number,
});
export type MemberAccess = typeof MemberAccess.Type;

/**
 * A member holds a seat when fewer than `maxMembers` members of the shop were
 * added before them, ordering by `createdAt` then `email`.
 *
 * Derived on every check from the plan in force and the roster as it stands.
 * Nothing is written on a downgrade, so there is no moment Baton has to pick to
 * decide who loses access: a downgrade learned about inside a webhook changes
 * only the answer the next member request gets, and no plan history can grant a
 * seat past the current limit — upgrade, add ten, downgrade, and only the first
 * three are still in. The merchant frees a seat by removing a member or
 * upgrading; those are verbs the members page already has.
 *
 * The tiebreak on `email` exists because `createdAt` is a millisecond
 * timestamp two adds can share, and a rank that flips between requests would
 * seat a different member on each page load.
 */
export const memberHasSeat = (seatRank: number, maxMembers: number) =>
  seatRank < maxMembers;

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

export const WorkflowStepId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowStepId"),
);
export type WorkflowStepId = typeof WorkflowStepId.Type;

/**
 * Arbitrary ceilings, enforced in the schemas below and re-checked by
 * `WorkflowRepository` before every insert, so the Durable Object never stores
 * an oversize row and the reorder UI stays a short list. Raise freely; they
 * exist so `position` loops are bounded, not to model a plan tier.
 */
export const WorkflowLimits = {
  maxWorkflows: 50,
  maxSteps: 20,
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
  maxOrdersPerCycle: 10_000,
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
  /** Set when a new order was refused because of {@link ShopLimits.maxOrdersPerCycle}; null once the cycle rolls. */
  ordersLimitedAt: Schema.NullOr(Schema.Number),
  /** Set when reconcile declined to auto-start a run because of `ShopLimits.maxOpenRuns`; null once under the ceiling again. */
  openRunsLimitedAt: Schema.NullOr(Schema.Number),
  /** `ctx.storage.sql.databaseSize` at read time. */
  databaseSize: Schema.Number,
  lastSweepAt: Schema.NullOr(Schema.Number),
  /** Usage events queued for the current cycle and not yet accepted by Shopify. Non-zero for long is an operator signal, not a merchant-facing number. */
  pendingUsageEvents: Schema.Number,
  /** Usage events that missed their cycle and can no longer be sent; see {@link usageEventIsDead}. Each is an order carried and never billed. */
  deadUsageEvents: Schema.Number,
  /**
   * Shopify's own meter reading at the last revalidation; null until one has
   * reported it. Diagnostic only — nothing is corrected from it.
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
  lastReconciledQuantity: Schema.NullOr(Schema.Number),
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

/** Shopify's meter reading for the current cycle, pushed in for the divergence check on {@link ShopUsage.lastReconciledQuantity}. */
export const ReconcileUsageInput = Schema.Struct({
  quantity: Schema.Number,
});
export type ReconcileUsageInput = typeof ReconcileUsageInput.Type;

/**
 * One App Events billing event: one counted order.
 *
 * `idempotencyKey` is permanent at Shopify and capped at 64 characters, which
 * is why it is derived from the order id rather than from a clock: replaying a
 * flush must not bill twice.
 */
export const UsageEvent = Schema.Struct({
  shopGid: ShopGid,
  eventHandle: Schema.NonEmptyString,
  /** When the order was counted, not when the event is sent: Shopify rejects a timestamp outside the merchant's current cycle. */
  occurredAt: Schema.Number,
  idempotencyKey: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  /**
   * One order, one unit. A `Literal(1)` rather than a number because the meter
   * only ever counts up: an order is billed the first time Baton creates a run
   * for it (`OrderRepository.countOrder`) and nothing afterwards gives that
   * back, so a negative or a plural value could only be a bug.
   */
  value: Schema.Literal(1),
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

export const StepName = trimmedName("StepName");
export type StepName = typeof StepName.Type;

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

/** Merchant-written how-to for a step, copied onto every run. Trimmed like {@link StepName}; a blank field is sent as `null`, never as an empty string. */
export const StepInstructions = trimmedText("StepInstructions", 2000);
export type StepInstructions = typeof StepInstructions.Type;

/**
 * The cap {@link StepNote} enforces, exported so a field can count down to it.
 * A decode failure mid-paragraph is the failure mode: the merchant has typed a
 * thousand characters before anything refuses them.
 */
export const STEP_NOTE_MAX_LENGTH = 1000;

/**
 * Where a note or reason field starts counting down to
 * {@link STEP_NOTE_MAX_LENGTH}. Late, because a counter on an empty field is a
 * rule nobody asked about; early enough that the cap announces itself while
 * there is still a paragraph's room to land in. Shared by the merchant's step
 * notes and the member's notes and block reasons so one number governs every
 * field the same text can be typed into.
 */
export const NOTE_COUNT_FROM = 800;

/** Worker-written text about one run's step (or a block reason). Same trimming; `null` clears. */
export const StepNote = trimmedText("StepNote", STEP_NOTE_MAX_LENGTH);
export type StepNote = typeof StepNote.Type;

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
 * - **Workflow**: name, type, tag, steps, Active / Off. This is what
 *   starts runs. Runs copy it wholesale and never look back at it.
 * - **Draft**: a private copy of the workflow's **steps**, created by
 *   Edit and living until Apply or Discard. Every edit writes to the draft
 *   immediately; there is no unsaved state anywhere.
 *
 * Verbs: **Edit** creates the draft. **Apply changes** replaces the
 * workflow's steps with the draft's and deletes the draft.
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
 * off** stops new runs and open ones finish; **a workflow needs at least one step before it
 * can be applied or turned on**, so zero steps is the state before the first
 * Apply and only that; **any open step on a run can be assigned to another
 * team**, a finished step is history; **deleting configuration never deletes
 * work**. Delete removes the definition, its steps, and its draft, nothing
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
 * start runs when `activatedAt is not null and it has steps and every step
 * is assigned to a team that exists`; `activatedAt` not null implies at
 * least one step, every one assigned at the moment of Turn on.
 * A step whose team was deleted is **unassigned** (`teamId` null, or an id
 * no D1 row carries — read as null everywhere). **Needs attention** is the
 * badge for a workflow, run, or team with an unassigned step or a team with
 * no members; it is derived on every read, never stored, and the fix is
 * always **assign a team** or add a member. Unassigned refuses Apply and
 * Turn on; an empty team is a warning only. Steps change only through Apply,
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
 * is the primary key), holding the steps being edited as `WorkflowDraftStep`
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
 * renames every step it owns, and a step can only be *applied* against a
 * team that exists. `null` is **unassigned** — what a team delete leaves
 * behind — and an id no D1 row carries reads the same way. It carries no
 * `teamName`: the name is joined at read time, and only the eventual
 * instance rows snapshot it.
 *
 * Workflow steps and draft steps have the same shape but live in two tables
 * (`WorkflowStep`, `WorkflowDraftStep`), so a step-id write can never be
 * ambiguous about which side it targets and `unique (workflowId, position)`
 * holds on each side independently. Only `applyDraft` writes `WorkflowStep`;
 * every editor write targets the draft. Apply carries draft step ids over to
 * the workflow; Edit copies workflow steps into the draft under new ids.
 *
 * `stage` groups steps that are ready together: along `position` the stages
 * are dense `1..m` and non-decreasing (`1 1 2 3 3`), so every step belongs to
 * exactly one stage and a stage of one step is the plain linear case. The
 * invariant lives in `WorkflowLayout`, which recomputes the whole layout for
 * every edit rather than patching rows.
 */
export const WorkflowStep = Schema.Struct({
  id: WorkflowStepId,
  workflowId: WorkflowId,
  position: Schema.Number,
  stage: Schema.Number,
  name: StepName,
  teamId: Schema.NullOr(TeamId),
  instructions: Schema.NullOr(StepInstructions),
});
export type WorkflowStep = typeof WorkflowStep.Type;

export const WorkflowDraftStep = WorkflowStep;
export type WorkflowDraftStep = typeof WorkflowDraftStep.Type;

/**
 * List row. `tag` and `stepCount` describe the workflow; `hasDraft` says
 * what starts runs today is not what is being edited. `needsAttention` is the
 * derived badge from {@link Workflow}: a step unassigned or on a team with no
 * members, computed against the live roster on every list read.
 */
const WorkflowSummaryRowFields = {
  hasDraft: SqliteBoolean,
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

/** The shape run creation reads: a workflow with its steps. Drafts never appear here. */
export const WorkflowDetail = Schema.Struct({
  workflow: Workflow,
  steps: Schema.Array(WorkflowStep),
});
export type WorkflowDetail = typeof WorkflowDetail.Type;

export const WorkflowDraftSteps = Schema.Struct({
  draft: WorkflowDraft,
  steps: Schema.Array(WorkflowDraftStep),
});
export type WorkflowDraftSteps = typeof WorkflowDraftSteps.Type;

/** What `WorkflowRepository.getWorkflow` returns: the workflow with its steps, and the draft with its steps when one exists. */
export const WorkflowWithDraft = Schema.Struct({
  ...WorkflowDetail.fields,
  draft: Schema.NullOr(WorkflowDraftSteps),
});
export type WorkflowWithDraft = typeof WorkflowWithDraft.Type;

/**
 * What the detail page renders, in one socket round trip: the workflow
 * (read-only, what starts runs) and the draft (what the editor writes), each
 * with its steps. Both attention states are derived here against the live
 * roster and never stored: `teamName` is `null` when the step is unassigned
 * (`teamId` null, or an id no team carries) — a flag, not a block in the
 * editor; the step renders with an empty picker and everything else stays
 * editable. `memberCount` is the team's live headcount (`null` when
 * unassigned) so the page can warn "No members on <team>". `teams` rides
 * along so the team picker needs no second call.
 */
const StepWithTeamName = Schema.Struct({
  ...WorkflowStep.fields,
  teamName: Schema.NullOr(TeamName),
  memberCount: Schema.NullOr(Schema.Number),
});
export type StepWithTeamName = typeof StepWithTeamName.Type;

export const WorkflowDraftView = Schema.Struct({
  draft: WorkflowDraft,
  steps: Schema.Array(StepWithTeamName),
});
export type WorkflowDraftView = typeof WorkflowDraftView.Type;

export const WorkflowDetailView = Schema.Struct({
  workflow: Workflow,
  steps: Schema.Array(StepWithTeamName),
  draft: Schema.NullOr(WorkflowDraftView),
  teams: Schema.Array(TeamRoster),
});
export type WorkflowDetailView = typeof WorkflowDetailView.Type;

/** A step is unassigned when its team is null or resolves to no team; the name is the tell after the roster join. */
export const isUnassigned = (step: StepWithTeamName) => step.teamName === null;

/** Assigned to a team nobody is on: a warning, never a blocker. */
export const hasEmptyTeam = (step: StepWithTeamName) =>
  step.teamName !== null && step.memberCount === 0;

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
 * dialog; the repository copies steps and stages and leaves the copy off with
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
 * asked to Apply steps that have never run and then turn on the thing they
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
  name: StepName,
  teamId: BoundedId,
  instructions: Schema.optionalKey(StepInstructions),
});
export type AddStepInput = typeof AddStepInput.Type;

/** Same as {@link AddStepInput} but into an existing stage: the new step lands after that stage's last step and is ready together with it. */
export const AddParallelStepInput = Schema.Struct({
  workflowId: BoundedId,
  stage: Schema.Number,
  name: StepName,
  teamId: BoundedId,
  instructions: Schema.optionalKey(StepInstructions),
});
export type AddParallelStepInput = typeof AddParallelStepInput.Type;

/** `instructions: null` clears; the UI maps a blank field to `null` before sending. */
export const UpdateStepInput = Schema.Struct({
  stepId: BoundedId,
  name: StepName,
  teamId: BoundedId,
  instructions: Schema.NullOr(StepInstructions),
});
export type UpdateStepInput = typeof UpdateStepInput.Type;

/**
 * The whole workflow fixture for `ShopAgent.seedWorkflows`, steps inline: one
 * declarative payload written in one transaction, rather than a
 * `createWorkflow` + `addStep`-per-step conversation whose failure midway
 * leaves a half-built definition. `position` is array order; `teamId` is a D1
 * `Team.id` the caller has already created, so the team check `AddStepInput`
 * exists to trigger has nothing left to catch — or `null`, which seeds the
 * step **unassigned** so the needs-attention state is visible after
 * `pnpm seed`. A step with no `stage` gets the previous step's stage + 1
 * (linear); the repository validates the stage invariant before writing.
 *
 * `steps` become the workflow's steps; a fixture with no steps and no
 * `draft` has no draft, the state the ordinary path produces for a fresh
 * workflow. `active` is the fixture's word for the switch and defaults to
 * `true` when the entry has steps and every step is assigned; the
 * repository stores it as `activatedAt = now`, so seeded orders qualify.
 * `draft` seeds a pending draft (steps) for fixtures that show the draft UI.
 */
const SeedWorkflowStep = Schema.Struct({
  name: StepName,
  teamId: Schema.NullOr(TeamId),
  stage: Schema.optionalKey(Schema.Number),
  instructions: Schema.optionalKey(StepInstructions),
});

export const SeedWorkflowsInput = Schema.Struct({
  workflows: Schema.Array(
    Schema.Struct({
      name: WorkflowName,
      active: Schema.optionalKey(Schema.Boolean),
      tag: WorkflowTag,
      steps: Schema.Array(SeedWorkflowStep),
      draft: Schema.optionalKey(
        Schema.Struct({ steps: Schema.Array(SeedWorkflowStep) }),
      ),
    }),
  ),
});
export type SeedWorkflowsInput = typeof SeedWorkflowsInput.Type;

export const StepDirection = Schema.Literals(["up", "down"]);
export type StepDirection = typeof StepDirection.Type;

/**
 * `moveStep`: the step takes a stage of its own past the neighbouring
 * boundary (`WorkflowLayout.move`). Reordering never makes a step parallel
 * with another; that is `joinStep`.
 */
export const MoveStepInput = Schema.Struct({
  stepId: BoundedId,
  direction: StepDirection,
});
export type MoveStepInput = typeof MoveStepInput.Type;

export const StepIdInput = Schema.Struct({ stepId: BoundedId });
export type StepIdInput = typeof StepIdInput.Type;

/** `separateStep`: the step leaves its stage into a new stage of its own immediately after it. */
export const SeparateStepInput = StepIdInput;
export type SeparateStepInput = typeof SeparateStepInput.Type;

/** `joinStep`: the step merges into the previous stage, after that stage's last member. */
export const JoinStepInput = StepIdInput;
export type JoinStepInput = typeof JoinStepInput.Type;

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

/** `StepUnassigned` names the offending steps so the page can say which to assign. Apply is about steps only; the tag never reaches it. */
export const ApplyResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NoDraft") }),
  Schema.Struct({ _tag: Schema.Literal("NoSteps") }),
  Schema.Struct({
    _tag: Schema.Literal("StepUnassigned"),
    stepNames: Schema.Array(StepName),
  }),
]);
export type ApplyResult = typeof ApplyResult.Type;

/** Discard is always allowed; on a never-applied workflow it leaves zero steps and no draft. */
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
  Schema.Struct({ _tag: Schema.Literal("NoSteps") }),
  Schema.Struct({
    _tag: Schema.Literal("StepUnassigned"),
    stepNames: Schema.Array(StepName),
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

export const StepResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    step: Schema.NullOr(WorkflowStep),
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Limit"), limit: Schema.Number }),
  /** The picked team no longer exists in D1: it was deleted under the editor. */
  Schema.Struct({ _tag: Schema.Literal("TeamNotFound") }),
]);
export type StepResult = typeof StepResult.Type;

/** Delete a workflow and its runs stay on their orders. */
export const DeleteWorkflowResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Deleted") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type DeleteWorkflowResult = typeof DeleteWorkflowResult.Type;

/**
 * Delete a team and its steps become unassigned; nothing refuses. `Deleted`
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
 * Workflow and draft steps are configuration; `openRunSteps` are work in
 * progress that will wait until someone assigns a team.
 */
export const TeamDeleteCounts = Schema.Struct({
  workflowSteps: Schema.Number,
  draftSteps: Schema.Number,
  openRunSteps: Schema.Number,
});
export type TeamDeleteCounts = typeof TeamDeleteCounts.Type;

/** One row per team that owns anything; a team absent from the list owns nothing. */
export const TeamStepCounts = Schema.Struct({
  teamId: TeamId,
  ...TeamDeleteCounts.fields,
});
export type TeamStepCounts = typeof TeamStepCounts.Type;

/** A step of the workflow or of its draft that points at a team; the team page lists both sides and links each to its workflow page. */
export const OwnedStep = Schema.Struct({
  workflowId: WorkflowId,
  workflowName: WorkflowName,
  /** Beside the name wherever a workflow is listed off its own page: names may repeat, the tag may not. */
  workflowTag: WorkflowTag,
  side: Schema.Literals(["workflow", "draft"]),
  stepName: StepName,
});
export type OwnedStep = typeof OwnedStep.Type;

/** {@link OwnedStep} for every team at once, keyed by team: the teams index's "Used by" column in one object read. */
export const OwnedStepByTeam = Schema.Struct({
  teamId: TeamId,
  ...OwnedStep.fields,
});
export type OwnedStepByTeam = typeof OwnedStepByTeam.Type;

/** Assign a team to any open run step: the remedy that makes team delete safe, and the merchant's way to move work between teams. */
export const AssignRunStepTeamInput = Schema.Struct({
  runStepId: BoundedId,
  teamId: BoundedId,
});
export type AssignRunStepTeamInput = typeof AssignRunStepTeamInput.Type;

/**
 * Any open step reassigns, started or not: only `teamId` / `teamName` move,
 * so `startedBy` / `startedByEmail` stay and history keeps whoever began it.
 * `StepFinished` refuses a completed step because the write would overwrite
 * `teamName`, the record of which team completed it.
 */
export const AssignRunStepTeamResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Assigned") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("TeamNotFound") }),
  Schema.Struct({ _tag: Schema.Literal("StepFinished") }),
  /** The step's run is not {@link runIsOpen}; see the {@link RunStatus} table. */
  Schema.Struct({ _tag: Schema.Literal("RunNotOpen") }),
]);
export type AssignRunStepTeamResult = typeof AssignRunStepTeamResult.Type;

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
 * order page; the picker there offers exactly these. Written by reconcile
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
 * Progress for one seeded run: `done` completes every step; `advance`
 * completes that many rounds of ready steps; `started` then Starts what is
 * ready; `blocked` flags the run.
 */
const SeedProgressFields = {
  done: Schema.optionalKey(Schema.Boolean),
  /**
   * Rounds of progress before the run is left alone: each round completes
   * every step that was *ready* when the round began, and what that makes
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
  blocked: Schema.optionalKey(StepNote),
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
 * Never stored: computed from the order row and its run counts on every read,
 * which is what makes the packer's round trip automatic — fulfil in Shopify,
 * `orders/fulfilled` stores `FULFILLED`, the next read says `shipped`, and the
 * order leaves the Ready-to-ship list without anyone touching Baton.
 *
 * The rule is a function, not a table: {@link productionState} is the one
 * definition, its precedence is documented there, and the SQL filters in
 * `OrderRepository.listOrders` restate its branches and must move with it.
 * Readers (`app.orders.index.tsx`) switch on the value for labels and
 * filters only; no site decides anything by comparing it inline.
 */
export const ProductionState = Schema.Literals([
  "no_workflow",
  "multiple_workflows",
  "in_production",
  "ready_to_ship",
  "shipped",
  "cancelled",
]);
export type ProductionState = typeof ProductionState.Type;

/**
 * The orders index's stage filter, which is {@link ProductionState} plus one
 * value that is not a stage.
 *
 * `null` is **open work**: everything except `shipped` and `cancelled`. It is
 * the default because retention keeps a year of orders
 * ({@link ShopLimits.orderRetentionDays}) and a merchant opening Orders is
 * looking at the bench, not at the year. `"all"` is the escape hatch that
 * shows the closed ones too, and is the only value here that crosses the open
 * and closed sets — which is why it is not a `ProductionState`: nothing
 * derives it from an order, and `productionState` must never return it.
 */
export const OrdersFilterState = Schema.Union([
  ProductionState,
  Schema.Literal("all"),
]);
export type OrdersFilterState = typeof OrdersFilterState.Type;

/**
 * Keyset cursor over `(processedAt desc, id desc)`, encoded as
 * `<processedAt>:<id>`. Not an offset: the bulk stream and webhooks both insert
 * while a merchant pages, and `limit/offset` would drop or repeat rows under
 * those writes.
 */
export const OrdersCursor = Schema.String.check(Schema.isMaxLength(128));

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
  /** {@link OrdersFilterState}: `null` is open work, `"all"` is every order, and each stage has a SQL form in `OrderRepository.listOrders` that restates `productionState`. */
  state: Schema.NullOr(OrdersFilterState),
  /** `null` is any payment state; `true`/`false` filters on `fullyPaid`, the run-creation gate. */
  paid: Schema.NullOr(Schema.Boolean),
  /** `true` keeps only orders with an open run that needs attention (see `OrderRow.attention`). */
  attention: Schema.Boolean,
  /**
   * `null` is any team; an id keeps only orders with a ready step on that
   * team — "waiting on", the run list's own predicate, not "owns a step
   * somewhere in the run". The looser reading pulls in orders the team
   * finished days ago and orders it will not touch for two more stages, so
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
   * **Needs attention**, derived at read time against the live D1 roster and
   * never stored: an open run has an open step that is unassigned (`teamId`
   * null or no longer in the roster) or a ready step on a team with no
   * members. The order page's "Assign team" picker and the members screen
   * are the remedies; either clears this with no further write.
   */
  attention: Schema.Boolean,
  /**
   * Teams with a ready step on an open run of this order, distinct, as ids:
   * "who is holding it", answered at the altitude the list grows with — a
   * shop has a handful of teams, while its runs are a cross product of line
   * items and matching workflows.
   *
   * Unassigned ready steps contribute nothing, and neither does a team that
   * has left the roster: both are `attention`, and rendering one fault in two
   * cells makes it look like two alarms. A blocked run contributes nothing
   * either: its team cannot move it, and `RunCounts.blocked` is its alarm. A
   * team still on the roster but with
   * no members does contribute: it is `attention` too, but the badge names
   * the team the merchant has to staff. So an order in production with an
   * empty list is exactly an order whose every ready step is unassigned or
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
 * `null` is an unpaid order with no runs: nothing to say, and not a state a
 * person acts on. Cancelled wins over everything because it is the only stop
 * gate; `shipped` is checked next, before the run counts, so an order
 * fulfilled with runs still open reads as shipped (the runs carry the
 * `order_fulfilled` flag) and an order fulfilled with no runs at all — every
 * historical order the window sync pulls in — reads as shipped rather than
 * as a "No workflow" warning nobody can act on. The SQL forms in
 * `OrderRepository.listOrders` restate these branches and must move with them.
 *
 * `multiple_workflows` sits above `in_production` and below `shipped`: an
 * ambiguity is a merchant decision blocking an item the merchant *meant* to
 * route, so it outranks the aggregate stage even when other items on the order
 * are already being made. A plain unrouted item is not a pending decision,
 * which is why `no_workflow` stays below `in_production`.
 *
 * Takes the three fields it reads rather than a whole `OrderRow`, so the order
 * page — which rebuilds the aggregate from its own run list — does not have
 * to invent a value for every row field the index adds later.
 */
export const productionState = ({
  order,
  runs,
  ambiguousItems,
}: Pick<
  OrderRow,
  "order" | "runs" | "ambiguousItems"
>): ProductionState | null =>
  Match.value({
    cancelled: isCancelled(order),
    fulfilled: isFulfilled(order),
    none: runs.open === 0 && runs.done === 0,
    canStart: canStartRuns(order),
    open: runs.open > 0,
    ambiguous: ambiguousItems > 0,
  }).pipe(
    Match.withReturnType<ProductionState | null>(),
    Match.when({ cancelled: true }, () => "cancelled"),
    Match.when({ fulfilled: true }, () => "shipped"),
    Match.when(
      { cancelled: false, fulfilled: false, canStart: true, ambiguous: true },
      () => "multiple_workflows",
    ),
    Match.when({ none: true, canStart: true }, () => "no_workflow"),
    Match.when({ none: true }, () => null),
    Match.when({ open: true }, () => "in_production"),
    Match.orElse(() => "ready_to_ship"),
  );

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
 * How many orders sit in each *open* stage, for the stage strip on the index.
 * Only the open stages are counted: they are read through the partial index
 * over unfulfilled, uncancelled orders, so the count costs one row per open
 * order, not one per order ever stored. "All" and "Shipped" carry no count —
 * on a shop with years of history that would be a full-table read on every
 * refresh of a subscribed page. Independent of the `paid` and `team` filters
 * so the strip reads the same whichever payment view or team is showing.
 */
export const OpenStageCounts = Schema.Struct({
  no_workflow: Schema.Number,
  multiple_workflows: Schema.Number,
  in_production: Schema.Number,
  ready_to_ship: Schema.Number,
  /** Open orders with `OrderRow.attention`; a cross-cutting count, not a stage. */
  attention: Schema.Number,
});
export type OpenStageCounts = typeof OpenStageCounts.Type;

export const OrdersPage = Schema.Struct({
  orders: Schema.Array(OrderRow),
  limit: Schema.Number,
  nextCursor: Schema.NullOr(OrdersCursor),
  openCounts: OpenStageCounts,
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
  /** `Member` rows in D1, against `Entitlements.maxMembers`. */
  readonly memberCount: number;
  /** The next contract boundary. */
  readonly planBoundaryAt: number | null;
}

/** `/login` (`login`). */
export interface LoginLoaderData {
  readonly isDemoMode: boolean;
}

/**
 * `/app/orders` (`app.orders.index`): the first page, plus the quota context
 * the page's banners need.
 *
 * `view` is what the socket replaces on every order push; `usage` and
 * `ordersPerCycle` are loader-only and deliberately do not move under the
 * socket. A quota is a billing-period fact and a plan an even slower one —
 * refreshing either on every webhook would be a read per push for a number that
 * changes on a scale of days.
 */
export interface OrdersIndexLoaderData {
  readonly view: OrdersView;
  readonly usage: ShopUsage;
  readonly ordersPerCycle: number;
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
  /**
   * The plan's seats. `members` is already ordered `createdAt, email` — the
   * same order {@link memberHasSeat} ranks by — so the page reads the cutoff
   * off the row index and no per-row seat flag is sent.
   */
  readonly maxMembers: number;
}

/**
 * `/app/teams` (`app.teams.index`). `ownedSteps` is Durable Object data
 * joined into a D1 page by the loader (the loader-versus-socket rule on
 * `ShopAgentClient`), grouped per team into the "Used by" column.
 */
export interface TeamsIndexLoaderData {
  readonly teams: readonly TeamSummary[];
  readonly ownedSteps: readonly OwnedStepByTeam[];
}

/**
 * `/app/teams/$teamId` (`app.teams.$teamId`; a param tail contributes its
 * noun, `Team`). `ownedSteps` and `stepCounts` are Durable Object data joined
 * into a D1 page by the loader — see the loader-versus-socket rule on
 * `ShopAgentClient`. `memberTeams` is the hint the Add members
 * dialog shows beside each candidate: where they already work.
 */
export interface TeamLoaderData extends TeamDetail {
  readonly memberTeams: readonly MemberTeam[];
  readonly ownedSteps: readonly OwnedStep[];
  readonly stepCounts: TeamDeleteCounts;
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
 * Who did a step action, as a closed union rather than a set of nullable
 * columns read together. The merchant has no member id and no email — they
 * act through the embedded admin, where identity is the Shopify session, not
 * a `Member` row — so inferring "merchant" from a null email would make every
 * reader re-derive the same rule and would collide with a member row whose
 * email columns are legitimately null (a step nobody has touched). The role
 * discriminator is stored beside the id and email on the row, and the
 * accessors below ({@link stepStartedBy} and friends) are the only place the
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
 * yet reads the same way on the page ({@link stepReopenedBy}).
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

/** Whether two actor slots hold the same person: the merchant is one person, and members are the same by email. */
export const sameActor = (a: Actor, b: Actor) =>
  a.role === "merchant" ? b.role === "merchant" : actorIsMember(b, a.email);

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

export const WorkflowRunStepId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowRunStepId"),
);
export type WorkflowRunStepId = typeof WorkflowRunStepId.Type;

/** How a run came to exist: a tag match during an order upsert, or an admin attaching by hand. */
export const RunSource = Schema.Literals(["tag", "manual"]);
export type RunSource = typeof RunSource.Type;

/**
 * Derived from the run's steps and stored for querying; every step write
 * recomputes it in the same transaction. `cancelled` is the one value steps
 * cannot produce — reconcile sets it on a `pending` run whose work vanished,
 * a person sets it from anywhere but `done`, and un-cancel recomputes from
 * the steps again.
 *
 * What each status allows. The gate column is the rule; the enforcing write
 * refuses with `RunTerminalError` when it fails, and every page that offers
 * a button reads the same predicate rather than restating it.
 *
 * | action                          | gate                                  |
 * | ------------------------------- | ------------------------------------- |
 * | Start, Done                     | {@link runIsOpen}, and the step ready |
 * | note on a step                  | {@link runIsLive}: a note is a record, not work |
 * | Block                           | {@link runIsOpen}, and a ready step   |
 * | Put back (clear a step's Start) | {@link runIsOpen}, and the step started and ready |
 * | assign a step's team            | {@link runIsOpen}, and the step open  |
 * | Cancel                          | {@link runIsOpen}                     |
 * | Undo (reopen a finished step)   | {@link runIsLive}, see {@link undoBlockedBy} |
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
 * Nobody has touched it: no step started or finished. Reconcile treats such
 * a run as free to cancel or resize silently when the order moves under it,
 * where a started run is flagged instead, because "someone has started
 * work" is exactly what should protect a run from a silent cancel.
 */
export const runIsUnstarted = (run: { readonly status: RunStatus }) =>
  run.status === "pending";

/** Work can still be recorded: Start, Done, notes, Block, team assignment, cancel. */
export const runIsOpen = (run: { readonly status: RunStatus }) =>
  run.status === "pending" || run.status === "active";

/** The last step's Done: no work is recorded on it again unless Undo reopens it. */
export const runIsDone = (run: { readonly status: RunStatus }) =>
  run.status === "done";

/**
 * The run still stands for its line item. Only `cancelled` is out, because
 * only `cancelled` was chosen; `done` is the last step's Done and is undone
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
 * work back rather than doing more, and a held step is the one somebody needs
 * to write on. Put back is refused for the reason on
 * `WorkflowRunRepository.unstartStep`. The one action a flag itself allows is lifting it: Unblock for
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
  reason: Schema.optionalKey(StepNote),
  /**
   * Who blocked the run. Snapshotted like the step actors, so a deleted
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
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  cancelledAt: Schema.NullOr(Schema.Number),
});
export type WorkflowRun = typeof WorkflowRun.Type;

/**
 * A step copied from the definition at run creation. `teamName` is
 * snapshotted alongside `teamId` so the run list never joins D1. `teamId` is
 * the live pointer that puts the step on a team's list; a team delete nulls
 * it on *open* steps only (**unassigned**: red on the order page, on nobody's
 * list, waiting for **assign a team**), while a finished step keeps both the
 * id and the name. `startedBy` / `completedBy` are D1 `Member.id`s,
 * cross-store and unreferenced; `startedByEmail` / `completedByEmail` are
 * the snapshots taken at the action that keep history readable after the
 * member is deleted.
 *
 * Each of the three actor slots carries a `*ByRole` column, and that column
 * is the discriminator: the merchant leaves the id and email null (they have
 * no `Member` row), a member fills all three. Read them through
 * {@link stepStartedBy} / {@link stepCompletedBy} / {@link stepReopenedBy}
 * rather than by hand, and see {@link Actor} for why the role is stored
 * rather than inferred from a null email.
 *
 * `reopened*` is a *last-actor slot*, not a history: it records the most
 * recent Undo and the next `completeStep` clears it, so the line only shows
 * while the step is genuinely back open. There is no `reopenedBy` id
 * column — the reopener is only ever displayed, never joined. Undo also
 * clears the whole Start slot, so a reopened step reads Ready. Put back
 * clears the Start slot with no slot of its own: a put-back step is plain
 * Ready and the next Start writes a fresh record.
 *
 * A step is *ready* when it is open and nothing in an earlier stage is still
 * open; several steps of one run can be ready at once. `startedAt` is set by
 * Start (and backfilled by a Done without Start) and marks the run `active`.
 */
export const WorkflowRunStep = Schema.Struct({
  id: WorkflowRunStepId,
  runId: WorkflowRunId,
  position: Schema.Number,
  stage: Schema.Number,
  name: StepName,
  teamId: Schema.NullOr(TeamId),
  teamName: TeamName,
  instructions: Schema.NullOr(StepInstructions),
  startedAt: Schema.NullOr(Schema.Number),
  startedBy: Schema.NullOr(MemberId),
  startedByEmail: Schema.NullOr(Email),
  completedAt: Schema.NullOr(Schema.Number),
  completedBy: Schema.NullOr(MemberId),
  completedByEmail: Schema.NullOr(Email),
  note: Schema.NullOr(StepNote),
  startedByRole: Schema.NullOr(ConnectionRole),
  completedByRole: Schema.NullOr(ConnectionRole),
  reopenedAt: Schema.NullOr(Schema.Number),
  reopenedByRole: Schema.NullOr(ConnectionRole),
  reopenedByEmail: Schema.NullOr(Email),
  noteByRole: Schema.NullOr(ConnectionRole),
});
export type WorkflowRunStep = typeof WorkflowRunStep.Type;

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
 * {@link WorkflowRunStep}, so a {@link RunListStep} — which carries no
 * `completed*` slot at all — is as good an argument as a finished one.
 */
export const stepStartedBy = (
  step: Pick<WorkflowRunStep, "startedByRole" | "startedBy" | "startedByEmail">,
) => actorFrom(step.startedByRole, step.startedBy, step.startedByEmail);

export const stepCompletedBy = (step: WorkflowRunStep) =>
  actorFrom(step.completedByRole, step.completedBy, step.completedByEmail);

/**
 * The reopener. Narrower than the other two: the `reopened` slot has no id
 * column (see {@link WorkflowRunStep}), so this is an {@link ActorDisplay} —
 * enough for {@link actorLabel}, which is all anything does with it.
 */
export const stepReopenedBy = (
  step: Pick<WorkflowRunStep, "reopenedByRole" | "reopenedByEmail">,
): ActorDisplay | null => {
  if (step.reopenedByRole === null) return null;
  if (step.reopenedByRole === "merchant") return { role: "merchant" };
  return step.reopenedByEmail === null
    ? null
    : { role: "member", email: step.reopenedByEmail };
};

/**
 * A step's note as every screen prints it. The merchant is named because a
 * worker did not expect them; a member's note is unprefixed, since on the
 * run list and the work page the author is a teammate by default and
 * "Note (Member)" would say nothing a reader did not assume.
 */
export const stepNoteLine = (
  step: Pick<WorkflowRunStep, "noteByRole" | "note">,
) =>
  step.noteByRole === "merchant"
    ? `Note (Merchant): ${step.note ?? ""}`
    : `Note: ${step.note ?? ""}`;

/** An open run step whose team is gone: `teamId` null, or an id the roster no longer carries. */
export const isRunStepUnassigned = (
  step: WorkflowRunStep,
  teams: readonly { readonly id: TeamId }[],
) =>
  step.completedAt === null &&
  (step.teamId === null || !teams.some((team) => team.id === step.teamId));

/** A run is complete in itself: its steps are copies, and nothing here refers back to the definition. */
export const WorkflowRunDetail = Schema.Struct({
  run: WorkflowRun,
  steps: Schema.Array(WorkflowRunStep),
});
export type WorkflowRunDetail = typeof WorkflowRunDetail.Type;

/**
 * One ready step the member may act on, cut to what a run's row renders.
 * `startedByEmail` is read off the row — the snapshot taken at Start, never a
 * live join — and it is load-bearing beyond display: {@link tierOf} decides
 * "Mine" with it.
 *
 * Two groups of columns are omitted rather than carried as nulls. The four
 * `completed*` ones can never say anything here: readiness is `completedAt is
 * null` (`readyWhere`) and Undo clears the whole slot, so on a list step
 * every one of them is null by construction. The rest — instructions, the
 * note and its role, the reopened slot — say something, but only on the work
 * page: a row shows the step's name and one state clause, and everything
 * behind that is one tap away. Either way they are fields per step on every
 * SSR paint and every refetch.
 *
 * A finished step is a {@link DoneItem}, which carries the whole
 * {@link WorkflowRunStep} because there the slot is the point.
 */
export const RunListStep = Schema.Struct(
  Struct.omit(WorkflowRunStep.fields, [
    "completedAt",
    "completedBy",
    "completedByEmail",
    "completedByRole",
    "instructions",
    "note",
    "noteByRole",
    "reopenedAt",
    "reopenedByRole",
    "reopenedByEmail",
  ]),
);
export type RunListStep = typeof RunListStep.Type;

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
 * of every read, parsed on arrival, to render nothing.
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
 * One row of a member's run list: a run with every *ready* step — open, and
 * nothing in an earlier stage still open — that belongs to one of the
 * member's teams. `stageCount` is the run's last stage, for "step k of n".
 *
 * The order's live note is not here. It is the work page's, along with the
 * step instructions and the item's attributes: the row is a list entry that
 * names the piece and its state, and the page one tap behind it is where a
 * maker reads anything.
 */
export const RunListItem = Schema.Struct({
  run: RunListRun,
  steps: Schema.NonEmptyArray(RunListStep),
  stageCount: Schema.Number,
});
export type RunListItem = typeof RunListItem.Type;

/**
 * The four tiers a waiting row can fall in. Four of the five tabs
 * ({@link RunTab}) are these; `done` is not a tier because it is a window
 * over finished steps rather than a grouping of the list. The labels the
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
 * undone. Four are the tiers of {@link tierOf}; `done` is the finished-steps
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
 * Which tier a row belongs in: a flag wins; else a step the viewer
 * started; else any started step; else up next.
 *
 * "Mine" is by `startedByEmail`, not by the `startedBy` member id. Removing a
 * member and re-adding the same address mints a **new** `Member.id`
 * (`migrations/0001_init.sql`), so the id on a row taken before that stops
 * matching the person still standing at the bench, while the email — the
 * snapshot the migration calls the durable one — keeps matching. A merchant's
 * step has no email at all and so is nobody's, which is right: `Merchant` is
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
  { run, steps }: RunListItem,
  memberEmail: Email,
): RunTier => {
  if (run.flag !== null) return "attention";
  if (steps.some((step) => step.startedByEmail === memberEmail)) return "mine";
  if (steps.some((step) => step.startedAt !== null)) return "inProgress";
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
 * What stands between a finished step and Undo: the first later step someone
 * has already started (or finished), in a later stage of the same run. Once
 * downstream has moved the fix is a conversation, so the page names who to
 * ask rather than offering a button that would pull work out from under them.
 */
export const UndoBlocker = Schema.Struct({
  stepName: StepName,
  teamName: TeamName,
});
export type UndoBlocker = typeof UndoBlocker.Type;

/**
 * The lowest stage with an open step — where the run is — or `null` once
 * every step is done.
 */
export const lowestOpenStage = (steps: readonly WorkflowRunStep[]) =>
  steps
    .filter((step) => step.completedAt === null)
    .reduce<number | null>(
      (lowest, step) =>
        lowest === null ? step.stage : Math.min(lowest, step.stage),
      null,
    );

/**
 * The readiness rule on rows already in hand: a step is ready when its run
 * is {@link runIsOpen}, it is open, and nothing in an earlier stage of the
 * same run is still open. Several are ready at once on a parallel stage, so
 * this is a list and every caller copes with more than one. `readyWhere.ts`
 * is the same rule as SQL for the run list and the step guards; this is the one
 * TypeScript copy, for the merchant's order page (which holds every step of
 * the order) and the dev seeder (which walks runs a stage at a time), and the
 * test on it pins that the two agree.
 */
export const readySteps = (
  run: { readonly status: RunStatus },
  steps: readonly WorkflowRunStep[],
): WorkflowRunStep[] => {
  if (!runIsOpen(run)) return [];
  const lowest = lowestOpenStage(steps);
  return steps.filter(
    (step) => step.completedAt === null && step.stage === lowest,
  );
};

/**
 * The undo rule, on rows already in hand: the first step in a later stage of
 * the same run that anyone has started. A `startedAt` test covers finished
 * steps too, because Done backfills `startedAt`.
 *
 * Pure and here rather than in `WorkflowRunRepository` so the three readers
 * cannot disagree: the repository's own write, the verdicts it precomputes for
 * the member pages, and the merchant's order page, which holds every step of
 * every run on the order and decides client-side whether to offer Reopen. A
 * browser cannot import the repository module — it carries the SQL service —
 * and a second copy of this rule is exactly the drift to avoid.
 */
const firstStarted = (steps: readonly WorkflowRunStep[]) =>
  steps
    .filter((other) => other.startedAt !== null)
    .toSorted((a, b) => a.stage - b.stage || a.position - b.position)[0];

export const undoBlockedBy = (
  step: WorkflowRunStep,
  runSteps: readonly WorkflowRunStep[],
): UndoBlocker | null => {
  const blocker = firstStarted(
    runSteps.filter(
      (other) => other.runId === step.runId && other.stage > step.stage,
    ),
  );
  return blocker === undefined
    ? null
    : { stepName: blocker.name, teamName: blocker.teamName };
};

/**
 * One entry of the run list's "Done today" tier: a step one of the member's
 * teams completed inside the window, with its run for the card line and the
 * undo verdict precomputed by the object, which is the only side that can see
 * the downstream steps.
 */
export const DoneItem = Schema.Struct({
  run: WorkflowRun,
  step: WorkflowRunStep,
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
 * A run step on the work page, decorated with what the page needs to offer
 * the right button: `ready` is the run list's readiness rule evaluated for this
 * step, and `undoBlockedBy` is the undo verdict for a finished one. Both are
 * facts about *other* rows (earlier and later stages of the run), which is
 * why the object computes them rather than the page.
 */
export const RunStepView = Schema.Struct({
  ...WorkflowRunStep.fields,
  ready: Schema.Boolean,
  undoBlockedBy: Schema.NullOr(UndoBlocker),
});
export type RunStepView = typeof RunStepView.Type;

/**
 * What a member may do to a step, in one place for the work page and the
 * run list's Done tier so the buttons and the writes cannot disagree. Rules: the
 * {@link RunStatus} table for status (Start, Done and Put back need
 * {@link runIsOpen}; Undo and the note need {@link runIsLive}); the step's
 * team must be one of `teamIds`, as `WorkflowRunRepository.requireActionable`
 * requires; a flag stops Start, Done and Put back but not Undo or the note
 * ({@link runIsFlagged}); Undo is offered on a finished step and carries its
 * downstream blocker ({@link undoBlockedBy}) when there is one.
 *
 * Put back is offered wherever Done is, and only on a started step
 * (`WorkflowRunRepository.unstartStep`). It shares Done's team gate, so every
 * member of the step's team sees it, not only the starter.
 *
 * **Nothing on a member screen renders that blocker.** The run list drops the
 * row's menu and the work page lists the whole run, so the started step
 * standing in the way is already on screen wearing its own badge, and a
 * sentence naming it is the page arguing with itself. The merchant's order
 * page is the one screen that puts it in words, because it can reopen that
 * step and so has an instruction to give; the wording lives there, next to
 * the only thing that renders it.
 */
export const stepActions = (
  run: { readonly status: RunStatus; readonly flag: RunFlag | null },
  step: Pick<
    RunStepView,
    "teamId" | "ready" | "startedAt" | "completedAt" | "undoBlockedBy"
  >,
  teamIds: readonly string[],
): {
  readonly start: boolean;
  readonly done: boolean;
  readonly putBack: boolean;
  /** `null` when Undo is not offered; otherwise the blocker, `null` meaning the button. */
  readonly undo: { readonly blockedBy: UndoBlocker | null } | null;
  readonly note: boolean;
} => {
  const mine = step.teamId !== null && teamIds.includes(step.teamId);
  const live = mine && runIsLive(run);
  const ready =
    live &&
    runIsOpen(run) &&
    !runIsFlagged(run) &&
    step.ready &&
    step.completedAt === null;
  return {
    start: ready && step.startedAt === null,
    done: ready,
    putBack: ready && step.startedAt !== null,
    undo:
      live && step.completedAt !== null
        ? { blockedBy: step.undoBlockedBy }
        : null,
    note: live,
  };
};

/**
 * Everything `/shop/$shop/workflows/$runId` renders: one run, its steps, and the
 * order's live note.
 *
 * The other line items on the order are deliberately **not** here. A workflow
 * is attached to a product and runs once per matching line item
 * ({@link Workflow}), so a member's unit of work is the line item and its
 * steps. Nothing on this page acts on the order as a whole, and an order can
 * carry an unbounded number of lines to render.
 */
export const RunView = Schema.Struct({
  run: WorkflowRun,
  steps: Schema.Array(RunStepView),
  note: Schema.NullOr(Schema.String),
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
   * Active workflows with at least one step — the manual-attach picker's
   * choices. Carried in the view rather than read by a second socket query so
   * the page has exactly one read, one key, and one push.
   */
  itemWorkflows: Schema.Array(Workflow),
  /** The live roster: the "Assign team" picker's choices, and what decides which open steps are unassigned or on an empty team. */
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
 * {@link ListRunsInput}. The guard is "any step of the run on one of my
 * teams", not "a ready step": a member may open work they have finished.
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
export const CompleteStepInput = Schema.Struct({
  runStepId: BoundedId,
});
export type CompleteStepInput = typeof CompleteStepInput.Type;

export const DismissFlagInput = Schema.Struct({
  runId: BoundedId,
});
export type DismissFlagInput = typeof DismissFlagInput.Type;

export const StartStepInput = CompleteStepInput;
export type StartStepInput = typeof StartStepInput.Type;

/** Undo: re-opens a finished step. Same shape; the rule is on `WorkflowRunRepository.uncompleteStep`. */
export const UncompleteStepInput = CompleteStepInput;
export type UncompleteStepInput = typeof UncompleteStepInput.Type;

/** Put back: clears a started step's Start record. Same shape; the rule is on `WorkflowRunRepository.unstartStep`. */
export const UnstartStepInput = CompleteStepInput;
export type UnstartStepInput = typeof UnstartStepInput.Type;

/** `note: null` clears. */
export const SetStepNoteInput = Schema.Struct({
  runStepId: BoundedId,
  note: Schema.NullOr(StepNote),
});
export type SetStepNoteInput = typeof SetStepNoteInput.Type;

/** `reason: null` blocks without a reason. */
export const BlockRunInput = Schema.Struct({
  runId: BoundedId,
  reason: Schema.NullOr(StepNote),
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
  reason: Schema.NullOr(StepNote),
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
 * difference: present, it is the member's membership and the step's team must
 * be in it; absent, the caller is the merchant and the team clause is skipped
 * entirely. Every other rule — stage order, terminal runs, the downstream
 * undo guard — applies to both.
 */
export interface StartStepCommand {
  readonly runStepId: string;
  /** Member-only: there is no merchant Start — the merchant never claims work. */
  readonly actor: MemberActor;
  readonly teamIds?: readonly string[] | undefined;
}

export interface CompleteStepCommand {
  readonly runStepId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

export interface SetStepNoteCommand {
  readonly runStepId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
  readonly note: StepNote | null;
}

export interface BlockRunCommand {
  readonly runId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
  readonly reason: StepNote | null;
}

export interface DismissFlagCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No `actor`: the reason is one field anyone with access may write, last
 * write wins, and `flagDetail.by` stays whoever set the hold. Recording the
 * editor would be an attribution the UI never shows and a second person to
 * explain on a card with no room for one.
 */
export interface SetBlockReasonCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
  readonly reason: StepNote | null;
}

/** The actor lands in the step's `reopened` slot: undo is a fact worth showing, and the next Done clears it. */
export interface UncompleteStepCommand {
  readonly runStepId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No slot records the actor: the step is plain Ready again
 * ({@link WorkflowRunStep}). `actor` is taken for the log line and for
 * symmetry with the other step commands.
 */
export interface UnstartStepCommand {
  readonly runStepId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * `WorkflowCannotStart` = off, zero steps, or an unassigned step (see
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
 * `NotAllowed` = the step's team is not among the caller's; `NotReady` = a
 * step in an earlier stage is still open (or this one is already done; for
 * undo, not yet done; for put back, not yet started or already done); `Terminal` = the run's status refuses the action,
 * see the table on {@link RunStatus} (or, for un-cancel, the run is not
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
