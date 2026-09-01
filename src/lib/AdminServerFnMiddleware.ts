import { type AnyRouter, redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { Effect, Option } from "effect";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { tryPromisePassthrough } from "@/lib/LayerEx";

/**
 * Operator-console guard shared by `admin.tsx`'s `beforeLoad` and
 * {@link adminServerFnMiddleware}. Anonymous → `/login` (the one login page;
 * `/login-callback` routes by role from there). A signed-in non-admin bounces
 * to `/shop`, the mirror of `memberServerFnMiddleware` bouncing admins here:
 * the roles are disjoint by invariant (an admin is never a member — a stray
 * `Member` row for an admin email is inert, the `/shop` guard still bounces),
 * so the pair cannot loop. `redirect<AnyRouter>` breaks the guard-type cycle
 * (see `MemberServerFnMiddleware`).
 */
export const requireAdmin = Effect.gen(function* () {
  const auth = yield* Auth;
  const request = yield* CurrentRequest;
  const sessionContext = yield* auth.getSession(request.headers);
  if (Option.isNone(sessionContext))
    return yield* Effect.fail(redirect({ to: "/login" }));
  const { user } = sessionContext.value;
  if (user.role !== "admin")
    return yield* Effect.fail(redirect<AnyRouter>({ to: "/shop" }));
  return user;
});

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
