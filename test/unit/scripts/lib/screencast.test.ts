import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  INSTRUCTIONS_LIMIT,
  instructionsText,
  type Scene,
  takeFiles,
  voiceKey,
} from "../../../../scripts/lib/screencast.ts";
import { SpeechText } from "../../../../scripts/lib/tts.ts";
import { SCENES } from "../../../../scripts/screencast-scenes.ts";
import { BRAND_CARD, FEATURE_SCENES } from "../../../../scripts/feature-video-scenes.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const scene = (id: string, step?: string): Scene => ({
  id,
  say: id,
  act: () => Promise.resolve(),
  ...(step === undefined ? {} : { step }),
});

describe("voiceKey", () => {
  it("is the same for the same model, speaker and words", () => {
    assert.strictEqual(voiceKey("aura-2", "luna", "Hello."), voiceKey("aura-2", "luna", "Hello."));
  });

  it("changes with any of them", () => {
    const base = voiceKey("aura-2", "luna", "Hello.");
    for (const other of [
      voiceKey("aura-1", "luna", "Hello."),
      voiceKey("aura-2", "athena", "Hello."),
      voiceKey("aura-2", "luna", "Hello!"),
    ])
      assert.notStrictEqual(other, base);
  });
});

describe("instructionsText", () => {
  it.effect("numbers the steps in scene order and skips scenes with none", () =>
    Effect.gen(function* () {
      const text = yield* instructionsText([
        scene("a", "First."),
        scene("b"),
        scene("c", "Second."),
      ]);
      assert.include(text, "1. First.\n2. Second.");
      assert.notInclude(text, "\n3. ");
    }),
  );

  it.effect("fails over Shopify's limit", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        instructionsText([scene("a", "x".repeat(INSTRUCTIONS_LIMIT))]),
      );
      assert.include(error.message, String(INSTRUCTIONS_LIMIT));
    }),
  );
});

describe("SCENES", () => {
  it("has unique ids", () => {
    assert.strictEqual(new Set(SCENES.map(({ id }) => id)).size, SCENES.length);
  });

  it("has lines the voice accepts", () => {
    for (const { id, say } of SCENES)
      assert.isTrue(Option.isSome(Schema.decodeUnknownOption(SpeechText)(say)), id);
  });

  it("keeps semicolons out of the copy", () => {
    for (const { id, say, step } of SCENES) {
      assert.notInclude(say, ";", id);
      assert.notInclude(step ?? "", ";", id);
    }
  });

  it.effect("fits the testing instructions under the limit", () =>
    Effect.gen(function* () {
      yield* instructionsText(SCENES);
    }),
  );
});

describe("FEATURE_SCENES", () => {
  it("has unique ids", () => {
    assert.strictEqual(new Set(FEATURE_SCENES.map(({ id }) => id)).size, FEATURE_SCENES.length);
  });

  it("has lines the voice accepts, with no semicolons", () => {
    for (const { id, say } of FEATURE_SCENES) {
      assert.isTrue(Option.isSome(Schema.decodeUnknownOption(SpeechText)(say)), id);
      assert.notInclude(say, ";", id);
    }
  });

  it("shows only help pictures that exist", () => {
    for (const { id, card } of FEATURE_SCENES)
      if (card?._tag === "Phones")
        for (const file of card.files)
          assert.isTrue(existsSync(resolve("public/assets/help", file)), `${id}: ${file}`);
  });

  it("says the brand line word for word at the end", () => {
    assert.include(
      FEATURE_SCENES.at(-1)?.say ?? "",
      BRAND_CARD._tag === "Title" ? BRAND_CARD.line : "",
    );
  });
});

describe("takeFiles", () => {
  it("keeps the review's files where they were", () => {
    const files = takeFiles("/tmp/screencast", "baton-review");
    assert.strictEqual(files.raw, "/tmp/screencast/raw.webm");
    assert.strictEqual(files.video, "/tmp/screencast/out/baton-review.mp4");
    assert.strictEqual(files.rehearsalVideo, "/tmp/screencast/out/baton-review-rehearsal.mp4");
  });
});
