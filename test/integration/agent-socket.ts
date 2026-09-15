import { env } from "cloudflare:workers";

import * as Domain from "@/lib/Domain";

/**
 * A WebSocket against a `ShopAgent` instance, plus the agents-SDK RPC wire
 * protocol spoken by hand.
 *
 * Why by hand: the client half of that protocol lives in `agents/react`, which
 * needs a DOM and a real origin, and the browser `useAgent` hook is not what
 * these tests are about. The frames are three fields wide — a request is
 * `{ type: "rpc", id, method, args }` and the reply is
 * `{ type: "rpc", id, success, result | error, done }` — so speaking them
 * directly is cheaper than standing up the hook, and it is the same surface a
 * hostile client would have.
 *
 * {@link openAgentSocket} talks to the Durable Object stub directly rather than
 * through the Worker, so a test can forward whatever `x-baton-*` headers it
 * likes and exercise the object's side of the contract without the gate. Tests
 * that want the gate go through `SELF.fetch` / the worker entry instead.
 *
 * `x-partykit-room` is not needed: `getByName` stamps `ctx.id.name`, which is
 * the first source partyserver consults for the instance name.
 */
export interface AgentSocket {
  /** Resolves with the method's return value, rejects with the server-side error message. */
  readonly call: <A = unknown>(
    method: string,
    ...args: readonly unknown[]
  ) => Promise<A>;
  /** Resolves when the server closes the socket; rejects if it stays open past `timeoutMs`. */
  readonly waitForClose: (timeoutMs?: number) => Promise<{
    readonly code: number;
    readonly reason: string;
  }>;
  /** Resolves with the first frame matching `predicate`, including ones already received. */
  readonly waitForMessage: (
    predicate: (data: string) => boolean,
    timeoutMs?: number,
  ) => Promise<string>;
  readonly received: readonly string[];
  readonly close: () => void;
}

const RPC_TIMEOUT_MS = 10_000;

export const merchantHeaders = (): Record<string, string> => ({
  [Domain.CONNECTION_ROLE_HEADER]: "merchant",
});

export const memberHeaders = (member: {
  readonly memberId: string;
  readonly memberEmail: string;
  readonly teamIds: readonly string[];
}): Record<string, string> => ({
  [Domain.CONNECTION_ROLE_HEADER]: "member",
  [Domain.CONNECTION_MEMBER_ID_HEADER]: member.memberId,
  [Domain.CONNECTION_MEMBER_EMAIL_HEADER]: member.memberEmail,
  [Domain.CONNECTION_TEAM_IDS_HEADER]: member.teamIds.join(","),
});

export const openAgentSocket = async (
  shop: string,
  headers: Record<string, string>,
): Promise<AgentSocket> =>
  agentSocket(
    await env.SHOP_AGENT.getByName(shop).fetch(
      new Request(`https://baton.test/agents/shop-agent/${shop}`, {
        headers: { Upgrade: "websocket", ...headers },
      }),
    ),
  );

/**
 * Wraps the `101` from any upgrade — the stub's, or the Worker's own, for a
 * test that wants the gate on the path — in the RPC protocol above.
 */
export const agentSocket = (response: Response): AgentSocket => {
  const socket = response.webSocket;
  if (!socket)
    throw new Error(
      `ShopAgent upgrade returned ${String(response.status)} with no socket`,
    );
  socket.accept();

  const received: string[] = [];
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const messageWaiters = new Set<(data: string) => void>();
  let closed: { code: number; reason: string } | null = null;
  const closeWaiters = new Set<
    (value: { code: number; reason: string }) => void
  >();

  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    received.push(data);
    // Deleting the current entry mid-iteration is defined behaviour for a
    // `Set`, and a waiter removes itself as it resolves.
    for (const waiter of messageWaiters) waiter(data);
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== "rpc"
    )
      return;
    const frame = parsed as {
      id: string;
      success: boolean;
      result?: unknown;
      error?: string;
    };
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    if (frame.success) entry.resolve(frame.result);
    else entry.reject(new Error(frame.error ?? "unknown RPC error"));
  });

  socket.addEventListener("close", (event) => {
    closed = { code: event.code, reason: event.reason };
    for (const waiter of closeWaiters) waiter(closed);
    for (const [, entry] of pending)
      entry.reject(new Error(`socket closed with ${String(event.code)}`));
    pending.clear();
  });

  const call = <A>(method: string, ...args: readonly unknown[]) =>
    new Promise<A>((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      setTimeout(() => {
        if (pending.delete(id))
          reject(new Error(`RPC call to ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      socket.send(JSON.stringify({ type: "rpc", id, method, args }));
    });

  const waitForClose = (timeoutMs = RPC_TIMEOUT_MS) =>
    new Promise<{ code: number; reason: string }>((resolve, reject) => {
      if (closed) {
        resolve(closed);
        return;
      }
      const waiter = (value: { code: number; reason: string }) => {
        closeWaiters.delete(waiter);
        resolve(value);
      };
      closeWaiters.add(waiter);
      setTimeout(() => {
        if (closeWaiters.delete(waiter))
          reject(new Error("socket stayed open"));
      }, timeoutMs);
    });

  const waitForMessage = (
    predicate: (data: string) => boolean,
    timeoutMs = RPC_TIMEOUT_MS,
  ) =>
    new Promise<string>((resolve, reject) => {
      const hit = received.find(predicate);
      if (hit !== undefined) {
        resolve(hit);
        return;
      }
      const waiter = (data: string) => {
        if (!predicate(data)) return;
        messageWaiters.delete(waiter);
        resolve(data);
      };
      messageWaiters.add(waiter);
      setTimeout(() => {
        if (messageWaiters.delete(waiter))
          reject(new Error("no matching frame"));
      }, timeoutMs);
    });

  return {
    call,
    waitForClose,
    waitForMessage,
    received,
    close: () => {
      socket.close();
    },
  };
};

/**
 * The five member mutations, typed, over an already-open member socket. The
 * wire inputs carry no identity — that comes from the connection the socket was
 * opened with — so a test that wants a different member or a different team
 * scope opens a different socket, exactly as a different person's browser
 * would.
 */
export const memberActions = (socket: AgentSocket) => ({
  startStep: (input: typeof Domain.StartStepInput.Encoded) =>
    socket.call<Domain.RunResult>("startStep", input),
  completeStep: (input: typeof Domain.CompleteStepInput.Encoded) =>
    socket.call<Domain.RunResult>("completeStep", input),
  setStepNote: (input: typeof Domain.SetStepNoteInput.Encoded) =>
    socket.call<Domain.RunResult>("setStepNote", input),
  blockRun: (input: typeof Domain.BlockRunInput.Encoded) =>
    socket.call<Domain.RunResult>("blockRun", input),
  dismissFlag: (input: typeof Domain.DismissFlagInput.Encoded) =>
    socket.call<Domain.RunResult>("dismissFlag", input),
});

/**
 * The merchant's five interventions, typed, over an already-open merchant
 * socket. No identity on the wire and none on the connection either: the
 * merchant *is* the shop, so the object supplies `{ role: "merchant" }` and no
 * `teamIds` (`ShopAgent.merchantCompleteStep`).
 */
export const merchantActions = (socket: AgentSocket) => ({
  completeStep: (input: typeof Domain.CompleteStepInput.Encoded) =>
    socket.call<Domain.RunResult>("merchantCompleteStep", input),
  uncompleteStep: (input: typeof Domain.UncompleteStepInput.Encoded) =>
    socket.call<Domain.RunResult>("merchantUncompleteStep", input),
  setStepNote: (input: typeof Domain.SetStepNoteInput.Encoded) =>
    socket.call<Domain.RunResult>("merchantSetStepNote", input),
  blockRun: (input: typeof Domain.BlockRunInput.Encoded) =>
    socket.call<Domain.RunResult>("merchantBlockRun", input),
  dismissFlag: (input: typeof Domain.RunIdInput.Encoded) =>
    socket.call<Domain.RunResult>("merchantDismissFlag", input),
});

/** A merchant socket plus its typed interventions, the order page's half of the wire. */
export const openMerchantSocket = async (shop: string) => {
  const socket = await openAgentSocket(shop, merchantHeaders());
  return { ...merchantActions(socket), socket, close: socket.close };
};

/** A member socket plus its typed mutations, the shape a test drives work through. */
export const openMemberSocket = async (
  shop: string,
  member: {
    readonly memberId: string;
    readonly memberEmail: string;
    readonly teamIds: readonly string[];
  },
) => {
  const socket = await openAgentSocket(shop, memberHeaders(member));
  return { ...memberActions(socket), socket, close: socket.close };
};

/** The one server push: `Domain.InvalidatedMessage` on the wire. */
export const isInvalidated = (data: string) => data.includes(`"invalidated"`);
