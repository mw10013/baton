import {
  ClientOnly,
  createFileRoute,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { PlanCache } from "@/components/PlanCache";
import { adminServerFnMiddleware } from "@/lib/AdminServerFnMiddleware";
import * as Domain from "@/lib/Domain";
import { formatDateTime } from "@/lib/format";
import { Repository } from "@/lib/Repository";

const LIMIT = 25;

const shopSessionSearchSchema = Schema.Struct({
  after: Schema.optional(Schema.NonEmptyString),
  before: Schema.optional(Schema.NonEmptyString),
  filter: Schema.optional(Schema.Trim),
});

const getShopSessionRedactedPage = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(shopSessionSearchSchema))
  .middleware([adminServerFnMiddleware])
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const repo = yield* Repository;
        return yield* repo.getShopSessionRedactedPage({
          ...data,
          limit: LIMIT,
        });
      }),
    ),
  );

export const Route = createFileRoute("/admin/shops")({
  validateSearch: Schema.toStandardSchemaV1(shopSessionSearchSchema),
  loaderDeps: ({ search }) => ({
    after: search.after,
    before: search.before,
    filter: search.filter,
  }),
  loader: {
    handler: async ({ deps }) => {
      if (deps.after !== undefined && deps.before !== undefined)
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect({
          to: "/admin/shops",
          search: { after: deps.after, filter: deps.filter },
        });
      const result = await getShopSessionRedactedPage({ data: deps });
      if (
        (deps.after !== undefined || deps.before !== undefined) &&
        result.shopSessions.length === 0
      )
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect({
          to: "/admin/shops",
          search: { filter: deps.filter },
        });
      return result;
    },
    staleReloadMode: "blocking",
  },
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();
  const { filter } = Route.useSearch();
  const page = Route.useLoaderData();
  const now = Date.now();
  return (
    <s-page heading="Shops" inlineSize="large">
      <s-link
        slot="breadcrumb-actions"
        onClick={() => void router.navigate({ to: "/admin" })}
      >
        Admin
      </s-link>
      <s-section padding="none" accessibilityLabel="Shops table">
        <ClientOnly>
          <s-table
            paginate={page.hasPreviousPage || page.hasNextPage}
            hasPreviousPage={page.hasPreviousPage}
            hasNextPage={page.hasNextPage}
            onPreviousPage={() => {
              void router.navigate({
                to: "/admin/shops",
                search: {
                  before: page.startCursor ?? undefined,
                  after: undefined,
                  filter,
                },
              });
            }}
            onNextPage={() => {
              void router.navigate({
                to: "/admin/shops",
                search: {
                  after: page.endCursor ?? undefined,
                  before: undefined,
                  filter,
                },
              });
            }}
          >
            <s-search-field
              slot="filters"
              label="Search by shop"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by shop"
              defaultValue={filter ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value.trim();
                void router.navigate({
                  to: "/admin/shops",
                  search: {
                    filter: value === "" ? undefined : value,
                    after: undefined,
                    before: undefined,
                  },
                });
              }}
            />
            <s-table-header-row>
              <s-table-header listSlot="primary">Shop</s-table-header>
              <s-table-header>Shop Agent ID</s-table-header>
              <s-table-header>Shop GID</s-table-header>
              <s-table-header>Scope</s-table-header>
              <s-table-header>Access token expires</s-table-header>
              <s-table-header>Refresh token expires</s-table-header>
              <s-table-header>Plan</s-table-header>
              <s-table-header>Plan expires</s-table-header>
              <s-table-header>Access token</s-table-header>
              <s-table-header>Refresh token</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {page.shopSessions.map((shopSession) => (
                <s-table-row key={shopSession.shop} id={shopSession.shop}>
                  <s-table-cell>
                    <s-link
                      onClick={() =>
                        void router.navigate({
                          to: "/admin/shop/$shop",
                          params: { shop: shopSession.shop },
                        })
                      }
                    >
                      {shopSession.shop}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{shopSession.shopAgentId}</s-table-cell>
                  <s-table-cell>{shopSession.shopGid}</s-table-cell>
                  <s-table-cell>{shopSession.scope ?? ""}</s-table-cell>
                  <s-table-cell>
                    {formatDateTime(shopSession.accessTokenExpiresAt)}
                  </s-table-cell>
                  <s-table-cell>
                    {formatDateTime(shopSession.refreshTokenExpiresAt)}
                  </s-table-cell>
                  <s-table-cell>
                    <PlanCache
                      plan={Domain.adminShopPlanCache(shopSession, now)}
                    />
                  </s-table-cell>
                  <s-table-cell>
                    {formatDateTime(shopSession.planHandleExpiresAt)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={shopSession.hasAccessToken ? "success" : "critical"}
                    >
                      {shopSession.hasAccessToken ? "Present" : "Missing"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        shopSession.hasRefreshToken ? "success" : "critical"
                      }
                    >
                      {shopSession.hasRefreshToken ? "Present" : "Missing"}
                    </s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </ClientOnly>
      </s-section>
      {page.shopSessions.length === 0 && (
        <s-banner tone="info">No sessions.</s-banner>
      )}
    </s-page>
  );
}
