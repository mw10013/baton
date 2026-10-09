import { SqliteClient } from "@effect/sql-sqlite-do";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { OrderRepository } from "@/lib/OrderRepository";
import { Repository } from "@/lib/Repository";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";

import {
  emailOf,
  resetMemberTables,
  run,
  seedShop,
  shopOf,
  teamNameOf,
} from "./member-fixtures";

/**
 * The home page's setup facts (`Domain.SetupFacts`) against a real object and
 * local D1: the D1 fact through `Repository`, the object's two through the
 * plain RPC the home page's loader calls. Every shop name is unique per test,
 * because an object keeps its SQLite across tests in one file.
 */

const LINE_ITEM_ID = "gid://shopify/LineItem/1";

/** Stores one open, paid order with one item, `#1001`. */
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
              id: "gid://shopify/Order/1",
              legacyId: "1",
              name: "#1001",
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
                id: LINE_ITEM_ID,
                orderId: "gid://shopify/Order/1",
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

/** The shop's session row and one team, with a member on it when `withMember`. */
const seedTeam = (shopName: string, withMember: boolean) =>
  Effect.runPromise(
    run(
      Effect.gen(function* () {
        const shop = shopOf(shopName);
        yield* seedShop(shop);
        const repository = yield* Repository;
        const team = yield* repository.createTeam({
          shop,
          name: teamNameOf("Engraving"),
        });
        if (withMember) {
          const email = emailOf("alice@example.com");
          yield* repository.addMember({ shop, email });
          const access = yield* repository.findMemberAccess({ shop, email });
          if (Option.isNone(access))
            return yield* Effect.die("member missing right after addMember");
          yield* repository.addMemberTeams({
            shop,
            memberId: access.value.memberId,
            teamIds: [team.id],
          });
        }
        return team;
      }),
    ),
  );

/** A one-task workflow on `teamId`, applied and turned on. */
const createActiveWorkflow = async (shop: string, teamId: Domain.TeamId) => {
  const agent = env.SHOP_AGENT.getByName(shop);
  const created = await agent.createWorkflow({
    name: "Engrave",
    tag: "engrave",
  });
  if (created._tag !== "Ok") throw new Error(created._tag);
  const workflowId = created.workflow.id;
  await agent.addStep({ workflowId, name: "Engrave", teamId });
  const applied = await agent.applyDraft({ workflowId });
  if (applied._tag !== "Ok") throw new Error(applied._tag);
  const on = await agent.setWorkflowState({ workflowId, state: "active" });
  if (on._tag !== "Ok") throw new Error(on._tag);
  return workflowId;
};

/** Stores an order and attaches the workflow to its item: the shop's first run. */
const startRun = async (shop: string, workflowId: string) => {
  await seedOrder(shop);
  const attached = await env.SHOP_AGENT.getByName(shop).merchantAttachWorkflow({
    lineItemId: LINE_ITEM_ID,
    workflowId,
  });
  if (attached._tag !== "Ok") throw new Error(attached._tag);
  return attached.run.id;
};

/** The three facts, read the way the home page's loader reads them. */
const setupFacts = async (shop: string): Promise<Domain.SetupFacts> => ({
  teamWithMember: await Effect.runPromise(
    run(
      Repository.pipe(
        Effect.flatMap((repository) =>
          repository.teamWithMemberExists(shopOf(shop)),
        ),
      ),
    ),
  ),
  ...(await env.SHOP_AGENT.getByName(shop).getWorkflowSetupFacts()),
});

/** Every fact holding: a team with a member, an active workflow on it, and a run. */
const completeSetup = async (shop: string) => {
  const team = await seedTeam(shop, true);
  const workflowId = await createActiveWorkflow(shop, team.id);
  const runId = await startRun(shop, workflowId);
  return { workflowId, runId };
};

afterEach(async () => {
  await resetMemberTables();
});

describe("the setup facts", () => {
  it("each step is undone on an empty shop and done once its fact holds", async () => {
    const shop = "setup-steps.myshopify.com";
    await Effect.runPromise(run(seedShop(shopOf(shop))));
    expect(await setupFacts(shop)).toEqual({
      teamWithMember: false,
      activeWorkflow: false,
      run: false,
    });

    const team = await seedTeam(shop, true);
    expect(await setupFacts(shop)).toEqual({
      teamWithMember: true,
      activeWorkflow: false,
      run: false,
    });

    const workflowId = await createActiveWorkflow(shop, team.id);
    expect(await setupFacts(shop)).toEqual({
      teamWithMember: true,
      activeWorkflow: true,
      run: false,
    });

    await startRun(shop, workflowId);
    const facts = await setupFacts(shop);
    expect(facts).toEqual({
      teamWithMember: true,
      activeWorkflow: true,
      run: true,
    });
    for (const fact of Domain.SETUP_FACTS)
      expect(Domain.setupFactHolds(facts, fact)).toBe(true);
  });

  it("a team with no member does not complete the first step", async () => {
    const shop = "setup-empty-team.myshopify.com";
    await seedTeam(shop, false);
    expect(
      Domain.setupFactHolds(await setupFacts(shop), "teamWithMember"),
    ).toBe(false);
  });

  it("the guide hides when all three hold", async () => {
    const shop = "setup-complete.myshopify.com";
    const team = await seedTeam(shop, true);
    const workflowId = await createActiveWorkflow(shop, team.id);
    expect(Domain.setupIsComplete(await setupFacts(shop))).toBe(false);
    await startRun(shop, workflowId);
    expect(Domain.setupIsComplete(await setupFacts(shop))).toBe(true);
  });

  it("the guide shows again when a fact stops holding", async () => {
    const shop = "setup-turned-off.myshopify.com";
    const { workflowId } = await completeSetup(shop);
    expect(Domain.setupIsComplete(await setupFacts(shop))).toBe(true);

    const off = await env.SHOP_AGENT.getByName(shop).setWorkflowState({
      workflowId,
      state: "inactive",
    });
    expect(off._tag).toBe("Ok");
    const facts = await setupFacts(shop);
    expect(Domain.setupFactHolds(facts, "activeWorkflow")).toBe(false);
    expect(Domain.setupIsComplete(facts)).toBe(false);
  });

  it("an item with a workflow in any state completes the third step", async () => {
    const shop = "setup-closed-run.myshopify.com";
    const { runId } = await completeSetup(shop);
    expect(
      await env.SHOP_AGENT.getByName(shop).merchantCancelRun({ runId }),
    ).toEqual({ _tag: "Ok" });
    expect(Domain.setupFactHolds(await setupFacts(shop), "run")).toBe(true);
  });

  it("the D1 fact ignores another shop's team", async () => {
    const shop = "setup-own-team.myshopify.com";
    const other = "setup-other-team.myshopify.com";
    await seedTeam(other, true);
    await Effect.runPromise(run(seedShop(shopOf(shop))));
    expect(
      Domain.setupFactHolds(await setupFacts(other), "teamWithMember"),
    ).toBe(true);
    expect(
      Domain.setupFactHolds(await setupFacts(shop), "teamWithMember"),
    ).toBe(false);
  });
});
