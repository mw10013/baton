#!/usr/bin/env node
/**
 * `vp run worktree:init`: prepares the linked worktree `wt-NN` it runs in to
 * serve its own dev server beside the main checkout's. Run it after
 * `vp install --frozen-lockfile` in a worktree T3 Code just created; it
 * needs `node_modules` to run.
 *
 * The index comes from the branch name: `wt-01` is index 1, serves on the
 * main checkout's `WEBSITE_PORT` + 1, runs `shopify app dev` on dev store
 * `mw10013-dev-shop-01` and keeps its e2e store `mw10013-e2e-shop-01`.
 *
 * Idempotent: a second run on an unchanged main checkout writes nothing. `.env` is the one file it
 * rewrites ({@link worktreeEnv}); links that exist are verified, never replaced. Steps, in order:
 *
 * 1. Refuse the main checkout, a branch other than `wt-NN`, and a port or
 *    dev or e2e store another checkout's `.env` already holds.
 * 2. `.env`: rebuilt from the main checkout's (not `.env.example`, which has
 *    no secrets) with `WEBSITE_PORT`, `SHOPIFY_DEV_STORE` and
 *    `SHOPIFY_E2E_STORE` set for this worktree; it prints the keys it added,
 *    changed or removed. A hand edit to a worktree's `.env` is lost here: make
 *    it in the main checkout's.
 * 3. The worktree's two stores, checked to exist ({@link checkStores}); a missing one fails
 *    with the command to create it by hand.
 * 4. `refs`: a symlink to the main checkout's `refs/`.
 * 5. `.env.<environment>` for each {@link Deployed} environment: a symlink to
 *    the main checkout's, so a deployed stage's values exist once; skipped
 *    when the main checkout has no such file.
 *
 * It does not start the server; `vp run dev` does.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { CliError, Command } from "effect/cli";
import path from "node:path";

import { Deployed } from "../src/backend/stage.ts";
import { checkStores } from "./lib/stores.ts";
import {
  checkoutKind,
  checkoutPaths,
  currentBranch,
  devStoreName,
  devStoreOf,
  e2eStoreName,
  e2eStoreOf,
  envChanges,
  websitePortOf,
  worktreeIndex,
  worktreeEnv,
  WorktreeError,
} from "./lib/worktree.ts";

const fail = (message: string) => new WorktreeError({ message });

const readIfExists = Effect.fn("readIfExists")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(file)) ? Option.some(yield* fs.readFileString(file)) : Option.none();
});

/**
 * `WEBSITE_PORT`, `SHOPIFY_DEV_STORE` and `SHOPIFY_E2E_STORE` of the checkout at `checkout`, each
 * none without a `.env` or the key in it.
 */
const checkoutClaims = Effect.fn("checkoutClaims")(function* (checkout: string) {
  const env = yield* readIfExists(path.join(checkout, ".env"));
  return yield* Option.match(env, {
    onNone: () =>
      Effect.succeed({
        port: Option.none<number>(),
        store: Option.none<string>(),
        e2eStore: Option.none<string>(),
      }),
    onSome: (text) =>
      Effect.all({
        port: websitePortOf(text).pipe(Effect.option),
        store: devStoreOf(text).pipe(Effect.orElseSucceed(Option.none<string>)),
        e2eStore: e2eStoreOf(text).pipe(Effect.orElseSucceed(Option.none<string>)),
      }),
  });
});

type LinkState =
  | { readonly _tag: "Symlink"; readonly target: string }
  | { readonly _tag: "Real" }
  | { readonly _tag: "Absent" };

const linkState = Effect.fn("linkState")(function* (
  link: string,
): Effect.fn.Return<LinkState, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* fs.readLink(link).pipe(Effect.option);
  if (Option.isSome(target)) return { _tag: "Symlink", target: target.value };
  return (yield* fs.exists(link).pipe(Effect.orElseSucceed(() => false)))
    ? { _tag: "Real" }
    : { _tag: "Absent" };
});

/**
 * Links `name` in the worktree at `root` to the same name in the main checkout: a link to it is
 * verified, a link elsewhere fails naming both, a real file or directory fails because it would
 * shadow the main checkout's, and an absent one is created.
 */
const linkToMain = Effect.fn("linkToMain")(function* (
  root: string,
  mainCheckout: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const link = path.join(root, name);
  const target = path.join(mainCheckout, name);
  yield* Match.valueTags(yield* linkState(link), {
    Symlink: (have) =>
      have.target === target
        ? Console.log(`ok    ${name} link verified`)
        : fail(`${name} points at ${have.target}, expected ${target}`),
    Real: () =>
      fail(
        `${name} is not a link: remove it; the main checkout's ${name} is shared through a symlink`,
      ),
    Absent: () =>
      fs.symlink(target, link).pipe(Effect.andThen(Console.log(`ok    ${name} -> ${target}`))),
  });
});

const init = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { root, linked, mainCheckout } = yield* checkoutKind;
  if (!linked)
    return yield* fail("this is the main checkout: run worktree:init in a linked worktree");
  const branch = yield* currentBranch;
  const index = yield* Effect.fromOption(worktreeIndex(branch)).pipe(
    Effect.mapError(() =>
      fail(
        `this worktree is on ${branch === "" ? "a detached HEAD" : branch}; expected a branch wt-01 to wt-99`,
      ),
    ),
  );

  const mainEnv = yield* readIfExists(path.join(mainCheckout, ".env")).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.mapError(() => fail(`no .env in the main checkout (${mainCheckout})`)),
  );
  const mainPort = yield* websitePortOf(mainEnv).pipe(
    Effect.mapError((error) => fail(`${mainCheckout}/.env: ${error.message}`)),
  );
  const port = mainPort + index;
  const store = devStoreName(index);
  const e2eStore = e2eStoreName(index);

  const others = (yield* checkoutPaths).filter((checkout) => checkout !== root);
  yield* Effect.forEach(others, (checkout) =>
    checkoutClaims(checkout).pipe(
      Effect.filterOrFail(
        (used) => !Option.contains(used.port, port),
        () => fail(`WEBSITE_PORT=${String(port)} is already used by ${checkout}`),
      ),
      Effect.filterOrFail(
        (used) => !Option.contains(used.store, store),
        () => fail(`SHOPIFY_DEV_STORE=${store} is already used by ${checkout}`),
      ),
      Effect.filterOrFail(
        (used) => !Option.contains(used.e2eStore, e2eStore),
        () => fail(`SHOPIFY_E2E_STORE=${e2eStore} is already used by ${checkout}`),
      ),
    ),
  );

  const envFile = path.join(root, ".env");
  const want = worktreeEnv(mainEnv, { port, store, e2eStore });
  const have = yield* readIfExists(envFile);
  if (Option.contains(have, want))
    yield* Console.log("ok    .env up to date with the main checkout");
  else {
    yield* fs.writeFileString(envFile, want);
    yield* Option.match(have, {
      onNone: () =>
        Console.log(
          `ok    .env copied from the main checkout, WEBSITE_PORT=${String(port)}, SHOPIFY_DEV_STORE=${store}, SHOPIFY_E2E_STORE=${e2eStore}`,
        ),
      onSome: (before) => {
        const { added, changed, removed } = envChanges(before, want);
        const list = (label: string, keys: readonly string[]) =>
          keys.length === 0 ? [] : [`${label} ${keys.join(", ")}`];
        const summary = [
          ...list("added", added),
          ...list("changed", changed),
          ...list("removed", removed),
        ];
        return Console.log(
          `ok    .env rebuilt from the main checkout: ${summary.length === 0 ? "layout only" : summary.join("; ")}`,
        );
      },
    });
  }

  yield* checkStores({ dev: store, e2e: e2eStore });

  yield* linkToMain(root, mainCheckout, "refs");
  yield* Effect.forEach(Deployed.literals, (environment) =>
    Effect.gen(function* () {
      const name = `.env.${environment}`;
      if (yield* fs.exists(path.join(mainCheckout, name)))
        return yield* linkToMain(root, mainCheckout, name);
      yield* Console.log(`skip  ${name}: none in the main checkout`);
    }),
  );

  yield* Console.log(`\n${branch} ready on port ${String(port)}. Next: vp run dev`);
});

/** Every failure of `init` is a message for the person at the terminal. */
const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const initCommand = Command.make("init", {}, () => init.pipe(Effect.mapError(toUserError))).pipe(
  Command.withDescription(
    "Prepare this wt-NN worktree: .env rebuilt from the main checkout's with its own WEBSITE_PORT, SHOPIFY_DEV_STORE and SHOPIFY_E2E_STORE, its two stores made sure to exist, and links to the main checkout's refs and .env.<deployed environment> files. Run it again whenever the main checkout's .env changes.",
  ),
);

Command.make("worktree").pipe(
  Command.withDescription("Set up long-lived linked worktrees of this repository"),
  Command.withSubcommands([initCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
