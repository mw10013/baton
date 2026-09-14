import type * as Domain from "@/lib/Domain";

import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";

const ShopParamInput = Schema.Struct({ shop: Schema.String });

/**
 * One D1 read and nothing else. This page used to call the Shopify Admin API
 * through the Durable Object for the shop's display name; it no longer does —
 * a member is shown the `myshopify.com` domain, which `requireMember` already
 * returns. See `Domain.ShopIndexLoaderData`.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ShopParamInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const { shop, teams } = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        return { shop, teams } satisfies Domain.ShopIndexLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/")({
  loader: ({ params }) => getLoaderData({ data: { shop: params.shop } }),
  component: RouteComponent,
});

function RouteComponent() {
  const { shop, teams } = Route.useLoaderData();
  return (
    <s-page heading={shop} inlineSize="small">
      <s-section heading="Shop" accessibilityLabel="Shop info">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            You have member access to this shop.
          </s-paragraph>
          <Link to="/shop">Back to your shops</Link>
        </s-stack>
      </s-section>
      <s-section heading="Your teams" accessibilityLabel="Your teams">
        {teams.length === 0 ? (
          <s-paragraph color="subdued">
            You&rsquo;re not on a team yet. Ask the shop owner to add you to a
            team to see work.
          </s-paragraph>
        ) : (
          <s-stack gap="small-300">
            {teams.map((team) => (
              <s-text key={team.id}>{team.name}</s-text>
            ))}
            <Link to="/shop/$shop/queue" params={{ shop }}>
              See your work
            </Link>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
