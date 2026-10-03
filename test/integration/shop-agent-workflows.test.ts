import type { ShopAgent } from "@/lib/ShopAgent";

import { SqliteClient } from "@effect/sql-sqlite-do";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Ref, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { BillingAgent } from "@/lib/agent/Billing";
import { ShopAgentHost } from "@/lib/agent/Host";
import { ShopWorkAgent } from "@/lib/agent/ShopWork";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { RunRepository } from "@/lib/RunRepository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import { ShopifyAppEvents } from "@/lib/ShopifyAppEvents";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

import { openMemberSocket, openMerchantSocket } from "./agent-socket";

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

/** Apply the draft and turn the workflow on, the two tasks a fresh workflow needs before it starts or attaches. */
const goLive = async (
  agent: Pick<ShopAgent, "applyDraft" | "setWorkflowOn">,
  workflowId: string,
) => {
  const applied = await agent.applyDraft({ workflowId });
  if (applied._tag !== "Ok") throw new Error(`apply: ${applied._tag}`);
  const on = await agent.setWorkflowOn({ workflowId, on: true });
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
 * The current half of the workflows list, flattened back into one list in strip
 * order because one read now returns one state; Done or closed and sorting by state
 * itself are covered by the repository tests. `memberEmail` defaults to
 * nobody these tests started work as, so every started task reads as a
 * teammate's; `state` names one state where that is what a case is about.
 */
const runListItems = async (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
  teamIds: readonly string[],
  {
    memberEmail = "viewer@example.com",
    state,
  }: {
    readonly memberEmail?: string;
    readonly state?: Domain.WorkflowsListState;
  } = {},
) => {
  const read = async (wanted: Domain.WorkflowsListState) => {
    const list = await agent.listRuns({
      teamIds,
      memberEmail,
      query: { team: null, state: wanted, limit: Domain.RUN_PAGE, q: null },
    });
    return list.items;
  };
  if (state !== undefined) return await read(state);
  const states = [
    "started_by_you",
    "ready",
    "started_by_others",
    "blocked",
  ] as const;
  const reads = await Promise.all(states.map(read));
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
    expect(fresh?.tasks).toEqual([]);
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
    expect(detail?.draft?.tasks.map((s) => s.teamName)).toEqual(["Engraving"]);
    expect(detail?.draft?.tasks.map((s) => s.memberCount)).toEqual([0]);
    expect(detail?.teams.map((t) => [t.id, t.memberCount])).toEqual([
      [team.id, 0],
    ]);
  });

  it("the next team delete nulls pointers to a team that is already gone", async () => {
    const shop = "wf-delete-team-repair.myshopify.com";
    const a = await seedTeam(shop, "A");
    const b = await seedTeam(shop, "B");
    const c = await seedTeam(shop, "C");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "w" });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;
    await agent.addStep({ workflowId, name: "S", teamId: a.id });
    await agent.addStep({ workflowId, name: "T", teamId: b.id });
    await agent.addStep({ workflowId, name: "U", teamId: c.id });
    await goLive(agent, workflowId);
    await agent.createDraft({ workflowId });
    // A's delete went half way: its row is gone and its pointers are not.
    await deleteTeamRowOnly(shop, a.id);
    expect(await agent.deleteTeam({ teamId: b.id })).toEqual({
      _tag: "Deleted",
    });
    const detail = await agent.getWorkflowDetail({ workflowId });
    expect(detail?.tasks.map((s) => s.teamId)).toEqual([null, null, c.id]);
    expect(detail?.draft?.tasks.map((s) => s.teamId)).toEqual([
      null,
      null,
      c.id,
    ]);
  });

  it("deleteTeam nulls every task pointer, D1 first; a dangling id reads as unassigned and a retry repairs it", async () => {
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

    expect(await agent.deleteTeam({ teamId: a.id })).toEqual({
      _tag: "Deleted",
    });
    strictEqual(await teamExists(shop, a.id), false);
    const detail = await agent.getWorkflowDetail({ workflowId });
    expect(detail?.tasks.map((s) => [s.name, s.teamId, s.teamName])).toEqual([
      ["S", null, null],
      ["T", b.id, "B"],
    ]);
    expect(detail?.draft?.tasks.map((s) => s.teamId)).toEqual([null, b.id]);
    expect(detail?.teams.map((t) => t.name)).toEqual(["B"]);
    expect(await agent.listTeamWorkflows({ teamId: a.id })).toEqual([]);
    // Off stays off; turning back on names the unassigned task.
    await agent.setWorkflowOn({ workflowId, on: false });
    expect(await agent.setWorkflowOn({ workflowId, on: true })).toEqual({
      _tag: "TaskUnassigned",
      taskNames: ["S"],
    });
    expect(await agent.applyDraft({ workflowId })).toEqual({
      _tag: "TaskUnassigned",
      taskNames: ["S"],
    });
    const [summary] = await agent.listWorkflows();
    strictEqual(summary?.unassigned, true);

    // The D1 half succeeded and the object half did not: every read treats
    // the dangling id as unassigned, and a retry nulls it for real.
    await deleteTeamRowOnly(shop, b.id);
    const dangling = await agent.getWorkflowDetail({ workflowId });
    expect(dangling?.tasks.map((s) => [s.teamId, s.teamName])).toEqual([
      [null, null],
      [b.id, null],
    ]);
    expect(await agent.setWorkflowOn({ workflowId, on: true })).toEqual({
      _tag: "TaskUnassigned",
      taskNames: ["S", "T"],
    });
    expect(await agent.deleteTeam({ teamId: b.id })).toEqual({
      _tag: "NotFound",
    });
    const repaired = await agent.getWorkflowDetail({ workflowId });
    expect(repaired?.tasks.map((s) => s.teamId)).toEqual([null, null]);

    // Assigning a team on the draft and applying clears unassigned.
    const c = await seedTeam(shop, "C");
    for (const task of repaired?.draft?.tasks ?? [])
      await agent.updateTask({
        taskId: task.id,
        name: task.name,
        teamId: c.id,
        instructions: null,
      });
    const reapplied = await agent.applyDraft({ workflowId });
    strictEqual(reapplied._tag, "Ok");
    // Turn on is allowed again; emptyTeam shows because C has nobody on it,
    // which is a warning, never a refusal.
    const backOn = await agent.setWorkflowOn({ workflowId, on: true });
    strictEqual(backOn._tag, "Ok");
    const [cleared] = await agent.listWorkflows();
    strictEqual(cleared?.unassigned, false);
    strictEqual(cleared?.emptyTeam, true);
    expect(await agent.deleteTeam({ teamId: "nope" })).toEqual({
      _tag: "NotFound",
    });
  });

  it("applyAndTurnOn promotes the draft and turns the switch on in one call; an empty workflow is refused", async () => {
    const shop = "wf-apply-activate.myshopify.com";
    const team = await seedTeam(shop, "T");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "w" });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;

    // Nothing to promote and nothing in force.
    const empty = await agent.applyAndTurnOn({ workflowId });
    strictEqual(empty._tag, "NoTasks");

    const task = await agent.addStep({
      workflowId,
      name: "S",
      teamId: team.id,
    });
    if (task._tag !== "Ok") throw new Error(task._tag);

    const result = await agent.applyAndTurnOn({ workflowId });
    strictEqual(result._tag, "Ok");
    if (result._tag !== "Ok") return;
    strictEqual(Domain.workflowIsOn(result.workflow), true);
    const detail = await agent.getWorkflowDetail({ workflowId });
    strictEqual(detail?.draft, null);
    expect(detail?.tasks.map((s) => s.name)).toEqual(["S"]);
  });

  it("a task whose team was deleted resolves teamName null; removeWorkflow takes the definition and its draft", async () => {
    const shop = "wf-removed.myshopify.com";
    const team = await seedTeam(shop, "T");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "w" });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const task = await agent.addStep({
      workflowId: created.workflow.id,
      name: "S",
      teamId: team.id,
    });
    if (task._tag !== "Ok" || task.task === null) throw new Error(task._tag);

    await agent.deleteTeam({ teamId: team.id });
    const detail = await agent.getWorkflowDetail({
      workflowId: created.workflow.id,
    });
    expect(detail?.draft?.tasks[0]?.teamName).toBe(null);
    expect(detail?.teams).toEqual([]);

    // Names compare exactly: a case variant under a free tag is a second workflow.
    const twin = await agent.createWorkflow({ name: "w", tag: "dupe" });
    strictEqual(twin._tag, "Ok");
    // The name itself is refused under its own field.
    expect(await agent.createWorkflow({ name: "w", tag: "free" })).toEqual({
      _tag: "NameTaken",
      name: "w",
    });
    // So is the tag.
    const dupeTag = await agent.createWorkflow({ name: "Other", tag: "W" });
    strictEqual(dupeTag._tag, "TagTaken");
    // Never applied: the list counts saved tasks, and there are none.
    const list = await agent.listWorkflows();
    expect(
      list.map((w) => `${w.name}:${w.tag}:${String(w.stepCount)}`).toSorted(),
    ).toEqual(["W:w:0", "w:dupe:0"]);

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
    const removeMissing = await agent.removeTask({ taskId: task.task.id });
    strictEqual(removeMissing._tag, "NotFound");
    // The twin is untouched: only the one removed goes.
    const remaining = await agent.listWorkflows();
    expect(remaining.map((w) => w.tag)).toEqual(["dupe"]);
    // Its name and tag are free at once.
    const recreated = await agent.createWorkflow({ name: "W", tag: "w" });
    strictEqual(recreated._tag, "Ok");
  });

  it("addTask and separateTask map missing step / task / team to results", async () => {
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
    if (first._tag !== "Ok" || first.task === null) throw new Error(first._tag);
    strictEqual(first.task.instructions, "Do it carefully");
    strictEqual(first.task.step, 1);

    const missingStep = await agent.addTask({
      workflowId,
      step: 9,
      name: "B",
      teamId: team.id,
    });
    strictEqual(missingStep._tag, "NotFound");
    const inactive = await agent.addTask({
      workflowId,
      step: 1,
      name: "B",
      teamId: "nope",
    });
    strictEqual(inactive._tag, "TeamNotFound");
    const parallel = await agent.addTask({
      workflowId,
      step: 1,
      name: "B",
      teamId: team.id,
    });
    if (parallel._tag !== "Ok" || parallel.task === null)
      throw new Error(parallel._tag);
    strictEqual(parallel.task.step, 1);
    strictEqual(parallel.task.position, 2);

    const separateMissing = await agent.separateTask({ taskId: "nope" });
    strictEqual(separateMissing._tag, "NotFound");
    const separated = await agent.separateTask({ taskId: parallel.task.id });
    strictEqual(separated._tag, "Ok");
    const detail = await agent.getWorkflowDetail({ workflowId });
    expect(detail?.draft?.tasks.map((s) => [s.name, s.step])).toEqual([
      ["A", 1],
      ["B", 2],
    ]);

    const joinMissing = await agent.joinTask({ taskId: "nope" });
    strictEqual(joinMissing._tag, "NotFound");
    const joined = await agent.joinTask({ taskId: parallel.task.id });
    strictEqual(joined._tag, "Ok");
    const rejoined = await agent.getWorkflowDetail({ workflowId });
    expect(rejoined?.draft?.tasks.map((s) => [s.name, s.step])).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
  });

  it("createDraft / applyDraft / discardDraft / setWorkflowOn / updateWorkflowTag map failures to results", async () => {
    const shop = "wf-draft.myshopify.com";
    const team = await seedTeam(shop, "T");
    await seedOrder(shop, Date.now() - 24 * 60 * 60 * 1000);
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({ name: "W", tag: "a" });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;

    // Fresh: no draft yet, so Apply has nothing; turn-on has no tasks.
    expect(await agent.applyDraft({ workflowId })).toEqual({ _tag: "NoDraft" });
    expect(await agent.setWorkflowOn({ workflowId, on: true })).toEqual({
      _tag: "NoTasks",
    });
    expect(await agent.createDraft({ workflowId })).toMatchObject({
      _tag: "Ok",
    });
    expect(await agent.applyDraft({ workflowId })).toEqual({ _tag: "NoTasks" });
    expect(await agent.applyDraft({ workflowId: "nope" })).toEqual({
      _tag: "NotFound",
    });
    expect(await agent.createDraft({ workflowId: "nope" })).toEqual({
      _tag: "NotFound",
    });
    // Discard is always allowed: a never-applied workflow keeps zero tasks.
    const discardedEmpty = await agent.discardDraft({ workflowId });
    strictEqual(discardedEmpty._tag, "Ok");
    // No draft: the task write makes one rather than refusing.
    const lazy = await agent.addStep({
      workflowId,
      name: "S",
      teamId: team.id,
    });
    strictEqual(lazy._tag, "Ok");
    const lazyDetail = await agent.getWorkflowDetail({ workflowId });
    strictEqual(lazyDetail?.draft?.tasks.length, 1);

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
    expect(detail?.tasks.map((s) => [s.name, s.teamName])).toEqual([
      ["S", "T"],
    ]);
    expect(detail?.draft).toBe(null);
    expect(await agent.applyDraft({ workflowId })).toEqual({ _tag: "NoDraft" });
    expect(await agent.discardDraft({ workflowId })).toEqual({
      _tag: "NoDraft",
    });

    const on = await agent.setWorkflowOn({ workflowId, on: true });
    strictEqual(on._tag, "Ok");
    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const [run] = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(run?.tasks.map((s) => s.name)).toEqual(["S"]);

    // Edit then discard: the tasks go back, and the tag was never in the
    // draft to begin with.
    const again = await agent.createDraft({ workflowId });
    strictEqual(again._tag, "Ok");
    await agent.updateWorkflowTag({ workflowId, tag: "c" });
    const edited = await agent.getWorkflowDetail({ workflowId });
    expect(edited?.draft?.tasks.map((s) => s.name)).toEqual(["S"]);
    strictEqual(tagOf(edited?.workflow), "c");
    const discarded = await agent.discardDraft({ workflowId });
    strictEqual(discarded._tag, "Ok");
    const afterDiscard = await agent.getWorkflowDetail({ workflowId });
    expect(afterDiscard?.draft).toBe(null);
    strictEqual(tagOf(afterDiscard?.workflow), "c");

    // Team deleted under the workflow's task: turn-on names the task.
    await agent.setWorkflowOn({ workflowId, on: false });
    await agent.deleteTeam({ teamId: team.id });
    expect(await agent.setWorkflowOn({ workflowId, on: true })).toEqual({
      _tag: "TaskUnassigned",
      taskNames: ["S"],
    });
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
  order: Partial<Domain.ShopOrder> = {},
  lineItem: Partial<Domain.OrderLineItem> = {},
  n = 1,
) =>
  runInDurableObject(
    env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          yield* (yield* OrderRepository).upsertOrder({
            order: {
              id: `gid://shopify/Order/${String(n)}`,
              legacyId: String(n),
              name: `#${String(1000 + n)}`,
              processedAt,
              updatedAt: processedAt,
              cancelledAt: null,
              fulfillmentStatus: "UNFULFILLED",
              fullyPaid: true,
              note: null,
              syncedAt: processedAt,
              ...order,
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
                productTags: [...productTags],
                properties: [],
                ...lineItem,
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
  it("attachWorkflow validates the item and the workflow, then refuses a duplicate", async () => {
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

    const noTasks = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(noTasks._tag, "WorkflowNotEligible");
    await agent.addStep({ workflowId, name: "Engrave", teamId: team.id });
    // A draft is not attachable; neither is an applied but off workflow.
    const draftOnly = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(draftOnly._tag, "WorkflowNotEligible");
    const applied = await agent.applyDraft({ workflowId });
    strictEqual(applied._tag, "Ok");
    const off = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(off._tag, "WorkflowNotEligible");
    await agent.setWorkflowOn({ workflowId, on: true });

    const unknownItem = await agent.merchantAttachWorkflow({
      lineItemId: "nope",
      workflowId,
    });
    strictEqual(unknownItem._tag, "LineItemNotFound");

    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(attached._tag, "Ok");
    if (attached._tag !== "Ok") return;
    strictEqual(attached.run.orderName, "#1001");
    strictEqual(attached.replaced, null);

    const twice = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(twice._tag, "AlreadyExists");

    const listed = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(listed.map((d) => [d.run.id, d.tasks.length])).toEqual([
      [attached.run.id, 1],
    ]);
    // Delete while on and with a run: no refusal, and the run stays on the
    // order with its snapshots. Re-attaching the deleted workflow cannot
    // create anything, because the definition is gone.
    expect(await agent.removeWorkflow({ workflowId })).toEqual({
      _tag: "Deleted",
    });
    const kept = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(
      kept.map((d) => [d.run.id, d.run.workflowName, d.tasks.length]),
    ).toEqual([[attached.run.id, attached.run.workflowName, 1]]);
    const gone = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId,
    });
    strictEqual(gone._tag, "WorkflowNotEligible");
  });

  /**
   * The one thing manual attach does not override. `Domain.orderIsOpen`
   * carries the reasoning; this is the rule at the callable.
   */
  it("manual attach is refused on a cancelled or fulfilled order and allowed on an unpaid one", async () => {
    const attachTo = async (shop: string, order: Partial<Domain.ShopOrder>) => {
      const team = await seedTeam(shop, "Engraving");
      await seedOrder(shop, Date.now() - 86_400_000, [], order);
      const agent = await getAgentByName(env.SHOP_AGENT, shop);
      const created = await agent.createWorkflow({
        name: "Engrave",
        tag: "engrave",
      });
      if (created._tag !== "Ok") throw new Error(created._tag);
      const workflowId = created.workflow.id;
      await agent.addStep({ workflowId, name: "Engrave", teamId: team.id });
      const applied = await agent.applyDraft({ workflowId });
      if (applied._tag !== "Ok") throw new Error(applied._tag);
      await agent.setWorkflowOn({ workflowId, on: true });
      return agent.merchantAttachWorkflow({
        lineItemId: "gid://shopify/LineItem/1",
        workflowId,
      });
    };

    const cancelled = await attachTo("wf-attach-cancelled.myshopify.com", {
      cancelledAt: Date.now(),
    });
    strictEqual(cancelled._tag, "OrderClosed");

    const fulfilled = await attachTo("wf-attach-fulfilled.myshopify.com", {
      fulfillmentStatus: "FULFILLED",
    });
    strictEqual(fulfilled._tag, "OrderClosed");

    // Unpaid is the merchant's judgement to make: work may start on a
    // deposit, which is exactly what automatic starts withhold.
    const unpaid = await attachTo("wf-attach-unpaid.myshopify.com", {
      fullyPaid: false,
    });
    strictEqual(unpaid._tag, "Ok");
  });

  it("merchantAttachWorkflow over an open run deletes it and names it as replaced; over a cancelled item it starts fresh, even the same workflow", async () => {
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

    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: first.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);

    const replaced = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: second.id,
    });
    if (replaced._tag !== "Ok") throw new Error(replaced._tag);
    strictEqual(replaced.replaced?.id, attached.run.id);
    strictEqual(replaced.replaced?.workflowName, "Engraving");
    strictEqual(replaced.run.workflowName, "Rush");

    // The replaced run is gone, not kept beside the new one.
    const afterChange = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    deepStrictEqual(
      afterChange.map(({ run }) => run.id),
      [replaced.run.id],
    );

    expect(await agent.merchantCancelRun({ runId: replaced.run.id })).toEqual({
      _tag: "Ok",
    });
    // Rush again, the workflow just cancelled: a fresh run over the closed one.
    const again = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: second.id,
    });
    if (again._tag !== "Ok") throw new Error(again._tag);
    strictEqual(again.replaced, null);
    strictEqual(again.run.state, "open");
    expect(again.run.id).not.toBe(replaced.run.id);
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
      workflowName: "Engraving",
    });
    // Edit tag: the same refusal on an existing workflow.
    expect(
      await agent.updateWorkflowTag({ workflowId: other.id, tag: "engraved" }),
    ).toEqual({
      _tag: "TagTaken",
      tag: "engraved",
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
      workflowName: "Engraving",
    });

    // The switch and Apply say nothing about tags: both are still on.
    const off = await agent.setWorkflowOn({
      workflowId: other.id,
      on: false,
    });
    strictEqual(off._tag, "Ok");
    const backOn = await agent.setWorkflowOn({
      workflowId: other.id,
      on: true,
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

  it("turning one of two matching workflows off creates the survivor's run", async () => {
    const shop = "wf-multi-match.myshopify.com";
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
    await seedOrder(shop, Date.now() + 60 * 60 * 1000, ["engraved", "rush"]);

    // Turn on again reconciles every stored order; the multi-match holds.
    const nudged = await agent.setWorkflowOn({
      workflowId: keeper.id,
      on: true,
    });
    if (nudged._tag !== "Ok") throw new Error(nudged._tag);
    expect(
      await agent.merchantListRunsForOrder({
        orderId: "gid://shopify/Order/1",
      }),
    ).toHaveLength(0);

    const off = await agent.setWorkflowOn({
      workflowId: rival.id,
      on: false,
    });
    if (off._tag !== "Ok") throw new Error(off._tag);
    const runs = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(runs.map((d) => d.run.workflowId)).toEqual([keeper.id]);
  });

  it("deleting one of two matching workflows creates the survivor's run", async () => {
    const shop = "wf-delete-multi-match.myshopify.com";
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
    const keeper = await build("Engraving", "engraved");
    const rival = await build("Rush", "rush");
    await seedOrder(shop, Date.now(), ["engraved", "rush"]);
    await agent.setWorkflowOn({ workflowId: keeper.id, on: true });
    expect(
      await agent.merchantListRunsForOrder({
        orderId: "gid://shopify/Order/1",
      }),
    ).toHaveLength(0);

    expect(await agent.removeWorkflow({ workflowId: rival.id })).toEqual({
      _tag: "Deleted",
    });
    const runs = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(runs.map((d) => d.run.workflowId)).toEqual([keeper.id]);
  });

  it("deleting a workflow leaves its runs to carry on", async () => {
    const shop = "wf-delete-own-runs.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engraving",
      tag: "engraved",
    });
    if (created._tag !== "Ok") throw new Error(created._tag);
    await agent.addStep({
      workflowId: created.workflow.id,
      name: "Do it",
      teamId: team.id,
    });
    await goLive(agent, created.workflow.id);
    await seedOrder(shop, Date.now(), ["engraved"]);
    await agent.setWorkflowOn({ workflowId: created.workflow.id, on: true });
    const [before] = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(before?.run.state).toBe("open");

    expect(
      await agent.removeWorkflow({ workflowId: created.workflow.id }),
    ).toEqual({ _tag: "Deleted" });
    const [after] = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    // The run copied its definition: it keeps its state, its tasks and the
    // workflow's name, with no workflow left to read them from.
    expect(after?.run.id).toBe(before?.run.id);
    expect(after?.run.state).toBe("open");
    expect(after?.run.workflowName).toBe("Engraving");
    expect(after?.tasks.map((task) => task.name)).toEqual(["Do it"]);
  });

  it("every order in a pass sees the same eligible snapshot", async () => {
    const shop = "wf-snapshot.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engraving",
      tag: "engraved",
    });
    if (created._tag !== "Ok") throw new Error(created._tag);
    await agent.addStep({
      workflowId: created.workflow.id,
      name: "Do it",
      teamId: team.id,
    });
    await goLive(agent, created.workflow.id);
    // Deleting this one is the trigger for the reconcile all below.
    const spare = await agent.createWorkflow({ name: "Spare", tag: "spare" });
    if (spare._tag !== "Ok") throw new Error(spare._tag);
    // Stored without a pass, so the reconcile all below is the first to see
    // them.
    await seedOrder(shop, Date.now(), ["engraved"], {}, {}, 1);
    await seedOrder(shop, Date.now(), ["engraved"], {}, {}, 2);

    // Shop work over the object's storage, with the D1 team read wrapped:
    // the team is deleted the moment it has been read, so a pass that read
    // the teams again for its second order would find the workflow no
    // longer eligible there and create one run, not two.
    const reads = await runInDurableObject(
      env.SHOP_AGENT.get(env.SHOP_AGENT.idFromName(shop)),
      (_instance, state) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const reads = yield* Ref.make(0);
            const repository = Layer.effect(
              Repository,
              Effect.gen(function* () {
                const real = yield* Repository;
                return {
                  ...real,
                  listTeams: (params: { readonly shop: Domain.Shop }) =>
                    real.listTeams(params).pipe(
                      Effect.tap(() =>
                        Ref.update(reads, (n) => n + 1).pipe(
                          Effect.andThen(
                            real
                              .deleteTeam({
                                shop: params.shop,
                                id: team.id,
                              })
                              .pipe(Effect.ignore),
                          ),
                        ),
                      ),
                    ),
                };
              }),
            ).pipe(Layer.provide(layer));
            const host = Layer.succeed(ShopAgentHost, {
              shop: () => shop,
              publish: () => Effect.void,
              setSubscription: () => Effect.void,
              closeMemberConnections: () => Effect.void,
              databaseSize: Effect.succeed(0),
              syncInFlight: () => Effect.succeed(false),
            });
            yield* ShopWorkAgent.pipe(
              Effect.flatMap((shopWork) =>
                shopWork.removeWorkflow({ workflowId: spare.workflow.id }),
              ),
              Effect.provide(
                ShopWorkAgent.layer.pipe(
                  Layer.provideMerge(BillingAgent.layer),
                  Layer.provideMerge(
                    Layer.mergeAll(
                      host,
                      repository,
                      makeEnvLayer(env),
                      Layer.provide(
                        ShopifyAppEvents.layerNoDeps,
                        FetchHttpClient.layer,
                      ),
                      Layer.mergeAll(
                        WorkflowRepository.layer,
                        RunRepository.layer,
                      ).pipe(
                        Layer.provideMerge(OrderRepository.layer),
                        Layer.provideMerge(
                          SqliteClient.layer({ storage: state.storage }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
            return yield* Ref.get(reads);
          }),
        ),
    );
    strictEqual(reads, 1);
    strictEqual(await teamExists(shop, team.id), false);
    for (const orderId of ["gid://shopify/Order/1", "gid://shopify/Order/2"])
      expect(await agent.merchantListRunsForOrder({ orderId })).toHaveLength(1);
  });

  it("no reconcile count reaches a screen", async () => {
    const shop = "wf-no-count.myshopify.com";
    const team = await seedTeam(shop, "Engraving");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const created = await agent.createWorkflow({
      name: "Engraving",
      tag: "engraved",
    });
    if (created._tag !== "Ok") throw new Error(created._tag);
    const workflowId = created.workflow.id;
    await agent.addStep({ workflowId, name: "Do it", teamId: team.id });
    await seedOrder(shop, Date.now(), ["engraved"]);
    // Both writes reconcile all and create a run; what they hand the screen
    // is the workflow and nothing a pass counted.
    const applied = await agent.applyDraft({ workflowId });
    if (applied._tag !== "Ok") throw new Error(applied._tag);
    expect(Object.keys(applied).toSorted()).toEqual(["_tag", "workflow"]);
    const on = await agent.setWorkflowOn({ workflowId, on: true });
    if (on._tag !== "Ok") throw new Error(on._tag);
    expect(Object.keys(on).toSorted()).toEqual(["_tag", "workflow"]);
    expect(
      await agent.merchantListRunsForOrder({
        orderId: "gid://shopify/Order/1",
      }),
    ).toHaveLength(1);
  });

  it("deleting a team creates the survivor's run on an item two workflows had matched", async () => {
    const shop = "wf-delete-team.myshopify.com";
    const kept = await seedTeam(shop, "Engraving");
    const gone = await seedTeam(shop, "Rush");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const build = async (workflowName: string, tag: string, teamId: string) => {
      const created = await agent.createWorkflow({ name: workflowName, tag });
      if (created._tag !== "Ok") throw new Error(created._tag);
      await agent.addStep({
        workflowId: created.workflow.id,
        name: "Do it",
        teamId,
      });
      await goLive(agent, created.workflow.id);
      return created.workflow;
    };
    const keeper = await build("Engraving", "engraved", kept.id);
    await build("Rush", "rush", gone.id);
    await seedOrder(shop, Date.now(), ["engraved", "rush"]);
    expect(
      await agent.merchantListRunsForOrder({
        orderId: "gid://shopify/Order/1",
      }),
    ).toHaveLength(0);

    expect(await agent.deleteTeam({ teamId: gone.id })).toEqual({
      _tag: "Deleted",
    });
    const runs = await agent.merchantListRunsForOrder({
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
    // Carrying a tag no workflow has yet.
    await seedOrder(shop, Date.now() + 60 * 60 * 1000, ["laser"]);
    expect(
      await agent.merchantListRunsForOrder({
        orderId: "gid://shopify/Order/1",
      }),
    ).toHaveLength(0);

    // The retag is the definition write that makes the item match; the
    // stored order starts now rather than on Shopify's next edit.
    const retagged = await agent.updateWorkflowTag({
      workflowId,
      tag: "laser",
    });
    strictEqual(retagged._tag, "Ok");
    const runs = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    expect(runs.map((d) => d.run.workflowId)).toEqual([workflowId]);
  });

  it("merchantCancelRun / memberMarkTaskDone map refusals to results", async () => {
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
    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: created.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const runId = attached.run.id;

    expect(await agent.merchantCancelRun({ runId: "nope" })).toEqual({
      _tag: "NotFound",
    });

    const [detail] = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    const runTaskId = detail?.tasks[0]?.id ?? "";
    const stranger = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: ["x"],
    });
    expect(await stranger.markTaskDone({ runTaskId })).toEqual({
      _tag: "NotAllowed",
    });
    stranger.close();
    expect(await runListItems(agent, [team.id])).toHaveLength(1);
    const engraver = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: [team.id],
    });
    expect(await engraver.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });
    expect(await runListItems(agent, [team.id])).toHaveLength(0);
    // A done run offers no Cancel (`Domain.runActions`), and has no block to lift.
    expect(await agent.merchantCancelRun({ runId })).toEqual({
      _tag: "NotAllowed",
    });
    expect(await engraver.unblockRun({ runId })).toEqual({
      _tag: "NotAllowed",
    });
    engraver.close();
    // Reopened, it is open again and cancels once; the closed run left
    // behind offers no second Cancel.
    const merchant = await openMerchantSocket(shop);
    expect(await merchant.reopenTask({ runTaskId })).toEqual({
      _tag: "Ok",
    });
    merchant.close();
    expect(await agent.merchantCancelRun({ runId })).toEqual({ _tag: "Ok" });
    expect(await agent.merchantCancelRun({ runId })).toEqual({
      _tag: "NotAllowed",
    });
  });

  it("unblock lifts a block for the team that holds a current task or the merchant, and is refused once nothing is blocked", async () => {
    const shop = "wf-unblock.myshopify.com";
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
    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: created.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const runId = attached.run.id;
    const engraver = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: [team.id],
    });
    const stranger = await openMemberSocket(shop, {
      memberId: "m2",
      memberEmail: "m2@example.com",
      teamIds: ["x"],
    });
    // Nothing is blocked yet: Unblock is not offered (`Domain.runActions`).
    expect(await engraver.unblockRun({ runId })).toEqual({
      _tag: "NotAllowed",
    });
    expect(await engraver.blockRun({ runId, reason: "no stock" })).toEqual({
      _tag: "Ok",
    });
    expect(await stranger.unblockRun({ runId })).toEqual({
      _tag: "NotAllowed",
    });
    expect(await engraver.unblockRun({ runId })).toEqual({ _tag: "Ok" });
    const [unblocked] = await runListItems(agent, [team.id]);
    strictEqual(unblocked?.run.blockedAt, null);
    strictEqual(unblocked?.run.blockReason, null);
    strictEqual(unblocked?.run.blockedBy, null);
    expect(await engraver.blockRun({ runId, reason: null })).toEqual({
      _tag: "Ok",
    });
    engraver.close();
    stranger.close();
    const merchant = await openMerchantSocket(shop);
    expect(await merchant.unblockRun({ runId })).toEqual({ _tag: "Ok" });
    expect(await merchant.unblockRun({ runId })).toEqual({
      _tag: "NotAllowed",
    });
    merchant.close();
  });

  /**
   * The member-area server fns cannot be driven end to end here (their route
   * needs a Shopify session the isolate cannot stub), so the kind check they
   * delegate to is asserted at the object: a team outside the caller's is
   * `NotAllowed` for every action, and `listRuns` returns the snapshotted
   * `startedByEmail`.
   */
  it("startTask / setRunNote / blockRun refuse another team's work; listRuns reads startedByEmail after the member is deleted", async () => {
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
    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: created.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const runId = attached.run.id;
    const [detail] = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    const runTaskId = detail?.tasks[0]?.id ?? "";

    const outsider = await openMemberSocket(shop, {
      memberId,
      memberEmail,
      teamIds: ["x"],
    });
    expect(await outsider.startTask({ runTaskId })).toEqual({
      _tag: "NotAllowed",
    });
    expect(await outsider.setRunNote({ runId, note: "hi" })).toEqual({
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
    expect(await engraver.startTask({ runTaskId })).toEqual({ _tag: "Ok" });
    // Their own started task, so it is Started by you for them — which is the state the
    // snapshotted email has to survive the delete in.
    const [item] = await runListItems(agent, [team.id], {
      memberEmail,
      state: "started_by_you",
    });
    strictEqual(item?.run.state, "open");
    strictEqual(item?.tasks[0]?.startedByEmail, "w@example.com");
    strictEqual(item?.stepCount, 1);
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
    const [deletedItem] = await runListItems(agent, [team.id], {
      memberEmail,
      state: "started_by_you",
    });
    strictEqual(deletedItem?.tasks[0]?.startedByEmail, "w@example.com");
    expect(
      await engraver.setRunNote({
        runId,
        note: " spelling confirmed ",
      }),
    ).toEqual({ _tag: "Ok" });
    expect(
      await engraver.blockRun({ runId, reason: "waiting on stock" }),
    ).toEqual({ _tag: "Ok" });
    engraver.close();
    const [blocked] = await runListItems(agent, [team.id]);
    strictEqual(
      blocked !== undefined && Domain.runIsBlocked(blocked.run),
      true,
    );
    strictEqual(blocked?.run.blockReason, "waiting on stock");
    deepStrictEqual<unknown>(blocked?.run.blockedBy, {
      role: "member",
      email: memberEmail,
    });
    strictEqual(blocked?.run.note, "spelling confirmed");
  });

  it("assignRunTaskTeam puts an unassigned open task on the new team's list; the order page lists the teams", async () => {
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
    const attached = await agent.merchantAttachWorkflow({
      lineItemId: "gid://shopify/LineItem/1",
      workflowId: created.workflow.id,
    });
    if (attached._tag !== "Ok") throw new Error(attached._tag);
    const [detail] = await agent.merchantListRunsForOrder({
      orderId: "gid://shopify/Order/1",
    });
    const runTaskId = detail?.tasks[0]?.id ?? "";

    await agent.deleteTeam({ teamId: a.id });
    expect(await runListItems(agent, [a.id])).toEqual([]);
    const page = await agent.getOrderDetail({ legacyId: "1" });
    expect(page?.runs[0]?.tasks[0]?.teamId).toBe(null);
    expect(page?.teams).toEqual([]);

    expect(
      await agent.merchantAssignRunTaskTeam({ runTaskId, teamId: a.id }),
    ).toEqual({
      _tag: "TeamNotFound",
    });
    const b = await seedTeam(shop, "B");
    expect(
      await agent.merchantAssignRunTaskTeam({ runTaskId, teamId: b.id }),
    ).toEqual({
      _tag: "Assigned",
    });
    const [item] = await runListItems(agent, [b.id]);
    strictEqual(item?.tasks[0]?.id, runTaskId);
    strictEqual(item?.tasks[0]?.teamName, "B");
    const after = await agent.getOrderDetail({ legacyId: "1" });
    expect(after?.teams.map((t) => [t.name, t.memberCount])).toEqual([
      ["B", 0],
    ]);
    // A *started* task can be assigned too: only teamId/teamName move, so history
    // keeps whoever began it and the new team takes it to done.
    const inB = await openMemberSocket(shop, {
      memberId: "m1",
      memberEmail: "m1@example.com",
      teamIds: [b.id],
    });
    expect(await inB.startTask({ runTaskId })).toEqual({ _tag: "Ok" });
    inB.close();
    const c = await seedTeam(shop, "C");
    expect(
      await agent.merchantAssignRunTaskTeam({ runTaskId, teamId: c.id }),
    ).toEqual({
      _tag: "Assigned",
    });
    expect(await runListItems(agent, [b.id])).toEqual([]);
    const [moved] = await runListItems(agent, [c.id]);
    strictEqual(moved?.tasks[0]?.id, runTaskId);
    strictEqual(moved?.tasks[0]?.teamName, "C");
    strictEqual(moved?.tasks[0]?.startedByEmail, "m1@example.com");
    strictEqual(moved?.tasks[0]?.startedAt !== null, true);

    const inC = await openMemberSocket(shop, {
      memberId: "m2",
      memberEmail: "m2@example.com",
      teamIds: [c.id],
    });
    expect(await inC.markTaskDone({ runTaskId })).toEqual({ _tag: "Ok" });
    inC.close();
    const finished = await agent.getOrderDetail({ legacyId: "1" });
    strictEqual(finished?.runs[0]?.tasks[0]?.doneByEmail, "m2@example.com");
    strictEqual(finished?.runs[0]?.tasks[0]?.startedByEmail, "m1@example.com");
    // A done task keeps its team: `Domain.taskActions`' `assign` is
    // false, so the action set refuses before the repository's own guard.
    expect(
      await agent.merchantAssignRunTaskTeam({ runTaskId, teamId: c.id }),
    ).toEqual({
      _tag: "NotAllowed",
    });
    expect(
      await agent.merchantAssignRunTaskTeam({
        runTaskId: "nope",
        teamId: b.id,
      }),
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

/** The index's own read, unfiltered, so a row can be put through `Domain.orderPosition`. */
const ordersPage = async (
  agent: Awaited<ReturnType<typeof getAgentByName<Cloudflare.Env, ShopAgent>>>,
) => {
  const data = await agent.subscribeOrders({
    subscriberId: "seed-test",
    limit: 50,
    cursor: null,
    q: null,
    position: null,
    issues: false,
    team: null,
  });
  return data.page.orders;
};

const twoTask = (name: string, tag: string, teamId: string) => ({
  name,
  tag,
  tasks: [
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
        twoTask("Board", "board", team.id),
        twoTask("Ring", "ring", team.id),
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
    const runs = await agent.merchantListRunsForOrder({
      orderId: seedOrderId(1),
    });
    expect(
      runs
        .map(({ run, tasks }) => ({
          workflow: run.workflowName,
          state: run.state,
          done: tasks.filter((task) => task.doneAt !== null).length,
        }))
        .toSorted((a, b) => a.workflow.localeCompare(b.workflow)),
    ).toEqual([
      { workflow: "Board", state: "done", done: 2 },
      { workflow: "Ring", state: "open", done: 1 },
    ]);
  });

  it("seedOrders chooses a workflow for an item two claim, and the order stops asking", async () => {
    const shop = "seed-choose.myshopify.com";
    const team = await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    const seeded = await agent.seedWorkflows({
      workflows: [
        twoTask("Board", "board", team.id),
        twoTask("Rush order", "rush", team.id),
      ],
    });
    const boardId = seeded.find(({ name }) => name === "Board")?.id;
    if (boardId === undefined) throw new Error("seedWorkflows returned no id");

    const multiMatchItem = {
      title: "Board",
      quantity: 1,
      tags: ["board", "rush"],
    };
    await agent.seedOrders({
      ...seedMember,
      orders: [{ n: 1, lineItems: [multiMatchItem] }],
    });
    const unrouted = await agent.merchantListRunsForOrder({
      orderId: seedOrderId(1),
    });
    strictEqual(unrouted.length, 0);
    const [asking] = await ordersPage(agent);
    deepStrictEqual(asking === undefined ? null : Domain.orderIssues(asking), [
      "multi_match",
    ]);

    await agent.seedOrders({
      ...seedMember,
      orders: [
        { n: 1, lineItems: [{ ...multiMatchItem, workflowId: boardId }] },
      ],
    });
    const runs = await agent.merchantListRunsForOrder({
      orderId: seedOrderId(1),
    });
    expect(runs.map(({ run }) => run.workflowName)).toEqual(["Board"]);
    const [chosen] = await ordersPage(agent);
    strictEqual(
      chosen === undefined ? null : Domain.orderPosition(chosen),
      "making",
    );
    strictEqual(
      chosen === undefined
        ? null
        : Domain.orderIssues(chosen).includes("multi_match"),
      false,
    );
  });

  it("seedOrders applies `after` once the work has started, so a cancel closes the run and a quantity change resizes it", async () => {
    const shop = "seed-after.myshopify.com";
    const team = await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await agent.seedWorkflows({
      workflows: [twoTask("Board", "board", team.id)],
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
          after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
          lineItems: [{ title: "Board", quantity: 2, tags: ["board"] }],
        },
      ],
    });
    const runOf = async (n: number) => {
      const runs = await agent.merchantListRunsForOrder({
        orderId: seedOrderId(n),
      });
      return runs[0]?.run;
    };
    const cancelled = await runOf(1);
    strictEqual(cancelled?.state, "closed");
    strictEqual(cancelled?.closedReason, "order_cancelled");
    const resized = await runOf(2);
    strictEqual(resized?.quantity, 1);
  });

  it("reseeding leaves the usage counter unchanged", async () => {
    const shop = "seed-usage.myshopify.com";
    const team = await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    // The meter counts an order when its first run is created, so the seed
    // includes a workflow its orders match; the runs start and nothing
    // is counted.
    await agent.seedWorkflows({
      workflows: [twoTask("Board", "board", team.id)],
    });
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
      return usage.ordersThisCycle;
    };
    await agent.seedOrders({ ...seedMember, orders });
    strictEqual(await countedOrders(), 0);
    const usage = await agent.getUsage();
    strictEqual(usage.pendingUsageEvents, 0);
    // Five orders the seed does not own, counted the way a sync would count
    // them: a reseed leaves their share alone.
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
      (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql.exec(
        "update ShopUsage set ordersThisCycle = ordersThisCycle + 5 where id = 1",
      );
    });
    await agent.seedOrders({ ...seedMember, orders });
    await agent.seedOrders({ ...seedMember, orders });
    strictEqual(await countedOrders(), 5);
  });

  it("the seed writes countedAt on every order it inserts", async () => {
    const shop = "seed-counted.myshopify.com";
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    await agent.seedOrders({
      ...seedMember,
      orders: [
        { n: 1, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] },
        { n: 2, lineItems: [{ title: "Board", quantity: 1, tags: ["board"] }] },
      ],
    });
    const counted = await runInDurableObject(
      env.SHOP_AGENT.getByName(shop),
      (instance) =>
        (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql
          .exec("select countedAt from ShopOrder order by id")
          .toArray()
          .map((row) => row.countedAt),
    );
    deepStrictEqual(counted, [0, 0]);
  });

  it("a reseed reconciles the orders it did not replace", async () => {
    const shop = "seed-reconcile.myshopify.com";
    const team = await seedTeam(shop, "Bench");
    const agent = await getAgentByName(env.SHOP_AGENT, shop);
    // A synced order, written past the seed so the reseed below has something
    // it does not own: this is the row the fixture leaves alone.
    await runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
      const { sql } = (instance as unknown as { ctx: DurableObjectState }).ctx
        .storage;
      sql.exec(
        `insert or replace into ShopOrder
           (id, legacyId, name, processedAt, updatedAt, cancelledAt,
            fulfillmentStatus, fullyPaid, note, syncedAt)
         values ('gid://shopify/Order/synced-1', 'synced-1', '#5001', 1, 1, null,
                 'UNFULFILLED', 1, null, 1)`,
      );
      sql.exec(
        `insert or replace into OrderLineItem
           (id, orderId, title, variantTitle, sku, quantity,
            currentQuantity, productTags, properties)
         values ('gid://shopify/Order/synced-1/line-1', 'gid://shopify/Order/synced-1',
                 'Board', null, null, 1, 1, '["board"]', '[]')`,
      );
    });

    // A fixture that says nothing about orders still replaces every workflow,
    // and `seedOrders` runs whatever the caller sent — here, nothing.
    await agent.seedWorkflows({
      workflows: [twoTask("Board", "board", team.id)],
    });
    await agent.seedOrders({ ...seedMember, orders: [] });

    const detail = await agent.getOrderDetail({ legacyId: "synced-1" });
    // The replacement, whose tag the item carries, is the one match, and
    // the reseed's reconcile created its run.
    expect(detail?.runs.map(({ run }) => run.workflowName)).toEqual(["Board"]);
  });
});
