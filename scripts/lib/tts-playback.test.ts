import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { latestRecording } from "./tts-playback.ts";

void test("latest means the greatest UTC folder date and numeric daily sequence, not file modification time", async () => {
  const root = await mkdtemp(join(tmpdir(), "tts-playback-"));
  try {
    await assert.rejects(latestRecording(root));
    for (const folder of [
      "20261004-99-old",
      "20261005-99-earlier",
      "20261005-100-latest",
      "20261006-01-empty",
      "2026-10-05T23-59-59.123Z-abcdef12",
    ]) {
      await mkdir(join(root, folder));
      if (!folder.endsWith("empty"))
        await writeFile(join(root, folder, "speech.mp3"), "test");
    }
    assert.equal(
      await latestRecording(root),
      join(root, "20261005-100-latest", "speech.mp3"),
    );
    await writeFile(join(root, "20261006-01-empty", "new.mp3"), "test");
    assert.equal(
      await latestRecording(root),
      join(root, "20261006-01-empty", "new.mp3"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("a sequence selects that daily number on the newest date with a playable match, ignoring legacy timestamp folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "tts-playback-"));
  try {
    for (const folder of [
      "20261003-03-old",
      "20261004-03-match",
      "20261005-04-other",
      "20261006-03-empty",
      "2026-10-07T23-59-59.123Z-legacy",
    ]) {
      await mkdir(join(root, folder));
      if (!folder.endsWith("empty"))
        await writeFile(join(root, folder, "speech.mp3"), "test");
    }
    assert.equal(
      await latestRecording(root, 3),
      join(root, "20261004-03-match", "speech.mp3"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("missing matches never fall back to another sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "tts-playback-"));
  try {
    await mkdir(join(root, "20261005-04-other"));
    await writeFile(join(root, "20261005-04-other", "speech.mp3"), "test");
    await assert.rejects(latestRecording(root, 3));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
