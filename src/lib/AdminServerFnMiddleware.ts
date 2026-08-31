import { createMiddleware } from "@tanstack/react-start";
import { Effect } from "effect";

import { AdminAuth } from "@/lib/AdminAuth";
import { tryPromisePassthrough } from "@/lib/LayerEx";

export const adminServerFnMiddleware = createMiddleware({
  type: "function",
}).server(({ next, context }) =>
  context.runEffect(
    Effect.gen(function* () {
      const auth = yield* AdminAuth;
      yield* auth.requireSession();
      return yield* tryPromisePassthrough(() => next());
    }),
  ),
);
