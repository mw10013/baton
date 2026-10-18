import * as Cloudflare from "alchemy/Cloudflare";
import type * as Effect from "effect/Effect";
import type { ShopSnapshot } from "../../contract/shop-actor.ts";
import type { OrderDetail } from "../../domain/orders.ts";
import type {
  GetOrderDetailInput,
  ListOrdersInput,
  ListRunsInput,
  OrderPageData,
  RunPageData,
  TeamId,
  WorkflowsListData,
  ListWorkflowsInput,
  OrdersIndexData,
  WorkflowPageData,
  WorkflowSetupFacts,
  WorkflowsIndexData,
} from "../../domain/shop-work.ts";
import type { ActorFixtureAdded, ActorFixtureCounts, ActorFixtureRows } from "../fixture.ts";
import type { OrderWebhookStatus } from "./orders.ts";
import type { OrdersStreamCounts } from "./orders-stream.ts";

/**
 * The reason `ShopActor.destroy` aborts the object with. The stub call it lands in rejects with
 * an `Error` of this message, which is how `ShopActors.destroy` tells the abort from a failure.
 */
export const ABORT_UNINSTALLED = "uninstalled";

/**
 * The methods the Backend and the orders sync Workflow may call on {@link ShopActor}'s stub, and
 * nothing else: the written contract of who may call the actor outside its socket. Declared, not
 * inferred from the implementation, so the tag's type does not depend on it.
 */
export interface ShopActorShape {
  readonly revoke: (input: {
    readonly by: "member" | "session";
    readonly id: string;
  }) => Effect.Effect<{ closed: number }>;
  readonly snapshot: () => Effect.Effect<ShopSnapshot>;
  readonly loadFixture: (rows: ActorFixtureRows) => Effect.Effect<ActorFixtureCounts>;
  readonly addFixture: (rows: ActorFixtureRows) => Effect.Effect<ActorFixtureAdded>;
  readonly applyFixture: (input: {
    readonly rows: ActorFixtureRows;
    readonly caller: "loadFixture" | "addToFixture";
  }) => Effect.Effect<void>;
  readonly removeOrder: (input: {
    readonly orderId: string;
  }) => Effect.Effect<{ removed: boolean }>;
  readonly syncOrderWebhook: (input: {
    readonly orderId: string;
    readonly topic: string;
    readonly updatedAt: number | null;
  }) => Effect.Effect<OrderWebhookStatus>;
  readonly getOrder: (input: { readonly orderId: string }) => Effect.Effect<OrderDetail | null>;
  readonly listOrders: (input: ListOrdersInput) => Effect.Effect<OrdersIndexData>;
  readonly getOrderDetail: (input: GetOrderDetailInput) => Effect.Effect<OrderPageData | null>;
  readonly listRuns: (input: ListRunsInput) => Effect.Effect<WorkflowsListData>;
  readonly getRunPage: (input: {
    readonly runId: string;
    readonly teamIds: ReadonlyArray<TeamId>;
  }) => Effect.Effect<RunPageData | null>;
  readonly listWorkflows: (input: ListWorkflowsInput) => Effect.Effect<WorkflowsIndexData>;
  readonly getWorkflowDetail: (input: {
    readonly workflowId: string;
  }) => Effect.Effect<WorkflowPageData | null>;
  readonly workflowSetupFacts: () => Effect.Effect<WorkflowSetupFacts>;
  readonly onOrdersStream: (input: {
    readonly workflowId: string;
    readonly url: string;
  }) => Effect.Effect<OrdersStreamCounts>;
  readonly onOrdersSyncEmpty: (input: { readonly workflowId: string }) => Effect.Effect<void>;
  readonly onOrdersSyncError: (input: {
    readonly workflowId: string;
    readonly message: string;
  }) => Effect.Effect<void>;
  readonly destroy: () => Effect.Effect<void>;
}

/**
 * One shop's actor, named by its `ShopKey`, holding the shop's work in private SQLite. After a
 * write it pushes a `Notice` to every socket so each browser refetches; it never pushes the value.
 *
 * It has two surfaces that never overlap. Browsers call `ShopActorRpcs` with Effect RPC over a
 * hibernating WebSocket; there is no HTTP RPC into the actor. The Backend and the orders sync
 * Workflow call {@link ShopActorShape}'s schemaless methods on its stub, which no browser can
 * reach.
 *
 * It owns its shop, as legacy's `ShopAgent` does: it fetches an order from the Admin API itself
 * (`Orders`, over the Backend's own `ShopifyAdmin`, which refreshes the offline token when a
 * call needs it), reads the shop's `ShopSession`, and creates the orders sync Workflow's instance
 * itself; the Workflow makes the bulk calls and calls the actor back.
 *
 * This module is the actor's identity only, with no implementation import: the actor yields the
 * Workflow and the Workflow binds the actor, and only this class may cross that cycle. The
 * implementation is `ShopActorLive`.
 *
 * @see refs/alchemy/website/src/content/docs/infrastructure-as-effects/circular-bindings.mdx
 */
export default class ShopActor extends Cloudflare.DurableObject<ShopActor, ShopActorShape>()(
  "ShopActor",
) {}
