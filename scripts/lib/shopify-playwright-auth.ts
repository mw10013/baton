import { Data, Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { homedir } from "node:os";
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
  creation_utc: bigint;
}

const ensureMacOS =
  process.platform === "darwin"
    ? Effect.void
    : Effect.fail(
        new AuthRefreshError({
          message: `Unsupported platform: ${process.platform} (macOS only)`,
        }),
      );

/**
 * Keep Keychain output inside the effect: errors must never carry a captured
 * password into logs. Scope interruption terminates the process, escalating to
 * SIGKILL if it does not exit after SIGTERM.
 */
export const readSafeStoragePassword = Effect.gen(function* () {
  const handle = yield* ChildProcess.make(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage"],
    { stdin: "ignore", stderr: "ignore", forceKillAfter: "2 seconds" },
  );
  const [password, code] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
    { concurrency: "unbounded" },
  );
  if (code !== ChildProcessSpawner.ExitCode(0) || !password.trim())
    return yield* new AuthRefreshError({
      message:
        "Keychain access failed: unlock your login keychain and allow access to Chrome Safe Storage, then retry.",
    });
  return password.trim();
}).pipe(
  Effect.scoped,
  Effect.timeout("120 seconds"),
  Effect.catchTag("TimeoutError", () =>
    Effect.fail(
      new AuthRefreshError({
        message:
          "Keychain access timed out after 120 seconds. Respond to the Chrome Safe Storage prompt, then retry.",
      }),
    ),
  ),
  Effect.mapError((error) =>
    error instanceof AuthRefreshError
      ? error
      : new AuthRefreshError({
          message: "Could not run the Chrome Safe Storage Keychain lookup.",
        }),
  ),
);

export const chromeProfile = () =>
  process.env.SHOPIFY_CHROME_PROFILE ?? "Default";

/**
 * How long an exported admin session is trusted before the setup re-reads
 * Chrome. `_merchant_essential` is issued with a one-year expiry and replaced
 * on every admin load, so its expiry says nothing about whether the session
 * behind it is still accepted; its age does. A day matches the lifetime the
 * old `koa.sid` carried, which is the only figure Shopify has ever shown.
 */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * A local freshness check, not proof that Shopify accepts a session.
 *
 * Two cookies count, because Shopify changed which one carries the admin
 * session. Until September 2026 it was `koa.sid` on `admin.shopify.com`, a
 * 24-hour cookie whose expiry was the check. Since then an admin load sets no
 * cookie on that host at all and re-issues `_merchant_essential` on
 * `.shopify.com` instead, so that cookie is the signal now, judged by
 * `issuedAt` — when Chrome created it, or when the export was written — rather
 * than by its expiry.
 */
export const adminSessionFresh = (
  cookies: readonly {
    readonly name: string;
    readonly domain: string;
    readonly expires: number;
  }[],
  issuedAt: number,
) =>
  cookies.some(
    (cookie) =>
      (cookie.name === "koa.sid" &&
        cookie.domain === "admin.shopify.com" &&
        (cookie.expires === -1 ||
          cookie.expires * 1000 > Date.now() + 5 * 60_000)) ||
      (cookie.name === "_merchant_essential" &&
        cookie.domain === ".shopify.com" &&
        issuedAt > Date.now() - SESSION_MAX_AGE_MS),
  );

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

export const copyCookieDatabase = (cookiesPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "baton-chrome-cookies-",
    });
    yield* fs.chmod(directory, 0o700);
    const tmpPath = path.join(directory, "Cookies");
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
      try {
        const stmt = db.prepare(
          `select name, value, encrypted_value, host_key, path, is_secure, is_httponly, samesite, expires_utc, has_expires, creation_utc
         from cookies
         where host_key in (${SHOPIFY_HOSTS.map(() => "?").join(", ")})`,
        );
        stmt.setReadBigInts(true);
        const rows = stmt.all(...SHOPIFY_HOSTS) as unknown as CookieRow[];
        // When Chrome last created the session cookie: the admin re-issues it
        // on every load, so this is when the admin was last open in Chrome.
        const issuedAt = rows
          .filter((row) => row.name === "_merchant_essential")
          .reduce(
            (latest, row) =>
              Math.max(
                latest,
                Number(row.creation_utc / 1000n) -
                  Number(chromeEpochOffset) * 1000,
              ),
            0,
          );
        const cookies = rows.map(
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
            value:
              encrypted_value.length > 0 ? decrypt(encrypted_value) : value,
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
        return { cookies, issuedAt };
      } finally {
        db.close();
      }
    },
    catch: (cause) =>
      new AuthRefreshError({
        message: "Failed to read cookies from Chrome database",
        cause,
      }),
  });

/**
 * Stage on the destination filesystem so rename atomically replaces the state.
 * A failed write leaves the previous export intact; scoped cleanup removes only
 * this invocation's staging directory, including on interruption.
 */
export const writeStorageState = (
  output: string,
  cookies: Effect.Success<ReturnType<typeof readShopifyCookies>>["cookies"],
  issuedAt: number,
) =>
  Effect.gen(function* () {
    if (!adminSessionFresh(cookies, issuedAt))
      yield* new AuthRefreshError({
        message:
          "Chrome's Shopify admin session is expired or missing. Open the store's admin at https://admin.shopify.com in a normal window of the selected Chrome profile, wait for the dashboard to load, then retry. The previous export was kept.",
      });
    const fs = yield* FileSystem.FileSystem;
    const parent = path.dirname(output);
    yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: parent,
      prefix: ".shopify-auth-",
    });
    yield* fs.chmod(directory, 0o700);
    const staged = path.join(directory, "state.json");
    yield* fs.writeFileString(
      staged,
      JSON.stringify({ cookies, origins: [] }, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    yield* fs.rename(staged, output);
  }).pipe(Effect.scoped);

export const refreshShopifyAuth = ({
  output,
  profile,
  dryRun = false,
}: {
  readonly output: string;
  readonly profile: string;
  readonly dryRun?: boolean;
}) =>
  Effect.gen(function* () {
    yield* ensureMacOS;
    if (
      !profile ||
      profile === "." ||
      profile === ".." ||
      /[\\/]/u.test(profile)
    )
      return yield* new AuthRefreshError({
        message:
          "Chrome profile must be a directory name such as Default or Profile 1.",
      });
    const cookiesPath = path.join(
      homedir(),
      "Library/Application Support/Google/Chrome",
      profile,
      "Cookies",
    );
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(cookiesPath)))
      return yield* new AuthRefreshError({
        message: `Chrome cookie database not found for profile ${profile}: ${cookiesPath}`,
      });
    const decrypt = makeDecrypt(
      pbkdf2Sync(yield* readSafeStoragePassword, "saltysalt", 1003, 16, "sha1"),
    );
    const { cookies, issuedAt } = yield* readShopifyCookies(
      yield* copyCookieDatabase(cookiesPath),
      decrypt,
    );
    if (!dryRun) yield* writeStorageState(output, cookies, issuedAt);
    return cookies.length;
  }).pipe(
    Effect.scoped,
    Effect.timeout("150 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new AuthRefreshError({
          message:
            "Shopify auth refresh timed out after 150 seconds; retry after checking Chrome and Keychain access.",
        }),
      ),
    ),
  );
