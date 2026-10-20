import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { stageState, wireBackend } from "../../src/backend/stack.ts";
import TestBackend from "./backend.ts";

/**
 * The Backend alone, as {@link TestBackend}, for the test harness. The Website is left out: under dev it would start
 * the TanStack Start dev server and want `WEBSITE_PORT`. Better Auth builds links on
 * `AUTH_ORIGIN`, which the real stack binds to the Website's URL; here the Backend is its own
 * origin, so a link can be followed against it directly. Links are delivered inline, so the
 * test gets them back from `IssueMagicLink` on the test Backend. `ROW_COUNTS` installs the row
 * tallies the rows-read probe takes (`TakeRowCounts`). `backendName` is the script
 * name Alchemy generated, which names the actor's local storage directory.
 */
export default Alchemy.Stack(
  "baton-test",
  { providers: Cloudflare.providers(), state: stageState },
  Effect.gen(function* () {
    const backend = yield* TestBackend;
    yield* wireBackend(backend, {
      authOrigin: backend.url,
      appUrl: backend.url,
      delivery: "inline",
    });
    yield* backend.bind("RowCounts", { env: { ROW_COUNTS: "on" } });
    return { backendUrl: backend.url.as<string>(), backendName: backend.workerName };
  }),
);
