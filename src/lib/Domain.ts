/**
 * The domain vocabulary, and the one place a behavioural rule is written
 * down.
 *
 * - A rule is stated once, on the symbol that *is* the concept (a
 *   `Schema.Literals` such as {@link RunStatus}) or the function that
 *   enforces it ({@link reopenBlockedBy}, {@link currentTasks}). A concept with
 *   more than one rule carries a table naming each rule's predicate.
 * - Every other site calls the predicate ({@link runIsOpen},
 *   {@link runIsBlocked}, {@link userIsAdmin}, ...) rather than comparing a
 *   literal. `scripts/rules-lint.ts`, run by `pnpm lint`, refuses an inline
 *   `.status`, `.flag` or admin `.role` comparison anywhere else under `src/`.
 * - A site that follows a different rule from its siblings says so and why,
 *   in its own JSDoc, and links the rule it departs from.
 * - Each rule is pinned by a test whose title is the rule in plain words.
 * - Which tier a site speaks. Identifiers, types, callables, route
 *   parameters (`$runId`), log messages, JSDoc, tests and research speak
 *   the domain tier: "run" is the word there. Route segments, string
 *   literals, JSX text, headings and labels speak the screen tier: the
 *   glossary's screen columns, and `scripts/rules-lint.ts` refuses the
 *   retired words in them. A JSDoc that explains copy quotes the copy.
 *   A JSDoc that names a screen uses the Screens table's spec name.
 *
 * The action tables cover buttons, and a run leaving Mine, Up next,
 * Teammates and Blocked is its status, not a button: a table can say a run
 * offers nothing and a list can still show it, so which rows a list holds is
 * decided by {@link RunStatus} (open runs only) and nothing else, the same
 * rule for every list. A page
 * never decides a gate itself: what an item's card is comes from
 * {@link lineItemState}, and which writes an actor may make comes from
 * {@link runActions} and {@link taskActions}, which the page and `ShopAgent`
 * both read.
 */

/**
 * Glossary. These are the words for code, JSDoc, research and screen; a
 * symbol named here is an export of this file, or a field of one. A row
 * says what a word means, where it lives, and what a screen calls it; the
 * rule stays on the symbol. The screen columns are checked: each cell is
 * the value of the label constant beside the table ({@link TASK_STATE_LABEL},
 * {@link RUN_STATE_LABEL}, {@link WORKFLOW_STATE_LABEL}, {@link VERB_LABEL}),
 * and `pnpm spec check` refuses a cell that differs, so a label
 * change starts here.
 *
 * Nouns. "(none)" means no screen says the word; the cell says what a
 * screen shows instead:
 *
 * | word     | meaning                                                  | symbol                          | screen                                                         |
 * | -------- | -------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
 * | merchant | the shop's owner, acting from the Shopify admin          | `Actor` role `merchant`         | "you" to the merchant, "the merchant" to a member              |
 * | shop     | one Shopify store, the tenant                            | `ShopSession`, `Shop`           | its domain                                                     |
 * | member   | a person at the bench, on one or more teams              | `Actor` role `member`, `Member` | member (merchant screens); "you" or a name (member screens)    |
 * | team     | the group a task is assigned to                          | `Team`                          | team, or its name                                              |
 * | order    | a Shopify order                                          | `ShopOrder`                     | its name (#1001)                                               |
 * | item     | one line item of an order                                | `OrderLineItem`                 | item; never "line item"                                        |
 * | workflow | the definition: steps of tasks                           | `Workflow`, `WorkflowTask`      | workflow, or its name                                          |
 * | step     | a position in a workflow; its tasks are done in parallel | `WorkflowTask`, `RunTask` field | Step k of n                                                    |
 * | run      | one item going through one workflow                      | `Run`                           | the item's workflow, on both sides; never bare, never "run"    |
 * | task     | one unit of work on a run, on one team                   | `RunTask`                       | task, or its name                                              |
 * | block    | a person's hold on a run                                 | `runIsBlocked`                  | Blocked                                                        |
 * | note     | free text on a run                                       | `RunNote`                       | Note                                                           |
 *
 * An item is always shown under its order on the merchant's order page,
 * and beside it in the member's row (`<item> · <workflow> · <order>`), so
 * the order carries the disambiguation and the word stays short. Copy with
 * no order beside it qualifies the word ("items on open orders", "N items
 * in production") rather than saying "items" bare. "run" is an
 * implementation noun a merchant or member would have to learn; the
 * merchant already has the item and its workflow (Change workflow replaces
 * the run without naming it), and the member has the item's workflow and
 * its tasks. `scripts/rules-lint.ts` refuses "run", "line item" and the
 * other retired words in screen strings. The run's screen word is
 * "workflow" with the item beside it ("Brass hinge ×2 · Finishing",
 * "Finishing workflow · #1001"). On the merchant's Workflows pages a bare
 * workflow name is the definition; on the member's Workflows list, which
 * never shows a definition, every row is a run and names its item.
 *
 * Run states:
 *
 * | word    | meaning                                           | stored          | screen                                                  |
 * | ------- | ------------------------------------------------- | --------------- | ------------------------------------------------------- |
 * | open    | work can be recorded                              | `active`        | In progress (merchant: Not started until a task starts) |
 * | blocked | open, and a person holds it                       | `blockedAt` set | Blocked                                                 |
 * | done    | a person marked the last task done                | `done`          | Done                                                    |
 * | closed  | something else ended it; `closedReason` says what | `closed`        | Closed · <reason>                                       |
 *
 * Task states. `current` is the flag: the task's step is the lowest with
 * an open task ({@link currentTasks}), whether or not someone has it. The
 * one derivation is {@link taskStateOf}; it reads `startedAt` before
 * `current`, so a task someone had when its run closed still reads started:
 *
 * | word    | meaning                            | derived from                          | screen  |
 * | ------- | ---------------------------------- | ------------------------------------- | ------- |
 * | waiting | its step is not current            | not current, `startedAt` null         | (none)  |
 * | ready   | its step is current, nobody has it | current, `startedAt` null             | Ready   |
 * | started | a person has it                    | `startedAt` set (current on an open run) | Started |
 * | done    | a person marked it done            | `doneAt` set                          | Done    |
 *
 * "In progress" is the run's screen word and only the run's: a started
 * task reads Started so the merchant never reads one word for two facts
 * on one card. "waiting" is a code word; the orders index's "Waiting on"
 * column means teams holding a current task, a fact about orders, and the
 * two never render together.
 *
 * Workflow states:
 *
 * | word | meaning                             | stored         | screen |
 * | ---- | ----------------------------------- | -------------- | ------ |
 * | on   | new items get runs from it          | `active` true  | On     |
 * | off  | it starts nothing; open runs carry on | `active` false | Off    |
 *
 * Verbs. Who may do each, and in which state, is the matrix on
 * {@link taskActions} or {@link runActions}, not here. The two screen
 * columns are the member's and the merchant's label; "(none)" means that
 * screen never offers the verb. Undo and Reopen are two words for one
 * verb on purpose: the member takes back their own Done, the merchant
 * reopens someone's record.
 *
 * | word            | on a | effect                              | member      | merchant        |
 * | --------------- | ---- | ----------------------------------- | ----------- | --------------- |
 * | start           | task | ready → started                     | Start       | (none)          |
 * | done            | task | ready or started → done             | Done        | Done            |
 * | put back        | task | started → ready                     | Put back    | Put back        |
 * | reopen          | task | done → ready                        | Undo        | Reopen          |
 * | assign          | task | moves it to a team                  | (none)      | Assign team     |
 * | note            | run  | writes the note                     | Edit note   | Edit note       |
 * | block           | run  | open → blocked                      | Block       | Block           |
 * | edit reason     | run  | changes the block's reason          | Edit reason | Edit reason     |
 * | unblock         | run  | blocked → open                      | Unblock     | Unblock         |
 * | cancel          | run  | open → closed, `merchant_cancelled` | (none)      | Cancel workflow |
 * | attach workflow | item | creates the run                     | (none)      | Attach          |
 * | change workflow | item | replaces the run                    | (none)      | Change workflow |
 *
 * Screens. A JSDoc, a test or a research doc names a screen by its spec
 * name, never by its route segment and never with "run". The heading is
 * what the person sees on the page. Two screens share the spec name
 * "workflow page", one per side; a JSDoc that mentions both sides
 * qualifies with "the merchant's" or "the member's".
 *
 * | side     | route file                        | heading                      | spec name                   |
 * | -------- | --------------------------------- | ---------------------------- | --------------------------- |
 * | merchant | `app.index`                       | Baton                        | the home page               |
 * | merchant | `app.orders.index`                | Orders                       | the orders index            |
 * | merchant | `app.orders.$orderId`             | the order's name             | the order page              |
 * | merchant | `app.workflows.index`             | Workflows                    | the workflows index         |
 * | merchant | `app.workflows.$workflowId`       | the workflow's name          | the workflow page           |
 * | merchant | `app.workflows.$workflowId_.edit` | the workflow's name          | the workflow editor         |
 * | merchant | `app.teams.index`                 | Teams                        | the teams index             |
 * | merchant | `app.teams.$teamId`               | the team's name              | the team page               |
 * | merchant | `app.members`                     | Members                      | the members page            |
 * | member   | `shop.index`                      | Your shops                   | the shop picker             |
 * | member   | `shop.$shop.workflows.index`      | Workflows                    | the workflows list          |
 * | member   | `shop.$shop.workflows.$runId`     | the item's title             | the workflow page           |
 * | member   | `shop.$shop_.lapsed`              | the shop's domain            | the lapsed page             |
 */
import { Match, Option, Schema, SchemaGetter, Struct } from "effect";

/**
 * The glossary's task-state words. Derived, never stored: {@link taskStateOf}
 * reads them off a task's row and its `current` flag.
 */
export const TaskState = Schema.Literals([
  "waiting",
  "ready",
  "started",
  "done",
]);
export type TaskState = typeof TaskState.Type;

/**
 * One task's state ({@link TaskState}) from its row and the `current` flag
 * ({@link RunTaskView}). The one derivation: a page that draws a task's
 * badge reads this rather than testing the columns itself.
 *
 * `startedAt` is read before `current`. On an open run the order does not
 * matter, because a started task is always current: nothing behind it can
 * reopen while it is started ({@link reopenBlockedBy}). On a closed run no
 * task is current ({@link currentTasks}), and a task someone had when the run
 * closed still reads started, because the closed card is the record of who
 * had what.
 */
export const taskStateOf = (
  task: Pick<RunTaskView, "current" | "startedAt" | "doneAt">,
): TaskState => {
  if (task.doneAt !== null) return "done";
  if (task.startedAt !== null) return "started";
  return task.current ? "ready" : "waiting";
};

/** The glossary's task-states screen column. `null` is "(none)". */
export const TASK_STATE_LABEL = {
  waiting: null,
  ready: "Ready",
  started: "Started",
  done: "Done",
} as const satisfies Record<TaskState, string | null>;

/**
 * The glossary's run-states screen column. `open` is the member's word for
 * an open run and the merchant's once a task has started; the merchant's
 * word before that is {@link RUN_UNSTARTED_LABEL} ({@link runIsUnstarted}).
 * `closed` is the prefix of `Closed · <reason>` ({@link ClosedReason}).
 */
export const RUN_STATE_LABEL = {
  open: "In progress",
  blocked: "Blocked",
  done: "Done",
  closed: "Closed",
} as const;

/** The merchant's word for an open run nobody has touched ({@link runIsUnstarted}); the glossary's run-states `open` row names it. */
export const RUN_UNSTARTED_LABEL = "Not started";

/** The glossary's workflow-states screen column, for `Workflow.active`. */
export const WORKFLOW_STATE_LABEL = { on: "On", off: "Off" } as const;

/**
 * The glossary's verbs, as the action structs name them ({@link RunActions},
 * {@link TaskActions}), plus the two item verbs.
 */
export const Verb = Schema.Literals([
  "start",
  "done",
  "putBack",
  "reopen",
  "assign",
  "note",
  "block",
  "editReason",
  "unblock",
  "cancel",
  "attachWorkflow",
  "changeWorkflow",
]);
export type Verb = typeof Verb.Type;

/** The glossary's two screen columns for verbs. `null` is "(none)": that screen never offers the verb. */
export const VERB_LABEL = {
  start: { member: "Start", merchant: null },
  done: { member: "Done", merchant: "Done" },
  putBack: { member: "Put back", merchant: "Put back" },
  reopen: { member: "Undo", merchant: "Reopen" },
  assign: { member: null, merchant: "Assign team" },
  note: { member: "Edit note", merchant: "Edit note" },
  block: { member: "Block", merchant: "Block" },
  editReason: { member: "Edit reason", merchant: "Edit reason" },
  unblock: { member: "Unblock", merchant: "Unblock" },
  cancel: { member: null, merchant: "Cancel workflow" },
  attachWorkflow: { member: null, merchant: "Attach" },
  changeWorkflow: { member: null, merchant: "Change workflow" },
} as const satisfies Record<
  Verb,
  { readonly member: string | null; readonly merchant: string | null }
>;

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
   * The contract's boundary, cached beside the handle and written only by
   * `Repository.updateShopSessionPlan`, so a cache hit answers "when does
   * this expire" without a second Partner call. Null means none or unknown,
   * and it is only meaningful while `planHandleExpiresAt` is in the future —
   * a stale row's date is as untrustworthy as its handle. The cycle start is
   * not cached: nothing reads it off the row.
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
 * Structure on {@link D1_TABLES}; how run history survives the delete is a
 * row on {@link initializeSchema}.
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
 * `Team.name` check constraint rejects untrimmed text, and uniqueness
 * compares exactly, so a leading space would otherwise be the difference
 * between a duplicate the database refuses and one it silently accepts.
 * Case is *not* folded: a name is a label compared as typed, so "Sewing" and
 * "sewing" are two teams, and merchants write "Cut & Sew", not "cut & sew".
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
 * The order of the delete is the team-delete row on {@link D1_TABLES};
 * which task pointers it nulls and why history never needs the row are the
 * cross-store rows on {@link initializeSchema}.
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
 * The team plus every member of its shop, each marked with whether they are on
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
  /** `Run` rows that are {@link runIsOpen} per shop; a safety valve, not a product limit. A `done` run still holds its item but frees this slot. */
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
 * Same shape and reasoning as {@link TeamName}: trimmed, case preserved,
 * and unique in its shop, compared exactly. See {@link Workflow} for why the
 * name is unique as well as the tag.
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

/** Why a run is blocked, in `Run.blockReason`. Same trimming; `null` blocks without one. */
export const BlockReason = trimmedText("BlockReason", BLOCK_REASON_MAX_LENGTH);
export type BlockReason = typeof BlockReason.Type;

/**
 * The workflow's one tag: its identity in a form a product can carry. Every
 * workflow has exactly one, from birth, and no two workflows share one. Baton
 * mints it (the create dialog prefills it from the workflow name) and the
 * merchant puts it on products in Shopify; an item whose product carries
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
 *   starts runs. Runs copy it wholesale and never look back at it (the
 *   data model on `initializeSchema`, `ShopAgentSchema.ts`).
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
 * - an order or item that no workflow's tag **matches** shows
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
 * workflow and its runs stay on their orders**, open ones carry on; **turn
 * off** stops new runs and open ones carry on; **a workflow needs at least one task before it
 * can be applied or turned on**, so zero tasks is the state before the first
 * Apply and only that; **any open task on a run can be assigned to another
 * team**, a done task is history; **deleting configuration never deletes
 * work**. Delete removes the definition, its tasks, and its draft, nothing
 * else (the data model on `initializeSchema`, `ShopAgentSchema.ts`) — a run
 * is self-sufficient, so it needs no confirm counts and the dialog says only
 * what survives. The id is identity, the tag is the key a product carries,
 * and the name is the label people pick a workflow by. Both are unique:
 * members never see the tag, and pickers such as the order page's attach
 * list show only the name, so the name alone has to tell two workflows
 * apart. A rename is immediate and cosmetic because runs snapshot
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
  updatedAt: Schema.Number,
};

/** On: `activatedAt` is set. The one read of the switch, so no caller compares the column to null on its own. */
export const isActive = (workflow: { readonly activatedAt: number | null }) =>
  workflow.activatedAt !== null;

/** A workflow: chosen by its tag, running once per matching item. */
export const Workflow = Schema.Struct({
  ...WorkflowFields,
  tag: WorkflowTag,
});
export type Workflow = typeof Workflow.Type;

/**
 * The draft side of {@link Workflow}, holding the tasks being edited as
 * `WorkflowDraftTask` rows. One per workflow at most; the data model on
 * `initializeSchema` (`ShopAgentSchema.ts`) says so and the draft holds
 * tasks only. Nothing that starts runs ever reads the draft.
 */
export const WorkflowDraft = Schema.Struct({
  workflowId: WorkflowId,
  updatedAt: Schema.Number,
});
export type WorkflowDraft = typeof WorkflowDraft.Type;

/**
 * `teamId` is a live pointer to a D1 `Team`, not a snapshot: renaming a team
 * renames every task it owns, and a task can only be *applied* against a
 * team that exists. `null` is **unassigned** — what a team delete leaves
 * behind — and an id no D1 row carries reads the same way. It carries no
 * `teamName`: the name is joined at read time, and only the eventual
 * instance rows snapshot it. The pointer's rule is the data model on
 * `initializeSchema` (`ShopAgentSchema.ts`).
 *
 * Workflow tasks and draft tasks have the same shape but live in two tables
 * (`WorkflowTask`, `WorkflowDraftTask`; why, on the DDL). Only `applyDraft` writes `WorkflowTask`;
 * every editor write targets the draft. Apply carries draft task ids over to
 * the workflow; Edit copies workflow tasks into the draft under new ids.
 *
 * A workflow is a sequence of numbered steps. Each step holds one or more
 * tasks, and a task is the unit a team starts and marks done: it has a name, a
 * team, and instructions. Along `position` the `step` values are dense `1..m`
 * and non-decreasing (`1 1 2 3 3`), so every task belongs to exactly one step,
 * and a step of one task is the plain linear case. Step k is current when every
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
 * (`teamId` null, or an id no team carries) — a warning, not a block in the
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

/** Same as {@link AddStepInput} but into an existing step: the new task lands after that step's last task and is current together with it. */
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
 * fine for faults but loses the tag the page needs to put "name taken" on the
 * name field and "tag taken" on the tag field rather than in a banner.
 *
 * `TagTaken` names the holder so the merchant can decide whether to change
 * this tag or retag the other workflow; the name is enough, since no two
 * workflows share one.
 */
export const WorkflowResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok"), workflow: Workflow }),
  Schema.Struct({ _tag: Schema.Literal("NameTaken"), name: WorkflowName }),
  Schema.Struct({
    _tag: Schema.Literal("TagTaken"),
    tag: WorkflowTag,
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
 * Any open task can be assigned, started or not: only `teamId` / `teamName`
 * move, so `startedByRole` / `startedByEmail` stay and history keeps whoever
 * began it. `TaskDone` refuses a done task because the write would
 * overwrite `teamName`, the record of which team did it.
 */
export const AssignRunTaskTeamResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Assigned") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("TeamNotFound") }),
  Schema.Struct({ _tag: Schema.Literal("TaskDone") }),
  /** The task's run is not {@link runIsOpen}; see the {@link RunStatus} table. */
  Schema.Struct({ _tag: Schema.Literal("RunNotOpen") }),
  /** {@link taskActions}' `assign` is false: the task is done, its run is done, or the order is closed. */
  Schema.Struct({ _tag: Schema.Literal("NotAllowed") }),
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
 * Which ingestion path is writing an order, for the sync logs. Diagnostic,
 * not control flow: every path runs the same `updatedAt`-guarded upsert. Not
 * stored on the row; a log line answers "how did this get here" as well.
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

/**
 * One line item property: Shopify's `Attribute` as it appears in
 * `LineItem.customAttributes`. The Help Center calls these line item
 * properties, REST and Liquid call them `properties`, and the merchant's line
 * item card is headed Properties. Order-level attributes are not stored (see
 * {@link ShopOrder}).
 */
export const LineItemProperty = Schema.Struct({
  key: Schema.String,
  value: Schema.NullOr(Schema.String),
});
export type LineItemProperty = typeof LineItemProperty.Type;

/**
 * One order in the shop's Durable Object SQLite. Encoded side is the row
 * (epoch-ms integers, `0`/`1` booleans, JSON text); decoded side is what the
 * page renders.
 *
 * Deliberately carries no customer identity: no `customer`, `shippingAddress`,
 * email, or phone. Baton is a production-floor view, so the buyer never needs
 * naming, and staying off those fields keeps the app clear of Level 2 protected
 * customer data. `note` stays because it can carry instructions a maker
 * works from. Order-level `customAttributes` (the cart attributes the admin
 * shows under Additional details) are not stored: no run or screen reads an
 * order-level field, and the merchant reads them in the admin one click away.
 *
 * Payment is stored as `fullyPaid` only, the one fact a rule reads
 * ({@link canStartRuns}). Shopify's display financial status and the order's
 * archive time (`closedAt`) are not mirrored: no rule and no maker reads them,
 * and the admin is one click away.
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
  fulfillmentStatus: Schema.String,
  fullyPaid: SqliteBoolean,
  note: Schema.NullOr(Schema.String),
  /**
   * Whether line items were **dropped** on the way in, past
   * {@link ShopLimits.maxLineItemsPerOrder}. Both paths ask Shopify for that
   * many and neither pages, so this is the whole of "the stored set is short
   * of the order" — see {@link OrderRepository.upsertOrder}, which states the
   * rule. The order page warns on it; nothing else reads it.
   */
  lineItemsTruncated: SqliteBoolean,
  syncedAt: Schema.Number,
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
 * fulfilled early still reads as work until the whole order is `FULFILLED`
 * ({@link isFulfilled}). `quantity` stays as "ordered" for display.
 *
 * `matchedWorkflowIds` is the active, startable workflows whose tag matched
 * this item at the last reconcile, whether or not a run was started. Two or
 * more with no run is an **ambiguity** the merchant resolves from the
 * order page; the picker there offers these first, then every other active
 * workflow. Written by reconcile
 * only — the order sync writes `[]`, because matching happens after the write,
 * inside `afterWrite`.
 *
 * `properties` is the item's own list, every key stored and shown as
 * Shopify sends it, underscore-prefixed app keys included; Baton is a
 * back-office view and hides nothing the merchant can already see in the
 * admin.
 *
 * The product and variant ids are not stored because nothing links to the
 * product; `requiresShipping` is not stored because no rule distinguishes a
 * digital item.
 */
export const OrderLineItem = Schema.Struct({
  id: Schema.String,
  orderId: Schema.String,
  title: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  sku: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  currentQuantity: Schema.Number,
  productTags: Schema.fromJsonString(Schema.Array(Schema.String)),
  matchedWorkflowIds: Schema.fromJsonString(Schema.Array(WorkflowId)),
  properties: Schema.fromJsonString(Schema.Array(LineItemProperty)),
});
export type OrderLineItem = typeof OrderLineItem.Type;

/**
 * The creation gate, and only that: whether reconcile may *start* new runs on
 * the order. Deliberately not the stop gate — an edit that pushes a paid order
 * back to `fullyPaid = false` must leave work in progress alone, so only
 * {@link isCancelled} and {@link isFulfilled} close existing runs. `AUTHORIZED` is not
 * treated as paid; manual-capture shops would need a clause here.
 */
export const canStartRuns = (order: ShopOrder) =>
  order.fullyPaid && order.cancelledAt === null;

/** A stop gate, with {@link isFulfilled}: reconcile closes every open run on the order, reason `order_cancelled` ({@link ClosedReason}). */
export const isCancelled = (order: Pick<ShopOrder, "cancelledAt">) =>
  order.cancelledAt !== null;

/**
 * Shopify reports the order `FULFILLED`: nothing is left to make or pack.
 * The other stop gate: reconcile closes every open run, reason `fulfilled`
 * ({@link ClosedReason}). The only fulfillment value Baton acts on; every
 * other `displayFulfillmentStatus` (partially fulfilled, on hold, in
 * progress, scheduled, ...) is displayed as Shopify sends it and read as open.
 */
export const isFulfilled = (order: Pick<ShopOrder, "fulfillmentStatus">) =>
  order.fulfillmentStatus === "FULFILLED";

/**
 * The two order fields {@link orderIsOpen} reads, and so every action set
 * ({@link runActions}, {@link taskActions}). Carried on the member's run
 * views ({@link RunView}, {@link RunListItem}, {@link RecentItem}) because a
 * member page never holds the order itself, and without them it would offer
 * work on an order Shopify has closed.
 */
export const OrderState = Schema.Struct({
  cancelledAt: Schema.NullOr(Schema.Number),
  fulfillmentStatus: Schema.String,
});
export type OrderState = typeof OrderState.Type;

/**
 * Whether the order is **open**: not cancelled and not fully fulfilled in
 * Shopify. **Closed** means Shopify has finished with the order; it has
 * nothing to do with whether a workflow is attached. Every other order is
 * open, whatever its runs say.
 *
 * **A closed order is read only.** Every write that does work on its runs is
 * refused ({@link runActions}, {@link taskActions}); only the note stays,
 * because a note is a record, not work. There is nothing to cancel either:
 * reconcile has already closed every open run on it ({@link RunStatus}).
 *
 * Manual attach (`ShopAgent.merchantAttachWorkflow`) is the merchant
 * overriding the tag, activation-date and payment gates on purpose; it is not
 * an override of the order being over. A closed order has no work left, so
 * attach is refused, and reconcile would only close the run on its next
 * pass. Unpaid is deliberately allowed: the merchant may start work on a
 * deposit, which is the same judgement {@link canStartRuns} withholds from
 * *automatic* starts. Attaching is starting work, so it bills the order like
 * any first run (`OrderRepository.countOrder`) — the one way an order Shopify
 * has not been paid for is metered, and the merchant chose it.
 */
export const orderIsOpen = (order: OrderState) =>
  !isCancelled(order) && !isFulfilled(order);

/**
 * Units a maker should see and a run should snapshot. `currentQuantity`, not
 * `quantity`: an edit or a refund lowers it, and neither leaves work a maker
 * should still do. Fulfillment is deliberately not in it — Shopify leaves
 * `currentQuantity` alone when a unit is fulfilled, so a line fulfilled ahead of the
 * rest of the order stays open work until the order reaches `FULFILLED`, which
 * is the one fulfillment state Baton acts on ({@link isFulfilled}). Partial
 * fulfillment is deliberately ignored: a line fulfilled ahead of the order
 * stays work until the order is `FULFILLED`.
 */
export const unitsToMake = (lineItem: Pick<OrderLineItem, "currentQuantity">) =>
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
 * Progress for one seeded run: `done` marks every task done; `advance`
 * marks that many rounds of current tasks done; `started` then Starts what is
 * ready; `blocked` blocks the run.
 */
const SeedProgressFields = {
  done: Schema.optionalKey(Schema.Boolean),
  /**
   * Rounds of progress before the run is left alone: each round marks done
   * every task that was *current* when the round began, and what that makes
   * current waits for the next. `advance: 1` on a three-step item is "step 1
   * done, step 2 up next". `done` is the limit of this.
   */
  advance: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  /** After `advance`, Start what is ready so the workflows list shows "Started · <seed member>" on a teammate's list. */
  started: Schema.optionalKey(Schema.Boolean),
  /**
   * Record the `done` / `advance` / `blocked` progress as the **merchant**
   * rather than the seed member, for a fixture of a merchant intervention
   * ("Done by Merchant", "Blocked by Merchant"). `started` stays the
   * member's whatever this says: there is no merchant Start — the merchant
   * records work, they do not claim it.
   */
  byMerchant: Schema.optionalKey(Schema.Boolean),
  /** After `advance`, block the run with this reason, the state a worker's Block leaves. */
  blocked: Schema.optionalKey(BlockReason),
  /** Last, Cancel workflow as the merchant: the run closes, reason `merchant_cancelled` ({@link ClosedReason}). */
  cancelled: Schema.optionalKey(Schema.Boolean),
} as const;

/**
 * `done` and `advance` are exclusive rather than merely undocumented
 * together: the seed runs `done` first, which leaves nothing current, so
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
 * on {@link SeedOrdersInput} for why it is a phase of its own. `cancelled`
 * and `fulfillmentStatus: "FULFILLED"` close the order's open runs
 * (`order_cancelled`, `fulfilled`); a line's `currentQuantity` at zero closes
 * its run as `item_removed`, and any other change resizes it
 * ({@link Run} `quantityChangedFrom`).
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
          properties: Schema.optionalKey(Schema.Array(LineItemProperty)),
          /** This item's run alone; the order's own progress keys are ignored for it. */
          progress: Schema.optionalKey(SeedProgress),
          /**
           * A workflow to set on this item after reconcile, exactly as the
           * merchant's Choose / Change does (`setRun`):
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
       * `upsertOrder` with `afterWrite: reconcile`, so its runs end up as a
       * webhook would leave them: closed (`order_cancelled`, `fulfilled`,
       * `item_removed`) or resized. Second on purpose — reconcile on an
       * already-cancelled or already-fulfilled order returns before creating
       * anything, so the first write has to be the order as it stood when
       * the work started.
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
 * An order's lifecycle position, the production ladder: **To make ·
 * Making · Made · Fulfilled**, and **Cancelled** beside it. One per order,
 * derived from the order row and its run counts on every read and never
 * stored. Problems are not positions: an order being made can also be
 * blocked or waiting on a workflow choice, so those live on {@link OrderNeed}
 * and an order carries any number of them beside its one position.
 *
 * The first three rungs are Baton's: nothing is being made yet, the bench has
 * it, every run is done and the order waits for the merchant to fulfil it.
 * The last two are Shopify's and use Shopify's own words, because they are
 * facts Shopify records (`FULFILLED`, `cancelledAt`) and the merchant reads
 * the same words in the admin. No "shipped": the admin never says it, and it
 * is wrong for pickup and digital orders.
 *
 * Never stored is what makes the packer's round trip automatic — fulfil in
 * Shopify, `orders/fulfilled` stores `FULFILLED`, the next read says
 * `fulfilled`, and the order leaves the Made list without anyone touching
 * Baton.
 *
 * The rule is a function, not a table: {@link productionState} is the one
 * definition, and the SQL filters in `OrderRepository.listOrders` restate its
 * branches and must move with it. Readers (`app.orders.index.tsx`) switch on
 * the value for labels and filters only; no site decides anything by
 * comparing it inline.
 */
export const ProductionState = Schema.Literals([
  "to_make",
  "making",
  "made",
  "fulfilled",
  "cancelled",
]);
export type ProductionState = typeof ProductionState.Type;

/**
 * The orders index's Status row, which is {@link ProductionState} plus one
 * value that is not a position.
 *
 * `null` is **open work**: to make, making and made, the three rungs Baton
 * owns. It is the default because retention keeps a year of orders
 * ({@link ShopLimits.orderRetentionDays}) and a merchant opening Orders is
 * looking at the bench, not at the year. `"all"` is the escape hatch that
 * shows the closed ones too, and is the only value here that crosses the
 * open and closed sets — which is why it is not a `ProductionState`: nothing
 * derives it from an order, and `productionState` must never return it.
 * `"cancelled"` is a legal value with no button.
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
 * | Need              | Rule                                                                                  | Remedy                                             |
 * | ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
 * | `no_workflow`     | paid, uncancelled, unfulfilled, no run of any status on any item, no ambiguous item   | attach a workflow on the order page                |
 * | `choose_workflow` | `ambiguousItems > 0` and the order can start runs ({@link canStartRuns})               | choose a workflow on the order page                |
 * | `team`            | {@link OrderRow} `attention`                                                           | assign a team on the order page, or staff the team |
 * | `blocked`         | `runs.blocked > 0`                                                                     | the order page                                     |
 *
 * An unpaid order with an ambiguous item is not choosing: reconcile would not
 * start a run on it whichever workflow was chosen, so there is no decision
 * waiting yet.
 *
 * A need is only ever on an open order ({@link orderIsOpen}): a closed order
 * has no work left. Needs are independent of each other and of the
 * {@link ProductionState}: one order can carry several, and an order being
 * made can be waiting on a choice for another item at the same time. No
 * Shopify change is a need: a Shopify event closes or resizes a run and
 * waits on nobody ({@link RunStatus}).
 */
export const OrderNeed = Schema.Literals([
  "no_workflow",
  "choose_workflow",
  "team",
  "blocked",
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
   * ({@link OrderRow} `waitingOn`, open orders only) — the workflows list's own
   * predicate for which tasks are current, not "owns a task somewhere in the run". The looser reading pulls in orders the team
   * done days ago and orders it will not touch for two more steps, so
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
 * `Run` rows in the same read. Counts every run on the order.
 * `open` counts {@link runIsOpen} runs, `done` the done ones.
 * `closed` counts {@link runIsClosed} runs: an item whose run was closed is
 * decided, so an order whose only runs were closed is not "No workflow"
 * ({@link orderNeeds}), though it reads as to make ({@link productionState}).
 */
export const RunCounts = Schema.Struct({
  open: Schema.Number,
  done: Schema.Number,
  /** Open runs a worker or the merchant blocked ({@link runIsBlocked}). */
  blocked: Schema.Number,
  closed: Schema.Number,
});
export type RunCounts = typeof RunCounts.Type;

/**
 * One index row. `itemUnits` is the sum of `currentQuantity`, not the number
 * of item rows: a cancelled or edited-down order keeps its items and
 * drops their current quantity to zero, and the admin shows those as
 * "0 items". Items themselves are not carried; the detail page reads them.
 */
export const OrderRow = Schema.Struct({
  order: ShopOrder,
  itemUnits: Schema.Number,
  runs: RunCounts,
  /**
   * **Needs a team**, derived at read time against the live D1 roster and
   * never stored: an open run has an open task that is unassigned (`teamId`
   * null or no longer in the roster) or a current task on a team with no
   * members. The order page's "Assign team" picker and the members screen
   * are the remedies; either clears this with no further write.
   *
   * It is the `team` element of {@link orderNeeds}, and the row badge reads
   * "Needs a team".
   */
  attention: Schema.Boolean,
  /**
   * Teams with a current task on an open run of this order, distinct, as ids:
   * "who is holding it", answered at the altitude the list grows with — a
   * shop has a handful of teams, while its runs are a cross product of line
   * items and matching workflows.
   *
   * **Only an open order waits on a team**: a fulfilled or cancelled
   * order's list is empty by the status rule, because reconcile closed every
   * open run on it and only open runs have current tasks ({@link currentTasks}).
   * This is the same line {@link OrderNeed} draws: needs are open-only too.
   *
   * Unassigned current tasks contribute nothing, and neither does a team that
   * has left the roster: both are `attention`, and rendering one fault in two
   * cells makes it look like two alarms. A blocked run contributes nothing
   * either: its team cannot move it, and `RunCounts.blocked` is its alarm. A
   * team still on the roster but with
   * no members does contribute: it is `attention` too, but the badge names
   * the team the merchant has to staff. So an order in production with an
   * empty list is exactly an order whose every current task is unassigned or
   * on a deleted team, which is when the critical badge is showing.
   *
   * Ids, not names: the Durable Object has no team names. The route resolves
   * them through `OrdersView.teams`, the roster the page was read against.
   */
  waitingOn: Schema.Array(TeamId),
  /**
   * How many of the order's items are **ambiguous**: two or more
   * `matchedWorkflowIds`, units still to make, and no run of any status.
   * Derived per read like {@link RunCounts}, never stored, so a Change
   * workflow that leaves an item with two matches and nothing on it reads as
   * ambiguous again without another reconcile. See {@link ambiguousItems} for the shared definition.
   */
  ambiguousItems: Schema.Number,
});
export type OrderRow = typeof OrderRow.Type;

/**
 * The {@link ProductionState} of an order, one for every order.
 *
 * Cancelled wins over everything because Shopify's cancel is final;
 * `fulfilled` is checked next, before the run counts, so an order fulfilled
 * with no runs at all — every historical order the window sync pulls in —
 * reads as fulfilled (and one fulfilled with runs open cannot exist past the
 * next reconcile, which closes them). The open positions then follow the run
 * counts alone: no open and no done run is `to_make`, any open run is
 * `making`, only done runs is `made`. An order whose runs are all closed
 * reads `to_make`, which is right: nothing is being made, and the items may
 * take a new workflow from the picker. Whether `to_make` is a problem is
 * {@link orderNeeds}' question (`no_workflow`), not this one's. The SQL forms
 * in `OrderRepository.listOrders` restate these branches and must move with
 * them.
 *
 * Takes the two fields it reads rather than a whole `OrderRow`, so the order
 * page — which rebuilds the aggregate from its own runs — does not have
 * to invent a value for every row field the index adds later.
 */
export const productionState = ({
  order,
  runs,
}: Pick<OrderRow, "order" | "runs">): ProductionState =>
  Match.value({
    cancelled: isCancelled(order),
    fulfilled: isFulfilled(order),
    none: runs.open === 0 && runs.done === 0,
    open: runs.open > 0,
  }).pipe(
    Match.withReturnType<ProductionState>(),
    Match.when({ cancelled: true }, () => "cancelled"),
    Match.when({ fulfilled: true }, () => "fulfilled"),
    Match.when({ none: true }, () => "to_make"),
    Match.when({ open: true }, () => "making"),
    Match.orElse(() => "made"),
  );

/**
 * The {@link OrderNeed}s of one order, in `OrderNeed` order; `[]` for a
 * closed order ({@link orderIsOpen}). The row badges render this result and
 * the Needs filter restates each element in SQL.
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
  if (!orderIsOpen(order)) return [];
  const need: Record<OrderNeed, boolean> = {
    no_workflow:
      canStartRuns(order) &&
      runs.open === 0 &&
      runs.done === 0 &&
      runs.closed === 0 &&
      ambiguousItems === 0,
    choose_workflow: canStartRuns(order) && ambiguousItems > 0,
    team: attention,
    blocked: runs.blocked > 0,
  };
  return OrderNeed.literals.filter((literal) => need[literal]);
};

/**
 * The index's per-order ambiguity count, recomputed from a detail page's line
 * items and runs so both pages share one definition — the SQL in
 * `OrderRepository.listOrders` restates it and must move with it.
 *
 * Any run counts, `done` and `closed` included: a `done` run means the item
 * was routed and done, and a closed run still holds the item's slot
 * ({@link RunStatus}).
 */
export const ambiguousItems = (
  lineItems: readonly OrderLineItem[],
  runs: readonly Run[],
): number =>
  lineItems.filter(
    (lineItem) =>
      lineItem.matchedWorkflowIds.length >= 2 &&
      unitsToMake(lineItem) > 0 &&
      !runs.some((run) => run.lineItemId === lineItem.id),
  ).length;

/** The index's per-order aggregate, recomputed from a detail page's runs so both pages share one definition. */
export const runCounts = (runs: readonly Run[]): RunCounts =>
  runs.reduce<RunCounts>(
    (counts, run) => ({
      open: counts.open + (runIsOpen(run) ? 1 : 0),
      done: counts.done + (runIsDone(run) ? 1 : 0),
      blocked: counts.blocked + (runIsOpen(run) && runIsBlocked(run) ? 1 : 0),
      closed: counts.closed + (runIsClosed(run) ? 1 : 0),
    }),
    { open: 0, done: 0, blocked: 0, closed: 0 },
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
 * open order, not one per order ever stored. So `fulfilled` and `all` carry
 * no status count — on a shop with years of history that would be a
 * full-table read on every refresh of a subscribed page — and under status
 * `fulfilled` (or `cancelled`) the need counts are all zero and the route
 * hides the row, while the status counts still read as the open positions
 * they would show.
 *
 * Refreshes are bounded by the subscribed page's invalidation throttle,
 * `INVALIDATION_THROTTLE_MS` in `useSubscribedQuery` (2 s), not by anything
 * here.
 */
export const OrderCounts = Schema.Struct({
  to_make: Schema.Number,
  making: Schema.Number,
  made: Schema.Number,
  no_workflow: Schema.Number,
  choose_workflow: Schema.Number,
  team: Schema.Number,
  blocked: Schema.Number,
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
 * `/shop/$shop/workflows` (`shop.$shop.workflows.index`): the member's
 * workflows list, which is the member area's landing page (`/shop/$shop`
 * redirects to it). `view` is the read of `query` — the tab from the URL, every
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
 * The live caller of a run or task action: the identity the gates check
 * ({@link runActions}, {@link taskActions}). The merchant has no member id
 * and no email — they act through the embedded admin, where identity is the
 * Shopify session, not a `Member` row. What a row keeps of the caller is the
 * narrower {@link ActorDisplay}, never this.
 */
export const Actor = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("member"),
    memberId: MemberId,
    email: Email,
    /**
     * The member's teams. Present when the actor is gating
     * ({@link runActions}, {@link taskActions}), absent otherwise. A stored
     * actor is an {@link ActorDisplay} and carries neither `memberId` nor
     * `teamIds`.
     */
    teamIds: Schema.optionalKey(Schema.Array(TeamId)),
  }),
  Schema.Struct({ role: Schema.Literal("merchant") }),
]);
export type Actor = typeof Actor.Type;

export type MemberActor = Extract<Actor, { readonly role: "member" }>;

/**
 * The part of an {@link Actor} a row stores and a page displays: the role,
 * and a member's email. Separate from `Actor`, which is the live caller the
 * gates check. No stored actor keeps a member id: history is displayed and
 * matched by email ({@link actorIsMember}), never joined to `Member`, so an
 * id would only go stale when the member is removed.
 *
 * Stored as a closed union rather than a set of nullable columns read
 * together: inferring "merchant" from a null email would make every reader
 * re-derive the same rule and would collide with a task row whose email
 * columns are legitimately null (a task nobody has touched). So the role
 * discriminator is stored beside the email — a `*ByRole` column on
 * {@link RunTask}, the `role` key of `Run.blockedBy` — and the accessors
 * ({@link taskStartedBy} and friends) are the only place the two columns are
 * reassembled.
 */
export const ActorDisplay = Schema.Union([
  Schema.Struct({ role: Schema.Literal("member"), email: Email }),
  Schema.Struct({ role: Schema.Literal("merchant") }),
]);
export type ActorDisplay = typeof ActorDisplay.Type;

/** How every page spells an actor: the merchant is `Merchant`, a member is their email. */
export const actorLabel = (actor: ActorDisplay) =>
  actor.role === "merchant" ? "Merchant" : actor.email;

/**
 * Whether an actor slot is this member, by email: the durable identity, since
 * a removed and re-added member mints a new id but keeps the address (the
 * member row on {@link D1_TABLES}; the same reason {@link tierOf} matches
 * Mine by email). The merchant has no email and is never "you" on a member
 * page.
 */
export const actorIsMember = (actor: ActorDisplay, email: Email) =>
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

export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"));
export type RunId = typeof RunId.Type;

export const RunTaskId = Schema.NonEmptyString.pipe(Schema.brand("RunTaskId"));
export type RunTaskId = typeof RunTaskId.Type;

/**
 * The run lifecycle, stated once. What a merchant reads:
 *
 * > An item goes through its workflow. It is **in progress** while
 * > your team works on it, **done** when the last step is done, and
 * > **closed** if Shopify ends it first (the order was fulfilled or
 * > cancelled, or the item was removed). A member can **block** a run that
 * > needs attention; unblock it to continue. Nothing else needs your action.
 *
 * The merchant's own Cancel workflow closes a run too, with its own reason
 * ({@link ClosedReason}). So a run ends one of two ways: `done`, a person
 * did the last task, or `closed`, something else ended it and
 * `closedReason` says what.
 *
 * `active` and `done` are derived from the run's tasks and stored for
 * querying; every task write on an open run recomputes them in the same
 * transaction. `closed` is written, never derived: reconcile or Cancel workflow
 * sets it with `closedAt` and `closedReason`, and nothing moves a run out of
 * it. There is no reopen: Shopify's own model is that a cancel or a
 * fulfilment is final, and the way forward is to start again. The merchant
 * may pick any workflow for a closed item by hand, the closed one included;
 * that replaces the row with a fresh run copied from the definition
 * (`RunRepository.setRun`).
 *
 * **Shopify events never create a to-do.** A Shopify change is applied to the
 * run and waits on nobody: the order fulfilled or cancelled closes every open
 * run, a line at zero units closes its open run, and a quantity change
 * resizes an open run ({@link Run} `quantityChangedFrom`). There is
 * nothing to dismiss. A closed run keeps its tasks as the record of who did
 * what; only deleting the row (Change workflow, a manual attach over a
 * closed item, the order's retention delete) removes tasks.
 *
 * **Mine, Up next, Teammates and Blocked hold open runs only.** Closed and done runs leave the
 * member's Mine, Up next, Teammates and Blocked tabs, and stop counting on
 * the orders index, by this status and no other rule: the list reads select
 * `status = 'active'`. The fifth tab, Recent, holds done tasks and closed
 * runs, a closed run with its reason ({@link RecentItem}).
 *
 * What each status allows. The gate column is the rule; the enforcing write
 * refuses with `RunTerminalError` when it fails. Which buttons a page shows
 * is {@link runActions} and {@link taskActions}, which read these same
 * predicates. `pnpm spec check` does not read this table: it names
 * the predicate per action, not a result per state, and the action matrices
 * pin each result it describes.
 *
 * | action                               | gate                                                                          |
 * | ------------------------------------ | ----------------------------------------------------------------------------- |
 * | Start                                | {@link runIsOpen}, task ready, not {@link runIsBlocked}                        |
 * | Done                                 | {@link runIsOpen}, task ready or started, not {@link runIsBlocked}             |
 * | note                                 | always (a note is a record)                                                    |
 * | Block, Unblock, edit reason          | {@link runIsOpen}; Unblock and edit reason only while {@link runIsBlocked}     |
 * | Put back                             | {@link runIsOpen}, task started, not blocked                                   |
 * | assign a task's team                 | {@link runIsOpen}, task open                                                   |
 * | Cancel (close, `merchant_cancelled`) | {@link runIsOpen}, order open ({@link orderIsOpen})                            |
 * | Reopen a done task               | {@link runIsOpen} or {@link runIsDone}, order open; see {@link reopenBlockedBy}  |
 * | reconcile resizes                    | {@link runIsOpen}; badge only if a task has started ({@link runIsUnstarted})   |
 * | reconcile closes                     | {@link runIsOpen}                                                              |
 * | holds the item's slot           | always, `done` and `closed` included                                           |
 * | replaced by a manual attach          | {@link runIsOpen} or {@link runIsClosed}; a `done` run is a record             |
 * | counts against the shop ceiling      | {@link runIsOpen}                                                              |
 *
 * A `done` run holds its item — a done item is not rerouted — but
 * is not open: done work does not count against
 * `ShopLimits.maxOpenRuns`, is never resized or closed by reconcile (it is
 * the record of what was made), and what is left on it is Reopen and a note.
 * A closed run holds the slot too, so reconcile starts nothing on the item: a
 * tag match must not undo a merchant's cancel or restart work Shopify ended
 * on the next webhook. The slot is the one run per item of the data model
 * on `initializeSchema` (`ShopAgentSchema.ts`).
 */
export const RunStatus = Schema.Literals(["active", "done", "closed"]);
export type RunStatus = typeof RunStatus.Type;

/**
 * Why a run was closed ({@link RunStatus}). The reason is one line of copy,
 * not a different card or a different set of actions: every closed run
 * offers the note and nothing else.
 *
 * | reason               | set by                                                       | member's Recent line                  | merchant's card line                 |
 * | -------------------- | ------------------------------------------------------------ | ------------------------------------- | ------------------------------------ |
 * | `fulfilled`          | reconcile, the order reached `FULFILLED` ({@link isFulfilled}) | Closed · Fulfilled in Shopify         | Fulfilled in Shopify                 |
 * | `order_cancelled`    | reconcile, the order was cancelled ({@link isCancelled})        | Closed · Order cancelled in Shopify   | Order cancelled in Shopify           |
 * | `item_removed`       | reconcile, the line's {@link unitsToMake} reached zero          | Closed · Item removed or refunded in Shopify | Item removed or refunded in Shopify |
 * | `merchant_cancelled` | the merchant's Cancel workflow                                | Closed · Cancelled by the merchant    | Cancelled by you                     |
 *
 * A fulfilled order closes its runs rather than marking them done because the
 * work may not have been done in Baton at all: the bench skipped the last
 * Done, the merchant took a rush order off the bench, or the item was made
 * elsewhere. Marking tasks done on the team's behalf would put a name on work
 * nobody recorded; closing says what happened.
 */
export const ClosedReason = Schema.Literals([
  "fulfilled",
  "order_cancelled",
  "item_removed",
  "merchant_cancelled",
]);
export type ClosedReason = typeof ClosedReason.Type;

/** Ended by something other than a person's Done on its last task; `closedReason` says what ({@link ClosedReason}). */
export const runIsClosed = (run: { readonly status: RunStatus }) =>
  run.status === "closed";

/**
 * Nobody has touched it: no task of the run started or done. Read from the
 * tasks, not the status, because an open run is `active` from the moment it
 * is created. Reconcile resizes such a run without the quantity badge
 * ({@link Run} `quantityChangedFrom`): nobody has cut anything to the old
 * number.
 */
export const runIsUnstarted = (
  tasks: readonly {
    readonly startedAt: number | null;
    readonly doneAt: number | null;
  }[],
) => tasks.every((task) => task.startedAt === null && task.doneAt === null);

/** Work can still be recorded: Start, Done, Block, team assignment, cancel. */
export const runIsOpen = (run: { readonly status: RunStatus }) =>
  run.status === "active";

/** The last task's Done: no work is recorded on it again unless Reopen reopens it. */
export const runIsDone = (run: { readonly status: RunStatus }) =>
  run.status === "done";

/**
 * A person holds the run, with an optional reason: the one flag Baton has.
 * A member whose team holds a current task, or the merchant, sets
 * it with Block and lifts it with Unblock; nothing else sets or clears it (a
 * Shopify change never does, and closing a run clears it with the rest of
 * the run's open state).
 *
 * What a block changes. Every site reads this predicate, never the column.
 * `pnpm spec check` does not read this table: it names the enforcer
 * per rule, not a result per state, and the action matrices pin each result
 * it describes.
 *
 * | rule                                                              | enforcer                                  |
 * | ----------------------------------------------------------------- | ----------------------------------------- |
 * | Start, Done and Put back are refused; Reopen and the note are not | `RunBlockedError`, {@link taskActions}     |
 * | Unblock and edit reason are offered; Block is not                 | {@link runActions}                         |
 * | a blocked run holds no team ("waiting on") and shows no Now line  | `OrderRepository.listOrders`, the order page |
 * | counted as `blocked`, open runs only                              | {@link runCounts}                          |
 * | the run's row is on the Blocked tab                               | {@link tierOf}                             |
 *
 * Reopen is not stopped because it takes work back rather than doing more,
 * and a held run is the one somebody needs to write on.
 */
export const runIsBlocked = (run: { readonly blockedAt: number | null }) =>
  run.blockedAt !== null;

/**
 * One workflow applied to one item. Every display field
 * is a snapshot taken at creation — `workflowName`, `orderName`, the line
 * item's title and properties — so a run's row reads only this row. The
 * member's views join `ShopOrder` for {@link OrderState} and drop a run whose
 * order is gone; the snapshots are for reading, not for outliving the order.
 *
 * What a run references, what it survives, and that an item has at most one
 * run are rules of the data model on `initializeSchema`
 * (`ShopAgentSchema.ts`), so replacing a workflow means deleting the
 * incumbent in the same transaction ({@link RunStatus}).
 */
export const Run = Schema.Struct({
  id: RunId,
  workflowId: WorkflowId,
  workflowName: WorkflowName,
  orderId: Schema.String,
  orderName: Schema.String,
  /**
   * `ShopOrder.processedAt` snapshotted at creation, like `orderName`: the
   * workflows list sorts every tier oldest-order-first from the run rows alone,
   * before it joins `ShopOrder` for the order's open state.
   */
  orderProcessedAt: Schema.Number,
  lineItemId: Schema.String,
  lineItemTitle: Schema.String,
  variantTitle: Schema.NullOr(Schema.String),
  sku: Schema.NullOr(Schema.String),
  quantity: Schema.Number,
  /**
   * The item's `properties` at creation. Prefixed like `lineItemTitle`
   * because on a run the bare word would read as the run's own.
   */
  lineItemProperties: Schema.fromJsonString(Schema.Array(LineItemProperty)),
  status: RunStatus,
  /** When the run was blocked; null is not blocked ({@link runIsBlocked}). */
  blockedAt: Schema.NullOr(Schema.Number),
  blockReason: Schema.NullOr(BlockReason),
  /**
   * Who blocked the run, role and email only. Snapshotted like the task
   * actors, so a deleted member still reads as who; an edit to the reason
   * leaves it alone.
   */
  blockedBy: Schema.NullOr(Schema.fromJsonString(ActorDisplay)),
  /**
   * The run's `quantity` before the last Shopify change, while nobody has
   * done a task since: the badge **Quantity changed · 3 → 2**.
   *
   * Reconcile writes the new units onto an open run. When a task has
   * started or is done (not {@link runIsUnstarted}) it also sets this to the
   * old quantity when it is null, so a second change keeps the original
   * "from": the maker cut to the first number, and that is the one they need
   * to hear about. An unstarted run is resized silently, since nobody has
   * worked to the old number, and a `done` run is never resized, because it
   * is the record of what was made.
   * `markTaskDone` on the run clears it: a Done after the change is
   * proof someone worked with the new number.
   *
   * Never a gate. No action reads it, because a quantity change is a notice,
   * not a stop: the new number is already on the run, and making the maker
   * acknowledge it would be a to-do created by a Shopify event
   * ({@link RunStatus}).
   */
  quantityChangedFrom: Schema.NullOr(Schema.Number),
  note: Schema.NullOr(RunNote),
  createdAt: Schema.Number,
  /**
   * Bumped by every run and task write. No screen reads it; its one reader is
   * the retention sweep (`OrderRepository.sweepExpiredOrders`), which ages an
   * orphaned run on it because the order the run belonged to, and its
   * `processedAt`, are gone. Kept for that reader alone.
   */
  updatedAt: Schema.Number,
  /** Set on a {@link runIsClosed} run only: when it closed. */
  closedAt: Schema.NullOr(Schema.Number),
  /** Set on a {@link runIsClosed} run only: why ({@link ClosedReason}). */
  closedReason: Schema.NullOr(ClosedReason),
});
export type Run = typeof Run.Type;

/**
 * A task copied from the definition at run creation. `teamName` is
 * snapshotted alongside `teamId` so the workflows list never joins D1. `teamId` is
 * the live pointer that puts the task on a team's list; a team delete nulls
 * it on *open* tasks only (**unassigned**: red on the order page, on nobody's
 * list, waiting for **assign a team**), while a done task keeps both the
 * id and the name. `startedByEmail` / `doneByEmail` / `reopenedByEmail` are
 * the snapshots taken at the action that keep history readable after the
 * member is deleted.
 *
 * Each of the three actor slots carries a `*ByRole` column, and that column
 * is the discriminator: the merchant leaves the email null (they have no
 * `Member` row), a member fills both. No slot has an id column: an actor is
 * displayed and matched by email ({@link actorIsMember}), never joined to
 * `Member`. Read them through
 * {@link taskStartedBy} / {@link taskDoneBy} / {@link taskReopenedBy}
 * rather than by hand, and see {@link ActorDisplay} for why the role is stored
 * rather than inferred from a null email.
 *
 * `reopened*` is a *last-actor slot*, not a history: it records the most
 * recent reopen and the next `markTaskDone` clears it, so the line only shows
 * while the task is genuinely back open. A reopen also
 * clears the whole Start slot, so a reopened task reads Ready. Put back
 * clears the Start slot with no slot of its own: a put-back task is plain
 * Ready and the next Start writes a fresh record.
 *
 * A task is *current* by {@link currentTasks}; several tasks of one run can be
 * current at once. `startedAt` is set by Start (and backfilled by a Done without
 * Start); it and `doneAt` are what {@link runIsUnstarted} reads, since the
 * run's status is `active` from creation.
 */
export const RunTask = Schema.Struct({
  id: RunTaskId,
  runId: RunId,
  position: Schema.Number,
  step: Schema.Number,
  name: TaskName,
  teamId: Schema.NullOr(TeamId),
  teamName: TeamName,
  instructions: Schema.NullOr(TaskInstructions),
  startedAt: Schema.NullOr(Schema.Number),
  startedByEmail: Schema.NullOr(Email),
  doneAt: Schema.NullOr(Schema.Number),
  doneByEmail: Schema.NullOr(Email),
  startedByRole: Schema.NullOr(ConnectionRole),
  doneByRole: Schema.NullOr(ConnectionRole),
  reopenedAt: Schema.NullOr(Schema.Number),
  reopenedByRole: Schema.NullOr(ConnectionRole),
  reopenedByEmail: Schema.NullOr(Email),
});
export type RunTask = typeof RunTask.Type;

/**
 * An actor slot, reassembled from its role column and its email. `null` when
 * the action has not happened; a `member` role with a missing email cannot
 * occur (the writes set the two together) and reads as nobody rather than
 * throwing, because a display path is the wrong place to fail.
 */
const actorFrom = (
  role: ConnectionRole | null,
  email: Email | null,
): ActorDisplay | null => {
  if (role === null) return null;
  if (role === "merchant") return { role: "merchant" };
  return email === null ? null : { role: "member", email };
};

/**
 * Each of these takes the slot it reads rather than a whole
 * {@link RunTask}, so a {@link RunListTask} — which carries no
 * `done*` slot at all — is as good an argument as a done one.
 */
export const taskStartedBy = (
  task: Pick<RunTask, "startedByRole" | "startedByEmail">,
) => actorFrom(task.startedByRole, task.startedByEmail);

export const taskDoneBy = (task: Pick<RunTask, "doneByRole" | "doneByEmail">) =>
  actorFrom(task.doneByRole, task.doneByEmail);

/** The reopener, the most recent one only (see {@link RunTask}). */
export const taskReopenedBy = (
  task: Pick<RunTask, "reopenedByRole" | "reopenedByEmail">,
) => actorFrom(task.reopenedByRole, task.reopenedByEmail);

/** An open run task whose team is gone: `teamId` null, or an id the roster no longer carries. */
export const isRunTaskUnassigned = (
  task: RunTask,
  teams: readonly { readonly id: TeamId }[],
) =>
  task.doneAt === null &&
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
 * current or not, done or not. It is what shows them the run page
 * (`RunRepository.getRunView`) and what lets them write the run's
 * note (`setRunNote`), the one write that is not about a particular task.
 * Acting on a task needs that task's team ({@link taskIsOnTeams}); Block
 * needs a current one, because a hold is placed by whoever is stuck.
 */
export const runIsVisibleTo = (
  tasks: readonly { readonly teamId: string | null }[],
  teamIds: readonly string[],
) => tasks.some((task) => taskIsOnTeams(task, teamIds));

/** A run is complete in itself: its tasks are copies, and nothing here refers back to the definition. */
export const RunDetail = Schema.Struct({
  run: Run,
  tasks: Schema.Array(RunTask),
});
export type RunDetail = typeof RunDetail.Type;

/**
 * One current task the member may act on, cut to what a run's row renders.
 * `startedByEmail` is read off the row — the snapshot taken at Start, never a
 * live join — and it is load-bearing beyond display: {@link tierOf} decides
 * "Mine" with it.
 *
 * Two groups of columns are omitted rather than carried as nulls. The three
 * `done*` ones can never say anything here: `currentWhere` requires `doneAt is
 * null` and a reopen clears the whole slot, so on a list task
 * every one of them is null by construction. The rest — instructions and the
 * reopened slot — say something, but only on the workflow
 * page: a row shows the task's name and one state clause, and everything
 * behind that is one tap away. Either way they are fields per task on every
 * SSR paint and every refetch.
 *
 * A done task is a {@link RecentItem}, which carries the whole
 * {@link RunTask} because there the slot is the point.
 */
export const RunListTask = Schema.Struct(
  Struct.omit(RunTask.fields, [
    "doneAt",
    "doneByEmail",
    "doneByRole",
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
 * {@link byAge}, which is the order every tier is in. `quantity` and
 * `quantityChangedFrom` stay because the row wears the quantity badge
 * ("Quantity changed · 3 → 2"), and the block columns stay because a blocked
 * row prints its reason and who. `workflowName` stays because the row
 * names the item's workflow, the noun both sides use for a run.
 *
 * What goes is everything only the workflow page reads — the order id, the
 * variant, the SKU, the timestamps, and `lineItemProperties`, which is the
 * one that matters: a JSON blob on every row of every read, parsed on
 * arrival, to render nothing. The run `note` stays:
 * the row prints it.
 */
export const RunListRun = Schema.Struct(
  Struct.omit(Run.fields, [
    "workflowId",
    "orderId",
    "variantTitle",
    "sku",
    "lineItemProperties",
    "createdAt",
    "updatedAt",
    "closedAt",
    "closedReason",
  ]),
);
export type RunListRun = typeof RunListRun.Type;

/**
 * One row of a member's workflows list: a run with every *current* task
 * ({@link currentTasks}) that belongs to one of the member's teams. `stepCount` is the run's last step, for "Step k of n" ({@link runRowLine}).
 *
 * The order's live note is not here. It is the workflow page's, along with the
 * task instructions and the item's attributes: the row is a list entry that
 * names the piece and its state, and the page one tap behind it is where a
 * maker reads anything.
 */
export const RunListItem = Schema.Struct({
  run: RunListRun,
  tasks: Schema.NonEmptyArray(RunListTask),
  stepCount: Schema.Number,
  /** The order's open or closed state, for {@link taskActions}. */
  order: OrderState,
});
export type RunListItem = typeof RunListItem.Type;

/**
 * Line two of a member's run row, in two parts so the row can swap the second
 * for a block or "Started · <who>" and keep the first. `names` is every current task
 * in `position` order, so a parallel step shows all of its tasks rather than
 * one name and a count. `step` is `Step k of n`, where k is the step the current
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
 * ({@link RunTab}) are these; `done` (Recent) is not a tier because it is a
 * window over what left the lists rather than a grouping of them. The labels the
 * member reads are the route's (`runTabs.ts`); the object only needs the
 * keys, because it is the side that groups, sorts, and caps.
 */
export const RunTier = Schema.Literals([
  "blocked",
  "mine",
  "teammates",
  "upNext",
]);
export type RunTier = typeof RunTier.Type;

/**
 * The five screens of the member's workflows list, in strip order: what I have
 * started, what I can start, what a teammate is holding, what a person has
 * blocked, and what left my lists lately. Four are the tiers of
 * {@link tierOf}, and hold open runs only ({@link RunStatus}); the blocked
 * tab (Blocked) holds blocks and nothing else, since a Shopify change is
 * never a to-do. `done` is the Recent window ({@link RecentItem}); the key
 * keeps its old name, the label is the route's (`runTabs.ts`). The tab is the
 * unit of a read: one read returns every tab's count and one tab's rows.
 */
export const RunTab = Schema.Literals([
  "mine",
  "upNext",
  "teammates",
  "blocked",
  "done",
]);
export type RunTab = typeof RunTab.Type;
export const DEFAULT_RUN_TAB: RunTab = "mine";

/**
 * Which tier a row belongs in: a block wins ({@link runIsBlocked}); else a
 * task the viewer started; else any started task; else up next. Every row
 * here is an open run already: closed and done runs never reach a tier.
 *
 * "Mine" is by `startedByEmail`; the row keeps no member id. Removing a
 * member and re-adding the same address mints a **new** `Member.id` (the
 * member row on {@link D1_TABLES}), so an id taken before that would stop
 * matching the person still standing at the bench, while the email —
 * the snapshot the run task keeps, the snapshot row on
 * {@link initializeSchema} — keeps matching. A merchant's task has no email
 * at all and so is nobody's, which is right: `Merchant` is not a member of
 * this shop.
 *
 * Put back and reopen both clear `startedByEmail`, so they are the two ways a
 * run leaves Mine without being done.
 *
 * Here rather than beside the route's labels because the object tiers the
 * rows now: one read counts every tier and returns one of them, so the
 * grouping has to happen on the side that decides what leaves.
 */
export const tierOf = (
  { run, tasks }: RunListItem,
  memberEmail: Email,
): RunTier => {
  if (runIsBlocked(run)) return "blocked";
  if (tasks.some((task) => task.startedByEmail === memberEmail)) return "mine";
  if (tasks.some((task) => task.startedAt !== null)) return "teammates";
  return "upNext";
};

/**
 * Within a tier, oldest order first by `run.orderProcessedAt` (the snapshot
 * on the run, so no join), then by item, then by run id. Two runs of one
 * order share the first key, and `createdAt` would not split them either (one
 * reconcile inserts them in the same millisecond), so the item id is the
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
 * What stands between a done task and reopening it ({@link reopenBlockedBy}). Once
 * downstream has moved the fix is a conversation, so the page names who to
 * ask rather than offering a button that would pull work out from under them.
 */
export const ReopenBlocker = Schema.Struct({
  taskName: TaskName,
  teamName: TeamName,
});
export type ReopenBlocker = typeof ReopenBlocker.Type;

/**
 * The lowest step with an open task — where the run is — or `null` once
 * every task is done.
 */
export const lowestOpenStep = (tasks: readonly RunTask[]) =>
  tasks
    .filter((task) => task.doneAt === null)
    .reduce<number | null>(
      (lowest, task) =>
        lowest === null ? task.step : Math.min(lowest, task.step),
      null,
    );

/**
 * The `current` rule on rows already in hand: step k is current when every
 * task of step k-1 is done ({@link WorkflowTask}), so a task is current when
 * its run is {@link runIsOpen}, it is open, and its step is the lowest with an
 * open task. Several are current at once on a step of several tasks, so this
 * is a list and every caller copes with more than one. A current task is
 * ready or started (the glossary's narrow words); this is the flag under
 * both. `currentWhere.ts` is the step half of the rule as SQL for the
 * workflows list and the task guards, and leaves the run's status to its callers; this
 * is the one TypeScript copy, for the merchant's order page (which holds every task of
 * the order) and the dev seeder (which walks runs a step at a time), and the
 * test on it pins that the two agree.
 */
export const currentTasks = (
  run: { readonly status: RunStatus },
  tasks: readonly RunTask[],
): RunTask[] => {
  if (!runIsOpen(run)) return [];
  const lowest = lowestOpenStep(tasks);
  return tasks.filter((task) => task.doneAt === null && task.step === lowest);
};

const firstStarted = (tasks: readonly RunTask[]) =>
  tasks
    .filter((other) => other.startedAt !== null)
    .toSorted((a, b) => a.step - b.step || a.position - b.position)[0];

/**
 * The reopen rule, on rows already in hand: the first task in a later step of
 * the same run that anyone has started. A `startedAt` test covers done
 * tasks too, because Done backfills `startedAt`.
 *
 * Pure and here rather than in `RunRepository` so the three readers
 * cannot disagree: the repository's own write, the verdicts it precomputes for
 * the member pages, and the merchant's order page, which holds every task of
 * every run on the order and decides client-side whether to offer Reopen. A
 * browser cannot import the repository module — it carries the SQL service —
 * and a second copy of this rule is exactly the drift to avoid.
 */
export const reopenBlockedBy = (
  task: RunTask,
  runTasks: readonly RunTask[],
): ReopenBlocker | null => {
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
 * One entry of the member's Recent tab: **what left my lists lately**, inside
 * {@link DONE_WINDOW_MS}, newest first. Two kinds:
 *
 * - `task`: a task one of the member's teams did, with its run for the
 *   card line and the reopen verdict precomputed by the object, which is the
 *   only side that can see the downstream tasks.
 * - `closed`: a run one of the member's teams could see ({@link runIsVisibleTo})
 *   that closed ({@link runIsClosed}), with its reason. A closed run leaves
 *   Mine, Up next, Teammates and Blocked the moment it closes, and without this entry it would
 *   just vanish; Recent is where the member reads why ("Fulfilled in
 *   Shopify", "Order cancelled in Shopify"). It is a notice, not a to-do: the
 *   row offers nothing.
 */
export const RecentItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("task"),
    run: Run,
    task: RunTask,
    reopenBlockedBy: Schema.NullOr(ReopenBlocker),
    /** The order's open or closed state, for {@link taskActions}. */
    order: OrderState,
  }),
  Schema.Struct({
    kind: Schema.Literal("closed"),
    run: Run,
    order: OrderState,
  }),
]);
export type RecentItem = typeof RecentItem.Type;

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
 * What the browser may choose about its workflows list: one of its own teams to narrow
 * to (`null` is every team on the connection), which tab, and how many rows of
 * that tab. `team` is validated against the connection's `teamIds` by the
 * object; a team the member is not on reads as an empty list, never as an
 * error. The screen resolves a URL's team against the roster before it gets
 * here (`shop.$shop.workflows.index.tsx`), so that empty list is reserved for a caller
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
 * The strip. `mine`, `upNext`, `teammates`, `blocked` and `done` are the
 * counts of the five tabs **after** `query.team` narrows them, because they
 * describe the lists the member can switch to. `total` and `teamCounts` are
 * over every team on the connection regardless of `query.team`, so the team
 * select does not move under the finger.
 */
export const RunListCounts = Schema.Struct({
  mine: Schema.Number,
  upNext: Schema.Number,
  teammates: Schema.Number,
  blocked: Schema.Number,
  done: Schema.Number,
  total: Schema.Number,
  teamCounts: Schema.Array(RunListTeamCount),
});
export type RunListCounts = typeof RunListCounts.Type;

/**
 * One read of the member's workflows list: every tab's count and one tab's rows. Exactly
 * one of `items` and `recent` is populated: `items` when `query.tab` is a tier,
 * `recent` when it is "done". The selected tab's total is `counts[query.tab]`.
 * One value rather than two reads so the loader and the socket paint the same
 * snapshot and the strip never disagrees with the list under it.
 */
export const RunListView = Schema.Struct({
  counts: RunListCounts,
  items: Schema.Array(RunListItem),
  recent: Schema.Array(RecentItem),
});
export type RunListView = typeof RunListView.Type;

/**
 * How far back Recent reaches ({@link RecentItem}). A day, not a shift: a
 * mistake is noticed when the next card looks wrong, which can be after lunch
 * or the next morning, and a longer window would make the tab a history view
 * the merchant's order page already is.
 */
export const DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A run task on the workflow page, decorated with what the page needs to offer
 * the right button: `current` is {@link currentTasks}' rule evaluated for this
 * task, and `reopenBlockedBy` is the reopen verdict for a done one. Both are
 * facts about *other* rows (earlier and later steps of the run), which is
 * why the object computes them rather than the page.
 */
export const RunTaskView = Schema.Struct({
  ...RunTask.fields,
  current: Schema.Boolean,
  reopenBlockedBy: Schema.NullOr(ReopenBlocker),
});
export type RunTaskView = typeof RunTaskView.Type;

/** What an actor may do to one run: the result of {@link runActions}, whose JSDoc holds the matrix. */
export const RunActions = Schema.Struct({
  note: Schema.Boolean,
  block: Schema.Boolean,
  editReason: Schema.Boolean,
  unblock: Schema.Boolean,
  cancel: Schema.Boolean,
  changeWorkflow: Schema.Boolean,
});
export type RunActions = typeof RunActions.Type;

/** The "m" in {@link runActions}' table: the merchant, or a member whose team holds a current task on the run. */
const holdsCurrentTask = (
  actor: Actor,
  tasks: readonly {
    readonly teamId: string | null;
    readonly current: boolean;
  }[],
) =>
  actor.role === "merchant" ||
  tasks.some(
    (task) => task.current && taskIsOnTeams(task, actor.teamIds ?? []),
  );

/**
 * What an actor may do to one run, as the page and the server both read it.
 * The page renders a run-level button only when its field is true, and the
 * `ShopAgent` callable for that write computes the same object from the same
 * inputs and refuses with `NotAllowed` when the field is false, so a stale
 * tab or a second admin cannot write what the page would not offer. The
 * repository keeps its own guards underneath; they protect the write from
 * every caller, reconcile and tests included.
 *
 * The table is the rule. `test/integration/run-actions.test.ts` reads it
 * out of this comment and asserts every row, so a change starts at a cell
 * and the test names the cell until the formula follows. `pnpm lint`
 * refuses a malformed table.
 *
 * "M" is the merchant. "m" is a member whose team holds a current
 * task on the run ({@link currentTasks}, {@link taskIsOnTeams}), the team gate
 * `RunRepository` applies to Block, Edit reason and Unblock; for the
 * note it is a member who can see the run ({@link runIsVisibleTo}). Blank is
 * never. Each state column is one input; a row is one fixture, and a word
 * such as "closed" under `order` stands for every state it names. A done
 * run is never blocked (the data model on `initializeSchema`,
 * `ShopAgentSchema.ts`), so "any" under `blocked` beside "open or done"
 * names a block on the open run only.
 *
 * | order  | run          | blocked | units | note | block | editReason | unblock | cancel | changeWorkflow |
 * | ------ | ------------ | ------- | ----- | ---- | ----- | ---------- | ------- | ------ | -------------- |
 * | open   | open         | no      | some  | M m  | M m   |            |         | M      | M              |
 * | open   | open         | yes     | some  | M m  |       | M m        | M m     | M      | M              |
 * | open   | open         | no      | none  | M m  | M m   |            |         | M      |                |
 * | open   | done         | no      | some  | M m  |       |            |         |        |                |
 * | open   | closed       | no      | some  | M m  |       |            |         |        |                |
 * | closed | open or done | any     | some  | M m  |       |            |         |        |                |
 * | closed | closed       | no      | some  | M m  |       |            |         |        |                |
 *
 * Why a cell is blank where it might not be:
 *
 * - `note` is never blank: a note is a record, not work.
 * - `block` is blank on a blocked run: it is already held, and a second
 *   Block would overwrite who held it. On a done or closed run there is no
 *   work left to hold.
 * - `editReason` and `unblock` need {@link runIsBlocked}. Closing a run
 *   clears its block, so a closed run is never blocked. A blocked run on a
 *   closed order is one reconcile has not yet closed; the order's close
 *   ends the work, and the block goes with it.
 * - `cancel` is blank on a done run: it is a record, reopened rather than
 *   cancelled. A closed run is over already. On a closed order reconcile
 *   has already closed every open run; there is nothing to cancel.
 * - `changeWorkflow` needs units to make ({@link unitsToMake}): a new run
 *   on an item Shopify removed or refunded to zero would be a run with no
 *   work behind it, and reconcile would close it as `item_removed` on its
 *   next pass. A done run is a record ({@link RunStatus}). A closed item
 *   takes a new workflow from its picker instead ({@link lineItemState}).
 *   Reading it needs the item, which only the merchant's callers
 *   hold, so `item` is optional and its absence answers false: member
 *   pages never offer Change workflow.
 * - There is no member `cancel` or `changeWorkflow`: those are the
 *   merchant's decisions about what the shop makes.
 */
export const runActions = (
  actor: Actor,
  order: OrderState,
  run: { readonly status: RunStatus; readonly blockedAt: number | null },
  tasks: readonly {
    readonly teamId: string | null;
    readonly current: boolean;
  }[],
  item?: Pick<OrderLineItem, "currentQuantity">,
): RunActions => {
  const merchant = actor.role === "merchant";
  const working = orderIsOpen(order) && runIsOpen(run);
  const holds = holdsCurrentTask(actor, tasks);
  const held = working && runIsBlocked(run) && holds;
  return {
    note: merchant || runIsVisibleTo(tasks, actor.teamIds ?? []),
    block: working && !runIsBlocked(run) && holds,
    editReason: held,
    unblock: held,
    cancel: merchant && working,
    changeWorkflow:
      merchant && working && item !== undefined && unitsToMake(item) > 0,
  };
};

/**
 * What an actor may do to one task: the result of {@link taskActions}, whose JSDoc holds the matrix.
 */
export const TaskActions = Schema.Struct({
  start: Schema.Boolean,
  done: Schema.Boolean,
  putBack: Schema.Boolean,
  /** `null` when Reopen is not offered; otherwise the blocker, `null` meaning the button. */
  reopen: Schema.NullOr(
    Schema.Struct({ blockedBy: Schema.NullOr(ReopenBlocker) }),
  ),
  assign: Schema.Boolean,
});
export type TaskActions = typeof TaskActions.Type;

/**
 * What an actor may do to one task, by the same contract as
 * {@link runActions}: the page draws a button only when its field is true,
 * the `ShopAgent` callable refuses with `NotAllowed` when it is false, and
 * the test reads this table. "M" is the merchant, "m" a member whose team
 * the task is on ({@link taskIsOnTeams}).
 *
 * | order  | run          | blocked | task     | downstream | start | done | putBack | reopen  | assign |
 * | ------ | ------------ | ------- | -------- | ---------- | ----- | ---- | ------- | ------- | ------ |
 * | open   | open         | no      | ready    | -          | m     | M m  |         |         | M      |
 * | open   | open         | no      | started  | -          |       | M m  | M m     |         | M      |
 * | open   | open         | no      | waiting  | -          |       |      |         |         | M      |
 * | open   | open         | yes     | any open | -          |       |      |         |         | M      |
 * | open   | open or done | any     | done     | none       |       |      |         | M m     |        |
 * | open   | open or done | any     | done     | started    |       |      |         | blocker |        |
 * | open   | closed       | no      | any      | -          |       |      |         |         |        |
 * | closed | open or done | any     | any      | -          |       |      |         |         |        |
 *
 * `blocker` under `reopen` is the button with a sentence: the started
 * downstream task ({@link reopenBlockedBy}) is carried so the merchant page
 * can say what stands in the way.
 *
 * - `start` is member only. "Started" records that a worker picked the task
 *   up, and a merchant marking it started on their behalf would put a name
 *   on work nobody has begun.
 * - `done` and `putBack` stop under a block: a block means stop
 *   ({@link runIsBlocked}). Put back goes to the whole team, not only the
 *   starter (`RunRepository.putBackTask`).
 * - `reopen` is offered under a block because it takes work back rather
 *   than doing more, and on a done run because reopening its last task is
 *   the point. Not on a closed run: closed is final ({@link RunStatus}),
 *   and reopening a task would put work back on a run that can never be done.
 * - `assign` is blank on a done task: it keeps the team that did it
 *   (`TaskDoneError`). One verb for a task with no team and for moving
 *   one that has a team.
 * - Everything is blank on a closed order ({@link orderIsOpen}) and a
 *   closed run: Shopify, or the merchant, says the work is over.
 *
 * **The verbs a task offers are the same on the workflows list and the
 * workflow page, and neither screen styles one as primary.** Primary and
 * secondary are a page's hierarchy, held in `s-page`'s action slots; a task has neither.
 * Polaris allows one primary per card and per page
 * (`refs/shopify-docs/docs/apps/design/layout.md`, "Cards that offer
 * interactivity"), and a step with two current tasks would draw two.
 *
 * When reopen is blocked, the merchant sees which task is in the way,
 * because the merchant can reopen or put back that task. A member sees
 * no Reopen button and no explanation: they cannot change the other
 * task, and it is already on their screen marked started.
 */
export const taskActions = (
  actor: Actor,
  order: OrderState,
  run: { readonly status: RunStatus; readonly blockedAt: number | null },
  task: Pick<
    RunTaskView,
    "teamId" | "current" | "startedAt" | "doneAt" | "reopenBlockedBy"
  >,
): TaskActions => {
  const merchant = actor.role === "merchant";
  const orderOpen = orderIsOpen(order);
  const mine =
    orderOpen && (merchant || taskIsOnTeams(task, actor.teamIds ?? []));
  const workable =
    mine &&
    runIsOpen(run) &&
    !runIsBlocked(run) &&
    task.current &&
    task.doneAt === null;
  return {
    start: workable && !merchant && task.startedAt === null,
    done: workable,
    putBack: workable && task.startedAt !== null,
    reopen:
      mine && !runIsClosed(run) && task.doneAt !== null
        ? { blockedBy: task.reopenBlockedBy }
        : null,
    assign: merchant && orderOpen && runIsOpen(run) && task.doneAt === null,
  };
};

/**
 * What one item's card is, as the order page switches on it: one kind
 * per layout.
 *
 * - `open` and `done`: the item has a run, open or `done`. Checked first,
 *   so an item whose units dropped to zero under a `done` run still shows
 *   the work that was done.
 * - `closed`: the item's run is {@link runIsClosed}. The run card shows with
 *   its tasks as the record, one line gives the reason and when, and the
 *   picker offers every workflow, the closed one included, as a fresh run.
 *   One kind for every reason: the reason is a line of copy
 *   ({@link ClosedReason}), not a layout. `startable` is false when the item
 *   has nothing left to make ({@link unitsToMake}): no workflow starts there,
 *   the same rule as `changeWorkflow` on {@link runActions}, and the line
 *   stands alone.
 * - `removed`: no run, and `currentQuantity` is zero. Nothing to do.
 * - `startable`: no run, and at least one active workflow with tasks can be
 *   attached. `options` lists the matched workflows first, then the rest;
 *   `ambiguous` is {@link ambiguousItems}' test for this one item, and the
 *   page says why it is asking.
 * - `unmatched`: no run and no workflow to offer.
 *
 * A block is not a kind: it adds a banner, not a different card. A closed
 * order is not a kind either: the kinds are the same under it, every field
 * of {@link runActions} and {@link taskActions} that does work is false, and
 * the sidebar's Fulfillment and Cancelled lines say why. The one control
 * outside those sets, the picker at rest, is the page's to hide with
 * {@link orderIsOpen}.
 *
 * `tasks` are decorated as the workflow page's are ({@link RunTaskView}), from
 * rows the order page already holds, so {@link taskActions} reads the same
 * shape on both pages.
 */
export const LineItemState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("removed") }),
  Schema.Struct({ kind: Schema.Literal("unmatched") }),
  Schema.Struct({
    kind: Schema.Literal("startable"),
    options: Schema.Array(Workflow),
    matched: Schema.Array(WorkflowId),
    ambiguous: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("closed"),
    run: Run,
    tasks: Schema.Array(RunTaskView),
    options: Schema.Array(Workflow),
    matched: Schema.Array(WorkflowId),
    startable: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("open"),
    run: Run,
    tasks: Schema.Array(RunTaskView),
  }),
  Schema.Struct({
    kind: Schema.Literal("done"),
    run: Run,
    tasks: Schema.Array(RunTaskView),
  }),
]);
export type LineItemState = typeof LineItemState.Type;

/** A run's tasks as {@link RunTaskView}s, from the rows alone: the `current` flag by {@link currentTasks}, the reopen verdict by {@link reopenBlockedBy}. */
export const runTaskViews = (
  run: { readonly status: RunStatus },
  tasks: readonly RunTask[],
): RunTaskView[] => {
  const current = new Set(currentTasks(run, tasks).map((task) => task.id));
  return tasks.map((task) => ({
    ...task,
    current: current.has(task.id),
    reopenBlockedBy: task.doneAt === null ? null : reopenBlockedBy(task, tasks),
  }));
};

export const lineItemState = (
  item: OrderLineItem,
  runs: readonly RunDetail[],
  workflows: readonly Workflow[],
): LineItemState => {
  const detail = runs.find(({ run }) => run.lineItemId === item.id);
  const matched = workflows.filter((workflow) =>
    item.matchedWorkflowIds.includes(workflow.id),
  );
  const options = [
    ...matched,
    ...workflows.filter((workflow) => !matched.includes(workflow)),
  ];
  return Match.value({ detail, removed: item.currentQuantity === 0 }).pipe(
    Match.withReturnType<LineItemState>(),
    Match.when({ detail: Match.defined }, ({ detail: { run, tasks } }) =>
      runIsClosed(run)
        ? {
            kind: "closed",
            run,
            tasks: runTaskViews(run, tasks),
            options,
            matched: matched.map((workflow) => workflow.id),
            startable: unitsToMake(item) > 0,
          }
        : {
            kind: runIsOpen(run) ? "open" : "done",
            run,
            tasks: runTaskViews(run, tasks),
          },
    ),
    Match.when({ removed: true }, () => ({ kind: "removed" })),
    Match.when(
      () => options.length === 0,
      () => ({ kind: "unmatched" }),
    ),
    Match.orElse(() => ({
      kind: "startable",
      options,
      matched: matched.map((workflow) => workflow.id),
      ambiguous: item.matchedWorkflowIds.length >= 2 && unitsToMake(item) > 0,
    })),
  );
};

/**
 * Everything `/shop/$shop/workflows/$runId` renders: one run, its tasks, and the
 * order's live note.
 *
 * The other items on the order are deliberately **not** here. A workflow
 * is attached to a product and runs once per matching item
 * ({@link Workflow}), so a member's unit of work is the item and its
 * tasks. Nothing on this page acts on the order as a whole, and an order can
 * carry an unbounded number of lines to render.
 */
export const RunView = Schema.Struct({
  run: Run,
  tasks: Schema.Array(RunTaskView),
  /** Shopify's order note, read-only here; the run's own note is `run.note`. */
  orderNote: Schema.NullOr(Schema.String),
  /** The order's open or closed state, for {@link runActions} and {@link taskActions}. */
  order: OrderState,
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
  runs: Schema.Array(RunDetail),
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
 * The member workflows list's loader read. Still Worker-resolved: `teamIds` comes
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
 * The socket half of the member workflows list's read: the same rows `listRuns`
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
 * The workflow page's loader read, Worker-resolved for the same reason as
 * {@link ListRunsInput}. The guard is "any task of the run on one of my
 * teams", not "a current task": a member may open work they have done.
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
export const MarkTaskDoneInput = Schema.Struct({
  runTaskId: BoundedId,
});
export type MarkTaskDoneInput = typeof MarkTaskDoneInput.Type;

export const StartTaskInput = MarkTaskDoneInput;
export type StartTaskInput = typeof StartTaskInput.Type;

/** Reopen: returns a done task to Ready. Same shape; the rule is on `RunRepository.reopenTask`. */
export const ReopenTaskInput = MarkTaskDoneInput;
export type ReopenTaskInput = typeof ReopenTaskInput.Type;

/** Put back: clears a started task's Start record. Same shape; the rule is on `RunRepository.putBackTask`. */
export const PutBackTaskInput = MarkTaskDoneInput;
export type PutBackTaskInput = typeof PutBackTaskInput.Type;

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
 * reopen guard — applies to both.
 */
export interface StartTaskCommand {
  readonly runTaskId: string;
  /** Member-only: there is no merchant Start — the merchant never claims work. */
  readonly actor: MemberActor;
  readonly teamIds?: readonly string[] | undefined;
}

export interface MarkTaskDoneCommand {
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

/** Lifts a block. No `actor`: nothing records who unblocked, and the block's own record goes with it. */
export interface UnblockRunCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No `actor`, by the rule on {@link SetRunNoteCommand}. `blockedBy` stays
 * whoever set the hold.
 */
export interface SetBlockReasonCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
  readonly reason: BlockReason | null;
}

/** The actor lands in the task's `reopened` slot: a reopen is a fact worth showing, and the next Done clears it. */
export interface ReopenTaskCommand {
  readonly runTaskId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * No slot records the actor: the task is plain Ready again
 * ({@link RunTask}). `actor` is taken for the log line and for
 * symmetry with the other task commands.
 */
export interface PutBackTaskCommand {
  readonly runTaskId: string;
  readonly actor: Actor;
  readonly teamIds?: readonly string[] | undefined;
}

/**
 * `WorkflowCannotStart` = off, zero tasks, or an unassigned task (see
 * {@link Workflow}).
 *
 * `replaced` is the run that was deleted to make room, or null. An item
 * holds at most one run, so attaching over one is a *replace*: the server
 * decides that from the item's state rather than from a separate input, and
 * the page uses `replaced` to say which workflow it took the item off.
 */
export const AttachResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Ok"),
    run: Run,
    replaced: Schema.NullOr(Run),
  }),
  Schema.Struct({ _tag: Schema.Literal("AlreadyExists") }),
  Schema.Struct({ _tag: Schema.Literal("LineItemNotFound") }),
  Schema.Struct({ _tag: Schema.Literal("WorkflowCannotStart") }),
  /** The shop is at `ShopLimits.maxOpenRuns`; the attach started nothing. */
  Schema.Struct({ _tag: Schema.Literal("RunLimit"), limit: Schema.Number }),
  /** The item's run is `done`; done work is not replaced. Names it. */
  Schema.Struct({
    _tag: Schema.Literal("ItemDone"),
    workflowName: WorkflowName,
  }),
  /** The order is cancelled or fully fulfilled, so there is nothing to attach work to ({@link orderIsOpen}). */
  Schema.Struct({ _tag: Schema.Literal("OrderClosed") }),
  /** The item has no units to make ({@link unitsToMake}): removed or refunded to zero in Shopify. */
  Schema.Struct({ _tag: Schema.Literal("NothingToMake") }),
]);
export type AttachResult = typeof AttachResult.Type;

/**
 * `NotAllowed` = the caller's action set refuses the write
 * ({@link runActions}, {@link taskActions}), or the task's team is not among
 * the caller's; `NotReady` = the task is not current ({@link currentTasks}) or is
 * already done (for reopen, not yet done; for put back, not yet started or
 * already done); `Terminal` = the run's status refuses this write, done
 * where it needs an open run, see the table on {@link RunStatus};
 * `ReopenBlocked` = someone downstream
 * has started, and names them ({@link ReopenBlocker}).
 *
 * `NotBlocked` = a write that only a standing block admits (rewriting its
 * reason) found no block. Separate from `NotAllowed` because the cause is a
 * race, not a permission: the hold was lifted while the editor was open, and
 * "this belongs to another team" would send the reader after the wrong thing.
 *
 * A write on a {@link runIsClosed} run other than the note answers
 * `NotAllowed`: every such field of {@link runActions} and
 * {@link taskActions} is false on it.
 */
export const RunResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Ok") }),
  Schema.Struct({ _tag: Schema.Literal("NotFound") }),
  Schema.Struct({ _tag: Schema.Literal("NotAllowed") }),
  Schema.Struct({ _tag: Schema.Literal("NotBlocked") }),
  Schema.Struct({ _tag: Schema.Literal("NotReady") }),
  Schema.Struct({ _tag: Schema.Literal("Terminal") }),
  /** Start, Done or Put back on a blocked run ({@link runIsBlocked}). */
  Schema.Struct({ _tag: Schema.Literal("Blocked") }),
  Schema.Struct({
    _tag: Schema.Literal("ReopenBlocked"),
    ...ReopenBlocker.fields,
  }),
]);
export type RunResult = typeof RunResult.Type;
