import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ShopAgentProvider } from "@/lib/ShopAgentContext";
import {
  INVALIDATION_THROTTLE_MS,
  useSubscribedQuery,
} from "@/lib/useSubscribedQuery";

/**
 * The hook against a stand-in socket: an `EventTarget` that the test
 * dispatches invalidations on, with a `subscribe` spy standing in for the
 * `subscribe<Feature>` RPC and an `unsubscribe` spy for `ShopAgent.unsubscribe`.
 * `document.visibilityState` is an own property shadowing the prototype's
 * getter for the width of a test. Each title is a row of the events table
 * on `useSubscribedQuery`.
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

/** Waits out one task, the delay the hook's unsubscribe takes. */
const nextTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 10);
  });

/**
 * Renders the hook over the stand-in socket. `identified` false renders it
 * before the handshake, `identify()` flips it, and `drop()` flips it back as
 * a socket close does; `strict` renders it under
 * `React.StrictMode`, whose setup, cleanup, setup probe the unsubscribe
 * delay exists for. A probe component and `render` rather than `renderHook`,
 * because Strict Mode runs effects twice only as the root element, and
 * `renderHook` puts its wrapper there.
 */
const renderSubscribed = async ({
  identified = true,
  strict = false,
}: {
  readonly identified?: boolean;
  readonly strict?: boolean;
} = {}) => {
  let identifiedNow = identified;
  const subscribe = vi.fn((_subscriberId: string) => Promise.resolve("read"));
  const unsubscribe = vi.fn((_input: { readonly subscriberId: string }) =>
    Promise.resolve(),
  );
  const agent = Object.assign(new EventTarget(), {
    identified,
    reconnect: vi.fn(),
    stub: { subscribe, unsubscribe },
  });
  const socket = agent as unknown as ShopAgentSocket;
  const queryClient = new QueryClient();
  function Probe() {
    useSubscribedQuery({
      queryKey: ["subscribed-test"],
      subscribe: (stub, subscriberId) =>
        (stub as unknown as typeof agent.stub).subscribe(subscriberId),
      initialData: "loader",
    });
    return null;
  }
  const tree = () => {
    const providers = (
      <QueryClientProvider client={queryClient}>
        <ShopAgentProvider value={{ agent: socket, identified: identifiedNow }}>
          <Probe />
        </ShopAgentProvider>
      </QueryClientProvider>
    );
    return strict ? (
      <React.StrictMode>{providers}</React.StrictMode>
    ) : (
      providers
    );
  };
  const rendered = await render(tree());
  // The identify refetch: the first subscribing read.
  if (identified) await expect.poll(() => subscribe.mock.calls.length).toBe(1);
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
    subscribe,
    unsubscribe,
    frame,
    identify: () => setIdentified(true),
    drop: () => setIdentified(false),
    unmount: rendered.unmount,
  };
};

describe("useSubscribedQuery", () => {
  it("a hidden tab defers its refetch to the next visibilitychange", async () => {
    const { subscribe, frame } = await renderSubscribed();
    setVisibility("hidden");
    frame();
    frame();
    await quiet();
    expect(subscribe).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
    await quiet();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("a throttled invalidation whose window elapses while hidden defers", async () => {
    const { subscribe, frame } = await renderSubscribed();
    setVisibility("visible");
    frame();
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
    // Inside the throttle window: pending, not fetched.
    frame();
    setVisibility("hidden");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INVALIDATION_THROTTLE_MS + 100);
    });
    expect(subscribe).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    await expect.poll(() => subscribe.mock.calls.length).toBe(3);
  });

  it("a visible tab refetches on an invalidation", async () => {
    const { subscribe, frame } = await renderSubscribed();
    setVisibility("visible");
    frame();
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
  });

  /**
   * The first identify reads once. A reconnect's identify landing while an
   * invalidation's refetch is still in flight joins it: TanStack Query
   * cancels a fetch in flight on a query that has data unless
   * `cancelRefetch` is false, and the RPC it would cancel cannot be aborted.
   */
  it("identify invalidates once and joins a fetch in flight", async () => {
    const { subscribe, frame, identify, drop } = await renderSubscribed({
      identified: false,
    });
    await quiet();
    expect(subscribe).not.toHaveBeenCalled();
    await identify();
    await expect.poll(() => subscribe.mock.calls.length).toBe(1);

    let release: ((value: string) => void) | undefined;
    subscribe.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    setVisibility("visible");
    frame();
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
    await drop();
    await identify();
    release?.("read");
    await quiet();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("a burst inside the window costs two refetches", async () => {
    const { subscribe, frame } = await renderSubscribed();
    setVisibility("visible");
    frame();
    frame();
    frame();
    // The leading refetch, now; the burst's other two are one pending refetch.
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INVALIDATION_THROTTLE_MS + 100);
    });
    // The trailing refetch at the window's end, and nothing after it.
    expect(subscribe).toHaveBeenCalledTimes(3);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INVALIDATION_THROTTLE_MS + 100);
    });
    expect(subscribe).toHaveBeenCalledTimes(3);
  });

  it("unmount unsubscribes with the mount's subscriber id", async () => {
    const { subscribe, unsubscribe, unmount } = await renderSubscribed();
    const subscriberId = subscribe.mock.calls[0]?.[0];
    await unmount();
    await nextTask();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith({ subscriberId });
  });

  it("a setup before the unsubscribe task cancels it", async () => {
    const { unsubscribe } = await renderSubscribed({ strict: true });
    await nextTask();
    await quiet();
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
