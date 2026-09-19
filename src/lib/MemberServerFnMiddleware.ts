import { type AnyRouter, redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect, Option } from "effect";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";
import * as Domain from "@/lib/Domain";
import { tryPromisePassthrough } from "@/lib/LayerEx";

/**
 * Server-function auth middleware for the member area (`/shop/*`): validates
 * the better-auth session cookie and injects `{ user }`. No session → `/login`;
 * an admin session → `/admin`: the operator role is cross-tenant and by
 * invariant never a member, so the two areas admit disjoint roles and the
 * mirror-image bounce in `requireAdmin` cannot loop. Impersonated sessions
 * pass because after the cookie swap `user` is the target with role `user`.
 * The `/admin` redirect instantiates `redirect<AnyRouter>` explicitly: with
 * the default `RegisteredRouter` generic this guard's type would depend on
 * `/admin`'s guard and vice versa (each redirects into the other's route),
 * and TS fails the cycle with TS7022. Per-shop
 * authorization is separate (`requireMember` in `@/lib/MemberAccess`) because
 * the shop lives in the URL, which a function middleware cannot see —
 * handlers receive it as
 * validated input and assert membership themselves.
 */
export const memberServerFnMiddleware = createMiddleware({
  type: "function",
}).server(({ next, context }) =>
  context.runEffect(
    Effect.gen(function* () {
      const auth = yield* Auth;
      const request = yield* CurrentRequest;
      const sessionContext = yield* auth.getSession(request.headers);
      if (Option.isNone(sessionContext))
        return yield* Effect.fail(redirect({ to: "/login" }));
      if (Domain.userIsAdmin(sessionContext.value.user))
        return yield* Effect.fail(redirect<AnyRouter>({ to: "/admin" }));
      return yield* tryPromisePassthrough(() =>
        next({ context: { user: sessionContext.value.user } }),
      );
    }),
  ),
);
