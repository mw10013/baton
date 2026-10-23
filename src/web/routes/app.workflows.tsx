import { createFileRoute, Outlet } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { WorkflowName, WorkflowsIndexState } from "../../domain/shop-work.ts";
import { lenientSearchKey, ListSearchParam } from "./-search-params.ts";

/**
 * **The merchant's filter on the workflows index, and it travels.** `state`, `q` and `after` are
 * on the layout, so the workflows pages read them; the index's links to a workflow and the
 * workflow page's breadcrumb carry them (`appHref`), so the breadcrumb lands on the filtered
 * list. A nav click drops them (`PAGE_KEYS`) rather than retaining them: this repo navigates by
 * `appHref` strings, which drop a key set to `null`, and a retained key would come back after
 * Clear search.
 *
 * The key is `state`, the list's main filter keyed by its axis (`WorkflowsIndexState`): Active and
 * Inactive are workflow states. All is the default and is written by leaving the key out.
 * `?q=` is the search, a word prefix of the name, submitted on Enter or blur; a search ignores
 * `state`, which stays in the URL so Clear search returns to it (`ListWorkflowsInput`). `?after=`
 * is the page, as the name of the last workflow on the page before; an absent `after` is page one.
 * There is no tag filter: a workflow's tag is its identity, not a grouping dimension.
 *
 * A value the page does not know (a stale link, a hand-edited URL) reads as no filter
 * (`lenientSearchKey`): a wrong filter is not an error condition.
 */
const WorkflowsSearch = Schema.Struct({
  state: lenientSearchKey(WorkflowsIndexState),
  q: lenientSearchKey(ListSearchParam),
  after: lenientSearchKey(WorkflowName),
});

/** Layout for the workflows pages: the search context ({@link WorkflowsSearch}) and nothing else. */
export const Route = createFileRoute("/app/workflows")({
  validateSearch: Schema.toStandardSchemaV1(WorkflowsSearch),
  component: () => <Outlet />,
});
