import { createFileRoute } from "@tanstack/react-router";

import { HelpList } from "@/components/screen/HelpList";
import { Things } from "@/components/screen/Things";
import { HELP_SECTIONS, helpTabTitle } from "@/lib/helpPages";

export const Route = createFileRoute("/help/")({
  head: () => ({ meta: [{ title: helpTabTitle("Help") }] }),
  component: RouteComponent,
});

/**
 * The hub: one sentence on Baton, then the sections. The breadcrumb is the
 * public landing page, the way back to the app for both readers.
 */
function RouteComponent() {
  return (
    <s-page heading="Help" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/">
        Baton
      </s-link>
      <s-section accessibilityLabel="About Baton">
        <Things>
          <s-paragraph>
            Baton takes each item a Shopify order sells through a workflow of
            steps, and shows the members on each team what to make next.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="In this section">
        <HelpList
          entries={HELP_SECTIONS}
          hrefOf={(section) => `/help/${section.slug}`}
        />
      </s-section>
    </s-page>
  );
}
