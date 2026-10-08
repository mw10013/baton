import { type AnyRouter, redirect } from "@tanstack/react-router";
import { Effect, Option } from "effect";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";
import * as Domain from "@/lib/Domain";

/**
 * Operator-console guard shared by `admin.tsx`'s `beforeLoad` and
 * `adminServerFnMiddleware`. Anonymous → `/login` (the one login page;
 * `/login-callback` routes by role from there). A signed-in non-admin bounces
 * to `/shop`, the mirror of `memberServerFnMiddleware` bouncing admins here:
 * the roles are disjoint by invariant (an admin is never a member — a stray
 * `Member` row for an admin email is inert, the `/shop` guard still bounces),
 * so the pair cannot loop. `redirect<AnyRouter>` breaks the guard-type cycle
 * (see `MemberServerFnMiddleware`).
 *
 * Lives in its own module rather than beside `adminServerFnMiddleware`
 * because a module a route imports at module level reaches the client build,
 * and TanStack Start's compiler prunes only the imports that a `.server()` or
 * `.handler()` body alone referenced. Every admin route imports the middleware
 * for `.middleware([...])`, so a module-level export there that yields `Auth`
 * kept `Auth` (better-auth, its Kysely adapter, the magic-link plugin,
 * `Repository`) alive in every document the app serves: 730 script modules and
 * about 0.65 s per document load in dev, and better-auth with Kysely in the
 * production client bundle. A guard that yields a server service therefore
 * lives in a module only server bodies import. The pin is TanStack Start's
 * import protection in `vite.config.ts`, which fails dev and build when
 * `Auth` or `Repository` reaches the client environment.
 */
export const requireAdmin = Effect.gen(function* () {
  const auth = yield* Auth;
  const request = yield* CurrentRequest;
  const sessionContext = yield* auth.getSession(request.headers);
  if (Option.isNone(sessionContext))
    return yield* Effect.fail(redirect({ to: "/login" }));
  const { user } = sessionContext.value;
  if (!Domain.userIsAdmin(user))
    return yield* Effect.fail(redirect<AnyRouter>({ to: "/shop" }));
  return user;
});
