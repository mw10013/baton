# Oxlint rule packs for Baton

## Executive answer

Baton already has broad lint coverage. It enables 457 native Oxlint rules plus
nine TanStack JavaScript-plugin rules. In particular, the native `react` pack
already includes React Hooks and React Compiler diagnostics. Adding a generic
React ESLint plugin would mostly duplicate what is present.

The best additions are narrow rather than entire packs:

1. Add native `react/unsupported-syntax` as a warning. It is the one official
   React Compiler recommended diagnostic that Baton's current category choices
   leave off. It reports no findings on the current tree.
2. Consider selected native `import` correctness rules, especially
   `import/no-duplicates`, `import/no-self-import`, `import/no-cycle`,
   `import/export`, `import/named`, and `import/namespace`. Do not enable the
   whole pack under the current categories.
3. Consider a small native Vitest override for focused or disabled tests and
   structurally invalid suites. Do not enable the whole pack, and do not assume
   its normal `expect` rules understand `@effect/vitest`.
4. If E2E linting is worth accepting Oxlint's alpha JavaScript-plugin boundary,
   `eslint-plugin-playwright` is the strongest external-plugin candidate. It
   catches missing `await`, stale page APIs, unsafe `evaluate` references, and
   weak locator/assertion patterns. Oxlint explicitly conformance-tests it.
5. For Effect, evaluate `@effect/language-service` rather than an Oxlint rule
   pack. Effect's useful diagnostics are type-aware and cannot run through
   Oxlint JavaScript plugins.

There is no useful official Cloudflare lint pack to add. Cloudflare's main lint
recommendation is `typescript/no-floating-promises`, which Baton already runs,
and its main correctness mechanism is Wrangler-generated runtime and binding
types, which Baton's `typecheck` script already regenerates.

Recommendation: if this research leads to implementation, make one small
change at a time in this order: `react/unsupported-syntax`, selected import
rules, selected Vitest rules, then an isolated Playwright plugin trial. Treat
Effect language-service adoption as a separate type-checking decision.

## Scope and date

Research was performed on 26 September 2026 against:

- Baton's pinned `oxlint` 1.82.0 and `oxlint-tsgolint` 7.0.2001
- the source pinned at `refs/oxlint`, tag `oxlint_v1.82.0`
- Baton's installed TanStack plugin versions
- current official React, TanStack, Effect, Cloudflare, Vitest, and Oxlint
  documentation
- current external plugin documentation where no official/native pack exists

Web package versions can change independently of Baton's exact pins. Findings
about what Baton runs use the local lockfile and source. Findings about possible
future additions use the web snapshot above.

Primary web sources:

- [Oxlint built-in plugins](https://oxc.rs/docs/guide/usage/linter/plugins)
- [Oxlint JavaScript plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins)
- [Oxlint React Compiler support](https://oxc.rs/blog/2026-08-18-react-compiler-support)
- [React Hooks lint reference](https://react.dev/reference/eslint-plugin-react-hooks)
- [TanStack Query ESLint plugin](https://tanstack.com/query/latest/docs/eslint/eslint-plugin-query)
- [TanStack Router ESLint plugin](https://tanstack.com/router/latest/docs/eslint/eslint-plugin-router)
- [TanStack Start ESLint plugin](https://tanstack.com/start/latest/docs/framework/react/eslint/eslint-plugin-start)
- [Effect development tools](https://effect.website/docs/getting-started/devtools/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/)
- [Vitest ESLint plugin](https://github.com/vitest-dev/eslint-plugin-vitest)
- [Playwright ESLint plugin](https://github.com/mskelton/eslint-plugin-playwright)

## What Baton already runs

### Native packs

`.oxlintrc.json` enables:

- `eslint`
- `typescript`
- `unicorn`
- `oxc`
- `react`
- `jsx-a11y`

The configured categories are:

- `correctness`: error
- `suspicious`: warning
- `pedantic`: warning
- `style`: warning

`perf`, `restriction`, and `nursery` are off. Individual rules then add stricter
project choices. Type-aware mode is enabled through `options.typeAware`, backed
by `oxlint-tsgolint` and TypeScript 7.

`oxlint --print-config` resolves 457 active native rules:

| Native pack           |  Errors | Warnings |   Total |
| --------------------- | ------: | -------: | ------: |
| ESLint core           |      60 |       75 |     135 |
| TypeScript            |      41 |       57 |      98 |
| Unicorn               |      13 |       99 |     112 |
| Oxc                   |      14 |        5 |      19 |
| React and React Hooks |      31 |       27 |      58 |
| JSX accessibility     |      35 |        0 |      35 |
| **Total**             | **194** |  **263** | **457** |

This count is before file overrides and before the TanStack JavaScript rules.

### TanStack JavaScript plugins

Baton loads:

- `@tanstack/eslint-plugin-router` 1.162.0
- `@tanstack/eslint-plugin-query` 5.102.8

The configured Router rules exactly match that installed package's recommended
set:

- `create-route-property-order`: warning
- `route-param-names`: error

The configured Query rules exactly match that installed package's recommended
set:

- `exhaustive-deps`
- `no-rest-destructuring`
- `stable-query-client`
- `no-unstable-deps`
- `infinite-query-property-order`
- `no-void-query-fn`
- `mutation-property-order`

The only current strict-only Query rule not enabled is
`prefer-query-options`.

## React

### Coverage is already strong

Oxlint's native `react` pack combines rules from `eslint-plugin-react`,
`eslint-plugin-react-hooks`, React Refresh, and React Compiler. Baton's active
rules include the familiar Hooks rules and the current compiler diagnostics:

- `rules-of-hooks`
- `exhaustive-deps`
- `error-boundaries`
- `globals`
- `immutability`
- `incompatible-library`
- `preserve-manual-memoization`
- `purity`
- `refs`
- `set-state-in-effect`
- `set-state-in-render`
- `static-components`
- `use-memo`
- `void-use-memo`

They also include useful native suspicious checks such as `capitalized-calls`,
`exhaustive-effect-dependencies`, `hooks`, and `memo-dependencies`.

React states that compiler diagnostics are useful even when a project has not
enabled the compiler. A diagnostic means the compiler would skip that component
while continuing to optimize safe components; adoption can therefore be
incremental. Baton's use of these rules is valid even though Vite is not
currently configured to compile with React Compiler.

### The one recommended gap

React's official recommended set includes `unsupported-syntax`. Oxlint maps it
to the `restriction` category, which Baton does not enable. Oxlint's other
official recommended compiler diagnostics are in `correctness` and are already
active.

An explicit trial of `react/unsupported-syntax` against `src` produced no
findings. It is therefore a low-cost warning to add. It protects future React
Compiler adoption without requiring the entire `restriction` category.

Oxlint does not implement upstream `config` or `gating`: Oxlint uses fixed
compiler options and does not expose compiler gating. There is nothing Baton
needs to install to fill those gaps.

### Do not add `react-perf` broadly

The native `react-perf` pack contains rules against new functions, objects,
arrays, and JSX values passed as props. A focused trial of three rules produced
181 findings, overwhelmingly ordinary inline event handlers.

These rules push code toward `useCallback` and memoization based on syntax,
without evidence that a child is memoized or the allocation is expensive. That
conflicts with Baton's React guidance not to add `useMemo` or `useCallback` by
default and overlaps with compiler-based analysis that has more semantic
context.

Recommendation: do not enable `react-perf`. Use profiling to justify a local
optimization before adding a narrow rule or suppression.

### Other compiler rules

`react/rule-suppression` found two existing, justified
`react-hooks/exhaustive-deps` disable comments. It can make suppressions visible,
but it treats intentional escape hatches as compiler optimization failures.
That is not useful as a general error here.

Recommendation: leave `rule-suppression`, `invariant`, `syntax`, and `todo` off
unless React Compiler itself is adopted and compiler coverage becomes an
explicit project objective.

## TanStack

### Router: recommended set is complete

The installed Router plugin exposes and recommends the two rules Baton already
configures. Neither requires TypeScript parser services. No Router addition is
needed.

The rendered Router documentation currently lists only
`create-route-property-order`, while the installed package source also
recommends `route-param-names`. The package source is authoritative for Baton's
pin, and the configuration already follows it.

### Query: recommended set is complete, compatibility is not

Baton has every rule in the installed Query recommended set. The strict preset
adds only `prefer-query-options`, which requires every query key and query
function to be co-located in a `queryOptions` or `infiniteQueryOptions` factory.
This can prevent the same key from drifting across different query functions,
but it also imposes an extraction pattern on one-off queries.

Recommendation: leave `prefer-query-options` off unless reusable query option
factories become a deliberate architecture rule. A trial produced no findings,
so enabling it would currently be cheap, but its value is also limited with only
two direct `useQuery` sites.

Two configured Query rules deserve a compatibility note:

- `no-void-query-fn` requires `parserServices.program` and the TypeScript node
  map. Oxlint gives JavaScript plugins no TypeScript parser services, so this
  rule returns without reporting.
- `no-rest-destructuring` works for direct imported Query hooks, but its typed
  recognition of custom hooks is unavailable under Oxlint.

Oxlint's native type-aware mode does not fix this. `oxlint-tsgolint` runs native
`typescript/*` rules; it does not expose type services to JavaScript plugins.
The configured `no-void-query-fn` therefore looks stronger than it is.

Recommendation: do not add ESLint solely for this one missing Query check. Keep
query functions explicitly returning values and rely on TypeScript where it can
infer the callback. Revisit only if void query functions become a recurring
defect.

### Start: useful rules, incompatible execution model

The official `@tanstack/eslint-plugin-start` provides:

- `no-client-code-in-server-component`
- `no-async-client-component`

Both call TypeScript parser services and inspect resolved types/program state.
They cannot run through Oxlint's JavaScript-plugin mode. Supporting them means a
separate typed ESLint pass, with its own parser, configuration, dependencies,
and runtime cost.

Recommendation: do not add a second linter preemptively. Consider a narrow
ESLint pass only if server/client boundary mistakes appear in practice or the
Start plugin grows checks with clear value that Oxlint cannot supply.

### Form: no official pack found

No official TanStack Form lint plugin or rule pack was found. Query rules do not
generalize to Form.

## Effect

### The official useful tool is type-aware

Effect's official guidance points to `@effect/language-service`. It provides
editor diagnostics for:

- floating Effect values
- missing or leaking service and Layer requirements
- incorrect error-channel handling
- redundant `Effect.gen` and pipe usage
- version conflicts
- Effect-specific refactors and completions

Effect explains that almost all of these diagnostics require types. Its build
integration patches the local TypeScript installation so the same diagnostics
can run during normal type checking. This is a fundamentally better fit than an
Oxlint JavaScript plugin, which cannot access TypeScript types.

The pinned Effect source itself configures `@effect/language-service` in its
TypeScript configurations. Baton does not currently install or configure it.

Recommendation: `@effect/language-service` is the highest-value Effect-specific
candidate, but evaluate it separately from Oxlint. Verify compatibility with
Baton's exact Effect 4 RC and TypeScript 7 pins, then decide whether editor-only
diagnostics or patched build diagnostics are acceptable. Patching TypeScript is
a supply-chain and maintenance decision and should not be introduced as an
incidental lint dependency.

### Official Effect Oxlint code is private monorepo tooling

The pinned Effect repository contains `@effect/oxc`, but its package is private,
versioned `0.0.0`, and constrained to TypeScript below 7. Its five rules are
mostly Effect repository conventions:

- `no-bigint-literals`
- `no-import-from-barrel-package`
- `no-js-extension-imports`
- `no-opaque-instance-fields`
- `no-unused-internal`

`no-import-from-barrel-package` would conflict with Baton's intentional and
pervasive imports from `"effect"`. This is evidence of Effect's internal style,
not a supported consumer preset.

Recommendation: do not copy or vendor this private pack.

### Third-party Effect Oxlint packs

At least two community Effect v4 Oxlint packs now exist. The most visible,
`@mpsuesser/oxlint-plugin-effect`, advertises 73 syntax and architecture rules.
Examples include forbidding native fetch, direct JSON, barrel imports, React
hooks, nullish types, loops, `try/catch`, `Date.now`, direct Node services, and
ordinary object helpers.

This is a personal architecture preset, not an official Effect standard. Its
recommended configuration enables every rule as an error. Several rules
directly conflict with Baton:

- Baton is a React application and intentionally uses React hooks.
- Baton uses Cloudflare-native `fetch` and platform APIs.
- Baton intentionally imports namespaces from the `effect` barrel.
- Baton uses null at storage and external API boundaries.
- Tooling scripts legitimately use Node filesystem and path APIs.
- Baton's Domain code uses both Effect matching and ordinary language control
  flow where each is clearer.

Some individual ideas, such as `throw-in-effect-gen`,
`effect-promise-vs-trypromise`, `prefer-duration-constructors`, and
`require-effect-concurrency`, may be worth reviewing manually. Adopting the
pack for four rules still takes on a young third-party dependency through
Oxlint's alpha plugin API.

Recommendation: do not add a community Effect pack now. First evaluate the
official language service. If a specific recurring code-shape problem remains,
assess one third-party rule on its own merits rather than extending a preset.

## Cloudflare Workers

### No supported lint pack

Cloudflare does not publish a current, supported Workers ESLint or Oxlint pack
for application projects. The old `eslint-plugin-cflint` has only two generic
rules and is not Workers runtime guidance. Internal Workers SDK lint
configuration is not a public consumer contract.

Cloudflare's current guidance emphasizes:

- generating `Env` and runtime types with `wrangler types`
- matching types to the compatibility date and flags
- testing in workerd with the Cloudflare Vitest integration
- always awaiting, returning, or passing Promises to `waitUntil`
- avoiding request-scoped mutable state at module scope
- using runtime bindings rather than REST APIs for Cloudflare services

### Baton already has the important pieces

Baton's `typecheck` runs `wrangler types` before TypeScript. The generated
`worker-configuration.d.ts` is in `tsconfig.json`, `nodejs_compat` is explicitly
enabled, and integration tests run in the Workers pool.

Most importantly, type-aware `typescript/no-floating-promises` is already
active. Cloudflare's own best-practices page names that exact Oxlint rule.

Recommendation: add no Cloudflare lint plugin. Continue treating Wrangler
types, type checking, and workerd tests as the runtime contract. If global
request-state bugs appear, a small project rule could be considered, but no
third-party pack found is authoritative enough to introduce now.

## Test rule packs

### Native Vitest: useful only when scoped and selected

Oxlint 1.82.0 has a native `vitest` pack with broad coverage. It is preferable
to loading `@vitest/eslint-plugin` through the alpha JavaScript bridge.

Enabling the pack globally under Baton's current categories produced 1,190
findings and misidentified Playwright files and ordinary source APIs as Vitest.
It also enabled mutually opposed import-style policies. The pack must be scoped
to `test/**/*.test.{ts,tsx}` and configured deliberately.

Several recommended rules do not fit Baton's test stack without options or
fixes in the rule implementation:

- `expect-expect` reports tests that use Node assertions or Effect testing
  helpers rather than Vitest's `expect`.
- `no-standalone-expect` misreads `expect` inside `it.effect` and nested
  `Effect.gen` callbacks as outside a test.
- `valid-title` rejects generated matrix titles even though dynamic test names
  are intentional executable-spec output.
- `valid-expect` produced findings around nonstandard Effect test patterns that
  need manual classification before adoption.

Good low-coupling candidates are:

- `vitest/no-focused-tests`: error
- `vitest/no-disabled-tests`: warning or error, depending on skip policy
- `vitest/valid-describe-callback`: error
- `vitest/valid-expect-in-promise`: error
- `vitest/no-identical-title`: error
- `vitest/no-import-node-test`: error

A narrowed trial of focused/disabled tests and structural callbacks produced no
findings. That is a clean baseline, though `forbidOnly`-style protection may be
more important for Playwright than Vitest because CI already executes the
Vitest suite in one mode.

Recommendation: add a minimal native override only if preventing `.only` and
`.skip` from entering the tree is an explicit policy. Do not enable the Vitest
recommended or all preset wholesale.

### Playwright: strongest external plugin candidate

Oxlint has no native Playwright pack. The community-maintained
`eslint-plugin-playwright` is nevertheless a credible JavaScript-plugin
candidate because Oxlint runs it in its conformance suite. Oxlint 1.82.0's
pinned snapshot reports 57 of 58 rules fully passing against the tested plugin
version; the partial case is `valid-test-tags` with regex-valued options.

The valuable rules include:

- `missing-playwright-await`
- `no-focused-test`
- `no-skipped-test`
- `no-page-pause`
- `no-networkidle`
- `no-wait-for-timeout`
- `no-wait-for-selector`
- `no-unsafe-references`
- `no-unused-locators`
- `prefer-locator`
- `prefer-web-first-assertions`
- `valid-expect`

These address mistakes TypeScript does not always catch. Missing `await` and
non-web-first assertions are especially relevant in a large browser suite.

Costs:

- one new JavaScript-plugin dependency
- Oxlint JavaScript plugins are alpha
- the installed current plugin may be newer than Oxlint's conformance fixture
- the recommended preset includes style and test-structure opinions that may
  conflict with Baton's established E2E helpers
- it must be scoped to `e2e/**/*.spec.ts` and setup files intentionally

Recommendation: this is worth a separate trial. Start with the recommended
rules in report-only mode, classify every finding, then retain only defect
prevention rules. Avoid regex options for `valid-test-tags` until tested against
the exact pair of versions.

## Native packs not recommended broadly

### Import

The native `import` pack is the most promising missing general pack, but
enabling it under Baton's category settings produced 2,489 findings. Most came
from policies Baton does not want: no named exports, no namespace imports,
default-export preference, exports last, dependency-count limits, and no Node
imports.

A narrow trial found three `import/no-duplicates` findings that can be fixed by
combining imports. `import/default` also falsely rejected Vite `?raw` modules,
so resolver-sensitive rules need care around virtual modules.

Recommendation: enable only selected correctness rules and explicitly keep
opinionated style rules off. Candidate set:

```json
{
  "import/export": "error",
  "import/named": "error",
  "import/namespace": "error",
  "import/no-cycle": "error",
  "import/no-duplicates": "error",
  "import/no-self-import": "error"
}
```

Do not add `import/default` until `?raw` handling is solved. Do not enable
`no-nodejs-modules`, `no-named-export`, `no-namespace`,
`prefer-default-export`, `exports-last`, `group-exports`, or
`max-dependencies`.

### Promise

The native `promise` pack produced 77 findings, mostly demanding `async`/`await`
instead of deliberate Promise chaining in callbacks and React actions. It also
objects to explicit Promise construction in socket test helpers.

The high-value correctness is already covered more accurately by type-aware
TypeScript rules such as `no-floating-promises`, `await-thenable`,
`no-misused-promises`, and `return-await`.

Recommendation: do not enable the Promise pack. Add an individual rule only in
response to a demonstrated defect pattern.

### JSDoc

The native JSDoc pack produced 921 findings, mainly requiring `@param` and
`@returns` tags on TypeScript functions. That duplicates TypeScript types and
conflicts with Baton's JSDoc policy: document subtle behavior and shared rules,
not every signature.

Structural rules such as valid tag names could be selected later, but the
current source already relies on TypeScript and focused normative prose.

Recommendation: do not enable the JSDoc pack broadly.

### Node

The deployed application targets Cloudflare Workers, while scripts and test
configuration intentionally use Node APIs. A global Node pack encodes the wrong
runtime assumptions; a scripts-only pack would object to legitimate synchronous
filesystem work.

Recommendation: do not enable it.

### Security

`eslint-plugin-security` is syntax-only and likely to run through Oxlint, but it
is not in Oxlint's conformance suite. Its preset mixes useful hotspot checks
with Node filesystem, child-process, buffer, Express, and object-injection
heuristics known for false positives.

Baton already has `no-eval`, `no-implied-eval`, `no-new-func`,
`no-prototype-builtins`, unsafe URL checks, iframe sandbox checks, fetch option
checks, and postMessage target-origin checks.

Recommendation: do not add the security preset. Use dependency scanning and
focused threat review; add one syntax rule only if it protects a concrete
boundary.

### Jest, Next.js, and Vue

They do not match the stack. Jest would duplicate or misclassify Vitest APIs;
Next.js rules target Next-specific files and components; Vue is absent.

## Trial results

These were read-only Oxlint runs against the current worktree. Counts show why
presets should not be enabled blindly; they are not a cleanup backlog.

| Trial                                             | Findings | Interpretation                                                                        |
| ------------------------------------------------- | -------: | ------------------------------------------------------------------------------------- |
| Full native import pack under current categories  |    2,489 | Mostly incompatible style and module policies                                         |
| Full native Vitest pack under current categories  |    1,190 | Unscoped and incompatible with Effect/Playwright patterns                             |
| Full native JSDoc pack under current categories   |      921 | Mostly redundant signature tags                                                       |
| Three React performance allocation rules          |      181 | Mostly ordinary inline handlers                                                       |
| Full native Promise pack under current categories |       77 | Mostly style demands against deliberate chaining                                      |
| Narrow import/Vitest correctness trial            |       12 | Three useful duplicate imports; several virtual-module or custom-test false positives |
| `react/unsupported-syntax` on `src`               |        0 | Clean candidate baseline                                                              |
| `react/rule-suppression` on `src`                 |        2 | Both are existing intentional dependency suppressions                                 |

No files were modified by the trials.

## Prioritized recommendation

### Tier 1: native, narrow, low-risk

1. Add `react/unsupported-syntax` as a warning.
2. Add selected native import correctness rules, after fixing the three
   duplicate-import findings and excluding resolver-sensitive `import/default`.
3. Add a scoped native Vitest subset only if `.only` and `.skip` prevention is
   a stated policy.

These use stable native Oxlint facilities and add no package dependency.

### Tier 2: valuable but separate evaluation

1. Trial `eslint-plugin-playwright` against only `e2e/` and retain defect rules.
2. Trial `@effect/language-service` with the exact Effect and TypeScript pins,
   deciding separately whether TypeScript patching is acceptable.

These have higher potential value, but also introduce new runtime or tooling
boundaries.

### Tier 3: defer

- TanStack Query strict style
- typed TanStack Start ESLint pass
- community Effect Oxlint packs
- React performance rules
- Promise, JSDoc, Node, or security presets

Revisit a deferred item only when a concrete defect or architectural decision
gives it a clear job.

## Decision questions

### 1. Should lint optimize for defects or enforce broad consistency?

**Recommendation: defects.** Baton's current categories already produce broad
style guidance. New packs should earn their place by catching mistakes that
type checking, formatting, tests, and existing lint do not catch.

Decision effect: choosing defects supports the narrow rule lists above.
Choosing broad consistency means accepting large cleanups and maintaining many
explicit exceptions.

### 2. Should `.skip` be forbidden in committed Vitest and Playwright tests?

**Recommendation: forbid focused tests everywhere; treat skipped tests as an
error in normal suites and allow them only in explicitly named exceptional
files.** Focused tests silently reduce coverage. Skips can be legitimate, but
they should remain visible and bounded.

Decision effect: this determines whether `vitest/no-disabled-tests` and
Playwright `no-skipped-test` are errors, warnings, or omitted.

### 3. Is an alpha JavaScript-plugin dependency acceptable for E2E correctness?

**Recommendation: yes for a measured Playwright pilot, not by default for its
whole recommended preset.** Oxlint explicitly tests this plugin, and the
missing-await and web-first assertion rules target real browser-test defects.

Decision effect: a yes leads to a report-only trial and curated rule set. A no
keeps the current E2E type checking and runtime tests without another plugin.

### 4. Should Effect diagnostics run only in editors or also fail CI?

**Recommendation: first test the language service in editors, then promote only
high-confidence correctness diagnostics to CI.** Effect's type-aware checks can
be valuable, but patching TypeScript changes the compiler installation and may
surface a large baseline.

Decision effect: editor-only adoption is low-friction but not enforceable. CI
adoption needs exact version pinning, reproducible patching, and a clean
diagnostic baseline.

### 5. Is a second typed ESLint pass acceptable for TanStack Start?

**Recommendation: no, unless server/client boundary bugs are recurring.** Two
rules do not currently justify a second linter, parser, config, and type-program
build.

Decision effect: a no accepts that the Start rules are unavailable under
Oxlint. A yes should scope ESLint only to the files those rules need.

## Bottom line

Baton is not missing a general React ruleset or the recommended TanStack Router
and Query lists. Its main gaps are more specific:

- one native React Compiler restriction rule
- selected module-graph correctness
- test-runner-specific mistakes
- Effect diagnostics that require the TypeScript type system

The right next step is not to enable more categories. It is to add a few
high-signal rules with clean baselines and evaluate Playwright and Effect in
their proper execution models.
