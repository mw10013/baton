import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Option } from "effect";

import { Auth } from "@/lib/Auth";
import { CurrentRequest } from "@/lib/CurrentRequest";

/**
 * Invisible on success: the verify endpoint has already set the session
 * cookie, so this resolves straight to a redirect to `/shop` — the shop list,
 * uniform for 0/1/many memberships. The only rendered state is failure — no
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
        return yield* Effect.fail(redirect({ to: "/shop" }));
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
