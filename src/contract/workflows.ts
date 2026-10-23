import * as Schema from "effect/Schema";
import {
  ListSearch,
  WorkflowIdInput,
  WorkflowName,
  WorkflowsIndexState,
} from "../domain/shop-work.ts";

/**
 * Rows per page of the workflows index, against the controls table's 25 for an index,
 * because a shop holds at most `WorkflowLimits.maxWorkflows` (200), four pages.
 */
export const WORKFLOWS_PAGE_SIZE = 50;

const sessionToken = Schema.NonEmptyString;

/**
 * `BackendApi.workflowsPage`' input: the merchant's session token, which names the shop, then the
 * workflows index's filter, search and page (`ListWorkflowsInput`; `after` is its `cursor`). The
 * route reads them leniently from its URL, so a value here has already decoded.
 */
export const WorkflowsPageRequest = Schema.Struct({
  sessionToken,
  state: Schema.NullOr(WorkflowsIndexState),
  q: Schema.NullOr(ListSearch),
  after: Schema.NullOr(WorkflowName),
});
export type WorkflowsPageRequest = typeof WorkflowsPageRequest.Type;

/** `BackendApi.workflowDetail`' input: the workflow the page or the editor shows. */
export const WorkflowDetailRequest = Schema.Struct({
  sessionToken,
  workflowId: WorkflowIdInput.fields.workflowId,
});
export type WorkflowDetailRequest = typeof WorkflowDetailRequest.Type;

/** `BackendApi.setupFacts`' input: the session token alone. */
export const SetupFactsRequest = Schema.Struct({ sessionToken });
export type SetupFactsRequest = typeof SetupFactsRequest.Type;
