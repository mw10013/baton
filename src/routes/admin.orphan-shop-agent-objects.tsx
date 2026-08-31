import { useState } from "react";

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { adminServerFnMiddleware } from "@/lib/AdminServerFnMiddleware";
import { Repository } from "@/lib/Repository";
import { ShopAgentObjects } from "@/lib/ShopAgentObjects";
import { destroyShopAgentObjectById } from "@/lib/Shopify";

const LIMIT = 1000;

const searchSchema = Schema.Struct({
  cursor: Schema.optional(Schema.NonEmptyString),
});

const listOrphanShopAgentObjects = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(searchSchema))
  .middleware([adminServerFnMiddleware])
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const shopAgentObjects = yield* ShopAgentObjects;
        const page = yield* shopAgentObjects.list({
          cursor: data.cursor,
          limit: LIMIT,
        });
        const orphanIds = new Set(
          yield* (yield* Repository).findOrphanShopAgentIds(
            page.objects
              .filter((object) => object.hasStoredData !== false)
              .map((object) => object.id),
          ),
        );
        return {
          orphans: page.objects.filter(
            (object) =>
              object.hasStoredData === false || orphanIds.has(object.id),
          ),
          cursor: page.cursor,
        };
      }).pipe(Effect.provide(ShopAgentObjects.layer)),
    ),
  );

const destroyOrphan = createServerFn({ method: "POST" })
  .validator(
    Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.NonEmptyString })),
  )
  .middleware([adminServerFnMiddleware])
  .handler(({ data, context: { runEffect } }) =>
    runEffect(destroyShopAgentObjectById(data.id)),
  );

export const Route = createFileRoute("/admin/orphan-shop-agent-objects")({
  validateSearch: Schema.toStandardSchemaV1(searchSchema),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: {
    handler: ({ deps }) => listOrphanShopAgentObjects({ data: deps }),
    staleReloadMode: "blocking",
  },
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();
  const { cursor } = Route.useSearch();
  const page = Route.useLoaderData();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [destroyingId, setDestroyingId] = useState<string>();
  const hasNextPage = page.cursor !== undefined;
  return (
    <s-page heading="Orphan Shop Agent Objects" inlineSize="large">
      <s-link
        slot="breadcrumb-actions"
        onClick={() => void router.navigate({ to: "/admin" })}
      >
        Admin
      </s-link>
      <s-section
        padding="none"
        accessibilityLabel="Orphan Shop Agent objects table"
      >
        <s-table
          paginate={history.length > 0 || hasNextPage}
          hasPreviousPage={history.length > 0}
          hasNextPage={hasNextPage}
          onPreviousPage={() => {
            const previous = history.at(-1);
            setHistory(history.slice(0, -1));
            void router.navigate({
              to: "/admin/orphan-shop-agent-objects",
              search: previous ? { cursor: previous } : {},
            });
          }}
          onNextPage={() => {
            setHistory([...history, cursor]);
            void router.navigate({
              to: "/admin/orphan-shop-agent-objects",
              search: page.cursor ? { cursor: page.cursor } : {},
            });
          }}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Object ID</s-table-header>
            <s-table-header>Name</s-table-header>
            <s-table-header>Stored data</s-table-header>
            <s-table-header>Action</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {page.orphans.map((object) => (
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
                <s-table-cell>
                  {object.hasStoredData === false ? null : (
                    <s-button
                      tone="critical"
                      loading={destroyingId === object.id}
                      disabled={destroyingId !== undefined}
                      onClick={() => {
                        setDestroyingId(object.id);
                        void destroyOrphan({ data: { id: object.id } })
                          .then(() => router.invalidate({ sync: true }))
                          .finally(() => {
                            setDestroyingId(undefined);
                          });
                      }}
                    >
                      Destroy
                    </s-button>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
      {page.orphans.length === 0 &&
        (hasNextPage ? (
          <s-banner tone="info">
            No orphans in this batch of {LIMIT}. Check the next batch.
          </s-banner>
        ) : (
          <s-banner tone="success">No orphans.</s-banner>
        ))}
    </s-page>
  );
}
