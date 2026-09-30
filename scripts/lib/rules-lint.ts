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
 * identifier or a path (`run-actions-`, `shop-runs`, `$runId`, `run.status`
 * are not copy); a sentence may end in "run." and is caught. A line holding
 * one bare word of JSX text is not read, because a lone identifier on its
 * own line looks the same.
 */

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
    // the middle of a JSX text block.
    ...(/^[A-Za-z][A-Za-z0-9 '’.,:;!?—–-]*$/u.test(text) &&
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
 * | stem     | why                                                                                 |
 * | -------- | ----------------------------------------------------------------------------------- |
 * | active   | a workflow is on, a run is open; "active" is Shopify's word for an app subscription |
 * | roster   | a synonym: the shop's members, the member count, or its teams                       |
 * | slot     | a metaphor for the rule "one run per item"                                          |
 * | tier     | a view of the member's workflows list; billing's tier is Shopify's and not exported |
 * | glossary | the block is the vocabulary                                                         |
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
