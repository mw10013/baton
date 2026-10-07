# AGENTS.md

- Prefer JSDoc for complex and subtle behavior the code cannot show, and for rules: any behaviour more than one site must agree on is stated once, normatively, on the symbol that enforces it or the symbol that is the concept. Other sites `{@link}` it rather than restate it; a site that follows a different rule says so and why. Each rule has a test whose title is the rule.
- An action matrix in a JSDoc (`runActions`, `taskActions` in `src/lib/domain/ShopWork.ts`, and the outcomes table on `reconcileItem` beside them, under its triggers table) is the spec: the test reads it out of the source, and a behaviour change starts at the cell. `pnpm lint` checks that the tables parse, that every word the vocabulary names still exists, that every vocabulary table names its context, and that the vocabulary's screen columns equal the label constants (`TASK_STATE_LABEL`, `RUN_STATE_LABEL`, `WORKFLOW_STATE_LABEL`, `VERB_LABEL`), which the screens read; a label change starts at the vocabulary row. `scripts/rules-lint.ts` refuses the retired words ("run", "line item", "finished", ...) and the copy words wrong in every slot ("please", "successfully", ...) in screen copy, and a placeholder on an `s-text-area`.
- The screens' spec is the JSDoc on `CopySlot` and `Control` in `src/lib/Screen.ts`: a tone list, a copy table (one row per slot: job, form, when it is empty, an example, what it never does) and a controls table (which control does which job). A copy or control change starts at the row; a component whose JSDoc explains its copy names the slot and links the table. The controls table holds the create, edit and delete pattern (index, create modal, details page, set sections, delete modal, paged tables); a new merchant screen starts at its rows. `pnpm spec check` parses both tables and refuses an example no screen shows. `node scripts/copy-audit.ts` inventories the screens by slot for an audit.
- The parts table in the JSDoc on `ScreenPart` (`src/lib/Screen.ts`) is the spec for shape: one row per part (a component under `src/components/screen/`, or a Polaris element), what it fixes and the templates it is used on. Routes and the other components compose parts and lay out nothing: `scripts/rules-lint.ts` refuses `s-grid`, `s-stack`, `s-box`, `s-query-container` and every spacing or layout prop (`gap`, `padding*`, `gridTemplateColumns`, `className`, `style`) in `src/routes/` and in `src/components/` outside `src/components/screen/`, and the parts use only the three distances and one breakpoint in `src/components/screen/layout.ts`. A shape change starts at the row, then the part, then the kit page (`/dev/kit`, local only), then the screens; a screen that needs a shape no part has gets a part and a row. The Screens table's `template` column names each screen's `ScreenTemplate`.
- The triggers table in the JSDoc on `ShopUsage` (`src/lib/domain/Billing.ts`) is the spec for usage metering: one row per trigger, saying what it does to the order count, the seat mark and the usage-event queue, and the test that pins it. `pnpm spec check` parses it, refuses a count or mark word outside its lists, and refuses a title no test carries; a metering change starts at the row.
- The publish tables are the spec for the per-shop socket's invalidations: the cycle table on `InvalidatedMessage` (`src/lib/domain/Platform.ts`), the sites table on `ShopAgent.publish` (`src/lib/ShopAgent.ts`: every write that publishes, and when), and the events table on `useLiveQuery` (`src/lib/useLiveQuery.ts`: what the tab does with each event). The connection table on `ConnectionRole` (`src/lib/domain/Platform.ts`) is the socket's authorization rule: who the gate forwards, what the object stores, when it closes a connection and what the tab does then. One row per rule or site, and the test that pins it, in either test project. `pnpm spec check` parses all four, refuses a word outside each closed column's list, and refuses a title no test carries; a publish or connection change starts at the row.
- The data-model tables are the spec for both stores: the JSDoc on `initializeSchema` (`src/lib/ShopAgentSchema.ts`) for the Durable Object and on `D1_TABLES` (`src/lib/D1Schema.ts`) for D1. One row per structural rule, in the vocabulary's words, with `holds by` (schema, app, schema+app) and `pinned by` (a test title). `pnpm spec check` parses both and refuses a title no test carries. A structural change starts at the row, then the DDL or migration and the write paths, then the pinned test. A cross-store rule has a half on each table: the pointer's side says what dangling means, the row's side says what its delete does and in what order. A failing pinned test means the row and the code disagree; fix one of them, never delete the test. Behavioural rules stay on the `Domain` symbol.
- The map at the top of `src/lib/Domain.ts` names the contexts and what each may import; each context's vocabulary is at the top of its file under `src/lib/domain/`. `scripts/rules-lint.ts` refuses an import against the map's direction and a direct import of a context file from outside `src/lib/domain/`. The vocabulary holds the words. Use them in code, JSDoc, tests and research, and update it in the same change as any rename. `docs/vocabulary-runbook.md` is the procedure for adding, renaming and retiring a word; `scripts/rules-lint.ts` refuses a reserved stem ("active", "roster", "slot", "tier", ...) and an `is<State>` predicate without its noun in an exported identifier under `src/lib/`. A `…LoaderData` type lives in its route; `scripts/rules-lint.ts` refuses the export elsewhere. The `Shape families` table on the map names the suffix families (`Input`, `Command`, `Result`, screen data, `LoaderData`), where each lives and the symbol that holds its rule; `pnpm spec check` holds every export to its row, and `scripts/rules-lint.ts` refuses a model symbol whose code names a shape, so the shapes' dependency on the model stays one-way. `src/lib/agent/` has its own map, on `ShopAgentHost`.
- The Screens table in the vocabulary names every merchant and member screen; a JSDoc, test or research doc uses that name, never the route segment and never "run". `pnpm spec check` verifies each row's route file exists.
- Status, flag and role predicates are `Domain` functions, never inline comparisons in routes or the object (`scripts/rules-lint.ts`, run by `pnpm lint`, refuses them).
- A JSDoc must carry its reasoning inline and never reference files under `docs/` — research docs go stale and get deleted. External URLs are acceptable. A `refs/` path is acceptable because `refs/` is pinned to the dependency versions in use (`pnpm refs:check`); cite the file and, if needed, a heading or symbol name, never a line number, which does not survive a version bump.
- Do not git commit unless you are explicitly instructed.
- In the main checkout, commit to `main`. In a linked worktree, commit to that worktree's branch (`wt-NN`) and never check out `main` there; merging is done from the main checkout. Do not create other branches.
- Write replies, comments, and docs in plain, direct prose: no flourishes, hedging, or ornamental phrasing.

## Project

- `Baton` is a Shopify app for made-to-order production workflows, built with TanStack Start, Cloudflare, and Effect.
- Route modules are in `src/routes/` and use file route conventions.
- The parts every screen is built from are in `src/components/screen/` (the parts table on `ScreenPart`); the kit page, `src/routes/dev.kit.tsx` at `/dev/kit`, renders every part once with the seed's worst cases and exists only on the local dev server.
- Per-shop state lives in the `ShopAgent` Durable Object (`src/lib/ShopAgent.ts`) and its private SQLite; the class is the callable surface and the sync wiring, and what it does per context is a service under `src/lib/agent/` (`Host`, `Billing`, `Orders`, `ShopWork`), whose import direction `scripts/rules-lint.ts` holds; shared Shopify session state (`ShopSession`) lives in D1.

## Worktrees

Each git worktree has its own branch, port and Shopify dev store, all named by one index: the main worktree is 0 (`main`, port 3800, `sandbox-shop-00`); linked worktree `NN` is `wt-NN` (branch, folder and Herdr workspace), port `3800+NN`, store `sandbox-shop-NN`. `PORT` and `SHOPIFY_DEV_STORE` in `.env` say which worktree you are in; every script, the Playwright config and the Shopify CLI (through `BACKEND_PORT`) read them from there.

- `docs/worktrees-runbook.md` is the procedure: creating a linked worktree, the git cycle (`git merge --ff-only main` to start a task, `git rebase main` to take in `main`, `git merge --ff-only wt-NN` in the main worktree to merge back), and the rules for agents.
- In a linked worktree, do not merge into `main`, push, or touch another worktree's server.
- `refs` in a linked worktree is a symlink to the main checkout's `refs/`; `pnpm refs fetch` runs only in the main checkout.

## Port Configuration

Get the local dev server port by running:

```bash
pnpm port
```

Use this port in commands via command substitution:

```bash
playwright-cli --session="$(pnpm port)-localdev" open "http://localhost:$(pnpm port)"
```

## Refs

Downloaded source code of libraries are in `refs/` for reference.

### Reference Docs Locations

- **TanStack Start**: `refs/tan-start/docs/` (MDX files - start/framework/react)
- **TanStack Router**: `refs/tan-router/docs/` (MDX files - router/framework/react)
- **TanStack Query**: `refs/tan-query/docs/` (Markdown files - framework/react, reference, eslint)
- **TanStack Form**: `refs/tan-form/docs/` (Markdown files)
- **Cloudflare Docs**: `refs/cloudflare-docs/src/content/docs/` (MDX files)
- **Effect Docs**: `refs/effect/ai-docs/src/` (Effect v4 — "effect" means v4 here)
- **Better Auth**: `refs/better-auth/docs/content/docs/` (MDX docs; source in `refs/better-auth/packages/`)
- **Shopify App JS**: `refs/shopify-app-js/` (source for `shopify-api`, `shopify-app-react-router`, and session storage adapters)
- **Shopify Bridge**: `refs/shopify-bridge/`
- **Shopify CLI**: `refs/shopify-cli/`
- **Shopify Docs**: `refs/shopify-docs/`
- **Shopify Flow manual** (merchant help center): `refs/flow-manual/` (markdown; `reference/` has triggers, conditions, actions)
- **Workers SDK**: `refs/workers-sdk/` (source for `wrangler`, `@cloudflare/vite-plugin`, `vitest-pool-workers`)
- **Cloudflare CF**: `refs/cf/` (source for the `cf` CLI; `packages/cli/` is the CLI package)
- **Agents**: `refs/agents/` (source for the `agents` SDK; `packages/agents/CHANGELOG.md` is the upgrade record)
- **PartyKit**: `refs/partykit/` (the monorepo, pinned to the `partysocket` version `agents` depends on; `packages/partysocket/` is the reconnecting WebSocket client under `useAgent`, `packages/partyserver/` is the Durable Object runtime that `agents` vendors into `agents/lifecycle`)
- **Vitest**: `refs/vitest/`
- **Competitor apps** (opt-in): `refs/route-to-ship/`, `refs/kanbanify/`, `refs/makers-production-view/`, `refs/makerbatch/`, `refs/benchcue/`

## Commands

```bash
pnpm app:dev            # Start dev server via Shopify CLI (runs pnpm dev internally)
pnpm worktree:init      # Prepare a linked worktree: .env, refs link, install, local D1 (--index NN)
pnpm dev:start          # Start the dev server, or adopt the running one; install on the dev store if needed (--seed to seed)
pnpm dev:status         # Report the dev server: where it runs, port, tunnel, ShopSession (--json)
pnpm dev:stop           # Stop the dev server wherever it runs
pnpm dev:reset          # Stop, wipe local D1 and object state, start, install, seed (--no-seed to skip)
pnpm dev:logs           # Print recent Shopify CLI output and the tail of the Worker log
pnpm typecheck          # TypeScript type checking (includes wrangler types generation)
pnpm lint               # Run oxlint, scripts/rules-lint.ts (Domain predicates, retired copy, import maps, no layout outside src/components/screen/) and pnpm spec check
pnpm spec check         # Parse the action tables in domain/ShopWork.ts and the four sync tables on syncOrder in domain/Orders.ts, check the vocabulary in Domain.ts and domain/, its contexts, its screen columns and its stored cells against the DDL in ShopAgentSchema.ts, the data-model tables in ShopAgentSchema.ts and D1Schema.ts, the publish tables (InvalidatedMessage in domain/Platform.ts, publish in ShopAgent.ts, useLiveQuery), the connection table (ConnectionRole in domain/Platform.ts), the copy, controls and parts tables in Screen.ts, and the Screens table's template column (also run by pnpm lint)
pnpm spec print         # Render the parsed action tables, their fixture counts, and the data-model rows
pnpm vocab:audit        # List words in exported identifiers under src/lib/ that the vocabulary does not have (an audit, not a check)
node scripts/copy-audit.ts > docs/<name>.md   # Inventory every screen string by slot, as a markdown table to annotate (an audit, not a check)
pnpm fmt                # Format the repo with oxfmt (excludes refs/ and dist/)
pnpm test               # Run tests with Vitest: the integration project (workerd) and the browser project (headless Chromium, test/browser/)
pnpm test:browser       # The browser project alone (test:browser:headed for a visible browser)
npm run test:e2e --     # Full local E2E suite, headless; pass Playwright args after --
npm run test:e2e:headed -- # Same suite with visible browsers for debugging
pnpm graphql-codegen    # Validate #graphql template literal strings against the Shopify Admin schema
pnpm tail               # Tail deployed remote logs (raw logs/default-worker.log, compact logs/default-worker.compact.log)
pnpm seed               # Seed local dev data (members, teams, workflows) via /api/dev/seed (--showcase for the help's showcase shop)
pnpm d1:reset           # Recreate local D1 from migrations (wipes .wrangler)
pnpm refs:check         # Report refs/ that drifted from package.json pins
pnpm refs fetch <name>  # Refetch a ref (see scripts/refs.ts; refs:all for everything but opt-ins)
```

- Run typecheck and lint after generating code. Not necessary if just research.
- Run `pnpm graphql-codegen` after any change to `#graphql` template literal strings.
- Run `pnpm fmt` repo-wide and **keep every file it touches**, including files your change never went near. The whole repo should be formatted; reverting the incidental ones means the next agent reformats them, reverts them again, and the repo never converges. Reformatting is not scope creep.
- Only `pnpm fmt` writes formatting. Never hand-format, and never `git checkout` a file to undo it.

## Server Log Monitoring

Log files are named `<environment>-<source>[.compact].log`:

- `logs/local-worker.log` - Local Vite and Worker output (written by `pnpm dev`, which `pnpm app:dev` runs).
- `logs/local-cli.log` - Shopify CLI output when `pnpm dev:start` runs it in the background (outside Herdr, with no terminal). Inside Herdr the CLI runs in the `server` tab; read it with `pnpm dev:logs`.
- `logs/default-worker.log` - Raw remote logs of the top-level deployed Worker (written by `pnpm tail`).
- `logs/default-worker.compact.log` - Same stream through `scripts/wrangler-tail-compact.jq`: one `timestamp<TAB>level<TAB>message` line per event.

Use `tail -f logs/local-worker.log` locally, `tail -f logs/default-worker.compact.log` for readable remote logs, or `tail -f logs/default-worker.log` for raw Cloudflare JSON. `pnpm tail:staging` / `pnpm tail:PRODUCTION` write the same pair as `logs/staging-worker*.log` / `logs/production-worker*.log`.

## Logging

- Use Effect logging: `Effect.logInfo`, `Effect.logWarning`, `Effect.logError`, `Effect.logDebug`.
- Pass a single string message to `Effect.log*`; put structured fields in `Effect.annotateLogs({ ... })`.
- Do not use two-argument log calls like `Effect.logError(message, { error })`; Cloudflare Workers Logs may show a blank Message column when `consoleJson` receives array messages.
- Make the message scannable for humans and annotations queryable for machines: if a value appears in the message, also keep it in `Effect.annotateLogs`.
- For shop-scoped logs, include shop in the message as `shop=<shop>` and in annotations as `{ shop }`.
- Preferred message format: `<operation>: shop=<shop> key=<value>: <detail>`.
- Use stable `key=value` fields in messages for bounded identifiers like `shop`, `step`, `topic`, `status`, `attempt`, `workflowId`.
- Do not put large or unbounded values in the message: full URLs, payloads, raw events, GraphQL bodies. Keep those in annotations when needed.

Examples:

```ts
Effect.logInfo(`ShopAgent.bump: shop=${this.name} count=${count}`).pipe(
  Effect.annotateLogs({ shop: this.name, count }),
);

Effect.logError(`ShopAgent.getShopInfo: shop=${this.name}: ${message}`).pipe(
  Effect.annotateLogs({ shop: this.name, message }),
);
```

## TypeScript Guidelines

- Always follow functional programming principles and effect patterns and idioms (refs/effect).
- Prefer immutable data (const, readonly)
- **Path aliases**: Use `@/*` for `src/*` imports (configured in tsconfig.json)

## SQL Guidelines

- SQLite in two places: Cloudflare D1 (shared `ShopSession` state) and each `ShopAgent` Durable Object's private SQLite.
- Use lowercase for all sql keywords.
- Use positional parameter placeholders.

## TanStack

- TanStack typing is world-class. You should not need to type cast and should let typescript infer types wherever possible.
- Start loaders are isomorphic so generally create a server fn with server logic and call it from loader.
- **beforeLoad vs loader**: Use `beforeLoad` for route guards (auth, authorization) - returns merge into context. Use `loader` for data fetching - route-specific, parallel execution.
- **Execution order**: `beforeLoad` runs sequentially parent→child. `loader` runs in parallel across all active routes after beforeLoad completes.

## Playwright CLI

Routine E2E test execution is headless: use `npm run test:e2e --`. Use `npm run test:e2e:headed --` when a visible test browser is needed for debugging. Both commands run the embedded, admin, member and public projects against local development.

The e2e seed replaces the dev shop's data (members, teams, workflows, orders). Run `pnpm seed` after any e2e run before using the dev store or taking screenshots; until then the seed's members (`lead@m.com`, ...) are gone.

For interactive browser exploration with `playwright-cli`, default to headless mode (omit `--headed`). Use `--headed` when the user requests a visible browser or manual interaction is needed, such as signing in.

Run it through the package script: `pnpm playwright-cli`.

Wait for `body[data-hydrated="true"]` before any fill or click; until then input and clicks are silently dropped (see `awaitHydration` in `e2e/hydration.ts`).

**Session naming:** `{port}-{purpose}` (e.g., `$(pnpm port)-localdev`, `$(pnpm port)-testing`)

```bash
# Open headless (default)
pnpm playwright-cli --session="$(pnpm port)-localdev" open "http://localhost:$(pnpm port)"

# Subsequent commands use the same session
pnpm playwright-cli --session="$(pnpm port)-localdev" type "Hello World"
pnpm playwright-cli --session="$(pnpm port)-localdev" click "button.submit"

# Session management
pnpm playwright-cli list
pnpm playwright-cli delete-data --session "$(pnpm port)-localdev"
```

## Do Not Edit

The following are auto-generated or externally managed:

- `src/routeTree.gen.ts` - Generated by TanStack Router
- `worker-configuration.d.ts` - Generated by Wrangler
- `refs/` directory - External reference code (excluded from TypeScript/linting)
