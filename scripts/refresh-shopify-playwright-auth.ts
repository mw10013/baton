#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  chromeProfile,
  refreshShopifyAuth,
} from "./lib/shopify-playwright-auth.ts";

try {
  process.loadEnvFile(".env.playwright");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
    throw error;
}

const command = Command.make(
  "refresh-shopify-playwright-auth",
  {
    output: Flag.string("output").pipe(
      Flag.withDefault("playwright/.auth/shopify-admin.json"),
    ),
    profile: Flag.string("profile").pipe(
      Flag.withDescription(
        "Chrome profile directory; defaults to SHOPIFY_CHROME_PROFILE or Default",
      ),
      Flag.withDefault(chromeProfile()),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription(
        "Read and decrypt cookies without writing storage state; may prompt for Keychain access",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fnUntraced(function* (options) {
    const count = yield* refreshShopifyAuth(options);
    yield* Console.log(
      options.dryRun
        ? `dry-run: ${count.toString()} Shopify cookie(s) found; not writing ${options.output}`
        : `Wrote ${count.toString()} cookies to ${options.output}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Export a logged-in Shopify session from Chrome into Playwright storage state. macOS only; may prompt for Keychain access.",
  ),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(command);
