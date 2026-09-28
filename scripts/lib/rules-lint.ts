/**
 * The copy half of `scripts/rules-lint.ts`, pure so the test can run it on
 * inline sources inside workerd (no `node:fs`), the way
 * `scripts/lib/spec.ts` is split from its command.
 *
 * The glossary's screen rule (`src/lib/Domain.ts`), for the copy its label
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
