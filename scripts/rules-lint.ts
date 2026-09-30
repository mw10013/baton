/**
 * Holds the line drawn in `src/lib/Domain.ts`: state, status, flag and role rules
 * are `Domain` predicates, never inline comparisons in routes, components or
 * the object. A site that needs `run.state === "done"` needs a predicate
 * that says what "done" means to it (`runIsOpen`, `runIsDone`,
 * `runIsUnstarted`), and a site that needs `user.role === "admin"` needs
 * `userIsAdmin`. `Domain.ts` and the context files under `src/lib/domain/`
 * it re-exports are the only files allowed to spell the literals.
 *
 * It also holds the vocabulary's two identifier rules on the exports under
 * `src/lib/`: no reserved stem ({@link reservedStemHits}) and no `is<State>`
 * without its noun ({@link bareStatePredicateHits}); and the map's import
 * direction ({@link contextImportHits}), the object map's
 * ({@link objectImportHits}), and the loader-data rule
 * ({@link loaderDataExportHits}) on every file under `src/`; and, in the
 * context files, the shapes' one-way dependency
 * ({@link modelShapeReferenceHits}).
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
  contextImportHits,
  contextImports,
  INLINE_COMPARISONS,
  loaderDataExportHits,
  modelShapeReferenceHits,
  objectImportHits,
  RESERVED_STEMS,
  reservedStemHits,
  retiredCopyHits,
  shapeSuffixes,
  textAreaPlaceholderHits,
} from "./lib/rules-lint.ts";

const ROOT = new URL("../src/", import.meta.url).pathname;
const ALLOWED = new Set(["lib/Domain.ts", "routeTree.gen.ts"]);
const ALLOWED_DIR = "lib/domain/";

const hits = walk(ROOT).flatMap((path) => {
  const file = relative(ROOT, path);
  if (ALLOWED.has(file) || file.startsWith(ALLOWED_DIR)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) =>
      INLINE_COMPARISONS.some((pattern) => pattern.test(line))
        ? [`src/${file}:${String(index + 1)}: ${line.trim()}`]
        : [],
    );
});

if (hits.length > 0) {
  console.error(
    "rules-lint: inline status/state/flag/role comparison outside src/lib/Domain.ts and src/lib/domain/; use a Domain predicate:",
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

const BARREL = readFileSync(join(ROOT, "lib", "Domain.ts"), "utf8");
const CONTEXT_MAP = contextImports(BARREL);

const importHits = walk(ROOT).flatMap((path) => {
  const file = relative(ROOT, path);
  return contextImportHits(file, readFileSync(path, "utf8"), CONTEXT_MAP).map(
    ({ line, specifier, allowed }) =>
      allowed === undefined
        ? `rules-lint: src/${file}:${String(line)} imports a context file directly (${specifier}); import @/lib/Domain`
        : `rules-lint: src/${file}:${String(line)} imports ${specifier}; the map in src/lib/Domain.ts allows ${allowed.length === 0 ? "nothing" : allowed.join(", ")}`,
  );
});

for (const hit of importHits) console.error(hit);

const objectHits = walk(ROOT).flatMap((path) => {
  const file = relative(ROOT, path);
  return objectImportHits(file, readFileSync(path, "utf8")).map(
    ({ line, specifier, allowed }) =>
      allowed === undefined
        ? `rules-lint: src/${file}:${String(line)} imports an object module (${specifier}); only src/lib/ShopAgent.ts may`
        : `rules-lint: src/${file}:${String(line)} imports ${specifier}; the object map on ShopAgentHost allows ${allowed.length === 0 ? "nothing" : allowed.join(", ")}`,
  );
});

for (const hit of objectHits) console.error(hit);

const loaderDataHits = walk(ROOT).flatMap((path) => {
  const file = relative(ROOT, path);
  return loaderDataExportHits(file, readFileSync(path, "utf8")).map(
    ({ name }) =>
      `rules-lint: src/${file} exports ${name}; loader data lives in its route (the rule on ShopAgentClient)`,
  );
});

for (const hit of loaderDataHits) console.error(hit);

const SUFFIXES = shapeSuffixes(BARREL);

const shapeHits = walk(join(ROOT, "lib", "domain")).flatMap((path) => {
  const file = relative(ROOT, path);
  return modelShapeReferenceHits(readFileSync(path, "utf8"), SUFFIXES).map(
    ({ name, line, shape }) =>
      `rules-lint: src/${file}:${String(line)} ${name} references ${shape}; a model symbol never references a shape (the rule on modelShapeReferenceHits)`,
  );
});

for (const hit of shapeHits) console.error(hit);

if (
  importHits.length > 0 ||
  objectHits.length > 0 ||
  loaderDataHits.length > 0 ||
  shapeHits.length > 0 ||
  hits.length > 0 ||
  copyHits.length > 0 ||
  placeholderHits.length > 0 ||
  stemHits.length > 0 ||
  predicateHits.length > 0
)
  process.exit(1);
