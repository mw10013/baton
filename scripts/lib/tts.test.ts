import { Schema } from "effect";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = resolve(REPO_ROOT, "scripts/tts.ts");
const parsePreview = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      dryRun: Schema.Boolean,
      model: Schema.String,
      speaker: Schema.String,
      text: Schema.String,
      characters: Schema.Number,
      output: Schema.String,
      estimatedNeurons: Schema.Number,
      estimatedOverageUsd: Schema.Number,
    }),
  ),
);

function invoke(...args: readonly string[]) {
  const textIndex = args.indexOf("--text");
  const cliArgs =
    textIndex === -1
      ? ["gen", ...args]
      : [
          "gen",
          args[textIndex + 1],
          ...args.filter(
            (_, index) => index !== textIndex && index !== textIndex + 1,
          ),
        ];
  return invokeCommand(...cliArgs);
}

function invokeCommand(...cliArgs: readonly string[]) {
  // eslint-disable-next-line prefer-object-spread -- Wrangler narrows ProcessEnv to deployment literals; this child process uses a test account instead.
  const env = Object.assign({}, process.env, {
    CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
    CLOUDFLARE_API_TOKEN: "",
    NO_COLOR: "1",
  });
  const result = spawnSync(process.execPath, [SCRIPT, ...cliArgs], {
    cwd: dirname(REPO_ROOT),
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

void test("help is available without text or credentials through --help and -h", () => {
  for (const flag of ["--help", "-h"]) {
    const result = invoke(flag);
    assert.equal(result.status, 0, result.stderr);
    for (const option of [
      "--model",
      "--voice",
      "--output",
      "--dry-run",
      "--help",
    ]) {
      assert.ok(result.stdout.includes(option));
    }
    assert.match(result.stdout, /pnpm tts gen/u);
    assert.ok(result.stdout.includes("<YYYYMMDD>-<NN>-<excerpt>"));
    assert.match(result.stdout, /aura-1 \(default\)/u);
    assert.match(result.stdout, /aura-2 \(English\)/u);
    assert.match(result.stdout, /default: luna/u);
    assert.match(result.stdout, /aura-1: asteria, athena, hera, luna, stella/u);
    assert.match(result.stdout, /aura-2: amalthea, andromeda/u);
    for (const voice of [
      "janus",
      "juno",
      "pandora",
      "thalia",
      "theia",
      "vesta",
    ]) {
      assert.ok(result.stdout.includes(voice));
    }
  }
});

void test("gen accepts positional text with options before or after it and rejects extra arguments", () => {
  for (const args of [
    ["Hello!", "--voice", "athena"],
    ["--voice", "athena", "Hello!"],
  ]) {
    const result = invokeCommand("gen", ...args, "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsePreview(result.stdout).text, "Hello!");
    assert.equal(parsePreview(result.stdout).speaker, "athena");
  }
  const extra = invokeCommand("gen", "Hello", "world", "--dry-run");
  assert.notEqual(extra.status, 0);
});

void test("root and play help are available without text or credentials", () => {
  const root = invokeCommand("--help");
  assert.equal(root.status, 0, root.stderr);
  assert.match(root.stdout, /gen/u);
  assert.match(root.stdout, /play/u);
  const play = invokeCommand("play", "--help");
  assert.equal(play.status, 0, play.stderr);
  assert.match(play.stdout, /mpv/u);
  const invalid = invokeCommand("play", "not-a-recording.wav");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout + invalid.stderr, /Playback path must end/u);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /CLOUDFLARE_API_TOKEN/u);
});

void test("shared female voices work with both models", () => {
  for (const model of ["aura-1", "aura-2"]) {
    for (const voice of ["asteria", "athena", "hera", "luna"]) {
      const result = invoke(
        "--text",
        "Hello",
        "--model",
        model,
        "--voice",
        voice,
        "--dry-run",
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(parsePreview(result.stdout).speaker, voice);
    }
  }
});

void test("model-specific female voices work with their supported model", () => {
  for (const [model, voice] of [
    ["aura-1", "stella"],
    ["aura-2", "thalia"],
    ["aura-2", "janus"],
  ]) {
    const result = invoke(
      "--text",
      "Hello",
      "--model",
      model,
      "--voice",
      voice,
      "--dry-run",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsePreview(result.stdout).speaker, voice);
  }
});

void test("reject incompatible pairs before credentials or requests", () => {
  for (const [model, voice] of [
    ["aura-1", "thalia"],
    ["aura-2", "stella"],
  ]) {
    const result = invoke(
      "--text",
      "Hello",
      "--model",
      model,
      "--voice",
      voice,
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout + result.stderr,
      /is not supported with --model/u,
    );
    assert.match(result.stdout + result.stderr, /Choose:/u);
    assert.doesNotMatch(result.stdout + result.stderr, /CLOUDFLARE_API_TOKEN/u);
  }
});

void test("male, unknown, and unavailable Cloudflare voices are rejected", () => {
  for (const voice of ["orion", "unknown", "selene", "lunar"]) {
    const result = invoke("--text", "Hello", "--voice", voice);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /voice/u);
    assert.doesNotMatch(result.stdout + result.stderr, /CLOUDFLARE_API_TOKEN/u);
  }
});

void test("CLI names select only these supported models; aura-2 means English", () => {
  for (const [name, id, neurons, usd] of [
    ["aura-1", "@cf/deepgram/aura-1", 1.36364, 0.000015],
    ["aura-2", "@cf/deepgram/aura-2-en", 2.72727, 0.00003],
  ] as const) {
    const result = invoke("--text", "Hello", "--model", name, "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    const preview = parsePreview(result.stdout);
    assert.equal(preview.model, id);
    assert.equal(preview.speaker, "luna");
    assert.equal(preview.estimatedNeurons, Math.round(5 * neurons * 100) / 100);
    assert.equal(preview.estimatedOverageUsd, 5 * usd);
    assert.ok(preview.output.endsWith("/hello.mp3"));
  }
});

void test("unsupported model names are rejected before credentials are loaded", () => {
  for (const model of ["aura-3", "@cf/deepgram/aura-2-en", ""]) {
    const result = invoke("--text", "Hello", "--model", model);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /aura-1/u);
    assert.match(result.stdout + result.stderr, /aura-2/u);
    assert.doesNotMatch(result.stdout + result.stderr, /CLOUDFLARE_API_TOKEN/u);
  }
});

void test("text is required even for a dry run", () => {
  const result = invoke("--dry-run");
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /text/u);
});

void test("blank or oversized text is rejected before credentials are loaded", () => {
  for (const text of ["", " \n\t ", "a".repeat(501)]) {
    const result = invoke("--text", text);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Text must contain/u);
    assert.doesNotMatch(result.stdout + result.stderr, /CLOUDFLARE_API_TOKEN/u);
  }
});

void test("the original text is preserved in the preview and its estimates", () => {
  const text = "  Hello\nBaton.  ";
  const result = invoke("--text", text, "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  const preview = parsePreview(result.stdout);
  assert.equal(preview.text, text);
  assert.equal(preview.characters, text.length);
  assert.equal(preview.model, "@cf/deepgram/aura-1");
  assert.equal(preview.speaker, "luna");
  assert.equal(preview.estimatedOverageUsd, text.length * 0.000015);
  assert.equal(
    preview.estimatedNeurons,
    Math.round(text.length * 1.36364 * 100) / 100,
  );
});

void test("count Unicode code points, not UTF-16 units, for validation and estimates", () => {
  const text = "😀".repeat(500);
  const result = invoke("--text", text, "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  const preview = parsePreview(result.stdout);
  assert.equal(preview.text, text);
  assert.equal(preview.characters, 500);
  assert.equal(preview.estimatedOverageUsd, 500 * 0.000015);
  const oversized = invoke("--text", `${text}😀`, "--dry-run");
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stdout + oversized.stderr, /Text must contain/u);
});

void test("generated output groups each recording under the repo root without writing during a dry run", () => {
  const outputs = Array.from({ length: 2 }, () => {
    const result = invoke("--text", "Hello", "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    const preview = parsePreview(result.stdout);
    assert.equal(preview.dryRun, true);
    assert.ok(preview.output.startsWith(`${resolve(REPO_ROOT, "tmp/tts")}/`));
    assert.match(preview.output, /\/\d{8}-\d{2,}-hello\/hello\.mp3$/u);
    assert.equal(existsSync(dirname(preview.output)), false);
    return preview.output;
  });
  assert.equal(outputs[0], outputs[1]);
});

void test("explicit output is a repo-relative or absolute MP3 file path", () => {
  for (const output of [
    "tmp/tts/welcome.mp3",
    resolve(REPO_ROOT, "tmp/custom.mp3"),
  ]) {
    const result = invoke("--text", "Hello", "--output", output, "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      parsePreview(result.stdout).output,
      resolve(REPO_ROOT, output),
    );
  }
  const invalid = invoke(
    "--text",
    "Hello",
    "--output",
    "tmp/tts/welcome.wav",
    "--dry-run",
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout + invalid.stderr, /--output must end in \.mp3/u);
});
