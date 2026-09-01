#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Data, Effect, FileSystem } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { execSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

class AuthRefreshError extends Data.TaggedError("AuthRefreshError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const SHOPIFY_HOSTS = [
  ".shopify.com",
  "admin.shopify.com",
  "accounts.shopify.com",
] as const;

const sameSiteMap: Record<string, string> = {
  "-1": "Lax",
  "0": "None",
  "1": "Lax",
  "2": "Strict",
};
const chromeEpochOffset = 11_644_473_600n;

interface CookieRow {
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  host_key: string;
  path: string;
  is_secure: bigint;
  is_httponly: bigint;
  samesite: bigint;
  expires_utc: bigint;
  has_expires: bigint;
}

const ensureMacOS =
  process.platform === "darwin"
    ? Effect.void
    : Effect.fail(
        new AuthRefreshError({
          message: `Unsupported platform: ${process.platform} (macOS only)`,
        }),
      );

const readSafeStoragePassword = Effect.try({
  try: () =>
    execSync('security find-generic-password -w -s "Chrome Safe Storage"', {
      encoding: "utf8",
    }).trim(),
  catch: (cause) =>
    new AuthRefreshError({
      message:
        "Failed to read 'Chrome Safe Storage' from Keychain (click Allow if prompted)",
      cause,
    }),
});

const makeDecrypt = (key: Buffer) => {
  const iv = Buffer.alloc(16, 0x20);
  return (enc: Uint8Array) => {
    const buf = Buffer.from(enc);
    if (buf.length < 3 || buf.subarray(0, 3).toString() !== "v10")
      return buf.toString("utf8");
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])
      .subarray(32)
      .toString("utf8");
  };
};

const copyCookieDatabase = (cookiesPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpPath = path.join(
      tmpdir(),
      `chrome-cookies-${Date.now().toString()}.db`,
    );
    yield* fs.copyFile(cookiesPath, tmpPath).pipe(
      Effect.mapError(
        (cause) =>
          new AuthRefreshError({
            message: `Failed to copy Chrome cookie database: ${cookiesPath}`,
            cause,
          }),
      ),
    );
    const walSrc = `${cookiesPath}-wal`;
    if (yield* fs.exists(walSrc).pipe(Effect.orElseSucceed(() => false)))
      yield* fs.copyFile(walSrc, `${tmpPath}-wal`).pipe(
        Effect.mapError(
          (cause) =>
            new AuthRefreshError({
              message: `Failed to copy Chrome cookie WAL: ${walSrc}`,
              cause,
            }),
        ),
      );
    return tmpPath;
  });

const readShopifyCookies = (
  dbPath: string,
  decrypt: (enc: Uint8Array) => string,
) =>
  Effect.try({
    try: () => {
      const db = new DatabaseSync(dbPath);
      const stmt = db.prepare(
        `select name, value, encrypted_value, host_key, path, is_secure, is_httponly, samesite, expires_utc, has_expires
         from cookies
         where host_key in (${SHOPIFY_HOSTS.map((h) => `'${h}'`).join(", ")})`,
      );
      stmt.setReadBigInts(true);
      const rows = stmt.all() as unknown as CookieRow[];
      db.close();
      return rows.map(
        ({
          name,
          value,
          encrypted_value,
          host_key,
          path: p,
          is_secure,
          is_httponly,
          samesite,
          expires_utc,
          has_expires,
        }) => ({
          name,
          value: encrypted_value.length > 0 ? decrypt(encrypted_value) : value,
          domain: host_key,
          path: p,
          secure: is_secure === 1n,
          httpOnly: is_httponly === 1n,
          sameSite: sameSiteMap[samesite.toString()] ?? "Lax",
          expires:
            has_expires === 1n
              ? Number(expires_utc / 1_000_000n - chromeEpochOffset)
              : -1,
        }),
      );
    },
    catch: (cause) =>
      new AuthRefreshError({
        message: "Failed to read cookies from Chrome database",
        cause,
      }),
  });

const command = Command.make(
  "refresh-shopify-playwright-auth",
  {
    output: Flag.string("output").pipe(
      Flag.withDescription("Playwright storage-state output path"),
      Flag.withDefault("playwright/.auth/shopify-admin.json"),
    ),
    profile: Flag.string("profile").pipe(
      Flag.withDescription("Chrome profile directory name"),
      Flag.withDefault("Default"),
    ),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Count cookies without writing the output file"),
    ),
  },
  Effect.fnUntraced(function* ({ output, profile, dryRun }) {
    yield* ensureMacOS;
    const cookiesPath = path.join(
      process.env.HOME ?? "",
      "Library/Application Support/Google/Chrome",
      profile,
      "Cookies",
    );
    const decrypt = makeDecrypt(
      pbkdf2Sync(yield* readSafeStoragePassword, "saltysalt", 1003, 16, "sha1"),
    );
    const cookies = yield* readShopifyCookies(
      yield* copyCookieDatabase(cookiesPath),
      decrypt,
    );
    if (dryRun) {
      yield* Console.log(
        `dry-run: ${cookies.length.toString()} Shopify cookie(s) found; not writing ${output}`,
      );
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(path.dirname(output), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AuthRefreshError({
            message: `Failed to create output directory: ${path.dirname(output)}`,
            cause,
          }),
      ),
    );
    yield* fs
      .writeFileString(
        output,
        JSON.stringify({ cookies, origins: [] }, null, 2),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthRefreshError({
              message: `Failed to write storage state: ${output}`,
              cause,
            }),
        ),
      );
    yield* Console.log(
      `Wrote ${cookies.length.toString()} cookies to ${output}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Export the logged-in Shopify session from Chrome's cookie database into Playwright storage state (playwright/.auth/shopify-admin.json), so e2e tests skip the captcha-locked admin login. macOS only; prompts for Keychain access.",
  ),
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(command);
