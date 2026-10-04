import type { ShopAgentSocket } from "@/lib/ShopAgentContext";

import * as React from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { ShopAgentProvider } from "@/lib/ShopAgentContext";
import {
  INVALIDATION_THROTTLE_MS,
  useSubscribedQuery,
} from "@/lib/useSubscribedQuery";

/**
 * The hook against a stand-in socket: an `EventTarget` that the test
 * dispatches `invalidated` frames on, with a `subscribe` spy standing in for
 * the `subscribe<Feature>` RPC. `document.visibilityState` is an own property
 * shadowing the prototype's getter for the width of a test.
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

const renderSubscribed = async () => {
  const subscribe = vi.fn(() => Promise.resolve("read"));
  const agent = Object.assign(new EventTarget(), {
    identified: true,
    reconnect: vi.fn(),
    stub: { subscribe, unsubscribe: () => Promise.resolve() },
  }) as unknown as ShopAgentSocket;
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { readonly children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ShopAgentProvider value={{ agent, identified: true }}>
        {children}
      </ShopAgentProvider>
    </QueryClientProvider>
  );
  await renderHook(
    () =>
      useSubscribedQuery({
        queryKey: ["subscribed-test"],
        subscribe: (stub) =>
          (stub as unknown as { subscribe: () => Promise<string> }).subscribe(),
        initialData: "loader",
      }),
    { wrapper },
  );
  // The identify refetch: the first subscribing read.
  await expect.poll(() => subscribe.mock.calls.length).toBe(1);
  const frame = () =>
    agent.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "invalidated" }),
      }),
    );
  return { subscribe, frame };
};

describe("useSubscribedQuery", () => {
  it("a hidden page defers its refetch to the next visibilitychange", async () => {
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

  it("a throttled frame whose window elapses while hidden defers", async () => {
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

  it("a visible page refetches on a frame", async () => {
    const { subscribe, frame } = await renderSubscribed();
    setVisibility("visible");
    frame();
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
  });
});
