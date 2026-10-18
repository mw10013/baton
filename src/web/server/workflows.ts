import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";
import { WorkflowDetailRequest, WorkflowsPageRequest } from "../../contract/workflows.ts";
import { backend, requestInfo } from "./backend.ts";
import { embeddedSessionToken } from "./shopify.ts";

/** The document's `id_token`, for a call made in-process during SSR; see `embeddedSessionToken`. */
const idToken = { idToken: Schema.optional(Schema.NonEmptyString) };

/**
 * The workflows index's page, for its loader. The token is only verified, never exchanged
 * (`BackendApi.workflowsPage`).
 */
export const workflowsPage = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        ...idToken,
        state: WorkflowsPageRequest.fields.state,
        q: WorkflowsPageRequest.fields.q,
        after: WorkflowsPageRequest.fields.after,
      }),
    ),
  )
  .handler(({ data: { state, q, after }, context: { sessionToken, rescueToken } }) =>
    backend().workflowsPage(requestInfo(), { sessionToken, state, q, after }).catch(rescueToken),
  );

/**
 * The workflow page's and the editor's data, for their loaders, as {@link workflowsPage}; `null`
 * is no such workflow.
 */
export const workflowDetail = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ ...idToken, workflowId: WorkflowDetailRequest.fields.workflowId }),
    ),
  )
  .handler(({ data: { workflowId }, context: { sessionToken, rescueToken } }) =>
    backend().workflowDetail(requestInfo(), { sessionToken, workflowId }).catch(rescueToken),
  );
