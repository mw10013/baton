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
export const MemberId = Schema.NonEmptyString.pipe(Schema.brand("MemberId"));
export type MemberId = typeof MemberId.Type;

/**
 * `archivedAt` null = active. Same reasoning as {@link Team}: a member is
 * archived, never deleted, because the ShopAgent's `WorkflowRunStep.startedBy`
 * / `completedBy` (and the block flag's actor) hold `Member.id` as bare text
 * with no foreign key, so a deleted row would leave history resolving to
 * nobody. An archived member cannot sign in or be added to a team, but still
 * resolves as an actor on run history.
 */
export const Member = Schema.Struct({
  id: MemberId,
  shop: Shop,
  email: Email,
  createdAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
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
 * A shop-scoped grouping of members. `archivedAt` null = active; nothing hard
 * deletes a team, so a step or historical record can always resolve the name it
 * was owned by (`migrations/0001_init.sql`).
 */
export const Team = Schema.Struct({
  id: TeamId,
  shop: Shop,
  name: TeamName,
  createdAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
});
export type Team = typeof Team.Type;

export const TeamSummary = Schema.Struct({
  ...Team.fields,
  memberCount: Schema.Number,
});
export type TeamSummary = typeof TeamSummary.Type;

/**
 * The team plus every member of its shop, each flagged with whether they are on
 * it — the detail screen toggles membership against the whole roster, so the
 * non-members are as much a part of the view as the members.
 */
export const TeamDetail = Schema.Struct({
  team: Team,
  members: Schema.Array(
    Schema.Struct({ ...Member.fields, inTeam: SqliteBoolean }),
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
 * exist so `position` loops and tag scans are bounded, not to model a plan tier.
 */
export const WorkflowLimits = {
  maxWorkflows: 50,
  maxSteps: 20,
  maxTags: 20,
} as const;

const trimmedName = <B extends string>(brand: B) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.NonEmptyString.check(Schema.isMaxLength(64)).pipe(
        Schema.brand(brand),
      ),
      {
        decode: SchemaGetter.transform((s) => s.trim()),
        encode: SchemaGetter.transform((s) => s),
      },
    ),
  );

/** Same shape and reasoning as {@link TeamName}: trimmed, case preserved. */
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

/** Worker-written text about one run's step (or a block reason). Same trimming; `null` clears. */
export const StepNote = trimmedText("StepNote", 1000);
export type StepNote = typeof StepNote.Type;

/**
 * Trimmed *and* lowercased, unlike the names: a tag exists only to be matched
 * against `OrderLineItem.productTags`, merchants type `Engraving` and
 * `engraving` interchangeably, and Shopify's own admin search is
 * case-insensitive. Folding once at the boundary means matching later is a
 * plain set intersection over lowercased line-item tags. 255 is Shopify's tag
 * length limit.
 */
export const ProductTag = Schema.String.pipe(
  Schema.decodeTo(
    Schema.NonEmptyString.check(Schema.isMaxLength(255)).pipe(
      Schema.brand("ProductTag"),
    ),
    {
      decode: SchemaGetter.transform((s) => s.trim().toLowerCase()),
      encode: SchemaGetter.transform((s) => s),
    },
  ),
);
export type ProductTag = typeof ProductTag.Type;

/**
 * Dedupes *after* folding, so `["Engraving", "engraving"]` is one tag, and
 * drops blanks so a trailing comma in the tags field is not an error. The
 * ceiling is checked on what survives.
 */
export const ProductTags = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(
    Schema.Array(ProductTag).check(
      Schema.isMaxLength(WorkflowLimits.maxTags, {
        message: `At most ${String(WorkflowLimits.maxTags)} tags`,
      }),
    ),
    {
      decode: SchemaGetter.transform((tags) => [
        ...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
      ]),
      encode: SchemaGetter.transform((tags) => tags),
    },
  ),
);
export type ProductTags = typeof ProductTags.Type;

/**
 * A production workflow *definition*: which product tags select it, and (in
 * `WorkflowStep`) the ordered stops a matching line item will pass through.
 * Encoded side is the Durable Object row (epoch-ms integers, JSON `tags`).
 *
 * No `status` column: `archivedAt is null and stepCount > 0 and every step's
 * team is active` *is* "routes". Archive, never delete, so a future running
 * instance can always resolve the name it was copied from. Editing a definition
 * never rewrites history because instances copy their steps at creation.
 */
/**
 * `item`: runs once per matching line item (tag routed). `order`: runs once
 * per order, after every item run on it is finished — at most one active per
 * shop, never tag-selected, `tags` always empty. Set on create, never changed.
 */
export const WorkflowScope = Schema.Literals(["item", "order"]);
export type WorkflowScope = typeof WorkflowScope.Type;

export const Workflow = Schema.Struct({
  id: WorkflowId,
  name: WorkflowName,
  scope: WorkflowScope,
  tags: Schema.fromJsonString(ProductTags),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  archivedAt: Schema.NullOr(Schema.Number),
});
export type Workflow = typeof Workflow.Type;

/**
 * `teamId` is a live pointer to a D1 `Team`, not a snapshot: renaming a team
 * renames every step it owns, and a step can only be *saved* against an active
 * team. It carries no `teamName` — the name is joined at read time, and only
 * the eventual instance rows snapshot it.
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
  teamId: TeamId,
  instructions: Schema.NullOr(StepInstructions),
  createdAt: Schema.Number,
});
export type WorkflowStep = typeof WorkflowStep.Type;

export const WorkflowSummary = Schema.Struct({
  ...Workflow.fields,
  stepCount: Schema.Number,
  activeRunCount: Schema.Number,
});
export type WorkflowSummary = typeof WorkflowSummary.Type;

export const WorkflowDetail = Schema.Struct({
  workflow: Workflow,
  steps: Schema.Array(WorkflowStep),
});
export type WorkflowDetail = typeof WorkflowDetail.Type;

/**
 * What the detail page renders, in one socket round trip. `teamName` is
 * `null` when the step's team is archived or gone — a flag, not a block: the
 * workflow shows "needs attention", the step renders with an empty picker, and
 * everything else stays editable. `activeTeams` rides along so the team picker
 * needs no second call.
 */
export const WorkflowDetailView = Schema.Struct({
  workflow: Workflow,
  steps: Schema.Array(
    Schema.Struct({
      ...WorkflowStep.fields,
      teamName: Schema.NullOr(TeamName),
    }),
  ),
  activeTeams: Schema.Array(Schema.Struct({ id: TeamId, name: TeamName })),
});
export type WorkflowDetailView = typeof WorkflowDetailView.Type;

const BoundedId = Schema.NonEmptyString.check(Schema.isMaxLength(128));

export const ListWorkflowsInput = Schema.Struct({
  includeArchived: Schema.Boolean,
});
export type ListWorkflowsInput = typeof ListWorkflowsInput.Type;

export const WorkflowIdInput = Schema.Struct({ workflowId: BoundedId });
export type WorkflowIdInput = typeof WorkflowIdInput.Type;

/** `scope` omitted means `item`, so every pre-existing caller keeps its shape. */
export const CreateWorkflowInput = Schema.Struct({
  name: WorkflowName,
  scope: Schema.optionalKey(WorkflowScope),
  tags: ProductTags,
});
export type CreateWorkflowInput = typeof CreateWorkflowInput.Type;

export const UpdateWorkflowInput = Schema.Struct({
  workflowId: BoundedId,
  name: WorkflowName,
  tags: ProductTags,
});
export type UpdateWorkflowInput = typeof UpdateWorkflowInput.Type;

export const SetWorkflowArchivedInput = Schema.Struct({
  workflowId: BoundedId,
  archived: Schema.Boolean,
});
export type SetWorkflowArchivedInput = typeof SetWorkflowArchivedInput.Type;

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
 * `Team.id` the caller has already created, so the active-team check
 * `AddStepInput` exists to trigger has nothing left to catch. A step with no
 * `stage` gets the previous step's stage + 1 (linear); the repository
 * validates the stage invariant before writing. `archived` seeds the row
 * already archived, so a fixture can show archived workflows without a click;
 * the repository still enforces one active order workflow and no tags on an
 * order workflow, since a fixture that breaks either would leave the app in a
 * state the ordinary write path can never produce.
 */
export const SeedWorkflowsInput = Schema.Struct({
  workflows: Schema.Array(
    Schema.Struct({
      name: WorkflowName,
      scope: Schema.optionalKey(WorkflowScope),
      archived: Schema.optionalKey(Schema.Boolean),
      tags: ProductTags,
      steps: Schema.Array(
        Schema.Struct({
          name: StepName,
          teamId: TeamId,
          stage: Schema.optionalKey(Schema.Number),
          instructions: Schema.optionalKey(StepInstructions),
        }),
      ),
    }),
  ),
});
export type SeedWorkflowsInput = typeof SeedWorkflowsInput.Type;

export const StepDirection = Schema.Literals(["up", "down"]);
export type StepDirection = typeof StepDirection.Type;

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

export const TeamIdInput = Schema.Struct({ teamId: BoundedId });
export type TeamIdInput = typeof TeamIdInput.Type;

/**
 * Expected failures cross the socket as values, not throws: `runEffect`
 * collapses every failure into one `Error(message)` at the RPC seam, which is
 * fine for faults but loses the tag the page needs to put "name taken" on the
 * field rather than in a banner.
 */
export const WorkflowResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NameTaken") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Limit"), limit: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("OrderWorkflowExists") }),
]);
export type WorkflowResult = typeof WorkflowResult.Type;

export const StepResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    step: Schema.NullOr(WorkflowStep),
  }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("Limit"), limit: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("TeamNotActive") }),
  Schema.Struct({ _tag: Schema.Literal("Archived") }),
]);
export type StepResult = typeof StepResult.Type;

export const TeamArchiveResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok") }),
  Schema.Struct({ _tag: Schema.Literal("InUse"), count: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
]);
export type TeamArchiveResult = typeof TeamArchiveResult.Type;

export const OwnedStep = Schema.Struct({
  workflowId: WorkflowId,
  workflowName: WorkflowName,
  workflowArchived: SqliteBoolean,
  stepName: StepName,
});
export type OwnedStep = typeof OwnedStep.Type;

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
 *
 * `unfulfilledQuantity` is the number of units still to be made
 * ({@link unitsToMake}): Shopify lowers it when a unit ships **or is
 * refunded** while leaving `currentQuantity` alone for a refund, so it is the
 * one count a maker should never overshoot. `currentQuantity` stays as
 * "ordered" for display.
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
 * Units a maker should see and a run should snapshot. `unfulfilledQuantity`,
 * not `currentQuantity`: a refund lowers the former and leaves the latter, so
 * counting `currentQuantity` would have a maker build a unit nobody will
 * receive. `currentQuantity > 0` is implied.
 */
export const unitsToMake = (lineItem: OrderLineItem) =>
  lineItem.unfulfilledQuantity;

export const OrderDetail = Schema.Struct({
  order: ShopOrder,
  lineItems: Schema.Array(OrderLineItem),
});
export type OrderDetail = typeof OrderDetail.Type;

/** Ids of seeded orders carry this prefix so a reseed replaces only fixture rows and never a synced order. */
export const SEED_ORDER_ID_PREFIX = "gid://shopify/Order/seed-";

/**
 * Local-only order fixture, written through the ordinary upsert-and-reconcile
 * path so runs route exactly as they would for a webhook. `unfulfilledQuantity`
 * defaults to `currentQuantity`, which defaults to `quantity`; lowering one
 * seeds a refund or a partial shipment. `done` completes every step of every
 * run the order routes to, so a "Ready to ship" row exists without a person
 * clicking through the queue.
 */
export const SeedOrdersInput = Schema.Struct({
  memberId: MemberId,
  orders: Schema.Array(
    Schema.Struct({
      /** Numeric suffix: the id becomes `SEED_ORDER_ID_PREFIX + n` and the name `#<n>`. */
      n: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      fulfillmentStatus: Schema.optionalKey(Schema.String),
      done: Schema.optionalKey(Schema.Boolean),
      note: Schema.optionalKey(Schema.String),
      lineItems: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          quantity: Schema.Number,
          currentQuantity: Schema.optionalKey(Schema.Number),
          unfulfilledQuantity: Schema.optionalKey(Schema.Number),
          tags: Schema.Array(Schema.String),
          customAttributes: Schema.optionalKey(Schema.Array(OrderAttribute)),
        }),
      ),
    }),
  ),
});
export type SeedOrdersInput = typeof SeedOrdersInput.Type;

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
 * Never stored: computed from the order row and its run counts on every read,
 * which is what makes the packer's round trip automatic — fulfil in Shopify,
 * `orders/updated` stores `FULFILLED`, the next read says `shipped`, and the
 * order leaves the Ready-to-ship list without anyone touching Baton.
 */
export const ProductionState = Schema.Literals([
  "not_routed",
  "in_production",
  "ready_to_ship",
  "shipped",
  "cancelled",
]);
export type ProductionState = typeof ProductionState.Type;

/**
 * Keyset cursor over `(processedAt desc, id desc)`, encoded as
 * `<processedAt>:<id>`. Not an offset: the bulk stream and webhooks both insert
 * while a merchant pages, and `limit/offset` would drop or repeat rows under
 * those writes.
 */
export const OrdersCursor = Schema.String.check(Schema.isMaxLength(128));

/**
 * `sessionToken` is what subscribes the calling connection to invalidations —
 * the `activate<Feature>` convention documented on `ShopAgent.activateOrders`.
 * A page that only reads is a page that never hears about a write: the Durable
 * Object pushes to attached connections only, and the `/app` socket is shared,
 * so a route that read without attaching would go silent the moment another
 * route's unmount detached the connection.
 */
export const ActivateOrdersInput = Schema.Struct({
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 50 }),
  ),
  cursor: Schema.NullOr(OrdersCursor),
  /** `null` is every order; only `ready_to_ship` has a SQL form today (see `OrderRepository.listOrders`). */
  state: Schema.NullOr(ProductionState),
  sessionToken: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type ActivateOrdersInput = typeof ActivateOrdersInput.Type;

export const ResyncOrderInput = Schema.Struct({
  orderId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type ResyncOrderInput = typeof ResyncOrderInput.Type;

/**
 * Per-order production state for the index table, aggregated from
 * `WorkflowRun` rows in the same read. Counts every run on the order, item
 * runs and the order run alike; it is not a view of the order run, which is
 * why the name avoids "order run". `open` counts `pending` and `active`
 * runs; cancelled runs count nowhere, so an order whose only runs were
 * cancelled reads as unrouted — which is what an admin has to act on.
 */
export const RunCounts = Schema.Struct({
  open: Schema.Number,
  done: Schema.Number,
  flagged: Schema.Number,
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
});
export type OrderRow = typeof OrderRow.Type;

/**
 * `null` is an unpaid order with no runs: nothing to say, and not a state a
 * person acts on. Cancelled wins over everything because it is the only stop
 * gate; `shipped` is checked before the run counts so an order fulfilled with
 * runs still open reads as shipped (the runs carry the `order_fulfilled`
 * flag). The SQL form of `ready_to_ship` in `OrderRepository.listOrders`
 * restates the last two branches and must move with them.
 */
export const productionState = ({
  order,
  runs,
}: OrderRow): ProductionState | null =>
  Match.value({
    cancelled: isCancelled(order),
    none: runs.open === 0 && runs.done === 0,
    canStart: canStartRuns(order),
    fulfilled: isFulfilled(order),
    open: runs.open > 0,
  }).pipe(
    Match.withReturnType<ProductionState | null>(),
    Match.when({ cancelled: true }, () => "cancelled"),
    Match.when({ none: true, canStart: true }, () => "not_routed"),
    Match.when({ none: true }, () => null),
    Match.when({ fulfilled: true }, () => "shipped"),
    Match.when({ open: true }, () => "in_production"),
    Match.orElse(() => "ready_to_ship"),
  );

/** The index's per-order aggregate, recomputed from a detail page's run list so both pages share one definition. */
export const runCounts = (runs: readonly WorkflowRun[]): RunCounts =>
  runs.reduce<RunCounts>(
    (counts, run) => {
      const open = run.status === "pending" || run.status === "active";
      return {
        open: counts.open + (open ? 1 : 0),
        done: counts.done + (run.status === "done" ? 1 : 0),
        flagged: counts.flagged + (open && run.flag !== null ? 1 : 0),
      };
    },
    { open: 0, done: 0, flagged: 0 },
  );

export const OrdersPage = Schema.Struct({
  orders: Schema.Array(OrderRow),
  limit: Schema.Number,
  nextCursor: Schema.NullOr(OrdersCursor),
  orderCount: Schema.Number,
});
export type OrdersPage = typeof OrdersPage.Type;

/**
 * The detail page is addressed by `legacyId`, not the GID: the GID contains
 * slashes, and the legacy id is what the Shopify admin puts in its own URL.
 */
export const ActivateOrderInput = Schema.Struct({
  legacyId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  /** Subscribes the connection to pushes; see `ActivateOrdersInput`. */
  sessionToken: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
export type ActivateOrderInput = typeof ActivateOrderInput.Type;

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
 * the guard. The sibling `../bang` project is that seam realized: its
 * attachment is `{ sessionToken, memoryKeys }` and its notifier pushes only to
 * connections watching the keys that changed. Baton has one message type and
 * two routes, so every attached connection is poked; grow the struct when a
 * second thing needs filtering, not before.
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

export const WorkflowRunId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowRunId"),
);
export type WorkflowRunId = typeof WorkflowRunId.Type;

export const WorkflowRunStepId = Schema.NonEmptyString.pipe(
  Schema.brand("WorkflowRunStepId"),
);
export type WorkflowRunStepId = typeof WorkflowRunStepId.Type;

/** How a run came to exist: tag routing during an order upsert, or an admin attaching by hand. */
export const RunSource = Schema.Literals(["tag", "manual"]);
export type RunSource = typeof RunSource.Type;

/**
 * Derived from the run's steps and stored for querying; every step write
 * recomputes it in the same transaction. `cancelled` is the one value steps
 * cannot produce — reconcile sets it on a `pending` run whose work vanished,
 * a person sets it from anywhere but `done`, and un-cancel recomputes from
 * the steps again.
 */
export const RunStatus = Schema.Literals([
  "pending",
  "active",
  "done",
  "cancelled",
]);
export type RunStatus = typeof RunStatus.Type;

/**
 * Attention markers reconcile leaves on an `active` run when the order under
 * it changed. A `pending` run is cancelled or updated silently instead — no
 * one has started it — and a `done` run is never touched. A later flag
 * overwrites an earlier one; a person clears it from the queue.
 *
 * `blocked` is the one flag a person sets rather than reconcile: a worker
 * marking the run as needing attention, with an optional reason. A later
 * reconcile flag overwrites it like any other.
 *
 * `item_added` is set only on an order run: a line item run appeared (new
 * item, manual attach, un-cancel) after the order run started, so "all items
 * made" no longer holds. Unlike item-run flags it lands on a `pending` order
 * run too, because there is no silent adjustment that restores the premise.
 *
 * `order_fulfilled` is set by reconcile alone when the stored order reaches
 * exactly `FULFILLED` while runs are open: active item runs and open order
 * runs (pending too, for the `item_added` reason) get it; pending item runs
 * are cancelled instead. A partial fulfilment never sets it — the shipped
 * line's `unfulfilledQuantity` hits zero and reads as `item_removed`.
 */
export const RunFlag = Schema.Literals([
  "item_removed",
  "quantity_changed",
  "order_cancelled",
  "order_deleted",
  "blocked",
  "item_added",
  "order_fulfilled",
]);
export type RunFlag = typeof RunFlag.Type;

export const RunFlagDetail = Schema.Struct({
  from: Schema.optionalKey(Schema.Number),
  to: Schema.optionalKey(Schema.Number),
  reason: Schema.optionalKey(StepNote),
  by: Schema.optionalKey(MemberId),
  /** The line item title behind an order run's `item_added` / `item_removed`. */
  item: Schema.optionalKey(Schema.String),
});
export type RunFlagDetail = typeof RunFlagDetail.Type;

/**
 * One workflow applied to one line item, or — when `lineItemId` is null — to
 * one whole order (an *order run*, see `WorkflowScope`). Every display field
 * is a snapshot taken at creation — `workflowName`, `orderName`, the line
 * item's title and personalization — so the queue card reads only this row
 * and the run outlives an order delete, a definition rename, or a line item
 * dropped from the order. No foreign keys to `ShopOrder`, `OrderLineItem`, or
 * `Workflow` for that reason. `unique (lineItemId, workflowId)` spans every
 * status, so a cancelled run keeps its key and the only way back is un-cancel;
 * a partial unique index does the same for `(orderId, workflowId)` on order
 * runs.
 *
 * One struct with nullable fields rather than a union: every decoder, action,
 * and card reads the same row, and {@link isOrderRun} is the only branch.
 */
export const WorkflowRun = Schema.Struct({
  id: WorkflowRunId,
  workflowId: WorkflowId,
  workflowName: WorkflowName,
  orderId: Schema.String,
  orderName: Schema.String,
  lineItemId: Schema.NullOr(Schema.String),
  lineItemTitle: Schema.NullOr(Schema.String),
  variantTitle: Schema.NullOr(Schema.String),
  sku: Schema.NullOr(Schema.String),
  quantity: Schema.NullOr(Schema.Number),
  customAttributes: Schema.NullOr(
    Schema.fromJsonString(Schema.Array(OrderAttribute)),
  ),
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

export const isOrderRun = (run: WorkflowRun) => run.lineItemId === null;

/**
 * A step copied from the definition at run creation. `teamName` is snapshotted
 * alongside `teamId` so the queue never joins D1; `completedBy` / `startedBy`
 * are D1 `Member.id`s, cross-store and therefore unreferenced.
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
  teamId: TeamId,
  teamName: TeamName,
  instructions: Schema.NullOr(StepInstructions),
  startedAt: Schema.NullOr(Schema.Number),
  startedBy: Schema.NullOr(MemberId),
  completedAt: Schema.NullOr(Schema.Number),
  completedBy: Schema.NullOr(MemberId),
  note: Schema.NullOr(StepNote),
});
export type WorkflowRunStep = typeof WorkflowRunStep.Type;

export const WorkflowRunDetail = Schema.Struct({
  run: WorkflowRun,
  steps: Schema.Array(WorkflowRunStep),
});
export type WorkflowRunDetail = typeof WorkflowRunDetail.Type;

/**
 * One ready step the member may act on. `siblings` are the other steps of
 * the same stage that are *not* in the item — owned by other teams — so a
 * worker can see who they are working alongside. `startedByEmail` is joined
 * from D1 by the Durable Object, since the run rows hold only member ids.
 */
export const QueueStep = Schema.Struct({
  ...WorkflowRunStep.fields,
  startedByEmail: Schema.NullOr(Email),
  siblings: Schema.Array(Schema.Struct({ name: StepName, teamName: TeamName })),
});
export type QueueStep = typeof QueueStep.Type;

/**
 * One row of a member's queue: a run with every *ready* step — open, and
 * nothing in an earlier stage still open — that belongs to one of the
 * member's teams. `stageCount` is the run's last stage, for "step k of n".
 * `note` is the order's live note, joined at read time rather than
 * snapshotted because a merchant edits it while work is in progress.
 */
/**
 * One line item of the order an *order run* is on, read live at queue time
 * (never snapshotted) so a late item shows on the card as soon as reconcile
 * stores it. `runStatus` is the worst status across that item's runs
 * (`pending` < `active` < `done`), or null when no item workflow touched it.
 */
export const QueueOrderItem = Schema.Struct({
  lineItemId: BoundedId,
  title: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  customAttributes: Schema.Array(OrderAttribute),
  runStatus: Schema.NullOr(RunStatus),
});
export type QueueOrderItem = typeof QueueOrderItem.Type;

export const QueueItem = Schema.Struct({
  run: WorkflowRun,
  steps: Schema.NonEmptyArray(QueueStep),
  stageCount: Schema.Number,
  note: Schema.NullOr(Schema.String),
  /** Populated only for order runs; `[]` for item runs. */
  items: Schema.Array(QueueOrderItem),
});
export type QueueItem = typeof QueueItem.Type;

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
  /** The shop's active order workflow, so the page can say what will start once the items are made. */
  orderWorkflow: Schema.NullOr(Workflow),
});
export type OrderDetailView = typeof OrderDetailView.Type;

/**
 * Member-area inputs. `teamIds` and `memberId` are resolved by `requireMember`
 * in the server fn from the session, never taken from the browser; the Durable
 * Object trusts them because its only caller for these methods is the Worker.
 */
export const ListQueueInput = Schema.Struct({
  teamIds: Schema.Array(BoundedId),
});
export type ListQueueInput = typeof ListQueueInput.Type;

export const CompleteStepInput = Schema.Struct({
  runStepId: BoundedId,
  memberId: BoundedId,
  teamIds: Schema.Array(BoundedId),
});
export type CompleteStepInput = typeof CompleteStepInput.Type;

export const DismissFlagInput = Schema.Struct({
  runId: BoundedId,
  memberId: BoundedId,
  teamIds: Schema.Array(BoundedId),
});
export type DismissFlagInput = typeof DismissFlagInput.Type;

export const StartStepInput = CompleteStepInput;
export type StartStepInput = typeof StartStepInput.Type;

/** `note: null` clears. */
export const SetStepNoteInput = Schema.Struct({
  runStepId: BoundedId,
  memberId: BoundedId,
  teamIds: Schema.Array(BoundedId),
  note: Schema.NullOr(StepNote),
});
export type SetStepNoteInput = typeof SetStepNoteInput.Type;

/** `reason: null` blocks without a reason. */
export const BlockRunInput = Schema.Struct({
  runId: BoundedId,
  memberId: BoundedId,
  teamIds: Schema.Array(BoundedId),
  reason: Schema.NullOr(StepNote),
});
export type BlockRunInput = typeof BlockRunInput.Type;

/** `WorkflowNotRoutable` = archived, zero steps, or a step owned by an inactive team. */
export const AttachResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), run: WorkflowRun }),
  Schema.Struct({ _tag: Schema.Literal("AlreadyExists") }),
  Schema.Struct({ _tag: Schema.Literal("LineItemNotFound") }),
  Schema.Struct({ _tag: Schema.Literal("WorkflowNotRoutable") }),
]);
export type AttachResult = typeof AttachResult.Type;

/**
 * `NotAllowed` = the step's team is not among the caller's; `NotReady` = a
 * step in an earlier stage is still open (or this one is already done);
 * `Terminal` = the run is `done` or `cancelled` (or, for un-cancel, is not
 * cancelled).
 */
export const RunResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NotAllowed") }),
  Schema.Struct({ _tag: Schema.Literal("NotReady") }),
  Schema.Struct({ _tag: Schema.Literal("Terminal") }),
]);
export type RunResult = typeof RunResult.Type;
