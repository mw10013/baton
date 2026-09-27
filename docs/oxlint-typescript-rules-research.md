# Oxlint TypeScript rules research

## Executive answer

Yes. Oxlint 1.82.0 can load a local TypeScript module as a JavaScript plugin,
and that plugin can define ESLint-style rules over Oxlint's ESTree AST. A rule
gets visitors such as `BinaryExpression`, `Literal`, `TemplateLiteral`, and
`JSXText`; it reports through `context.report`; and it can provide fixes,
suggestions, options, source locations, tokens, comments, scopes, and most of
the usual ESLint rule context.

Baton already uses this extension path. The `jsPlugins` array in
`.oxlintrc.json` loads the TanStack Router and Query ESLint plugins. A local
plugin is configured in the same array:

```json
{
  "jsPlugins": [
    "./scripts/oxlint-plugin-baton.ts",
    "@tanstack/eslint-plugin-router",
    "@tanstack/eslint-plugin-query"
  ],
  "rules": {
    "baton/no-inline-domain-comparison": "error",
    "baton/no-retired-screen-copy": "error"
  }
}
```

This is possible, but replacing Baton's current scripts is not the best next
step. Oxlint calls the feature **alpha and not subject to semver**. A plugin-only
migration would also change two important properties of the current checks:

- Oxlint does not visit files excluded by `.oxlintrc.json`; `rules-lint` does.
- An Oxlint rule can be suppressed by an `oxlint-disable` comment;
  `rules-lint` is deliberately a repository-wide, non-suppressible check.

Recommendation: keep `scripts/rules-lint.ts` and
`scripts/action-table.ts check` authoritative. If immediate editor diagnostics
are valuable, pilot a small local plugin containing the two file-local
`rules-lint` checks, in addition to the scripts. Do not move the action-table
and glossary integration checks into Oxlint.

## Scope and source snapshot

This research uses the pinned source under `refs/oxlint`, not assumptions about
a newer online release:

- repository: `oxc-project/oxc`
- tag: `oxlint_v1.82.0`
- package version: `1.82.0`
- pin record: `refs/oxlint/.ref.json`

The project consistently spells the product **Oxlint**. This note treats
"Oxlent" in the request as Oxlint.

Primary Oxlint sources consulted:

- `refs/oxlint/crates/oxc_linter/src/config/oxlintrc.rs`, `Oxlintrc.jsPlugins`
- `refs/oxlint/apps/oxlint/src-js/plugins/load.ts`, `Plugin` and `Rule`
- `refs/oxlint/apps/oxlint/src-js/plugins/context.ts`, `Context`
- `refs/oxlint/apps/oxlint/src-js/plugins/source_code.ts`, `SourceCode`
- `refs/oxlint/apps/oxlint/src-js/plugins/report.ts`, `Diagnostic`
- `refs/oxlint/apps/oxlint/src-js/plugins/fix.ts`, fixer implementation
- `refs/oxlint/apps/oxlint/src-js/plugins/visitor.ts`, visitor implementation
- `refs/oxlint/apps/oxlint/src-js/package/rule_tester.ts`, `RuleTester`
- `refs/oxlint/npm/oxlint-plugins/README.md`, TypeScript authoring example
- `refs/oxlint/apps/oxlint/test/fixtures/basic`, local TypeScript plugin fixture

## Baton's lint architecture today

`pnpm lint` runs three independent checks in order:

1. `oxlint --format agent`
2. `node scripts/rules-lint.ts`
3. `node scripts/action-table.ts check`

This split is visible in `package.json`. It is not accidental. Each tool is
checking a different kind of contract.

### Oxlint

`.oxlintrc.json` enables native Oxlint rules, type-aware rules through
`oxlint-tsgolint`, and two JavaScript plugins from the ESLint ecosystem. It
ignores build output, refs, docs, generated files, and a set of imported UI
components.

### `rules-lint`

`scripts/rules-lint.ts` performs two repository rules:

- Status, flag, and admin-role comparisons must use `Domain` predicates rather
  than spelling selected comparisons inline.
- Retired glossary words must not appear in merchant or member screen copy.

The second check delegates to the pure functions in
`scripts/lib/rules-lint.ts`. Its tests run in
`test/integration/rules-lint.test.ts` without filesystem access.

### Action-table and glossary checks

`scripts/action-table.ts check` validates the executable specification and
vocabulary in `src/lib/Domain.ts`. It parses the action matrices, rejects
overlapping rows, checks glossary symbols and label constants, and compares the
Screens table with the route files. The same pure parser is used by tests and
by `action-table print`.

These checks include cross-file and evaluated-value relationships. They are
closer to repository integrity tests than normal per-file lint rules.

## How a TypeScript Oxlint plugin works

### Module shape

Oxlint dynamically imports the module's default export. The recognized plugin
surface is small: optional `meta.name` and a `rules` record. A normal rule has
optional metadata and `create(context)`, which returns AST visitors.

The following is the structural shape, not a proposed complete implementation:

```ts
import { definePlugin, defineRule } from "@oxlint/plugins";

const noInlineDomainComparison = defineRule({
  meta: {
    messages: {
      usePredicate: "Use a Domain predicate instead of an inline comparison.",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        // Match the deliberately narrow Baton rule, then report the exact node.
        context.report({ node, messageId: "usePredicate" });
      },
    };
  },
});

export default definePlugin({
  meta: { name: "baton" },
  rules: {
    "no-inline-domain-comparison": noInlineDomainComparison,
  },
});
```

`definePlugin` and `defineRule` are runtime identity functions. Their value is
TypeScript inference and validation. They are provided by the optional
`@oxlint/plugins` package. Baton does not currently depend on that package, so
a typed plugin should add it at the exact version corresponding to the pinned
Oxlint version.

The repository requires Node 26. That satisfies Oxlint's requirement for
loading `.ts` plugin files through Node's native type stripping. No compile
step is required for type-only TypeScript syntax. Code that relies on
TypeScript transformations, rather than erasable type syntax, should still be
avoided.

### Configuration and naming

A local string in `jsPlugins`, such as
`"./scripts/oxlint-plugin-baton.ts"`, is resolved relative to the configuration
file. The configured rule ID combines the plugin's `meta.name` and the rule
key, for example `baton/no-retired-screen-copy`.

Oxlint also accepts `{ "name": "alias", "specifier": "package-or-path" }`.
That form is useful when a JavaScript plugin would collide with a native Rust
plugin name. Baton does not need an alias for a plugin named `baton`.

Only the default export is loaded. Plugin-level ESLint features such as shared
configs, processors, languages, and environments are not part of the currently
recognized Oxlint plugin shape.

### Available rule facilities

The current implementation supports the facilities needed for Baton's two
file-local checks:

- ESTree node visitors, exit visitors, wildcard visitors, and selectors
- JS, JSX, TypeScript, and TSX ASTs parsed by Oxlint
- `context.filename`, `physicalFilename`, `cwd`, options, settings, and rule ID
- `context.sourceCode` with text, AST, tokens, comments, locations, ancestors,
  scopes, and token navigation
- `context.report` using a node or location, messages or message IDs, and
  interpolation data
- autofixes and editor suggestions when declared in rule metadata
- JSON Schema validation and default values for rule options
- `oxlint-disable` handling
- an Oxlint `RuleTester` exported from `oxlint/plugins-dev`
- CLI and language-server execution

The alternative `createOnce` API builds one reusable visitor and provides
per-file `before` and `after` hooks. It is an Oxlint-specific optimization, not
a project-wide finalization API. Standard `create` is simpler and sufficient
for Baton. In particular, `after` runs after each file, not once after the
whole lint invocation.

### Relevant limits

The limits that matter here are:

- JavaScript plugins are alpha and outside semver guarantees.
- Oxlint supplies no parser services. `sourceCode.parserServices` is an empty
  object, so a custom rule cannot ask TypeScript for a symbol's resolved type.
- Oxlint uses its own parser; a plugin cannot substitute a custom parser.
- JavaScript callbacks execute on the main Node thread. Rust can parse in
  parallel, but lint workers may wait for JavaScript rule execution.
- Rule execution order is unspecified in release builds. Rules must not depend
  on each other running first.
- Plugins are trusted code loaded with a normal dynamic import. They are not
  sandboxed and have the invoking process's filesystem and environment access.
- Some ESLint compatibility APIs are incomplete. The missing type services are
  the important gap for custom Baton rules.

None of these limits prevents an AST-only Baton rule. They do argue for a
small plugin with no cross-file state, no filesystem traversal, and no type
resolution.

## Candidate-by-candidate assessment

### Inline domain comparisons: feasible, moderate benefit

The current check matches exact text forms:

```ts
\.(?:status|flag) (?:===|!==) "
\.role (?:===|!==) "admin"
```

An Oxlint visitor on `BinaryExpression` could recognize the same contract
without depending on whitespace or quote style. It could also intentionally
handle reversed operands, comments between tokens, multiline expressions, and
multiple violations on one line. Comments and unrelated raw text would not be
mistaken for expressions, and each diagnostic could underline the comparison.

The rule must remain narrow. Baton contains legitimate `.status`, `.flag`, and
`.role` comparisons that are not the domain policy this check enforces.
Without TypeScript parser services, the rule cannot reliably infer that an
arbitrary object is a particular domain type. It should preserve the current
literal restrictions unless the Domain policy itself is deliberately widened.

Verdict: a sound AST rule and a useful quality improvement, but not enough by
itself to justify replacing the existing script.

### Retired screen copy: best plugin candidate

The current implementation hand-parses source lines to find string literals,
template literals, and JSX text while skipping comments. Its tests pin several
careful distinctions between prose and identifiers, paths, query keys, member
access, and route fragments.

An Oxlint rule could instead visit:

- string `Literal` nodes
- the cooked or raw quasis of `TemplateLiteral` nodes
- nested literals inside template expressions through their own visitors
- `JSXText` nodes

This removes the hand-written approximation of JavaScript comments and
literals. It naturally handles multiline JSX, escaped values, and a bare
single-word JSX text node, which the current implementation deliberately skips
because it cannot distinguish that source line from an identifier. Diagnostics
could point at the exact copy rather than the containing line.

The filename scope remains important. The current script selects merchant and
member routes, components, and named copy modules while excluding operator,
API, and public pages. A plugin can inspect `context.filename`, but it only
runs on files Oxlint has not globally ignored.

Verdict: the clearest technical win for a pilot plugin rule.

### Action matrices: possible, wrong abstraction

A rule restricted to `src/lib/Domain.ts` could read `context.sourceCode.text`
and call the existing parser. That would merely place a lint wrapper around a
repository-specific JSDoc parser. It would not make the check more structural,
and the parser would still need to support tests and `action-table print`.

The table also generates behavioral fixtures. Keeping one pure parser used by
the command and tests is a stronger design than making Oxlint the host for it.

Verdict: keep it out of Oxlint.

### Glossary symbols and screen labels: low-value or unsafe migration

The glossary symbol-presence check could inspect one file's AST, but doing so
would change a deliberately simple occurrence contract into a different rule.
There is little practical gain.

The screen-column check compares source prose with imported runtime values from
`TASK_STATE_LABEL`, `RUN_STATE_LABEL`, `WORKFLOW_STATE_LABEL`, and
`VERB_LABEL`. A plugin would have to evaluate `Domain.ts`, import application
code during lint, or duplicate TypeScript constant evaluation. All three make
the check more coupled and less reliable.

Verdict: keep both in `action-table check`.

### Screens table and route inventory: not a per-file rule

This contract is bidirectional: every named route file must exist, and every
qualifying merchant or member screen must have a row. It therefore requires a
view of the complete route set.

Oxlint's `createOnce` shares setup across files, but its hooks surround each
file and do not provide a clean end-of-project callback. A plugin could walk
the filesystem itself, but that would reproduce the existing command inside a
lint callback and make editor results depend on out-of-band files.

Verdict: keep it as a repository integration check.

## Migration risks that are easy to miss

### Ignored files

`.oxlintrc.json` excludes several files under `src/components/ui` and the
`src/components/ai-elements` directory. `scripts/rules-lint.ts` walks those
paths anyway. Replacing it with plugin rules would silently reduce policy
coverage unless the global ignore model changed.

Changing the ignore model only for these rules is not obviously available:
ignored files do not enter ordinary rule processing. Removing the ignores
could expose those imported components to every other configured rule.

### Suppression policy

Oxlint applies disable directives to JavaScript-plugin diagnostics. A source
author could add:

```ts
// oxlint-disable-next-line baton/no-retired-screen-copy
```

The current scripts provide no local escape hatch. Existing vocabulary work
has preferred correcting an overbroad matcher over adding allowlists. Moving
authority to a plugin therefore changes policy, not just implementation.

### Tests and runtime boundary

The current matcher tests are pure and run in the workerd integration project.
Oxlint's `RuleTester` is Node/native tooling. A real migration needs a Node test
boundary for visitor behavior and at least one CLI-level test for config,
overrides, filenames, ignores, and disable directives.

Pure tests can remain useful for the retired-word predicate, but they cannot
prove AST visitor wiring or diagnostic locations.

### Alpha maintenance

The repository pins Oxlint exactly, which contains risk, but an upgrade can
still require coordinated plugin changes. Any local plugin should stay small,
use the standard ESLint-style `create` API, and have CLI integration coverage.
Avoid Oxlint-specific optimization until measured lint time requires it.

## Options

| Option                                 | Result                                         | Benefits                                                         | Costs and risks                                                                                            |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Keep current scripts                   | No plugin work                                 | Stable, simple, non-suppressible, full current coverage          | Diagnostics arrive after Oxlint and are line-oriented                                                      |
| Add advisory plugin rules              | Plugin and scripts run together                | Immediate AST-precise diagnostics; low-risk way to learn the API | Temporary duplicated enforcement and tests                                                                 |
| Replace `rules-lint` with plugin rules | Oxlint owns both file-local checks             | One reporting pipeline; precise locations                        | Alpha dependency, ignored-file regression, new suppression policy, Node test work                          |
| Move all custom checks into Oxlint     | Oxlint hosts action-table and route checks too | Superficially one command                                        | Poor abstraction, cross-file filesystem work, runtime evaluation, loss of reusable command design          |
| Write native Rust Oxlint rules         | Upstream or forked native rules                | Maximum engine integration and performance                       | Wrong ownership for Baton-specific vocabulary; Rust/upstream maintenance; no local rule facility in config |

## Recommendation

### Default: keep the current architecture

Do not migrate merely to make every line of `pnpm lint` execute inside the
Oxlint process. The current package script already presents one developer
command, while preserving appropriate implementation boundaries.

Keep:

- `scripts/rules-lint.ts` as authoritative enforcement
- `scripts/lib/rules-lint.ts` as the pure matcher and workerd-testable unit
- `scripts/action-table.ts check` for matrices, glossary values, and routes
- the existing `pnpm lint` sequence

### Optional pilot: duplicate only the two file-local rules

If editor feedback is the goal, add `scripts/oxlint-plugin-baton.ts` with:

- `baton/no-inline-domain-comparison`
- `baton/no-retired-screen-copy`

Use AST visitors and `context.filename`; do not read the filesystem. Keep the
scripts authoritative during the pilot. Add `@oxlint/plugins` at an exact
version, use standard `create`, and test the rules with `oxlint/plugins-dev`
under Node plus one real CLI fixture.

Before removing duplicate script enforcement, require all of the following:

1. Full-tree comparison shows equivalent or intentionally improved findings.
2. The ignored-component coverage problem has an explicit resolution.
3. The team has decided whether source-level disables are permitted.
4. CLI integration tests cover TS, TSX, templates, JSX text, filenames, ignores,
   and disables.
5. Lint time is measured before and after the plugin is enabled.

Do not move the action-table or glossary integration checks during this pilot.

## Decision questions

### 1. Is the goal better editor feedback or fewer commands internally?

**Recommendation: optimize for editor feedback.** Developers already run one
public command, `pnpm lint`; changing its internal process count has little
value. Immediate highlighting and exact source ranges are the concrete reasons
to add plugin rules.

Decision effect: if editor feedback is not important, stop here and keep the
current implementation. If it is important, run the additive two-rule pilot.

### 2. May repository rules be suppressed in source?

**Recommendation: no for these two rules.** A domain-policy or vocabulary
exception should be represented in the normative Domain rule or by narrowing
the detector, not hidden at a usage site.

Decision effect: a "no" answer means the standalone script should remain the
authoritative backstop even if the plugin supplies editor diagnostics. A
"yes" answer makes eventual plugin-only enforcement more plausible, but it
should include a documented exception-review policy.

### 3. Must the checks continue to cover Oxlint-ignored UI files?

**Recommendation: yes.** Retired screen copy is a product-language rule, and
imported or generated-origin components can still render product language.
Coverage should not change accidentally because another lint rule is noisy in
those files.

Decision effect: a "yes" answer favors the script backstop. A "no" answer
requires explicitly redefining the vocabulary contract and updating its tests
and JSDoc, rather than accepting the gap as a migration side effect.

### 4. Is an alpha extension API acceptable for authoritative policy checks?

**Recommendation: acceptable for an additive pilot, not yet as the only
enforcement path.** Exact dependency pins and focused tests make experimentation
reasonable. They do not remove upgrade and compatibility work.

Decision effect: if alpha APIs are unacceptable, do not add the plugin. If
they are acceptable, keep the plugin small and isolate it in one module.

### 5. Should the action-table checks be made visible in editors too?

**Recommendation: no unless a measured workflow problem appears.** These
checks validate one central file and already run through `pnpm lint` and tests.
Wrapping them in a per-file linter adds coupling without improving their
model.

Decision effect: if immediate Domain-table feedback becomes important, first
consider a focused watch command or editor task that runs `action-table check`.
Do not make the parser depend on Oxlint.

## Bottom line

Oxlint has a real TypeScript rule extension mechanism, and Baton is already
using its JavaScript-plugin runtime indirectly. The retired-copy detector would
be cleaner and more precise as an AST visitor, and the inline-comparison check
would become formatting-independent.

The integration boundary matters more than the implementation possibility.
For Baton today, Oxlint plugins are a good optional diagnostics layer, while
the existing scripts remain the better authority for repository-wide,
non-suppressible policy and cross-file specification checks.
