import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import { isTerminalCloseEvent } from "agents/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import * as Domain from "@/lib/Domain";
import { SOCKET_KEEPALIVE_MS, useShopAgent } from "@/lib/ShopAgentContext";
import { ShopAgentSocketProvider } from "@/lib/ShopAgentSocketHost";

/**
 * `ShopAgentSocketProvider` over a fake `WebSocket`. Partysocket constructs
 * whatever `globalThis.WebSocket` is at connect time when no `WebSocket`
 * option is passed, so the fake goes there for the width of a test. It opens
 * on a microtask, as a real socket opens on a later task, and `close` lands
 * the code a server close would carry.
 *
 * The first test is the tab's row of the connection table on
 * `Domain.ConnectionRole`. The decision is the SDK's: whether it treats the
 * close as terminal, which stops partysocket's reconnect. The e2e "removing a
 * member closes the shop page on their live session" proves the reconnect end
 * to end.
 */
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  readonly send = vi.fn();
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

const RealWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
  vi.useRealTimers();
});

const close = (code: number) => new CloseEvent("close", { code });

/** Lets the fake's microtask open and the effects that follow it run. */
const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Renders the provider with a probe child that reports each render's context
 * to a spy, so `seen` reads what a consumer last saw.
 */
const mount = async ({
  enabled = true,
}: { readonly enabled?: boolean } = {}) => {
  const observe =
    vi.fn<(agent: ShopAgentSocket | null, identified: boolean) => void>();
  const seen = {
    get agent() {
      return observe.mock.lastCall?.[0] ?? null;
    },
    get identified() {
      return observe.mock.lastCall?.[1] ?? false;
    },
  };
  const onSocketClose = vi.fn<(event: CloseEvent) => void>();
  function Probe() {
    const { agent, identified } = useShopAgent();
    observe(agent, identified);
    return null;
  }
  const tree = (enabledNow: boolean) => (
    <ShopAgentSocketProvider
      shop="shop.test"
      query={undefined}
      enabled={enabledNow}
      onSocketClose={onSocketClose}
    >
      <Probe />
    </ShopAgentSocketProvider>
  );
  const rendered = await render(tree(enabled));
  return {
    seen,
    onSocketClose,
    rerender: (enabledNow: boolean) => rendered.rerender(tree(enabledNow)),
    unmount: () => rendered.unmount(),
  };
};

const identify = (socket: FakeWebSocket) =>
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "cf_agent_identity",
        name: "shop.test",
        agent: "shop-agent",
      }),
    }),
  );

describe("ShopAgentSocketProvider", () => {
  it("the tab reconnects on 3401 and not on 4403", () => {
    expect(isTerminalCloseEvent(close(Domain.CONNECTION_CLOSE_REVOKED))).toBe(
      false,
    );
    expect(isTerminalCloseEvent(close(Domain.CONNECTION_CLOSE_FORBIDDEN))).toBe(
      true,
    );
  });

  it("no connect before `enabled`", async () => {
    const { seen, rerender, unmount } = await mount({ enabled: false });
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(seen.agent).toBeNull();
    await rerender(true);
    await expect.poll(() => FakeWebSocket.instances.length).toBe(1);
    await expect.poll(() => seen.agent).not.toBeNull();
    expect(seen.identified).toBe(false);
    await unmount();
  });

  it("identify flips `identified` on the identity frame and off on close", async () => {
    const { seen, unmount } = await mount();
    await expect.poll(() => FakeWebSocket.instances.length).toBe(1);
    const [socket] = FakeWebSocket.instances;
    await expect.poll(() => socket.readyState).toBe(FakeWebSocket.OPEN);
    identify(socket);
    await expect.poll(() => seen.identified).toBe(true);
    const agent = seen.agent;
    expect(agent).not.toBeNull();
    socket.close(1006);
    await expect.poll(() => seen.identified).toBe(false);
    expect(seen.agent).toBe(agent);
    await unmount();
  });

  it("`onSocketClose` receives the close code", async () => {
    const { onSocketClose, unmount } = await mount();
    await expect.poll(() => FakeWebSocket.instances.length).toBe(1);
    const [socket] = FakeWebSocket.instances;
    await expect.poll(() => socket.readyState).toBe(FakeWebSocket.OPEN);
    socket.close(Domain.CONNECTION_CLOSE_REVOKED);
    expect(onSocketClose).toHaveBeenCalledTimes(1);
    expect(onSocketClose.mock.calls[0][0]).toMatchObject({
      code: Domain.CONNECTION_CLOSE_REVOKED,
    });
    await unmount();
  });

  it("the keepalive sends the ping when the socket is open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { unmount } = await mount();
    await expect.poll(() => FakeWebSocket.instances.length).toBe(1);
    const [socket] = FakeWebSocket.instances;
    await expect.poll(() => socket.readyState).toBe(FakeWebSocket.OPEN);
    socket.send.mockClear();
    vi.advanceTimersByTime(SOCKET_KEEPALIVE_MS);
    expect(
      socket.send.mock.calls.filter(
        ([data]) => data === Domain.SocketKeepalivePing,
      ),
    ).toHaveLength(1);
    await unmount();
  });
});
