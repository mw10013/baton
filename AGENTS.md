# AGENTS.md

- Prefer JSDoc for complex and subtle behavior the code cannot show, and for rules: any behaviour more than one site must agree on is stated once, normatively, on the symbol that enforces it or the symbol that is the concept. Other sites `{@link}` it rather than restate it; a site that follows a different rule says so and why. Status, flag and role predicates are `Domain` functions, never inline comparisons in routes or the object (`scripts/rules-lint.ts`, run by `pnpm lint`, refuses them). Each rule has a test whose title is the rule. A JSDoc must carry its reasoning inline and never reference files under `docs/` — research docs go stale and get deleted. External URLs are acceptable. A `refs/` path is acceptable because `refs/` is pinned to the dependency versions in use (`pnpm refs:check`); cite the file and, if needed, a heading or symbol name, never a line number, which does not survive a version bump.
- Do not git commit unless you are explicitly instructed.
- Commit to `main`. Do not create branches.
- Please remove all mannered prose

## Project

- `Baton` is a Shopify app for made-to-order production workflows, built with TanStack Start, Cloudflare, and Effect.
- Route modules are in `src/routes/` and use file route conventions.
- Per-shop state lives in the `ShopAgent` Durable Object (`src/lib/ShopAgent.ts`) and its private SQLite; shared Shopify session state (`ShopSession`) lives in D1.

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
- **Effect Docs**: `refs/effect/ai-docs/src/` (Effect v4 release candidate — "effect" means v4 here)
- **Better Auth**: `refs/better-auth/docs/content/docs/` (MDX docs; source in `refs/better-auth/packages/`)
- **Shopify App JS**: `refs/shopify-app-js/` (source for `shopify-api`, `shopify-app-react-router`, and session storage adapters)
- **Shopify Bridge**: `refs/shopify-bridge/`
- **Shopify CLI**: `refs/shopify-cli/`
- **Shopify Docs**: `refs/shopify-docs/`
- **Shopify Flow manual** (merchant help center): `refs/flow-manual/` (markdown; `reference/` has triggers, conditions, actions)
- **Workers SDK**: `refs/workers-sdk/` (source for `wrangler`, `@cloudflare/vite-plugin`, `vitest-pool-workers`)
- **Agents**: `refs/agents/` (source for the `agents` SDK; `packages/agents/CHANGELOG.md` is the upgrade record)
- **PartyKit**: `refs/partykit/` (the monorepo, pinned to the `partysocket` version `agents` depends on; `packages/partysocket/` is the reconnecting WebSocket client under `useAgent`, `packages/partyserver/` is the Durable Object runtime agents 0.22.0 vendored into `agents/lifecycle`)
- **Vitest**: `refs/vitest/`
- **Competitor apps** (opt-in): `refs/route-to-ship/`, `refs/kanbanify/`, `refs/makers-production-view/`, `refs/makerbatch/`, `refs/benchcue/`

## Commands

```bash
pnpm app:dev            # Start dev server via Shopify CLI (runs pnpm dev internally)
pnpm typecheck          # TypeScript type checking (includes wrangler types generation)
pnpm lint               # Run oxlint
pnpm fmt                # Format the repo with oxfmt (excludes refs/ and dist/)
pnpm test               # Run tests with Vitest.
npm run test:e2e --     # Full local E2E suite, headless; pass Playwright args after --
npm run test:e2e:headed -- # Same suite with visible browsers for debugging
pnpm graphql-codegen    # Validate #graphql template literal strings against the Shopify Admin schema
pnpm tail               # Tail deployed remote logs (raw logs/tail.log, compact logs/tail-compact.log)
pnpm seed               # Seed local dev data (members, teams, workflows) via /api/dev/seed
pnpm d1:reset           # Recreate local D1 from migrations (wipes .wrangler)
pnpm refs:check         # Report refs/ that drifted from package.json pins
pnpm refs fetch <name>  # Refetch a ref (see scripts/refs.ts; refs:all for everything but opt-ins)
```

- Run typecheck and lint after generating code. Not necessary if just research.
- Run `pnpm graphql-codegen` after any change to `#graphql` template literal strings.
- Run `pnpm fmt` repo-wide and **keep every file it touches**, including files your change never went near. The whole repo should be formatted; reverting the incidental ones means the next agent reformats them, reverts them again, and the repo never converges. Reformatting is not scope creep.
- Only `pnpm fmt` writes formatting. Never hand-format, and never `git checkout` a file to undo it.

## Server Log Monitoring

- `logs/server.log` - Local dev server logs (written by `pnpm dev`).
- `logs/tail.log` - Raw remote logs (written by `pnpm tail`).
- `logs/tail-compact.log` - Same stream through `scripts/wrangler-tail-compact.jq`: one `timestamp<TAB>level<TAB>message` line per event.

Use `tail -f logs/server.log` locally, `tail -f logs/tail-compact.log` for readable remote logs, or `tail -f logs/tail.log` for raw Cloudflare JSON. `pnpm tail:staging` / `pnpm tail:PRODUCTION` write the same pair as `logs/staging*.log` / `logs/production*.log`.

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

- Using sqlite with Cloudflare D1.
- Use lowercase for all sql keywords.
- Use positional parameter placeholders.

## TanStack

- TanStack typing is world-class. You should not need to type cast and should let typescript infer types wherever possible.
- Start loaders are isomorphic so generally create a server fn with server logic and call it from loader.
- **beforeLoad vs loader**: Use `beforeLoad` for route guards (auth, authorization) - returns merge into context. Use `loader` for data fetching - route-specific, parallel execution.
- **Execution order**: `beforeLoad` runs sequentially parent→child. `loader` runs in parallel across all active routes after beforeLoad completes.

## Playwright CLI

Routine E2E test execution is headless: use `npm run test:e2e --`. Use `npm run test:e2e:headed --` when a visible test browser is needed for debugging. Both commands run the embedded, admin, and member projects against local development.

For interactive browser exploration with `playwright-cli`, default to headless mode (omit `--headed`). Use `--headed` when the user requests a visible browser or manual interaction is needed, such as signing in.

Run it through the package script: `pnpm playwright-cli`.

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
