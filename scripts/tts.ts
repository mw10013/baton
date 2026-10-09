#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, Redacted, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { parse, type ParseError } from "jsonc-parser";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { recordingOutput } from "./lib/tts-naming.ts";
import { latestRecording } from "./lib/tts-playback.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
/**
 * CLI names select only these supported models; aura-2 means English.
 * Voices are limited to feminine English voices supported by Cloudflare for
 * each model. Reject incompatible pairs before credentials or requests.
 * Help and validation read the same lists. Luna is the default for both.
 * Cloudflare support and Deepgram's expressed-gender classifications:
 * https://developers.cloudflare.com/workers-ai/models/aura-1/
 * https://developers.cloudflare.com/workers-ai/models/aura-2-en/
 * https://developers.deepgram.com/docs/tts-models
 * Estimates use published character rates, not the account's free allocation:
 * https://developers.cloudflare.com/workers-ai/platform/pricing/
 */
const MODELS = {
  "aura-1": {
    id: "@cf/deepgram/aura-1",
    voices: ["asteria", "athena", "hera", "luna", "stella"],
    neuronsPerCharacter: 1.36364,
    usdPerCharacter: 0.000015,
  },
  "aura-2": {
    id: "@cf/deepgram/aura-2-en",
    voices: [
      "amalthea",
      "andromeda",
      "asteria",
      "athena",
      "aurora",
      "callista",
      "cora",
      "cordelia",
      "delia",
      "electra",
      "harmonia",
      "helena",
      "hera",
      "iris",
      "janus",
      "juno",
      "luna",
      "minerva",
      "ophelia",
      "pandora",
      "phoebe",
      "thalia",
      "theia",
      "vesta",
    ],
    neuronsPerCharacter: 2.72727,
    usdPerCharacter: 0.00003,
  },
};
const VOICES = [
  ...new Set(Object.values(MODELS).flatMap((model) => model.voices)),
];
const VOICE_HELP = Object.entries(MODELS)
  .map(([name, model]) => `${name}: ${model.voices.join(", ")}`)
  .join("; ");
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEADLINE_MS = 60_000;

/** Count Unicode code points, not UTF-16 units, for validation and estimates. */
function countCharacters(text: string): number {
  // eslint-disable-next-line typescript/no-misused-spread -- String iteration counts Unicode code points, as this command requires.
  return [...text].length;
}

class SpeechError extends Schema.TaggedError<SpeechError>()("SpeechError", {
  message: Schema.String,
}) {}

const accountConfig = Schema.Struct({
  vars: Schema.Struct({ CLOUDFLARE_ACCOUNT_ID: Schema.String }),
});

const accountId = Effect.tryPromise({
  try: async () => {
    const override = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (override !== undefined) return override;
    const errors: ParseError[] = [];
    const value: unknown = parse(
      await readFile(resolve(REPO_ROOT, "wrangler.jsonc"), "utf8"),
      errors,
    );
    if (errors.length > 0) throw new Error("Invalid JSONC");
    return Schema.decodeUnknownSync(accountConfig)(value).vars
      .CLOUDFLARE_ACCOUNT_ID;
  },
  catch: () =>
    new SpeechError({
      message: "Cannot read the account ID from wrangler.jsonc.",
    }),
}).pipe(
  Effect.flatMap((value) =>
    /^[a-f0-9]{32}$/iu.test(value)
      ? Effect.succeed(value)
      : Effect.fail(
          new SpeechError({
            message:
              "CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal ID.",
          }),
        ),
  ),
);

/** Bound buffering while reading, not after allocating the entire response. */
async function readAudio(response: Response): Promise<Uint8Array> {
  if (response.body === null)
    throw new SpeechError({
      message: "Cloudflare returned an empty audio body.",
    });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array))
        throw new SpeechError({
          message: "Cloudflare returned an invalid audio chunk.",
        });
      size += chunk.byteLength;
      if (size > MAX_AUDIO_BYTES)
        throw new SpeechError({
          message: "Audio exceeds the local 10 MiB limit.",
        });
      chunks.push(chunk);
    }
    if (size === 0)
      throw new SpeechError({
        message: "Cloudflare returned an empty audio body.",
      });
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    await reader.cancel().catch(() => null);
    reader.releaseLock();
  }
}

/**
 * Send one request, never retry, and publish complete bytes without replacing
 * an existing destination. A timeout can still represent metered inference.
 * Transport failures are mapped to fixed messages: raw errors may carry secrets.
 */
function synthesize(
  account: string,
  token: Redacted.Redacted,
  output: string,
  text: string,
  model: string,
  speaker: string,
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const parent = dirname(output);
      const staging = resolve(parent, `.speech-${randomUUID()}.part`);
      let stageCreated = false;
      try {
        try {
          await mkdir(parent, { recursive: true });
          try {
            await lstat(output);
            throw new SpeechError({
              message: "Output already exists; choose another --output path.",
            });
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          }
          const handle = await open(staging, "wx", 0o600);
          stageCreated = true;
          await handle.close();
        } catch (error) {
          if (error instanceof SpeechError) throw error;
          throw new SpeechError({
            message: "Cannot prepare the output directory and staging file.",
          });
        }

        const started = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, DEADLINE_MS);
        let bytes: Uint8Array;
        let ray: string | null;
        try {
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.any([signal, controller.signal]),
              headers: {
                Authorization: `Bearer ${Redacted.value(token)}`,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
              },
              body: JSON.stringify({
                text,
                speaker,
                encoding: "mp3",
              }),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new SpeechError({
              message: `Cloudflare returned HTTP ${response.status.toString()}. Check credentials, permissions, or service availability; no retry was sent.`,
            });
          }
          if (
            response.headers
              .get("content-type")
              ?.split(";")[0]
              ?.trim()
              .toLowerCase() !== "audio/mpeg"
          ) {
            await response.body?.cancel();
            throw new SpeechError({
              message:
                "Cloudflare did not return audio/mpeg; no audio file was published.",
            });
          }
          ray = response.headers.get("cf-ray");
          bytes = await readAudio(response);
        } catch (error) {
          if (error instanceof SpeechError) throw error;
          throw new SpeechError({
            message: controller.signal.aborted
              ? "Speech request exceeded 60 seconds. It may have been charged; no retry was sent."
              : "Speech transport failed. It may have been charged; no retry was sent.",
          });
        } finally {
          clearTimeout(timer);
          controller.abort();
        }

        try {
          await writeFile(staging, bytes);
          await link(staging, output);
        } catch {
          throw new SpeechError({
            message:
              "Audio was received but could not be published without overwriting. The request may have been charged.",
          });
        }
        const metadata = {
          createdAt: new Date().toISOString(),
          output,
          accountId: account,
          model,
          speaker,
          text,
          characters: countCharacters(text),
          bytes: bytes.byteLength,
          elapsedMs: Math.round(performance.now() - started),
          cfRay: ray,
        };
        const metadataSaved = await writeFile(
          `${output.slice(0, -4)}.metadata.json`,
          `${JSON.stringify(metadata, null, 2)}\n`,
          {
            flag: "wx",
            mode: 0o600,
          },
        ).then(
          () => true,
          () => false,
        );
        return { ...metadata, metadataSaved };
      } finally {
        if (stageCreated) await unlink(staging).catch(() => null);
      }
    },
    catch: (error) =>
      error instanceof SpeechError
        ? error
        : new SpeechError({
            message: "Speech command failed; no automatic retry was sent.",
          }),
  });
}

const gen = Command.make(
  "gen",
  {
    model: Flag.choice("model", ["aura-1", "aura-2"]).pipe(
      Flag.withDescription("Speech model: aura-1 or aura-2 (English, default)"),
      Flag.withDefault("aura-2"),
    ),
    voice: Flag.choice("voice", VOICES).pipe(
      Flag.withDescription(`Female voice (default: luna). ${VOICE_HELP}`),
      Flag.withDefault("luna"),
    ),
    text: Argument.string("text").pipe(
      Argument.withDescription(
        "Required text to speak (1–500 Unicode code points); quote it as one argument",
      ),
    ),
    output: Flag.string("output").pipe(
      Flag.withDescription(
        "MP3 file path, absolute or relative to the repo root; defaults to tmp/tts/<YYYYMMDD>-<NN>-<excerpt>/<excerpt>.mp3; creates parent directories; never overwrites",
      ),
      Flag.withDefault(""),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription(
        "Preview without loading credentials, writing files, or making requests",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fnUntraced(function* (options) {
    const model = MODELS[options.model];
    if (!model.voices.includes(options.voice)) {
      yield* Effect.fail(
        new SpeechError({
          message: `--voice ${options.voice} is not supported with --model ${options.model}. Choose: ${model.voices.join(", ")}.`,
        }),
      );
    }
    const characters = countCharacters(options.text);
    if (options.text.trim().length === 0 || characters > 500) {
      yield* Effect.fail(
        new SpeechError({
          message:
            "Text must contain non-whitespace text and at most 500 Unicode code points.",
        }),
      );
    }
    const chooseOutput = (reserve: boolean) =>
      Effect.tryPromise({
        try: () =>
          options.output
            ? Promise.resolve(resolve(REPO_ROOT, options.output))
            : recordingOutput(
                resolve(REPO_ROOT, "tmp/tts"),
                options.text,
                reserve,
              ),
        catch: () =>
          new SpeechError({
            message: "Cannot choose or reserve the output folder.",
          }),
      });
    const output = yield* chooseOutput(false);
    if (!output.endsWith(".mp3"))
      yield* Effect.fail(
        new SpeechError({ message: "--output must end in .mp3." }),
      );
    if (options.dryRun) {
      const account = yield* accountId;
      yield* Console.log(
        JSON.stringify(
          {
            dryRun: true,
            accountId: account,
            model: model.id,
            speaker: options.voice,
            text: options.text,
            characters,
            output,
            estimatedNeurons:
              Math.round(characters * model.neuronsPerCharacter * 100) / 100,
            estimatedOverageUsd: characters * model.usdPerCharacter,
          },
          null,
          2,
        ),
      );
      return;
    }
    const token = yield* Config.redacted("CLOUDFLARE_API_TOKEN").pipe(
      Effect.mapError(
        () =>
          new SpeechError({
            message: "Set CLOUDFLARE_API_TOKEN in the environment.",
          }),
      ),
    );
    if (Redacted.value(token).trim().length === 0)
      yield* Effect.fail(
        new SpeechError({ message: "CLOUDFLARE_API_TOKEN is blank." }),
      );
    const account = yield* accountId;
    const reservedOutput = yield* chooseOutput(true);
    const result = yield* synthesize(
      account,
      token,
      reservedOutput,
      options.text,
      model.id,
      options.voice,
    );
    yield* Console.log(JSON.stringify(result, null, 2));
    if (!result.metadataSaved)
      yield* Console.warn(
        "Audio was saved, but its metadata sidecar could not be written.",
      );
  }),
).pipe(
  Command.withDescription(
    "Generate one MP3. Defaults to Aura-2 (English) and luna. Example: pnpm tts gen 'Hello from Baton!' --model aura-2 --voice athena. No retries. Text is stored in metadata and may appear in shell history and process listings.",
  ),
);

const play = Command.make(
  "play",
  {
    path: Argument.string("path").pipe(
      Argument.withDescription(
        "MP3 path or daily sequence number (newest matching date); defaults to the latest recording in tmp/tts",
      ),
      Argument.withDefault(""),
    ),
    device: Flag.string("device").pipe(
      Flag.withDescription(
        "mpv output device identifier; defaults to Speakers + BlackHole; use auto for normal system output or mpv --audio-device=help to list devices",
      ),
      Flag.withDefault("coreaudio/~:AMS2_StackedOutput:0"),
    ),
  },
  Effect.fnUntraced(function* ({ path, device }) {
    const sequence = /^\d+$/u.test(path) ? Number(path) : undefined;
    if (
      sequence !== undefined &&
      (!Number.isSafeInteger(sequence) || sequence < 1)
    )
      yield* Effect.fail(
        new SpeechError({
          message: "Recording number must be a positive safe integer.",
        }),
      );
    const output = yield* Effect.tryPromise({
      try: () =>
        path && sequence === undefined
          ? Promise.resolve(resolve(REPO_ROOT, path))
          : latestRecording(resolve(REPO_ROOT, "tmp/tts"), sequence),
      catch: () =>
        new SpeechError({
          message:
            sequence === undefined
              ? "No audio found or the recording directory could not be read."
              : `No playable recording numbered ${sequence.toString()} found or the recording directory could not be read.`,
        }),
    });
    if (!output.endsWith(".mp3"))
      yield* Effect.fail(
        new SpeechError({ message: "Playback path must end in .mp3." }),
      );
    yield* Console.log(`Playing ${output} on ${device}`);
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((complete, fail) => {
          const child = spawn(
            "mpv",
            ["--no-config", "--no-video", `--audio-device=${device}`, output],
            { stdio: "inherit" },
          );
          child.once("error", fail);
          child.once("exit", (code) => {
            if (code === 0) complete();
            else fail(new Error("Playback failed"));
          });
        }),
      catch: () =>
        new SpeechError({
          message:
            "Playback failed. Check the MP3 path and output device; mpv must be installed (brew install mpv).",
        }),
    });
  }),
).pipe(
  Command.withDescription(
    "Play the latest recording, a daily sequence number, or a specific MP3 using mpv; output defaults to Speakers + BlackHole",
  ),
);

const command = Command.make("tts").pipe(
  Command.withDescription("Generate and play speech recordings"),
  Command.withSubcommands([gen, play]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(command);
