#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Redacted,
  Schema,
} from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { parse, type ParseError } from "jsonc-parser";
import { randomUUID } from "node:crypto";
import {
  access,
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

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MODEL = "@cf/deepgram/aura-1";
const SPEAKER = "luna";
const TEST_TEXT =
  "Hello from Baton. This is a short test of text to speech using Cloudflare Workers AI.";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEADLINE_MS = 60_000;
// eslint-disable-next-line typescript/no-misused-spread -- Count code points, not graphemes; the fixed test text is ASCII, with unambiguous billing units.
const CHARACTER_COUNT = [...TEST_TEXT].length;

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

const loadCredentials = Effect.tryPromise({
  try: async () => {
    const path = resolve(REPO_ROOT, ".env.cf.local");
    try {
      await access(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    process.loadEnvFile(path);
  },
  catch: () => new SpeechError({ message: "Cannot load .env.cf.local." }),
});

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
function synthesize(account: string, token: Redacted.Redacted, output: string) {
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
            `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`,
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
                text: TEST_TEXT,
                speaker: SPEAKER,
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
          output,
          accountId: account,
          model: MODEL,
          speaker: SPEAKER,
          text: TEST_TEXT,
          characters: CHARACTER_COUNT,
          bytes: bytes.byteLength,
          elapsedMs: Math.round(performance.now() - started),
          cfRay: ray,
        };
        const metadataSaved = await writeFile(
          `${output}.metadata.json`,
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

const command = Command.make(
  "tts",
  {
    output: Flag.string("output").pipe(
      Flag.withDescription(
        "MP3 destination, relative to the repo root; existing files are never replaced",
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
    if (TEST_TEXT.trim().length === 0 || CHARACTER_COUNT > 500) {
      yield* Effect.fail(
        new SpeechError({
          message: "TEST_TEXT must contain between 1 and 500 characters.",
        }),
      );
    }
    const output = resolve(
      REPO_ROOT,
      options.output ||
        `tmp/tts/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}/speech.mp3`,
    );
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
            model: MODEL,
            speaker: SPEAKER,
            text: TEST_TEXT,
            characters: CHARACTER_COUNT,
            output,
            estimatedNeurons: Math.round(CHARACTER_COUNT * 1.36364 * 100) / 100,
            estimatedOverageUsd: CHARACTER_COUNT * 0.000015,
          },
          null,
          2,
        ),
      );
      return;
    }
    yield* loadCredentials;
    const token = yield* Config.redacted("CLOUDFLARE_API_TOKEN").pipe(
      // The CLI can initialize the default provider before dotenv is loaded.
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv(),
      ),
      Effect.mapError(
        () =>
          new SpeechError({
            message: "Set CLOUDFLARE_API_TOKEN in .env.cf.local.",
          }),
      ),
    );
    if (Redacted.value(token).trim().length === 0)
      yield* Effect.fail(
        new SpeechError({ message: "CLOUDFLARE_API_TOKEN is blank." }),
      );
    const account = yield* accountId;
    const result = yield* synthesize(account, token, output);
    yield* Console.log(JSON.stringify(result, null, 2));
    if (!result.metadataSaved)
      yield* Console.warn(
        "Audio was saved, but its metadata sidecar could not be written.",
      );
  }),
).pipe(
  Command.withDescription(
    "Generate one Aura-1/luna MP3 from the fixed TEST_TEXT. No retries.",
  ),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(command);
