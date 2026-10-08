import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";

import { requireAdmin } from "@/lib/AdminAccess";
import { tryPromisePassthrough } from "@/lib/LayerEx";

/**
 * Server-function middleware for the operator console: runs
 * {@link requireAdmin} and injects `{ user }`. Every admin route imports this
 * module at module level, so it reaches the client build, and it may export
 * nothing that references a server service outside a `.server()` body: the
 * compiler prunes only what such a body alone referenced, and anything else
 * drags the service's module graph into every document.
 */
export const adminServerFnMiddleware = createMiddleware({
  type: "function",
}).server(({ next, context }) =>
  context.runEffect(
    Effect.gen(function* () {
      const user = yield* requireAdmin;
      return yield* tryPromisePassthrough(() => next({ context: { user } }));
    }),
  ),
);
