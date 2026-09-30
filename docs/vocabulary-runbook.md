# Vocabulary runbook

How to add, rename or retire a word. For people and for agents. The rules of the vocabulary itself (the contexts, and what a word must pass to get a row) are in the JSDoc block that starts `Vocabulary.` at the top of `src/lib/Domain.ts` (the map), and each context's words are in the block that starts `Vocabulary, <context>.` at the top of its file under `src/lib/domain/`; this runbook is the procedure around them.

## A new word

1. **Look it up.** Read the map and the vocabulary block of the word's context. If a row already names the concept, use that word; stop.
2. **Grep the stem.** `grep -rn -i '<stem>' src scripts test e2e`. Every identifier, JSDoc line and label that comes back must mean the same thing in the same context. If one means something else, the word is taken: pick another, or split the old sense first (step 5).
3. **Write the row first**, in the table of the word's context, in that context's file under `src/lib/domain/`: word, meaning, symbol, screen. The row goes in the file that holds its symbol. When the word crosses into a second context, the map in `src/lib/Domain.ts` gains a Shared words row. A word with no screen says "(none)". A word only one symbol uses stays a JSDoc term on that symbol and gets no row.
4. **Rename in the same change.** Every identifier, type, callable, JSDoc, test title, log message and label constant moves with the row. A stored literal in our own store moves too (`initializeSchema` in `src/lib/ShopAgentSchema.ts`; while prototyping, edit in place and run `pnpm dev:reset`).
5. **Retire the loser.** The old word goes on a retired list (below), in the same change.

Then run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`.

## Retiring a word

| where the word was               | list                                            | checked by  |
| -------------------------------- | ----------------------------------------------- | ----------- |
| screen copy                      | `RETIRED` in `scripts/lib/rules-lint.ts`        | `pnpm lint` |
| exported identifier (`src/lib/`) | `RESERVED_STEMS` in `scripts/lib/rules-lint.ts` | `pnpm lint` |

- Add the stem to the list and a line to the table in the list's JSDoc saying which word replaced it.
- An export that keeps the stem on purpose, in another context, goes on `RESERVED_STEM_ALLOWED` with the reason in its JSDoc.
- Add a case to `test/integration/rules-lint.test.ts`.
- Research docs under `docs/` are dated and are not rewritten.

## Shared words

A word two contexts share (open, closed, cancel) is a row of the Shared words table in the map at the top of `src/lib/Domain.ts`, and always travels with its noun: "open order", "open run". In identifiers that is `<noun>Is<State>` (`orderIsOpen`, `runIsOpen`, `workflowIsOn`). `pnpm lint` refuses an exported `is<State>` under `src/lib/`.

## The audit

```bash
pnpm vocab:audit
```

Lists every word in an exported identifier (and in every `Schema.Literals`) under `src/lib/` that is neither a vocabulary word nor on `scripts/vocab-allowlist.txt`, most frequent first, with one example each. It exits 0; it is a list to read, not a check.

For each word it lists, decide one of:

- **Row**: it names a domain concept that surfaces or that several symbols share. Add the row (step 3 above).
- **JSDoc term**: only its own symbol uses it. Leave it.
- **Allowlist**: it is an English function word or a code word that names no concept (`get`, `input`, `result`). Add it to `scripts/vocab-allowlist.txt`. A domain word never goes there.
- **Retire**: it is a synonym or a metaphor for a word the vocabulary already has. Rename it and add it to a retired list.

Run the audit before writing a spec that adds words, and after a rename, to see that the old word is gone.
