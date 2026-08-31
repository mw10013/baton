import { useState } from "react";

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { adminServerFnMiddleware } from "@/lib/AdminServerFnMiddleware";
import { ShopAgentObjects } from "@/lib/ShopAgentObjects";

const LIMIT = 1000;
const TABLE_LIMIT = 50;

const PageIndex = Schema.Union([
  Schema.Int,
  Schema.NumberFromString.check(Schema.isInt()),
]).check(Schema.isGreaterThanOrEqualTo(0));

const searchSchema = Schema.Struct({
  cursor: Schema.optional(Schema.NonEmptyString),
  page: Schema.optional(PageIndex),
});

const listShopAgentObjects = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(searchSchema))
  .middleware([adminServerFnMiddleware])
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const shopAgentObjects = yield* ShopAgentObjects;
        return yield* shopAgentObjects.list({
          cursor: data.cursor,
          limit: LIMIT,
        });
      }).pipe(Effect.provide(ShopAgentObjects.layer)),
    ),
  );

export const Route = createFileRoute("/admin/shop-agent-objects")({
  validateSearch: Schema.toStandardSchemaV1(searchSchema),
  loaderDeps: ({ search }) => ({ cursor: search.cursor, page: search.page }),
  loader: {
    handler: ({ deps }) => listShopAgentObjects({ data: deps }),
    staleReloadMode: "blocking",
  },
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();
  const { cursor, page = 0 } = Route.useSearch();
  const data = Route.useLoaderData();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const pageIndex = page;
  const objects = data.objects.slice(
    pageIndex * TABLE_LIMIT,
    (pageIndex + 1) * TABLE_LIMIT,
  );
  const hasPreviousPage = pageIndex > 0 || history.length > 0;
  const hasNextPage =
    (pageIndex + 1) * TABLE_LIMIT < data.objects.length ||
    data.cursor !== undefined;
  return (
    <s-page heading="Shop Agent Objects" inlineSize="large">
      <s-link
        slot="breadcrumb-actions"
        onClick={() => void router.navigate({ to: "/admin" })}
      >
        Admin
      </s-link>
      <s-section padding="none" accessibilityLabel="Shop Agent objects table">
        <s-table
          paginate={hasPreviousPage || hasNextPage}
          hasPreviousPage={hasPreviousPage}
          hasNextPage={hasNextPage}
          onPreviousPage={() => {
            if (pageIndex > 0) {
              void router.navigate({
                to: "/admin/shop-agent-objects",
                search: { cursor, page: pageIndex - 1 },
              });
              return;
            }
            const previous = history.at(-1);
            setHistory(history.slice(0, -1));
            void router.navigate({
              to: "/admin/shop-agent-objects",
              search: previous ? { cursor: previous } : {},
            });
          }}
          onNextPage={() => {
            if ((pageIndex + 1) * TABLE_LIMIT < data.objects.length) {
              void router.navigate({
                to: "/admin/shop-agent-objects",
                search: { cursor, page: pageIndex + 1 },
              });
              return;
            }
            setHistory([...history, cursor]);
            void router.navigate({
              to: "/admin/shop-agent-objects",
              search: data.cursor ? { cursor: data.cursor } : {},
            });
          }}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Object ID</s-table-header>
            <s-table-header>Name</s-table-header>
            <s-table-header>Stored data</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {objects.map((object) => (
              <s-table-row key={object.id} id={object.id}>
                <s-table-cell>
                  <s-text>{object.id}</s-text>
                </s-table-cell>
                <s-table-cell>
                  <s-text>{object.name}</s-text>
                </s-table-cell>
                <s-table-cell>
                  {object.hasStoredData === undefined ? (
                    <s-text tone="neutral">undefined</s-text>
                  ) : (
                    <s-badge
                      tone={object.hasStoredData ? "success" : "neutral"}
                    >
                      {object.hasStoredData ? "Yes" : "No"}
                    </s-badge>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
      {data.objects.length === 0 && (
        <s-banner tone="info">No Shop Agent objects found.</s-banner>
      )}
    </s-page>
  );
}
