import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ShopAgentProvider } from "@/lib/ShopAgentContext";
import { INVALIDATION_THROTTLE_MS, useLiveQuery } from "@/lib/useLiveQuery";

/**
 * The hook against a stand-in socket: an `EventTarget` that the test
 * dispatches invalidations on, with a `read` spy standing in for the
 * object method a live screen reads. `document.visibilityState` is an own
 * property shadowing the prototype's getter for the width of a test. Each
 * title is a row of the events table on `useLiveQuery`.
 */
let visibility: DocumentVisibilityState = "visible";
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
};

/** Waits out a window in which no fetch should start. */
const quiet = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
});

/**
 * Renders the hook over the stand-in socket. `identified` false renders it
 * before the handshake, `identify()` flips it, and `drop()` flips it back as
 * a socket close does. A probe component and `render`, so a rerender
 * replaces the provider's value as the socket host does.
 */
const renderLive = async ({
  identified = true,
}: {
  readonly identified?: boolean;
} = {}) => {
  let identifiedNow = identified;
  const read = vi.fn(() => Promise.resolve("read"));
  const agent = Object.assign(new EventTarget(), {
    identified,
    reconnect: vi.fn(),
    stub: { read },
  });
  const socket = agent as unknown as ShopAgentSocket;
  const queryClient = new QueryClient();
  function Probe() {
    useLiveQuery({
      queryKey: ["live-test"],
      read: (stub) => (stub as unknown as typeof agent.stub).read(),
      initialData: "loader",
    });
    return null;
  }
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <ShopAgentProvider
        value={{ agent: socket, identified: identifiedNow, displaced: false }}
      >
        <Probe />
      </ShopAgentProvider>
    </QueryClientProvider>
  );
  const rendered = await render(tree());
  // The identify refetch: the first socket read.
  if (identified) await expect.poll(() => read.mock.calls.length).toBe(1);
  const frame = () =>
    agent.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "invalidated" }),
      }),
    );
  const setIdentified = async (value: boolean) => {
    identifiedNow = value;
    agent.identified = value;
    await rendered.rerender(tree());
  };
  return {
    read,
    frame,
    identify: () => setIdentified(true),
    drop: () => setIdentified(false),
  };
};

describe("useLiveQuery", () => {
  it("a hidden tab defers its refetch to the next visibilitychange", async () => {
    const { read, frame } = await renderLive();
    setVisibility("hidden");
    frame();
    frame();
    await quiet();
    expect(read).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    await expect.poll(() => read.mock.calls.length).toBe(2);
    await quiet();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a throttled invalidation whose window elapses while hidden defers", async () => {
    const { read, frame } = await renderLive();
    setVisibility("visible");
    frame();
    await expect.poll(() => read.mock.calls.length).toBe(2);
    // Inside the throttle window: pending, not fetched.
    frame();
    setVisibility("hidden");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INVALIDATION_THROTTLE_MS + 100);
    });
    expect(read).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    await expect.poll(() => read.mock.calls.length).toBe(3);
  });

  it("a visible tab refetches on an invalidation", async () => {
    const { read, frame } = await renderLive();
    setVisibility("visible");
    frame();
    await expect.poll(() => read.mock.calls.length).toBe(2);
  });

  /**
   * The first identify reads once. A reconnect's identify landing while an
   * invalidation's refetch is still in flight joins it: TanStack Query
   * cancels a fetch in flight on a query that has data unless
   * `cancelRefetch` is false, and the RPC it would cancel cannot be aborted.
   */
  it("identify invalidates once and joins a fetch in flight", async () => {
    const { read, frame, identify, drop } = await renderLive({
      identified: false,
    });
    await quiet();
    expect(read).not.toHaveBeenCalled();
    await identify();
    await expect.poll(() => read.mock.calls.length).toBe(1);

    let release: ((value: string) => void) | undefined;
    read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    setVisibility("visible");
    frame();
    await expect.poll(() => read.mock.calls.length).toBe(2);
    await drop();
    await identify();
    release?.("read");
    await quiet();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("a burst inside the window costs two refetches", async () => {
    const { read, frame } = await renderLive();
    setVisibility("visible");
    frame();
    frame();
    frame();
    // The leading refetch, now; the burst's other two are one pending refetch.
    await expect.poll(() => read.mock.calls.length).toBe(2);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INVALIDATION_THROTTLE_MS + 100);
    });
    // The trailing refetch at the window's end, and nothing after it.
    expect(read).toHaveBeenCalledTimes(3);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INVALIDATION_THROTTLE_MS + 100);
    });
    expect(read).toHaveBeenCalledTimes(3);
  });
});
