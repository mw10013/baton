# AGENTS.md

## Project
Baton: embedded Shopify admin app for made-to-order production workflows. We are porting `refs/baton-legacy` into it.

## Git
- Do not git commit unless you are explicitly instructed.
- Commit only to the branch checked out where you work: `main` in the main checkout, `wt-NN` in a worktree. Create no other branches, except a new `wt-NN` when setting up a worktree.

## Toolchain
Vite+. Never npm or npx.
- Run `vp check --fix` after code changes (format, lint, type check). Plain `vp check` is for CI or read-only verification.
- Tests: `vp test` (unit, browser, integ); `vp run test:e2e` (e2e).

## Effect
- Validation, parsing, encoding: Effect Schema. Never trim, length-check or regex-test input by hand.
- Tag dispatch: `Match`. Errors: `Schema.TaggedError`. Reusable effects: `Effect.fn("name")`.
- Effect's own idiom guide is in `refs/effect/ai-docs/src` and `refs/effect/LLMS.md`.

## Comments
- Document a declaration with JSDoc on the symbol, never a `//` above it: JSDoc shows on hover and at every use, and its `{@link}`s follow renames.
- JSDoc says what the code cannot: a rule, a non-obvious why, a platform or library constraint. Never what the name and type already say.
- State a rule once, on the symbol that enforces it or is the concept. Other sites `{@link}` it instead of restating it; a site that deviates says so and why.
- Reference code with `{@link Symbol}`, never a file name. A link resolves only to a symbol in scope (declared or imported, `{@link Module.member}` included); never import just for a link, name the symbol in backticks instead. `@see` for an external URL or a `refs/` path (file plus heading or symbol, never a line number).
- Tags: `{@link}`, `@see`, `@example` for a pattern to copy, `@deprecated`. `@param`/`@returns` only when a parameter means something its type does not. No `@throws`: Effect errors are in the type.
- `//` only for a why that belongs to one line or branch inside a body.
- Never reference plans or research docs; they go stale and get deleted. State the reason in the comment itself.

## Dev server
Start with `vp run dev`. Open `http://localhost:$(pnpm port)`. Plain `vp dev` is blocked because it bypasses Alchemy.

## Logs
Dev logs: `.logs/dev/current`. Rotated archives: `.logs/dev/`.
E2E server logs: `.logs/e2e/current`. Rotated archives: `.logs/e2e/`.
Staging logs: use `cf o11y telemetry query` on `cloudflare-workers`, filtering `$metadata.service` to `baton-website-staging` (Website) or `baton-backend-staging` (Backend).

## Browser checks
- Playwright CLI or Chrome MCP: choose as useful for implementation and verification. CLI setup, cleanup and recovery: [runbook](docs/playwright-cli-runbook.md). Start with `vp run browser open`; it drives the agent Chrome, never your own.

## Logging
- One string message: `<operation>: shop=<shop> key=<value>: <detail>`. Structured fields go in `Effect.annotateLogs`; `shop` goes in both.

## SQL
- Lowercase keywords, positional parameters (the `sql` template's interpolations), never values spliced into the text.
- Price a query or schema change at the marginal rate: rows read and rows written per call, times how often it runs. Never weigh cost against a plan's included allowance; that allowance is shared by every shop and Worker on the account.

## UI: Polaris web components
- Layout lives only in named parts under `src/web/components/screen/`. Elsewhere, no `s-stack`, `s-grid`, `s-box` or layout props (`gap`, `padding`, …); a new shape is a new part.
- Outside the Shopify admin nothing intercepts Polaris anchors: navigate with a TanStack `<Link>`, or `href` plus an `onClick` that calls the router.
