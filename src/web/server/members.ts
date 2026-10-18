import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Forbidden, ReturnPath, Unauthorized } from "../../contract/auth.ts";
import { MemberDetailRequest, MembersPageRequest } from "../../contract/members.ts";
import { homeFor } from "../client/session.ts";
import { backend, requestInfo, rescue } from "./backend.ts";
import { embeddedSessionToken } from "./shopify.ts";

/** The only page that lists members, so where sign-in returns to. */
const MEMBERS_PATH = Option.getOrUndefined(
  Schema.decodeUnknownOption(ReturnPath)("/admin/members"),
);

/**
 * Every shop's members, for an admin. Signed out goes to sign-in and back here afterwards;
 * anyone else, who can only be a `user`, goes to their own home.
 */
export const listMembers = createServerFn({ method: "GET" }).handler(() =>
  backend()
    .listMembers(requestInfo())
    .catch(
      rescue(Schema.Union([Unauthorized, Forbidden]), (failure) =>
        Match.valueTags(failure, {
          Unauthorized: () => {
            throw redirect({ to: "/sign-in", search: { redirect: MEMBERS_PATH } });
          },
          Forbidden: () => {
            throw redirect({ to: homeFor("user") });
          },
        }),
      ),
    ),
);

/** The document's `id_token`, for a call made in-process during SSR; see `embeddedSessionToken`. */
const idToken = { idToken: Schema.optional(Schema.NonEmptyString) };

/**
 * The members index's page, for its loader. The token is only verified, never exchanged
 * (`BackendApi.membersPage`).
 */
export const membersPage = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        ...idToken,
        q: MembersPageRequest.fields.q,
        after: MembersPageRequest.fields.after,
      }),
    ),
  )
  .handler(({ data: { q, after }, context: { sessionToken, rescueToken } }) =>
    backend().membersPage(requestInfo(), { sessionToken, q, after }).catch(rescueToken),
  );

/** The member page's data, for its loader, as {@link membersPage}; `null` is no such member. */
export const memberDetail = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        ...idToken,
        memberId: MemberDetailRequest.fields.memberId,
        teamsAfter: MemberDetailRequest.fields.teamsAfter,
      }),
    ),
  )
  .handler(({ data: { memberId, teamsAfter }, context: { sessionToken, rescueToken } }) =>
    backend()
      .memberDetail(requestInfo(), { sessionToken, memberId, teamsAfter })
      .catch(rescueToken),
  );
