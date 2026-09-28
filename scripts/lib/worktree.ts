import { Data, Effect } from "effect";
import path from "node:path";

import { runCommand } from "./command.ts";

/**
 * A checkout of this repository is either the main checkout, whose `.git` is
 * the repository, or a linked worktree (`git worktree add`, which is what
 * `herdr worktree create` runs), whose `.git` is a file pointing into the main
 * checkout's `.git/worktrees/`. Each checkout has its own branch, its own
 * `PORT` and dev store in `.env`, and its own `.wrangler` state, so each runs
 * its own dev server. Every one of those names derives from the checkout's
 * index ({@link worktreeName}, {@link worktreeEnv}).
 *
 * `refs/` exists once, in the main checkout; a linked worktree has a symlink
 * named `refs` pointing at it. `.gitignore` lists `refs` without a trailing
 * slash so the one rule ignores both the directory and the symlink.
 */

export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly message: string;
}> {}

/** The `.env` keys that belong to one checkout and must differ between checkouts. */
export interface WorktreeEnv {
  readonly PORT: string;
  readonly BETTER_AUTH_URL: string;
  readonly SHOPIFY_DEV_STORE: string;
}

const WORKTREE_KEYS = ["PORT", "BETTER_AUTH_URL", "SHOPIFY_DEV_STORE"] as const;

/**
 * A checkout's index: the main checkout is 0, linked worktrees count from 1.
 * One number names everything a checkout must not share, so nothing is paired
 * up by hand: branch, folder and Herdr workspace `wt-NN` (the main checkout
 * keeps `main`), port `3800 + index`, dev store `sandbox-shop-NN`. The stores
 * are a pool shared across projects: every project's worktree `NN` uses
 * `sandbox-shop-NN`, which is safe because each project is its own app there.
 */
export const MAX_INDEX = 99;
const BASE_PORT = 3800;

const pad = (index: number) => String(index).padStart(2, "0");

/** A linked worktree's branch, folder and Herdr workspace label: `wt-01` for index 1. */
export const worktreeName = (index: number) => `wt-${pad(index)}`;

/** A checkout's `.env` values by index; `BETTER_AUTH_URL` follows `PORT` because magic links are minted from it. */
export const worktreeEnv = (index: number): WorktreeEnv => {
  const port = String(BASE_PORT + index);
  return {
    PORT: port,
    BETTER_AUTH_URL: `http://localhost:${port}`,
    SHOPIFY_DEV_STORE: `sandbox-shop-${pad(index)}`,
  };
};

const KEY_LINE = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u;

/** The `KEY=value` lines of a `.env`; comments and blank lines are skipped. */
export const parseEnv = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text
      .split("\n")
      .map((line) => KEY_LINE.exec(line)?.groups)
      .flatMap((groups) =>
        groups?.key === undefined || groups.value === undefined
          ? []
          : [[groups.key, groups.value] as const],
      ),
  );

/**
 * Sets each key in a `.env`'s text: an existing `KEY=` line is replaced in
 * place, a missing key is appended. Every other line, comments included, is
 * kept as it was.
 */
export const setEnvKeys = (text: string, values: WorktreeEnv): string => {
  const lines = text.split("\n").map((line) => {
    const key = WORKTREE_KEYS.find(
      (name) => name === KEY_LINE.exec(line)?.groups?.key,
    );
    return key === undefined ? line : `${key}=${values[key]}`;
  });
  const present = parseEnv(text);
  const missing = WORKTREE_KEYS.filter((key) => !present.has(key)).map(
    (key) => `${key}=${values[key]}`,
  );
  const body = lines.join("\n").replace(/\n*$/u, "");
  return `${[body, ...missing].join("\n")}\n`;
};

/**
 * A `.env` that exists is verified, never rewritten: each of these keys must
 * already hold the expected value. Returns one line per disagreement.
 */
export const envDisagreements = (
  text: string,
  expected: WorktreeEnv,
): readonly string[] => {
  const env = parseEnv(text);
  return WORKTREE_KEYS.flatMap((key) => {
    const have = env.get(key);
    return have === expected[key]
      ? []
      : [`${key} is ${have ?? "missing"}, expected ${expected[key]}`];
  });
};

/**
 * A port or dev store belongs to one checkout: two dev servers cannot listen
 * on one port, and two `shopify app dev` sessions on one store overwrite each
 * other's preview. Returns one line per value another checkout's `.env`
 * already holds.
 */
export const claimConflicts = (
  others: readonly { readonly checkout: string; readonly env: string }[],
  expected: WorktreeEnv,
): readonly string[] =>
  others.flatMap(({ checkout, env }) => {
    const values = parseEnv(env);
    return (["PORT", "SHOPIFY_DEV_STORE"] as const).flatMap((key) =>
      values.get(key) === expected[key]
        ? [`${key}=${expected[key]} is already used by ${checkout}`]
        : [],
    );
  });

/** This checkout's git directory and the repository's common one, both absolute. */
const gitDirs = runCommand("git", [
  "rev-parse",
  "--path-format=absolute",
  "--git-dir",
  "--git-common-dir",
]).pipe(
  Effect.map((output) => {
    const [gitDir = "", commonDir = ""] = output.trim().split("\n");
    return { gitDir, commonDir };
  }),
);

/**
 * Where this checkout sits: `mainCheckout` is the main checkout's root, which
 * is the parent of the common git directory in a non-bare repository, and
 * `linked` is true in a linked worktree, whose git directory differs from the
 * common one.
 */
export const checkoutKind = gitDirs.pipe(
  Effect.map(({ gitDir, commonDir }) => ({
    linked: gitDir !== commonDir,
    mainCheckout: path.dirname(commonDir),
  })),
);

/** The branch checked out here; empty on a detached HEAD. */
export const currentBranch = runCommand("git", [
  "branch",
  "--show-current",
]).pipe(Effect.map((output) => output.trim()));

/** Every checkout of the repository, main first, as absolute paths. */
export const checkoutPaths = runCommand("git", [
  "worktree",
  "list",
  "--porcelain",
]).pipe(
  Effect.map((output) =>
    output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length)),
  ),
);
