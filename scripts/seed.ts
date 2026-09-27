#!/usr/bin/env node
/**
 * `pnpm seed`: posts the development fixture to the running dev server
 * ({@link seed} in `scripts/lib/seed.ts` has the rules). `SEED_SHOP` picks the
 * shop.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect } from "effect";
import process from "node:process";

import { DEFAULT_SEED_SHOP, seed, SeedError } from "./lib/seed.ts";

const port = process.env.PORT;

NodeRuntime.runMain(
  (port === undefined
    ? Effect.fail(
        new SeedError({
          message: "pnpm seed requires PORT in .env (run via `pnpm seed`).",
        }),
      )
    : seed({ port, shop: process.env.SEED_SHOP ?? DEFAULT_SEED_SHOP })
  ).pipe(Effect.flatMap(Console.log)),
);
