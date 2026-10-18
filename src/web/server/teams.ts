import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";
import { TeamDetailRequest, TeamsPageRequest } from "../../contract/members.ts";
import { backend, requestInfo } from "./backend.ts";
import { embeddedSessionToken } from "./shopify.ts";

/** The document's `id_token`, for a call made in-process during SSR; see `embeddedSessionToken`. */
const idToken = { idToken: Schema.optional(Schema.NonEmptyString) };

/**
 * The teams index's page, for its loader. The token is only verified, never exchanged
 * (`BackendApi.teamsPage`).
 */
export const teamsPage = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        ...idToken,
        q: TeamsPageRequest.fields.q,
        after: TeamsPageRequest.fields.after,
      }),
    ),
  )
  .handler(({ data: { q, after }, context: { sessionToken, rescueToken } }) =>
    backend().teamsPage(requestInfo(), { sessionToken, q, after }).catch(rescueToken),
  );

/** The team page's data, for its loader, as {@link teamsPage}; `null` is no such team. */
export const teamDetail = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        ...idToken,
        teamId: TeamDetailRequest.fields.teamId,
        membersAfter: TeamDetailRequest.fields.membersAfter,
      }),
    ),
  )
  .handler(({ data: { teamId, membersAfter }, context: { sessionToken, rescueToken } }) =>
    backend().teamDetail(requestInfo(), { sessionToken, teamId, membersAfter }).catch(rescueToken),
  );
