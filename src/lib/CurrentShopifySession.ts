import type * as ShopifyApi from "@shopify/shopify-api";

import { Context } from "effect";

export class CurrentShopifySession extends Context.Service<
  CurrentShopifySession,
  ShopifyApi.Session
>()("CurrentShopifySession") {}
