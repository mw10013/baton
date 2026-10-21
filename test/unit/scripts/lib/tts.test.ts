import { afterEach, assert, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countCharacters,
  latestRecording,
  recordingOutput,
  SpeechText,
  speechExcerpt,
  synthesize,
} from "../../../../scripts/lib/tts.ts";

const scratch = () => mkdtemp(join(tmpdir(), "baton-tts-"));

describe("SpeechText", () => {
  const decode = Schema.decodeUnknownOption(SpeechText);

  it("accepts 500 code points, counted as code points, not UTF-16 units", () => {
    const emoji = "😀".repeat(500);
    assert.strictEqual(countCharacters(emoji), 500);
    assert.isTrue(Option.isSome(decode(emoji)));
  });

  it("rejects blank or oversized text", () => {
    for (const text of ["", "   \n", "a".repeat(501)]) assert.isTrue(Option.isNone(decode(text)));
  });
});

describe("speechExcerpt", () => {
  it("keeps letters and numbers, drops apostrophes, joins the rest with one dash", () => {
    assert.strictEqual(
      speechExcerpt("Hi there, I'm Ana — order #1201!"),
      "hi-there-im-ana-order-1201",
    );
    assert.strictEqual(speechExcerpt("Café über 2"), "café-über-2");
    assert.strictEqual(speechExcerpt("?!"), "speech");
  });

  it("cuts at a word boundary within 80 code points", () => {
    const excerpt = speechExcerpt(`${"word ".repeat(30)}`);
    assert.isAtMost(Array.from(excerpt).length, 80);
    assert.isFalse(excerpt.endsWith("-"));
    assert.isTrue(excerpt.endsWith("word"));
  });
});

describe("recordingOutput", () => {
  const date = new Date("2026-10-21T12:00:00Z");

  it("numbers past the highest folder that day, not the folder count", async () => {
    const root = await scratch();
    await mkdir(join(root, "20261021-07-old"));
    await mkdir(join(root, "20261020-30-yesterday"));
    assert.strictEqual(
      await recordingOutput(root, "Hello there", false, date),
      join(root, "20261021-08-hello-there", "hello-there.mp3"),
    );
  });

  it("writes nothing without reserve, and reserves the folder with it", async () => {
    const root = await scratch();
    await recordingOutput(root, "Hello", false, date);
    assert.deepStrictEqual(await readdir(root), []);
    await recordingOutput(root, "Hello", true, date);
    assert.deepStrictEqual(await readdir(root), ["20261021-01-hello"]);
  });
});

describe("latestRecording", () => {
  const seed = async (root: string, folders: Record<string, readonly string[]>) => {
    for (const [folder, files] of Object.entries(folders)) {
      await mkdir(join(root, folder));
      for (const file of files) await writeFile(join(root, folder, file), "");
    }
  };

  it("takes the newest date, then the highest number, skipping folders with no MP3", async () => {
    const root = await scratch();
    await seed(root, {
      "20261020-09-a": ["a.mp3"],
      "20261021-02-b": ["b.mp3"],
      "20261021-10-c": ["c.mp3"],
      "20261021-11-d": ["d.metadata.json"],
    });
    assert.strictEqual(await latestRecording(root), join(root, "20261021-10-c", "c.mp3"));
  });

  it("selects a daily number on the newest date that has it, with no fallback", async () => {
    const root = await scratch();
    await seed(root, { "20261020-03-a": ["a.mp3"], "20261021-01-b": ["b.mp3"] });
    assert.strictEqual(await latestRecording(root, 3), join(root, "20261020-03-a", "a.mp3"));
    const missing = await latestRecording(root, 4).then(
      () => false,
      () => true,
    );
    assert.isTrue(missing);
  });
});

describe("synthesize", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const request = (output: string, text = "Hello") => ({
    account: "0".repeat(32),
    token: Redacted.make("secret-token"),
    model: "aura-2" as const,
    speaker: "luna",
    text,
    output,
  });

  const audio = (status = 200, type = "audio/mpeg") =>
    vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), { status, headers: { "content-type": type } }),
      ),
    );

  it.effect("writes the MP3 and its metadata, with one request", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(scratch);
      const fetch = audio();
      vi.stubGlobal("fetch", fetch);
      const output = join(root, "line.mp3");
      const result = yield* synthesize(request(output));
      assert.strictEqual(fetch.mock.calls.length, 1);
      assert.deepStrictEqual([...(yield* Effect.promise(() => readFile(output)))], [1, 2, 3]);
      assert.strictEqual(result.characters, 5);
      assert.isTrue(result.metadataSaved);
      const files = yield* Effect.promise(() => readdir(root));
      assert.deepStrictEqual(files.toSorted(), ["line.metadata.json", "line.mp3"]);
    }),
  );

  it.effect("refuses an existing output before any request", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(scratch);
      const output = join(root, "line.mp3");
      yield* Effect.promise(() => writeFile(output, "old"));
      const fetch = audio();
      vi.stubGlobal("fetch", fetch);
      const exit = yield* Effect.exit(synthesize(request(output)));
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(fetch.mock.calls.length, 0);
      assert.strictEqual(yield* Effect.promise(() => readFile(output, "utf8")), "old");
    }),
  );

  it.effect("rejects an unsupported voice and blank text before any request", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(scratch);
      const fetch = audio();
      vi.stubGlobal("fetch", fetch);
      const output = join(root, "line.mp3");
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(synthesize({ ...request(output), speaker: "orion" }))),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(synthesize(request(output, " ")))));
      assert.strictEqual(fetch.mock.calls.length, 0);
    }),
  );

  it.effect(
    "fails with a fixed message on an HTTP error or a non-audio answer, writing nothing",
    () =>
      Effect.gen(function* () {
        for (const fetch of [audio(403), audio(200, "application/json")]) {
          const root = yield* Effect.promise(scratch);
          vi.stubGlobal("fetch", fetch);
          const error = yield* Effect.flip(synthesize(request(join(root, "line.mp3"))));
          assert.notInclude(error.message, "secret-token");
          assert.deepStrictEqual(yield* Effect.promise(() => readdir(root)), []);
        }
      }),
  );
});
