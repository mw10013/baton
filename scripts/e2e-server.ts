#!/usr/bin/env node
/**
 * `vp run e2e:serve`: the e2e server in the foreground, which `scripts/e2e.ts` starts in a herdr
 * pane, the caller's terminal or the background, and which nothing else should run. It is Shopify
 * CLI on this checkout's e2e store (`SHOPIFY_E2E_STORE` in `.env`): `shopify app dev` opens a
 * tunnel and runs the web command with the real app's key, secret and tunnel URL in its
 * environment, and the web command serves the e2e stage ({@link WEB_ENVIRONMENT}) on
 * {@link e2ePortOf} of `WEBSITE_PORT`, beside the dev server.
 *
 * The CLI's whole output, its own lines and Alchemy's, goes to `.logs/e2e/current` through `s6-log`
 * in order, after one marker line per start, and is echoed to stderr. The script stays in the
 * foreground; on SIGTERM or SIGINT it stops the CLI, which stops `alchemy dev`, `workerd` and the
 * tunnel.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CliError, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";

import { runCommand } from "./lib/command.ts";
import { StoresError } from "./lib/stores.ts";
import { e2ePortOf, stage } from "./lib/worktree.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const LOG_DIR = "./.logs/e2e";
/**
 * `s6-log`'s arguments, the same rotation as the `web:dev` script's: 20 files of 5 MiB at
 * most, 100 MiB in all, an ISO timestamp on each line.
 */
const S6_LOG_ARGS = ["-b", "-l", "65536", "n20", "s5242880", "S104857600", "T", LOG_DIR, "1"];
/** The value of `SANDBOX_ENVIRONMENT` that makes the CLI's web command serve the e2e stage. */
const WEB_ENVIRONMENT = "e2e";

const fromEnv = (key: string) =>
  Config.NonEmptyString(key).pipe(
    Effect.mapError(
      () => new StoresError({ message: `${key} is not set: add it to .env (see .env.example)` }),
    ),
  );

const serve = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const store = yield* fromEnv("SHOPIFY_E2E_STORE");
  const port = String(e2ePortOf(yield* Config.Port("WEBSITE_PORT")));
  const e2eStage = yield* stage("e2e");

  yield* runCommand(
    "s6-log",
    S6_LOG_ARGS,
    `==== e2e server ${new Date().toISOString()} stage=${e2eStage} store=${store} port=${port}\n`,
  );
  yield* Console.error(`e2e server: stage ${e2eStage}, store ${store}, port ${port}`);

  const cli = yield* spawner.spawn(
    ChildProcess.make("shopify", ["app", "dev", "--config", "shopify.app.toml", "--store", store], {
      cwd: ROOT,
      env: {
        BACKEND_PORT: port,
        WEBSITE_PORT: port,
        SANDBOX_ENVIRONMENT: WEB_ENVIRONMENT,
      },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // In this script's process group, so the herdr pane running it shows the CLI in its
      // foreground (how the e2e server's pane is found) and a Ctrl-C there reaches the CLI too.
      detached: false,
    }),
  );
  const logger = yield* spawner.spawn(
    ChildProcess.make("s6-log", S6_LOG_ARGS, {
      cwd: ROOT,
      stdin: {
        stream: Stream.merge(cli.stdout, cli.stderr).pipe(
          Stream.tap((chunk) => Effect.sync(() => process.stderr.write(chunk))),
        ),
      },
      stdout: "inherit",
      stderr: "inherit",
      detached: false,
    }),
  );
  const exitCode = yield* cli.exitCode;
  yield* logger.exitCode;
  return yield* new StoresError({ message: `shopify app dev exited ${String(exitCode)}` });
}).pipe(Effect.scoped);

Command.make("e2e-server", {}, () =>
  serve.pipe(
    Effect.mapError(
      (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
    ),
  ),
).pipe(
  Command.withDescription(
    "Run the e2e server in the foreground: Shopify CLI on this checkout's e2e store. Start it with vp run e2e:start.",
  ),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
