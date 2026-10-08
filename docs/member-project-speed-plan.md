# Plan: keep the authentication server out of the client

Written 2026-10-07 from `docs/member-project-speed-research.md` and its Decisions section.
This is for an implementer who has not read the research; the numbers it rests on are repeated
here. Read the research once before starting.

## Goal

Every document the app serves, merchant and member alike, loads better-auth, Kysely, jose and
zod into the browser: about 620 of the 934 script modules of a dev page load, and the bulk of
the 1.3 MB production `index-*.js` (369 KB gzipped). Nothing on the client calls any of it.

| measure                                         | today          | target                     |
| ----------------------------------------------- | -------------- | -------------------------- |
| dev document load, `/login`, to `data-hydrated` | 1,020–1,050 ms | 340–450 ms (measured once) |
| dev script modules per document                 | 934            | about 204                  |
| production `dist/client/assets/index-*.js`      | 1.30 MB        | well under half            |
| `pnpm test:e2e --project=member` (45 tests)     | about 1.7 min  | about 65 s                 |

The chain: `AdminServerFnMiddleware.ts` exports `requireAdmin`, a module-level `Effect.gen`
that yields `Auth`. TanStack Start's compiler strips the `.server()` body of
`adminServerFnMiddleware` from the client build and prunes the imports that become unused,
but `requireAdmin` keeps `Auth` alive, so `Auth.ts` (better-auth, its Kysely adapter, the
magic-link plugin, `Repository`, `KV`, `Email`) survives. The admin routes import the
middleware at module level for `.middleware([...])`, the route tree imports every route, the
router imports the tree. `MemberServerFnMiddleware.ts` has no such export: its client
transform is one import, `createMiddleware`. The research verified this against the dev
server's client transforms and by applying the split for a minute.

## Decisions already taken (do not reopen)

1. The split is the fix; the pin is TanStack Start import protection, with `behavior: "error"`
   in dev and build.
2. The new module is `AdminAccess.ts` beside `MemberAccess.ts`.
3. Mark `Auth.ts` and `Repository.ts` with the `server-only` marker; deny the `better-auth` and
   `kysely` specifiers on the client.
4. One page per member per spec (lever 2), the browser-project move and sign-in sharing
   (lever 3) are parked. Do none of them here.

## Ground rules

- Run `pnpm typecheck`, `pnpm lint` and `pnpm fmt` after each phase; keep every file `fmt`
  touches.
- Do not commit.
- A JSDoc carries its reasoning inline and names no file under `docs/`. The research's
  numbers may be repeated in a JSDoc; the research may not be cited.
- Re-run `pnpm seed` after any e2e run before using the dev store.

## Phase 1: the split

Files: `src/lib/AdminAccess.ts` (new), `src/lib/AdminServerFnMiddleware.ts`,
`src/routes/admin.tsx`.

1. Create `src/lib/AdminAccess.ts` holding `requireAdmin` exactly as it is today, with its
   JSDoc moved whole and extended by one paragraph that states the rule this split enforces:
   a module a route imports at module level reaches the client build, and the compiler prunes
   only what a `.server()` or `.handler()` body alone referenced, so a guard that yields `Auth`
   must live in a module that only server bodies import. Mirror the sentence in
   `MemberAccess.ts`'s JSDoc ("Lives in its own module rather than beside
   `memberServerFnMiddleware` because ...") and name the measured cost: 730 script modules and
   about 0.65 s per document load in dev, and better-auth with Kysely in the production client
   bundle. Say the pin is import protection in `vite.config.ts` and `{@link}` nothing under
   `docs/`.
2. `AdminServerFnMiddleware.ts` keeps `adminServerFnMiddleware` only, importing `requireAdmin`
   from `@/lib/AdminAccess`. Its imports become `createMiddleware`, `Effect`, `requireAdmin`
   and `tryPromisePassthrough`. Its JSDoc (now the only one in the file) says the module is
   client-reachable and may export nothing that references a server service outside a
   `.server()` body, with the reason in one sentence and a link to `requireAdmin`.
3. `admin.tsx` imports `requireAdmin` from `@/lib/AdminAccess`. Its use is inside a
   `createServerFn` handler, which the compiler strips with the import.
4. `MemberServerFnMiddleware.ts`'s JSDoc says "`requireMember` in `@/lib/MemberAccess`" and
   "the mirror-image bounce in `requireAdmin`"; both stay true. Update nothing there unless
   the sentence in step 1 is placed there as the normative one, in which case
   `AdminAccess.ts` links it rather than restating it. Pick one home for the rule; the
   research suggests `AdminAccess.ts` because it is the symbol the leak was on.

Check, with the dev server running:

```bash
curl -s "http://localhost:$(pnpm port)/src/lib/AdminServerFnMiddleware.ts" | grep -E '^import'
```

prints one `@/lib`-free import (`createMiddleware`) and nothing from `/src/lib/Auth.ts`.

## Phase 2: the pin

Files: `vite.config.ts`, `src/lib/Auth.ts`, `src/lib/Repository.ts`,
`test/browser/vitest.config.ts`.

1. In `vite.config.ts`, give `tanstackStart()` the option:

   ```ts
   importProtection: {
     behavior: "error",
     client: { specifiers: [/^better-auth(\/|$)/, /^kysely(\/|$)/] },
   },
   ```

   with a JSDoc above it stating the rule: no server package reaches the client environment,
   checked on every import under `src/` in dev at request time and in build after
   tree-shaking; `error` rather than the default `mock` in dev because a mocked module and a
   one-line warning are invisible to an agent and the app keeps working on a Proxy. Cite
   `refs/tan-start/docs/start/framework/react/guide/import-protection.md`.

2. Add `import "@tanstack/react-start/server-only";` as the first line of `src/lib/Auth.ts`
   and `src/lib/Repository.ts`, each with a one-line comment naming the marker's effect (a
   client-environment import of this file is denied with a trace from the route entry).
3. `test/browser/vitest.config.ts` calls `tanstackStart()` too. Leave it on the defaults; the
   browser project imports hooks and parts, never a route. If a browser test ever trips the
   marker, that is a real leak into a part, not a config problem.
4. Prove the pin bites: temporarily re-add `export const leak = Effect.gen(function* () { yield* Auth; })`
   to `AdminServerFnMiddleware.ts`, load any page on the dev server, and confirm the Vite
   log (`logs/local-worker.log`) shows `[import-protection] Import denied in client
environment` with a trace through `routeTree.gen.ts`; then run `pnpm build` and confirm it
   fails the same way. Remove the line. Record both outputs' first lines under Measurements.
5. The rule has no Vitest test: it is a build-tool rule checked by the build tool itself on
   every dev request and every `pnpm build`, and a test that ran a Vite build would cost more
   than it pins. Say so in the `vite.config.ts` JSDoc so the next reader does not add one.

## Phase 3: measure

1. `pnpm build`; record `dist/client/assets/index-*.js` size raw and gzipped, and confirm
   `grep -c betterAuth`, `createKyselyAdapter`, `SelectQueryBuilder` on it are all 0 and that
   no `*-sqlite-dialect-*.js` chunk is emitted.
2. With the dev server up, measure `/login` to `data-hydrated` and the script-module count
   three times (the research used a Playwright script: `page.on("request")`, `goto`, wait for
   `body[data-hydrated="true"]`).
3. `pnpm exec playwright test --project=member --reporter=list`; record wall time and the sum
   of test durations. Then `npm run test:e2e --` for the whole run and record it. Then
   `pnpm seed`.
4. Replace the research's "Expected result" lever 1 row with the measurement, and update the
   e2e index comment in `playwright.config.ts` if it states the run's length.

## Measurements

Taken 2026-10-07 on wt-01 (port 3801).

| measure                                                         | before         | after                                            |
| --------------------------------------------------------------- | -------------- | ------------------------------------------------ |
| dev document load, `/login`, to `data-hydrated`                 | 1,020–1,050 ms | 416, 524 ms warm (2,634 ms first, cold optimize) |
| dev document load, `/admin`, to `data-hydrated`                 | not measured   | 592, 436, 429 ms                                 |
| dev script modules per document                                 | 934            | 204 (both pages, every run)                      |
| production `dist/client/assets/index-*.js`                      | 1.30 MB        | 476,771 B raw, 155,215 B gzipped                 |
| `grep -c` betterAuth / createKyselyAdapter / SelectQueryBuilder | not 0          | 0 / 0 / 0                                        |
| `*-sqlite-dialect-*.js` chunk                                   | emitted        | none                                             |
| `--project=member` (45 tests)                                   | about 1.7 min  | 70 s wall (reported 1.2m), 60.6 s summed         |
| `npm run test:e2e --` (91 tests)                                | 4.3 min        | 201 s wall (reported 3.3m), all passed           |

Phase 1 check: the dev client transform of `AdminServerFnMiddleware.ts` has one import,
`createMiddleware` from `@tanstack/react-start`.

Pin proof, with `leak` re-added to `AdminServerFnMiddleware.ts`:

- Dev (`logs/local-worker.log`), `/login` never hydrated:
  `[import-protection] Import denied in client environment` / `Denied by marker: module is
restricted to the opposite environment`, trace `src/router.tsx (entry)` →
  `src/routeTree.gen.ts` → `src/routes/admin.orphan-shop-agent-objects.tsx` →
  `src/lib/AdminServerFnMiddleware.ts` → `src/lib/Auth`.
- `pnpm build` exit 1: `[import-protection] Import denied in client environment` / `Denied by
specifier pattern: /^better-auth(?:\/|$)/u`, trace `src/router.tsx (entry)` →
  `src/routeTree.gen.ts` → `src/routes/admin.shop.$shop.tsx` →
  `src/lib/AdminServerFnMiddleware.ts` → `src/lib/Auth.ts:78:16` → `better-auth`.

The line was removed and a clean `pnpm build` passed. `pnpm seed` was run after the e2e runs.

## Deviations and issues

- The specifier patterns are `/^better-auth(?:\/|$)/u` and `/^kysely(?:\/|$)/u`: oxlint warns on
  an unnamed capture group and a missing `u` flag, so the group is non-capturing.
- The rule's one home is `requireAdmin`'s JSDoc in `AdminAccess.ts`;
  `MemberServerFnMiddleware.ts` is unchanged. `requireAdmin`'s JSDoc names
  `adminServerFnMiddleware` in backticks instead of `{@link}`, since linking it would mean
  importing the middleware module into the guard's.
- `playwright.config.ts` states no run length, so it is unchanged.
- In build the leak is caught by the `better-auth` specifier, in dev by the `Auth.ts` marker;
  both layers fire.

## Review (2026-10-07)

Checked by a second agent: every measurement reproduced, the pin proof repeated in dev and
build, the four deviations above accepted. Two additions:

- `test/browser/vitest.config.ts` now passes `importProtection: { behavior: "error" }` too.
  Phase 2 step 3 left it on the defaults, but the default in serve mode is `mock`, so a part
  that reached `Auth` would have been swapped for a Proxy and logged once, which is the silent
  failure the `error` decision exists to prevent. The browser project passes (10 tests).
- The `vite.config.ts` JSDoc says that in dev the document still serves with 200 when a leak is
  present: the client module request fails, so the page never hydrates and the log carries the
  trace. The e2e suite catches it by waiting for `data-hydrated`; a curl does not.
