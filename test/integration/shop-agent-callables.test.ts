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
 *
 * `listOrders` and `getOrderDetail` are both callable and plain RPC: the
 * `"merchant"` role admits a merchant connection or a connectionless caller,
 * so one method serves the route loader through `ShopAgentClient` and the
 * live screen over the socket. The member reads cannot, since `teamIds`
 * comes off the connection, so `liveRuns` and `liveRun` are the socket
 * entry points and `listRuns` and `memberGetRun` stay plain RPC.
 */
const CALLABLE_ROLES = {
  liveRuns: "member",
  memberStartTask: "member",
  memberMarkTaskDone: "member",
  memberSetRunNote: "member",
  memberBlockRun: "member",
  memberUnblockRun: "member",
  memberReopenTask: "member",
  memberPutBackTask: "member",
  liveRun: "member",
  syncOpenOrders: "merchant",
  getUsage: "merchant",
  syncOrder: "merchant",
  listOrders: "merchant",
  createWorkflow: "merchant",
  duplicateWorkflow: "merchant",
  updateWorkflow: "merchant",
  updateWorkflowTag: "merchant",
  createDraft: "merchant",
  applyDraft: "merchant",
  discardDraft: "merchant",
  setWorkflowOn: "merchant",
  applyAndTurnOn: "merchant",
  removeWorkflow: "merchant",
  getOrderDetail: "merchant",
  merchantListRunsForOrder: "merchant",
  merchantAttachWorkflow: "merchant",
  merchantCancelRun: "merchant",
  merchantMarkTaskDone: "merchant",
  merchantReopenTask: "merchant",
  merchantPutBackTask: "merchant",
  merchantSetRunNote: "merchant",
  merchantBlockRun: "merchant",
  merchantUnblockRun: "merchant",
  addStep: "merchant",
  addTask: "merchant",
  updateTask: "merchant",
  moveTask: "merchant",
  separateTask: "merchant",
  joinTask: "merchant",
  removeTask: "merchant",
  deleteTeam: "merchant",
  merchantAssignRunTaskTeam: "merchant",
  seedWorkflows: "merchant",
  seedOrders: "merchant",
} as const satisfies Record<string, "merchant" | "member">;

const roleOf = (name: string) =>
  CALLABLE_ROLES[name as keyof typeof CALLABLE_ROLES] as
    | "merchant"
    | "member"
    | undefined;

const namesWithRole = (role: "merchant" | "member") =>
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

  /**
   * The Worker-only RPCs stay off the socket. Each carries an input a browser
   * must never supply — a billing cycle with its member count, a revoke —
   * and the first test would catch a stray decorator by set equality, but
   * naming them here is what says the omission is deliberate.
   */
  it("keeps the Worker's plain RPCs out of the callable surface", async () => {
    const shop = "callables-rpc.myshopify.com";
    const socket = await openAgentSocket(shop, merchantHeaders());
    await socket.waitForMessage((data) => data.includes("cf_agent_identity"));
    const callables = await decoratedCallables(shop);
    for (const name of [
      "setBillingCycle",
      "flushUsageEvents",
      "revokeAllConnections",
      "onOrdersStream",
    ])
      expect(callables, `${name} must not be @callable()`).not.toContain(name);
    socket.close();
  });

  it("the stream's callbacks are not callable from a socket, and the two sync buttons refuse a member", async () => {
    const shop = "callables-sync.myshopify.com";
    const merchant = await openAgentSocket(shop, merchantHeaders());
    await merchant.waitForMessage((data) => data.includes("cf_agent_identity"));
    const callables = await decoratedCallables(shop);
    expect(callables).toEqual(
      expect.arrayContaining(["syncOpenOrders", "syncOrder"]),
    );
    for (const name of [
      "onOrdersStream",
      "onOrdersSyncEmpty",
      "onOrdersSyncError",
    ]) {
      expect(callables, `${name} must not be @callable()`).not.toContain(name);
      await expect(
        merchant.call(name, { url: "https://example.test/orders.jsonl" }),
        `${name} must not answer a socket`,
      ).rejects.toThrow();
    }
    merchant.close();

    const member = await memberSocket(shop);
    for (const name of ["syncOpenOrders", "syncOrder"])
      await expect(
        member.call(name, {}),
        `${name} must refuse a member connection`,
      ).rejects.toThrow(/forbidden/iu);
    member.close();
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

describe("ShopAgent run callable names", () => {
  const RUN_WRITES = [
    "merchantAttachWorkflow",
    "merchantCancelRun",
    "merchantMarkTaskDone",
    "merchantReopenTask",
    "merchantPutBackTask",
    "merchantSetRunNote",
    "merchantBlockRun",
    "merchantUnblockRun",
    "merchantAssignRunTaskTeam",
    "memberStartTask",
    "memberMarkTaskDone",
    "memberReopenTask",
    "memberPutBackTask",
    "memberSetRunNote",
    "memberBlockRun",
    "memberUnblockRun",
  ] as const;

  it("every run-write callable is named <role><Verb>, where the role is the ConnectionRole allowed to call it", async () => {
    const shop = "callables-naming.myshopify.com";
    const socket = await openAgentSocket(shop, merchantHeaders());
    await socket.waitForMessage((data) => data.includes("cf_agent_identity"));
    const callables = await decoratedCallables(shop);
    for (const name of RUN_WRITES) {
      expect(callables).toContain(name);
      const role = name.startsWith("merchant") ? "merchant" : "member";
      expect(roleOf(name), name).toBe(role);
    }
    socket.close();
    const member = await memberSocket(shop);
    for (const name of RUN_WRITES.filter((name) => name.startsWith("merchant")))
      await expect(member.call(name, {}), name).rejects.toThrow(/forbidden/iu);
    member.close();
    const merchant = await openAgentSocket(shop, merchantHeaders());
    for (const name of RUN_WRITES.filter((name) => name.startsWith("member")))
      await expect(merchant.call(name, {}), name).rejects.toThrow(
        /forbidden/iu,
      );
    merchant.close();
  });
});
