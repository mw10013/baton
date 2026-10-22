/**
 * The screencasts' parts: the scene table's shape, a take's files, the narration's voice and
 * cache, and the review's testing instructions built from its scenes. `vp run screencast` drives
 * them.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameLocator, Page } from "playwright";

import type { ShopFixture } from "../../src/contract/fixture.ts";

import { runCommand } from "./command.ts";
import {
  countCharacters,
  estimate,
  type ModelName,
  speechAccount,
  speechToken,
  synthesize,
} from "./tts.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Everything the screencast writes; ignored by git with the rest of `tmp/`. */
export const SCREENCAST_DIR = resolve(REPO_ROOT, "tmp/screencast");
/**
 * The narration clips of every take, in one cache: a clip is keyed by its words, so a line two
 * takes both say is rendered once.
 */
export const VOICE_DIR = resolve(SCREENCAST_DIR, "voice");

/** Where one take's files go. */
export interface TakeFiles {
  readonly voiceIndex: string;
  readonly raw: string;
  readonly sceneIndex: string;
  readonly narration: string;
  readonly out: string;
  readonly video: string;
  /** The silent video `build` makes from a rehearsal. */
  readonly rehearsalVideo: string;
  readonly contactSheet: string;
}

export const takeFiles = (dir: string, video: string): TakeFiles => ({
  voiceIndex: resolve(dir, "voice.json"),
  raw: resolve(dir, "raw.webm"),
  sceneIndex: resolve(dir, "scenes.json"),
  narration: resolve(dir, "narration.wav"),
  out: resolve(dir, "out"),
  video: resolve(dir, "out", `${video}.mp4`),
  rehearsalVideo: resolve(dir, "out", `${video}-rehearsal.mp4`),
  contactSheet: resolve(dir, "out", "contact-sheet.png"),
});

/**
 * One video made from a scene table. `start` is the shop the take films, loaded before it; the
 * dev fixture is loaded again after either way. `frame` is what the video shows: the whole
 * `admin`, or only the app's `pane`, its title bar included, which leaves out the Shopify top bar
 * and the admin nav, and with them the Shopify mark and the dev app's name.
 */
export interface TakeSpec {
  readonly name: string;
  readonly scenes: ReadonlyArray<Scene>;
  readonly files: TakeFiles;
  readonly start: ShopFixture;
  readonly frame: "admin" | "pane";
}

/** The narration's voice for every scene. */
export const VOICE: { readonly model: ModelName; readonly speaker: string } = {
  model: "aura-2",
  speaker: "luna",
};

/** Shopify's limit on the submission form's testing instructions. */
export const INSTRUCTIONS_LIMIT = 2800;

/**
 * What a scene's `act` can do in the take. Every call is paced for a viewer, and a control is
 * looked up in the admin's top document first, then in the app frame: title-bar actions and
 * modals live in the top document.
 */
export interface Take {
  readonly page: Page;
  readonly app: () => FrameLocator;
  /** Choose an item in Baton's section of the admin nav. */
  readonly nav: (name: string) => Promise<void>;
  /** Press the button or link named `name`. */
  readonly press: (name: string) => Promise<void>;
  /** Type `text` into the field labelled `label`, character by character. */
  readonly fill: (label: string, text: string) => Promise<void>;
  /** Choose `option` in the select labelled `label`. */
  readonly choose: (label: string, option: string) => Promise<void>;
  /** Tick the checkbox labelled `label`. */
  readonly tick: (label: string) => Promise<void>;
  /** Wait until `text` shows anywhere on screen, as a whole text or inside one. */
  readonly see: (text: string) => Promise<void>;
  /** Rest the cursor on the first visible `text`, without pressing it. */
  readonly point: (text: string) => Promise<void>;
  /** Place the take's paid order in Shopify, off camera, and answer its name. */
  readonly placeOrder: () => Promise<string>;
  /** The name of the order {@link Take.placeOrder} placed. */
  readonly placedOrder: () => string;
  /** Close the window open over the admin, such as the workflow editor. */
  readonly closeWindow: () => Promise<void>;
  /** Open the order {@link Take.placeOrder} placed, from the Orders list. */
  readonly openOrder: () => Promise<void>;
}

/**
 * One scene of the take. `say` is its narration, `act` what the viewer sees while it plays, and
 * `step` its line in the testing instructions: the exact names and values, and what the tester
 * should see. A scene with no `step` adds nothing to the instructions.
 */
export interface Scene {
  readonly id: string;
  /** A card shown before the scene: the start of a chapter. */
  readonly chapter?: { readonly title: string; readonly description?: string };
  /** A card covering the frame for the whole scene, in place of the screen. */
  readonly card?: Card;
  readonly say: string;
  readonly step?: string;
  readonly act: (take: Take) => Promise<void>;
}

/**
 * A frame-filling card: a `Title` with the brand line, or `Phones`, member screens side by side.
 * A phone's `file` is a help picture under `public/assets/help/`, so the card shows the screens
 * the help shows.
 */
export type Card =
  | { readonly _tag: "Title"; readonly title: string; readonly line: string }
  | { readonly _tag: "Phones"; readonly files: ReadonlyArray<string> };

/** A clip's cache key: a change to the model, the speaker or the words is a new clip. */
export const voiceKey = (model: ModelName, speaker: string, text: string): string =>
  createHash("sha256")
    .update(JSON.stringify([model, speaker, text]))
    .digest("hex");

export const voicePath = (key: string) => resolve(VOICE_DIR, `${key}.mp3`);

export class ScreencastError extends Schema.TaggedError<ScreencastError>()("ScreencastError", {
  message: Schema.String,
}) {}

/**
 * The testing instructions: a line saying no credentials are needed, then every scene's `step`,
 * numbered in scene order. Fails over {@link INSTRUCTIONS_LIMIT}.
 */
export const instructionsText = (scenes: ReadonlyArray<Scene>) => {
  const steps = scenes.flatMap(({ step }) => (step === undefined ? [] : [step]));
  const text = [
    "No credentials are needed. Baton runs only in the Shopify admin, with no customer flow.",
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
  ].join("\n");
  return countCharacters(text) <= INSTRUCTIONS_LIMIT
    ? Effect.succeed(text)
    : Effect.fail(
        new ScreencastError({
          message: `the testing instructions are ${countCharacters(text)} characters, over Shopify's ${INSTRUCTIONS_LIMIT}`,
        }),
      );
};

/** A rendered clip: which scene, which file, and how long it plays. */
export const VoiceClip = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  durationMs: Schema.Number,
});
export type VoiceClip = typeof VoiceClip.Type;

const VoiceIndex = Schema.fromJsonString(Schema.Array(VoiceClip));

/** How long `file` plays, in whole milliseconds, by `ffprobe`. */
export const durationMs = Effect.fn("durationMs")(function* (file: string) {
  const out = yield* runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  const seconds = Number(out.trim());
  if (!Number.isFinite(seconds))
    return yield* new ScreencastError({ message: `ffprobe gave no duration for ${file}` });
  return Math.round(seconds * 1000);
});

/** The scenes whose clip is not on disk yet, and the characters and cost of rendering them. */
export const voicePlan = (scenes: ReadonlyArray<Scene>) => {
  const missing = scenes.filter(
    ({ say }) => !existsSync(voicePath(voiceKey(VOICE.model, VOICE.speaker, say))),
  );
  const characters = missing.reduce((sum, { say }) => sum + countCharacters(say), 0);
  return { missing, characters, ...estimate(VOICE.model, characters) };
};

/**
 * Renders every scene's narration that has no clip yet, one metered request each and never a
 * retry, then writes the take's voice index with every clip's duration and deletes the clips no
 * scene in `keep` uses: `keep` is every take's scenes, since the clips are shared. A second run
 * with no copy change sends no request.
 */
export const renderVoices = Effect.fn("renderVoices")(function* (
  scenes: ReadonlyArray<Scene>,
  files: TakeFiles,
  keep: ReadonlyArray<Scene>,
) {
  const plan = voicePlan(scenes);
  if (plan.missing.length > 0) {
    const token = yield* speechToken;
    const account = yield* speechAccount;
    for (const scene of plan.missing) {
      yield* synthesize({
        account,
        token,
        model: VOICE.model,
        speaker: VOICE.speaker,
        text: scene.say,
        output: voicePath(voiceKey(VOICE.model, VOICE.speaker, scene.say)),
      });
      yield* Console.log(`voice  ${scene.id}: rendered (${countCharacters(scene.say)} characters)`);
    }
  }
  const clips = yield* Effect.forEach(scenes, (scene) => {
    const key = voiceKey(VOICE.model, VOICE.speaker, scene.say);
    return durationMs(voicePath(key)).pipe(
      Effect.map((duration): VoiceClip => ({ id: scene.id, key, durationMs: duration })),
    );
  });
  yield* Effect.promise(async () => {
    await mkdir(dirname(files.voiceIndex), { recursive: true });
    await writeFile(files.voiceIndex, `${JSON.stringify(clips, null, 2)}\n`);
  });
  const used = new Set(keep.map(({ say }) => voiceKey(VOICE.model, VOICE.speaker, say)));
  const pruned = yield* Effect.promise(async () => {
    const files = await readdir(VOICE_DIR).catch(() => []);
    const stale = files.filter((file) => !used.has(file.replace(/\.(mp3|metadata\.json)$/u, "")));
    await Promise.all(stale.map((file) => unlink(resolve(VOICE_DIR, file))));
    return stale;
  });
  for (const file of pruned) yield* Console.log(`voice  pruned ${file}`);
  return { rendered: plan.missing.length, characters: plan.characters, clips };
});

/** The clips {@link renderVoices} last wrote for a take, failing if any scene has none. */
export const readVoiceIndex = Effect.fn("readVoiceIndex")(function* (
  scenes: ReadonlyArray<Scene>,
  files: TakeFiles,
) {
  const text = yield* Effect.tryPromise({
    try: () => readFile(files.voiceIndex, "utf8"),
    catch: () => new ScreencastError({ message: "no voice.json: run vp run screencast voice" }),
  });
  const clips = yield* Schema.decodeUnknownEffect(VoiceIndex)(text).pipe(
    Effect.mapError((error) => new ScreencastError({ message: error.message })),
  );
  for (const scene of scenes) {
    const clip = clips.find(({ id }) => id === scene.id);
    if (clip?.key !== voiceKey(VOICE.model, VOICE.speaker, scene.say))
      return yield* new ScreencastError({
        message: `scene ${scene.id} has no current clip: run vp run screencast voice`,
      });
  }
  return clips;
});
