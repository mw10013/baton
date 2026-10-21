/**
 * Building the review screencast from a take: the narration laid on the recording at each scene's
 * start, the picture scaled to 1080p, and a contact sheet to check before watching.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCommand } from "./command.ts";
import {
  durationMs,
  readVoiceIndex,
  type Scene,
  SCREENCAST_DIR,
  ScreencastError,
  type VoiceClip,
  voicePath,
} from "./screencast.ts";
import { RAW_VIDEO, SCENE_INDEX, SceneIndex, type SceneMark, VIEWPORT } from "./screencast-take.ts";

export const OUT_DIR = resolve(SCREENCAST_DIR, "out");
export const NARRATION = resolve(SCREENCAST_DIR, "narration.wav");
export const VIDEO = resolve(OUT_DIR, "baton-review.mp4");
export const CONTACT_SHEET = resolve(OUT_DIR, "contact-sheet.png");

/** One frame at 30 fps, rounded up: how far the built video may run from the raw one. */
const FRAME_MS = 34;
const LABEL_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";

/** A clip placed at its scene's start, as the narration pass lays it. */
export interface PlacedClip {
  readonly id: string;
  readonly file: string;
  readonly startMs: number;
  readonly durationMs: number;
}

/** Each scene's clip at the scene's start in the take, in scene order. */
export const placeClips = (
  marks: ReadonlyArray<SceneMark>,
  clips: ReadonlyArray<VoiceClip>,
): ReadonlyArray<PlacedClip> =>
  marks.map((mark) => {
    const clip = clips.find(({ id }) => id === mark.id);
    if (clip === undefined) throw new Error(`no clip for scene ${mark.id}`);
    return {
      id: mark.id,
      file: voicePath(clip.key),
      startMs: Math.round(mark.startMs),
      durationMs: clip.durationMs,
    };
  });

/** Every clip that runs past the next clip's start: two lines spoken over each other. */
export const overlaps = (placed: ReadonlyArray<PlacedClip>) =>
  placed.flatMap((clip, index) => {
    const next = placed[index + 1];
    return next !== undefined && clip.startMs + clip.durationMs > next.startMs
      ? [`${clip.id} runs ${clip.startMs + clip.durationMs - next.startMs} ms into ${next.id}`]
      : [];
  });

/**
 * The narration pass's ffmpeg arguments: each clip delayed to its start and mixed, loudness
 * normalized, then padded and cut to the video's length. Rendered apart from the picture, since a
 * graph mixing both hung ffmpeg, and timestamps are rebuilt around `adelay`: `loudnorm` emits
 * frames without them, which once landed the narration half a second early.
 */
export const narrationArgs = (
  placed: ReadonlyArray<PlacedClip>,
  videoMs: number,
  output: string,
): ReadonlyArray<string> => {
  const delays = placed.map(
    (clip, index) =>
      `[${index}:a]aresample=48000,asetpts=N/SR/TB,adelay=${clip.startMs}:all=1,asetpts=N/SR/TB[a${index}]`,
  );
  const inputs = placed.map((_, index) => `[a${index}]`).join("");
  const mix = `${inputs}amix=inputs=${placed.length}:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5,aresample=48000,apad,atrim=0:${(videoMs / 1000).toFixed(3)}[out]`;
  return [
    "-v",
    "error",
    "-y",
    ...placed.flatMap((clip) => ["-i", clip.file]),
    "-filter_complex",
    [...delays, mix].join(";"),
    "-map",
    "[out]",
    "-ac",
    "2",
    output,
  ];
};

/** The mux's ffmpeg arguments: the take scaled to 1080p H.264, the narration as AAC. */
export const muxArgs = (
  raw: string,
  narration: string,
  videoMs: number,
  output: string,
): ReadonlyArray<string> => [
  "-v",
  "error",
  "-y",
  "-i",
  raw,
  "-i",
  narration,
  "-map",
  "0:v",
  "-map",
  "1:a",
  "-vf",
  "scale=1920:1080:flags=lanczos",
  "-c:v",
  "libx264",
  "-crf",
  "18",
  "-preset",
  "slow",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-t",
  (videoMs / 1000).toFixed(3),
  "-movflags",
  "+faststart",
  output,
];

const decodeSceneIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(SceneIndex));

/**
 * `vp run screencast build`: refuses a rehearsal or a take whose clips are stale or overlap, then
 * writes {@link NARRATION}, {@link VIDEO} and {@link CONTACT_SHEET}.
 */
export const buildVideo = Effect.fn("buildVideo")(function* (scenes: ReadonlyArray<Scene>) {
  const text = yield* Effect.tryPromise({
    try: () => readFile(SCENE_INDEX, "utf8"),
    catch: () => new ScreencastError({ message: "no scenes.json: run vp run screencast record" }),
  });
  const index = yield* decodeSceneIndex(text).pipe(
    Effect.mapError((error) => new ScreencastError({ message: error.message })),
  );
  if (index.rehearsal)
    return yield* new ScreencastError({
      message: "the last take was a rehearsal: run vp run screencast record",
    });
  const clips = yield* readVoiceIndex(scenes);
  const placed = placeClips(index.scenes, clips);
  const over = overlaps(placed);
  if (over.length > 0) return yield* new ScreencastError({ message: `OVER: ${over.join("; ")}` });

  yield* Effect.promise(() => mkdir(OUT_DIR, { recursive: true }));
  yield* runCommand("ffmpeg", [...narrationArgs(placed, index.durationMs, NARRATION)]);
  yield* runCommand("ffmpeg", [...muxArgs(RAW_VIDEO, NARRATION, index.durationMs, VIDEO)]);
  const built = yield* durationMs(VIDEO);
  if (Math.abs(built - index.durationMs) > FRAME_MS)
    return yield* new ScreencastError({
      message: `the video runs ${built} ms, the take ${index.durationMs} ms`,
    });

  const frames = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "baton-screencast-")));
  yield* Effect.forEach(index.scenes, (mark, position) =>
    runCommand("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-ss",
      ((mark.startMs + mark.endMs) / 2000).toFixed(3),
      "-i",
      RAW_VIDEO,
      "-frames:v",
      "1",
      "-vf",
      `scale=${VIEWPORT.width / 2}:-1`,
      join(frames, `${String(position + 1).padStart(2, "0")}-${mark.id}.png`),
    ]),
  );
  yield* runCommand("sh", [
    "-c",
    `magick montage "$1"/*.png -font "$2" -label '%t' -pointsize 16 -tile 4x -geometry +4+4 "$3"`,
    "montage",
    frames,
    LABEL_FONT,
    CONTACT_SHEET,
  ]);
  yield* Console.log(
    `build  ok: ${VIDEO} (${(built / 1000).toFixed(1)} s, 1920×1080), contact sheet ${CONTACT_SHEET}`,
  );
});
