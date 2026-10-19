import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  AdminShopRequest,
  PlanRefreshFailed,
  ShopSessionsPageRequest,
} from "../../contract/admin.ts";
import { Forbidden, ReturnPath, Unauthorized } from "../../contract/auth.ts";
import { homeFor } from "../client/session.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

const decodeReturnPath = Schema.decodeUnknownSync(ReturnPath);

/**
 * The admin console's rescue of the Backend's role check: signed out goes to sign-in and back to
 * `path` afterwards; anyone else, who can only be a `user`, goes to their own home. As
 * `listMembers`' does.
 */
const rescueAdmin = (path: string) =>
  rescue(Schema.Union([Unauthorized, Forbidden]), (failure) =>
    Match.valueTags(failure, {
      Unauthorized: () => {
        throw redirect({ to: "/sign-in", search: { redirect: decodeReturnPath(path) } });
      },
      Forbidden: () => {
        throw redirect({ to: homeFor("user") });
      },
    }),
  );

/** The shop page's path, where sign-in returns to. */
const shopPath = (shop: string) => `/admin/shop/${shop}`;

/** The Shops list's page, for its loader (`BackendApi.shopSessionsPage`). */
export const shopSessionsPage = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ShopSessionsPageRequest))
  .handler(({ data }) =>
    backend().shopSessionsPage(requestInfo(), data).catch(rescueAdmin("/admin/shops")),
  );

/** The shop page's data, for its loader (`BackendApi.adminShop`). */
export const adminShop = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(AdminShopRequest))
  .handler(({ data }) =>
    backend()
      .adminShop(requestInfo(), data)
      .catch(rescueAdmin(shopPath(data.shop))),
  );

/**
 * Refresh plan (`BackendApi.refreshPlan`). POST: it writes. Answers `null` when the plan was
 * re-read, or {@link PlanRefreshFailed} as data, so the page can show its message.
 */
export const refreshPlan = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(AdminShopRequest))
  .handler(({ data }) =>
    backend()
      .refreshPlan(requestInfo(), data)
      .then(() => null)
      .catch(
        rescue(PlanRefreshFailed, ({ message }) => ({
          _tag: "PlanRefreshFailed" as const,
          message,
        })),
      )
      .catch(rescueAdmin(shopPath(data.shop))),
  );
