import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import type { ShopKey } from "../../src/domain/platform.ts";
import { type MemberCaller, ORDERS_KEY } from "../../src/contract/shop-actor.ts";
import * as ShopWork from "../../src/domain/shop-work.ts";
import { SEED_SHOP } from "../seed-shops.ts";
import { deliverWebhook } from "../shopify-webhook.ts";
import { mintSessionToken } from "../shopify-session-token.ts";
import {
  addToFixture,
  dev,
  email,
  integ,
  openAs,
  orderSyncAnswer,
  scriptGraphql,
  storeByWebhook,
  syncOrderAs,
} from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The runs service against a real Backend and actor, over forged sockets: reconcile on the
 * order write paths and after the definition writes, the run procedures and the gate in front
 * of them, the fixture's work on its runs, and the setup facts a run completes. Legacy
 * `shop-agent-workflows.test.ts`, `shop-agent-sync-order.test.ts`, `setup-facts.test.ts` and
 * `shop-agent-callables.test.ts` titles, unchanged. Every case starts from an empty
 * `SEED_SHOP` (this file's own stage); orders arrive as production gets them, by webhook or
 * Sync from Shopify with the fake answering, and each one is reconciled as it is stored, so an
 * order meant to be stored before a workflow matches it arrives before the workflow is on.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("runs"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const teamName = Schema.decodeUnknownSync(ShopWork.TeamName);
const teamId = Schema.decodeUnknownSync(ShopWork.TeamId);
const create = Schema.decodeUnknownSync(ShopWork.CreateWorkflowInput);
const addStep = Schema.decodeUnknownSync(ShopWork.AddStepInput);
const workflowIdInput = Schema.decodeUnknownSync(ShopWork.WorkflowIdInput);
const setState = Schema.decodeUnknownSync(ShopWork.SetWorkflowStateInput);
const retag = Schema.decodeUnknownSync(ShopWork.UpdateWorkflowTagInput);
const runNote = Schema.decodeUnknownSync(ShopWork.RunNote);
const blockReason = Schema.decodeUnknownSync(ShopWork.BlockReason);
const fixture = Schema.decodeUnknownSync(ShopFixtureData);

/** Empties `shop`: a load of an empty fixture, its D1 members and teams included. */
const reset = (shop: ShopKey) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) =>
      c.LoadFixture({ shop, fixture: { members: [], teams: [], workflows: [], orders: [] } }),
    );
  });

const orderGid = (n: number) => `gid://shopify/Order/${String(n)}`;
const lineItemGid = (n: number) => `gid://shopify/LineItem/${String(n)}`;

const aNode = (n: number, overrides: Partial<OrderNode> = {}): OrderNode => ({
  id: orderGid(n),
  legacyResourceId: String(n),
  name: `#${String(1000 + n)}`,
  processedAt: Date.now() - 86_400_000 + n,
  updatedAt: Date.now(),
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  ...overrides,
});

const aLineItemNode = (n: number, tags: ReadonlyArray<string>): LineItemNode => ({
  id: lineItemGid(n),
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  customAttributes: [],
  product: { tags: [...tags] },
});

/** Order `n` with one item carrying `tags`, stored by webhook (and reconciled as it is). */
const storeOrder = (
  n: number,
  tags: ReadonlyArray<string> = [],
  overrides: Partial<OrderNode> = {},
) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* storeByWebhook(backendUrl, SEED_SHOP, aNode(n, overrides), [aLineItemNode(n, tags)]);
  });

/**
 * A merchant's socket to `SEED_SHOP`, forged past the gate, open in the caller's scope. An HTTP
 * call goes first, so the file's first socket does not meet a cold workerd.
 */
const merchant = Effect.gen(function* () {
  const { backendUrl } = yield* stack;
  yield* integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP }));
  return yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
});

type Client = Effect.Success<typeof merchant>["client"];
type Socket = Effect.Success<typeof merchant>;

/** A member on `teamIds`, forged past the gate: the identity the member procedures read. */
const memberCaller = (
  memberId: string,
  teamIds: ReadonlyArray<string>,
  memberEmail = `${memberId}@runs.test`,
): MemberCaller => ({
  role: "member",
  memberId,
  memberEmail: email(memberEmail),
  teamIds: [...teamIds],
  userId: `user-${memberId}`,
  sessionId: `session-${memberId}-${String(teamIds.length)}`,
  sessionExpiresAt: Date.now() + 600_000,
});

const member = (memberId: string, teamIds: ReadonlyArray<string>, memberEmail?: string) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    return yield* openAs(backendUrl, SEED_SHOP, memberCaller(memberId, teamIds, memberEmail));
  });

/** A team of the shop, created through the merchant's own procedure. */
const team = (client: Client, name: string) => client.MerchantCreateTeam({ name: teamName(name) });

/** Creates a workflow, failing the test on any answer but `Ok`. */
const created = (client: Client, name: string, tag: string) =>
  Effect.flatMap(client.MerchantCreateWorkflow(create({ name, tag })), (result) =>
    result._tag === "Ok" ? Effect.succeed(result.workflow) : Effect.die(new Error(result._tag)),
  );

/** Apply the draft and turn the workflow on, the two writes a fresh workflow needs before it starts or attaches. */
const goLive = (client: Client, id: string) =>
  Effect.gen(function* () {
    const applied = yield* client.MerchantApplyDraft(workflowIdInput({ workflowId: id }));
    assert.strictEqual(applied._tag, "Ok");
    const on = yield* client.MerchantSetWorkflowState(
      setState({ workflowId: id, state: "active" }),
    );
    assert.strictEqual(on._tag, "Ok");
  });

/** A workflow with one step on `onTeam`, applied and on. */
const live = (client: Client, name: string, tag: string, onTeam: string) =>
  Effect.gen(function* () {
    const workflow = yield* created(client, name, tag);
    yield* client.MerchantAddStep(
      addStep({ workflowId: workflow.id, name: "Do it", teamId: onTeam }),
    );
    yield* goLive(client, workflow.id);
    return workflow;
  });

/** The runs on order `n`, with their tasks, as the order page reads them. */
const runsOn = (client: Client, n: number) =>
  client
    .MerchantGetOrderDetail({ legacyId: String(n) })
    .pipe(Effect.map((detail) => detail?.runs ?? []));

/** The four states whose rows the workflows list returns; Done or closed is read apart. */
const CURRENT_STATES = ["started_by_you", "ready", "started_by_others", "blocked"] as const;

/**
 * The current half of a member's workflows list, flattened in strip order: one read per state,
 * as the list reads one state at a time.
 */
const currentRows = (socket: Socket) =>
  Effect.gen(function* () {
    const rows: Array<ShopWork.RunListItem> = [];
    for (const state of CURRENT_STATES) {
      const list = yield* socket.client.MemberListRuns({
        query: { team: null, state, limit: ShopWork.RUN_PAGE, q: null },
      });
      rows.push(...list.items);
    }
    return rows;
  });

/** `count` notices on `received`, each naming `ORDERS_KEY`, then none for a moment. */
const noticedOnce = (received: Socket["received"]) =>
  Effect.gen(function* () {
    const notice = yield* PubSub.take(received).pipe(Effect.timeout("5 seconds"));
    assert.deepStrictEqual<unknown>(notice.invalidated, [ORDERS_KEY]);
    yield* Effect.sleep("500 millis");
    assert.strictEqual(yield* PubSub.remaining(received), 0, "no second notice");
  });

/** The GraphQL calls the fake answered since its log was last read. */
const graphqlCalls = Effect.gen(function* () {
  const { backendUrl } = yield* stack;
  return (yield* integ(backendUrl, (c) => c.ShopifyCalls({}))).filter(
    ({ route }) => route === "graphql",
  ).length;
});

/** Sync from Shopify on order `n`, the fake answering it with one item carrying `tags`. */
const syncFromShopify = (
  n: number,
  tags: ReadonlyArray<string>,
  overrides: Partial<OrderNode> = {},
) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* scriptGraphql(backendUrl, [
      orderSyncAnswer(aNode(n, overrides), [aLineItemNode(n, tags)]),
    ]);
    return yield* syncOrderAs(backendUrl, SEED_SHOP, orderGid(n));
  });

/** An `orders/edited` webhook for order `n` with no version, the fake answering it with `tags`. */
const editedWebhook = (n: number, tags: ReadonlyArray<string>, updatedAt: number) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* scriptGraphql(backendUrl, [
      orderSyncAnswer(aNode(n, { updatedAt }), [aLineItemNode(n, tags)]),
    ]);
    const status = yield* deliverWebhook(
      `${backendUrl}/webhooks/orders`,
      "orders/edited",
      SEED_SHOP,
      {
        id: 0,
        admin_graphql_api_id: orderGid(n),
        updated_at: null,
      },
    );
    assert.strictEqual(status, 200);
  });

/** `BackendApi.setupFacts` for `SEED_SHOP`, with a signed merchant token. */
const setupFacts = Effect.gen(function* () {
  const { backendUrl } = yield* stack;
  const sessionToken = yield* mintSessionToken({ shop: SEED_SHOP });
  return yield* integ(backendUrl, (c) => c.ApiSetupFacts({ sessionToken }));
});

/** A team with a member on it, through the merchant's procedures: the first setup fact. */
const teamWithMember = (client: Client, name: string) =>
  Effect.gen(function* () {
    const made = yield* team(client, name);
    const added = yield* client.MerchantAddMember({
      email: email(`${name.toLowerCase()}@runs.test`),
    });
    yield* client.MerchantAddTeamMembers({ teamId: made.id, memberIds: [added.id] });
    return made;
  });

test(
  "a webhook for an order whose item carries an active workflow's tag creates its run inside the upsert",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    yield* addToFixture(backendUrl, SEED_SHOP, {
      members: [email("engraver@e2e.test")],
      teams: [{ name: teamName("Engravers"), members: [email("engraver@e2e.test")] }],
      workflows: [
        fixture({
          members: [],
          teams: [{ name: "Engravers", members: [] }],
          workflows: [
            { name: "Engraving", tag: "engraved", tasks: [{ name: "Engrave", team: "Engravers" }] },
          ],
          orders: [],
        }).workflows[0]!,
      ],
    });
    yield* storeOrder(1, ["engraved"]);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const detail = yield* client.MerchantGetOrderDetail({ legacyId: "1" });
      assert.isNotNull(detail);
      assert.deepStrictEqual(
        detail?.runs.map(({ run }) => [run.workflowName, run.state]),
        [["Engraving", "open"]],
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "attachWorkflow validates the item and the workflow, then refuses a duplicate",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* created(client, "Engrave", "engrave");
      const attach = (lineItemId: string) =>
        client.MerchantAttachWorkflow({ lineItemId, workflowId: workflow.id });

      assert.strictEqual((yield* attach(lineItemGid(1)))._tag, "WorkflowNotEligible");
      yield* client.MerchantAddStep(
        addStep({ workflowId: workflow.id, name: "Engrave", teamId: engraving.id }),
      );
      // A draft is not attachable; neither is an applied but inactive workflow.
      assert.strictEqual((yield* attach(lineItemGid(1)))._tag, "WorkflowNotEligible");
      const applied = yield* client.MerchantApplyDraft(
        workflowIdInput({ workflowId: workflow.id }),
      );
      assert.strictEqual(applied._tag, "Ok");
      assert.strictEqual((yield* attach(lineItemGid(1)))._tag, "WorkflowNotEligible");
      yield* client.MerchantSetWorkflowState(
        setState({ workflowId: workflow.id, state: "active" }),
      );

      assert.strictEqual((yield* attach("nope"))._tag, "LineItemNotFound");

      const attached = yield* attach(lineItemGid(1));
      if (attached._tag !== "Ok") return assert.fail(attached._tag);
      assert.strictEqual(attached.run.orderName, "#1001");
      assert.strictEqual(attached.replaced, null);

      assert.strictEqual((yield* attach(lineItemGid(1)))._tag, "AlreadyExists");

      assert.deepStrictEqual(
        (yield* runsOn(client, 1)).map((d) => [d.run.id, d.tasks.length]),
        [[attached.run.id, 1]],
      );
      // Delete while active and with a run: no refusal, and the run stays on the order with
      // its snapshots. Re-attaching the deleted workflow cannot create anything, because the
      // definition is gone.
      assert.deepStrictEqual(
        yield* client.MerchantDeleteWorkflow(workflowIdInput({ workflowId: workflow.id })),
        { _tag: "Deleted" },
      );
      assert.deepStrictEqual(
        (yield* runsOn(client, 1)).map((d) => [d.run.id, d.run.workflowName, d.tasks.length]),
        [[attached.run.id, attached.run.workflowName, 1]],
      );
      assert.strictEqual((yield* attach(lineItemGid(1)))._tag, "WorkflowNotEligible");
    }).pipe(Effect.scoped);
  }),
);

test(
  "manual attach is refused on a cancelled or fulfilled order and allowed on an unpaid one",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1, [], { cancelledAt: Date.now() });
    yield* storeOrder(2, [], { displayFulfillmentStatus: "FULFILLED" });
    yield* storeOrder(3, [], { fullyPaid: false });
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* live(client, "Engrave", "engrave", engraving.id);
      const attach = (n: number) =>
        client.MerchantAttachWorkflow({ lineItemId: lineItemGid(n), workflowId: workflow.id });
      assert.strictEqual((yield* attach(1))._tag, "OrderClosed");
      assert.strictEqual((yield* attach(2))._tag, "OrderClosed");
      // Unpaid is the merchant's judgement to make: work may start on a deposit, which is
      // exactly what automatic starts withhold.
      assert.strictEqual((yield* attach(3))._tag, "Ok");
    }).pipe(Effect.scoped);
  }),
);

test(
  "merchantAttachWorkflow over an open run deletes it and names it as replaced; over a cancelled item it starts fresh, even the same workflow",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const first = yield* live(client, "Engraving", "engraving", engraving.id);
      const second = yield* live(client, "Rush", "rush", engraving.id);
      const attach = (workflowId: string) =>
        client.MerchantAttachWorkflow({ lineItemId: lineItemGid(1), workflowId });

      const attached = yield* attach(first.id);
      if (attached._tag !== "Ok") return assert.fail(attached._tag);
      const replaced = yield* attach(second.id);
      if (replaced._tag !== "Ok") return assert.fail(replaced._tag);
      assert.strictEqual(replaced.replaced?.id, attached.run.id);
      assert.strictEqual(replaced.replaced?.workflowName, "Engraving");
      assert.strictEqual(replaced.run.workflowName, "Rush");

      // The replaced run is gone, not kept beside the new one.
      assert.deepStrictEqual(
        (yield* runsOn(client, 1)).map(({ run }) => run.id),
        [replaced.run.id],
      );

      assert.deepStrictEqual(yield* client.MerchantCancelRun({ runId: replaced.run.id }), {
        _tag: "Ok",
      });
      // Rush again, the workflow just cancelled: a fresh run over the closed one.
      const again = yield* attach(second.id);
      if (again._tag !== "Ok") return assert.fail(again._tag);
      assert.strictEqual(again.replaced, null);
      assert.strictEqual(again.run.state, "open");
      assert.notStrictEqual(again.run.id, replaced.run.id);
    }).pipe(Effect.scoped);
  }),
);

test(
  "turning one of two matching workflows off creates the survivor's run",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      // Both on *before* the order exists, so the first reconcile it ever sees already has two
      // matches to choose between.
      const keeper = yield* live(client, "Engraving", "engraved", engraving.id);
      const rival = yield* live(client, "Rush", "rush", engraving.id);
      yield* storeOrder(1, ["engraved", "rush"]);

      // Turn on again reconciles every stored order; the multi-match holds.
      const nudged = yield* client.MerchantSetWorkflowState(
        setState({ workflowId: keeper.id, state: "active" }),
      );
      assert.strictEqual(nudged._tag, "Ok");
      assert.lengthOf(yield* runsOn(client, 1), 0);

      const off = yield* client.MerchantSetWorkflowState(
        setState({ workflowId: rival.id, state: "inactive" }),
      );
      assert.strictEqual(off._tag, "Ok");
      assert.deepStrictEqual(
        (yield* runsOn(client, 1)).map((d) => d.run.workflowId),
        [keeper.id],
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "deleting one of two matching workflows creates the survivor's run",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const keeper = yield* live(client, "Engraving", "engraved", engraving.id);
      const rival = yield* live(client, "Rush", "rush", engraving.id);
      yield* storeOrder(1, ["engraved", "rush"]);
      yield* client.MerchantSetWorkflowState(setState({ workflowId: keeper.id, state: "active" }));
      assert.lengthOf(yield* runsOn(client, 1), 0);

      assert.deepStrictEqual(
        yield* client.MerchantDeleteWorkflow(workflowIdInput({ workflowId: rival.id })),
        { _tag: "Deleted" },
      );
      assert.deepStrictEqual(
        (yield* runsOn(client, 1)).map((d) => d.run.workflowId),
        [keeper.id],
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "an active workflow deletes, and its runs carry on",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* live(client, "Engraving", "engraved", engraving.id);
      yield* storeOrder(1, ["engraved"]);
      yield* client.MerchantSetWorkflowState(
        setState({ workflowId: workflow.id, state: "active" }),
      );
      const [before] = yield* runsOn(client, 1);
      assert.strictEqual(before?.run.state, "open");

      assert.deepStrictEqual(
        yield* client.MerchantDeleteWorkflow(workflowIdInput({ workflowId: workflow.id })),
        { _tag: "Deleted" },
      );
      const [after] = yield* runsOn(client, 1);
      // The run copied its definition: it keeps its state, its tasks and the workflow's name,
      // with no workflow left to read them from.
      assert.strictEqual(after?.run.id, before?.run.id);
      assert.strictEqual(after?.run.state, "open");
      assert.strictEqual(after?.run.workflowName, "Engraving");
      assert.deepStrictEqual(
        after?.tasks.map((task) => task.name),
        ["Do it"],
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "every order in a pass sees the same eligible snapshot",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* created(client, "Engraving", "engraved");
      yield* client.MerchantAddStep(
        addStep({ workflowId: workflow.id, name: "Do it", teamId: engraving.id }),
      );
      // Applied but not on: the two orders below are stored with no match, so the Turn on's
      // reconcile all is the first pass to see them.
      const applied = yield* client.MerchantApplyDraft(
        workflowIdInput({ workflowId: workflow.id }),
      );
      assert.strictEqual(applied._tag, "Ok");
      yield* storeOrder(1, ["engraved"]);
      yield* storeOrder(2, ["engraved"]);
      assert.lengthOf(yield* runsOn(client, 1), 0);
      assert.lengthOf(yield* runsOn(client, 2), 0);
      // One pass over both orders, under the one teams read it took before its first order.
      yield* client.MerchantSetWorkflowState(
        setState({ workflowId: workflow.id, state: "active" }),
      );
      for (const n of [1, 2]) assert.lengthOf(yield* runsOn(client, n), 1);
    }).pipe(Effect.scoped);
  }),
);

test(
  "no reconcile count reaches a screen",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* created(client, "Engraving", "engraved");
      yield* client.MerchantAddStep(
        addStep({ workflowId: workflow.id, name: "Do it", teamId: engraving.id }),
      );
      yield* storeOrder(1, ["engraved"]);
      // Both writes reconcile all and create a run; what they hand the screen is the workflow
      // and nothing a pass counted.
      const applied = yield* client.MerchantApplyDraft(
        workflowIdInput({ workflowId: workflow.id }),
      );
      assert.strictEqual(applied._tag, "Ok");
      assert.deepStrictEqual(Object.keys(applied).toSorted(), ["_tag", "workflow"]);
      const on = yield* client.MerchantSetWorkflowState(
        setState({ workflowId: workflow.id, state: "active" }),
      );
      assert.strictEqual(on._tag, "Ok");
      assert.deepStrictEqual(Object.keys(on).toSorted(), ["_tag", "workflow"]);
      assert.lengthOf(yield* runsOn(client, 1), 1);
    }).pipe(Effect.scoped);
  }),
);

test(
  "deleting a team creates the survivor's run on an item two workflows had matched",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const kept = yield* team(client, "Engraving");
      const gone = yield* team(client, "Rush");
      const keeper = yield* live(client, "Engraving", "engraved", kept.id);
      yield* live(client, "Rush", "rush", gone.id);
      yield* storeOrder(1, ["engraved", "rush"]);
      assert.lengthOf(yield* runsOn(client, 1), 0);

      assert.deepStrictEqual(yield* client.MerchantDeleteTeam({ teamId: gone.id }), {
        _tag: "Deleted",
      });
      assert.deepStrictEqual(
        (yield* runsOn(client, 1)).map((d) => d.run.workflowId),
        [keeper.id],
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "retagging an active workflow reconciles stored orders against the new tag",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* live(client, "Engraving", "engraved", engraving.id);
      // Carrying a tag no workflow has yet.
      yield* storeOrder(1, ["laser"]);
      assert.lengthOf(yield* runsOn(client, 1), 0);

      // The retag is the definition write that makes the item match; the stored order starts
      // now rather than on Shopify's next edit.
      const retagged = yield* client.MerchantUpdateWorkflowTag(
        retag({ workflowId: workflow.id, tag: "laser" }),
      );
      assert.strictEqual(retagged._tag, "Ok");
      assert.deepStrictEqual(
        (yield* runsOn(client, 1)).map((d) => d.run.workflowId),
        [workflow.id],
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "merchantCancelRun / memberMarkTaskDone map refusals to results",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* live(client, "Engrave", "engrave", engraving.id);
      const attached = yield* client.MerchantAttachWorkflow({
        lineItemId: lineItemGid(1),
        workflowId: workflow.id,
      });
      if (attached._tag !== "Ok") return assert.fail(attached._tag);
      const runId = attached.run.id;

      assert.deepStrictEqual(yield* client.MerchantCancelRun({ runId: "nope" }), {
        _tag: "NotFound",
      });

      const [detail] = yield* runsOn(client, 1);
      const runTaskId = detail?.tasks[0]?.id ?? "";
      const stranger = yield* member("m1", ["x"]);
      assert.deepStrictEqual(yield* stranger.client.MemberMarkTaskDone({ runTaskId }), {
        _tag: "NotAllowed",
      });
      const engraver = yield* member("m1", [engraving.id]);
      assert.lengthOf(yield* currentRows(engraver), 1);
      assert.deepStrictEqual(yield* engraver.client.MemberMarkTaskDone({ runTaskId }), {
        _tag: "Ok",
      });
      assert.lengthOf(yield* currentRows(engraver), 0);
      // A done run offers no Cancel (`runActions`), and has no block to lift.
      assert.deepStrictEqual(yield* client.MerchantCancelRun({ runId }), { _tag: "NotAllowed" });
      assert.deepStrictEqual(yield* engraver.client.MemberUnblockRun({ runId }), {
        _tag: "NotAllowed",
      });
      // Reopened, it is open again and cancels once; the closed run left behind offers no
      // second Cancel.
      assert.deepStrictEqual(yield* client.MerchantReopenTask({ runTaskId }), { _tag: "Ok" });
      assert.deepStrictEqual(yield* client.MerchantCancelRun({ runId }), { _tag: "Ok" });
      assert.deepStrictEqual(yield* client.MerchantCancelRun({ runId }), { _tag: "NotAllowed" });
    }).pipe(Effect.scoped);
  }),
);

test(
  "unblock lifts a block for the team that holds a current task or the merchant, and is refused once nothing is blocked",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* live(client, "Engrave", "engrave", engraving.id);
      const attached = yield* client.MerchantAttachWorkflow({
        lineItemId: lineItemGid(1),
        workflowId: workflow.id,
      });
      if (attached._tag !== "Ok") return assert.fail(attached._tag);
      const runId = attached.run.id;
      const engraver = yield* member("m1", [engraving.id]);
      const stranger = yield* member("m2", ["x"]);
      // Nothing is blocked yet: Unblock is not offered (`runActions`).
      assert.deepStrictEqual(yield* engraver.client.MemberUnblockRun({ runId }), {
        _tag: "NotAllowed",
      });
      assert.deepStrictEqual(
        yield* engraver.client.MemberBlockRun({ runId, reason: blockReason("no stock") }),
        { _tag: "Ok" },
      );
      assert.deepStrictEqual(yield* stranger.client.MemberUnblockRun({ runId }), {
        _tag: "NotAllowed",
      });
      assert.deepStrictEqual(yield* engraver.client.MemberUnblockRun({ runId }), { _tag: "Ok" });
      const [unblocked] = yield* currentRows(engraver);
      assert.strictEqual(unblocked?.run.blockedAt, null);
      assert.strictEqual(unblocked?.run.blockReason, null);
      assert.strictEqual(unblocked?.run.blockedBy, null);
      assert.deepStrictEqual(yield* engraver.client.MemberBlockRun({ runId, reason: null }), {
        _tag: "Ok",
      });
      assert.deepStrictEqual(yield* client.MerchantUnblockRun({ runId }), { _tag: "Ok" });
      assert.deepStrictEqual(yield* client.MerchantUnblockRun({ runId }), { _tag: "NotAllowed" });
    }).pipe(Effect.scoped);
  }),
);

test(
  "startTask / setRunNote / blockRun refuse another team's work; listRuns reads startedByEmail after the member is deleted",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1);
    const memberEmail = "w@example.com";
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const { id: memberId } = yield* client.MerchantAddMember({ email: email(memberEmail) });
      const workflow = yield* live(client, "Engrave", "engrave", engraving.id);
      const attached = yield* client.MerchantAttachWorkflow({
        lineItemId: lineItemGid(1),
        workflowId: workflow.id,
      });
      if (attached._tag !== "Ok") return assert.fail(attached._tag);
      const runId = attached.run.id;
      const [detail] = yield* runsOn(client, 1);
      const runTaskId = detail?.tasks[0]?.id ?? "";

      const outsider = yield* member(memberId, ["x"], memberEmail);
      assert.deepStrictEqual(yield* outsider.client.MemberStartTask({ runTaskId }), {
        _tag: "NotAllowed",
      });
      assert.deepStrictEqual(
        yield* outsider.client.MemberSetRunNote({ runId, note: runNote("hi") }),
        { _tag: "NotAllowed" },
      );
      assert.deepStrictEqual(yield* outsider.client.MemberBlockRun({ runId, reason: null }), {
        _tag: "NotAllowed",
      });

      const engraver = yield* member(memberId, [engraving.id], memberEmail);
      assert.deepStrictEqual(yield* engraver.client.MemberStartTask({ runTaskId }), {
        _tag: "Ok",
      });
      // Their own started task, so it is Started by you for them — which is the state the
      // snapshotted email has to survive the delete in.
      const startedByYou = (socket: Socket) =>
        socket.client
          .MemberListRuns({
            query: { team: null, state: "started_by_you", limit: ShopWork.RUN_PAGE, q: null },
          })
          .pipe(Effect.map(({ items }) => items));
      const [item] = yield* startedByYou(engraver);
      assert.strictEqual(item?.run.state, "open");
      assert.strictEqual(item?.tasks[0]?.startedByEmail, memberEmail);
      assert.strictEqual(item?.stepCount, 1);
      // startedByEmail is a snapshot: it survives the member's delete. The delete closes the
      // member's sockets, so the reads after it are on a socket opened again as them.
      yield* client.MerchantDeleteMember({ email: email(memberEmail) });
      const after = yield* member(memberId, [engraving.id], memberEmail);
      const [deletedItem] = yield* startedByYou(after);
      assert.strictEqual(deletedItem?.tasks[0]?.startedByEmail, memberEmail);
      assert.deepStrictEqual(
        yield* after.client.MemberSetRunNote({ runId, note: runNote(" spelling confirmed ") }),
        { _tag: "Ok" },
      );
      assert.deepStrictEqual(
        yield* after.client.MemberBlockRun({ runId, reason: blockReason("waiting on stock") }),
        { _tag: "Ok" },
      );
      const [blocked] = yield* currentRows(after);
      assert.isTrue(blocked !== undefined && ShopWork.runIsBlocked(blocked.run));
      assert.strictEqual(blocked?.run.blockReason, "waiting on stock");
      assert.deepStrictEqual<unknown>(blocked?.run.blockedBy, {
        role: "member",
        email: memberEmail,
      });
      assert.strictEqual(blocked?.run.note, "spelling confirmed");
    }).pipe(Effect.scoped);
  }),
);

test(
  "assignRunTaskTeam puts an unassigned open task on the new team's list; the order page lists the teams",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const a = yield* team(client, "A");
      const workflow = yield* live(client, "W", "w", a.id);
      const attached = yield* client.MerchantAttachWorkflow({
        lineItemId: lineItemGid(1),
        workflowId: workflow.id,
      });
      if (attached._tag !== "Ok") return assert.fail(attached._tag);
      const [detail] = yield* runsOn(client, 1);
      const runTaskId = detail?.tasks[0]?.id ?? "";

      yield* client.MerchantDeleteTeam({ teamId: a.id });
      assert.deepStrictEqual(yield* currentRows(yield* member("a1", [a.id])), []);
      const page = yield* client.MerchantGetOrderDetail({ legacyId: "1" });
      assert.strictEqual(page?.runs[0]?.tasks[0]?.teamId, null);
      assert.deepStrictEqual(page?.teams, []);
      // Durable Object SQLite keeps the nulled pointer through the Show counts' facts.
      const issues = { limit: 25, cursor: null, q: null, show: "issues", team: null } as const;
      const stuck = yield* client.MerchantListOrders(issues);
      assert.strictEqual(stuck.page.counts.issues, 1, "a task on no team is an issue");
      assert.deepStrictEqual(
        stuck.page.orders.map(({ unassigned }) => unassigned),
        [true],
      );

      assert.deepStrictEqual(yield* client.MerchantAssignRunTaskTeam({ runTaskId, teamId: a.id }), {
        _tag: "TeamNotFound",
      });
      const b = yield* team(client, "B");
      assert.deepStrictEqual(yield* client.MerchantAssignRunTaskTeam({ runTaskId, teamId: b.id }), {
        _tag: "Assigned",
      });
      const assigned = yield* client.MerchantListOrders(issues);
      assert.strictEqual(assigned.page.counts.issues, 0, "the assigned task is no issue");
      const [item] = yield* currentRows(yield* member("b0", [b.id]));
      assert.strictEqual(item?.tasks[0]?.id, runTaskId);
      assert.strictEqual(item?.tasks[0]?.teamName, "B");
      const after = yield* client.MerchantGetOrderDetail({ legacyId: "1" });
      assert.deepStrictEqual(
        after?.teams.map((t) => t.name),
        ["B"],
      );
      // A *started* task can be assigned too: only teamId/teamName move, so history keeps
      // whoever began it and the new team takes it to done.
      const inB = yield* member("m1", [b.id], "m1@example.com");
      assert.deepStrictEqual(yield* inB.client.MemberStartTask({ runTaskId }), { _tag: "Ok" });
      const c = yield* team(client, "C");
      assert.deepStrictEqual(yield* client.MerchantAssignRunTaskTeam({ runTaskId, teamId: c.id }), {
        _tag: "Assigned",
      });
      assert.deepStrictEqual(yield* currentRows(inB), []);
      const inC = yield* member("m2", [c.id], "m2@example.com");
      const [moved] = yield* currentRows(inC);
      assert.strictEqual(moved?.tasks[0]?.id, runTaskId);
      assert.strictEqual(moved?.tasks[0]?.teamName, "C");
      assert.strictEqual(moved?.tasks[0]?.startedByEmail, "m1@example.com");
      assert.isTrue(moved?.tasks[0]?.startedAt !== null);

      assert.deepStrictEqual(yield* inC.client.MemberMarkTaskDone({ runTaskId }), { _tag: "Ok" });
      const finished = yield* client.MerchantGetOrderDetail({ legacyId: "1" });
      assert.strictEqual(finished?.runs[0]?.tasks[0]?.doneByEmail, "m2@example.com");
      assert.strictEqual(finished?.runs[0]?.tasks[0]?.startedByEmail, "m1@example.com");
      // A done task keeps its team: `taskActions`' `assign` is false, so the action set refuses
      // before the repository's own guard.
      assert.deepStrictEqual(yield* client.MerchantAssignRunTaskTeam({ runTaskId, teamId: c.id }), {
        _tag: "NotAllowed",
      });
      assert.deepStrictEqual(
        yield* client.MerchantAssignRunTaskTeam({ runTaskId: "nope", teamId: b.id }),
        { _tag: "NotFound" },
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "the one-order sync stores the order and creates its run",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      const workflow = yield* live(client, "Engraving", "engraved", engraving.id);

      assert.deepStrictEqual(yield* syncFromShopify(1, ["engraved"]), { _tag: "Stored" });
      assert.strictEqual(yield* graphqlCalls, 1);
      const first = yield* runsOn(client, 1);
      assert.lengthOf(first, 1);
      assert.strictEqual(first[0]?.run.workflowId, workflow.id);

      // A second click fetches again and creates nothing: the item holds its run.
      yield* syncFromShopify(1, ["engraved"]);
      assert.strictEqual(yield* graphqlCalls, 1);
      const second = yield* runsOn(client, 1);
      assert.lengthOf(second, 1);
      assert.strictEqual(second[0]?.run.id, first[0]?.run.id);
    }).pipe(Effect.scoped);
  }),
);

test(
  "a webhook on the same version whose reconcile creates a run publishes",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    const version = Date.parse("2026-09-02T12:00:00.000Z");
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      yield* live(client, "Engraving", "engraved", engraving.id);
      yield* editedWebhook(1, ["plain"], version);
      assert.lengthOf(yield* runsOn(client, 1), 0);
      const screens = {
        merchant: yield* merchant,
        member: yield* member("screen", [engraving.id]),
      };
      // The same version, but the item now carries the workflow's tag: the row does not move
      // and the reconcile creates the run. Gating on `written` alone would publish here too;
      // gating on the row alone would not.
      yield* editedWebhook(1, ["engraved"], version);
      assert.lengthOf(yield* runsOn(client, 1), 1);
      yield* noticedOnce(screens.merchant.received);
      yield* noticedOnce(screens.member.received);
    }).pipe(Effect.scoped);
  }),
);

test(
  "a product retagged in Shopify changes nothing until its order syncs again",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      yield* live(client, "Engraving", "engraved", engraving.id);
      yield* syncFromShopify(1, ["plain"]);
      assert.lengthOf(yield* runsOn(client, 1), 0);
      // Retagged in Shopify: the stored item keeps the tags it was synced with, so nothing
      // Baton does in between sees the new tag.
      const { backendUrl } = yield* stack;
      yield* scriptGraphql(backendUrl, [
        orderSyncAnswer(aNode(1), [aLineItemNode(1, ["engraved"])]),
      ]);
      assert.lengthOf(yield* runsOn(client, 1), 0);
      yield* syncFromShopify(1, ["engraved"]);
      assert.lengthOf(yield* runsOn(client, 1), 1);
    }).pipe(Effect.scoped);
  }),
);

test(
  "an item's product tags are rewritten by the next sync and a run created from the old tags is not revisited",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* team(client, "Engraving");
      yield* live(client, "Engraving", "engraved", engraving.id);
      yield* syncFromShopify(1, ["engraved"]);
      const [made] = yield* runsOn(client, 1);
      assert.strictEqual(made?.run.state, "open");
      yield* syncFromShopify(1, ["plain"]);
      const stored = yield* integ(backendUrl, (c) =>
        c.GetOrder({ shop: SEED_SHOP, orderId: orderGid(1) }),
      );
      assert.deepStrictEqual(stored?.lineItems[0]?.productTags, ["plain"]);
      // The item no longer carries the workflow's tag; its run stays, open.
      assert.deepStrictEqual(
        (yield* runsOn(client, 1)).map(({ run }) => [run.id, run.state]),
        [[made?.run.id, "open"]],
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "each step is undone on an empty shop and done once its fact holds",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    assert.deepStrictEqual(yield* setupFacts, {
      teamWithMember: false,
      activeWorkflow: false,
      run: false,
    });
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* teamWithMember(client, "Engraving");
      assert.deepStrictEqual(yield* setupFacts, {
        teamWithMember: true,
        activeWorkflow: false,
        run: false,
      });
      const workflow = yield* live(client, "Engrave", "engrave", engraving.id);
      assert.deepStrictEqual(yield* setupFacts, {
        teamWithMember: true,
        activeWorkflow: true,
        run: false,
      });
      yield* storeOrder(1);
      const attached = yield* client.MerchantAttachWorkflow({
        lineItemId: lineItemGid(1),
        workflowId: workflow.id,
      });
      assert.strictEqual(attached._tag, "Ok");
      const facts = yield* setupFacts;
      assert.deepStrictEqual(facts, { teamWithMember: true, activeWorkflow: true, run: true });
      for (const fact of ShopWork.SETUP_FACTS) assert.isTrue(ShopWork.setupFactHolds(facts, fact));
    }).pipe(Effect.scoped);
  }),
);

/** Every fact holding: a team with a member, an active workflow on it, and a run. */
const completeSetup = (client: Client) =>
  Effect.gen(function* () {
    const engraving = yield* teamWithMember(client, "Engraving");
    const workflow = yield* live(client, "Engrave", "engrave", engraving.id);
    yield* storeOrder(1);
    const attached = yield* client.MerchantAttachWorkflow({
      lineItemId: lineItemGid(1),
      workflowId: workflow.id,
    });
    if (attached._tag !== "Ok") return yield* Effect.die(new Error(attached._tag));
    return { workflowId: workflow.id, runId: attached.run.id, teamId: engraving.id };
  });

test(
  "the guide hides when all three hold",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const engraving = yield* teamWithMember(client, "Engraving");
      const workflow = yield* live(client, "Engrave", "engrave", engraving.id);
      assert.isFalse(ShopWork.setupIsComplete(yield* setupFacts));
      yield* storeOrder(1);
      yield* client.MerchantAttachWorkflow({ lineItemId: lineItemGid(1), workflowId: workflow.id });
      assert.isTrue(ShopWork.setupIsComplete(yield* setupFacts));
    }).pipe(Effect.scoped);
  }),
);

test(
  "the guide shows again when a fact stops holding",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const { workflowId } = yield* completeSetup(client);
      assert.isTrue(ShopWork.setupIsComplete(yield* setupFacts));
      const off = yield* client.MerchantSetWorkflowState(
        setState({ workflowId, state: "inactive" }),
      );
      assert.strictEqual(off._tag, "Ok");
      const facts = yield* setupFacts;
      assert.isFalse(ShopWork.setupFactHolds(facts, "activeWorkflow"));
      assert.isFalse(ShopWork.setupIsComplete(facts));
    }).pipe(Effect.scoped);
  }),
);

test(
  "an item with a workflow in any state completes the third step",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const { runId } = yield* completeSetup(client);
      assert.deepStrictEqual(yield* client.MerchantCancelRun({ runId }), { _tag: "Ok" });
      assert.isTrue(ShopWork.setupFactHolds(yield* setupFacts, "run"));
    }).pipe(Effect.scoped);
  }),
);

test(
  "the seed publishes once to every screen",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const screens = {
        merchant: yield* merchant,
        member: yield* member("screen", [teamId("no-team")]),
      };
      // A socket is open once a call has gone over it.
      yield* screens.merchant.client.MerchantWhoAmI();
      yield* screens.member.client.MemberWhoAmI();
      yield* addToFixture(
        backendUrl,
        SEED_SHOP,
        fixture({
          members: ["seed-publish@runs.test"],
          teams: [{ name: "Seed publish", members: ["seed-publish@runs.test"] }],
          workflows: [
            {
              name: "Seed publish",
              tag: "seed-publish",
              tasks: [
                { name: "Make", team: "Seed publish" },
                { name: "Pack", team: "Seed publish" },
              ],
            },
          ],
          orders: [
            {
              n: 7001,
              lineItems: [
                { title: "Ring", quantity: 1, tags: ["seed-publish"], progress: { advance: 1 } },
              ],
            },
            {
              n: 7002,
              lineItems: [
                {
                  title: "Mug",
                  quantity: 1,
                  tags: ["seed-publish"],
                  progress: { started: true, by: "seed-publish@runs.test" },
                },
              ],
            },
          ],
        }),
      );
      yield* noticedOnce(screens.merchant.received);
      yield* noticedOnce(screens.member.received);
    }).pipe(Effect.scoped);
  }),
);

/** A run on order 1 with one task, for the role refusals' payloads. */
const oneRun = (client: Client) =>
  Effect.gen(function* () {
    const engraving = yield* team(client, "Engraving");
    const workflow = yield* live(client, "Engrave", "engrave", engraving.id);
    const attached = yield* client.MerchantAttachWorkflow({
      lineItemId: lineItemGid(1),
      workflowId: workflow.id,
    });
    if (attached._tag !== "Ok") return yield* Effect.die(new Error(attached._tag));
    const [detail] = yield* runsOn(client, 1);
    return {
      runId: attached.run.id,
      runTaskId: detail?.tasks[0]?.id ?? "",
      teamId: engraving.id,
      workflowId: workflow.id,
    };
  });

test(
  "refuses every merchant callable on a member connection",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const { runId, runTaskId, teamId: onTeam, workflowId } = yield* oneRun(client);
      const { client: forged } = yield* member("m1", [onTeam]);
      const calls: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        forged.MerchantListOrders({ limit: 25, cursor: null, q: null, show: "all", team: null }),
        forged.MerchantGetOrderDetail({ legacyId: "1" }),
        forged.MerchantAttachWorkflow({ lineItemId: lineItemGid(1), workflowId }),
        forged.MerchantCancelRun({ runId }),
        forged.MerchantMarkTaskDone({ runTaskId }),
        forged.MerchantReopenTask({ runTaskId }),
        forged.MerchantPutBackTask({ runTaskId }),
        forged.MerchantSetRunNote({ runId, note: null }),
        forged.MerchantBlockRun({ runId, reason: null }),
        forged.MerchantUnblockRun({ runId }),
        forged.MerchantAssignRunTaskTeam({ runTaskId, teamId: onTeam }),
      ];
      for (const call of calls) assert.strictEqual((yield* Effect.flip(call))._tag, "Forbidden");
      // Nothing was written: the run is still open, unblocked and unnoted.
      const [detail] = yield* runsOn(client, 1);
      assert.strictEqual(detail?.run.state, "open");
      assert.strictEqual(detail?.run.blockedAt, null);
      assert.strictEqual(detail?.tasks[0]?.doneAt, null);
    }).pipe(Effect.scoped);
  }),
);

test(
  "refuses every member callable on a merchant connection",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* storeOrder(1);
    yield* Effect.gen(function* () {
      const { client } = yield* merchant;
      const { runId, runTaskId } = yield* oneRun(client);
      const calls: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
        client.MemberListRuns({
          query: { team: null, state: "ready", limit: ShopWork.RUN_PAGE, q: null },
        }),
        client.MemberGetRun({ runId }),
        client.MemberStartTask({ runTaskId }),
        client.MemberMarkTaskDone({ runTaskId }),
        client.MemberReopenTask({ runTaskId }),
        client.MemberPutBackTask({ runTaskId }),
        client.MemberSetRunNote({ runId, note: null }),
        client.MemberBlockRun({ runId, reason: null }),
        client.MemberUnblockRun({ runId }),
      ];
      for (const call of calls) assert.strictEqual((yield* Effect.flip(call))._tag, "Forbidden");
      const [detail] = yield* runsOn(client, 1);
      assert.strictEqual(detail?.tasks[0]?.startedAt, null);
      assert.strictEqual(detail?.run.blockedAt, null);
    }).pipe(Effect.scoped);
  }),
);
