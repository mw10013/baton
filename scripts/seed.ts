#!/usr/bin/env node
/**
 * `pnpm seed`: posts the development fixture to the running dev server
 * ({@link seed} in `scripts/lib/seed.ts` has the rules). The shop is this
 * checkout's `SHOPIFY_DEV_STORE`, unless `SEED_SHOP` names another.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect } from "effect";
import process from "node:process";

import { seed, SeedError } from "./lib/seed.ts";

const port = process.env.PORT;
const store = process.env.SHOPIFY_DEV_STORE;
const shop =
  process.env.SEED_SHOP ??
  (store === undefined ? undefined : `${store}.myshopify.com`);

NodeRuntime.runMain(
  (port === undefined || shop === undefined
    ? Effect.fail(
        new SeedError({
          message:
            "pnpm seed requires PORT and SHOPIFY_DEV_STORE in .env (run via `pnpm seed`).",
        }),
      )
    : seed({ port, shop })
  ).pipe(Effect.flatMap(Console.log)),
);
