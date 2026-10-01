/**
 * The copy half of `scripts/rules-lint.ts`, pure so the test can run it on
 * inline sources inside workerd (no `node:fs`), the way
 * `scripts/lib/spec.ts` is split from its command.
 *
 * The vocabulary's screen rule (`src/lib/Domain.ts`), for the copy its label
 * constants cannot reach (toasts, error sentences, empty states): the words
 * it retired stay off every merchant and member screen.
 *
 * | pattern                   | why                                                                |
 * | ------------------------- | ------------------------------------------------------------------ |
 * | run, runs, workflow run   | no screen says run: the item and its workflow, or the work         |
 * | line item                 | the screen word is item                                            |
 * | mark done, marked done    | the verb's label is Done                                           |
 * | finish, finished          | done (a task), or done or closed (a run)                           |
 * | in progress               | the run's label, read from `Domain.RUN_STATE_LABEL`                |
 * | unclaimed                 | no such state; a task waits for a member                           |
 * | tab, tabs                 | a list's button is a view (`Domain.WorkflowsListView`)             |
 * | staff, staffed, unstaffed | a team's people are members; Shopify's staff are the merchant side |
 * | attention                 | an issue is named by its fault: unassigned, empty team, blocked    |
 * | billing period            | the screen word is billing cycle (`Domain.ShopUsage`)              |
 * | import, imports, importing | the word is sync: Baton's copy agreeing with Shopify; import is Shopify's word for `orderCreate` |
 * | resync                    | the word is sync at one-order scope; the button is Sync from Shopify |
 *
 * And the copy words that are wrong in every slot, whatever the noun: copy
 * states facts and names the act, so it never pleads, apologises, exclaims
 * over a routine write, or points at a link with "here" (Shopify's own
 * guidance, `refs/shopify-docs/docs/apps/design/content/voice-and-tone.md`,
 * "Acknowledging effort, progress, or completion" and "Simple errors"):
 *
 * | pattern      | why                                                                    |
 * | ------------ | ---------------------------------------------------------------------- |
 * | please       | a field's label or error says what to do; nobody is asked              |
 * | successfully | a toast says the verb ("Note saved"); a routine write is not a success |
 * | oops, sorry  | an error says what was refused and the fix, not a feeling              |
 * | click here   | a link's text is the screen it goes to                                 |
 * | are you sure | a modal that asks names the thing in its heading and says the consequence in its body (`Screen.ts`) |
 *
 * A placeholder on an `s-text-area` is refused outright
 * ({@link textAreaPlaceholderHits}): free text has a label that says what
 * goes in, so the only placeholder possible is a question or an instruction,
 * and both are filler. A placeholder on an `s-text-field` shows the shape of
 * a value ("e.g. Engrave", "Search by email") and stays.
 *
 * A grep. It reads string literals, including the literals inside a
 * template's `${...}`, and in `.tsx` JSX text: text between tags on one
 * line, and a line of plain words inside an element, with `{...}`
 * expressions blanked first. Comments are skipped, including block comments
 * that span lines. `run` is matched only as a word not joined to an
 * identifier or a path (`run-actions-`, `shop-runs`, `$runId`, `run.state`
 * are not copy); a sentence may end in "run." and is caught. A line holding
 * one bare word of JSX text is not read, because a lone identifier on its
 * own line looks the same.
 */
import { vocabularyTables } from "./spec.ts";

/**
 * An inline state, status, flag or admin role comparison: a line outside
 * `src/lib/Domain.ts` and `src/lib/domain/` that matches one needs a
 * `Domain` predicate instead. `state` is Baton's word and `status` is
 * Shopify's (the entry test on the vocabulary in `src/lib/Domain.ts`), and
 * both are read through predicates.
 */
export const INLINE_COMPARISONS: readonly RegExp[] = [
  /\.(?:status|state|flag) (?:===|!==) "/u,
  /\.role (?:===|!==) "admin"/u,
];

export const RETIRED: readonly RegExp[] = [
  /(?<![-_/.$\w])runs?\b(?![-_/$]|\.\w)/iu,
  /\bline items?\b/iu,
  /\bmark(?:ed)? done\b/iu,
  /\bfinish(?:ed)?\b/iu,
  /\bin progress\b/iu,
  /\bunclaimed\b/iu,
  /\btabs?\b/iu,
  /\b(?:un)?staff(?:s|ed|ing)?\b/iu,
  /\battention\b/iu,
  /\bbilling periods?\b/iu,
  /\bimport(?:s|ed|ing)?\b/iu,
  /\bre-?sync(?:s|ed|ing)?\b/iu,
  /\bplease\b/iu,
  /\bsuccessfully\b/iu,
  /\boops\b/iu,
  /\bsorry\b/iu,
  /\bclick here\b/iu,
  /\bare you sure\b/iu,
];

const LITERAL =
  /"(?<double>(?:[^"\\]|\\.)*)"|'(?<single>(?:[^'\\]|\\.)*)'|`(?<template>(?:[^`\\]|\\.)*)`/gu;
const INTERPOLATION = /\$\{(?<expr>[^}]*)\}/gu;
const JSX_EXPRESSION = /\{[^{}]*\}/gu;

/** The string literals on one line; a template's interpolations contribute their own literals and are then blanked. */
const literalsOf = (line: string): readonly string[] =>
  [...line.matchAll(LITERAL)].flatMap(({ groups }) => {
    const template = groups?.template;
    if (template === undefined) return [groups?.double ?? groups?.single ?? ""];
    const inner = [...template.matchAll(INTERPOLATION)].flatMap(({ groups }) =>
      literalsOf(groups?.expr ?? ""),
    );
    return [template.replaceAll(INTERPOLATION, " "), ...inner];
  });

/** The copy on one line of code: its string literals, and in `.tsx` its JSX text. */
export const copyOf = (line: string, tsx: boolean): readonly string[] => {
  const literals = literalsOf(line);
  if (!tsx) return literals;
  const blanked = line.replaceAll(JSX_EXPRESSION, " ");
  const text = blanked.trim();
  return [
    ...literals,
    ...[...blanked.matchAll(/>(?<text>[^<>{}]+)</gu)].map(
      ({ groups }) => groups?.text ?? "",
    ),
    // A line of words and prose punctuation with no member access or key:
    // the middle of a JSX text block. The ASCII double quote is not prose
    // punctuation here: with its braces blanked, `import { X } from "y";`
    // would read as copy. Literals are read by `literalsOf` anyway.
    ...(/^[A-Za-z][A-Za-z0-9 '’“”.,:;!?—–…()&%-]*$/u.test(text) &&
    text.includes(" ") &&
    !/\w\.\w|^\w+:/u.test(text)
      ? [text]
      : []),
  ];
};

/** The lines of `source` whose copy holds a retired word, 1-based, with their trimmed text. Comments are skipped. */
export const retiredCopyHits = (
  source: string,
  tsx: boolean,
): readonly { readonly line: number; readonly text: string }[] => {
  let inComment = false;
  return source.split("\n").flatMap((line, index) => {
    const text = line.trim();
    const wasInComment = inComment;
    const opens = text.lastIndexOf("/*");
    const closes = text.lastIndexOf("*/");
    if (opens !== -1 && opens > closes) inComment = true;
    else if (closes !== -1) inComment = false;
    if (
      wasInComment ||
      text.startsWith("*") ||
      text.startsWith("/*") ||
      text.startsWith("{/*") ||
      text.startsWith("//")
    )
      return [];
    return copyOf(line, tsx).some((copy) =>
      RETIRED.some((pattern) => pattern.test(copy)),
    )
      ? [{ line: index + 1, text }]
      : [];
  });
};

/**
 * The lines, 1-based, on which an `s-text-area` element sets `placeholder`,
 * with the element's opening line. The element's attributes may span lines,
 * so this reads the whole opening tag, not one line.
 */
export const textAreaPlaceholderHits = (
  source: string,
): readonly { readonly line: number; readonly text: string }[] =>
  [...source.matchAll(/<s-text-area\b[^>]*?\bplaceholder=/gsu)].map(
    ({ index }) => ({
      line: source.slice(0, index).split("\n").length,
      text: source.slice(index).split("\n")[0]?.trim() ?? "",
    }),
  );

/** One exported name in a source file, with its 1-based line and what kind of declaration it is. */
export interface ExportedName {
  readonly name: string;
  readonly line: number;
  readonly kind: string;
}

const EXPORT =
  /^export (?:declare )?(?:abstract )?(?<kind>const|let|async function\*?|function\*?|class|type|interface|enum) (?<name>[A-Za-z_$][A-Za-z0-9_$]*)/gmu;

/** The names a module exports by declaration (`export const`, `export function`, `export type`, ...). Re-exports are not read. */
export const exportedNames = (source: string): readonly ExportedName[] =>
  [...source.matchAll(EXPORT)].map(({ index, groups }) => ({
    name: groups?.name ?? "",
    line: source.slice(0, index).split("\n").length,
    kind: groups?.kind ?? "",
  }));

/**
 * The word stems the vocabulary retired or reserved, refused in any exported
 * identifier under `src/lib/`, case-insensitive, as a substring:
 *
 * | stem       | why                                                                                 |
 * | ---------- | ----------------------------------------------------------------------------------- |
 * | active     | a workflow is on, a run is open; "active" is Shopify's word for an app subscription |
 * | roster     | a synonym: the shop's members, the member count, or its teams                       |
 * | slot       | a metaphor for the rule "one run per item"                                          |
 * | tier       | a view of the member's workflows list; billing's tier is Shopify's and not exported |
 * | glossary   | the block is the vocabulary                                                         |
 * | production | the deploy environment; the core context is shop work                               |
 * | activated  | nothing; the switch is `state`, `on` / `off`                                        |
 * | import     | retired; the word is sync                                                           |
 * | resync     | retired; the word is sync                                                           |
 *
 * {@link RESERVED_STEM_ALLOWED} names the exports that keep a stem on
 * purpose.
 */
export const RESERVED_STEMS: readonly string[] = [
  "active",
  "roster",
  "slot",
  "tier",
  "glossary",
  "production",
  "activated",
  "import",
  "resync",
];

/**
 * Exact names exempt from {@link RESERVED_STEMS}. `CopySlot` is the screen
 * spec's slot (`src/lib/Screen.ts`): a place in a screen's copy, a different
 * context from the run's retired slot, and the word the copy table is built
 * on.
 */
export const RESERVED_STEM_ALLOWED: ReadonlySet<string> = new Set(["CopySlot"]);

/** **An exported identifier carries no reserved stem.** The exports in `source` that contain one of {@link RESERVED_STEMS}, less {@link RESERVED_STEM_ALLOWED}. */
export const reservedStemHits = (source: string): readonly ExportedName[] =>
  exportedNames(source).filter(
    ({ name }) =>
      !RESERVED_STEM_ALLOWED.has(name) &&
      RESERVED_STEMS.some((stem) => name.toLowerCase().includes(stem)),
  );

/**
 * **A state predicate names its noun before the state.** An exported
 * function or const named `is<Word>` has no noun: `isOpen` could be an order
 * or a run, and a word two contexts share is always spoken with its noun
 * (`orderIsOpen`, `runIsOpen`, `workflowIsOn`). Returns the exports in
 * `source` named `is` and a capital letter.
 */
export const bareStatePredicateHits = (
  source: string,
): readonly ExportedName[] =>
  exportedNames(source).filter(
    ({ name, kind }) =>
      /^is[A-Z]/u.test(name) &&
      kind !== "type" &&
      kind !== "interface" &&
      kind !== "class",
  );

/** What each context file under `src/lib/domain/` may import, by file stem (`Orders` → `["Platform"]`). */
export type ContextImports = ReadonlyMap<string, readonly string[]>;

/**
 * The map's `file` and `may import` columns, read out of the barrel's source
 * (`src/lib/Domain.ts`) so the table a person edits is the table the lint
 * enforces. A `may import` cell names contexts, joined with ", ", or says
 * "(nothing)"; each context becomes the stem of its row's `file`.
 */
export const contextImports = (barrel: string): ContextImports => {
  const rows =
    vocabularyTables(barrel).find(({ intro }) => intro.startsWith("Contexts."))
      ?.rows ?? [];
  const stemOf = (context: string) =>
    (rows.find((row) => row.context === context)?.file ?? context)
      .replaceAll("`", "")
      .replace(/\.ts$/u, "");
  return new Map(
    rows.map((row) => [
      stemOf(row.context ?? ""),
      row["may import"] === "(nothing)"
        ? []
        : (row["may import"] ?? "").split(", ").map(stemOf),
    ]),
  );
};

/** One import a file may not make: its 1-based line, the specifier, and, for a context file, the stems the map allows it. */
export interface ContextImportHit {
  readonly line: number;
  readonly specifier: string;
  readonly allowed?: readonly string[];
}

const FROM = /^\s*(?:import|export)\b[^;]*?\bfrom\s+"(?<specifier>[^"]+)"/gmu;

/** `dir` joined with the relative `specifier`, `..` and `.` resolved: `lib`, `./domain/Orders.ts` → `lib/domain/Orders.ts`. */
const resolve = (dir: string, specifier: string) =>
  [...dir.split("/"), ...specifier.split("/")]
    .reduce<string[]>((parts, part) => {
      if (part === "" || part === ".") return parts;
      if (part === "..") return parts.slice(0, -1);
      return [...parts, part];
    }, [])
    .join("/");

/**
 * **An import follows the map's direction.** `file` is the path under
 * `src/` (`lib/domain/Orders.ts`, `routes/app.index.tsx`). A context file
 * under `lib/domain/` may import only the context files its map row's `may
 * import` cell names ({@link contextImports}); a stem the map has no row for
 * may import none. Any other file imports the barrel (`@/lib/Domain`), never
 * a context file, by alias or by relative path: the barrel is the public
 * surface. The barrel itself (`lib/Domain.ts`) is exempt, since re-exporting
 * the four is its job. Returns each import that breaks the rule.
 */
export const contextImportHits = (
  file: string,
  source: string,
  map: ContextImports,
): readonly ContextImportHit[] => {
  if (file === "lib/Domain.ts") return [];
  const dir = file.split("/").slice(0, -1).join("/");
  const imports = [...source.matchAll(FROM)].map(({ index, groups }) => ({
    line: source.slice(0, index).split("\n").length,
    specifier: groups?.specifier ?? "",
  }));
  const intoDomain = (specifier: string) =>
    specifier.startsWith("@/lib/domain/") ||
    (specifier.startsWith(".") &&
      resolve(dir, specifier).startsWith("lib/domain/"));
  if (!file.startsWith("lib/domain/"))
    return imports.filter(({ specifier }) => intoDomain(specifier));
  const allowed =
    map.get(file.slice("lib/domain/".length, -".ts".length)) ?? [];
  return imports.flatMap(({ line, specifier }) => {
    if (!intoDomain(specifier)) return [];
    const stem = resolve(dir, specifier)
      .slice("lib/domain/".length)
      .replace(/\.ts$/u, "");
    return allowed.includes(stem) ? [] : [{ line, specifier, allowed }];
  });
};

/**
 * **Loader data lives in its route.** `file` is the path under `src/`; for a
 * file not under `routes/`, every export whose name ends in `LoaderData` is a
 * hit (the loader-data rule on `ShopAgentClient`).
 */
export const loaderDataExportHits = (
  file: string,
  source: string,
): readonly ExportedName[] =>
  file.startsWith("routes/")
    ? []
    : exportedNames(source).filter(({ name }) => name.endsWith("LoaderData"));

/**
 * The object map: what each file under `src/lib/agent/` may import from that
 * folder, by file stem. The table is on `ShopAgentHost` (`src/lib/agent/Host.ts`),
 * which says why shop work's one crossing into Billing exists; this constant is
 * that table's `may import` column. Every other file may import none of them,
 * except `lib/ShopAgent.ts`, the class, which imports all four.
 */
export const OBJECT_MAP: ReadonlyMap<string, readonly string[]> = new Map([
  ["Host", []],
  ["Billing", ["Host"]],
  ["Orders", ["Host"]],
  ["ShopWork", ["Host", "Billing"]],
]);

/**
 * **An import follows the object map's direction.** `file` is the path under
 * `src/`. A file under `lib/agent/` may import under `agent/` only the stems its
 * {@link OBJECT_MAP} row names; a stem the map has no row for may import none.
 * `lib/ShopAgent.ts` may import any of them. Any other file imports none, by
 * alias or by relative path: the class is the modules' only consumer. Returns
 * each import that breaks the rule, with `allowed` set for a file under
 * `lib/agent/`.
 */
export const objectImportHits = (
  file: string,
  source: string,
): readonly ContextImportHit[] => {
  if (file === "lib/ShopAgent.ts") return [];
  const dir = file.split("/").slice(0, -1).join("/");
  const imports = [...source.matchAll(FROM)].map(({ index, groups }) => ({
    line: source.slice(0, index).split("\n").length,
    specifier: groups?.specifier ?? "",
  }));
  const target = (specifier: string) => {
    if (specifier.startsWith("@/lib/agent/"))
      return `lib/agent/${specifier.slice("@/lib/agent/".length)}`;
    return specifier.startsWith(".") ? resolve(dir, specifier) : "";
  };
  const intoAgent = (specifier: string) =>
    target(specifier).startsWith("lib/agent/");
  if (!file.startsWith("lib/agent/"))
    return imports.filter(({ specifier }) => intoAgent(specifier));
  const allowed =
    OBJECT_MAP.get(file.slice("lib/agent/".length).replace(/\.ts$/u, "")) ?? [];
  return imports.flatMap(({ line, specifier }) => {
    if (!intoAgent(specifier)) return [];
    const stem = target(specifier)
      .slice("lib/agent/".length)
      .replace(/\.ts$/u, "");
    return allowed.includes(stem) ? [] : [{ line, specifier, allowed }];
  });
};

/** The Shape families table's suffixes (`Input`, `Command`, ..., `LoaderData`), read out of the barrel's source (`src/lib/Domain.ts`), longest first. */
export const shapeSuffixes = (barrel: string): readonly string[] =>
  (
    vocabularyTables(barrel).find(({ intro }) =>
      intro.startsWith("Shape families."),
    )?.rows ?? []
  )
    .flatMap((row) => [...(row.suffix ?? "").matchAll(/`(?<suffix>[^`]+)`/gu)])
    .map(({ groups }) => groups?.suffix ?? "")
    .toSorted((a, b) => b.length - a.length);

/** One model symbol that names a shape in its code: the symbol, its 1-based line, and the shape. */
export interface ShapeReferenceHit {
  readonly name: string;
  readonly line: number;
  readonly shape: string;
}

const DECLARATION =
  /^(?:export (?:declare )?)?(?:abstract )?(?:const|let|async function\*?|function\*?|class|type|interface|enum) (?<name>[A-Za-z_$][A-Za-z0-9_$]*)/gmu;

const COMMENT = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;

/**
 * **A model symbol never references a shape.** In a context file, a
 * top-level declaration whose name has no family suffix ({@link shapeSuffixes})
 * may not name, in its code, an export of that file whose name has one.
 * Shapes read the model; the model never reads the shapes. The rule keeps a
 * contracts file (the shapes in a sibling file, the barrel re-exporting both)
 * a mechanical move for the day a consumer needs the shapes without the
 * model, which no consumer does today; the Shape families paragraph on the
 * map says so. A `{@link}` from a model symbol to a shape is JSDoc and is not
 * read: comments are blanked before the scan. A declaration's code runs to
 * the next top-level declaration.
 */
export const modelShapeReferenceHits = (
  source: string,
  suffixes: readonly string[],
): readonly ShapeReferenceHit[] => {
  const isShape = (name: string) =>
    suffixes.some((suffix) => name.endsWith(suffix));
  const shapes = new Set(
    exportedNames(source)
      .map(({ name }) => name)
      .filter(isShape),
  );
  if (shapes.size === 0) return [];
  const blanked = source.replaceAll(COMMENT, (text) =>
    text.replaceAll(/[^\n]/gu, " "),
  );
  const declarations = [...blanked.matchAll(DECLARATION)].map(
    ({ index, groups }) => ({
      name: groups?.name ?? "",
      start: index ?? 0,
    }),
  );
  return declarations.flatMap(({ name, start }, i) => {
    if (isShape(name)) return [];
    const end = declarations[i + 1]?.start ?? blanked.length;
    const body = blanked.slice(start, end);
    const seen = new Set<string>();
    return [...body.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)].flatMap(
      ({ index, 0: word }) => {
        if (word === name || !shapes.has(word) || seen.has(word)) return [];
        seen.add(word);
        return [
          {
            name,
            line: blanked.slice(0, start + (index ?? 0)).split("\n").length,
            shape: word,
          },
        ];
      },
    );
  });
};
