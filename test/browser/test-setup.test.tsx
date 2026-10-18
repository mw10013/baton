import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "vite-plus/test";
import { renderHookInApp, renderInApp } from "./render.tsx";
import { shopTestRegistry } from "./shop-actor.ts";
import { RUN_PAGE, type WorkflowsListData } from "../../src/domain/shop-work.ts";
import { memberRunsQuery } from "../../src/web/client/shop-actor-client.ts";

const list: WorkflowsListData = {
  counts: { started_by_you: 0, started_by_others: 0, ready: 7, blocked: 0, done: 0 },
  items: [],
  recent: [],
  matches: null,
};

describe("browser tests", () => {
  it("render a Polaris element and click it", async () => {
    let clicks = 0;
    const screen = await renderInApp(
      <s-button variant="primary" onClick={() => clicks++}>
        Go
      </s-button>,
      shopTestRegistry({}),
    );
    const button = screen.getByRole("button", { name: "Go" });

    await expect.element(button).toBeVisible();
    await button.click();
    expect(clicks).toBe(1);
    // Polaris loaded: without it `s-button` is an unknown element with no shadow root.
    expect(customElements.get("s-button")).toBeDefined();
    expect(screen.container.querySelector("s-button")?.shadowRoot).not.toBeNull();
  });

  it("read an atom through a hook, backed by test handlers", async () => {
    const registry = shopTestRegistry({ MemberListRuns: () => Effect.succeed(list) });
    const query = { team: null, state: "ready", limit: RUN_PAGE, q: null } as const;
    const { result } = await renderHookInApp(() => useAtomValue(memberRunsQuery(query)), registry);

    await expect.poll(() => AsyncResult.isSuccess(result.current)).toBe(true);
    expect(AsyncResult.getOrThrow(result.current).counts.ready).toBe(7);
  });
});
