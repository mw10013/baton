import { createFileRoute, notFound } from "@tanstack/react-router";
import { findHelpPage, findHelpSection, helpTabTitle } from "../components/help/pages.ts";
import { HelpArticle, HelpNotFound } from "../components/HelpPages.tsx";

export const Route = createFileRoute("/help/$section/$page")({
  loader: ({ params }) => {
    const section = findHelpSection(params.section);
    const page = section === undefined ? undefined : findHelpPage(section, params.page);
    if (section === undefined || page === undefined) throw notFound();
    return { section, page };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: helpTabTitle(loaderData?.page.title ?? "Help") }],
  }),
  component: function HelpPageRoute() {
    const { section, page } = Route.useLoaderData();
    return <HelpArticle section={section} page={page} />;
  },
  notFoundComponent: HelpNotFound,
});
