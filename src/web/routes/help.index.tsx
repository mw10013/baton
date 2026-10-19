import { createFileRoute } from "@tanstack/react-router";
import { helpTabTitle } from "../components/help/pages.ts";
import { HelpHub } from "../components/HelpPages.tsx";

export const Route = createFileRoute("/help/")({
  head: () => ({ meta: [{ title: helpTabTitle("Help") }] }),
  component: HelpHub,
});
