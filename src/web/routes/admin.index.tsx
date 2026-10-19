import { createFileRoute } from "@tanstack/react-router";
import { Inline } from "../components/screen/Inline.tsx";
import SignOutButton from "../components/SignOutButton.tsx";
import { useNavigateOnClick } from "../components/navigate.ts";

/** The admin's consoles, in the dashboard's order: heading, one sentence, the View button. */
const CONSOLES = [
  {
    heading: "Shops",
    sentence: "View connected shops and their stored Shopify sessions.",
    action: "View shops",
    href: "/admin/shops",
  },
  {
    heading: "Members",
    sentence: "Every shop's members, with the date each was added.",
    action: "View members",
    href: "/admin/members",
  },
] as const;

export const Route = createFileRoute("/admin/")({
  component: function AdminHome() {
    const { me } = Route.useRouteContext();
    const navigate = useNavigateOnClick();
    return (
      <s-page heading="Admin">
        <SignOutButton variant="secondary" slot="secondary-actions" leave />
        <s-section accessibilityLabel="Signed in">
          <s-paragraph color="subdued">Signed in as {me.email}</s-paragraph>
        </s-section>
        {CONSOLES.map((console) => (
          <s-section key={console.href} accessibilityLabel={`${console.heading} overview`}>
            <s-heading>{console.heading}</s-heading>
            <s-paragraph>{console.sentence}</s-paragraph>
            <Inline>
              <s-button variant="primary" {...navigate(console.href)}>
                {console.action}
              </s-button>
            </Inline>
          </s-section>
        ))}
      </s-page>
    );
  },
});
