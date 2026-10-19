import type { Me } from "../../contract/auth.ts";
import { homeFor } from "../client/session.ts";
import { useNavigateOnClick } from "./navigate.ts";
import { BatonMark } from "./screen/BatonMark.tsx";
import { Things } from "./screen/Things.tsx";
import SignOutButton from "./SignOutButton.tsx";

/**
 * The public landing page: what a merchant sees at the site's root when they arrive without a
 * `shop` parameter, and the page the App Store listing and the privacy policy link back to. Its
 * actions follow the session: a signed-out visitor is offered sign-in, a member their
 * {@link homeFor} dashboard and sign-out.
 */
export default function HomePage({ me }: { me: Me | undefined }) {
  const navigate = useNavigateOnClick();
  const dashboard = me && homeFor(me.role);

  return (
    <s-page heading="Baton" inlineSize="small">
      {dashboard ? (
        <>
          <s-button slot="secondary-actions" variant="secondary" {...navigate(dashboard)}>
            Dashboard
          </s-button>
          <SignOutButton variant="secondary" slot="secondary-actions" />
        </>
      ) : (
        <s-button slot="secondary-actions" variant="secondary" {...navigate("/sign-in")}>
          Sign in
        </s-button>
      )}
      <s-section accessibilityLabel="Baton overview">
        <Things>
          <BatonMark size={56} />
          <s-paragraph>
            Baton gives made-to-order Shopify merchants a clear production workflow from order to
            completion.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section accessibilityLabel="Member sign-in">
        {dashboard ? (
          <s-link {...navigate(dashboard)}>Dashboard</s-link>
        ) : (
          <s-link {...navigate("/sign-in")}>Sign in</s-link>
        )}
      </s-section>
      <s-section accessibilityLabel="Help">
        <s-link {...navigate("/help")}>Help</s-link>
      </s-section>
      <s-section accessibilityLabel="Legal">
        <s-link {...navigate("/privacy")}>Privacy policy</s-link>
      </s-section>
    </s-page>
  );
}
