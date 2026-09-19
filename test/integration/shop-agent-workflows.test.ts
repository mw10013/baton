import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
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

import { openMemberSocket } from "./agent-socket";

const layer = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

const tagOf = (
  workflow: Domain.Workflow | Domain.WorkflowSummary | null | undefined,
): string | null => workflow?.tag ?? null;

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
/**
 * The ready half of the queue view, flattened back into one list in strip
 * order because one read now returns one tab; the Done tab and the tiering
 * itself are covered by the repository tests. `memberEmail` defaults to
 * nobody these tests started work as, so every started step reads as a
 * teammate's; `tab` names one tab where that is what a case is about.
 */
const queueItems = async (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
  teamIds: readonly string[],
  {
    memberEmail = "viewer@example.com",
    tab,
  }: { readonly memberEmail?: string; readonly tab?: Domain.QueueTab } = {},
) => {
  const read = async (wanted: Domain.QueueTab) => {
    const view = await agent.listQueue({
      teamIds,
      memberEmail,
      query: { team: null, tab: wanted, limit: Domain.QUEUE_PAGE },
    });
    return view.items;
  };
  if (tab !== undefined) return await read(tab);
  const tabs = ["mine", "upNext", "inProgress", "attention"] as const;
  const reads = await Promise.all(tabs.map(read));
  return reads.flat();
};

describe("ShopAgent workflow callables", () => {
  it("addStep refuses an unknown team, accepts an existing one", async () => {
    const shop = "wf-team-check.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engrave",
      tag: "Engraving",
    });
    expect(created._tag).toBe("Ok");
    if (created._tag !== "Ok") return;
    const fresh = await agent.getWorkflowDetail({
      workflowId: created.workflow.id,
    });
    expect(fresh?.draft).toBe(null);
    expect(fresh?.steps).toEqual([]);
    strictEqual(tagOf(fresh?.workflow), "engraving");

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
    const created = await agent.createWorkflow({ name: "W", tag: "w" });
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

  it("applyAndActivate promotes the draft and turns the switch on in one call; an empty workflow is refused", async () => {
    const shop = "wf-apply-activate.myshopify.com";
    const team = await seedTeam(shop, "T");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "w" });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;

    // Nothing to promote and nothing in force.
    const empty = await agent.applyAndActivate({ workflowId });
    strictEqual(empty._tag, "NoSteps");

    const step = await agent.addStep({
      workflowId,
      name: "S",
      teamId: team.id,
    });
    if (step._tag !== "Ok") throw new Error(step._tag);

    const result = await agent.applyAndActivate({ workflowId });
    strictEqual(result._tag, "Ok");
    if (result._tag !== "Ok") return;
    strictEqual(Domain.isActive(result.workflow), true);
    const detail = await agent.getWorkflowDetail({ workflowId });
    strictEqual(detail?.draft, null);
    expect(detail?.steps.map((s) => s.name)).toEqual(["S"]);
  });

  it("a step whose team was deleted resolves teamName null; removeWorkflow takes the definition and its draft", async () => {
    const shop = "wf-removed.myshopify.com";
    const team = await seedTeam(shop, "T");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "w" });
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

    // The name is a label: the same one under a free tag is a second workflow.
    const twin = await agent.createWorkflow({ name: "w", tag: "dupe" });
    strictEqual(twin._tag, "Ok");
    // The tag is the one key, refused under its own field.
    const dupeTag = await agent.createWorkflow({ name: "Other", tag: "W" });
    strictEqual(dupeTag._tag, "TagTaken");
    // Never applied: the list counts saved steps, and there are none.
    const list = await agent.listWorkflows();
    expect(
      list
        .map(
          (w) =>
            `${w.name}:${w.tag}:${String(w.stepCount)}:${String(w.hasDraft)}`,
        )
        .toSorted(),
    ).toEqual(["W:w:0:true", "w:dupe:0:false"]);

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
    // The twin is untouched: two rows shared a name, and only one was deleted.
    const remaining = await agent.listWorkflows();
    expect(remaining.map((w) => w.tag)).toEqual(["dupe"]);
    // The name is free at once.
    const recreated = await agent.createWorkflow({ name: "w", tag: "w" });
    strictEqual(recreated._tag, "Ok");
  });

  it("addParallelStep and separateStep map missing stage / step / team to results", async () => {
    const shop = "wf-parallel.myshopify.com";
    const team = await seedTeam(shop, "T");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "w" });
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

    const joinMissing = await agent.joinStep({ stepId: "nope" });
    strictEqual(joinMissing._tag, "NotFound");
    const joined = await agent.joinStep({ stepId: parallel.step.id });
    strictEqual(joined._tag, "Ok");
    const rejoined = await agent.getWorkflowDetail({ workflowId });
    expect(rejoined?.draft?.steps.map((s) => [s.name, s.stage])).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
  });

  it("createDraft / applyDraft / discardDraft / setWorkflowActive / updateWorkflowTag map failures to results", async () => {
    const shop = "wf-draft.myshopify.com";
    const team = await seedTeam(shop, "T");
    await seedOrder(shop, Date.now() - 24 * 60 * 60 * 1000);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "a" });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;

    // Fresh: no draft yet, so Apply has nothing; turn-on has no steps.
    expect(await agent.applyDraft({ workflowId })).toEqual({ _tag: "NoDraft" });
    expect(await agent.setWorkflowActive({ workflowId, active: true })).toEqual(
      { _tag: "NoSteps" },
    );
    expect(await agent.createDraft({ workflowId })).toMatchObject({
      _tag: "Ok",
    });
    expect(await agent.applyDraft({ workflowId })).toEqual({ _tag: "NoSteps" });
    expect(await agent.applyDraft({ workflowId: "nope" })).toEqual({
      _tag: "NotFound",
    });
    expect(await agent.createDraft({ workflowId: "nope" })).toEqual({
      _tag: "NotFound",
    });
    // Discard is always allowed: a never-applied workflow keeps zero steps.
    const discardedEmpty = await agent.discardDraft({ workflowId });
    strictEqual(discardedEmpty._tag, "Ok");
    // No draft: the step write makes one rather than refusing.
    const lazy = await agent.addStep({
      workflowId,
      name: "S",
      teamId: team.id,
    });
    strictEqual(lazy._tag, "Ok");
    const lazyDetail = await agent.getWorkflowDetail({ workflowId });
    strictEqual(lazyDetail?.draft?.steps.length, 1);

    // Immediate: the tag is on the workflow before Apply, and no draft of
    // its own is involved.
    const tagged = await agent.updateWorkflowTag({ workflowId, tag: "B" });
    strictEqual(tagged._tag, "Ok");
    if (tagged._tag === "Ok") strictEqual(tagOf(tagged.workflow), "b");
    const applied = await agent.applyDraft({ workflowId });
    if (applied._tag !== "Ok") throw new Error(applied._tag);
    strictEqual(tagOf(applied.workflow), "b");
    const detail = await agent.getWorkflowDetail({ workflowId });
    strictEqual(tagOf(detail?.workflow), "b");
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

    // Edit then discard: the steps go back, and the tag was never in the
    // draft to begin with.
    const again = await agent.createDraft({ workflowId });
    strictEqual(again._tag, "Ok");
    await agent.updateWorkflowTag({ workflowId, tag: "c" });
    const edited = await agent.getWorkflowDetail({ workflowId });
    expect(edited?.draft?.steps.map((s) => s.name)).toEqual(["S"]);
    strictEqual(tagOf(edited?.workflow), "c");
    const discarded = await agent.discardDraft({ workflowId });
    strictEqual(discarded._tag, "Ok");
    const afterDiscard = await agent.getWorkflowDetail({ workflowId });
    expect(afterDiscard?.draft).toBe(null);
    strictEqual(tagOf(afterDiscard?.workflow), "c");

    // Team deleted under the workflow's step: turn-on names the step.
    await agent.setWorkflowActive({ workflowId, active: false });
    await agent.deleteTeam({ teamId: team.id });
    expect(await agent.setWorkflowActive({ workflowId, active: true })).toEqual(
      { _tag: "StepUnassigned", stepNames: ["S"] },
    );
    expect(
      await agent.updateWorkflowTag({ workflowId: "nope", tag: "x" }),
    ).toEqual({ _tag: "NotFound" });
  });
  it("callable inputs reject excess properties", () => {
    strictEqual(
      Option.isNone(
        Schema.decodeUnknownOption(Domain.CreateWorkflowInput)(
          { name: "W", tag: "w", extra: 1 },
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
const seedOrder = (
  shop: string,
  processedAt: number,
  productTags: readonly string[] = [],
) =>
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
              lineItemsTruncated: false,
              syncedAt: processedAt,
              syncSource: "manual",
            },
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
                productTags: [...productTags],
                matchedWorkflowIds: [],
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
    const created = await agent.createWorkflow({
      name: "Engrave",
      tag: "engrave",
    });
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
    strictEqual(attached.replaced, null);

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
    // Delete while on and with a run: no refusal, and the run stays on the
    // order with its snapshots. Re-attaching the deleted workflow cannot
    // start anything, because the definition is gone.
    expect(await agent.removeWorkflow({ workflowId })).toEqual({
      _tag: "Deleted",
    });
    const kept = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(
      kept.map((d) => [d.run.id, d.run.workflowName, d.steps.length]),
    ).toEqual([[attached.run.id, attached.run.workflowName, 1]]);
    const gone = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(gone._tag, "WorkflowCannotStart");
  });

  it("attachWorkflow over a live run replaces it and names what it cancelled", async () => {
    const shop = "wf-replace.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    await seedOrder(shop, Date.now() - 24 * 60 * 60 * 1000);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const build = async (workflowName: string) => {
      const created = await agent.createWorkflow({
        name: workflowName,
        tag: workflowName.toLowerCase(),
      });
      if (created._tag !== "Ok") throw new Error(created._tag);
      await agent.addStep({
        workflowId: created.workflow.id,
        name: "Do it",
        teamId: team.id,
      });
      await goLive(agent, created.workflow.id);
      return created.workflow;
    };
    const first = await build("Engraving");
    const second = await build("Rush");

    const attached = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: first.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);

    const replaced = await agent.attachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: second.id,
    });
    if (replaced._tag !== "Ok") throw new Error(replaced._tag);
    strictEqual(replaced.replaced?.id, attached.run.id);
    strictEqual(replaced.replaced?.workflowName, "Engraving");
    strictEqual(replaced.run.workflowName, "Rush");

    // The item is Rush's now, so the old run cannot be brought back until
    // Rush's is cancelled.
    expect(await agent.uncancelRun({ runId: attached.run.id })).toEqual({
      _tag: "ItemHasRun",
      workflowName: "Rush",
    });
    expect(await agent.cancelRun({ runId: replaced.run.id })).toEqual({
      _tag: "Ok",
    });
    expect(await agent.uncancelRun({ runId: attached.run.id })).toEqual({
      _tag: "Ok",
    });
  });

  it("createWorkflow and updateWorkflowTag refuse a tag another workflow holds; the switch never does", async () => {
    const shop = "wf-tagtaken.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const build = async (workflowName: string, tag: string) => {
      const created = await agent.createWorkflow({ name: workflowName, tag });
      if (created._tag !== "Ok") throw new Error(created._tag);
      await agent.addStep({
        workflowId: created.workflow.id,
        name: "Do it",
        teamId: team.id,
      });
      return created.workflow;
    };
    const holder = await build("Engraving", "engraved");
    await goLive(agent, holder.id);
    const other = await build("Rush", "rush");
    await goLive(agent, other.id);

    // Create: refused under the tag field, naming the holder.
    expect(
      await agent.createWorkflow({ name: "Third", tag: "Engraved" }),
    ).toEqual({
      _tag: "TagTaken",
      tag: "engraved",
      workflowId: holder.id,
      workflowName: "Engraving",
    });
    // Edit tag: the same refusal on an existing workflow.
    expect(
      await agent.updateWorkflowTag({ workflowId: other.id, tag: "engraved" }),
    ).toEqual({
      _tag: "TagTaken",
      tag: "engraved",
      workflowId: holder.id,
      workflowName: "Engraving",
    });
    // Duplicate: the copy's own tag.
    expect(
      await agent.duplicateWorkflow({
        workflowId: other.id,
        name: "Rush copy",
        tag: "engraved",
      }),
    ).toEqual({
      _tag: "TagTaken",
      tag: "engraved",
      workflowId: holder.id,
      workflowName: "Engraving",
    });

    // The switch and Apply say nothing about tags: both are still on.
    const off = await agent.setWorkflowActive({
      workflowId: other.id,
      active: false,
    });
    strictEqual(off._tag, "Ok");
    const backOn = await agent.setWorkflowActive({
      workflowId: other.id,
      active: true,
    });
    strictEqual(backOn._tag, "Ok");
    await agent.addStep({
      workflowId: other.id,
      name: "Pack",
      teamId: team.id,
    });
    const applied = await agent.applyDraft({ workflowId: other.id });
    strictEqual(applied._tag, "Ok");
    const detail = await agent.getWorkflowDetail({ workflowId: other.id });
    strictEqual(tagOf(detail?.workflow), "rush");
  });

  it("turning one of two matching workflows off starts the survivor and says how many", async () => {
    const shop = "wf-ambiguous.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const build = async (workflowName: string, tag: string) => {
      const created = await agent.createWorkflow({ name: workflowName, tag });
      if (created._tag !== "Ok") throw new Error(created._tag);
      await agent.addStep({
        workflowId: created.workflow.id,
        name: "Do it",
        teamId: team.id,
      });
      await goLive(agent, created.workflow.id);
      return created.workflow;
    };
    // Both on *before* the order exists, so the first reconcile it ever sees
    // already has two matches to choose between.
    const keeper = await build("Engraving", "engraved");
    const rival = await build("Rush", "rush");
    // Placed after both went on, so only the ambiguity holds it back.
    await seedOrder(shop, Date.now() + 60 * 60 * 1000, ["engraved", "rush"]);

    // Any definition write on an on workflow reconciles every stored order.
    const nudged = await agent.setWorkflowActivatedAt({
      workflowId: keeper.id,
      activatedAt: keeper.activatedAt ?? Date.now(),
    });
    if (nudged._tag !== "Ok") throw new Error(nudged._tag);
    strictEqual(nudged.started, 0);
    expect(
      await agent.listRunsForOrder({ orderId: "gid://shopify/Order/1" }),
    ).toHaveLength(0);

    const off = await agent.setWorkflowActive({
      workflowId: rival.id,
      active: false,
    });
    if (off._tag !== "Ok") throw new Error(off._tag);
    // Turn off started a run: `started` is meaningful in both directions.
    strictEqual(off.started, 1);
    const runs = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(runs.map((d) => d.run.workflowId)).toEqual([keeper.id]);
  });

  it("retagging an on workflow reconciles stored orders against the new tag", async () => {
    const shop = "wf-retag.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engraving",
      tag: "engraved",
    });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;
    await agent.addStep({ workflowId, name: "Engrave", teamId: team.id });
    await goLive(agent, workflowId);
    // Placed after Turn on, but carrying a tag no workflow has yet.
    await seedOrder(shop, Date.now() + 60 * 60 * 1000, ["laser"]);
    expect(
      await agent.listRunsForOrder({ orderId: "gid://shopify/Order/1" }),
    ).toHaveLength(0);

    // The retag is the definition write that makes the item match; the
    // stored order starts now rather than on Shopify's next edit.
    const retagged = await agent.updateWorkflowTag({
      workflowId,
      tag: "laser",
    });
    strictEqual(retagged._tag, "Ok");
    const runs = await agent.listRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(runs.map((d) => d.run.workflowId)).toEqual([workflowId]);
  });

  it("cancelRun / uncancelRun / completeStep map repository failures to results", async () => {
    const shop = "wf-cancel.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    await seedOrder(shop, Date.now());
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engrave",
      tag: "engrave",
    });
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
    const stranger = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: ["x"],
    });
    expect(await stranger.completeStep({ runStepId })).toEqual({
      _tag: "NotAllowed",
    });
    stranger.close();
    expect(await queueItems(agent, [team.id])).toHaveLength(1);
    const engraver = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: [team.id],
    });
    expect(await engraver.completeStep({ runStepId })).toEqual({ _tag: "Ok" });
    expect(await queueItems(agent, [team.id])).toHaveLength(0);
    expect(await agent.cancelRun({ runId })).toEqual({ _tag: "Terminal" });
    expect(await engraver.dismissFlag({ runId })).toEqual({
      _tag: "NotAllowed",
    });
    engraver.close();
  });

  /**
   * The member-area server fns cannot be driven end to end here (their route
   * needs a Shopify session the isolate cannot stub), so the kind check they
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
        yield* repo.addMember({
          shop: shopOf(shop),
          email,
          limit: Domain.MAX_ENTITLEMENTS.maxMembers,
        });
        const members = yield* repo.listMembers(shopOf(shop));
        return members.find((m) => m.email === email)?.id ?? "";
      }).pipe(Effect.provide(layer)),
    );
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engrave",
      tag: "engrave",
    });
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

    const outsider = await openMemberSocket(shop, {
      memberId,
      memberEmail,
      teamIds: ["x"],
    });
    expect(await outsider.startStep({ runStepId })).toEqual({
      _tag: "NotAllowed",
    });
    expect(await outsider.setStepNote({ runStepId, note: "hi" })).toEqual({
      _tag: "NotAllowed",
    });
    expect(await outsider.blockRun({ runId, reason: null })).toEqual({
      _tag: "NotAllowed",
    });
    outsider.close();

    const engraver = await openMemberSocket(shop, {
      memberId,
      memberEmail,
      teamIds: [team.id],
    });
    expect(await engraver.startStep({ runStepId })).toEqual({ _tag: "Ok" });
    // Their own started step, so it is Mine for them — which is the tab the
    // snapshotted email has to survive the delete in.
    const [item] = await queueItems(agent, [team.id], {
      memberEmail,
      tab: "mine",
    });
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
    const [deletedItem] = await queueItems(agent, [team.id], {
      memberEmail,
      tab: "mine",
    });
    strictEqual(deletedItem?.steps[0]?.startedByEmail, "w@example.com");
    expect(
      await engraver.setStepNote({
        runStepId,
        note: " spelling confirmed ",
      }),
    ).toEqual({ _tag: "Ok" });
    expect(
      await engraver.blockRun({ runId, reason: "waiting on stock" }),
    ).toEqual({ _tag: "Ok" });
    engraver.close();
    const [blocked] = await queueItems(agent, [team.id]);
    strictEqual(blocked?.run.flag, "blocked");
    strictEqual(blocked?.run.flagDetail?.reason, "waiting on stock");
    deepStrictEqual<unknown>(blocked?.run.flagDetail?.by, {
      role: "member",
      memberId,
      email: memberEmail,
    });
    strictEqual(blocked?.steps[0]?.note, "spelling confirmed");
  });

  it("assignRunStepTeam puts an unassigned open step in the new team's queue; the order view lists the roster", async () => {
    const shop = "wf-assign.myshopify.com";
    const a = await seedTeam(shop, "A");
    await seedOrder(shop, Date.now());
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "w" });
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
    expect(await queueItems(agent, [a.id])).toEqual([]);
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
    const [item] = await queueItems(agent, [b.id]);
    strictEqual(item?.steps[0]?.id, runStepId);
    strictEqual(item?.steps[0]?.teamName, "B");
    const after = await agent.getOrderDetail({ legacyId: "1" });
    expect(after?.teams.map((t) => [t.name, t.memberCount])).toEqual([
      ["B", 0],
    ]);
    // A *started* step reassigns too: only teamId/teamName move, so history
    // keeps whoever began it and the new team finishes what they started.
    const inB = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: [b.id],
    });
    expect(await inB.startStep({ runStepId })).toEqual({ _tag: "Ok" });
    inB.close();
    const c = await seedTeam(shop, "C");
    expect(await agent.assignRunStepTeam({ runStepId, teamId: c.id })).toEqual({
      _tag: "Assigned",
    });
    expect(await queueItems(agent, [b.id])).toEqual([]);
    const [moved] = await queueItems(agent, [c.id]);
    strictEqual(moved?.steps[0]?.id, runStepId);
    strictEqual(moved?.steps[0]?.teamName, "C");
    strictEqual(moved?.steps[0]?.startedByEmail, "m1@example.com");
    strictEqual(moved?.steps[0]?.startedAt !== null, true);

    const inC = await openMemberSocket(shop, {
      memberId: "m2",
      memberEmail: "m2@example.com",
      teamIds: [c.id],
    });
    expect(await inC.completeStep({ runStepId })).toEqual({ _tag: "Ok" });
    inC.close();
    const finished = await agent.getOrderDetail({ legacyId: "1" });
    strictEqual(
      finished?.runs[0]?.steps[0]?.completedByEmail,
      "m2@example.com",
    );
    strictEqual(finished?.runs[0]?.steps[0]?.startedByEmail, "m1@example.com");
    expect(await agent.assignRunStepTeam({ runStepId, teamId: c.id })).toEqual({
      _tag: "StepFinished",
    });
    expect(
      await agent.assignRunStepTeam({ runStepId: "nope", teamId: b.id }),
    ).toEqual({ _tag: "NotFound" });
  });
});

/**
 * The seed callables, at the level the fixture uses them: the phases of
 * `seedOrders` (a chosen workflow, per-item progress, the `after` state) and
 * the two mechanics a reseed depends on — the usage counter not climbing, and
 * `seedWorkflows` leaving surviving orders matched against what it just wrote.
 */
const seedMember = { memberId: "seed-member", memberEmail: "lead@m.com" };
const seedOrderId = (n: number) => `${Domain.SEED_ORDER_ID_PREFIX}${String(n)}`;

/** The index's own read, unfiltered, so a row can be put through `Domain.productionState`. */
const ordersPage = async (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
) => {
  const view = await agent.subscribeOrders({
    subscriberId: "seed-test",
    limit: 50,
    cursor: null,
    q: null,
    state: null,
    paid: null,
    attention: false,
    team: null,
  });
  return view.page.orders;
};

const twoStep = (name: string, tag: string, teamId: string) => ({
  name,
  tag,
  steps: [
    { name: `Make ${name}`, teamId },
    { name: `Finish ${name}`, teamId },
  ],
});

describe("ShopAgent seed callables", () => {
  it("seedOrders runs each item on its own progress and leaves its siblings alone", async () => {
    const shop = "seed-per-item.myshopify.com";
    const team = await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await agent.seedWorkflows({
      workflows: [
        twoStep("Board", "board", team.id),
        twoStep("Ring", "ring", team.id),
      ],
    });
    await agent.seedOrders({
      ...seedMember,
      orders: [
        {
          n: 1,
          // The order's own keys, which the board overrides and the ring takes.
          advance: 1,
          lineItems: [
            {
              title: "Board",
              quantity: 1,
              tags: ["board"],
              progress: { done: true },
            },
            { title: "Ring", quantity: 1, tags: ["ring"] },
          ],
        },
      ],
    });
    const runs = await agent.listRunsForOrder({ orderId: seedOrderId(1) });
    expect(
      runs
        .map(({ run, steps }) => ({
          workflow: run.workflowName,
          status: run.status,
          done: steps.filter((step) => step.completedAt !== null).length,
        }))
        .toSorted((a, b) => a.workflow.localeCompare(b.workflow)),
    ).toEqual([
      { workflow: "Board", status: "done", done: 2 },
      { workflow: "Ring", status: "active", done: 1 },
    ]);
  });

  it("seedOrders chooses a workflow for an item two claim, and the order stops asking", async () => {
    const shop = "seed-choose.myshopify.com";
    const team = await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const seeded = await agent.seedWorkflows({
      workflows: [
        twoStep("Board", "board", team.id),
        twoStep("Rush order", "rush", team.id),
      ],
    });
    const boardId = seeded.find(({ name }) => name === "Board")?.id;
    if (boardId === undefined) throw new Error("seedWorkflows returned no id");

    const ambiguousItem = {
      title: "Board",
      quantity: 1,
      tags: ["board", "rush"],
    };
    await agent.seedOrders({
      ...seedMember,
      orders: [{ n: 1, lineItems: [ambiguousItem] }],
    });
    const unrouted = await agent.listRunsForOrder({ orderId: seedOrderId(1) });
    strictEqual(unrouted.length, 0);
    const [asking] = await ordersPage(agent);
    strictEqual(
      asking === undefined ? null : Domain.productionState(asking),
      "multiple_workflows",
    );

    await agent.seedOrders({
      ...seedMember,
      orders: [
        { n: 1, lineItems: [{ ...ambiguousItem, workflowId: boardId }] },
      ],
    });
    const runs = await agent.listRunsForOrder({ orderId: seedOrderId(1) });
    expect(runs.map(({ run }) => [run.workflowName, run.source])).toEqual([
      ["Board", "manual"],
    ]);
    const [chosen] = await ordersPage(agent);
    strictEqual(
      chosen === undefined ? null : Domain.productionState(chosen),
      "in_production",
    );
  });

  it("seedOrders applies `after` once the work has started, so the run carries the flag", async () => {
    const shop = "seed-after.myshopify.com";
    const team = await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await agent.seedWorkflows({
      workflows: [twoStep("Board", "board", team.id)],
    });
    await agent.seedOrders({
      ...seedMember,
      orders: [
        {
          n: 1,
          advance: 1,
          after: { cancelled: true },
          lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }],
        },
        {
          n: 2,
          advance: 1,
          after: { lineItems: [{ position: 1, unfulfilledQuantity: 1 }] },
          lineItems: [{ title: "Board", quantity: 2, tags: ["board"] }],
        },
      ],
    });
    const flagOf = async (n: number) => {
      const runs = await agent.listRunsForOrder({ orderId: seedOrderId(n) });
      return runs[0]?.run.flag;
    };
    strictEqual(await flagOf(1), "order_cancelled");
    strictEqual(await flagOf(2), "quantity_changed");
  });

  it("seedOrders leaves the usage counter at one seed's worth however often it is reseeded", async () => {
    const shop = "seed-usage.myshopify.com";
    await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const orders = [
      { n: 1, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] },
      { n: 2, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] },
      {
        n: 3,
        unpaid: true,
        lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }],
      },
    ];
    const countedOrders = async () => {
      const usage = await agent.getUsage();
      return usage.ordersThisMonth;
    };
    await agent.seedOrders({ ...seedMember, orders });
    strictEqual(await countedOrders(), 2);
    // Five orders the seed does not own, counted the way a sync would count
    // them: a reseed gives back only its own share, never theirs.
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "update ShopUsage set ordersThisMonth = ordersThisMonth + 5 where id = 1",
      );
    });
    await agent.seedOrders({ ...seedMember, orders });
    await agent.seedOrders({ ...seedMember, orders });
    strictEqual(await countedOrders(), 7);
  });

  it("a reseed re-matches the orders it did not replace", async () => {
    const shop = "seed-reconcile.myshopify.com";
    const team = await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    // A synced order, written past the seed so the reseed below has something
    // it does not own: this is the row the fixture leaves alone, carrying a
    // match against a workflow the reseed is about to delete.
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
      const { sql } = (instance as unknown as { ctx: DurableObjectState }).ctx
        .storage;
      sql.exec(
        `insert or replace into ShopOrder
           (id, legacyId, name, processedAt, updatedAt, cancelledAt, closedAt,
            financialStatus, fulfillmentStatus, fullyPaid, tags, note,
            customAttributes, lineItemsComplete, lineItemsTruncated, syncedAt, syncSource)
         values ('gid://shopify/Order/synced-1', 'synced-1', '#5001', 1, 1, null, null,
                 'PAID', 'UNFULFILLED', 1, '[]', null, '[]', 1, 0, 1, 'webhook')`,
      );
      sql.exec(
        `insert or replace into OrderLineItem
           (id, orderId, productId, variantId, title, variantTitle, sku, quantity,
            currentQuantity, unfulfilledQuantity, nonFulfillableQuantity, productTags,
            matchedWorkflowIds, customAttributes, requiresShipping)
         values ('gid://shopify/Order/synced-1/line-1', 'gid://shopify/Order/synced-1',
                 null, null, 'Board', null, null, 1, 1, 1, 0, '["board"]',
                 '["a-workflow-this-seed-deletes"]', '[]', 1)`,
      );
    });

    // A fixture that says nothing about orders still replaces every workflow,
    // and `seedOrders` runs whatever the caller sent — here, nothing.
    await agent.seedWorkflows({
      workflows: [twoStep("Board", "board", team.id)],
    });
    await agent.seedOrders({ ...seedMember, orders: [] });

    const detail = await agent.getOrderDetail({ legacyId: "synced-1" });
    // Recomputed, not left behind: empty because the replacement was switched
    // on after this order was placed, which is the date rule the reconcile
    // re-applies.
    expect(detail?.lineItems.map((item) => item.matchedWorkflowIds)).toEqual([
      [],
    ]);
  });
});
