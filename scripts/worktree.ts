#!/usr/bin/env node
/**
 * `pnpm worktree:init --port <port> --store <store>`: prepares a linked
 * worktree (created with `herdr worktree create --branch wt/NN`) to run its
 * own dev server beside the main checkout's. A slot is a checkout, a port and
 * a dev store: `wt/02` serves `sandbox-shop-02` on 3801, the main checkout
 * serves `sandbox-shop-01` on 3800. The model is in `scripts/lib/worktree.ts`.
 *
 * Idempotent: a file that exists is verified, never rewritten, and a second
 * run only checks. Steps, in order:
 *
 * 1. Refuse the main checkout, and a port or store another checkout's `.env`
 *    already holds.
 * 2. `.env`: copied from the main checkout's (not `.env.example`, whose
 *    secrets are blank) with `PORT`, `BETTER_AUTH_URL` and `SHOPIFY_DEV_STORE`
 *    set for this slot.
 * 3. `refs`: a symlink to the main checkout's `refs/`.
 * 4. `pnpm install`.
 * 5. The D1 migrations, applied to this checkout's empty local D1: without
 *    them the first request that reads `ShopSession` fails, including the
 *    sample `app/uninstalled` webhook the Shopify CLI sends on its first run
 *    in a new directory.
 *
 * It does not start the server: `pnpm dev:start --seed` does, and installs the
 * app on the store.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, FileSystem } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./lib/command.ts";
import { getDatabaseName } from "./lib/d1.ts";
import {
  checkoutKind,
  checkoutPaths,
  claimConflicts,
  envDisagreements,
  setEnvKeys,
  slotEnv,
  WorktreeError,
} from "./lib/worktree.ts";

const fail = (message: string) => Effect.fail(new WorktreeError({ message }));

const readIfExists = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(file))
      ? yield* fs.readFileString(file)
      : undefined;
  });

const init = Effect.fn(function* (port: number, store: string) {
  const fs = yield* FileSystem.FileSystem;
  const expected = slotEnv(port, store);
  const { linked, mainCheckout } = yield* checkoutKind;
  if (!linked)
    return yield* fail(
      "this is the main checkout: run worktree:init in a linked worktree",
    );
  const here = process.cwd();

  const others = yield* Effect.forEach(
    (yield* checkoutPaths).filter((checkout) => checkout !== here),
    (checkout) =>
      readIfExists(path.join(checkout, ".env")).pipe(
        Effect.map((env) => ({ checkout, env: env ?? "" })),
      ),
  );
  const conflicts = claimConflicts(others, expected);
  if (conflicts.length > 0) return yield* fail(conflicts.join("\n"));

  const env = yield* readIfExists(".env");
  if (env === undefined) {
    const mainEnv = yield* readIfExists(path.join(mainCheckout, ".env"));
    if (mainEnv === undefined)
      return yield* fail(`no .env in the main checkout (${mainCheckout})`);
    yield* fs.writeFileString(".env", setEnvKeys(mainEnv, expected));
    yield* Console.log("ok    .env copied from the main checkout");
  } else {
    const disagreements = envDisagreements(env, expected);
    if (disagreements.length > 0)
      return yield* fail(
        `.env disagrees with --port/--store; fix it by hand:\n${disagreements.join("\n")}`,
      );
    yield* Console.log("ok    .env verified");
  }

  const refsTarget = path.join(mainCheckout, "refs");
  const refsLink = yield* fs.readLink("refs").pipe(Effect.option);
  if (refsLink._tag === "Some") {
    if (refsLink.value !== refsTarget)
      return yield* fail(
        `refs points at ${refsLink.value}, expected ${refsTarget}`,
      );
    yield* Console.log("ok    refs link verified");
  } else if (yield* fs.exists("refs"))
    return yield* fail(
      "refs is a real directory: remove it; the main checkout's refs/ is shared through a symlink",
    );
  else {
    yield* fs.symlink(refsTarget, "refs");
    yield* Console.log(`ok    refs -> ${refsTarget}`);
  }

  yield* runCommand("pnpm", ["install", "--frozen-lockfile"]);
  yield* Console.log("ok    pnpm install");

  yield* runCommand("pnpm", [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    yield* getDatabaseName("local"),
    "--local",
  ]);
  yield* Console.log("ok    local D1 migrations applied");

  return yield* Console.log(
    `\nslot ready: port ${expected.PORT}, store ${store}. Next: pnpm dev:start --seed`,
  );
});

const initCommand = Command.make(
  "init",
  {
    port: Flag.integer("port").pipe(
      Flag.withDescription("This checkout's dev server port, e.g. 3801"),
    ),
    store: Flag.string("store").pipe(
      Flag.withDescription(
        "This checkout's dev store handle, e.g. sandbox-shop-02",
      ),
    ),
  },
  ({ port, store }) =>
    init(port, store).pipe(
      Effect.mapError(
        (error) =>
          new CliError.UserError({
            cause: error,
            userMessage: error instanceof Error ? error.message : String(error),
          }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Prepare a linked worktree: .env, refs link, pnpm install, local D1 migrations. Verifies instead of rewriting on a second run.",
  ),
);

const worktreeCommand = Command.make("worktree").pipe(
  Command.withDescription("Set up linked worktrees of this repository"),
  Command.withSubcommands([initCommand]),
);

NodeRuntime.runMain(
  worktreeCommand.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer),
  ),
);
