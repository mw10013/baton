import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  INSTRUCTIONS_LIMIT,
  instructionsText,
  type Scene,
  voiceKey,
} from "../../../../scripts/lib/screencast.ts";
import { SpeechText } from "../../../../scripts/lib/tts.ts";
import { SCENES } from "../../../../scripts/screencast-scenes.ts";
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
      assert.notInclude(text, "3.");
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
