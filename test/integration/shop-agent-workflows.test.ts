import { strictEqual } from "@effect/vitest/utils";
import { getAgentByName } from "agents";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

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
