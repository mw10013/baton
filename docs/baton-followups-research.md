# Baton follow-ups from the Bang parity port

Research date: 2026-09-09. Written from the Bang side for whoever works in Baton next. Bang ported Baton's toolchain, hydration, `ShopSession`, subscribe pattern, and small patterns in five phases (`docs/baton-parity-research.md`, commits b9893d7…c2747a1). Auditing that port turned up a few things Bang did better or had to add; they should go back into Baton so the two repos keep reading the same. Part 1 lists them. Part 2 is the one open question the port left unresolved: whether Baton should reinstate `ClientOnly` around `s-page` slot children.

## Part 1 — Ports from Bang to Baton

Each item is small and independent. Bang's file is the reference; copy it rather than re-deriving.

### 1. `awaitHydration(scope, timeout?)` — `e2e/hydration.ts`

Baton's `awaitHydration` takes no timeout, so `refs/baton/e2e/app.ts:70-79` (`gotoApp`) re-inlines the `body[data-hydrated="true"]` locator with a 15 s rescue window, and any spec needing a longer wait must inline it again. Bang added an optional `timeout` parameter and removed both inline copies (`e2e/hydration.ts`, `e2e/app.ts` `gotoApp`, `e2e/plan.spec.ts` billing return leg). One selector lives in one place. Port: add the parameter with Bang's JSDoc sentence, replace the inline locator in `gotoApp` with `awaitHydration(frame, 15_000)`, grep `e2e/` for any other `data-hydrated` locator.

### 2. `"unicorn/number-literal-case": "off"` — `.oxlintrc.json`

oxfmt 0.67 lowercases hex digits; `unicorn/number-literal-case` demands uppercase, so any hex literal with a letter digit (Bang: `0xdc_00` in `src/lib/MemoryRepository.ts:120`) fails lint after every `pnpm fmt`. Bang turned the rule off with a one-line reason (`.oxlintrc.json:127-128`). Baton's only hex literal today is `0x20` (no letter digits), so it does not fire yet, but the parity plan wants the lint config byte-identical across repos so a rule question has one answer. Port the two lines verbatim.

### 3. `DefaultErrorComponent` normalises to an `Error` — `src/components/DefaultErrorComponent.tsx`

Baton guards `error instanceof Error ? error.message : "Something went wrong"` and drops the thrown value. Bang normalises once, `const caught = error instanceof Error ? error : new Error(String(error))`, so a thrown string or object still shows in the banner (the page heading already says "Something went wrong", so the literal was redundant) and `caught.stack` reads uniformly. Small; take it or leave it, but the JSDoc on Bang's version explains why `ErrorComponentProps["error"]` is `unknown`.

### 4. Seed fixture stays per-spec — `e2e/fixture.ts`

Not a port, a decision to mirror. The phase 5 spec said specs should import the shared `e2e/fixture.ts`; Bang kept per-spec inline seeds and wrote the reason into `e2e/fixture.ts:9-14`: each spec seeds the exact shape its assertions compute (capacity, plan, live value), and a shared fixture would couple unrelated specs. `pnpm seed` and manual seeding use the fixture. If Baton's specs also seed their own shapes, record the same reason in Baton's fixture rather than centralising.

## Part 2 — `ClientOnly` around `s-page` slot children: reinstate or not

Bang and Baton share the hydration commit history up to the fork; Baton then dropped the `ClientOnly` wrappers Bang still carries around `s-page` slot children, without a written reason, while keeping the one around `s-table`. Bang's parity plan (`docs/baton-parity-research.md`) keeps Bang's wrappers. This doc makes the case for Baton and gives the five-minute test that settles it.

## What Bang does and why

Three routes wrap every `s-page` slot child (`slot="accessory"`, `slot="primary-action"`) in TanStack's `ClientOnly`, and two wrap `s-table`:

- `src/routes/app.index.tsx:220-224` — `<ClientOnly><s-button slot="primary-action" href="/app/live">`
- `src/routes/app.memory.tsx:275-290` — `<s-badge slot="accessory">`, `<s-button slot="primary-action">`; `:293-468` — `<s-table>`
- `src/components/LivePage.tsx:859-863` — `<s-badge slot="accessory">` status
- `src/routes/admin.shops.tsx:82` — `<s-table>`

Recorded reason, commit `21c53d2` (shared history, present in both repos' lineage):

> refactor: replace useMounted with ClientOnly for Polaris SSR hydration safety
> Polaris upgrades and hoists s-page slot children before React hydration, causing hydration mismatches. TanStack Start's ClientOnly is cleaner than the useMounted pattern and prevents intermittent issues like blank Updated column in s-table.

JSDoc in `app.memory.tsx:155-158`:

> Polaris upgrades and hoists `s-page` slot children before React can hydrate them, while `s-table` snapshots locale-formatted cell text during its upgrade. `ClientOnly` keeps both kinds of custom elements out of the SSR hydration tree.

Mechanism claimed: Polaris is loaded at body end (`<script src={POLARIS_URL} />` in `__root.tsx`, before `<Scripts />`), so custom elements upgrade before React hydrates. If `s-page`'s upgrade moves its slotted light-DOM children (into shadow DOM, or reorders them), React's hydration walk finds a sibling list that no longer matches the SSR output. React 19 treats that as a recoverable error: it logs "Hydration failed…" and **re-renders the whole root on the client**, discarding the SSR tree. Not a crash, but every page load pays a full client render and the console carries the warning.

The `s-table` case is a different mechanism (cell text snapshot at upgrade vs React's text) and produced a visible symptom (blank column). That is the one Baton kept.

## What Baton does

Baton wraps only `s-table` (`refs/baton/src/routes/admin.shops.tsx:89`). Slot children render unwrapped from SSR'd loader data:

- `refs/baton/src/routes/app.workflows.$workflowId.tsx:233-247` — `<s-badge slot="accessory">` Active/Off and `<s-button slot="primary-action">` Edit, both off `Route.useLoaderData()`.
- `refs/baton/src/routes/app.orders.$orderId.tsx:733-757`, `app.teams.$teamId.tsx:232`, `app.workflows.$workflowId_.edit.tsx:595-627`.

`ClientOnly` survives in Baton only for `s-table` and for `SocketBanner` (`identified` is false during SSR; different reason).

## Evidence that cuts both ways

- **Against the wrapper being necessary:** both repos render `<s-link slot="breadcrumb-actions">` unwrapped (`src/routes/admin.shops.tsx:75-80`, Baton `:82-87`) and no one has recorded a mismatch from it. Either not every `s-page` slot is hoisted, or hoisting is harmless. Baton has shipped unwrapped accessory/primary-action slots across four routes; if a full client re-render happened on every load someone might have noticed the console.
- **For the wrapper:** the only recorded reproduction (`21c53d2`) says "intermittent", which is exactly what a race between custom-element upgrade and React hydration looks like: it depends on whether Polaris's script finishes before React's. Over a tunnel (slow JS) the order flips. Absence of a bug report is weak evidence for an intermittent, console-only failure that recovers silently.
- **Cost of the wrapper:** the badge and primary button paint one commit late (after hydration) instead of in the SSR HTML. With Baton's body-level `inert` the page is non-interactive until that same commit anyway, so the button appearing at hydration costs nothing functional; the badge flashes in. Minor.
- **Cost of no wrapper, if the mismatch is real:** full client re-render of the route on every load plus a console error; SSR becomes a preview that gets thrown away.

## The test that settles it

Five minutes in Baton, no code change:

1. `pnpm app:dev`, open `/app/workflows/<id>` (unwrapped accessory badge + primary button) in the embedded admin with DevTools console open. Hard-reload five times. Look for `Hydration failed because the server rendered HTML didn't match the client` or `A tree hydrated but some attributes…` or any `onRecoverableError` output.
2. Repeat over the Shopify CLI tunnel URL rather than localhost — slower Polaris load changes the upgrade/hydration order and is where "intermittent" lives.
3. Optional belt-and-braces: add `onRecoverableError` logging in `src/start.ts`'s `hydrateRoot` (or the Start equivalent) for one session so recoverable errors cannot be missed.

Decision rule:

- **Any hydration error on any reload → reinstate** `ClientOnly` around every `s-page` slot child (accessory, primary-action, secondary-actions) in Baton, matching Bang, and add the JSDoc from `app.memory.tsx:155-158`. Leave breadcrumb-actions alone unless it also shows up.
- **Clean across both localhost and tunnel → do not reinstate.** Instead record the result in Baton (a JSDoc on `RootDocument` next to the `inert` explanation: "slot children hydrate cleanly under Polaris N; `ClientOnly` is only needed for `s-table`"). Then Bang should drop its three slot wrappers in a follow-up for parity, keeping only the `s-table` ones. Note the Polaris version tested; this is a property of Polaris's upgrade behavior and can change.

## Outcome (2026-09-09)

Superseded by `docs/bang-timestamp-hydration-research.md`. The test was run: the hydration error was real on every reload but its cause was `formatDateTime` producing UTC text on the server and local-timezone text in the browser, not slot hoisting. Baton moved timestamps behind a `useHydrated()` component and dropped the `s-table` wrapper; Bang should do the same and drop its slot wrappers too. Part 1 items 1–4 were ported.

## Recommendation absent the test

Reinstate. The wrapper is cheap, the failure it guards is intermittent and silent, and the two repos should agree. But run the test first: it is faster than the change, and if it is clean the right parity move is the opposite direction.
