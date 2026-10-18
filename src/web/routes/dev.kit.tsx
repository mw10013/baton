import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { KitPage } from "../components/KitPage.tsx";
import { requireDevKit } from "../server/dev-kit.ts";
import { lenientSearchKey } from "./-search-params.ts";

const KitSearch = Schema.Struct({
  /** The page width the parts render in: the member's (`small`, the default) or the merchant's (`large`). */
  width: lenientSearchKey(Schema.Literals(["small", "large"])),
});

/**
 * The kit page ({@link KitPage}): a dev page, not a merchant or member screen, found only where
 * the stage's environment is one whose data is disposable (`requireDevKit`), so never on staging.
 */
export const Route = createFileRoute("/dev/kit")({
  validateSearch: Schema.toStandardSchemaV1(KitSearch),
  beforeLoad: () => requireDevKit(),
  head: () => ({ meta: [{ title: "Kit — Baton" }] }),
  component: function KitRoute() {
    const { width } = Route.useSearch();
    return <KitPage width={width ?? "small"} />;
  },
});
