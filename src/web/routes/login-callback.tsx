import { createFileRoute } from "@tanstack/react-router";
import { useNavigateOnClick } from "../components/navigate.ts";
import { Things } from "../components/screen/Things.tsx";
import { resolveLanding } from "../server/session.ts";

/**
 * Where a magic link lands when no `returnTo` names a page: invisible on success, because the
 * verify endpoint has already set the session cookie, so the loader resolves straight to a
 * redirect (`resolveLanding`): `/admin` for an admin, the member's workflows list when they belong
 * to one shop, Your stores otherwise. It is also where sign-in sends a member who is already
 * signed in. The only rendered state is failure: no session.
 */
export const Route = createFileRoute("/login-callback")({
  loader: () => resolveLanding(),
  component: function LoginCallback() {
    const { error } = Route.useLoaderData();
    const navigate = useNavigateOnClick();
    return (
      <s-page heading="Sign-in failed" inlineSize="small">
        <s-section accessibilityLabel="Sign-in failed">
          <Things>
            <s-banner tone="critical">{error}</s-banner>
            <s-link {...navigate("/sign-in")}>Request a new sign-in link</s-link>
          </Things>
        </s-section>
      </s-page>
    );
  },
});
