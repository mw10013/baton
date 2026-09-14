import type * as Domain from "@/lib/Domain";

import { SqliteClient } from "@effect/sql-sqlite-do";
import { runInDurableObject } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { runShopAgentMigrations } from "@/lib/ShopAgent";

import {
  agentSocket,
  isInvalidated,
  memberActions,
  openMemberSocket,
  type AgentSocket,
} from "./agent-socket";
import {
  emailOf,
  resetMemberTables,
  run,
  seedShop,
  shopOf,
  signInThroughWorker,
  teamNameOf,
} from "./member-fixtures";

/**
 * The member socket end to end: the queue read that registers a subscription,
 * the push fan-out that decides who hears about a write, and one full hop
 * through the Worker's gate with a real sign-in cookie.
 *
 * The fan-out is the interesting part. A member's subscription is scoped by
 * their teams, not by an order, so `publish` cannot use the order GIDs that
 * scope a merchant's. The five member mutations name the teams instead — every
 * team owning a step on any run of the touched order, because completing the
 * last item step makes the *order* run ready for a different team
 * (`WorkflowRunRepository.listOrderTeamIds`). A team with no work on that order
 * hears nothing.
 */
const ORDER_ID = "gid://shopify/Order/1";
const LINE_ITEM_ID = "gid://shopify/LineItem/1";

const seedOrder = (shop: string) =>
  runInDurableObject(
    env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          const processedAt = Date.now() - 60_000;
          yield* (yield* OrderRepository).upsertOrder({
            order: {
              id: ORDER_ID,
              legacyId: "1",
              name: "#1001",
              processedAt,
              updatedAt: processedAt,
              cancelledAt: null,
              closedAt: null,
              financialStatus: "PAID",
              fulfillmentStatus: "UNFULFILLED",
              fullyPaid: true,
              tags: [],
              note: null,
              customAttributes: [],
              lineItemsComplete: true,
              syncedAt: processedAt,
              syncSource: "manual",
            },
            raw: "{}",
            lineItems: [
              {
                id: LINE_ITEM_ID,
                orderId: ORDER_ID,
                productId: null,
                variantId: null,
                title: "Necklace",
                variantTitle: null,
                sku: null,
                quantity: 1,
                currentQuantity: 1,
                unfulfilledQuantity: 1,
                nonFulfillableQuantity: 0,
                productTags: [],
                customAttributes: [],
                requiresShipping: true,
              },
            ],
          });
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              OrderRepository.layer,
              SqliteClient.layer({ storage: state.storage }),
            ),
          ),
        ),
      ),
  );

/**
 * One shop with two teams, a member on each, an order, and a one-step item
 * workflow owned by the first team — the smallest arrangement in which a write
 * is in one team's queue and not the other's.
 */
const seedShopWithWork = async (shopName: string) => {
  const shop = shopOf(shopName);
  const seeded = await Effect.runPromise(
    run(
      Effect.gen(function* () {
        yield* seedShop(shop);
        const repository = yield* Repository;
        const working = yield* repository.createTeam({
          shop,
          name: teamNameOf("Engraving"),
        });
        const idle = yield* repository.createTeam({
          shop,
          name: teamNameOf("Shipping"),
        });
        const memberIdOf = (email: Domain.Email, teamId: Domain.TeamId) =>
          Effect.gen(function* () {
            yield* repository.addMember({ shop, email });
            const access = yield* repository.findMemberAccess({ shop, email });
            const memberId = Option.isNone(access)
              ? yield* Effect.die("member missing right after addMember")
              : access.value.memberId;
            yield* repository.setMemberTeams({
              shop,
              memberId,
              teamIds: [teamId],
            });
            return memberId;
          });
        return {
          working,
          idle,
          alice: yield* memberIdOf(emailOf("alice@example.com"), working.id),
          bob: yield* memberIdOf(emailOf("bob@example.com"), working.id),
          carol: yield* memberIdOf(emailOf("carol@example.com"), idle.id),
        };
      }),
    ),
  );
  await seedOrder(shopName);
  const agent = env.SHOP_AGENT.getByName(shopName);
  const created = await agent.createWorkflow({ name: "Engrave", tags: [] });
  if (created._tag !== "Ok") throw new Error(created._tag);
  await agent.addStep({
    workflowId: created.workflow.id,
    name: "Engrave",
    teamId: seeded.working.id,
  });
  const applied = await agent.applyDraft({ workflowId: created.workflow.id });
  if (applied._tag !== "Ok") throw new Error(applied._tag);
  const live = await agent.setWorkflowActive({
    workflowId: created.workflow.id,
    active: true,
  });
  if (live._tag !== "Ok") throw new Error(live._tag);
  const attached = await agent.attachWorkflow({
    lineItemId: LINE_ITEM_ID,
    workflowId: created.workflow.id,
  });
  if (attached._tag !== "Ok") throw new Error(attached._tag);
  const [detail] = await agent.listRunsForOrder({ orderId: ORDER_ID });
  const runStepId = detail?.steps[0]?.id;
  if (runStepId === undefined) throw new Error("no run step");
  return { shop, runStepId, ...seeded };
};

const subscribe = (socket: AgentSocket, subscriberId: string) =>
  socket.call<readonly Domain.QueueItem[]>("subscribeQueue", { subscriberId });

afterEach(async () => {
  await resetMemberTables();
});

describe("member queue socket", () => {
  it("reads the queue for the connection's teams and subscribes", async () => {
    const { shop, working, alice, idle, carol } = await seedShopWithWork(
      "queue-read.myshopify.com",
    );
    const worker = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    const items = await subscribe(worker.socket, "sub-alice");
    expect(items).toHaveLength(1);
    expect(items[0]?.steps[0]?.teamId).toBe(working.id);
    worker.close();

    // The same call on a connection scoped to a team with no work reads empty
    // — the teams come off the connection, so there is nothing to ask for.
    const idler = await openMemberSocket(shop, {
      memberId: carol,
      memberEmail: "carol@example.com",
      teamIds: [idle.id],
    });
    expect(await subscribe(idler.socket, "sub-carol")).toHaveLength(0);
    idler.close();
  });

  it("pushes a completed step to the team, and not to a team with no work on that order", async () => {
    const { shop, working, idle, runStepId, alice, bob, carol } =
      await seedShopWithWork("queue-push.myshopify.com");
    const acting = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    const teammate = await openMemberSocket(shop, {
      memberId: bob,
      memberEmail: "bob@example.com",
      teamIds: [working.id],
    });
    const elsewhere = await openMemberSocket(shop, {
      memberId: carol,
      memberEmail: "carol@example.com",
      teamIds: [idle.id],
    });
    await subscribe(acting.socket, "sub-alice");
    await subscribe(teammate.socket, "sub-bob");
    await subscribe(elsewhere.socket, "sub-carol");

    expect(await acting.completeStep({ runStepId })).toEqual({ _tag: "Ok" });

    await teammate.socket.waitForMessage(isInvalidated);
    await expect(
      elsewhere.socket.waitForMessage(isInvalidated, 200),
    ).rejects.toThrow("no matching frame");
    acting.close();
    teammate.close();
    elsewhere.close();
  });

  /**
   * The whole path a maker's browser takes: magic-link cookie, upgrade through
   * the Worker's gate, identity resolved from D1 and forwarded to the object,
   * and a mutation whose `memberId` / `teamIds` the browser never sent.
   */
  it("completes a step over a socket opened with a real member cookie", async () => {
    const { shop, runStepId } = await seedShopWithWork(
      "queue-cookie.myshopify.com",
    );
    const cookie = await Effect.runPromise(
      run(signInThroughWorker(emailOf("alice@example.com"))),
    );
    const socket = agentSocket(
      await workerExports.default.fetch(
        new Request(`http://localhost/agents/shop-agent/${shop}`, {
          headers: { Upgrade: "websocket", cookie },
        }),
      ),
    );
    await socket.waitForMessage((data) => data.includes("cf_agent_identity"));
    // Nothing here names Alice, her team, or her id: the gate put all three on
    // the connection, and the object read them from there.
    expect(await memberActions(socket).completeStep({ runStepId })).toEqual({
      _tag: "Ok",
    });
    socket.close();
  });
});
