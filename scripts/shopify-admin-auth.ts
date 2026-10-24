#!/usr/bin/env node
/**
 * `vp run e2e:auth`: exports the agent Chrome's Shopify login into the Playwright storage state the
 * `embedded` e2e project loads. The e2e run does this itself; this is for a script run alone.
 * The logic is in {@link exportShopifyAdminAuth}.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { CliError, Command, Flag } from "effect/cli";

import { exportShopifyAdminAuth } from "./lib/agent-chrome.ts";

Command.make(
  "shopify-admin-auth",
  {
    output: Flag.String("output").pipe(Flag.withDefault("playwright/.auth/shopify-admin.json")),
  },
  ({ output }) =>
    Effect.gen(function* () {
      const store = yield* Config.NonEmptyString("SHOPIFY_E2E_STORE");
      const count = yield* exportShopifyAdminAuth({ output, store });
      yield* Console.log(`Wrote ${String(count)} cookies to ${output}`);
    }).pipe(
      Effect.mapError(
        (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
      ),
    ),
).pipe(
  Command.withDescription("Export the agent Chrome's Shopify login into Playwright storage state."),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
