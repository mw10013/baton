import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import {
  memberServerFnMiddleware,
  requireMember,
} from "@/lib/MemberServerFnMiddleware";
import { ShopAgentClient } from "@/lib/ShopAgentClient";

const ShopParamInput = Schema.Struct({ shop: Schema.String });

const getShopPage = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ShopParamInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        const shopAgentClient = yield* ShopAgentClient;
        return { shop, shopInfo: yield* shopAgentClient.getShopInfo(shop) };
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop")({
  loader: ({ params }) => getShopPage({ data: { shop: params.shop } }),
  component: RouteComponent,
});

function RouteComponent() {
  const { shop, shopInfo } = Route.useLoaderData();
  return (
    <s-page heading={shopInfo.name} inlineSize="small">
      <s-section heading="Shop" accessibilityLabel="Shop info">
        <s-stack gap="base">
          <s-paragraph>{shopInfo.myshopifyDomain}</s-paragraph>
          <s-paragraph color="subdued">
            You have member access to this shop ({shop}).
          </s-paragraph>
          <Link to="/shop">Back to your shops</Link>
        </s-stack>
      </s-section>
    </s-page>
  );
}
