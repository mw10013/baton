import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import {
  OrderDetail,
  OrdersSyncResult,
  OrdersSyncStatus,
  SyncOrderInput,
  SyncOrderResult,
} from "../domain/orders.ts";
import {
  AddStepInput,
  AddTaskInput,
  ApplyAndTurnOnInput,
  ApplyDraftInput,
  ApplyResult,
  CreateWorkflowInput,
  DeleteTeamResult,
  DeleteWorkflowInput,
  DeleteWorkflowResult,
  DiscardDraftInput,
  DiscardResult,
  DuplicateWorkflowInput,
  JoinTaskInput,
  ListOrdersInput,
  Member,
  MoveTaskInput,
  OrdersCursor,
  SeparateTaskInput,
  SetWorkflowStateInput,
  SwitchResult,
  TaskIdInput,
  TaskResult,
  Team,
  UpdateTaskInput,
  UpdateWorkflowInput,
  UpdateWorkflowTagInput,
  WorkflowResult,
} from "../domain/shop-work.ts";
import { Email, Forbidden } from "./auth.ts";
import {
  AddMemberInput,
  AddMemberTeamsInput,
  AddTeamMembersInput,
  CreateTeamInput,
  DeleteMemberInput,
  DeleteTeamInput,
  MemberCeilingError,
  MemberNotFoundError,
  RenameTeamInput,
  SetTeamMemberInput,
  TeamLimitError,
  TeamNameTakenError,
  TeamNotFoundError,
} from "./members.ts";
import { OrdersSyncFailure } from "./shopify.ts";

export const Count = Schema.Struct({ value: Schema.Int });
export type Count = typeof Count.Type;

/**
 * A dev aid: an id minted once per activation of the actor. The same id across calls means the
 * same activation; a new id after an idle period shows the object hibernated and was rebuilt.
 */
export const Activation = Schema.Struct({ id: Schema.String });

/**
 * What the actor pushes to every connected socket after a write: the reactivity keys whose
 * queries are stale. Never the data; a browser refetches what it renders. Carried on the RPC
 * socket as its own frame, outside the RPC protocol; see `ShopActorClient`.
 */
export const Notice = Schema.Struct({
  _tag: Schema.Literal("ShopActorNotice"),
  invalidated: Schema.Array(Schema.String),
});
export type Notice = typeof Notice.Type;

/** A {@link Notice} as the JSON text frame it travels in. */
export const NoticeFrame = Schema.fromJsonString(Notice);

/** The `count` reactivity key. */
export const COUNT_KEY = "count";

/** The orders list's reactivity key: a write that moved an order row, or a sweep that deleted one. */
export const ORDERS_KEY = "orders";

/**
 * The open-orders sync status's reactivity key (`MerchantSyncStatus`): a sync started, or ended
 * in any way.
 */
export const SYNC_KEY = "sync";

/**
 * One page of the orders list, run-free: `limit` and `cursor` as `ListOrdersInput` bounds them,
 * without its search, filter or team. `cursor` null is page one.
 */
export const OrdersListInput = Schema.Struct({
  limit: ListOrdersInput.fields.limit,
  cursor: ListOrdersInput.fields.cursor,
});
export type OrdersListInput = typeof OrdersListInput.Type;

/**
 * A page of the orders list: each order with its items, newest first by `processedAt`, and the
 * cursor of the next page, null on the last. `OrdersPage` without its runs, counts and matches.
 */
export const OrdersListPage = Schema.Struct({
  orders: Schema.Array(OrderDetail),
  limit: Schema.Number,
  nextCursor: Schema.NullOr(OrdersCursor),
});
export type OrdersListPage = typeof OrdersListPage.Type;

/**
 * A member on a socket: Baton's `ConnectionState` for the `member` role (`memberId`,
 * `memberEmail`, `teamIds`), plus the Better Auth session it was resolved from. `sessionId`
 * scopes a revoke to one session; `sessionExpiresAt` (epoch ms, the session's `expiresAt`) is
 * the backstop for a missed revoke, checked on every message. `teamIds` is carried as Baton
 * carries it; nothing reads it yet.
 */
export const MemberCaller = Schema.Struct({
  role: Schema.Literal("member"),
  memberId: Schema.String,
  memberEmail: Email,
  teamIds: Schema.Array(Schema.String),
  userId: Schema.String,
  sessionId: Schema.String,
  sessionExpiresAt: Schema.Number,
});
export type MemberCaller = typeof MemberCaller.Type;

/**
 * A merchant: whoever presented a Shopify session token for the shop. It carries nothing beyond
 * its role, as in Baton, and its token is checked at connect only.
 */
export const MerchantCaller = Schema.Struct({ role: Schema.Literal("merchant") });
export type MerchantCaller = typeof MerchantCaller.Type;

/** What a socket can carry: a member or a merchant. */
export const ConnectionCaller = Schema.Union([MemberCaller, MerchantCaller]);
export type ConnectionCaller = typeof ConnectionCaller.Type;

/** The caller of the current procedure, provided by {@link ConnectionMiddleware}. */
export class CurrentCaller extends Context.Service<CurrentCaller, ConnectionCaller>()(
  "CurrentCaller",
) {}

/**
 * The header naming a socket's {@link ConnectionCaller}, as JSON. Only the Backend's gate sets
 * it, on the upgrade it forwards to the actor, and it rebuilds that request from nothing, so a
 * browser cannot set it. The actor decodes it once, when it accepts the socket.
 */
export const CONNECTION_HEADER = "x-actor-connection";

/**
 * Provides {@link CurrentCaller}: the socket's caller, written into the socket when it was
 * accepted, from {@link CONNECTION_HEADER}. Nothing a message carries is read.
 */
export class ConnectionMiddleware extends RpcMiddleware.Service<
  ConnectionMiddleware,
  { provides: CurrentCaller }
>()("ConnectionMiddleware") {}

/** Admits a `merchant` caller only. */
export class RequireMerchant extends RpcMiddleware.Service<
  RequireMerchant,
  { requires: CurrentCaller }
>()("RequireMerchant", { error: Forbidden }) {}

/** Admits a `member` caller only. */
export class RequireMember extends RpcMiddleware.Service<
  RequireMember,
  { requires: CurrentCaller }
>()("RequireMember", { error: Forbidden }) {}

/** Close code for a socket whose identity was revoked (Baton's): the browser asks again. */
export const CONNECTION_CLOSE_REVOKED = 3401;

/**
 * Close code for a socket that may not open this shop (Baton's): sent by the gate for a 403 (an
 * admin, or a Shopify token for another shop), and by the actor for a socket whose
 * {@link CONNECTION_HEADER} does not decode. Terminal to the browser.
 */
export const CONNECTION_CLOSE_FORBIDDEN = 4403;

/** Close code the gate sends for a 401 (Baton's): no session, or a Shopify token it rejects. */
export const CONNECTION_CLOSE_UNAUTHENTICATED = 4401;

/** Close code the gate sends for a 404 (Baton's): no `Member` row for this shop. */
export const CONNECTION_CLOSE_NOT_A_MEMBER = 4404;

/**
 * Close code the gate sends for a 503, when it could not answer (WebSocket's "try again
 * later"). The browser retries.
 */
export const CONNECTION_CLOSE_TRY_AGAIN = 1013;

/**
 * Close code for a member's oldest socket when a newer one takes the last of
 * {@link MAX_CONNECTIONS_PER_MEMBER} (Baton's). Terminal to the browser, so two windows never
 * displace each other in turn; only the person's Reconnect opens a new socket.
 */
export const CONNECTION_CLOSE_DISPLACED = 4409;

/**
 * Close code for every socket when the shop uninstalls Baton and its actor is destroyed.
 * Terminal: the actor and its storage are gone, so the browser must not reconnect. The gate
 * would refuse it anyway, since the shop's session and members went first.
 */
export const CONNECTION_CLOSE_UNINSTALLED = 4410;

/** At most this many sockets per member (Baton's `maxConnectionsPerMember`); merchants are not capped. */
export const MAX_CONNECTIONS_PER_MEMBER = 2;

/** What `ShopActor.snapshot` returns for the Backend: the page's first data, read at once. */
export const ShopSnapshot = Schema.Struct({ count: Count, activation: Activation });
export type ShopSnapshot = typeof ShopSnapshot.Type;

/**
 * A member's procedures, served on the socket only. Each `Require…` admits exactly its role, so
 * a read both roles may make is declared once per role, as Baton does, never with a role switch
 * inside a handler. The first middleware added runs innermost: the role check reads the caller
 * {@link ConnectionMiddleware} provides.
 */
export const MemberRpcs = RpcGroup.make(
  Rpc.make("MemberGetCount", { success: Count }),
  Rpc.make("MemberIncrement", { success: Count }),
  Rpc.make("MemberActivation", { success: Activation }),
  Rpc.make("MemberWhoAmI", { success: ConnectionCaller }),
)
  .middleware(RequireMember)
  .middleware(ConnectionMiddleware);

/**
 * A merchant's procedures; see {@link MemberRpcs} for the role rule. The workflow writes answer
 * legacy's result unions as their success and declare no error: the screens switch on the
 * union's `_tag`, and a fault is a defect.
 */
export const MerchantRpcs = RpcGroup.make(
  Rpc.make("MerchantGetCount", { success: Count }),
  Rpc.make("MerchantResetCount", { success: Count }),
  Rpc.make("MerchantWhoAmI", { success: ConnectionCaller }),
  Rpc.make("MerchantListOrders", { payload: OrdersListInput, success: OrdersListPage }),
  Rpc.make("MerchantSyncStatus", { success: OrdersSyncStatus }),
  Rpc.make("MerchantSyncOpenOrders", { success: OrdersSyncResult, error: OrdersSyncFailure }),
  Rpc.make("MerchantSyncOrder", {
    payload: SyncOrderInput,
    success: SyncOrderResult,
    error: OrdersSyncFailure,
  }),
  Rpc.make("MerchantAddMember", {
    payload: AddMemberInput,
    success: Member,
    error: MemberCeilingError,
  }),
  Rpc.make("MerchantDeleteMember", { payload: DeleteMemberInput, error: MemberNotFoundError }),
  Rpc.make("MerchantAddMemberTeams", { payload: AddMemberTeamsInput, error: MemberNotFoundError }),
  Rpc.make("MerchantSetTeamMember", { payload: SetTeamMemberInput, error: TeamNotFoundError }),
  Rpc.make("MerchantCreateTeam", {
    payload: CreateTeamInput,
    success: Team,
    error: Schema.Union([TeamLimitError, TeamNameTakenError]),
  }),
  Rpc.make("MerchantRenameTeam", {
    payload: RenameTeamInput,
    error: Schema.Union([TeamNameTakenError, TeamNotFoundError]),
  }),
  Rpc.make("MerchantAddTeamMembers", { payload: AddTeamMembersInput, error: TeamNotFoundError }),
  Rpc.make("MerchantDeleteTeam", { payload: DeleteTeamInput, success: DeleteTeamResult }),
  Rpc.make("MerchantCreateWorkflow", { payload: CreateWorkflowInput, success: WorkflowResult }),
  Rpc.make("MerchantDuplicateWorkflow", {
    payload: DuplicateWorkflowInput,
    success: WorkflowResult,
  }),
  Rpc.make("MerchantUpdateWorkflow", { payload: UpdateWorkflowInput, success: WorkflowResult }),
  Rpc.make("MerchantUpdateWorkflowTag", {
    payload: UpdateWorkflowTagInput,
    success: WorkflowResult,
  }),
  Rpc.make("MerchantApplyDraft", { payload: ApplyDraftInput, success: ApplyResult }),
  Rpc.make("MerchantDiscardDraft", { payload: DiscardDraftInput, success: DiscardResult }),
  Rpc.make("MerchantSetWorkflowState", { payload: SetWorkflowStateInput, success: SwitchResult }),
  Rpc.make("MerchantApplyAndTurnOn", { payload: ApplyAndTurnOnInput, success: SwitchResult }),
  Rpc.make("MerchantDeleteWorkflow", {
    payload: DeleteWorkflowInput,
    success: DeleteWorkflowResult,
  }),
  Rpc.make("MerchantAddStep", { payload: AddStepInput, success: TaskResult }),
  Rpc.make("MerchantAddTask", { payload: AddTaskInput, success: TaskResult }),
  Rpc.make("MerchantUpdateTask", { payload: UpdateTaskInput, success: TaskResult }),
  Rpc.make("MerchantMoveTask", { payload: MoveTaskInput, success: TaskResult }),
  Rpc.make("MerchantSeparateTask", { payload: SeparateTaskInput, success: TaskResult }),
  Rpc.make("MerchantJoinTask", { payload: JoinTaskInput, success: TaskResult }),
  Rpc.make("MerchantRemoveTask", { payload: TaskIdInput, success: TaskResult }),
)
  .middleware(RequireMerchant)
  .middleware(ConnectionMiddleware);

export const ShopActorRpcs = MemberRpcs.merge(MerchantRpcs);
