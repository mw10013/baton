import { createFileRoute, notFound } from "@tanstack/react-router";

import { HelpList } from "@/components/HelpList";
import { Things } from "@/components/screen/Things";
import { findHelpPage, findHelpSection, helpTabTitle } from "@/lib/helpPages";

export const Route = createFileRoute("/help/$section/$page")({
  loader: ({ params }) => {
    const section = findHelpSection(params.section);
    const page =
      section === undefined ? undefined : findHelpPage(section, params.page);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (section === undefined || page === undefined) throw notFound();
    return { section, page };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: helpTabTitle(loaderData?.page.title ?? "Help") }],
  }),
  component: RouteComponent,
  notFoundComponent: HelpNotFound,
});

/**
 * A page: breadcrumbs up to its section, the lead (the page's one line,
 * until it has a body), the body (none yet: the content phase adds one
 * component per page), and the foot list, "In <section>", the section's
 * pages with this one unlinked. The foot list is the sideways device in
 * place of a sidebar, and on a phone, where `s-page` folds the breadcrumbs
 * into a "…" button, the visible way up (`docs/help-research.md`).
 */
function RouteComponent() {
  const { section, page } = Route.useLoaderData();
  return (
    <s-page heading={page.title} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/">
        Baton
      </s-link>
      <s-link slot="breadcrumb-actions" href="/help">
        Help
      </s-link>
      <s-link slot="breadcrumb-actions" href={`/help/${section.slug}`}>
        {section.title}
      </s-link>
      <s-section accessibilityLabel={page.title}>
        <Things>
          <s-paragraph>{page.description}</s-paragraph>
        </Things>
      </s-section>
      {/* The heading names the section as a link: on a phone, where the
          breadcrumbs have folded, it is the visible way up. */}
      <s-section accessibilityLabel={`In ${section.title}`}>
        <Things>
          <s-heading>
            In <s-link href={`/help/${section.slug}`}>{section.title}</s-link>
          </s-heading>
          <HelpList
            entries={section.pages}
            hrefOf={(entry) => `/help/${section.slug}/${entry.slug}`}
            current={page.slug}
          />
        </Things>
      </s-section>
    </s-page>
  );
}

/** What a slug the tree does not have renders, with the way back to the hub. */
export function HelpNotFound() {
  return (
    <s-page heading="Page not found" inlineSize="small">
      <s-link slot="breadcrumb-actions" href="/help">
        Help
      </s-link>
      <s-section accessibilityLabel="Page not found">
        <Things>
          <s-paragraph color="subdued">There is no help page here.</s-paragraph>
          <s-link href="/help">Help</s-link>
        </Things>
      </s-section>
    </s-page>
  );
}
