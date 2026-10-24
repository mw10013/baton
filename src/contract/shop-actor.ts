import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import {
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
  AssignRunTaskTeamInput,
  AssignRunTaskTeamResult,
  AttachResult,
  AttachWorkflowInput,
  BlockRunInput,
  CreateWorkflowInput,
  DeleteTeamResult,
  DeleteWorkflowInput,
  DeleteWorkflowResult,
  DiscardDraftInput,
  DiscardResult,
  DuplicateWorkflowInput,
  GetOrderDetailInput,
  JoinTaskInput,
  ListOrdersInput,
  LiveRunsInput,
  MarkTaskDoneInput,
  Member,
  MoveTaskInput,
  OrderPageData,
  OrdersIndexData,
  PutBackTaskInput,
  ReopenTaskInput,
  RunIdInput,
  RunPageData,
  RunResult,
  RemoveTaskInput,
  SeparateTaskInput,
  SetRunNoteInput,
  StartTaskInput,
  SetWorkflowStateInput,
  SwitchResult,
  TaskResult,
  Team,
  UpdateTaskInput,
  UpdateWorkflowInput,
  UpdateWorkflowTagInput,
  WorkflowResult,
  WorkflowsListData,
} from "../domain/shop-work.ts";
import { ShopUsage } from "../domain/billing.ts";
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

/**
 * The orders' and their runs' reactivity key: an order or one of its runs changed (a write that
 * moved an order row or a run, or a sweep that deleted one). Read by every screen that shows
 * orders or their runs, the member's included.
 */
export const ORDERS_KEY = "orders";

/**
 * The open-orders sync status's reactivity key (`MerchantSyncStatus`): a sync started, or ended
 * in any way.
 */
export const SYNC_KEY = "sync";

/**
 * A member on a socket: the `member` role's identity (`memberId`,
 * `memberEmail`, `teamIds`), plus the Better Auth session it was resolved from. `sessionId`
 * scopes a revoke to one session; `sessionExpiresAt` (epoch ms, the session's `expiresAt`) is
 * the backstop for a missed revoke, checked on every message. `teamIds` gates the member's run
 * reads and writes, which take the member's identity from here, never from a payload.
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

/** Close code for a socket whose identity was revoked: the browser asks again. */
export const CONNECTION_CLOSE_REVOKED = 3401;

/**
 * Close code for a socket that may not open this shop: sent by the gate for a 403 (an
 * admin, or a Shopify token for another shop), and by the actor for a socket whose
 * {@link CONNECTION_HEADER} does not decode. Terminal to the browser.
 */
export const CONNECTION_CLOSE_FORBIDDEN = 4403;

/** Close code the gate sends for a 401: no session, or a Shopify token it rejects. */
export const CONNECTION_CLOSE_UNAUTHENTICATED = 4401;

/** Close code the gate sends for a 404: no `Member` row for this shop. */
export const CONNECTION_CLOSE_NOT_A_MEMBER = 4404;

/**
 * Close code the gate sends for a 402: the shop holds no app subscription (a merchant's shop,
 * or the shop of a member). Terminal to the browser, which re-runs its route guards instead:
 * `/app` sends the merchant to plan selection, the member layout to Subscription inactive. A
 * revoke's 3401 after a plan change reconnects into this answer.
 */
export const CONNECTION_CLOSE_PAYMENT_REQUIRED = 4402;

/**
 * Close code the gate sends for a 503, when it could not answer (WebSocket's "try again
 * later"). The browser retries.
 */
export const CONNECTION_CLOSE_TRY_AGAIN = 1013;

/**
 * Close code for a member's oldest socket when a newer one takes the last of
 * {@link MAX_CONNECTIONS_PER_MEMBER}. Terminal to the browser, so two windows never
 * displace each other in turn; only the person's Reconnect opens a new socket.
 */
export const CONNECTION_CLOSE_DISPLACED = 4409;

/**
 * Close code for every socket when the shop uninstalls Baton and its actor is destroyed.
 * Terminal: the actor and its storage are gone, so the browser must not reconnect. The gate
 * would refuse it anyway, since the shop's session and members went first.
 */
export const CONNECTION_CLOSE_UNINSTALLED = 4410;

/** At most this many sockets per member; merchants are not capped. */
export const MAX_CONNECTIONS_PER_MEMBER = 2;

/**
 * A member's procedures, served on the socket only. Each `Require…` admits exactly its role, so
 * a read both roles may make is declared once per role, as Baton does, never with a role switch
 * inside a handler. The first middleware added runs innermost: the role check reads the caller
 * {@link ConnectionMiddleware} provides.
 */
export const MemberRpcs = RpcGroup.make(
  Rpc.make("MemberActivation", { success: Activation }),
  Rpc.make("MemberWhoAmI", { success: ConnectionCaller }),
  Rpc.make("MemberListRuns", { payload: LiveRunsInput, success: WorkflowsListData }),
  Rpc.make("MemberGetRun", { payload: RunIdInput, success: Schema.NullOr(RunPageData) }),
  Rpc.make("MemberStartTask", { payload: StartTaskInput, success: RunResult }),
  Rpc.make("MemberMarkTaskDone", { payload: MarkTaskDoneInput, success: RunResult }),
  Rpc.make("MemberReopenTask", { payload: ReopenTaskInput, success: RunResult }),
  Rpc.make("MemberPutBackTask", { payload: PutBackTaskInput, success: RunResult }),
  Rpc.make("MemberSetRunNote", { payload: SetRunNoteInput, success: RunResult }),
  Rpc.make("MemberBlockRun", { payload: BlockRunInput, success: RunResult }),
  Rpc.make("MemberUnblockRun", { payload: RunIdInput, success: RunResult }),
)
  .middleware(RequireMember)
  .middleware(ConnectionMiddleware);

/**
 * A merchant's procedures; see {@link MemberRpcs} for the role rule. The workflow writes answer
 * result unions as their success and declare no error: the screens switch on the
 * union's `_tag`, and a fault is a defect.
 */
export const MerchantRpcs = RpcGroup.make(
  Rpc.make("MerchantWhoAmI", { success: ConnectionCaller }),
  Rpc.make("MerchantListOrders", { payload: ListOrdersInput, success: OrdersIndexData }),
  Rpc.make("MerchantGetOrderDetail", {
    payload: GetOrderDetailInput,
    success: Schema.NullOr(OrderPageData),
  }),
  Rpc.make("MerchantAttachWorkflow", { payload: AttachWorkflowInput, success: AttachResult }),
  Rpc.make("MerchantCancelRun", { payload: RunIdInput, success: RunResult }),
  Rpc.make("MerchantMarkTaskDone", { payload: MarkTaskDoneInput, success: RunResult }),
  Rpc.make("MerchantReopenTask", { payload: ReopenTaskInput, success: RunResult }),
  Rpc.make("MerchantPutBackTask", { payload: PutBackTaskInput, success: RunResult }),
  Rpc.make("MerchantSetRunNote", { payload: SetRunNoteInput, success: RunResult }),
  Rpc.make("MerchantBlockRun", { payload: BlockRunInput, success: RunResult }),
  Rpc.make("MerchantUnblockRun", { payload: RunIdInput, success: RunResult }),
  Rpc.make("MerchantAssignRunTaskTeam", {
    payload: AssignRunTaskTeamInput,
    success: AssignRunTaskTeamResult,
  }),
  Rpc.make("MerchantGetUsage", { success: ShopUsage }),
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
  Rpc.make("MerchantRemoveTask", { payload: RemoveTaskInput, success: TaskResult }),
)
  .middleware(RequireMerchant)
  .middleware(ConnectionMiddleware);

export const ShopActorRpcs = MemberRpcs.merge(MerchantRpcs);
