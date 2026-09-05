import { SqliteClient } from "@effect/sql-sqlite-do";
import { strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { runShopAgentMigrations } from "@/lib/ShopAgent";

const layer = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

const shopOf = Schema.decodeUnknownSync(Domain.Shop);
const teamName = Schema.decodeUnknownSync(Domain.TeamName);

const seedTeam = (shop: string, name: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* Repository;
      yield* repo.upsertShopSession({
        shop: shopOf(shop),
        shopGid: Schema.decodeUnknownSync(Domain.ShopGid)(
          "gid://shopify/Shop/1",
        ),
        shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)(
          `agent-${shop}`,
        ),
        scope: null,
        accessTokenExpiresAt: null,
        accessToken: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
      });
      return yield* repo.createTeam({
        shop: shopOf(shop),
        name: teamName(name),
      });
    }).pipe(Effect.provide(layer)),
  );

const isArchived = async (shop: string, teamId: string) => {
  const teams = await Effect.runPromise(
    Repository.pipe(
      Effect.flatMap((repo) =>
        repo.listTeams({ shop: shopOf(shop), includeArchived: true }),
      ),
      Effect.provide(layer),
    ),
  );
  return teams.find((t) => t.id === teamId)?.archivedAt !== null;
};

afterEach(async () => {
  await env.D1.exec("delete from TeamMember");
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from ShopSession");
});

/**
 * Every shop name is unique per test: a Durable Object keeps its SQLite across
 * tests in the same worker, so sharing a shop would leak workflows between cases.
 */
describe("ShopAgent workflow callables", () => {
  it("addStep refuses an unknown or archived team, accepts an active one", async () => {
    const shop = "wf-team-check.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engrave",
      tags: ["Engraving"],
    });
    expect(created._tag).toBe("Ok");
    if (created._tag !== "Ok") return;
    expect(created.workflow.tags).toEqual(["engraving"]);

    const unknown = await agent.addStep({
      workflowId: created.workflow.id,
      name: "Engrave",
      teamId: "nope",
    });
    strictEqual(unknown._tag, "TeamNotActive");

    const ok = await agent.addStep({
      workflowId: created.workflow.id,
      name: "Engrave",
      teamId: team.id,
    });
    strictEqual(ok._tag, "Ok");

    const detail = await agent.getWorkflowDetail({
      workflowId: created.workflow.id,
    });
    expect(detail?.steps.map((s) => s.teamName)).toEqual(["Engraving"]);
    expect(detail?.activeTeams.map((t) => t.id)).toEqual([team.id]);
  });

  it("archiveTeam refuses while steps point at the team, succeeds after reassignment", async () => {
    const shop = "wf-archive-guard.myshopify.com";
    const a = await seedTeam(shop, "A");
    const b = await seedTeam(shop, "B");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tags: [] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const step = await agent.addStep({
      workflowId: created.workflow.id,
      name: "S",
      teamId: a.id,
    });
    if (step._tag !== "Ok" || step.step === null) throw new Error(step._tag);

    const refused = await agent.archiveTeam({ teamId: a.id });
    expect(refused).toEqual({ _tag: "InUse", count: 1 });
    strictEqual(await isArchived(shop, a.id), false);

    const owned = await agent.listStepsOwnedBy({ teamId: a.id });
    expect(owned.map((o) => [o.workflowName, o.stepName])).toEqual([
      ["W", "S"],
    ]);

    const moved = await agent.updateStep({
      stepId: step.step.id,
      name: "S",
      teamId: b.id,
      instructions: null,
    });
    strictEqual(moved._tag, "Ok");
    const archived = await agent.archiveTeam({ teamId: a.id });
    expect(archived).toEqual({ _tag: "Ok" });
    strictEqual(await isArchived(shop, a.id), true);

    const detail = await agent.getWorkflowDetail({
      workflowId: created.workflow.id,
    });
    expect(detail?.activeTeams.map((t) => t.name)).toEqual(["B"]);

    const missing = await agent.archiveTeam({ teamId: "nope" });
    expect(missing).toEqual({ _tag: "NotFound" });
  });

  it("a step whose team was archived resolves teamName null; writes on an archived workflow return Archived", async () => {
    const shop = "wf-archived.myshopify.com";
    const team = await seedTeam(shop, "T");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tags: [] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const step = await agent.addStep({
      workflowId: created.workflow.id,
      name: "S",
      teamId: team.id,
    });
    if (step._tag !== "Ok" || step.step === null) throw new Error(step._tag);

    await Effect.runPromise(
      Repository.pipe(
        Effect.flatMap((repo) =>
          repo.setTeamArchived({
            shop: shopOf(shop),
            id: team.id,
            archived: true,
          }),
        ),
        Effect.provide(layer),
      ),
    );
    const detail = await agent.getWorkflowDetail({
      workflowId: created.workflow.id,
    });
    expect(detail?.steps[0]?.teamName).toBe(null);
    expect(detail?.activeTeams).toEqual([]);

    const archived = await agent.setWorkflowArchived({
      workflowId: created.workflow.id,
      archived: true,
    });
    strictEqual(archived._tag, "Ok");
    const addOnArchived = await agent.addStep({
      workflowId: created.workflow.id,
      name: "X",
      teamId: team.id,
    });
    strictEqual(addOnArchived._tag, "Archived");
    const moveOnArchived = await agent.moveStep({
      stepId: step.step.id,
      direction: "down",
    });
    strictEqual(moveOnArchived._tag, "Archived");
    const removeOnArchived = await agent.removeStep({ stepId: step.step.id });
    strictEqual(removeOnArchived._tag, "Archived");
    const removeMissing = await agent.removeStep({ stepId: "nope" });
    strictEqual(removeMissing._tag, "NotFound");

    const dupe = await agent.createWorkflow({ name: "w", tags: [] });
    strictEqual(dupe._tag, "NameTaken");
    const list = await agent.listWorkflows({ includeArchived: true });
    expect(list.map((w) => [w.name, w.stepCount])).toEqual([["W", 1]]);
  });

  it("addParallelStep and separateStep map missing stage / step / team and archived to results", async () => {
    const shop = "wf-parallel.myshopify.com";
    const team = await seedTeam(shop, "T");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tags: [] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;
    const first = await agent.addStep({
      workflowId,
      name: "A",
      teamId: team.id,
      instructions: "  Do it carefully  ",
    });
    if (first._tag !== "Ok" || first.step === null) throw new Error(first._tag);
    strictEqual(first.step.instructions, "Do it carefully");
    strictEqual(first.step.stage, 1);

    const missingStage = await agent.addParallelStep({
      workflowId,
      stage: 9,
      name: "B",
      teamId: team.id,
    });
    strictEqual(missingStage._tag, "NotFound");
    const inactive = await agent.addParallelStep({
      workflowId,
      stage: 1,
      name: "B",
      teamId: "nope",
    });
    strictEqual(inactive._tag, "TeamNotActive");
    const parallel = await agent.addParallelStep({
      workflowId,
      stage: 1,
      name: "B",
      teamId: team.id,
    });
    if (parallel._tag !== "Ok" || parallel.step === null)
      throw new Error(parallel._tag);
    strictEqual(parallel.step.stage, 1);
    strictEqual(parallel.step.position, 2);

    const separateMissing = await agent.separateStep({ stepId: "nope" });
    strictEqual(separateMissing._tag, "NotFound");
    const separated = await agent.separateStep({ stepId: parallel.step.id });
    strictEqual(separated._tag, "Ok");
    const detail = await agent.getWorkflowDetail({ workflowId });
    expect(detail?.steps.map((s) => [s.name, s.stage])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);

    await agent.setWorkflowArchived({ workflowId, archived: true });
    const parallelOnArchived = await agent.addParallelStep({
      workflowId,
      stage: 1,
      name: "C",
      teamId: team.id,
    });
    strictEqual(parallelOnArchived._tag, "Archived");
    const separateOnArchived = await agent.separateStep({
      stepId: parallel.step.id,
    });
    strictEqual(separateOnArchived._tag, "Archived");
  });

  it("callable inputs reject excess properties", () => {
    strictEqual(
      Option.isNone(
        Schema.decodeUnknownOption(Domain.CreateWorkflowInput)(
          { name: "W", tags: [], extra: 1 },
          { onExcessProperty: "error" },
        ),
      ),
      true,
    );
  });
});

/**
 * Orders are seeded straight into the object's SQLite through the repository:
 * the object's own fetch path needs a Shopify session and an Admin API the
 * test isolate cannot stub, and what these cases exercise is the attach /
 * cancel logic over stored rows, not the fetch.
 */
const seedOrder = (shop: string, processedAt: number) =>
  runInDurableObject(
    env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          yield* (yield* OrderRepository).upsertOrder({
            order: {
              id: "gid://shopify/Order/1",
              legacyId: "1",
              name: "#1001",
              createdAt: processedAt,
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
                id: "gid://shopify/LineItem/1",
                orderId: "gid://shopify/Order/1",
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

describe("ShopAgent workflow run callables", () => {
  it("attachWorkflow validates the line item and the workflow, then refuses a duplicate", async () => {
    const shop = "wf-attach.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    await seedOrder(shop, Date.now() - 24 * 60 * 60 * 1000);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "Engrave", tags: [] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;

    const noSteps = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(noSteps._tag, "WorkflowNotRoutable");
    await agent.addStep({ workflowId, name: "Engrave", teamId: team.id });

    const unknownItem = await agent.attachWorkflow({
      lineItemId: "nope",
      workflowId,
    });
    strictEqual(unknownItem._tag, "LineItemNotFound");

    const attached = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(attached._tag, "Ok");
    if (attached._tag !== "Ok") return;
    strictEqual(attached.run.source, "manual");
    strictEqual(attached.run.orderName, "#1001");

    const twice = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(twice._tag, "AlreadyExists");

    const listed = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(listed.map((d) => [d.run.id, d.steps.length])).toEqual([
      [attached.run.id, 1],
    ]);
    const summaries = await agent.listWorkflows({ includeArchived: false });
    strictEqual(summaries[0]?.activeRunCount, 1);

    await agent.setWorkflowArchived({ workflowId, archived: true });
    const archived = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(archived._tag, "WorkflowNotRoutable");
  });

  it("cancelRun / uncancelRun / completeStep map repository failures to results", async () => {
    const shop = "wf-cancel.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    await seedOrder(shop, Date.now());
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "Engrave", tags: [] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    await agent.addStep({
      workflowId: created.workflow.id,
      name: "Engrave",
      teamId: team.id,
    });
    const attached = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: created.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const runId = attached.run.id;

    expect(await agent.uncancelRun({ runId })).toEqual({ _tag: "Terminal" });
    expect(await agent.cancelRun({ runId })).toEqual({ _tag: "Ok" });
    expect(await agent.cancelRun({ runId })).toEqual({ _tag: "Terminal" });
    expect(await agent.uncancelRun({ runId })).toEqual({ _tag: "Ok" });
    expect(await agent.cancelRun({ runId: "nope" })).toEqual({
      _tag: "NotFound",
    });

    const [detail] = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    const runStepId = detail?.steps[0]?.id ?? "";
    expect(
      await agent.completeStep({ runStepId, memberId: "m1", teamIds: ["x"] }),
    ).toEqual({ _tag: "NotAllowed" });
    expect(await agent.listQueue({ teamIds: [team.id] })).toHaveLength(1);
    expect(
      await agent.completeStep({
        runStepId,
        memberId: "m1",
        teamIds: [team.id],
      }),
    ).toEqual({ _tag: "Ok" });
    expect(await agent.listQueue({ teamIds: [team.id] })).toHaveLength(0);
    expect(await agent.cancelRun({ runId })).toEqual({ _tag: "Terminal" });
    expect(
      await agent.dismissFlag({ runId, memberId: "m1", teamIds: [team.id] }),
    ).toEqual({ _tag: "NotAllowed" });
  });

  it("completing the last item step starts the order run; the packing team can complete and cancel it", async () => {
    const shop = "wf-order-run.myshopify.com";
    const engraving = await seedTeam(shop, "Engraving");
    const packing = await seedTeam(shop, "Packing");
    await seedOrder(shop, Date.now() + 60 * 60 * 1000);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const item = await agent.createWorkflow({ name: "Engrave", tags: [] });
    if (item._tag !== "Ok") throw new Error(item._tag);
    await agent.addStep({
      workflowId: item.workflow.id,
      name: "Engrave",
      teamId: engraving.id,
    });
    const pack = await agent.createWorkflow({
      name: "Pack",
      scope: "order",
      tags: [],
    });
    if (pack._tag !== "Ok") throw new Error(pack._tag);
    strictEqual(pack.workflow.scope, "order");
    expect(
      await agent.createWorkflow({ name: "Pack 2", scope: "order", tags: [] }),
    ).toEqual({ _tag: "OrderWorkflowExists" });
    await agent.addStep({
      workflowId: pack.workflow.id,
      name: "QC",
      teamId: packing.id,
    });

    const attached = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: item.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const detail = await agent.activateOrder({
      legacyId: "1",
      sessionToken: "t",
    });
    strictEqual(detail?.orderWorkflow?.id, pack.workflow.id);
    strictEqual(detail?.runs.length, 1);

    const [engraveItem] = await agent.listQueue({ teamIds: [engraving.id] });
    expect(
      await agent.completeStep({
        runStepId: engraveItem?.steps[0]?.id ?? "",
        memberId: "m1",
        teamIds: [engraving.id],
      }),
    ).toEqual({ _tag: "Ok" });

    const [packItem] = await agent.listQueue({ teamIds: [packing.id] });
    if (packItem === undefined) throw new Error("no order run in the queue");
    strictEqual(packItem.run.lineItemId, null);
    strictEqual(packItem.run.workflowName, "Pack");
    expect(packItem.items.map((i) => [i.title, i.runStatus])).toEqual([
      ["Necklace", "done"],
    ]);
    const runs = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    strictEqual(runs.at(-1)?.run.id, packItem.run.id);

    expect(await agent.cancelRun({ runId: packItem.run.id })).toEqual({
      _tag: "Ok",
    });
    expect(await agent.uncancelRun({ runId: packItem.run.id })).toEqual({
      _tag: "Ok",
    });
    expect(
      await agent.completeStep({
        runStepId: packItem.steps[0]?.id ?? "",
        memberId: "m1",
        teamIds: [packing.id],
      }),
    ).toEqual({ _tag: "Ok" });
    expect(await agent.listQueue({ teamIds: [packing.id] })).toHaveLength(0);
    const after = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    strictEqual(
      after.find((d) => d.run.id === packItem.run.id)?.run.status,
      "done",
    );
  });

  /**
   * The member-area server fns cannot be driven end to end here (their route
   * needs a Shopify session the isolate cannot stub), so the scope check they
   * delegate to is asserted at the object: a team outside the caller's is
   * `NotAllowed` for every action, and `listQueue` resolves `startedByEmail`.
   */
  it("startStep / setStepNote / blockRun refuse another team's work; listQueue joins startedByEmail", async () => {
    const shop = "wf-start.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    await seedOrder(shop, Date.now());
    const memberId = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const email = Schema.decodeUnknownSync(Domain.Email)("w@example.com");
        yield* repo.addMember({ shop: shopOf(shop), email });
        const members = yield* repo.listMembers(shopOf(shop));
        return members.find((m) => m.email === email)?.id ?? "";
      }).pipe(Effect.provide(layer)),
    );
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "Engrave", tags: [] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    await agent.addStep({
      workflowId: created.workflow.id,
      name: "Engrave",
      teamId: team.id,
    });
    const attached = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: created.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const runId = attached.run.id;
    const [detail] = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    const runStepId = detail?.steps[0]?.id ?? "";

    expect(
      await agent.startStep({ runStepId, memberId, teamIds: ["x"] }),
    ).toEqual({ _tag: "NotAllowed" });
    expect(
      await agent.setStepNote({
        runStepId,
        memberId,
        teamIds: ["x"],
        note: "hi",
      }),
    ).toEqual({ _tag: "NotAllowed" });
    expect(
      await agent.blockRun({ runId, memberId, teamIds: ["x"], reason: null }),
    ).toEqual({ _tag: "NotAllowed" });

    expect(
      await agent.startStep({ runStepId, memberId, teamIds: [team.id] }),
    ).toEqual({ _tag: "Ok" });
    const [item] = await agent.listQueue({ teamIds: [team.id] });
    strictEqual(item?.run.status, "active");
    strictEqual(item?.steps[0]?.startedByEmail, "w@example.com");
    strictEqual(item?.stageCount, 1);
    // startedByEmail still resolves after the member is archived.
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        yield* repo.setMemberArchived({
          shop: shopOf(shop),
          email: Schema.decodeUnknownSync(Domain.Email)("w@example.com"),
          archived: true,
        });
      }).pipe(Effect.provide(layer)),
    );
    const [archivedItem] = await agent.listQueue({ teamIds: [team.id] });
    strictEqual(archivedItem?.steps[0]?.startedByEmail, "w@example.com");
    expect(
      await agent.setStepNote({
        runStepId,
        memberId,
        teamIds: [team.id],
        note: " spelling confirmed ",
      }),
    ).toEqual({ _tag: "Ok" });
    expect(
      await agent.blockRun({
        runId,
        memberId,
        teamIds: [team.id],
        reason: "waiting on stock",
      }),
    ).toEqual({ _tag: "Ok" });
    const [blocked] = await agent.listQueue({ teamIds: [team.id] });
    strictEqual(blocked?.run.flag, "blocked");
    strictEqual(blocked?.run.flagDetail?.reason, "waiting on stock");
    strictEqual(blocked?.run.flagDetail?.by, memberId);
    strictEqual(blocked?.steps[0]?.note, "spelling confirmed");
  });
});
