import { notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Forbidden, ReturnPath, Unauthorized } from "../../contract/auth.ts";
import { PaymentRequired } from "../../contract/billing.ts";
import { NotAShopMember, ShopAccessInput } from "../../contract/shop.ts";
import type { ShopKey } from "../../domain/platform.ts";
import { MemberWorkflowPageRequest, WorkflowsListRequest } from "../../contract/workflows-list.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/**
 * A member loader's refusal, as the member area renders it: a member no longer signed in goes
 * to sign-in and back to `path`, as the `/shop` guard would send them; a member of a shop whose
 * app subscription lapsed goes to Subscription inactive (`/shop/$key/lapsed`); anyone the gate
 * does not admit to the shop (an admin, a non-member, a member since removed) reads as the shop
 * not found, which the member shop layout renders as "No access".
 */
const memberRefusal = (key: ShopKey, path: string) =>
  rescue(Schema.Union([Unauthorized, PaymentRequired, Forbidden, NotAShopMember]), (failure) =>
    Match.valueTags(failure, {
      PaymentRequired: (): never => {
        throw redirect({ to: "/shop/$key/lapsed", params: { key } });
      },
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
 * The gate alone, for the member shop layout's loader: who the socket will say this browser is,
 * or the {@link memberRefusal}. Each page under the layout reads its own data.
 */
export const getShopAccess = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ShopAccessInput))
  .handler(({ data }) =>
    backend()
      .shopAccess(requestInfo(), data)
      .catch(memberRefusal(data.key, `/shop/${data.key}`)),
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
      .catch(memberRefusal(data.key, `/shop/${data.key}/workflows`)),
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
      .catch(memberRefusal(data.key, `/shop/${data.key}/workflows/${data.runId}`)),
  );
