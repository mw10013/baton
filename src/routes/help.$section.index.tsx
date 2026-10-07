import { createFileRoute, notFound } from "@tanstack/react-router";

import { HelpList } from "@/components/screen/HelpList";
import { Things } from "@/components/screen/Things";
import { findHelpSection, helpTabTitle } from "@/lib/helpPages";

import { HelpNotFound } from "./help.$section.$page";

export const Route = createFileRoute("/help/$section/")({
  loader: ({ params }) => {
    const section = findHelpSection(params.section);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (section === undefined) throw notFound();
    return section;
  },
  head: ({ loaderData }) => ({
    meta: [{ title: helpTabTitle(loaderData?.title ?? "Help") }],
  }),
  component: RouteComponent,
  notFoundComponent: HelpNotFound,
});

/**
 * A section hub: the lead (the section's one line, until it has a body of
 * its own), then "In this section" over its pages.
 */
function RouteComponent() {
  const section = Route.useLoaderData();
  return (
    <s-page heading={section.title} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/">
        Baton
      </s-link>
      <s-link slot="breadcrumb-actions" href="/help">
        Help
      </s-link>
      <s-section accessibilityLabel={section.title}>
        <Things>
          <s-paragraph>{section.description}</s-paragraph>
        </Things>
      </s-section>
      <s-section heading="In this section">
        <HelpList
          entries={section.pages}
          hrefOf={(page) => `/help/${section.slug}/${page.slug}`}
        />
      </s-section>
    </s-page>
  );
}
