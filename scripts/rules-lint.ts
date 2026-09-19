/**
 * Holds the line drawn in `src/lib/Domain.ts`: status, flag and role rules
 * are `Domain` predicates, never inline comparisons in routes, components or
 * the object. A site that needs `run.status === "done"` needs a predicate
 * that says what "done" means to it (`runIsOpen`, `runIsLive`,
 * `runIsUnstarted`), and a site that needs `user.role === "admin"` needs
 * `userIsAdmin`. `Domain.ts` is the one file allowed to spell the literals.
 *
 * A grep, not an oxlint rule: the pattern is three tokens and has stayed
 * quiet. Union narrowing on `actor.role` and the connection state's `role`
 * is not matched, because those are discriminants of a union, not rules.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
  process.exit(1);
}
