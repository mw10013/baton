# AGENTS.md

- Prefer JSDoc for comments for complex and subtle behavior the code cannot show. A JSDoc must carry its reasoning inline and must never reference files under `docs/` — research docs go stale and get deleted. External URLs and `refs/` paths are acceptable.
- Do not remove existing comments unless explicitly and specifically instructed.
- Do not git commit unless you are explicitly instructed.
- Commit to `main`. Do not create branches.
- Your answers and explanations should be concise and scannable so the user can scan quickly and easily understand. Scarifice grammar for the sake of concision.
- Ground your answers and explanations with excerpts from documentation and code.

## Project

- `Baton` is a Shopify app for made-to-order production workflows, built with TanStack Start, Cloudflare, and Effect v4.
- Route modules are in `src/routes/` and use file route conventions.
- Per-shop state lives in the `ShopAgent` Durable Object (`src/lib/ShopAgent.ts`) and its private SQLite; shared Shopify session state (`ShopSession`) lives in D1.
- Billing code is present but gated: `BILLING_ENABLED` is `"false"` in `wrangler.jsonc`, so `SubscriptionPlan` grants every shop the default plan without calling the Partner API.

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
- **Workers SDK**: `refs/workers-sdk/`
- **Vitest**: `refs/vitest/`
- **Competitor apps** (opt-in): `refs/route-to-ship/`, `refs/kanbanify/`, `refs/makers-production-view/`, `refs/makerbatch/`, `refs/benchcue/`

## Commands

```bash
pnpm app:dev            # Start dev server via Shopify CLI (runs pnpm dev internally)
pnpm typecheck          # TypeScript type checking (includes wrangler types generation)
pnpm lint               # Run oxlint
pnpm test               # Run tests with Vitest.
npm run test:e2e --     # Playwright via npm (uses pnpm exec in script); pass args after -- and may be helpful to use --trace on
pnpm graphql-codegen    # Validate #graphql template literal strings against the Shopify Admin schema
pnpm tail               # Tail deployed remote logs (raw logs/tail.log, compact logs/tail-compact.log)
pnpm d1:reset           # Recreate local D1 from migrations (wipes .wrangler)
pnpm refs:check         # Report refs/ that drifted from package.json pins
pnpm refs fetch <name>  # Refetch a ref (see scripts/refs.ts; refs:all for everything but opt-ins)
```

- Run typecheck and lint after generating code. Not necessary if just research.
- Run `pnpm graphql-codegen` after any change to `#graphql` template literal strings.

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

- Always follow functional programming principles and effect v4 patterns and idioms.
- Use interfaces for data structures and type definitions
- Prefer immutable data (const, readonly)
- Use optional chaining (?.) and nullish coalescing (??) operators
- **Do not add any comments to generated code.** Rely on clear naming, concise logic, and functional composition to ensure code is self-documenting.
- Employ a concise and dense coding style. Prefer inlining expressions, function composition (e.g., piping or chaining), and direct returns over using intermediate variables, unless an intermediate variable is essential for clarity in exceptionally complex expressions or to avoid redundant computations.
- Inline types when practical instead of introducing extra interfaces or type aliases.
- Avoid intermediate variables that are not necessary for clarity.
- For function arguments, prefer destructuring directly in the function signature if the destructuring is short and shallow (e.g., `({ data: { value }, otherArg })`). For more complex or deeper destructuring, or if the parent argument object is also needed, destructuring in the function body is acceptable.
- Import modules as namespace objects and access members through them (`Effect.gen`, `Schema.String`, `Domain.MemoryKey`) — never cherry-pick individual functions (`import { gen } from "effect/Effect"`). For `effect`, use named module imports from the barrel (`import { Effect, Schema, Layer } from "effect"`) — the documented v4 style; those named exports are module namespaces. Use `import * as X` for local modules (`import * as Domain from "@/lib/Domain"`) and libraries without namespace re-exports (`import * as ShopifyApi from "@shopify/shopify-api"`).
- **Strict mode enabled**: All strict TypeScript checks are on
- **No unused variables/parameters**: Prefix with `_` if intentionally unused
- **Type imports**: Use `import type` for type-only imports when possible
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

**Default to headed mode** (visible browser) unless the user explicitly requests headless. Use `--headed` flag.

Run it through the package script: `pnpm playwright-cli`.

**Session naming:** `{port}-{purpose}` (e.g., `$(pnpm port)-localdev`, `$(pnpm port)-testing`)

```bash
# Open with headed browser (default for LLM use)
pnpm playwright-cli --headed --session="$(pnpm port)-localdev" open "http://localhost:$(pnpm port)"

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
