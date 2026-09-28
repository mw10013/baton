/**
 * Holds the line drawn in `src/lib/Domain.ts`: status, flag and role rules
 * are `Domain` predicates, never inline comparisons in routes, components or
 * the object. A site that needs `run.status === "done"` needs a predicate
 * that says what "done" means to it (`runIsOpen`, `runIsDone`,
 * `runIsUnstarted`), and a site that needs `user.role === "admin"` needs
 * `userIsAdmin`. `Domain.ts` is the one file allowed to spell the literals.
 *
 * A grep, not an oxlint rule: the pattern is three tokens and has stayed
 * quiet. Union narrowing on `actor.role` and the connection state's `role`
 * is not matched, because those are discriminants of a union, not rules.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { retiredCopyHits } from "./lib/rules-lint.ts";

const ROOT = new URL("../src/", import.meta.url).pathname;
const ALLOWED = new Set(["lib/Domain.ts", "routeTree.gen.ts"]);
const PATTERNS: readonly RegExp[] = [
  /\.(?:status|flag) (?:===|!==) "/u,
  /\.role (?:===|!==) "admin"/u,
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });

const hits = walk(ROOT).flatMap((path) => {
  const file = relative(ROOT, path);
  if (ALLOWED.has(file)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) =>
      PATTERNS.some((pattern) => pattern.test(line))
        ? [`src/${file}:${String(index + 1)}: ${line.trim()}`]
        : [],
    );
});

if (hits.length > 0) {
  console.error(
    "rules-lint: inline status/flag/role comparison outside src/lib/Domain.ts; use a Domain predicate:",
  );
  for (const hit of hits) console.error(`  ${hit}`);
}

/**
 * The glossary's screen rule: `scripts/lib/rules-lint.ts` says which words
 * are retired and how a line's copy is read. The screens are the merchant's
 * and the member's: `src/components/`, the routes that render them, and the
 * modules that hold their copy. The operator console (`admin.*`), the API
 * routes (`api.*`), and the public home and privacy pages (`index.tsx`,
 * `privacy.tsx`) are not glossary screens and are left out.
 */
const COPY_FILES = [
  ...walk(join(ROOT, "routes")).filter(
    (path) =>
      !/\/routes\/(?:admin\.|api\.|index\.tsx$|privacy\.tsx$)/u.test(path) &&
      !path.endsWith("routeTree.gen.ts"),
  ),
  ...walk(join(ROOT, "components")),
  ...[
    "useMemberRunActions.ts",
    "changeWarning.ts",
    "workflowShared.ts",
    "workflowsListViews.ts",
  ].map((name) => join(ROOT, "lib", name)),
];

const copyHits = COPY_FILES.flatMap((path) => {
  const file = relative(ROOT, path);
  return retiredCopyHits(readFileSync(path, "utf8"), path.endsWith(".tsx")).map(
    ({ line, text }) => `src/${file}:${String(line)}: ${text}`,
  );
});

if (copyHits.length > 0) {
  console.error(
    "rules-lint: retired word in screen copy; use the glossary word:",
  );
  for (const hit of copyHits) console.error(`  ${hit}`);
}

if (hits.length > 0 || copyHits.length > 0) process.exit(1);
