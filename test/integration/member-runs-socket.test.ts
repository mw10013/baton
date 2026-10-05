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
 * The member socket end to end: the workflows list read over the socket, the
 * publish that tells every connection to re-read after a write, and one full
 * hop through the Worker's gate with a real sign-in cookie.
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

const readList = (socket: AgentSocket, query: Domain.RunQuery = READY) =>
  socket.call<Domain.WorkflowsListData>("liveRuns", { query });

/**
 * The current rows of one state. Every test here seeds a single untouched task on
 * one team, which is Ready for whoever reads it.
 */
const readItems = (socket: AgentSocket, query?: Domain.RunQuery) =>
  readList(socket, query).then((list) => list.items);

afterEach(async () => {
  await resetMemberTables();
});

describe("member workflows list socket", () => {
  it("reads the workflows list for the connection's teams", async () => {
    const { shop, working, alice, idle, carol } = await seedShopWithWork(
      "runs-read.myshopify.com",
    );
    const worker = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    const items = await readItems(worker.socket);
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
    expect(await readItems(idler.socket)).toHaveLength(0);
    idler.close();
  });

  /**
   * The query is the browser's to choose and the object's to honour: the same
   * connection, reading again with a different state, gets that state's rows
   * while every read agrees on the counts. What this proves is that `query`
   * reaches the object and selects the state — sorting by state itself is the
   * repository's test.
   */
  it("a second read with a different query returns that query's rows", async () => {
    const { shop, working, alice } = await seedShopWithWork(
      "runs-limits.myshopify.com",
    );
    const worker = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    const ready = await readList(worker.socket, {
      ...READY,
      limit: 1,
    });
    expect(ready.items).toHaveLength(1);
    expect(ready.counts.ready).toBe(1);

    const done = await readList(worker.socket, {
      ...READY,
      state: "done",
    });
    expect(done.items).toHaveLength(0);
    expect(done.recent).toHaveLength(0);
    expect(done.counts.ready).toBe(1);
    worker.close();
  });

  /**
   * One Mark done, and every screen re-reads: the orders index, another
   * order's page, a member on the task's team and a member on a team with
   * no work on the order. A publish names nothing, so the cost of a
   * connection that did not need it is one throttled re-read.
   */
  it("every connection receives every publish", async () => {
    const { shop, working, idle, runTaskId, alice, bob, carol } =
      await seedShopWithWork("runs-publish.myshopify.com");
    await seedOrder(shop, 2);
    const index = await openMerchantSocket(shop);
    await index.socket.call("listOrders", {
      limit: 50,
      cursor: null,
      q: null,
      show: null,
      team: null,
    });
    const otherOrder = await openMerchantSocket(shop);
    await otherOrder.socket.call("getOrderDetail", { legacyId: "2" });
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
    await readItems(teammate.socket);
    await readItems(elsewhere.socket);

    expect(await acting.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });

    for (const socket of [
      index.socket,
      otherOrder.socket,
      acting.socket,
      teammate.socket,
      elsewhere.socket,
    ]) {
      await receivedInvalidations(socket, 1);
      await receivesNoMore(socket, 1);
    }
    index.close();
    otherOrder.close();
    acting.close();
    teammate.close();
    elsewhere.close();
  });

  /**
   * The merchant's half. `merchantMarkTaskDone` carries no identity and no
   * `teamIds` — the order page has neither — yet lands on a task owned by a
   * team it is not on, and the worker watching that team receives the
   * invalidation over their own socket. The rules the merchant is still held to are
   * the repository's and are tested there; this is the wire.
   */
  it("completes a member's task over a merchant socket and publishes", async () => {
    const { shop, working, runTaskId, alice } = await seedShopWithWork(
      "runs-merchant.myshopify.com",
    );
    const worker = await openMemberSocket(shop, {
      memberId: alice,
      memberEmail: "alice@example.com",
      teamIds: [working.id],
    });
    await readItems(worker.socket);

    const merchant = await openMerchantSocket(shop);
    expect(await merchant.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });

    await worker.socket.waitForMessage(isInvalidated);
    expect(await readItems(worker.socket)).toHaveLength(0);
    merchant.close();
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
 * The rows of the sites table on `ShopAgent.publish` that the run verbs and
 * the configuration verbs own, each over the two screens of
 * `openTwoScreens`: the orders index, and a member on a team with no work,
 * who receives every publish all the same.
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
    // A second delete answers NotFound and still publishes: it nulls any
    // pointer to a team gone from D1 and reconciles, which the lists show.
    const again = await agent.deleteTeam({ teamId: idle.id });
    expect(again._tag).toBe("NotFound");
    await everyScreen(6);
    screens.close();
  });

  it("assigning a task's team publishes to every screen", async () => {
    const { shop, runTaskId, idle } = await seedShopWithWork(
      "sites-assign.myshopify.com",
    );
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop);

    expect(
      await agent.merchantAssignRunTaskTeam({ runTaskId, teamId: idle.id }),
    ).toEqual({ _tag: "Assigned" });

    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    screens.close();
  });

  it("Attach workflow publishes to every screen", async () => {
    const { shop, workflowId } = await seedShopWithWork(
      "sites-attach.myshopify.com",
    );
    await seedOrder(shop, 2);
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop);

    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/2",
      workflowId,
    });
    expect(attached._tag).toBe("Ok");

    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
    screens.close();
  });

  it("Cancel workflow publishes to every screen", async () => {
    const { shop, runId } = await seedShopWithWork(
      "sites-cancel.myshopify.com",
    );
    const agent = env.SHOP_AGENT.getByName(shop);
    const screens = await openTwoScreens(shop);

    expect(await agent.merchantCancelRun({ runId })).toEqual({ _tag: "Ok" });

    await receivedInvalidations(screens.merchant, 1);
    await receivedInvalidations(screens.member, 1);
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
