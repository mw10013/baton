#!/usr/bin/env node
/**
 * `pnpm showcase:store`: writes the showcase shop's products into the dev
 * store, archives the others, closes the leftover order and keeps three real
 * orders open ({@link showcaseStore} in `scripts/lib/showcase-store.ts` has the
 * rules). The store is this checkout's `SHOPIFY_DEV_STORE`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect } from "effect";
import process from "node:process";

import { showcaseStore, ShowcaseStoreError } from "./lib/showcase-store.ts";

const store = process.env.SHOPIFY_DEV_STORE;

NodeRuntime.runMain(
  (store === undefined
    ? Effect.fail(
        new ShowcaseStoreError({
          message:
            "pnpm showcase:store requires SHOPIFY_DEV_STORE in .env (run via `pnpm showcase:store`).",
        }),
      )
    : showcaseStore(`${store}.myshopify.com`)
  ).pipe(Effect.flatMap(Console.log), Effect.provide(NodeServices.layer)),
);
