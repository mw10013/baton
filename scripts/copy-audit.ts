// Inventories the screen copy so the human can read it by slot rather than
// by page: every string literal or JSX text of two or more words on a
// merchant or member screen, tagged with the screen (the vocabulary's Screens
// table) and the slot it fills (a guess from the nearest attribute or
// element; blank when nothing nearby says). Run once per audit, never as a
// check: the output is a markdown table to annotate, and what the
// annotations agree on becomes the spec on `Screen.ts`.
//
//   node scripts/copy-audit.ts [recommendations.json] > docs/ui-copy-audit-research.md
//
// The optional JSON maps "<file>:<line>|<text>" to { verdict, reason?,
// rewrite?, link? } and fills each block's Recommend line; a row with no
// entry is emitted with the line blank.

import { readFileSync } from "node:fs";
import { relative } from "node:path";

import * as Screen from "../src/lib/Screen.ts";
import { copyFiles, SRC } from "./lib/copy-files.ts";

/** The Screens table in `src/lib/Domain.ts`, route stem to spec name. */
const SCREENS: Readonly<Record<string, string>> = {
  "app.index": "the home page",
  "app.orders.index": "the orders index",
  "app.orders.$orderId": "the order page",
  "app.workflows.index": "the workflows index",
  "app.workflows.$workflowId": "the workflow page (merchant)",
  "app.workflows.$workflowId_.edit": "the workflow editor",
  "app.teams.index": "the teams index",
  "app.teams.$teamId": "the team page",
  "app.members": "the members page",
  "shop.index": "the shop picker",
  "shop.$shop.workflows.index": "the workflows list",
  "shop.$shop.workflows.$runId": "the workflow page (member)",
  "shop.$shop_.lapsed": "the lapsed page",
};

const SLOTS = Screen.CopySlot.literals;
type Slot = Screen.CopySlot;

interface Row {
  readonly file: string;
  readonly line: number;
  readonly screen: string;
  readonly slot: Slot;
  readonly text: string;
  readonly link: boolean;
  /** A line of prose inside a JSX block, mergeable with its neighbours. */
  readonly prose: boolean;
}

const screenOf = (file: string): string => {
  const stem = file.replace(/^routes\//u, "").replace(/\.tsx?$/u, "");
  if (file.startsWith("routes/")) return SCREENS[stem] ?? `(layout ${stem})`;
  return `(${file.replace(/^(?:components|lib)\//u, "")})`;
};

const ENTITIES: Readonly<Record<string, string>> = {
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&nbsp;": " ",
  "&amp;": "&",
  "&hellip;": "…",
};

/** A `${expr}` or JSX `{expr}` shown as «expr», so a sentence keeps its shape. */
const marker = (expr: string) => {
  const short = expr.trim().replaceAll(/\s+/gu, " ");
  return `«${short.length > 28 ? `${short.slice(0, 26)}…` : short}»`;
};

const LITERAL =
  /"(?<double>(?:[^"\\]|\\.)*)"|'(?<single>(?:[^'\\]|\\.)*)'|`(?<template>(?:[^`\\]|\\.)*)`/gu;

/**
 * The copy on one line, like `copyOf` in `scripts/lib/rules-lint.ts` but
 * with interpolations and JSX expressions kept as «markers» instead of
 * blanked, and entities decoded. Returns each string with whether it was a
 * quoted literal (`false` means JSX text).
 */
const copyWithMarkers = (
  raw: string,
  tsx: boolean,
): readonly { readonly text: string; readonly literal: boolean }[] => {
  const line = Object.entries(ENTITIES)
    .reduce((acc, [entity, char]) => acc.replaceAll(entity, char), raw)
    .replaceAll(/\\u(?<hex>[0-9a-fA-F]{4})/gu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/\$\{(?<expr>[^}]*)\}/gu, (_, expr: string) => marker(expr));
  const literals = [...line.matchAll(LITERAL)].map(({ groups }) => ({
    text: groups?.double ?? groups?.single ?? groups?.template ?? "",
    literal: true,
  }));
  if (!tsx) return literals;
  const jsx = line
    .replaceAll(/\{\s*(?:"|')\s?(?:"|')\s*\}/gu, " ")
    .replaceAll(/\{(?<expr>[^{}]*)\}/gu, (_, expr: string) => marker(expr));
  const between = [...jsx.matchAll(/>(?<text>[^<>]+)</gu)].map(
    ({ groups }) => ({
      text: groups?.text ?? "",
      literal: false,
    }),
  );
  const text = jsx.trim();
  const prose =
    /^[A-Z«][A-Za-z0-9 '’‘.,:;!?—–()«»×#·-]*[a-z0-9.!?»)]$/u.test(text) &&
    text.includes(" ") &&
    !/\w\.\w|^\w+:|^(?:return|if|throw|const|let|export|import|case|else)\b/u.test(
      text,
    )
      ? [{ text, literal: false }]
      : [];
  return [...literals, ...between, ...prose];
};

/** Elements whose text is a slot; tracked as an open stack across lines. */
const CONTEXT: readonly (readonly [RegExp, Slot])[] = [
  [/<s-banner\b/u, "banner"],
  [/<s-modal\b/u, "confirm"],
  [/<s-link\b/u, "link"],
  [/<s-heading\b/u, "heading"],
  [/<s-button\b/u, "button"],
  [/<s-badge\b/u, "badge"],
];

const slotOf = (line: string, copy: string, context: readonly Slot[]): Slot => {
  const top = context.at(-1);
  if (/\bplaceholder=/u.test(line)) return "placeholder";
  if (/\bheading=/u.test(line) || top === "heading") return "heading";
  if (/\bdetails=/u.test(line)) return "help";
  if (/\berror[=:(]|setError\(|isError|\.message\b/u.test(line)) return "error";
  if (/toast/iu.test(line)) return "toast";
  if (/\b(?:label|accessibilityLabel|submitLabel)=/u.test(line)) return "label";
  if (top === "link") return "link";
  if (top === "button") return "button";
  if (top === "badge") return "badge";
  if (top === "banner" || /\bsetBanner\(|\bbanner\b/u.test(line))
    return "banner";
  if (
    /^(?:No |Nothing |You(?:’|')re not |You do not |You no longer )/u.test(copy)
  )
    return "empty";
  if (top === "confirm") return "confirm";
  return "body";
};

/** A string that is code rather than copy: a path, a key, a log line, a query. */
const isCode = (line: string, copy: string): boolean =>
  !/^[A-Za-z(“"'«]/u.test(copy.trim()) ||
  !/[A-Za-z]{2,}/u.test(copy.replaceAll(/«[^»]*»/gu, "")) ||
  !copy.trim().includes(" ") ||
  /Effect\.log|annotateLogs|shop=|queryKey|console\.|throw new|RepositoryError|^\s*message:|data-testid|className=|href=\{?["'`]|gridTemplate|padding|gap=|style=/u.test(
    line,
  ) ||
  copy.trim().startsWith("«`") ||
  /[{}<>=;]|\binstanceof\b|\?\?|^[a-z]+(?: [a-z]+)*$|\b(?:minmax|repeat|translate|scale|max-content|\d+fr|\d+px|\d+rem)\b|^(?:small|large|base)-\d/u.test(
    copy.trim(),
  );

const rowsOf = (path: string): Row[] => {
  const file = relative(SRC, path);
  const tsx = path.endsWith(".tsx");
  const screen = screenOf(file);
  const context: Slot[] = [];
  let inComment = false;
  let inGraphql = false;
  const rows: Row[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const text = line.trim();
      if (inGraphql) {
        if (text.includes("`")) inGraphql = false;
        return;
      }
      if (text.includes("#graphql")) {
        inGraphql = !/`\s*[,)]?;?\s*$/u.test(
          text.slice(text.indexOf("#graphql")),
        );
        return;
      }
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
        return;
      const before = [...context];
      for (const [pattern, slot] of CONTEXT) {
        if (pattern.test(line)) context.push(slot);
      }
      for (const { text: copy, literal } of copyWithMarkers(line, tsx)) {
        const clean = copy.trim().replaceAll(/\s+/gu, " ");
        const seen = rows.some(
          (row) => row.line === index + 1 && row.text === clean,
        );
        if (!isCode(line, copy) && !seen) {
          rows.push({
            file,
            line: index + 1,
            screen,
            slot: slotOf(line, clean, before.length > 0 ? before : context),
            text: clean,
            link: /<s-link\b/u.test(line) || context.includes("link"),
            prose: !literal && !/[<>]/u.test(line),
          });
        }
      }
      for (const [, slot] of CONTEXT) {
        const closeTag = `</s-${slot === "confirm" ? "modal" : slot}>`;
        if (
          line.includes(closeTag) ||
          (/\/>\s*$/u.test(text) &&
            context.at(-1) === slot &&
            !line.includes(`<s-${slot}`))
        )
          context.splice(context.lastIndexOf(slot), 1);
      }
    });
  // Merge consecutive prose lines of one block into one row.
  return rows.reduce<Row[]>((merged, row) => {
    const last = merged.at(-1);
    if (
      last?.prose === true &&
      row.prose &&
      row.line === last.line + 1 &&
      last.file === row.file
    ) {
      merged[merged.length - 1] = {
        ...last,
        text: `${last.text} ${row.text}`,
        link: last.link || row.link,
      };
      return merged;
    }
    return [...merged, row];
  }, []);
};

interface Recommendation {
  readonly verdict: "keep" | "cut" | "rewrite";
  readonly rewrite?: string;
  readonly reason?: string;
  readonly link?: "keep" | "cut";
}
const recommendationsPath = process.argv[2];
const recommendations: Readonly<Record<string, Recommendation>> =
  recommendationsPath === undefined
    ? {}
    : (JSON.parse(readFileSync(recommendationsPath, "utf8")) as Record<
        string,
        Recommendation
      >);
const keyOf = (row: Row) => `${row.file}:${String(row.line)}|${row.text}`;

const recommendLine = (row: Row): string => {
  const rec = recommendations[keyOf(row)];
  if (rec === undefined) return "";
  const verdict =
    rec.verdict === "rewrite" ? `rewrite: ${rec.rewrite ?? ""}` : rec.verdict;
  const link = rec.link === undefined ? "" : ` · link ${rec.link}`;
  const reason = rec.reason === undefined ? "" : ` — ${rec.reason}`;
  return `${verdict}${link}${reason}`;
};

const rows = copyFiles().flatMap(rowsOf);
const today = new Date().toISOString().slice(0, 10);

const out: string[] = [
  "# Screen copy audit",
  "",
  `Every string of two or more words on a merchant or member screen, read by slot rather than by page, from \`scripts/copy-audit.ts\` on ${today}. The slot is a guess from the nearest attribute or element. Words already retired by \`scripts/lib/rules-lint.ts\` do not appear. Button and badge text are listed last; label constants read from the vocabulary (\`Domain.ts\`) are not listed.`,
  "",
  "One block per string. The quoted line is the copy as it is now, with «…» where a value is filled in. **Recommend** is the implementer's call: keep, cut, or rewrite with the new text, and for a link, keep or cut. **You** is yours: leave it blank to accept the recommendation, or write keep, cut, or the text you want, and anything else you want said. What the blocks agree on becomes the copy table and tone list on `Screen.ts` (`docs/ui-copy-spec-research.md`).",
  "",
  `${String(rows.length)} strings.`,
  "",
];
const groups = SLOTS.map(
  (slot) => [slot, rows.filter((row) => row.slot === slot)] as const,
).filter(([, group]) => group.length > 0);
for (const [slot, group] of groups) {
  out.push(
    `## ${slot} (${String(group.length)})`,
    "",
    ...group
      .toSorted((a, b) => a.screen.localeCompare(b.screen) || a.line - b.line)
      .flatMap((row, i) => [
        `### ${slot} ${String(i + 1)} · ${row.screen}${row.link ? " · link" : ""} · \`${row.file}:${String(row.line)}\``,
        "",
        `> ${row.text}`,
        "",
        `**Recommend:** ${recommendLine(row)}`,
        "",
        "**You:**",
        "",
      ]),
  );
}
process.stdout.write(out.join("\n"));
