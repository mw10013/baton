/**
 * Building a screencast from its take: the narration laid on the recording at each scene's start,
 * the picture cropped to the take's frame and scaled to 1080p, and a contact sheet to check before
 * watching. A rehearsal builds a silent video, to check the picture before narration is paid for.
 *
 * @module
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "./command.ts";
import {
  durationMs,
  readVoiceIndex,
  ScreencastError,
  type TakeSpec,
  type VoiceClip,
  voicePath,
} from "./screencast.ts";
import { type Crop, SceneIndex, type SceneMark } from "./screencast-take.ts";

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

/**
 * The part of the take the video keeps, in `raw.webm`'s milliseconds: from the first scene's
 * opening to the last scene's end. A take recorded before scenes marked their opening keeps all of
 * it.
 */
export const takeWindow = (index: SceneIndex) => {
  const last = index.scenes.at(-1);
  return index.openMs === undefined || last === undefined
    ? { startMs: 0, endMs: index.durationMs }
    : {
        startMs: Math.round(index.openMs),
        endMs: Math.round(Math.min(last.endMs, index.durationMs)),
      };
};

/** Each scene's clip at the scene's start in the video, which begins `offsetMs` into the take. */
export const placeClips = (
  marks: ReadonlyArray<SceneMark>,
  clips: ReadonlyArray<VoiceClip>,
  offsetMs = 0,
): ReadonlyArray<PlacedClip> =>
  marks.map((mark) => {
    const clip = clips.find(({ id }) => id === mark.id);
    if (clip === undefined) throw new Error(`no clip for scene ${mark.id}`);
    return {
      id: mark.id,
      file: voicePath(clip.key),
      startMs: Math.round(mark.startMs - offsetMs),
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

/** The picture's filter: the take's crop, if it has one, then 1080p. */
export const pictureFilter = (crop: Crop | undefined) =>
  [
    ...(crop === undefined ? [] : [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`]),
    "scale=1920:1080:flags=lanczos",
  ].join(",");

/**
 * The mux's ffmpeg arguments: the take's window, cropped and scaled to 1080p H.264, the narration
 * as AAC.
 * With no narration, as from a rehearsal, the video is silent.
 */
export const muxArgs = (
  raw: string,
  narration: string | undefined,
  crop: Crop | undefined,
  window: { readonly startMs: number; readonly endMs: number },
  output: string,
): ReadonlyArray<string> => [
  "-v",
  "error",
  "-y",
  "-ss",
  (window.startMs / 1000).toFixed(3),
  "-i",
  raw,
  ...(narration === undefined ? ["-map", "0:v"] : ["-i", narration, "-map", "0:v", "-map", "1:a"]),
  "-vf",
  pictureFilter(crop),
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
  ((window.endMs - window.startMs) / 1000).toFixed(3),
  "-movflags",
  "+faststart",
  output,
];

const decodeSceneIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(SceneIndex));

/**
 * `vp run screencast build`: refuses a take whose clips are stale or overlap, then writes the
 * narration, the video and the contact sheet. A rehearsal gets a silent video instead, with no
 * narration read.
 */
export const buildVideo = Effect.fn("buildVideo")(function* (spec: TakeSpec) {
  const { scenes, files } = spec;
  const text = yield* Effect.tryPromise({
    try: () => readFile(files.sceneIndex, "utf8"),
    catch: () =>
      new ScreencastError({
        message: `no scenes.json for the ${spec.name} take: run vp run screencast record`,
      }),
  });
  const index = yield* decodeSceneIndex(text).pipe(
    Effect.mapError((error) => new ScreencastError({ message: error.message })),
  );
  const video = index.rehearsal ? files.rehearsalVideo : files.video;
  const window = takeWindow(index);
  const videoMs = window.endMs - window.startMs;
  yield* Effect.promise(() => mkdir(files.out, { recursive: true }));
  if (index.rehearsal)
    yield* runCommand("ffmpeg", [...muxArgs(files.raw, undefined, index.crop, window, video)]);
  else {
    const clips = yield* readVoiceIndex(scenes, files);
    const placed = placeClips(index.scenes, clips, window.startMs);
    const over = overlaps(placed);
    if (over.length > 0) return yield* new ScreencastError({ message: `OVER: ${over.join("; ")}` });
    yield* runCommand("ffmpeg", [...narrationArgs(placed, videoMs, files.narration)]);
    yield* runCommand("ffmpeg", [
      ...muxArgs(files.raw, files.narration, index.crop, window, video),
    ]);
  }
  const built = yield* durationMs(video);
  if (Math.abs(built - videoMs) > FRAME_MS)
    return yield* new ScreencastError({
      message: `the video runs ${built} ms, the take's window ${videoMs} ms`,
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
      files.raw,
      "-frames:v",
      "1",
      "-vf",
      `${pictureFilter(index.crop)},scale=800:-1`,
      join(frames, `${String(position + 1).padStart(2, "0")}-${mark.id}.png`),
    ]),
  );
  yield* runCommand("sh", [
    "-c",
    `magick montage "$1"/*.png -font "$2" -label '%t' -pointsize 16 -tile 4x -geometry +4+4 "$3"`,
    "montage",
    frames,
    LABEL_FONT,
    files.contactSheet,
  ]);
  yield* Console.log(
    `build  ok: ${video} (${(built / 1000).toFixed(1)} s, 1920×1080${index.rehearsal ? ", silent rehearsal" : ""}), contact sheet ${files.contactSheet}`,
  );
});
