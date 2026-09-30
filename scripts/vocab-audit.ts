// Lists the words in exported identifiers under src/lib/ that the vocabulary
// (the map at the top of src/lib/Domain.ts and the block at the top of each
// context file under src/lib/domain/) does not have, so a word that
// never got a row, or a retired word still in the code, shows up. An audit,
// not a check: it always exits 0, and what to do with each word is the
// vocabulary's entry test.
//
//   pnpm vocab:audit
//
// Reads every exported declaration (const, function, class, type,
// interface) and the string literals of every `Schema.Literals([...])`,
// splits each name into lowercase words (camelCase, PascalCase, snake_case,
// SCREAMING_CASE), and drops the words that appear in any vocabulary table's
// `word` or `context` cell and the words on scripts/vocab-allowlist.txt
// (English function words and code words). A table's name is not a word:
// "Run states" does not make "state" known, so a `<Noun>State` shows up. A trailing plural "s" is folded
// into the singular. Prints each remaining word with its count and one
// example identifier, most frequent first.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { SRC, walk } from "./lib/copy-files.ts";
import { exportedNames } from "./lib/rules-lint.ts";
import { vocabularyTables } from "./lib/spec.ts";

/** `orderIsOpen` → order, is, open; `USAGE_METER_ORDER` → usage, meter, order; `D1Schema` → d1, schema. */
const wordsOf = (name: string): readonly string[] =>
  name
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .replaceAll(/(?<run>[A-Z]+)(?<next>[A-Z][a-z])/gu, "$<run> $<next>")
    .split(/[\s_\-$]+/u)
    .map((word) => word.toLowerCase())
    .filter((word) => /[a-z]/u.test(word));

/** Folds a plural onto its singular: runs → run, entries → entry; leaves "status", "class" and short words ("ms") alone. */
const singular = (word: string) => {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  return /[^su]s$/u.test(word) ? word.slice(0, -1) : word;
};

const LITERALS = /Schema\.Literals\(\s*\[(?<body>[^\]]*)\]/gu;

const VOCABULARY_FILES = [
  "Domain.ts",
  "domain/Platform.ts",
  "domain/Orders.ts",
  "domain/Billing.ts",
  "domain/ShopWork.ts",
];
const known = new Set(
  VOCABULARY_FILES.map((file) => readFileSync(join(SRC, "lib", file), "utf8"))
    .flatMap(vocabularyTables)
    .flatMap(({ rows }) => rows.flatMap((row) => [row.word, row.context]))
    .flatMap((cell) => wordsOf(cell ?? ""))
    .map(singular),
);
const allowed = new Set(
  readFileSync(new URL("vocab-allowlist.txt", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/u, "").trim().toLowerCase())
    .filter((line) => line !== "")
    .map(singular),
);

const names = walk(join(SRC, "lib")).flatMap((path) => {
  const source = readFileSync(path, "utf8");
  const file = relative(SRC, path);
  return [
    ...exportedNames(source).map(({ name }) => ({ name, file })),
    ...[...source.matchAll(LITERALS)].flatMap(({ groups }) =>
      [...(groups?.body ?? "").matchAll(/"(?<literal>[^"]+)"/gu)].map(
        (match) => ({ name: match.groups?.literal ?? "", file }),
      ),
    ),
  ];
});

const found = new Map<string, { count: number; example: string }>();
for (const { name, file } of names)
  for (const word of new Set(wordsOf(name).map(singular)))
    if (!known.has(word) && !allowed.has(word)) {
      const entry = found.get(word);
      found.set(word, {
        count: (entry?.count ?? 0) + 1,
        example: entry?.example ?? `${name} (src/${file})`,
      });
    }

const rows = [...found].toSorted(
  ([a, x], [b, y]) => y.count - x.count || a.localeCompare(b),
);
console.log("| word | count | example |");
console.log("| ---- | ----- | ------- |");
for (const [word, { count, example }] of rows)
  console.log(`| ${word} | ${String(count)} | ${example} |`);
