#!/usr/bin/env node
/**
 * `vp run screencast`: the App Store review screencast from one scene table ({@link SCENES}).
 * `voice` renders the narration that changed, through Workers AI; every rendered line is a
 * metered request, so `voice --dry-run` prints what a render would send and cost first.
 * `record` films the take in the dev store, `record --rehearse` with estimated line lengths and no
 * narration. `build` lays the narration on the take as a 1080p MP4. `instructions` writes the testing instructions from the same scenes, and `all` runs the four in order. Credentials for `voice`
 * come from the shell's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError, Command, Flag } from "effect/cli";

import {
  instructionsText,
  renderVoices,
  SCREENCAST_DIR,
  VOICE,
  voicePlan,
} from "./lib/screencast.ts";
import { buildVideo } from "./lib/screencast-build.ts";
import { recordTake } from "./lib/screencast-take.ts";
import { countCharacters } from "./lib/tts.ts";
import { SCENES } from "./screencast-scenes.ts";

const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const voice = Command.make(
  "voice",
  {
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the lines a render would send and their cost, and send nothing"),
      Flag.withDefault(false),
    ),
  },
  ({ dryRun }) =>
    Effect.gen(function* () {
      const plan = voicePlan(SCENES);
      const total = SCENES.reduce((sum, { say }) => sum + countCharacters(say), 0);
      yield* Console.log(
        `voice  ${VOICE.model} ${VOICE.speaker}: ${plan.missing.length} of ${SCENES.length} lines to render, ${plan.characters} of ${total} characters, about $${plan.estimatedUsd.toFixed(3)}`,
      );
      if (dryRun) {
        for (const scene of plan.missing)
          yield* Console.log(`  ${scene.id} (${countCharacters(scene.say)}): ${scene.say}`);
        return;
      }
      const result = yield* renderVoices(SCENES);
      const seconds = result.clips.reduce((sum, { durationMs }) => sum + durationMs, 0) / 1000;
      yield* Console.log(
        `voice  ok: ${result.rendered} rendered, ${result.clips.length} clips, ${seconds.toFixed(1)} s of narration`,
      );
    }).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Render the narration lines that have no clip yet"));

const record = Command.make(
  "record",
  {
    rehearse: Flag.Boolean("rehearse").pipe(
      Flag.withDescription(
        "Estimate each line's length instead of reading its clip: no narration needed",
      ),
      Flag.withDefault(false),
    ),
    headed: Flag.Boolean("headed").pipe(
      Flag.withDescription("Show the browser while filming"),
      Flag.withDefault(false),
    ),
  },
  (options) => recordTake(SCENES, options).pipe(Effect.asVoid, Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Film the take in the dev store: the screencast fixture first, the dev fixture again after",
  ),
);

const build = Command.make("build", {}, () =>
  buildVideo(SCENES).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Lay the narration on the last take and write the 1080p MP4 and a contact sheet",
  ),
);

const writeInstructions = Effect.gen(function* () {
  const text = yield* instructionsText(SCENES);
  const file = resolve(SCREENCAST_DIR, "out/testing-instructions.txt");
  yield* Effect.promise(async () => {
    await mkdir(resolve(SCREENCAST_DIR, "out"), { recursive: true });
    await writeFile(file, text);
  });
  yield* Console.log(text);
  yield* Console.log(`instructions ok: ${countCharacters(text)} characters, written to ${file}`);
});

const instructions = Command.make("instructions", {}, () =>
  writeInstructions.pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Write the testing instructions from the scenes' steps"));

const all = Command.make(
  "all",
  {
    headed: Flag.Boolean("headed").pipe(
      Flag.withDescription("Show the browser while filming"),
      Flag.withDefault(false),
    ),
  },
  ({ headed }) =>
    Effect.gen(function* () {
      yield* renderVoices(SCENES);
      yield* recordTake(SCENES, { rehearse: false, headed });
      yield* buildVideo(SCENES);
      yield* writeInstructions;
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "voice, record, build and instructions in order, stopping at the first failure",
  ),
);

Command.make("screencast").pipe(
  Command.withDescription("The App Store review screencast"),
  Command.withSubcommands([voice, record, build, instructions, all]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
