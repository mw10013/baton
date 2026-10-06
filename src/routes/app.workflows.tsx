import {
  createFileRoute,
  Outlet,
  retainSearchParams,
} from "@tanstack/react-router";
import { Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { lenientSearchKey, ListSearchParam } from "@/lib/searchParams";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * Set on the entry the workflows index's Next pushes, for the reason on
     * `ordersNextPage` (`app.orders.tsx`): the entry before is the page
     * before, so Previous can be the browser's Back.
     */
    readonly workflowsNextPage?: true;
  }
}

/**
 * **The merchant's filter on the workflows index, and it travels.** The same
 * rule as the member area's {@link MemberSearch} (`shop.$shop.tsx`) and the
 * orders index's `OrdersSearch` (`app.orders.tsx`): `state` lives on the
 * layout and `retainSearchParams` puts it on every link and navigation under
 * `/app/workflows`, so the workflow page's breadcrumb, the navigation back
 * after a delete, and the Workflows nav link land on the filtered list. The
 * editor route (`$workflowId_.edit`) is a child as well: the `_` escapes only
 * `$workflowId`, and a `?state=` on the editor window's URL is harmless.
 *
 * The key is `state`, the list's main filter keyed by its axis
 * (`Domain.WorkflowsIndexState`): Active and Inactive are workflow states. All is the
 * default and is written by leaving the key out; a stale `?view=` or
 * `?status=` from before the renames is an unknown key and reads as All.
 *
 * The filter buttons are in the URL, so a filtered list is a link someone can
 * send. `?q=` is the search, a word prefix of the name, keyed as on the
 * orders index (`app.orders.tsx`): it is submitted on Enter or blur, not per
 * keystroke, and a search ignores `state`, which stays in the URL so Clear
 * search returns to it (`Domain.ListWorkflowsInput`). `?after=` is the page,
 * as the name of the last workflow on the page before; an absent `after` is
 * page one, and Previous is the browser's Back when the entry before is that
 * page ({@link HistoryState}'s `workflowsNextPage`). There is no tag filter:
 * a workflow's tag is its identity, not a grouping dimension, and one filter
 * button per tag made it look like one.
 *
 * The layout is `/app/workflows` rather than `/app` because only the
 * workflows screens read `state`; retained on `/app` it would ride onto every
 * other screen's links. No `stripSearchParams`: absence is the default.
 * A value the page does not know — a stale link, a hand-edited URL — reads as
 * no filter ({@link lenientSearchKey}): a wrong filter is not an error
 * condition.
 */
const WorkflowsSearch = Schema.Struct({
  state: lenientSearchKey(Domain.WorkflowsIndexState),
  q: lenientSearchKey(ListSearchParam),
  after: lenientSearchKey(Domain.WorkflowName),
});

/** Layout for the workflows pages: the search context ({@link WorkflowsSearch}) and nothing else. */
export const Route = createFileRoute("/app/workflows")({
  validateSearch: Schema.toStandardSchemaV1(WorkflowsSearch),
  search: {
    middlewares: [retainSearchParams(["state", "q", "after"])],
  },
  component: () => <Outlet />,
});
