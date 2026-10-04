import { SqliteClient } from "@effect/sql-sqlite-do";
import { runInDurableObject } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";

import {
  agentSocket,
  isInvalidated,
  memberActions,
  openMemberSocket,
  openMerchantSocket,
  openTwoScreens,
  receivedInvalidations,
  receivesNoMore,
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
 * The member socket end to end: the workflows list read that registers a subscription,
 * the publish fan-out that decides who receives a write's invalidation, and one full hop
 * through the Worker's gate with a real sign-in cookie.
 *
 * The fan-out is the interesting part. A member's subscription is scoped by
 * their teams, not by an order, so `publish` cannot use the order GIDs that
 * scope a merchant's. The five member mutations name the teams instead — every
 * team owning a task on any run of the touched order, because marking the
 * last item task done makes the *order* run current for a different team
 * (`RunRepository.listOrderTeamIds`). A team with no work on that order
 * receives nothing.
 */
const ORDER_ID = "gid://shopify/Order/1";
const LINE_ITEM_ID = "gid://shopify/LineItem/1";

/** Stores order `n` (`#100n`, legacy id `n`) with one item; order 1 is {@link ORDER_ID}. */
const seedOrder = (shop: string, n = 1) =>
  runInDurableObject(
    env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          const processedAt = Date.now() - 60_000;
          yield* (yield* OrderRepository).upsertOrder({
            order: {
              id: `gid://shopify/Order/${String(n)}`,
              legacyId: String(n),
              name: `#100${String(n)}`,
              processedAt,
              updatedAt: processedAt,
              cancelledAt: null,
              fulfillmentStatus: "UNFULFILLED",
              fullyPaid: true,
              note: null,
              syncedAt: processedAt,
            },
            lineItems: [
              {
                id: `gid://shopify/LineItem/${String(n)}`,
                orderId: `gid://shopify/Order/${String(n)}`,
                title: "Necklace",
                variantTitle: null,
                sku: null,
                quantity: 1,
                currentQuantity: 1,
                productTags: [],
                properties: [],
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
 * One shop with two teams, a member on each, an order, and a one-task item
 * workflow owned by the first team — the smallest arrangement in which a write
 * is on one team's list and not the other's.
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
            yield* repository.addMember({
              shop,
              email,
            });
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
  const created = await agent.createWorkflow({
    name: "Engrave",
    tag: "engrave",
  });
  if (created._tag !== "Ok") throw new Error(created._tag);
  await agent.addStep({
    workflowId: created.workflow.id,
    name: "Engrave",
    teamId: seeded.working.id,
  });
  const applied = await agent.applyDraft({ workflowId: created.workflow.id });
  if (applied._tag !== "Ok") throw new Error(applied._tag);
  const live = await agent.setWorkflowOn({
    workflowId: created.workflow.id,
    on: true,
  });
  if (live._tag !== "Ok") throw new Error(live._tag);
  const attached = await agent.merchantAttachWorkflow({
    lineItemId: LINE_ITEM_ID,
    workflowId: created.workflow.id,
  });
  if (attached._tag !== "Ok") throw new Error(attached._tag);
  const [detail] = await agent.merchantListRunsForOrder({ orderId: ORDER_ID });
  const runTaskId = detail?.tasks[0]?.id;
  if (runTaskId === undefined) throw new Error("no run task");
  return {
    shop,
    runTaskId,
    runId: detail?.run.id ?? "",
    workflowId: created.workflow.id,
    ...seeded,
  };
};

/** One page of Ready, every team: what every test here seeds a single row into. */
const READY: Domain.RunQuery = {
  team: null,
  state: "ready",
  limit: Domain.RUN_PAGE,
  q: null,
};

const subscribeList = (
  socket: AgentSocket,
  subscriberId: string,
  query: Domain.RunQuery = READY,
) =>
  socket.call<Domain.WorkflowsListData>("subscribeRuns", {
    subscriberId,
    query,
  });

/**
 * The current rows of one state. Every test here seeds a single untouched task on
 * one team, which is Ready for whoever reads it.
 */
const subscribe = (
  socket: AgentSocket,
  subscriberId: string,
  query?: Domain.RunQuery,
) => subscribeList(socket, subscriberId, query).then((list) => list.items);

afterEach(async () => {
  await resetMemberTables();
});

describe("member workflows list socket", () => {
  it("reads the workflows list for the connection's teams and subscribes", async () => {
    const { shop, working, alice, idle, carol } = await seedShopWithWork(
      "runs-read.myshopify.com",
    );
    const worker = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    const items = await subscribe(worker.socket, "sub-alice");
    expect(items).toHaveLength(1);
    expect(items[0]?.tasks[0]?.teamId).toBe(working.id);
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

  /**
   * The query is the browser's to choose and the object's to honour: the same
   * connection, re-subscribing with a different state, gets that state's rows
   * while every read agrees on the counts. What this proves is that `query`
   * reaches the object and selects the state — sorting by state itself is the
   * repository's test.
   */
  it("re-subscribing with a different query changes what the read returns", async () => {
    const { shop, working, alice } = await seedShopWithWork(
      "runs-limits.myshopify.com",
    );
    const worker = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    const ready = await subscribeList(worker.socket, "sub-alice", {
      ...READY,
      limit: 1,
    });
    expect(ready.items).toHaveLength(1);
    expect(ready.counts.ready).toBe(1);

    const done = await subscribeList(worker.socket, "sub-alice", {
      ...READY,
      state: "done",
    });
    expect(done.items).toHaveLength(0);
    expect(done.recent).toHaveLength(0);
    expect(done.counts.ready).toBe(1);
    worker.close();
  });

  it("publishes a completed task to the team, and not to a team with no work on that order", async () => {
    const { shop, working, idle, runTaskId, alice, bob, carol } =
      await seedShopWithWork("runs-publish.myshopify.com");
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

    expect(await acting.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });

    await teammate.socket.waitForMessage(isInvalidated);
    await expect(
      elsewhere.socket.waitForMessage(isInvalidated, 200),
    ).rejects.toThrow("no matching frame");
    acting.close();
    teammate.close();
    elsewhere.close();
  });

  /**
   * The merchant's half of the same fan-out. `merchantMarkTaskDone` carries no
   * identity and no `teamIds` — the order page has neither — yet lands on a
   * task owned by a team it is not on, and the worker watching that team
   * receives the invalidation over their own socket. The rules the merchant is still held to are
   * the repository's and are tested there; this is the wire.
   */
  it("completes a member's task over a merchant socket and publishes it to the team", async () => {
    const { shop, working, runTaskId, alice } = await seedShopWithWork(
      "runs-merchant.myshopify.com",
    );
    const worker = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    await subscribe(worker.socket, "sub-alice");

    const merchant = await openMerchantSocket(shop);
    expect(await merchant.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });

    await worker.socket.waitForMessage(isInvalidated);
    expect(await subscribe(worker.socket, "sub-alice")).toHaveLength(0);
    merchant.close();
    worker.close();
  });

  it("a task verb reaches the orders index and the order's page, and not another order's page", async () => {
    const { shop, working, runTaskId, alice } = await seedShopWithWork(
      "runs-order-scope.myshopify.com",
    );
    await seedOrder(shop, 2);
    const index = await openMerchantSocket(shop);
    await index.socket.call("subscribeOrders", {
      subscriberId: "sub-index",
      limit: 50,
      cursor: null,
      q: null,
      show: null,
      team: null,
    });
    const thisOrder = await openMerchantSocket(shop);
    await thisOrder.socket.call("subscribeOrder", {
      subscriberId: "sub-order-1",
      legacyId: "1",
    });
    const otherOrder = await openMerchantSocket(shop);
    await otherOrder.socket.call("subscribeOrder", {
      subscriberId: "sub-order-2",
      legacyId: "2",
    });
    const worker = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });

    expect(await worker.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });

    await thisOrder.socket.waitForMessage(isInvalidated);
    await index.socket.waitForMessage(isInvalidated);
    await expect(
      otherOrder.socket.waitForMessage(isInvalidated, 200),
    ).rejects.toThrow("no matching frame");
    index.close();
    thisOrder.close();
    otherOrder.close();
    worker.close();
  });

  /**
   * The whole path a maker's browser takes: magic-link cookie, upgrade through
   * the Worker's gate, identity resolved from D1 and forwarded to the object,
   * and a mutation whose `memberId` / `teamIds` the browser never sent.
   */
  it("completes a task over a socket opened with a real member cookie", async () => {
    const { shop, runTaskId } = await seedShopWithWork(
      "runs-cookie.myshopify.com",
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
    expect(await memberActions(socket).markTaskDone({ runTaskId })).toEqual({
      _tag: "Ok",
    });
    socket.close();
  });
});

/**
 * The cycle on `Domain.Subscription`, the rows the suite above does not
 * already prove: what a connection receives before it subscribes, after a
 * stale unsubscribe, after a reconnect, and on the member's workflow page.
 * Each negative waits 200 ms, as the team-scope test does; each has a
 * positive beside it, so a publish that never ran cannot pass for a
 * delivery rule.
 */
const identified = (socket: AgentSocket) =>
  socket.waitForMessage((data) => data.includes("cf_agent_identity"));

describe("the subscription cycle", () => {
  it("a connection with no subscription receives nothing", async () => {
    const { shop, working, runTaskId, alice, bob } = await seedShopWithWork(
      "cycle-unsubscribed.myshopify.com",
    );
    const idle = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    await identified(idle.socket);
    const acting = await openMemberSocket(shop, {
      memberId: bob,
      memberEmail: "bob@example.com",
      teamIds: [working.id],
    });
    await subscribe(acting.socket, "sub-bob");

    expect(await acting.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });

    await acting.socket.waitForMessage(isInvalidated);
    await expect(
      idle.socket.waitForMessage(isInvalidated, 200),
    ).rejects.toThrow("no matching frame");
    idle.close();
    acting.close();
  });

  it("a stale unsubscribe cannot clear a newer mount's subscription", async () => {
    const { shop, working, runTaskId, alice, bob } = await seedShopWithWork(
      "cycle-stale-unsubscribe.myshopify.com",
    );
    const watching = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    await subscribe(watching.socket, "sub-a");
    await subscribe(watching.socket, "sub-b");
    // The replaced mount's unsubscribe, landing after the newer mount's read.
    await watching.socket.call("unsubscribe", { subscriberId: "sub-a" });
    const acting = await openMemberSocket(shop, {
      memberId: bob,
      memberEmail: "bob@example.com",
      teamIds: [working.id],
    });

    expect(await acting.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });

    await watching.socket.waitForMessage(isInvalidated);
    watching.close();
    acting.close();
  });

  it("a reconnect is a fresh connection with no subscription", async () => {
    const { shop, working, workflowId, alice } = await seedShopWithWork(
      "cycle-reconnect.myshopify.com",
    );
    const member = {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    };
    const before = await openMemberSocket(shop, member);
    await subscribe(before.socket, "sub-alice");
    before.close();
    const after = await openMemberSocket(shop, member);
    await identified(after.socket);
    const agent = env.SHOP_AGENT.getByName(shop);

    // Edit tag publishes to every screen ("all", "all"), so only a missing
    // subscription can keep it from this connection.
    await agent.updateWorkflowTag({ workflowId, tag: "engrave-2" });
    await expect(
      after.socket.waitForMessage(isInvalidated, 200),
    ).rejects.toThrow("no matching frame");

    await subscribe(after.socket, "sub-alice");
    await agent.updateWorkflowTag({ workflowId, tag: "engrave-3" });
    await after.socket.waitForMessage(isInvalidated);
    after.close();
  });

  it("the member's workflow page receives what the list receives", async () => {
    const { shop, working, idle, runId, runTaskId, alice, bob, carol } =
      await seedShopWithWork("cycle-run-page.myshopify.com");
    const onTeam = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    await onTeam.socket.call("subscribeRun", {
      subscriberId: "sub-alice-run",
      runId,
    });
    const offTeam = await openMemberSocket(shop, {
      memberId: carol,
      memberEmail: "carol@example.com",
      teamIds: [idle.id],
    });
    await offTeam.socket.call("subscribeRun", {
      subscriberId: "sub-carol-run",
      runId,
    });
    const acting = await openMemberSocket(shop, {
      memberId: bob,
      memberEmail: "bob@example.com",
      teamIds: [working.id],
    });

    expect(await acting.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });

    await onTeam.socket.waitForMessage(isInvalidated);
    await expect(
      offTeam.socket.waitForMessage(isInvalidated, 200),
    ).rejects.toThrow("no matching frame");
    onTeam.close();
    offTeam.close();
    acting.close();
  });
});

/**
 * The rows of the sites table on `ShopAgent.publish` that the run verbs and
 * the configuration verbs own, each over the two screens of
 * `openTwoScreens`: the orders index, which receives any publish, and a
 * member on a team with no work, who receives only a publish to all teams.
 */
describe("what each write publishes", () => {
  it("Edit tag and Apply publish to every screen whether or not a run moved", async () => {
    const { shop, workflowId } = await seedShopWithWork(
      "sites-edit-tag-apply.myshopify.com",
    );
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop);

    // Neither write moves a run: the item has no tags, and the draft is
    // applied unchanged.
    await agent.updateWorkflowTag({ workflowId, tag: "engrave-2" });
    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    await agent.createDraft({ workflowId });
    const applied = await agent.applyDraft({ workflowId });
    expect(applied._tag).toBe("Ok");
    await receivedInvalidations(screens.merchant, 2);
    await receivedInvalidations(screens.member, 2);
    screens.close();
  });

  it("turning a workflow on or off, deleting it, or deleting a team publishes to every screen", async () => {
    const { shop, workflowId, working, idle } = await seedShopWithWork(
      "sites-configuration.myshopify.com",
    );
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop);
    const everyScreen = async (count: number) => {
      await receivedInvalidations(screens.merchant, count);
      await receivedInvalidations(screens.member, count);
    };

    await agent.setWorkflowOn({ workflowId, on: false });
    await everyScreen(1);
    await agent.setWorkflowOn({ workflowId, on: true });
    await everyScreen(2);
    const created = await agent.createWorkflow({ name: "Box", tag: "box" });
    if (created._tag !== "Ok") throw new Error(created._tag);
    await agent.addStep({
      workflowId: created.workflow.id,
      name: "Box",
      teamId: working.id,
    });
    const turnedOn = await agent.applyAndTurnOn({
      workflowId: created.workflow.id,
    });
    expect(turnedOn._tag).toBe("Ok");
    await everyScreen(3);
    await agent.removeWorkflow({ workflowId: created.workflow.id });
    await everyScreen(4);
    await agent.deleteTeam({ teamId: idle.id });
    await everyScreen(5);
    screens.close();
  });

  it("assigning a task's team publishes to the teams before and after", async () => {
    const { shop, runTaskId, working, idle, alice, carol } =
      await seedShopWithWork("sites-assign.myshopify.com");
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop);
    const losing = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    await subscribe(losing.socket, "sub-alice");
    const gaining = await openMemberSocket(shop, {
      memberId: carol,
      memberEmail: "carol@example.com",
      teamIds: [idle.id],
    });
    await subscribe(gaining.socket, "sub-carol");

    expect(
      await agent.merchantAssignRunTaskTeam({ runTaskId, teamId: idle.id }),
    ).toEqual({ _tag: "Assigned" });

    await receivedInvalidations(losing.socket, 1);
    await receivedInvalidations(gaining.socket, 1);
    await receivedInvalidations(screens.merchant, 1);
    await receivesNoMore(screens.member);
    losing.close();
    gaining.close();
    screens.close();
  });

  it("Attach workflow publishes the order to every team", async () => {
    const { shop, workflowId } = await seedShopWithWork(
      "sites-attach.myshopify.com",
    );
    await seedOrder(shop, 2);
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop);
    const otherOrder = await openMerchantSocket(shop);
    await otherOrder.socket.call("subscribeOrder", {
      subscriberId: "sub-order-1",
      legacyId: "1",
    });

    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/2",
      workflowId,
    });
    expect(attached._tag).toBe("Ok");

    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    await receivesNoMore(otherOrder.socket);
    otherOrder.close();
    screens.close();
  });

  it("Cancel workflow publishes the order to the teams it had", async () => {
    const { shop, runId, working, alice } = await seedShopWithWork(
      "sites-cancel.myshopify.com",
    );
    await seedOrder(shop, 2);
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop);
    const otherOrder = await openMerchantSocket(shop);
    await otherOrder.socket.call("subscribeOrder", {
      subscriberId: "sub-order-2",
      legacyId: "2",
    });
    const onTeam = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    await subscribe(onTeam.socket, "sub-alice");

    expect(await agent.merchantCancelRun({ runId })).toEqual({ _tag: "Ok" });

    // The run's task is gone from the team's list after the write, so only
    // the read before it names the team.
    await receivedInvalidations(onTeam.socket, 1);
    await receivedInvalidations(screens.merchant, 1);
    await receivesNoMore(otherOrder.socket);
    await receivesNoMore(screens.member);
    onTeam.close();
    otherOrder.close();
    screens.close();
  });

  /**
   * The `written` rows of the sites table: a refusal wrote nothing a screen
   * shows, and the refused tab refetches itself on every result
   * (`useMemberRunActions`). One refusal per result shape: a member verb and
   * a merchant verb on a task already done, Edit tag on a workflow that is
   * not there, Apply with no draft, the switch on a workflow that is not
   * there. The positive half first, so a publish that never ran cannot pass.
   */
  it("a refused call publishes nothing", async () => {
    const { shop, workflowId, runTaskId, working, alice } =
      await seedShopWithWork("sites-refused.myshopify.com");
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop, [working.id]);
    const acting = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    const merchant = await openMerchantSocket(shop);

    expect(await acting.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });
    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);

    expect(await acting.markTaskDone({ runTaskId })).toEqual({
      _tag: "NotAllowed",
    });
    expect(await merchant.markTaskDone({ runTaskId })).toEqual({
      _tag: "NotAllowed",
    });
    const edited = await agent.updateWorkflowTag({
      workflowId: "missing",
      tag: "x",
    });
    expect(edited._tag).toBe("NotFound");
    const applied = await agent.applyDraft({ workflowId });
    expect(applied._tag).toBe("NoDraft");
    const switched = await agent.setWorkflowOn({
      workflowId: "missing",
      on: false,
    });
    expect(switched._tag).toBe("NotFound");
    await receivesNoMore(screens.merchant, 1);
    await receivesNoMore(screens.member, 1);
    acting.close();
    merchant.close();
    screens.close();
  });
});
