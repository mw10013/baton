import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { liveLoad } from "../../../../src/web/client/live-load.ts";

/**
 * Outside the TanStack Start compiler `createIsomorphicFn` runs its `.server()` branch, so this
 * Node test is the server's `liveLoad`.
 */
describe("liveLoad on the server", () => {
  it("the server always fetches", async () => {
    const registry = AtomRegistry.make();
    const query = Atom.make<AsyncResult.AsyncResult<number, never>>(AsyncResult.initial()).pipe(
      Atom.serializable({
        key: "live-load-server",
        schema: AsyncResult.Schema({ success: Schema.Number }),
      }),
    );
    // Kept with a value, which a browser loader would answer from.
    registry.set(query, AsyncResult.success(1));
    let fetched = 0;
    const answer = await liveLoad({
      registry,
      query,
      fetch: () => {
        fetched++;
        return Promise.resolve(2);
      },
    });
    expect(answer).toBe(2);
    expect(fetched).toBe(1);
    registry.dispose();
  });
});
