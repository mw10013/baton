import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";

/**
 * Sign out of the member area. Shared by the shop picker (`/shop`) and the
 * top bar every `/shop/$shop/*` page carries (`MemberBar`), so the member
 * area has exactly one sign-out and both surfaces land on the same door.
 */
export const signOutFn = createServerFn({ method: "POST" })
  .middleware([memberServerFnMiddleware])
  .handler(({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const request = yield* CurrentRequest;
        yield* auth.signOut(request.headers);
        return yield* Effect.fail(redirect({ to: "/" }));
      }),
    ),
  );
