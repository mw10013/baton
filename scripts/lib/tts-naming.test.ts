import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import { recordingOutput, speechExcerpt } from "./tts-naming.ts";

void test("recording excerpts preserve Unicode letters and numbers, remove apostrophes, and turn other punctuation into word separators", () => {
  assert.equal(
    speechExcerpt("Don't forget—pickup/delivery!"),
    "dont-forget-pickup-delivery",
  );
  assert.equal(speechExcerpt("  Café, 世界!  "), "café-世界");
  assert.equal(speechExcerpt("😀!!!"), "speech");
  assert.equal(speechExcerpt(`${"a".repeat(75)} nextword`), "a".repeat(75));
  assert.equal(speechExcerpt("a".repeat(100)), "a".repeat(80));
});

void test("daily numbers advance past the highest existing folder number, not the folder count", async () => {
  const root = await mkdtemp(join(tmpdir(), "tts-naming-"));
  const date = new Date("2026-10-05T23:59:59Z");
  try {
    await mkdir(join(root, "20261005-03-old"));
    const preview = await recordingOutput(root, "Hello!", false, date);
    assert.equal(basename(dirname(preview)), "20261005-04-hello");
    const entries = await readdir(root);
    assert.equal(entries.length, 1);
    const outputs = await Promise.all(
      Array.from({ length: 3 }, () =>
        recordingOutput(root, "Hello!", true, date),
      ),
    );
    assert.equal(new Set(outputs).size, 3);
    assert.deepEqual(
      outputs.map((output) => basename(dirname(output))).toSorted(),
      ["20261005-04-hello", "20261005-05-hello", "20261005-06-hello"],
    );
    const tomorrow = await recordingOutput(
      root,
      "Hello!",
      false,
      new Date("2026-10-06T00:00:00Z"),
    );
    assert.equal(basename(dirname(tomorrow)), "20261006-01-hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
