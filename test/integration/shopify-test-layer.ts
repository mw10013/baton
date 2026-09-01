import { env } from "cloudflare:workers";
import { ConfigProvider, Context, Layer } from "effect";

import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { CurrentRequest } from "@/lib/CurrentRequest";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import { Repository } from "@/lib/Repository";
import { Shopify } from "@/lib/Shopify";

export const shopifyTestLayer = () => {
  const baseLayer = Layer.succeedContext(
    Context.make(CloudflareEnv, env).pipe(
      Context.add(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          SHOPIFY_API_KEY: "test_api_key",
          SHOPIFY_API_SECRET: "test_api_secret",
          SHOPIFY_APP_URL: "https://example.com",
        }),
      ),
    ),
  );
  const repositoryLayer = Layer.provideMerge(
    Repository.layerNoDeps,
    Layer.mergeAll(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, baseLayer),
      baseLayer,
    ),
  );
  const requestLayer = Layer.succeedContext(
    Context.make(CurrentRequest, new Request("https://example.com/")),
  );
  return Layer.provideMerge(
    Shopify.layerNoDeps,
    Layer.merge(repositoryLayer, requestLayer),
  );
};
