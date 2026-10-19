import { createFileRoute, notFound } from "@tanstack/react-router";
import { findHelpSection, helpTabTitle } from "../components/help/pages.ts";
import { HelpNotFound, HelpSectionHub } from "../components/HelpPages.tsx";

export const Route = createFileRoute("/help/$section/")({
  loader: ({ params }) => {
    const section = findHelpSection(params.section);
    if (section === undefined) throw notFound();
    return section;
  },
  head: ({ loaderData }) => ({ meta: [{ title: helpTabTitle(loaderData?.title ?? "Help") }] }),
  component: function HelpSectionRoute() {
    return <HelpSectionHub section={Route.useLoaderData()} />;
  },
  notFoundComponent: HelpNotFound,
});
