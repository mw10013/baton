/**
 * Holds the line drawn in `src/lib/Domain.ts`: status, flag and role rules
 * are `Domain` predicates, never inline comparisons in routes, components or
 * the object. A site that needs `run.status === "done"` needs a predicate
 * that says what "done" means to it (`runIsOpen`, `runIsDone`,
 * `runIsUnstarted`), and a site that needs `user.role === "admin"` needs
 * `userIsAdmin`. `Domain.ts` is the one file allowed to spell the literals.
 *
 * It also holds the vocabulary's two identifier rules on the exports under
 * `src/lib/`: no reserved stem ({@link reservedStemHits}) and no `is<State>`
 * without its noun ({@link bareStatePredicateHits}).
 *
 * A grep, not an oxlint rule: the pattern is three tokens and has stayed
 * quiet. Union narrowing on `actor.role` and the connection state's `role`
 * is not matched, because those are discriminants of a union, not rules.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { copyFiles, walk } from "./lib/copy-files.ts";
import {
  bareStatePredicateHits,
  RESERVED_STEMS,
  reservedStemHits,
  retiredCopyHits,
  textAreaPlaceholderHits,
} from "./lib/rules-lint.ts";

const ROOT = new URL("../src/", import.meta.url).pathname;
const ALLOWED = new Set(["lib/Domain.ts", "routeTree.gen.ts"]);
const PATTERNS: readonly RegExp[] = [
  /\.(?:status|flag) (?:===|!==) "/u,
  /\.role (?:===|!==) "admin"/u,
];

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

const COPY_FILES = copyFiles();

const copyHits = COPY_FILES.flatMap((path) => {
  const file = relative(ROOT, path);
  return retiredCopyHits(readFileSync(path, "utf8"), path.endsWith(".tsx")).map(
    ({ line, text }) => `src/${file}:${String(line)}: ${text}`,
  );
});

if (copyHits.length > 0) {
  console.error(
    "rules-lint: retired word in screen copy; use the vocabulary word:",
  );
  for (const hit of copyHits) console.error(`  ${hit}`);
}

const placeholderHits = COPY_FILES.flatMap((path) => {
  const file = relative(ROOT, path);
  return textAreaPlaceholderHits(readFileSync(path, "utf8")).map(
    ({ line, text }) => `src/${file}:${String(line)}: ${text}`,
  );
});

if (placeholderHits.length > 0) {
  console.error(
    "rules-lint: placeholder on an s-text-area; free text has a label and no placeholder:",
  );
  for (const hit of placeholderHits) console.error(`  ${hit}`);
}

const LIB_FILES = walk(join(ROOT, "lib"));

const identifierHits = (
  check: (source: string) => readonly { name: string; line: number }[],
) =>
  LIB_FILES.flatMap((path) =>
    check(readFileSync(path, "utf8")).map(
      ({ name, line }) =>
        `src/${relative(ROOT, path)}:${String(line)}: ${name}`,
    ),
  );

const stemHits = identifierHits(reservedStemHits);

if (stemHits.length > 0) {
  console.error(
    `rules-lint: reserved stem (${RESERVED_STEMS.join(", ")}) in an exported identifier; use the vocabulary word:`,
  );
  for (const hit of stemHits) console.error(`  ${hit}`);
}

const predicateHits = identifierHits(bareStatePredicateHits);

if (predicateHits.length > 0) {
  console.error(
    "rules-lint: exported predicate named is<State> with no noun; name it <noun>Is<State>:",
  );
  for (const hit of predicateHits) console.error(`  ${hit}`);
}

if (
  hits.length > 0 ||
  copyHits.length > 0 ||
  placeholderHits.length > 0 ||
  stemHits.length > 0 ||
  predicateHits.length > 0
)
  process.exit(1);
