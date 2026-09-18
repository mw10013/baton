import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import {
  copyCookieDatabase,
  readSafeStoragePassword,
  writeStorageState,
} from "./shopify-playwright-auth.ts";

const temporaryDirectory = async (t: TestContext) => {
  const directory = await mkdtemp(path.join(tmpdir(), "baton-auth-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const cookies = [
  {
    name: "koa.sid",
    value: "synthetic-test-session",
    domain: "admin.shopify.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: Date.now() / 1000 + 3600,
  },
];

await test("atomic export replaces the state with owner-only permissions and removes staging files", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, "state.json");
  await writeFile(output, "previous state", { mode: 0o644 });
  await Effect.runPromise(
    writeStorageState(output, cookies).pipe(Effect.provide(NodeServices.layer)),
  );
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
    cookies,
    origins: [],
  });
  const outputStat = await stat(output);
  assert.equal(outputStat.mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

await test("an expired export preserves the previous state", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, "state.json");
  await writeFile(output, "previous state");
  await assert.rejects(
    Effect.runPromise(
      writeStorageState(
        output,
        cookies.map((cookie) => ({ ...cookie, expires: 1 })),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
    /expired or missing/u,
  );
  assert.equal(await readFile(output, "utf8"), "previous state");
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

await test("a failed staged write preserves the previous state and removes partial files", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, "state.json");
  await writeFile(output, "previous state");
  const failedWrite = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* writeStorageState(output, cookies).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (file, _data, options) =>
          fs
            .writeFileString(file, "partial", options)
            .pipe(
              Effect.andThen(fs.rename(path.join(directory, "missing"), file)),
            ),
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer));
  await assert.rejects(Effect.runPromise(failedWrite));
  assert.equal(await readFile(output, "utf8"), "previous state");
  assert.deepEqual(await readdir(directory), ["state.json"]);
});

await test("database and WAL copies are private and removed on scope failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "Cookies");
  await writeFile(source, "synthetic database");
  await writeFile(`${source}-wal`, "synthetic WAL");
  const copies: string[] = [];
  const copy = Effect.gen(function* () {
    const file = yield* copyCookieDatabase(source);
    copies.push(file);
    const fs = yield* FileSystem.FileSystem;
    assert.equal(yield* fs.readFileString(`${file}-wal`), "synthetic WAL");
    assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
    return yield* Effect.fail(new Error("failure after copying"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  await assert.rejects(Effect.runPromise(copy), /failure after copying/u);
  assert.equal(copies.length, 1);
  await assert.rejects(stat(path.dirname(copies[0])), { code: "ENOENT" });
  assert.equal(await readFile(source, "utf8"), "synthetic database");
});

const fakeKeychain = (script: string, pids: number[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* readSafeStoragePassword.pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          assert.equal(command._tag, "StandardCommand");
          return spawner
            .spawn(
              ChildProcess.make(
                process.execPath,
                ["-e", script],
                command._tag === "StandardCommand" ? command.options : {},
              ),
            )
            .pipe(
              Effect.tap((handle) =>
                Effect.sync(() => {
                  pids.push(handle.pid);
                }),
              ),
            );
        }),
      ),
    );
  });

await test("Keychain failure does not expose captured output", async () => {
  await assert.rejects(
    Effect.runPromise(
      fakeKeychain(
        'process.stdout.write("synthetic-secret"); process.exitCode = 1',
        [],
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
    (error: Error) => {
      assert.match(error.message, /Keychain access failed/u);
      assert.doesNotMatch(String(error), /synthetic-secret/u);
      return true;
    },
  );
});

await test("cancelling a blocked Keychain lookup terminates the child even when it ignores SIGTERM", async () => {
  const pids: number[] = [];
  await assert.rejects(
    Effect.runPromise(
      fakeKeychain(
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
        pids,
      ).pipe(Effect.timeout("500 millis"), Effect.provide(NodeServices.layer)),
    ),
    /Timeout/u,
  );
  assert.equal(pids.length, 1);
  assert.throws(() => process.kill(pids[0], 0), { code: "ESRCH" });
});
