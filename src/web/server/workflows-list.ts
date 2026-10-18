import { notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Forbidden, ReturnPath, Unauthorized } from "../../contract/auth.ts";
import { NotAShopMember } from "../../contract/shop.ts";
import { MemberWorkflowPageRequest, WorkflowsListRequest } from "../../contract/workflows-list.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/**
 * A member loader's refusal, as the member area renders it: a member no longer signed in goes
 * to sign-in and back to `path`; anyone the gate does not admit to the shop (an admin, a
 * non-member) reads as the shop not found.
 */
const memberRefusal = (path: string) =>
  rescue(Schema.Union([Unauthorized, Forbidden, NotAShopMember]), (failure) =>
    Match.valueTags(failure, {
      Unauthorized: (): never => {
        throw redirect({
          to: "/sign-in",
          search: { redirect: Option.getOrUndefined(decodeReturnPath(path)) },
        });
      },
      Forbidden: (): never => {
        throw notFound();
      },
      NotAShopMember: (): never => {
        throw notFound();
      },
    }),
  );

/**
 * The workflows list's first paint, for its loader: the member the cookie names, their teams and
 * the list for the query the URL carries (`BackendApi.workflowsList`).
 */
export const workflowsList = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(WorkflowsListRequest))
  .handler(({ data }) =>
    backend()
      .workflowsList(requestInfo(), data)
      .catch(memberRefusal(`/shop/${data.key}/workflows`)),
  );

/**
 * The member's workflow page's first paint, for its loader (`BackendApi.memberWorkflowPage`);
 * its `page` is null for a run the member cannot see.
 */
export const memberWorkflowPage = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(MemberWorkflowPageRequest))
  .handler(({ data }) =>
    backend()
      .memberWorkflowPage(requestInfo(), data)
      .catch(memberRefusal(`/shop/${data.key}/workflows/${data.runId}`)),
  );
