import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Option } from "effect";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";
import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";

/**
 * Invisible on success: the verify endpoint has already set the session
 * cookie, so this resolves straight to a redirect — `/admin` for the operator
 * role, otherwise the member's work. A member of exactly one shop lands on
 * that shop's queue: the picker would be a page with one link on it, and a
 * bench wants the work, not a menu. Zero or several memberships land on
 * `/shop`, the picker (which is also where a member with no shops reads why).
 * Admin and member surfaces are disjoint: an admin never lands on `/shop`
 * (impersonation is the sanctioned door). The only rendered state is failure — no
 * session, or better-auth redirected here with `?error=INVALID_TOKEN` after an
 * expired/used link.
 */
const resolveLoginCallback = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const request = yield* CurrentRequest;
        const auth = yield* Auth;
        const sessionContext = yield* auth.getSession(request.headers);
        if (Option.isNone(sessionContext))
          return { error: "Magic link sign-in could not be completed." };
        const { user } = sessionContext.value;
        if (Domain.userIsAdmin(user))
          return yield* Effect.fail(redirect({ to: "/admin" }));
        const shops = yield* (yield* Repository).listMemberShops(user.email);
        const [only] = shops;
        return yield* Effect.fail(
          only !== undefined && shops.length === 1
            ? redirect({ to: "/shop/$shop", params: { shop: only } })
            : redirect({ to: "/shop" }),
        );
      }),
    ),
);

export const Route = createFileRoute("/login-callback")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  loaderDeps: ({ search }) => ({ error: search.error }),
  loader: ({ deps }) =>
    deps.error
      ? { error: "This magic link is invalid or has expired." }
      : resolveLoginCallback(),
  component: RouteComponent,
});

function RouteComponent() {
  const { error } = Route.useLoaderData();
  return (
    <s-page heading="Sign-in failed" inlineSize="small">
      <s-section accessibilityLabel="Sign-in failed">
        <s-stack gap="base">
          <s-banner tone="critical">{error}</s-banner>
          <s-link href="/login">Request a new magic link</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}
