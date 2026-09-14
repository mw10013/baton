import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  memberHeaders,
  merchantHeaders,
  openAgentSocket,
} from "./agent-socket";

/**
 * The role gate over the whole `@callable()` surface, enumerated rather than
 * sampled.
 *
 * This file is what makes an ungated callable a failing build: the first test
 * asks the agents SDK which prototype methods carry the decorator and compares
 * that set against {@link CALLABLE_ROLES} below, so adding `@callable()`
 * without deciding who may reach it breaks here rather than shipping a method
 * a member can call. The remaining tests then prove the declared role is the
 * one actually enforced.
 *
 * Arguments are deliberately garbage (`{}`): the guard runs before the input is
 * decoded, so a caller who may not be here never learns anything from the shape
 * of a schema error. The positive control at the bottom is the other half of
 * that claim — the *right* role on the same garbage input gets a decode failure,
 * not a refusal.
 */
const CALLABLE_ROLES = {
  unsubscribe: "any",
  subscribeQueue: "member",
  startStep: "member",
  completeStep: "member",
  setStepNote: "member",
  blockRun: "member",
  dismissFlag: "member",
  uncompleteStep: "member",
  subscribeRun: "member",
  syncOrders: "merchant",
  resyncOrder: "merchant",
  subscribeOrders: "merchant",
  createWorkflow: "merchant",
  duplicateWorkflow: "merchant",
  updateWorkflow: "merchant",
  updateWorkflowTags: "merchant",
  createDraft: "merchant",
  applyDraft: "merchant",
  discardDraft: "merchant",
  setWorkflowActive: "merchant",
  setWorkflowActivatedAt: "merchant",
  countWaitingOrders: "merchant",
  removeWorkflow: "merchant",
  subscribeOrder: "merchant",
  listRunsForOrder: "merchant",
  attachWorkflow: "merchant",
  cancelRun: "merchant",
  uncancelRun: "merchant",
  addStep: "merchant",
  addParallelStep: "merchant",
  updateStep: "merchant",
  moveStep: "merchant",
  separateStep: "merchant",
  joinStep: "merchant",
  removeStep: "merchant",
  deleteTeam: "merchant",
  assignRunStepTeam: "merchant",
  seedWorkflows: "merchant",
  seedOrders: "merchant",
} as const satisfies Record<string, "merchant" | "member" | "any">;

const roleOf = (name: string) =>
  CALLABLE_ROLES[name as keyof typeof CALLABLE_ROLES] as
    | "merchant"
    | "member"
    | "any"
    | undefined;

const namesWithRole = (role: "merchant" | "member" | "any") =>
  Object.keys(CALLABLE_ROLES).filter((name) => roleOf(name) === role);

/**
 * The decorated set, straight from the SDK's own `callableMetadata` WeakMap via
 * the private predicate its RPC dispatcher consults. Reading the same source
 * the dispatcher reads is the point: a list maintained by hand here could drift
 * from what is actually reachable.
 */
const decoratedCallables = (shop: string) =>
  runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) => {
    /* oxlint-disable-next-line no-underscore-dangle -- the SDK's own predicate over its callable WeakMap; there is no public equivalent */
    const { _isCallable } = instance as unknown as {
      _isCallable: (method: string) => boolean;
    };
    const isCallable = _isCallable.bind(instance);
    return Object.getOwnPropertyNames(Object.getPrototypeOf(instance))
      .filter((name) => name !== "constructor" && isCallable(name))
      .toSorted();
  });

const memberSocket = (shop: string) =>
  openAgentSocket(
    shop,
    memberHeaders({
      memberId: "member-gate",
      memberEmail: "maker@example.com",
      teamIds: ["team-1"],
    }),
  );

describe("ShopAgent callable role gate", () => {
  it("declares a role for exactly the decorated methods", async () => {
    const shop = "callables-inventory.myshopify.com";
    // A socket first, so the object is awake and initialized before the walk.
    const socket = await openAgentSocket(shop, merchantHeaders());
    await socket.waitForMessage((data) => data.includes("cf_agent_identity"));
    expect(await decoratedCallables(shop)).toEqual(
      Object.keys(CALLABLE_ROLES).toSorted(),
    );
    socket.close();
  });

  it("refuses every merchant callable on a member connection", async () => {
    const shop = "callables-member.myshopify.com";
    const socket = await memberSocket(shop);
    for (const name of namesWithRole("merchant")) {
      await expect(
        socket.call(name, {}),
        `${name} must refuse a member connection`,
      ).rejects.toThrow(/forbidden/iu);
    }
    socket.close();
  });

  it("refuses every member callable on a merchant connection", async () => {
    const names = namesWithRole("member");
    if (names.length === 0) return;
    const shop = "callables-merchant.myshopify.com";
    const socket = await openAgentSocket(shop, merchantHeaders());
    for (const name of names) {
      await expect(
        socket.call(name, {}),
        `${name} must refuse a merchant connection`,
      ).rejects.toThrow(/forbidden/iu);
    }
    socket.close();
  });

  it("admits the shared callables on either role", async () => {
    for (const [shop, headers] of [
      ["callables-any-merchant.myshopify.com", merchantHeaders()],
      [
        "callables-any-member.myshopify.com",
        memberHeaders({
          memberId: "member-any",
          memberEmail: "maker@example.com",
          teamIds: [],
        }),
      ],
    ] as const) {
      const socket = await openAgentSocket(shop, headers);
      for (const name of namesWithRole("any"))
        await expect(
          socket.call(name, { subscriberId: "sub-1" }),
        ).resolves.toBeUndefined();
      socket.close();
    }
  });

  /**
   * The guard is about the caller, not the payload: the same empty object that
   * a member is refused for gets past the gate on a merchant connection and
   * fails on its own merits in the decoder.
   */
  it("lets the right role through to the decoder", async () => {
    const shop = "callables-control.myshopify.com";
    const socket = await openAgentSocket(shop, merchantHeaders());
    await expect(socket.call("createWorkflow", {})).rejects.not.toThrow(
      /forbidden/iu,
    );
    socket.close();
  });
});
