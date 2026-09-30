# Shop work rename: implementation plan

The core context is renamed from "production" to "shop work". This plan says what changes, in what order, and how to know it is done. It follows the rename procedure in `docs/vocabulary-runbook.md`.

## Decision

- The context is **shop work**: the work of making what the shop sold, meaning who does it, in what steps, and how far along it is. The merchant sets the work up (workflows, teams, members), members do it (runs, tasks, blocks, notes), and the merchant reads how far along it is (order positions, issues).
- Why rename: "production" also names the deploy environment (`environment: "production"` in `src/lib/Shopify.ts`, `deploy:PRODUCTION`, `tail:PRODUCTION`, `.env.production`, `logs/production-worker.log`). A grep or a sentence ("production is broken") hits both senses.
- Why "shop work" and not the others:
  - The other contexts are named for their subject (orders, billing). Shop work is a subject too; "shop floor" is a place.
  - "Work" is already the plain word in the context's definitions ("one unit of work on a run", "work can be recorded", "Teams are what scope work").
  - "workflows" is a noun inside the context. "core" is the DDD classification, already in the map's `kind` column. "baton" also names the whole app. "jobs" means background jobs. "making" is an order-position screen word.
- The boundary that "shop floor" would have drawn by itself (selling and paying are not on the floor) is drawn by the map's `about` cell and its `may import` column.

## Names

| where                           | before                             | after                             |
| ------------------------------- | ---------------------------------- | --------------------------------- |
| the map's context cell          | `production`                       | `shop work`                       |
| context file                    | `src/lib/domain/Production.ts`     | `src/lib/domain/ShopWork.ts`      |
| object service file             | `src/lib/agent/Production.ts`      | `src/lib/agent/ShopWork.ts`       |
| service class                   | `ProductionAgent`                  | `ShopWorkAgent`                   |
| local binding in `ShopAgent.ts` | `(production) => production.x(…)`  | `(shopWork) => shopWork.x(…)`     |
| vocabulary table intros         | `Run states, production:` …        | `Run states, shop work:` …        |
| Shared words `contexts` cells   | `orders, production`               | `orders, shop work`               |
| possessive in JSDoc             | "Production's reading of an order" | "Shop work's reading of an order" |
| stem in lists and maps          | `Production`                       | `ShopWork`                        |
| test source import              | `productionSource`                 | `shopWorkSource`                  |

The two-word context parses as it is: `checkContexts` in `scripts/lib/spec.ts` splits an intro on ", " and a cell on " and " or ", ", and `contextImports` in `scripts/lib/rules-lint.ts` takes a row's stem from its `file` cell, not from the context word.

## Three senses of "production"

Every occurrence of "production" under `src/`, `scripts/`, `test/`, `e2e/` and `AGENTS.md` is one of these. Only the first one changes.

| sense                           | examples                                                                                                                                                                                                                                | action                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| the context                     | `domain/Production.ts`, `ProductionAgent`, "Production is downstream of orders", "not a production word here", the vocabulary table intros, `CONTEXTS` in `scripts/spec.ts`                                                             | rename to shop work                                                                            |
| the deploy environment          | `src/lib/Shopify.ts`, `ShopAgentObjects.ts`, `LayerEx.ts`, `Email.ts`, `ShopAgentContext.tsx`, `scripts/d1-reset.ts`, test comments ("failures in production", "production signature"), `e2e/app.ts`, AGENTS.md's `tail:PRODUCTION`     | keep                                                                                           |
| making things, in plain English | screen copy ("items are in production" in `QuotaBanners.tsx` and the order page), page titles ("Made-to-order production workflows"), `privacy.tsx`, `USAGE_METER_ORDER` = `"production-orders"`, competitor names in `scripts/refs.ts` | keep in screen copy, page titles and external literals; in JSDoc and comments, rewrite (below) |

Screen copy keeps "in production" because a merchant reads it as plain English and never sees the context name. `USAGE_METER_ORDER` keeps its value because it must match the Partner Dashboard meter handle exactly.

In JSDoc and code comments, "production" from now on means only the deploy environment. The plain-English uses there get rewritten:

| file                              | before                                                               | after                                                    |
| --------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `src/lib/SubscriptionPlan.ts`     | "locked out of the production floor mid-shift"                       | "locked out of the shop's work mid-shift"                |
| `src/lib/domain/Billing.ts`       | "the production floor must not lose the work it is already carrying" | "the shop must not lose the work it is already carrying" |
| `src/lib/domain/Orders.ts`        | "Baton is a production-floor tool"                                   | "Baton is a tool for the shop's work"                    |
| `src/lib/domain/Orders.ts`        | "N items in production" (a quote of copy)                            | keep: it quotes screen copy                              |
| `src/lib/domain/ShopWork.ts`      | "the production ladder"                                              | "the ladder"                                             |
| `src/routes/app.orders.index.tsx` | "On an order in production, empty means …"                           | "On an order with open runs, empty means …"              |

## Steps

One change. Do not commit unless the user says so.

1. **The map row.** In `src/lib/Domain.ts`, the Contexts table row becomes:

   `| shop work | core | the work of making what the shop sold: who does it, in what steps, and how far along it is | Baton's, the merchant's and the members' | \`ShopWork.ts\` | orders, platform |`

   Rewrite the prose after the map ("Production is downstream of orders …", "is production's, not orders'", "Orders never reads production") and the Shared words `contexts` cells in the new word. The re-export becomes `export * from "./domain/ShopWork.ts";`. Update the three "in Production" mentions in the map's opening bullets and the Shape families rows that name `Production.ts`.

2. **The files.** `git mv src/lib/domain/Production.ts src/lib/domain/ShopWork.ts` and `git mv src/lib/agent/Production.ts src/lib/agent/ShopWork.ts`, so history follows the move.

3. **The context file.** In `src/lib/domain/ShopWork.ts`, the eight table intros (`Vocabulary, production.`, `Nouns, production.`, `Run states, production:`, `Task states, production.`, `Workflow states, production:`, `Order positions, production:`, `Order issues, production:`, `Verbs, production.`) take `shop work`. "not a production word here" becomes "not a shop-work word here". The three "Production's reading of …" JSDoc openings become "Shop work's reading of …". "the production ladder" becomes "the ladder".

4. **The service.** In `src/lib/agent/ShopWork.ts`, `ProductionAgent` becomes `ShopWorkAgent` (the class, its `Context.Service` generic and its key string). "The object's production:" becomes "The object's shop work:". In `src/lib/agent/Host.ts`, the object map row and the prose under it. In `src/lib/agent/Orders.ts` and `Billing.ts`, the one mention each.

5. **The class.** In `src/lib/ShopAgent.ts`: the import, the layer, every `{@link ProductionAgent}`, and every `(production) =>` binding with its `production.` calls. Replace the binding with a word-bounded pattern (`\bproduction\b` inside `(production)` and `production\.` followed by an identifier), not a bare `production.`, which also matches the end of a sentence.

6. **Other context files.** `src/lib/domain/Orders.ts` (the `in Production` references and "production's writing on the orders row"), `Billing.ts`, `Platform.ts` (`runIsOpen` in Production). Rewrite the plain-English uses per the table above.

7. **Scripts.**
   - `scripts/spec.ts`: `CONTEXTS`, `contexts.Production` (five sites), the header comment and the two command descriptions.
   - `scripts/lib/spec.ts`: `CONTEXT_FILES`, the header's matrix path, and the `checkContexts` JSDoc examples ("Run states, shop work:", "shop work and orders").
   - `scripts/lib/rules-lint.ts`: `OBJECT_MAP` key and its JSDoc.
   - `scripts/vocab-audit.ts`: the file list.

8. **Retire the stem.** Add `production` to `RESERVED_STEMS` in `scripts/lib/rules-lint.ts`, with the table row `| production | the deploy environment; the core context is shop work |`. After the rename no exported identifier under `src/lib/` carries it (`USAGE_METER_ORDER`'s value is a string, not an identifier). Add a case to `test/integration/rules-lint.test.ts`: "an export named ProductionAgent is refused". A stray `Run states, production:` intro is already refused by `checkContexts`, because production is no longer on the map.

9. **Tests.** Rename the files' imports and doctored strings (`" * Run states, shop work:"`, `"| cancel | orders, shop work |"`) and the titles that name the file or stem:
   - `test/integration/spec.test.ts`: `productionSource`, `Production:` keys, "ShopWork.ts passes", the path key `src/lib/domain/ShopWork.ts`, the Shape families expectation that quotes `Production.ts`.
   - `test/integration/rules-lint.test.ts`: the context map fixture, "Orders importing ShopWork is refused", "ShopWork importing Orders is allowed", "a route importing @/lib/domain/ShopWork is refused", and the object-map cases.
   - `test/integration/run-actions.test.ts`: the `?raw` import and its JSDoc path.

   No data-model table pins a title that contains "production" (`grep -n -i production src/lib/ShopAgentSchema.ts src/lib/D1Schema.ts` is empty).

10. **AGENTS.md.** Line 4 (the matrices' path), line 20 (the services list: `Host`, `Billing`, `Orders`, `ShopWork`) and the `pnpm spec check` line in Commands. Line 18's tagline keeps "production workflows": it is plain English about what the app does.

11. **Run** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`, `pnpm vocab:audit`. Keep every file `pnpm fmt` touches.

Research docs under `docs/` are dated and are not rewritten; they keep "production".

## Done when

- The checks in step 11 pass.
- `grep -rn -i production src scripts test e2e AGENTS.md` returns only the second and third senses: the deploy environment, screen copy, page titles, `privacy.tsx`, `USAGE_METER_ORDER`'s value, the quote of copy in `Orders.ts`, `scripts/refs.ts`, and the new `RESERVED_STEMS` row and its test.
- `git log --follow src/lib/domain/ShopWork.ts` shows the history of `Production.ts`.

## Decisions

The implementation was reviewed on 2026-09-30. Typecheck, lint, format and the test suite pass; the remaining "production" hits are the second and third senses. The deviations from the plan were all accepted:

- The context file's opening line ("Vocabulary, shop work.") describes the context in the map row's words ("The work of making what the shop sold: who does it, in what steps, and how far along it is") instead of "What the shop makes and who makes it". The old intro repeated the old `about` cell, so it had to follow the cell.
- `src/lib/ShopAgent.ts` had three plain-English or possessive uses the plan did not list: "Production's per-order reconciler" became "Shop work's per-order reconciler", "(production's reconciler" became "(shop work's reconciler", and "every order already on the production floor" became "every order Baton already carries". These follow the rule that "production" in JSDoc now means only the deploy environment.
- The map's `context` column narrowed by one character after the rename, so the doctored header in `test/integration/spec.test.ts` ("a map with no kind column ...") changed to `| context   | kind       |`.
- `git log --follow src/lib/domain/ShopWork.ts` shows history only after the change is committed; the moves are staged as renames.

Two fixes the review added: the `ShopWork.ts` row of the object map in `src/lib/agent/Host.ts` had its padding inside the cell after the colon, moved to the end of the cell; and the JSDoc in `scripts/lib/rules-lint.ts` said "ShopWork's one crossing" in prose, now "shop work's", since the stem is for lists and maps and prose uses the two words.
