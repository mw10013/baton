import {
  createFileRoute,
  Outlet,
  retainSearchParams,
} from "@tanstack/react-router";
import { Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { lenientSearchKey } from "@/lib/searchParams";

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
 * (`Domain.WorkflowsIndexState`): On and Off are workflow states. All is the
 * default and is written by leaving the key out; a stale `?view=` or
 * `?status=` from before the renames is an unknown key and reads as All.
 *
 * The filter buttons are in the URL, so a filtered list is a link someone can
 * send. The search text is not: it changes on every keystroke and is
 * nobody's destination. There is no tag filter: a workflow's tag is its
 * identity, not a grouping dimension, and one filter button per tag made it
 * look like one.
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
});

/** Layout for the workflows pages: the search context ({@link WorkflowsSearch}) and nothing else. */
export const Route = createFileRoute("/app/workflows")({
  validateSearch: Schema.toStandardSchemaV1(WorkflowsSearch),
  search: {
    middlewares: [retainSearchParams(["state"])],
  },
  component: () => <Outlet />,
});
