#!/usr/bin/env node
/**
 * `vp run screencast`: Baton's two videos, each from one scene table ({@link TAKES}). `--take
 * review`, the default, is the App Store review screencast; `--take feature` is the listing's
 * feature video. `voice` renders the narration that changed, through Workers AI; every rendered
 * line is a metered request, so `voice --dry-run` prints what a render would send and cost first.
 * `record` films the take in the dev store, `record --rehearse` with estimated line lengths and no
 * narration. `build` lays the narration on the take as a 1080p MP4, or makes a silent one from a
 * rehearsal. `instructions` writes the review's testing instructions from its scenes, `thumbnail`
 * the feature video's thumbnail, and `all` runs voice, record, build and, for the review,
 * instructions. Credentials for `voice` come from the shell's `CLOUDFLARE_API_TOKEN` and
 * `CLOUDFLARE_ACCOUNT_ID`.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CliError, Command, Flag } from "effect/cli";

import { fixture } from "../fixture.ts";
import { screencastFixture } from "../screencast-fixture.ts";
import { FEATURE_SCENES, BRAND_CARD } from "./feature-video-scenes.ts";
import {
  instructionsText,
  renderVoices,
  SCREENCAST_DIR,
  takeFiles,
  type TakeSpec,
  VOICE,
  voicePlan,
} from "./lib/screencast.ts";
import { buildVideo } from "./lib/screencast-build.ts";
import { renderThumbnail } from "./lib/screencast-cards.ts";
import { recordTake } from "./lib/screencast-take.ts";
import { countCharacters } from "./lib/tts.ts";
import { SCENES } from "./screencast-scenes.ts";

const FEATURE_DIR = resolve(SCREENCAST_DIR, "feature");

/**
 * The takes. The review films the whole admin from an empty Baton. The feature video films the
 * dev fixture's shop, cropped to the app pane.
 */
export const TAKES = {
  review: {
    name: "review",
    scenes: SCENES,
    files: takeFiles(SCREENCAST_DIR, "baton-review"),
    start: screencastFixture,
    frame: "admin",
  },
  feature: {
    name: "feature",
    scenes: FEATURE_SCENES,
    files: takeFiles(FEATURE_DIR, "baton-feature"),
    start: fixture,
    frame: "pane",
  },
} as const satisfies Record<string, TakeSpec>;

const TAKE_NAMES = ["review", "feature"] as const;

/** Every take's scenes: the voice cache keeps a clip any of them says. */
const ALL_SCENES = Object.values(TAKES).flatMap(({ scenes }) => scenes);

const takeFlag = Flag.Literals("take", TAKE_NAMES).pipe(
  Flag.withDescription("Which video: review (default) or feature"),
  Flag.withDefault("review" as const),
);

const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const voice = Command.make(
  "voice",
  {
    take: takeFlag,
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the lines a render would send and their cost, and send nothing"),
      Flag.withDefault(false),
    ),
  },
  ({ take, dryRun }) =>
    Effect.gen(function* () {
      const { scenes, files } = TAKES[take];
      const plan = voicePlan(scenes);
      const total = scenes.reduce((sum, { say }) => sum + countCharacters(say), 0);
      yield* Console.log(
        `voice  ${take} ${VOICE.model} ${VOICE.speaker}: ${plan.missing.length} of ${scenes.length} lines to render, ${plan.characters} of ${total} characters, about $${plan.estimatedUsd.toFixed(3)}`,
      );
      if (dryRun) {
        for (const scene of plan.missing)
          yield* Console.log(`  ${scene.id} (${countCharacters(scene.say)}): ${scene.say}`);
        return;
      }
      const result = yield* renderVoices(scenes, files, ALL_SCENES);
      const seconds = result.clips.reduce((sum, { durationMs }) => sum + durationMs, 0) / 1000;
      yield* Console.log(
        `voice  ok: ${result.rendered} rendered, ${result.clips.length} clips, ${seconds.toFixed(1)} s of narration`,
      );
    }).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Render the narration lines that have no clip yet"));

const record = Command.make(
  "record",
  {
    take: takeFlag,
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
  ({ take, ...options }) =>
    recordTake(TAKES[take], options).pipe(Effect.asVoid, Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Film the take in the dev store: its starting shop first, the dev fixture again after",
  ),
);

const build = Command.make("build", { take: takeFlag }, ({ take }) =>
  buildVideo(TAKES[take]).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Lay the narration on the last take and write the 1080p MP4 and a contact sheet; a rehearsal gets a silent MP4",
  ),
);

const thumbnail = Command.make("thumbnail", {}, () =>
  Effect.gen(function* () {
    const file = resolve(TAKES.feature.files.out, "thumbnail.png");
    yield* renderThumbnail(BRAND_CARD, file);
    yield* Console.log(`thumbnail ok: ${file}`);
  }),
).pipe(Command.withDescription("Render the feature video's 1600 × 900 thumbnail"));

const writeInstructions = Effect.gen(function* () {
  const text = yield* instructionsText(SCENES);
  const file = resolve(TAKES.review.files.out, "testing-instructions.txt");
  yield* Effect.promise(async () => {
    await mkdir(TAKES.review.files.out, { recursive: true });
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
    take: takeFlag,
    headed: Flag.Boolean("headed").pipe(
      Flag.withDescription("Show the browser while filming"),
      Flag.withDefault(false),
    ),
  },
  ({ take, headed }) =>
    Effect.gen(function* () {
      const spec = TAKES[take];
      yield* renderVoices(spec.scenes, spec.files, ALL_SCENES);
      yield* recordTake(spec, { rehearse: false, headed });
      yield* buildVideo(spec);
      if (take === "review") yield* writeInstructions;
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "voice, record, build and, for the review, instructions in order, stopping at the first failure",
  ),
);

Command.make("screencast").pipe(
  Command.withDescription("Baton's review screencast and feature video"),
  Command.withSubcommands([voice, record, build, instructions, thumbnail, all]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
