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
import { runShopAgentMigrations, type ShopAgent } from "@/lib/ShopAgent";

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

const teamExists = async (shop: string, teamId: string) => {
  const teams = await Effect.runPromise(
    Repository.pipe(
      Effect.flatMap((repo) => repo.listTeams({ shop: shopOf(shop) })),
      Effect.provide(layer),
    ),
  );
  return teams.some((t) => t.id === teamId);
};

/** Deletes the D1 row only, the state a `deleteTeam` whose object half failed leaves behind. */
const deleteTeamRowOnly = (shop: string, teamId: Domain.TeamId) =>
  Effect.runPromise(
    Repository.pipe(
      Effect.flatMap((repo) =>
        repo.deleteTeam({ shop: shopOf(shop), id: teamId }),
      ),
      Effect.provide(layer),
    ),
  );

/** Apply the draft and turn the workflow on, the two steps a fresh workflow needs before it starts or attaches. */
const goLive = async (
  agent: Pick<ShopAgent, "applyDraft" | "setWorkflowActive">,
  workflowId: string,
) => {
  const applied = await agent.applyDraft({ workflowId });
  if (applied._tag !== "Ok") throw new Error(`apply: ${applied._tag}`);
  const on = await agent.setWorkflowActive({ workflowId, active: true });
  if (on._tag !== "Ok") throw new Error(`turn on: ${on._tag}`);
  return on.workflow;
};

afterEach(async () => {
  await env.D1.exec("delete from TeamMember");
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from Member");
  await env.D1.exec("delete from ShopSession");
});

/**
 * Every shop name is unique per test: a Durable Object keeps its SQLite across
 * tests in the same worker, so sharing a shop would leak workflows between cases.
 */
describe("ShopAgent workflow callables", () => {
  it("addStep refuses an unknown team, accepts an existing one", async () => {
    const shop = "wf-team-check.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engrave",
      tags: ["Engraving"],
    });
    expect(created._tag).toBe("Ok");
    if (created._tag !== "Ok") return;
    const fresh = await agent.getWorkflowDetail({
      workflowId: created.workflow.id,
    });
    expect(fresh?.draft?.draft.tags).toEqual(["engraving"]);
    expect(fresh?.steps).toEqual([]);
    expect(fresh?.workflow.tags).toEqual([]);

    const unknown = await agent.addStep({
      workflowId: created.workflow.id,
      name: "Engrave",
      teamId: "nope",
    });
    strictEqual(unknown._tag, "TeamNotFound");

    const ok = await agent.addStep({
      workflowId: created.workflow.id,
      name: "Engrave",
      teamId: team.id,
    });
    strictEqual(ok._tag, "Ok");

    const detail = await agent.getWorkflowDetail({
      workflowId: created.workflow.id,
    });
    expect(detail?.draft?.steps.map((s) => s.teamName)).toEqual(["Engraving"]);
    expect(detail?.draft?.steps.map((s) => s.memberCount)).toEqual([0]);
    expect(detail?.teams.map((t) => [t.id, t.memberCount])).toEqual([
      [team.id, 0],
    ]);
  });

  it("deleteTeam nulls every step pointer, D1 first; a dangling id reads as unassigned and a retry repairs it", async () => {
    const shop = "wf-delete-team.myshopify.com";
    const a = await seedTeam(shop, "A");
    const b = await seedTeam(shop, "B");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tags: [] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;
    await agent.addStep({ workflowId, name: "S", teamId: a.id });
    await agent.addStep({ workflowId, name: "T", teamId: b.id });
    await goLive(agent, workflowId);
    await agent.createDraft({ workflowId });

    const counts = await agent.countStepsByTeam();
    expect(
      counts.map((c) => [c.teamId, c.workflowSteps, c.draftSteps]),
    ).toEqual(
      [a, b]
        .toSorted((x, y) => x.id.localeCompare(y.id))
        .map((team) => [team.id, 1, 1]),
    );

    expect(await agent.deleteTeam({ teamId: a.id })).toEqual({
      _tag: "Deleted",
    });
    strictEqual(await teamExists(shop, a.id), false);
    const detail = await agent.getWorkflowDetail({ workflowId });
    expect(detail?.steps.map((s) => [s.name, s.teamId, s.teamName])).toEqual([
      ["S", null, null],
      ["T", b.id, "B"],
    ]);
    expect(detail?.draft?.steps.map((s) => s.teamId)).toEqual([null, b.id]);
    expect(detail?.teams.map((t) => t.name)).toEqual(["B"]);
    expect(await agent.listStepsOwnedBy({ teamId: a.id })).toEqual([]);
    // Off stays off; turning back on names the unassigned step.
    await agent.setWorkflowActive({ workflowId, active: false });
    expect(await agent.setWorkflowActive({ workflowId, active: true })).toEqual(
      { _tag: "StepUnassigned", stepNames: ["S"] },
    );
    expect(await agent.applyDraft({ workflowId })).toEqual({
      _tag: "StepUnassigned",
      stepNames: ["S"],
    });
    const [summary] = await agent.listWorkflows();
    strictEqual(summary?.needsAttention, true);

    // The D1 half succeeded and the object half did not: every read treats
    // the dangling id as unassigned, and a retry nulls it for real.
    await deleteTeamRowOnly(shop, b.id);
    const dangling = await agent.getWorkflowDetail({ workflowId });
    expect(dangling?.steps.map((s) => [s.teamId, s.teamName])).toEqual([
      [null, null],
      [b.id, null],
    ]);
    expect(await agent.setWorkflowActive({ workflowId, active: true })).toEqual(
      { _tag: "StepUnassigned", stepNames: ["S", "T"] },
    );
    expect(await agent.deleteTeam({ teamId: b.id })).toEqual({
      _tag: "NotFound",
    });
    const repaired = await agent.getWorkflowDetail({ workflowId });
    expect(repaired?.steps.map((s) => s.teamId)).toEqual([null, null]);

    // Assigning a team on the draft and applying clears the badge.
    const c = await seedTeam(shop, "C");
    for (const step of repaired?.draft?.steps ?? [])
      await agent.updateStep({
        stepId: step.id,
        name: step.name,
        teamId: c.id,
        instructions: null,
      });
    const reapplied = await agent.applyDraft({ workflowId });
    strictEqual(reapplied._tag, "Ok");
    // Turn on is allowed again; the badge stays because C has nobody on it,
    // which is a warning, never a refusal.
    const backOn = await agent.setWorkflowActive({ workflowId, active: true });
    strictEqual(backOn._tag, "Ok");
    const [cleared] = await agent.listWorkflows();
    strictEqual(cleared?.needsAttention, true);
    expect(await agent.deleteTeam({ teamId: "nope" })).toEqual({
      _tag: "NotFound",
    });
  });

  it("a step whose team was deleted resolves teamName null; removeWorkflow takes the definition and its draft", async () => {
    const shop = "wf-removed.myshopify.com";
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

    await agent.deleteTeam({ teamId: team.id });
    const detail = await agent.getWorkflowDetail({
      workflowId: created.workflow.id,
    });
    expect(detail?.draft?.steps[0]?.teamName).toBe(null);
    expect(detail?.teams).toEqual([]);
    expect(detail?.runCounts).toEqual({ openRuns: 0, finishedRuns: 0 });

    const dupe = await agent.createWorkflow({ name: "w", tags: [] });
    strictEqual(dupe._tag, "NameTaken");
    // Never applied: the list counts saved steps, and there are none.
    const list = await agent.listWorkflows();
    expect(list.map((w) => [w.name, w.stepCount, w.hasDraft])).toEqual([
      ["W", 0, true],
    ]);

    expect(
      await agent.removeWorkflow({ workflowId: created.workflow.id }),
    ).toEqual({ _tag: "Deleted" });
    expect(
      await agent.removeWorkflow({ workflowId: created.workflow.id }),
    ).toEqual({ _tag: "NotFound" });
    strictEqual(
      await agent.getWorkflowDetail({ workflowId: created.workflow.id }),
      null,
    );
    const removeMissing = await agent.removeStep({ stepId: step.step.id });
    strictEqual(removeMissing._tag, "NotFound");
    expect(await agent.listWorkflows()).toEqual([]);
    // The name is free at once.
    const recreated = await agent.createWorkflow({ name: "w", tags: [] });
    strictEqual(recreated._tag, "Ok");
  });

  it("addParallelStep and separateStep map missing stage / step / team to results", async () => {
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
    strictEqual(inactive._tag, "TeamNotFound");
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
    expect(detail?.draft?.steps.map((s) => [s.name, s.stage])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
  });

  it("createDraft / applyDraft / discardDraft / setWorkflowActive / updateWorkflowTags map failures to results", async () => {
    const shop = "wf-draft.myshopify.com";
    const team = await seedTeam(shop, "T");
    await seedOrder(shop, Date.now() - 24 * 60 * 60 * 1000);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tags: ["a"] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;

    expect(await agent.applyDraft({ workflowId })).toEqual({ _tag: "NoSteps" });
    expect(await agent.setWorkflowActive({ workflowId, active: true })).toEqual(
      { _tag: "NoSteps" },
    );
    expect(await agent.applyDraft({ workflowId: "nope" })).toEqual({
      _tag: "NotFound",
    });
    expect(await agent.createDraft({ workflowId: "nope" })).toEqual({
      _tag: "NotFound",
    });
    // Discard is always allowed: a never-applied workflow keeps zero steps.
    const discardedEmpty = await agent.discardDraft({ workflowId });
    strictEqual(discardedEmpty._tag, "Ok");
    expect(
      await agent.addStep({ workflowId, name: "S", teamId: team.id }),
    ).toEqual({ _tag: "NoDraft" });
    expect(await agent.updateWorkflowTags({ workflowId, tags: ["a"] })).toEqual(
      { _tag: "NoDraft" },
    );
    const edit = await agent.createDraft({ workflowId });
    strictEqual(edit._tag, "Ok");

    await agent.addStep({ workflowId, name: "S", teamId: team.id });
    const tagged = await agent.updateWorkflowTags({
      workflowId,
      tags: ["B", "b"],
    });
    strictEqual(tagged._tag, "Ok");
    const applied = await agent.applyDraft({ workflowId });
    if (applied._tag !== "Ok") throw new Error(applied._tag);
    expect(applied.workflow.tags).toEqual(["b"]);
    const detail = await agent.getWorkflowDetail({ workflowId });
    expect(detail?.workflow.tags).toEqual(["b"]);
    expect(detail?.steps.map((s) => [s.name, s.teamName])).toEqual([
      ["S", "T"],
    ]);
    expect(detail?.draft).toBe(null);
    expect(await agent.applyDraft({ workflowId })).toEqual({ _tag: "NoDraft" });
    expect(await agent.discardDraft({ workflowId })).toEqual({
      _tag: "NoDraft",
    });

    const on = await agent.setWorkflowActive({ workflowId, active: true });
    strictEqual(on._tag, "Ok");
    const attached = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const [run] = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(run?.steps.map((s) => s.name)).toEqual(["S"]);

    // Edit, retag, then discard: the workflow is unchanged throughout.
    const again = await agent.createDraft({ workflowId });
    strictEqual(again._tag, "Ok");
    await agent.updateWorkflowTags({ workflowId, tags: ["c"] });
    const edited = await agent.getWorkflowDetail({ workflowId });
    expect(edited?.draft?.draft.tags).toEqual(["c"]);
    expect(edited?.draft?.steps.map((s) => s.name)).toEqual(["S"]);
    expect(edited?.workflow.tags).toEqual(["b"]);
    const discarded = await agent.discardDraft({ workflowId });
    strictEqual(discarded._tag, "Ok");
    const afterDiscard = await agent.getWorkflowDetail({ workflowId });
    expect(afterDiscard?.draft).toBe(null);
    expect(afterDiscard?.workflow.tags).toEqual(["b"]);

    // Team deleted under the workflow's step: turn-on names the step.
    await agent.setWorkflowActive({ workflowId, active: false });
    await agent.deleteTeam({ teamId: team.id });
    expect(await agent.setWorkflowActive({ workflowId, active: true })).toEqual(
      { _tag: "StepUnassigned", stepNames: ["S"] },
    );
    expect(
      await agent.updateWorkflowTags({ workflowId: "nope", tags: [] }),
    ).toEqual({ _tag: "NotFound" });
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
    strictEqual(noSteps._tag, "WorkflowCannotStart");
    await agent.addStep({ workflowId, name: "Engrave", teamId: team.id });
    // A draft is not attachable; neither is an applied but off workflow.
    const draftOnly = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(draftOnly._tag, "WorkflowCannotStart");
    const applied = await agent.applyDraft({ workflowId });
    strictEqual(applied._tag, "Ok");
    const off = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(off._tag, "WorkflowCannotStart");
    await agent.setWorkflowActive({ workflowId, active: true });

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
    const summaries = await agent.listWorkflows();
    strictEqual(summaries[0]?.openRuns, 1);
    const detail = await agent.getWorkflowDetail({ workflowId });
    expect(detail?.runCounts).toEqual({ openRuns: 1, finishedRuns: 0 });

    // Delete while on and with a run: no refusal, and the run goes with it.
    expect(await agent.removeWorkflow({ workflowId })).toEqual({
      _tag: "Deleted",
    });
    expect(
      await agent.listRunsForOrder({ orderId: "gid://shopify/Order/1" }),
    ).toEqual([]);
    const gone = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(gone._tag, "WorkflowCannotStart");
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
    await goLive(agent, created.workflow.id);
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
      await agent.completeStep({
        runStepId,
        memberId: "m1",
        memberEmail: "m1@example.com",
        teamIds: ["x"],
      }),
    ).toEqual({ _tag: "NotAllowed" });
    expect(await agent.listQueue({ teamIds: [team.id] })).toHaveLength(1);
    expect(
      await agent.completeStep({
        runStepId,
        memberId: "m1",
        memberEmail: "m1@example.com",
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
    await goLive(agent, item.workflow.id);
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
    await goLive(agent, pack.workflow.id);

    const attached = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: item.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const detail = await agent.subscribeOrder({
      legacyId: "1",
      subscriberId: "t",
    });
    strictEqual(detail?.orderWorkflow?.id, pack.workflow.id);
    strictEqual(detail?.runs.length, 1);

    const [engraveItem] = await agent.listQueue({ teamIds: [engraving.id] });
    expect(
      await agent.completeStep({
        runStepId: engraveItem?.steps[0]?.id ?? "",
        memberId: "m1",
        memberEmail: "m1@example.com",
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
        memberEmail: "m1@example.com",
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
   * `NotAllowed` for every action, and `listQueue` returns the snapshotted
   * `startedByEmail`.
   */
  it("startStep / setStepNote / blockRun refuse another team's work; listQueue reads startedByEmail after the member is deleted", async () => {
    const shop = "wf-start.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    await seedOrder(shop, Date.now());
    const memberEmail = "w@example.com";
    const memberId = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const email = Schema.decodeUnknownSync(Domain.Email)(memberEmail);
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
    await goLive(agent, created.workflow.id);
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
      await agent.startStep({
        runStepId,
        memberId,
        memberEmail,
        teamIds: ["x"],
      }),
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
      await agent.blockRun({
        runId,
        memberId,
        memberEmail,
        teamIds: ["x"],
        reason: null,
      }),
    ).toEqual({ _tag: "NotAllowed" });

    expect(
      await agent.startStep({
        runStepId,
        memberId,
        memberEmail,
        teamIds: [team.id],
      }),
    ).toEqual({ _tag: "Ok" });
    const [item] = await agent.listQueue({ teamIds: [team.id] });
    strictEqual(item?.run.status, "active");
    strictEqual(item?.steps[0]?.startedByEmail, "w@example.com");
    strictEqual(item?.stageCount, 1);
    // startedByEmail is a snapshot: it survives the member's delete.
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        yield* repo.deleteMember({
          shop: shopOf(shop),
          email: Schema.decodeUnknownSync(Domain.Email)(memberEmail),
        });
      }).pipe(Effect.provide(layer)),
    );
    const [deletedItem] = await agent.listQueue({ teamIds: [team.id] });
    strictEqual(deletedItem?.steps[0]?.startedByEmail, "w@example.com");
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
        memberEmail,
        teamIds: [team.id],
        reason: "waiting on stock",
      }),
    ).toEqual({ _tag: "Ok" });
    const [blocked] = await agent.listQueue({ teamIds: [team.id] });
    strictEqual(blocked?.run.flag, "blocked");
    strictEqual(blocked?.run.flagDetail?.reason, "waiting on stock");
    strictEqual(blocked?.run.flagDetail?.by, memberId);
    strictEqual(blocked?.run.flagDetail?.byEmail, memberEmail);
    strictEqual(blocked?.steps[0]?.note, "spelling confirmed");
  });

  it("assignRunStepTeam puts an unassigned open step in the new team's queue; the order view lists the roster", async () => {
    const shop = "wf-assign.myshopify.com";
    const a = await seedTeam(shop, "A");
    await seedOrder(shop, Date.now());
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tags: [] });
    if (created._tag !== "Ok") throw new Error(created._tag);
    await agent.addStep({
      workflowId: created.workflow.id,
      name: "S",
      teamId: a.id,
    });
    await goLive(agent, created.workflow.id);
    const attached = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: created.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const [detail] = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    const runStepId = detail?.steps[0]?.id ?? "";

    await agent.deleteTeam({ teamId: a.id });
    expect(await agent.listQueue({ teamIds: [a.id] })).toEqual([]);
    const view = await agent.getOrderDetail({ legacyId: "1" });
    expect(view?.runs[0]?.steps[0]?.teamId).toBe(null);
    expect(view?.teams).toEqual([]);

    expect(await agent.assignRunStepTeam({ runStepId, teamId: a.id })).toEqual({
      _tag: "TeamNotFound",
    });
    const b = await seedTeam(shop, "B");
    expect(await agent.assignRunStepTeam({ runStepId, teamId: b.id })).toEqual({
      _tag: "Assigned",
    });
    const [item] = await agent.listQueue({ teamIds: [b.id] });
    strictEqual(item?.steps[0]?.id, runStepId);
    strictEqual(item?.steps[0]?.teamName, "B");
    const after = await agent.getOrderDetail({ legacyId: "1" });
    expect(after?.teams.map((t) => [t.name, t.memberCount])).toEqual([
      ["B", 0],
    ]);
    expect(
      await agent.completeStep({
        runStepId,
        memberId: "m1",
        memberEmail: "m1@example.com",
        teamIds: [b.id],
      }),
    ).toEqual({ _tag: "Ok" });
    expect(await agent.assignRunStepTeam({ runStepId, teamId: b.id })).toEqual({
      _tag: "StepFinished",
    });
    expect(
      await agent.assignRunStepTeam({ runStepId: "nope", teamId: b.id }),
    ).toEqual({ _tag: "NotFound" });
  });
});
