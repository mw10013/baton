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
 * ({@link modelShapeReferenceHits}); and, in the object, nothing that keeps
 * it from hibernating ({@link hibernationBlockerHits}); and, in a route or a
 * component outside `src/components/screen/`, no layout ({@link layoutHits});
 * and, on the merchant's and member's screens, the controls table's four
 * syntactic rules: no info banner ({@link infoBannerHits}), no `maxLength`
 * on a field outside `src/components/screen/` ({@link maxLengthHits}), no
 * parenthesis in an option ({@link optionAnnotationHits}), and no `details`
 * slot outside `src/components/screen/` ({@link detailsSlotHits}); and,
 * under `e2e/`, no control located by its host tag
 * ({@link hostTagLocatorHits}).
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
  detailsSlotHits,
  hibernationBlockerHits,
  infoBannerHits,
  INLINE_COMPARISONS,
  loaderDataExportHits,
  maxLengthHits,
  modelShapeReferenceHits,
  objectImportHits,
  optionAnnotationHits,
  RESERVED_STEMS,
  reservedStemHits,
  retiredCopyHits,
  layoutHits,
  hostTagLocatorHits,
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

const tagHitsIn = (
  files: readonly string[],
  read: (
    source: string,
  ) => readonly { readonly line: number; readonly text: string }[],
) =>
  files.flatMap((path) => {
    const file = relative(ROOT, path);
    return read(readFileSync(path, "utf8")).map(
      ({ line, text }) => `src/${file}:${String(line)}: ${text}`,
    );
  });

const infoHits = tagHitsIn(COPY_FILES, infoBannerHits);
if (infoHits.length > 0) {
  console.error(
    "rules-lint: info banner on a merchant or member screen; an info fact is a line or a badge (the controls table on Control):",
  );
  for (const hit of infoHits) console.error(`  ${hit}`);
}

const fieldHits = tagHitsIn(
  COPY_FILES.filter((path) => !path.includes("/components/screen/")),
  maxLengthHits,
);
if (fieldHits.length > 0) {
  console.error(
    "rules-lint: maxLength on a field outside src/components/screen/; a text limit counts down near the cap and refuses on submit (the controls table on Control):",
  );
  for (const hit of fieldHits) console.error(`  ${hit}`);
}

const optionHits = tagHitsIn(COPY_FILES, optionAnnotationHits);
if (optionHits.length > 0) {
  console.error(
    "rules-lint: a parenthesis in an s-option; a select is a list of names (the controls table on Control):",
  );
  for (const hit of optionHits) console.error(`  ${hit}`);
}

const slotHits = tagHitsIn(
  COPY_FILES.filter((path) => !path.includes("/components/screen/")),
  detailsSlotHits,
);
if (slotHits.length > 0) {
  console.error(
    "rules-lint: a details slot outside src/components/screen/; a choice among records shows the record's name (the controls table on Control):",
  );
  for (const hit of slotHits) console.error(`  ${hit}`);
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

const hibernationHits = walk(ROOT).flatMap((path) => {
  const file = relative(ROOT, path);
  return hibernationBlockerHits(file, readFileSync(path, "utf8")).map(
    ({ line, call }) =>
      `rules-lint: src/${file}:${String(line)} calls ${call}; a pending timer or a standard-API socket keeps the object from hibernating, which charges duration and costs the list memo its one computation per push (the rule on hibernationBlockerHits)`,
  );
});

for (const hit of hibernationHits) console.error(hit);

const layoutViolations = [
  ...walk(join(ROOT, "routes")),
  ...walk(join(ROOT, "components")).filter(
    (path) => !relative(ROOT, path).startsWith("components/screen/"),
  ),
]
  .filter((path) => path.endsWith(".tsx"))
  .flatMap((path) =>
    layoutHits(readFileSync(path, "utf8")).map(
      ({ line, text }) =>
        `rules-lint: src/${relative(ROOT, path)}:${String(line)} ${text}; only src/components/screen/ lays out, routes and components compose its parts (the rule on layoutHits)`,
    ),
  );

for (const hit of layoutViolations) console.error(hit);

const E2E = new URL("../e2e/", import.meta.url).pathname;

const hostTagHits = walk(E2E)
  .filter((path) => path.endsWith(".ts"))
  .flatMap((path) =>
    hostTagLocatorHits(readFileSync(path, "utf8")).map(
      ({ line, text }) =>
        `rules-lint: e2e/${relative(E2E, path)}:${String(line)} ${text}; locate a control by role, never by its host tag (e2e/member.ts)`,
    ),
  );

for (const hit of hostTagHits) console.error(hit);

if (
  hostTagHits.length > 0 ||
  layoutViolations.length > 0 ||
  hibernationHits.length > 0 ||
  importHits.length > 0 ||
  objectHits.length > 0 ||
  loaderDataHits.length > 0 ||
  shapeHits.length > 0 ||
  hits.length > 0 ||
  copyHits.length > 0 ||
  placeholderHits.length > 0 ||
  infoHits.length > 0 ||
  fieldHits.length > 0 ||
  optionHits.length > 0 ||
  slotHits.length > 0 ||
  stemHits.length > 0 ||
  predicateHits.length > 0
)
  process.exit(1);
