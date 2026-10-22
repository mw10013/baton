#!/usr/bin/env node
/**
 * `vp run cloud:reset --stage <stage> --confirm <stage>`: wipes a deployed stage and rebuilds it
 * from the code, for prototyping, when the schema is one `0001_init` rewritten in place rather
 * than migrated. `alchemy destroy` deletes the Workers, which takes every Durable Object with them,
 * and the D1 database; `alchemy deploy` recreates them, migrates D1 from nothing and seeds it.
 * The `StageConfig` record is its own stack and survives. Every Better Auth session and every
 * shop's Shopify token goes with D1: people sign in again, and a shop's next embedded load
 * exchanges a new token.
 *
 * The Workers Builds trigger is attached to the Website Worker's tag, which a new Worker does not
 * keep, so it is read before the destroy, saved under `.alchemy/cloud-reset/`, recreated on the
 * new Worker and then deleted from the old one. The GitHub connection and the build token belong
 * to the account and survive. A run that stops after the destroy is rerun as is: with the Website
 * gone, the trigger comes from the saved file.
 *
 * The URLs do not change, because deployed Workers have fixed names (`workerNameOf`), so Shopify
 * needs no `shopify app deploy`.
 *
 * A schema change goes out as: commit, run this from the laptop, then push. Pushed first, Workers
 * Builds deploys the new code onto the old databases: Alchemy skips a migration it has already
 * applied, and so does every actor, so both keep the old schema until the reset.
 *
 * Only for prototyping: once a stage holds data that matters, this script goes, `0001_init` is
 * frozen and the schema moves by additive migrations.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CliError, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";

import { ResettableDeployed, workerNameOf } from "../src/backend/stage.ts";
import { runCommand } from "./lib/command.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const SAVED_DIR = `${ROOT}/.alchemy/cloud-reset`;

class ResetError extends Schema.TaggedError<ResetError>()("ResetError", {
  message: Schema.String,
}) {}

/** A Worker as `cf workers scripts search` lists it; `id` is the tag Workers Builds keys on. */
const Scripts = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String, script_name: Schema.String })),
);

/** The fields of a Workers Builds trigger that recreating it needs. */
const Trigger = Schema.Struct({
  trigger_uuid: Schema.String,
  external_script_id: Schema.String,
  build_token_uuid: Schema.String,
  trigger_name: Schema.String,
  build_command: Schema.String,
  deploy_command: Schema.String,
  root_directory: Schema.String,
  branch_includes: Schema.Array(Schema.String),
  branch_excludes: Schema.Array(Schema.String),
  path_includes: Schema.Array(Schema.String),
  path_excludes: Schema.Array(Schema.String),
  build_caching_enabled: Schema.Boolean,
  repo_connection: Schema.Struct({ repo_connection_uuid: Schema.String }),
});
type Trigger = typeof Trigger.Type;

const TriggerJson = Schema.fromJsonString(Trigger);
const Triggers = Schema.fromJsonString(Schema.Array(Trigger));
const CreatedTrigger = Schema.fromJsonString(Schema.Struct({ trigger_uuid: Schema.String }));

const decode =
  <S extends Schema.Top>(schema: S, what: string) =>
  (text: string) =>
    Schema.decodeUnknownEffect(schema)(text).pipe(
      Effect.mapError(() => new ResetError({ message: `unexpected output from ${what}: ${text}` })),
    );

/** The tag of the Worker with exactly this name, if it exists. */
const findTag = Effect.fn("findTag")(function* (name: string) {
  const scripts = yield* runCommand("cf", ["workers", "scripts", "search", "--name", name]).pipe(
    Effect.flatMap(decode(Scripts, "cf workers scripts search")),
  );
  return Option.map(
    Option.fromNullishOr(scripts.find((script) => script.script_name === name)),
    (script) => script.id,
  );
});

/** Runs `alchemy` with its output on the terminal. */
const alchemy = Effect.fn("alchemy")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make("alchemy", [...args], {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (exitCode !== ChildProcessSpawner.ExitCode(0))
    return yield* new ResetError({ message: `alchemy ${args.join(" ")} exited ${exitCode}` });
});

/**
 * The trigger to carry across: read from the live Website Worker and saved, or, when the Worker is
 * already gone, the one an earlier run saved.
 */
const triggerToCarry = Effect.fn("triggerToCarry")(function* (website: string, saved: string) {
  const fs = yield* FileSystem.FileSystem;
  const tag = yield* findTag(website);
  if (Option.isNone(tag)) {
    if (!(yield* fs.exists(saved)))
      return yield* new ResetError({
        message: `${website} does not exist and no trigger was saved at ${saved}; recreate the Workers Builds trigger by hand`,
      });
    yield* Console.log(`${website} is gone; using the trigger saved at ${saved}`);
    return yield* fs.readFileString(saved).pipe(Effect.flatMap(decode(TriggerJson, saved)));
  }
  const triggers = yield* runCommand("cf", [
    "builds",
    "triggers",
    "list",
    "--external-script-id",
    tag.value,
  ]).pipe(Effect.flatMap(decode(Triggers, "cf builds triggers list")));
  const [trigger, ...others] = triggers;
  if (trigger === undefined || others.length > 0)
    return yield* new ResetError({
      message: `${website} has ${triggers.length} Workers Builds triggers; expected exactly one`,
    });
  yield* fs.makeDirectory(SAVED_DIR, { recursive: true });
  yield* fs.writeFileString(saved, yield* Schema.encodeEffect(TriggerJson)(trigger));
  return trigger;
});

const recreateTrigger = Effect.fn("recreateTrigger")(function* (trigger: Trigger, tag: string) {
  const body = {
    external_script_id: tag,
    repo_connection_uuid: trigger.repo_connection.repo_connection_uuid,
    build_token_uuid: trigger.build_token_uuid,
    trigger_name: trigger.trigger_name,
    build_command: trigger.build_command,
    deploy_command: trigger.deploy_command,
    root_directory: trigger.root_directory,
    branch_includes: trigger.branch_includes,
    branch_excludes: trigger.branch_excludes,
    path_includes: trigger.path_includes,
    path_excludes: trigger.path_excludes,
    build_caching_enabled: trigger.build_caching_enabled,
  };
  // The flag form insists on every field, so the whole trigger goes as one body.
  const created = yield* runCommand("cf", [
    "builds",
    "triggers",
    "create",
    "--body",
    JSON.stringify(body),
  ]).pipe(Effect.flatMap(decode(CreatedTrigger, "cf builds triggers create")));
  yield* Console.log(`created Workers Builds trigger ${created.trigger_uuid}`);
  yield* runCommand("cf", ["builds", "triggers", "delete", trigger.trigger_uuid, "--force"]).pipe(
    Effect.andThen(Console.log(`deleted the old trigger ${trigger.trigger_uuid}`)),
    Effect.catchTag("CommandError", (error) =>
      Console.error(`could not delete the old trigger: ${error.message}`),
    ),
  );
});

const reset = Effect.fn("reset")(function* (stage: ResettableDeployed) {
  const fs = yield* FileSystem.FileSystem;
  const website = workerNameOf(stage, "website");
  if (website === undefined)
    return yield* new ResetError({ message: `stage ${stage} has no fixed Worker name` });
  const saved = `${SAVED_DIR}/${stage}-trigger.json`;

  const trigger = yield* triggerToCarry(website, saved);
  yield* alchemy(["destroy", "--stage", stage, "--yes"]);
  yield* alchemy(["deploy", "--stage", stage, "--yes"]);

  const tag = yield* findTag(website);
  if (Option.isNone(tag))
    return yield* new ResetError({ message: `${website} is missing after the deploy` });
  yield* recreateTrigger(trigger, tag.value);
  yield* fs.remove(saved);
  yield* Console.log(`${stage} reset; check the embedded app`);
});

Command.make(
  "cloud-reset",
  {
    stage: Flag.String("stage").pipe(
      Flag.withDescription("The disposable deployed stage to reset (staging only)"),
    ),
    confirm: Flag.String("confirm").pipe(
      Flag.withDescription("The stage name again, to confirm that its data is to be deleted"),
    ),
  },
  ({ stage, confirm }) =>
    Effect.gen(function* () {
      const deployed = yield* Schema.decodeUnknownEffect(ResettableDeployed)(stage).pipe(
        Effect.mapError(
          () =>
            new ResetError({
              message: `cloud:reset is for ${ResettableDeployed.literals.join(", ")} only, not "${stage}"`,
            }),
        ),
      );
      if (confirm !== stage)
        return yield* new ResetError({ message: `--confirm must repeat the stage, ${stage}` });
      yield* reset(deployed);
    }).pipe(
      Effect.mapError(
        (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Destroy and redeploy staging, deleting its D1 and Durable Object data, and carry its Workers Builds trigger across.",
  ),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
