# Plan: loader and socket reads

Implements `docs/live-read-research.md`. Every recommendation in its §6 was accepted on 2026-10-19, Q3 with the 5-minute window written out under it. Read the research's §0, §2, §3.3, §4 and §5 first; this plan does not repeat their reasoning.

Prior art is effect-app's Atom query engine, `https://github.com/effect-app/libs`, `packages/vue/src/atomQuery.ts` and `queryLifetime.ts`, read at `c64841e`. Clone it shallow into a fresh directory outside the repo to read it, and never copy its files in. Port the ideas into Baton's idiom, and name the source in a `@see` on the symbol that ports it.

## 0. Rules for the implementer

- **AGENTS.md.**
  - Vite+ only; run `vp check --fix` after every change.
  - Effect Schema for parsing; `Match` for tag dispatch; `Effect.fn("name")`.
  - The JSDoc rules: never cite this plan, the research or any `docs/` file in code.
- **Commits.**
  - Work on `main`. Commit at the end of each green step.
  - Stage paths explicitly; never `git add -A` or `git commit -a`. Do not push.
- **Each step ends green.**
  - `vp check` and `vp test` (unit, browser, integ) every step. From Step 3 on, also `vp run test:e2e`, the embedded project at least.
  - A step that cannot end green is recorded in §7 before moving on.
  - Do not re-run e2e through a failure you already understand; record it instead.
- **What does not change.**
  - No contract change to `ShopActorRpcs` or `BackendApi`, except Step 5's log line.
  - No table changes. Never `db:reset` staging, `cloud:reset` or `deploy:staging`.
- **A2 and A3 stand.**
  - A page's first render still comes from a server function, and the socket query is seeded from it.
  - One socket per tab, held by the layout (`ShopSocket`).
  - Every live screen keeps one `s-page` from SSR through hydration.
- **Measure, don't assume.** Counts come from the instrumentation in §A, run in the embedded dev app (`vp run browser open`). Record the before and after numbers in §7, with StrictMode doubles named.
- Do not rewrite the steps. Record in §7 what you built differently, and what surprised you, as you go.

## 1. Outcome

- **A live read has one owner: the atom registry.**
  - A loader in the browser asks the registry first. It fetches over HTTP only when the registry has no answer for that read.
  - `useLiveRead` never refreshes. It seeds only the hydrated first page.
- **A socket notice refetches only the live queries a page shows.** A kept query nobody shows is marked invalidated and refetches once when it is shown again.
  - Notices are throttled per key (2 s, leading and trailing) and held while the tab is hidden.
  - A notice that lands during a fetch is replayed after it settles instead of interrupting it.
  - `refreshOnFocus` is gone.
- **Live queries and router matches are both kept 5 minutes**, through one constant.
- **`/app`'s guards are cheaper.**
  - They run on every full page load.
  - On a client-side navigation they reuse the last answer while it is under 5 minutes old.
  - The search checks run every time. `getShopifyApp` is read once per document.
- **Targets**, counted in the embedded dev app as in research §1, production counts:

  | Navigation                                  | Before | Target                                                                  |
  | ------------------------------------------- | ------ | ----------------------------------------------------------------------- |
  | Orders index → order page → index (revisit) | 7      | 0 if no notice in between, else 1 socket read                           |
  | Previous page (a cached match)              | 7      | 0 or 1                                                                  |
  | Next page, filter change                    | 5      | 2 HTTP (`listOrders`, plus `orderUsage` only if usage is absent)        |
  | Home revisit                                | 8      | `setupFacts` + `homePlan` (not live), 0 socket reads if nothing changed |
  | Index → order page, first visit             | 3      | 1 (`orderDetail`)                                                       |
  | A notice with _n_ kept pages, 1 shown       | _n_    | 1                                                                       |

  Each "Before" includes the 2 guard requests; each "Target" assumes they were reused.

## 2. What this plan rests on

- **Research §2.1.** Node lifetime is `defaultIdleTTL` 400 ms today (`getRouter`), in buckets of half that.
- **Research §2.2.** `Atom.withReactivity` subscribes to its query, so every wrapper alive within its TTL refetches on every notice. `refreshOnWindowFocus` has the same shape.
- **Research §2.3.**
  - `registry.setSerializable` on a node with no `initialValueTarget` makes it valid with no fetch. Keep seeding the inner query, never the wrapper.
  - `seed`'s JSDoc is wrong about an existing node.
- **Research §3.1.**
  - A cached match background-reloads on `enter` when stale (`staleTime` 0).
  - `beforeLoad` runs on every navigation.
  - The router context carries `registry`, and the loader context has `cause`, `preload` and the match's `updatedAt`.
- **Research §3.3.**
  - effect-app's `observeQueryAtom`, `atomsToRefetch` and `recoverStuckWaitingOnMount`.
  - The interrupted-refetch hang. Its repro titles are in `test/interrupt-refetch-repro.test.ts`.
- **Research Q3's decision.** The plan has one refinement: the cached guard answer is dropped by the one invalidation `/app` makes for an auth reason, `usePaymentRequired` in `ShopSocket.tsx`. `src/web/client/session.ts`'s `signOut` is the member side's, and is out of scope with `requireRole` (§8). The `router.invalidate({ sync: true })` calls after a press (members, teams, workflows) keep it, since they are data refreshes. Record it in §7 if the code says otherwise.

## 3. Names and constants

- **`LIVE_RETENTION`** (`Duration`, 5 minutes) in `src/web/client/query.ts`, which is otherwise emptied by Step 2. It is both the live query idle TTL and the router's `defaultGcTime` (`getRouter`), stated once and linked from the other.
- **`liveQuery(query, keys)`** in `shop-actor-client.ts` replaces `.pipe(Atom.withReactivity(keys), refreshOnFocus)` on every live atom:
  - `merchantOrdersAtom`, `merchantSyncStatusAtom`, `merchantUsageAtom`, `merchantOrderDetailAtom`, `memberRunsAtom`, `memberRunAtom`.
  - The `…Query` families (the serializable inner queries) keep their names and serialization keys.
- **`liveLoad`** in `src/web/client/live-load.ts`: the loader half of a live read (Step 3).
- **`NOTICE_THROTTLE`** (`Duration`, 2 seconds) on `noticesAtom`.
- **`GUARD_MAX_AGE`**, which is `LIVE_RETENTION`: the reuse window for `/app`'s guard answer (Step 4).
- **The Step 5 log line**: `Runs.listOrders: shop=<shop> memo=<hit|miss>`, debug level, with `shop` and `memo` annotated (AGENTS.md logging).

## 4. Steps

### Step 0: Baseline and spike S1

1. **Baseline.**
   - `vp run browser open`, install §A's instrumentation, and recount the research §1 rows.
   - Add one row the research did not measure: a notice. Press Sync from Shopify on an order the dev store has. Count with the orders index and the order page both kept, the index shown.
   - Record everything in §7 under Command results.
2. **Spike S1** as unit tests on a test registry, before any production code depends on it. Use `test/browser/shop-actor.ts`'s `shopTestRegistry`, or a plain `AtomRegistry.make` with a fake effect atom if that is simpler; say which in §7. Build both variants of research §5.1:
   - **(A)** an observer-counting wrapper with an `invalidated` flag (effect-app's `QueryLifetime`);
   - **(B)** reactivity registered on the query node itself, relying on Atom's laziness.

   Cases, each a test title:
   - "a mounted live query refetches on a notice"
   - "a kept live query nobody shows does not refetch on a notice"
   - "a kept live query refetches once when it is shown again after a notice"
   - "a notice naming two keys refetches a query once"
   - "an interrupted refetch is never left waiting with nothing in flight"
   - "a seeded live query does not fetch on mount"

3. Keep the simpler variant that passes all six, delete the other, and record the choice and the results in §7. If neither passes, stop and record why. That is a research question, not an implementation detail.

### Step 1: `liveQuery`

1. Build `liveQuery` from the Step 0 variant, in `shop-actor-client.ts`.
   - `Atom.setIdleTTL(…, LIVE_RETENTION)` is applied **last**, so the whole chain is kept (effect-app's `buildQueryFamily` order).
   - Port `recoverStuckWaitingOnMount`: count fetches in flight per query, and treat a `waiting` result with none in flight as stuck, refetching it once.
2. Keep a key → kept atoms index (effect-app's `trackByKeys`) for Step 2's dispatch. One `refresh` per atom per dispatch, however many keys match.
3. Replace every live atom's `.pipe(Atom.withReactivity(…), refreshOnFocus)` with `liveQuery(…)`. Keep each atom's keys exactly (research §1's table names them).
4. Move the Step 0 tests to their home (`test/unit/web/client/live-query.test.ts`, or under `test/browser/` if they need the browser) and keep their titles.

### Step 2: Notices

1. `noticesAtom` dispatches through the Step 1 index, not `Reactivity.invalidate`:
   - a shown query is refreshed;
   - a kept one is marked invalidated.

   Check whether anything else still listens on `Reactivity` for these keys (`grep -rn "Reactivity" src/web`). Remove it, or record it in §7.

2. **Throttle.** `NOTICE_THROTTLE`, leading and trailing, per key: legacy's `INVALIDATION_THROTTLE_MS` rule in `refs/baton-legacy/src/lib/useLiveQuery.ts` (`useLiveQuery`). The first notice refetches at once; any more inside the window cost one refetch at its end.
3. **Hidden tab.** While `document.visibilityState` is hidden, hold the keys. On `visibilitychange` to visible, dispatch them once, through the throttle.
4. **A notice during a fetch.** Do not interrupt the fetch. Mark the query and refetch once when the fetch settles, effect-app's buffered-writes idea (`liveQueryInvalidation.ts`, `beginLiveQueryFetch` / `endLiveQueryFetch`).
5. **The connect notice** (`browserProtocol`'s `onConnect`) stays, and it is never deferred or throttled away: legacy's identify rule. It refetches the shown queries and marks the kept ones.
6. Delete `refreshOnFocus` and `createIsomorphicFn`'s use in `query.ts`. Also delete `refreshOnWindowFocus` everywhere it is used.
7. Test titles, each its own test:
   - "a burst of notices inside the window costs two refetches"
   - "a hidden tab defers its refetch to the next visibilitychange"
   - "a notice during a fetch refetches once after it settles"
   - "every connect refetches what is shown"

   The first two are legacy's titles (its `test/browser/use-live-query.test.tsx`). Keep them byte for byte where the rule is the same, and list in §7 any whose rule changed.

### Step 3: Loader-first reads

1. **`liveLoad`.** It takes the router context's `registry`, the serializable inner query, the server function, and the loader's `updatedAt` if any.
   - **Server:** call the server function and return its answer. Never touch the server registry.
   - **Browser:**
     - a node for the query's serialization key holding a `Success` → return its value, with no request (`registry.getNodes()`, `AsyncResult.value`);
     - no node, or no `Success` in it → call the server function, seed the node with its answer, and return the answer.
   - The split is a `createIsomorphicFn`, as `protocol` is.
   - A kept query marked invalidated returns its last value. Its mount refetches it (Step 1), and the screen shows `waiting`.
2. **Seed timestamp.** `seed` takes the read's time (research Q6) and stamps `AsyncResult.success`'s `timestamp` with it:
   - the server function's completion time for a browser fetch;
   - the match's `updatedAt` for the hydrated page.

   Fix `seed`'s JSDoc (research §2.3).

3. **Convert every live loader to `liveLoad`:**
   - `app.orders.index.tsx`: `listOrders` and `orderUsage`;
   - `app.index.tsx`: the arrival `listOrders`. `setupFacts` and `homePlan` are not live and keep fetching;
   - `app.orders.$orderId.tsx`: `orderDetail`;
   - `shop.$key.workflows.index.tsx`: `workflowsList`, keyed by the query its answer resolves. Check how the loader learns that key before the fetch, and record the answer in §7;
   - `shop.$key.workflows.$runId.tsx`: `memberWorkflowPage`.

   **Usage.** `homePlan` carries `plan.usage`. Seed the usage node from it only if it is absent, so the home page and the orders index share one usage node, as today.

4. **`useLiveRead` shrinks** to:
   - before hydration, `loaded` and the idle atom (unchanged; its JSDoc reason stands);
   - once hydrated, seed the node only if it is absent (the page the server rendered), then read the atom.

   Delete the key-change and new-`loaded` refreshes, the `seeded` ref, and the `useMemo` side effect. Seeding no longer happens in render, except the one hydration seed. Do that seed in a `useState` initializer, as `LiveShopSocket` names the socket, and say in its JSDoc why it is safe under StrictMode (an absent check, so it is idempotent).

5. **Router** (`getRouter`): `defaultGcTime: LIVE_RETENTION` and `defaultPreloadStaleTime: 0` (research §3.2). `staleTime` stays 0. Do not turn on `defaultPreload` (§8).
6. **Tests.**
   - Update the browser tests that seed (`OrdersIndexPage.test.tsx`, `run.test.tsx`, `workflows-list.test.tsx`, `home-and-kit.test.tsx` and any `grep -rln "seed" test/browser` finds).
   - Add a unit test for `liveLoad`'s three branches: "a kept read answers the loader with no request", "an absent read is fetched and seeded", and "the server always fetches".
7. **Simplify the orders spec** (research Q5).
   - `orders.spec.ts`'s "keeps its filters and page across the order page" waits for `listOrdersAnswer`, then `tableIdle`. With no background double refresh, `listOrdersAnswer` may never come (no request): remove it, keep `tableIdle`, and rewrite the comment above it to the new rule.
   - Run the embedded project. Run the test alone `--repeat-each=12` once, and record its pass count in §7.

### Step 4: `/app`'s guards

1. In `app.tsx`'s `beforeLoad`, the search checks (`shop`, `host`, `embedded`, `id_token`) stay first and run every time.
2. **`getShopifyApp`** is read once per document. In the browser, keep its answer for the document's life; on the server it is one call per request, as today.
3. **`authenticateApp`.** In the browser, reuse the last `Subscribed` answer for the same shop while it is under `GUARD_MAX_AGE` old; otherwise call it.
   - Never reuse an `Unsubscribed` answer, and never reuse across shops.
   - The server always calls it. The `plan_handle` billing redirect is a full page load, so it always calls it too.
4. **Hydration.** The first client-side navigation after hydration counts as fresh from the server's check: take the time from the `/app` match's `updatedAt` and the answer from its context. Put the cache where the router's `registry` lives (one per router), not in a module variable, so tests and the server's per-request routers never share it.
5. **Drop the cached answer** before `usePaymentRequired`'s `router.invalidate()` (§2). Leave the press invalidations alone. If you find another `/app` path that invalidates for an auth reason, drop it there too and record it in §7.
6. **Tests.** A unit or browser test per rule, each its own title:
   - "a navigation inside the window reuses the guard answer"
   - "a navigation after the window authenticates again"
   - "a refused socket drops the guard answer"
   - "the search checks run on every navigation"

   Run the embedded e2e project.

### Step 5: Memo log and structural sharing

1. **Memo log.** The Step 5 log line in `Runs.listOrders` and `Runs.listRuns` (wherever `ordersMemo` and `runsMemo` are read). Tell a hit from a miss without a second lookup that could race; say how in §7. Update the `runs.test.ts` expectations if log lines are asserted.
2. **Structural sharing** (research Q10). One combinator on `liveQuery`: on a new `Success`, reuse the previous value's references for unchanged sub-trees, comparing leaves with `Equal.equals` (effect-app's `replaceEqualDeep` and `structuralShare`). Test title: "a refetch that changed nothing keeps the value's identity".

### Step 6: Verify

1. Recount every §1 row with §A, plus Step 0's notice row. Record before and after side by side in §7, and explain any miss of a target.
2. **Spike S3.** On a full page load of the orders index and of the member's workflows list, check that the `s-page` the server rendered is the one that stays after hydration (a DOM node identity check in the frame, or the existing hydration marker). Check that there is no socket read for a seeded page. Record it.
3. Full `vp test` and `vp run test:e2e`; record counts and times.
4. Record anything left for the lead under Human steps requested. Staging is the lead's: it is a push, never `deploy:staging`.

## 5. Verification checklist

- `vp check`, `vp test` and `vp run test:e2e` are green at the end; counts and times are in §7.
- `grep -rn "withReactivity\|refreshOnWindowFocus\|refreshOnFocus" src/web` finds nothing, or each hit is explained in §7.
- No seed or refresh runs inside a render, except `useLiveRead`'s hydration seed, which is idempotent (read `live-read.ts`).
- `LIVE_RETENTION` is the only place 5 minutes is written for live retention and the guard window; the others link it.
- `ShopActorRpcs`, `BackendApi` and the actor's tables are unchanged (`git diff` on `src/contract`, `migrations`, `src/backend/shop-actor/*schema*`).
- `/app`'s `beforeLoad` still runs the search checks unconditionally, and never reuses an `Unsubscribed` answer (read it).
- Every new test title in §4 exists (`grep -rlF` each).
- §7 has the before and after counts for every §1 row.

## 6. Done when

- §1 holds in the embedded dev app; every step is green and committed; §7 is filled in.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step (`**2026-10-19, Step 2:** …`).

- A **deviation** is anything built differently from the step that specified it. Say what, and why.
- An **issue** is anything the plan did not predict. Say what you saw, what you did, and whether it is open.
- **Command results** carry counts and times, and §A's read counts.
- **Human steps requested** lists what only the lead or the user can do.

### Deviations

- **2026-10-19, Step 0:** variant (B) is built as "the notice refreshes the query node itself", not as a `Reactivity` registration inside the query's own lifetime. A seeded node is valid with no build (research §2.3), so a registration made by the query's build would never exist for a seeded page, and a seeded, shown page would never hear a notice. The keys live beside the query atom instead (a `WeakMap` from query atom to keys), the dispatcher walks `registry.getNodes()` and refreshes each matching query node once, and the wrapper reads the query as a tracked dependency (`get(query)`), so the query is observed exactly while the wrapper is shown. Atom's laziness does the rest: an observed node refetches at once, an unobserved one goes stale and refetches when next read.
- **2026-10-19, Step 0:** variant (A), the observer count, needs a mount hook outside the registry: Baton's live atoms are family members that outlive a mount, so a wrapper's build is not a mount (effect-app builds a new wrapper per `useQuery` call). The spike counted observers in a `show(registry, live)` helper, which in the app would be a `useEffect` in `useLiveRead`.
- **2026-10-19, Step 1:** no `recoverStuckWaitingOnMount` and no in-flight count. Spike S1's "interrupted refetch" case passed without it (Step 0, Command results): in (B) the wrapper is a tracked child of the query, so an interrupt only comes from an invalidation, which leaves the node stale, and a stale node rebuilds on its next read; an interrupt from outside (the socket dropping a call) ends as a `Failure`, not `waiting` (`AsyncResult.fromExitWithPrevious`). The test keeps its title and pins it.
- **2026-10-19, Step 1:** the key → kept atoms index is not a maintained index (effect-app's `trackByKeys`). `liveQuery` puts the keys in a `WeakMap` beside the query atom, and `refreshLive` walks the registry's nodes, so "kept" is exactly "has a node", with nothing to add or remove when a node is created or swept. One refresh per node per dispatch, however many keys match.
- **2026-10-19, Step 1:** `noticesAtom` calls `refreshLive` from this step, not Step 2: with `Atom.withReactivity` gone nothing listens on `Reactivity`, so notices would stop until Step 2. `refreshOnFocus` and `query.ts`'s `createIsomorphicFn` also went in this step, since `liveQuery` replaces the pipe that carried them.
- **2026-10-19, Step 1:** the inner queries carry `timeToLive: LIVE_RETENTION` too (AtomRpc's option), not only the wrapper, so a node a loader seeds before any page mounts it is kept as long.
- **2026-10-19, Step 2:** the connect notice is its own bus value, `Connected` (`BusNotice` in `shop-actor-client.ts`), not a `ShopActorNotice` the socket publishes on itself, so the dispatch can tell it from the actor's and skip the throttle and the hidden hold. `NoticeFrame` and the contract are unchanged; `Connected` never crosses the wire. Like a notice, it does not interrupt a read in flight but replays after it.
- **2026-10-19, Step 2:** the throttle is per key, as specified, so a node under two keys (`merchantUsageAtom`: `ORDERS_KEY` and `SYNC_KEY`) gets one leading refresh per key when both keys open a window apart. Windows that end at the same time are flushed in one pass, so their trailing refreshes reach such a node once. Not a cost today: the actor's notices name one key each except the sync's own.
- **2026-10-19, Step 2:** test titles. Legacy's are kept byte for byte: "a hidden tab defers its refetch to the next visibilitychange", and "a burst inside the window costs two refetches", which §4 Step 2.7 writes as "a burst of notices inside the window costs two refetches"; the rule is legacy's, so legacy's title wins and the §5 `grep -rlF` for §4's wording will not find it. Legacy's rule is per query (one hook per screen); here it is per notice key over every live query, which for one query is the same rule.
- **2026-10-19, Step 2:** `test/browser/shop-actor.ts` no longer merges `Reactivity.layer` into the test client layer: nothing reads `Reactivity` any more. The `as Layer.Layer<ShopActorClient>` cast went with it.
- **2026-10-19, Step 3:** `liveLoad` takes no `updatedAt`: the loader context has none (`cause`, `preload`, `abortController`, `deps`, `params`, `context`, `location`, `route`; router-core 1.171.34 `LoaderFnContext`), contrary to §2's reading of research §3.1. A browser fetch is stamped with its completion time inside `liveLoad`; the hydration seed is stamped with the leaf match's `updatedAt`, which `useLiveRead` reads off `useRouter({ warn: false })` (a live screen is its leaf route's page; `Date.now()` without a router, as in browser tests).
- **2026-10-19, Step 3:** two forms. `liveLoad({ registry, cause, query, fetch })` for a loader whose answer is the live read (orders index, usage, order page, home strip). `liveLoadAnswer({ …, request, live, withValue })` for the member's two pages, whose answer also carries who the member is and their teams, which no node holds. **How the workflows list learns its key before the fetch: it cannot.** The Backend resolves `team` against the member's teams, so the query is only known from an answer. `liveLoadAnswer` keeps the last answer per request (the URL's state, team, limit and search) in the registry, and answers from it while its node is kept, with the node's list in place of the old one. So the first visit of a member page in a document, the server-rendered one included, is read over HTTP once.
- **2026-10-19, Step 3:** a `stay` (`router.invalidate()`, or the same URL again) always reads over HTTP and reseeds. `MembershipWatch` and `usePaymentRequired` invalidate so that the server answers again; answering them from the registry would show a removed member their old teams.
- **2026-10-19, Step 3:** a kept node a notice marked stale is built by the loader's read of it (`Node.value()` builds a stale node), so its socket refetch starts in the loader instead of at the mount. Still one socket read, and the screen shows `waiting` until it lands.
- **2026-10-19, Step 3:** `seed` also creates the node (`registry.get` after `setSerializable`), so the read is kept from the loader on, not from the mount.
- **2026-10-19, Step 3:** `useLiveRead`'s hydration seed runs in the `useState` initializer of the browser's first render, which is the hydration render (`useHydrated` still false), and it only stores the value (`seedIfAbsent`, no node); the read of `atom` once hydrated consumes it. Its `key` and `seed` inputs are gone; it takes the inner `query`, optional, because the sync status is never seeded. The per-page `seedOrders`, `seedUsage`, `seedOrderDetail`, `seedWorkflowsList` and `seedMemberRun` are gone.
- **2026-10-19, Step 3:** the home loader seeds the usage from `homePlan` through `seedIfAbsentInBrowser`, a browser-only `seedIfAbsent`, so the server's registry is never touched.
- **2026-10-19, Step 3:** the `liveLoad` tests are split by runtime. "the server always fetches" is a Node unit test (`test/unit/web/client/live-load.test.ts`): outside the Start compiler `createIsomorphicFn` runs `.server()`. The two browser branches are in `test/browser/web/client/live-load.test.ts`, plus "a stay reads over HTTP even when the read is kept" (renamed in Step 6). The browser tests that seed needed no change past the `useLiveRead` call sites.
- **2026-10-19, Step 3:** `test/e2e/embedded/orders-screens.ts`'s `listOrdersAnswer` is deleted with its one use.
- **2026-10-19, Step 4:** the guard flow moved out of `app.tsx` into `appGuard` (`src/web/routes/-app-guard.ts`), which takes the two server functions and a clock, so a browser test can run it with stand-ins; `app.tsx`'s `beforeLoad` is `appGuard({ getShopifyApp, authenticateApp })`. The memo, `GUARD_MAX_AGE`, `forgetAppGuard` and `rememberHydratedAppGuard` are in `src/web/client/app-guard.ts`, where `ShopSocket` can import them. The memo is a `keepAlive` atom in the router's registry.
- **2026-10-19, Step 4:** the `shop`/`host` check now runs before `getShopifyApp`, not after: it needs nothing from it. The `embedded` and `id_token` checks still follow it, because their redirects are built from its `apiKey` and `appUrl`.
- **2026-10-19, Step 4:** the hydration seed of the memo is in `AppLayout`'s `useState` initializer, not in `beforeLoad`: `beforeLoad` does not run for the hydrated match. The `/app` route context now also carries `appUrl` (a public URL), so the hydrated document remembers `getShopifyApp` too and the first client navigation makes no guard request at all. The answer is remembered under the URL's `shop` with the match's `updatedAt`, only if nothing is remembered yet.
- **2026-10-19, Step 4:** a remembered answer's age is measured from when its request started (the guard's clock), not when it returned: the conservative end. §2's reading of Q3 held: `usePaymentRequired` is the only `/app` invalidation for an auth reason; the press invalidations (members, teams, workflows) and `Playground` keep the answer; `session.ts`'s `signOut` is the member side's.
- **2026-10-19, Step 4:** one test beyond §4's four, "another shop, Shopify's billing redirect and an unsubscribed shop always authenticate". "a refused socket drops the guard answer" is in `ShopSocket.test.tsx`, through a real 4402 close.
- **2026-10-19, Step 5:** a memo hit is told from a miss by key identity: the lookup adds the very key `Cache.get` was given to a `WeakSet` (`missed`), and the caller asks about its own key after the get. No second lookup, so a concurrent notice cannot race it; a caller that joined a lookup in flight logs a hit. Structural sharing is `shareStructure` inside `liveQuery`'s transform, walking plain objects and arrays only; a `Schema.Class` instance or `DateTime` is a leaf compared with `Equal.equals`.
- **2026-10-19, Steps 5–6:** finished by the lead's orchestrator, not the implementer (the implementer was stopped mid-Step 5). Step 5 ran its two test files, not the full `vp test`, and no e2e; Step 6 ran each full suite once.

- **2026-10-19, Step 6 (fix to Step 3):** `liveLoad` no longer reads over HTTP on a `stay`. The router calls a match `stay` whenever the same route holds the same place in the tree (router-core `matchRoutesInternal`: `previousAt` compares `routeId`, not the match id), so every filter change, Next and Previous page was a `stay` and read over HTTP, kept or not: the recount found 2 HTTP on Previous page and on a filter change with usage kept. Callers that want the server's answer now say so: `reloadFromServer(registry, router)` counts a reload in a `keepAlive` atom around `router.invalidate()`, and every live loader that runs meanwhile reads over HTTP. `usePaymentRequired` and `MembershipWatch` call it; the loaders lost their `cause` argument. A same-URL navigation is now answered by the registry. The browser test "a stay reads over HTTP even when the read is kept" became "a reload from the server reads over HTTP even when the read is kept".

### Issues

- **2026-10-19, Step 0:** the notice row could not be produced by Sync from Shopify: every one of the 42 stored orders on `mw10013-dev-shop-00` is a fixture order (`fixture-12xx`), which offers no Sync from Shopify, and the store's 3 Shopify orders are not stored. The notice was produced by `vp run fixture` (`LoadFixture`), which publishes one `ORDERS_KEY` notice to the shop's sockets. The same trigger is used for the after count. Not open.
- **2026-10-19, Step 3: a write inside the throttle window is read late.** `order-page.spec.ts` "an item matching two workflows waits for the merchant to choose, then changes" failed twice in a row: Attach, then Change workflow less than two seconds later. The change's notice fell inside the window the attach's notice opened, so the page read the new run when the window ended, after the test had already reopened the old run's drawer. Fixed in the spec: the gate is now the old drawer's heading going, with a comment saying why. The product consequence stands and is open: the merchant's own second write inside two seconds shows its result up to two seconds late. Legacy had the same rule (its throttle covered its own writes too).
- **2026-10-19, Step 3:** `orders-pages.spec.ts` "Next page shows the orders past the first 25, the fixture's cancelled order among them" failed once in the first embedded run and passed on its own rerun and in the second full run. Likely cause: Next pressed while the table was `loading` for the first connect's refetch (Polaris ignores the press), a race the old code had too. Not re-run further; open as a flake.

- **2026-10-19, Step 6, open: a full page load re-reads every seeded live query once over the socket.** Spike S3 on a full load: the orders index sent `MerchantListOrders`, `MerchantGetUsage`, `MerchantSyncStatus` (×2 in dev), the order page `MerchantGetOrderDetail`. The cause is the connect notice (`Connected`), which refreshes every shown live query when the socket opens, and the first open follows hydration. It is the kept reconnect rule, and on the first connect it covers notices missed between the SSR read and the socket opening. Cost: one socket read per live query per full load, no HTTP.
- **2026-10-19, Step 6, open: `orders-pages.spec.ts` flake, second sighting.** The full e2e run failed both of its tests in `beforeAll`: `getByRole('searchbox', { name: 'Search' })` resolved to 2 elements, both `id="P0-0"`, i.e. two copies of the index's search field at once, briefly. The spec alone, `--repeat-each=3`, passed 6/6 (1.0 min). The Step 3 failure of the same spec was likely this, not a press during `loading`. Spike S3 found one `s-page` once settled, so the double is transient, around hydration or the first navigation.
- **2026-10-19, Step 6:** spike S3 for the member's workflows list not run: the dev browser holds the merchant's admin session, not a member's.

### Command results

- **2026-10-19, Step 0: baseline**, embedded dev app on `mw10013-dev-shop-00`, §A's instrumentation (a `run-code` script kept outside the repo), `router.navigate`, 1.5 s wait. "dev" is the raw count; "prod" removes the StrictMode doubles, read off the `Interrupt` frames the client sends (one per doubled refresh). Guards = `getShopifyApp` + `authenticateApp`.

  | Navigation                                                     | HTTP (dev = prod)                                 | Socket dev                                          | Socket prod | Total prod |
  | -------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------- | ----------- | ---------- |
  | Home → orders index, first visit                               | guards + `listOrders` + `orderUsage`              | ListOrders ×2, SyncStatus, GetUsage ×2, 2 Interrupt | 3           | 7          |
  | Filter change (`show=no_workflow`, new deps)                   | guards + `listOrders` + `orderUsage`              | GetUsage                                            | 1           | 5          |
  | Next page (`after=…`)                                          | guards + `listOrders` + `orderUsage`              | GetUsage                                            | 1           | 5          |
  | Previous page (a cached match)                                 | guards + `listOrders` + `orderUsage`              | GetUsage ×2, ListOrders                             | 3           | 7          |
  | Index → order page, first visit                                | guards + `orderDetail`                            | none                                                | 0           | 3          |
  | Order page → index, revisit after 5 s                          | guards + `listOrders` + `orderUsage`              | SyncStatus, ListOrders, GetUsage                    | 3           | 7          |
  | Orders → home, revisit                                         | guards + `listOrders` + `setupFacts` + `homePlan` | GetUsage ×3, ListOrders, 1 Interrupt                | 3           | 8          |
  | Window becomes visible (on home)                               | none                                              | GetUsage, ListOrders                                | 2           | 2          |
  | Home → orders index, revisit                                   | guards + `listOrders` + `orderUsage`              | 7 Requests, 2 Interrupt                             | 5           | 9          |
  | Notice (`ORDERS_KEY`), index shown, order page left 3 s before | none                                              | ListOrders, GetUsage                                | 2           | 2          |

  The research's rows reproduce exactly. The notice row: the order page's node was already swept (400 ms TTL), so only the shown page refetched.

- **2026-10-19, Step 0: spike S1**, `test/browser/web/client/live-query-spike.test.ts`, on `shopTestRegistry` (a test `MerchantGetOrderDetail` handler that counts calls and answers after a delay; the queries are `ShopActorClient.query` atoms with their own serialization keys). Both variants passed all six cases (12/12, 1.9 s). As a control, today's shape (`Atom.withReactivity` + `Reactivity.invalidate`) fails three: "a kept live query nobody shows does not refetch on a notice" (1 fetch), "a kept live query refetches once when it is shown again after a notice" (2) and "a notice naming two keys refetches a query once" (2). **Kept (B)**: no observer bookkeeping, no mount hook, and no per-key index to maintain; (A) deleted. The "interrupted refetch" case covers three shapes (left mid-fetch then a notice while hidden; a refresh superseding one in flight; left mid-fetch and shown again) and none leaves `waiting` behind: with a tracked chain, an interrupt only happens by invalidation, which makes the node stale, and a stale node rebuilds when it is next read. effect-app's stuck case comes from its `get.subscribe` + `get.once` copies, which (B) does not have.
- **2026-10-19, Step 0:** `vp check` green; `vp test` 84 files, 1079 tests passed, 70 s.
- **2026-10-19, Step 4:** `vp check` green; `vp test` 87 files, 1092 tests passed, 59 s; `vp run test:e2e --project=embedded` 49 passed, 5.5 min. Spot check in the dev app (production counts, guards included): home → orders index 0 HTTP + `SyncStatus` (the home loader's arrival page and usage were kept); orders → home revisit `setupFacts` + `homePlan`, 0 socket.
- **2026-10-19, Step 3:** `vp check` green; `vp test` 86 files, 1087 tests passed, 59 s. `vp run test:e2e --project=embedded`: first run 45 passed, 2 failed (the two Issues above), 2 did not run, 5.9 min; after the spec fix, `order-page.spec.ts` alone 9 passed, then the full embedded project 49 passed, 5.8 min. "the orders index keeps its filters and page across the order page" alone with `--repeat-each=12`: 12/12 passed, 2.9 min.
- **2026-10-19, Step 2:** `vp check` green; `vp test` 84 files, 1083 tests passed, 61 s. `grep -rn "withReactivity\|refreshOnWindowFocus\|refreshOnFocus\|Reactivity" src/web` finds one hit, `liveQuery`'s JSDoc naming `Atom.withReactivity` as the shape it avoids.
- **2026-10-19, Step 1:** `vp check` green; `vp test` 84 files, 1079 tests passed, 60 s. The six S1 tests moved to `test/browser/web/client/live-query.test.ts` (titles kept), now over `liveQuery` and `refreshLive`.
- **2026-10-19, Step 6: after count**, embedded dev app on `mw10013-dev-shop-00`, §A, production counts (no StrictMode doubles seen on navigation), guards reused in every row:

  | Navigation                                          | Before | After                                                                                                                                      |
  | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
  | Home → orders index, first visit                    | 7      | 1 socket (`MerchantSyncStatus`; page and usage kept from home)                                                                             |
  | Filter change (new deps)                            | 5      | 1 HTTP (`listOrders`; usage kept)                                                                                                          |
  | Back to an earlier filter or page (a cached match)  | 7      | 0                                                                                                                                          |
  | Index → order page, first visit                     | 3      | 1 HTTP (`orderDetail`)                                                                                                                     |
  | Order page → index, revisit                         | 7      | 0                                                                                                                                          |
  | Index → order page, revisit                         | —      | 0                                                                                                                                          |
  | Orders → home, revisit                              | 8      | 2 HTTP (`setupFacts`, `homePlan`), 0 socket                                                                                                |
  | Window becomes visible                              | 2      | 0                                                                                                                                          |
  | Home → orders index, revisit                        | 9      | 0                                                                                                                                          |
  | Notice (`ORDERS_KEY`), index shown, order page kept | 2      | 2 socket (the shown page's `MerchantListOrders`, `MerchantGetUsage`), then 1 (`MerchantGetOrderDetail`) when the order page is shown again |

  Every §1 target met. Spike S3: a full load of the orders index and of an order page keeps the server's `s-page` through hydration (an init script recorded the first `s-page`; once settled it is the only one, the same node).

- **2026-10-19, Step 6:** `vp check` green; `vp test` 87 files, 1094 tests passed, 73 s (before the `reloadFromServer` fix; after it, the two `liveLoad` test files 4/4). `vp run test:e2e` (all projects) 5.7 min: every test passed but the two of `orders-pages.spec.ts` (Issues); that spec alone `--repeat-each=3` 6/6.

- **2026-10-19, Step 6:** after the `reloadFromServer` commit, `vp run test:e2e --project=chromium` on `member-workflows.spec.ts` and `members.spec.ts`: 9 passed, 41 s.

- **2026-10-19, after Step 6:** `orders-pages.spec.ts` simplified: it opens on `app/orders?q=<title>` instead of typing into the search field, so the brief second copy of the field cannot flake its setup. Kept: it is the only test of paging past 25 and of a notice on page 2. `--repeat-each=3`: 8 passed (setup included), 1.2 min.

### Human steps requested

- **2026-10-19, Step 6:** staging: push when ready (the lead's; never `deploy:staging`), then check a revisit of the orders index makes no request.

## 8. Out of scope

- `defaultPreload: 'intent'`. With `liveLoad`, a hover on a live route costs nothing when the read is kept; turn it on in a follow-up, measured.
- The member shop's `requireRole` guard (`shop.tsx`, `getMe` per navigation). This is the same shape as research Q3 for the member side; decide it separately.
- Making members, teams and the merchant's workflows pages live (research Q8).
- Invalidation finer than `ORDERS_KEY` (research Q9).
- Staging verification (the lead's, after this plan).

## A. Counting reads in the embedded app

Run in the app frame (`iframe[src*="embedded=1"]:not([src*="chrome=window"])`) through `vp exec playwright cli -s=dev --raw run-code`. It patches `WebSocket.prototype.send` (outgoing RPC `Request` tags; on first use per socket it also adds a `message` listener for notices and `Exit`s), a `PerformanceObserver` on `/_serverFn/` resources (the base64 id names the function), and the router's `onResolved`. It writes everything to `window.__lr`.

Navigate with `window.__TSR_ROUTER__.navigate({ href })`, the same call App Bridge's replayed Back makes. Keep the raw search and set or delete only `q`, `show`, `team` and `after`. Wait at least 1 s after each navigation (longer than any idle TTL bucket), then read and clear `window.__lr`.

A synthetic `visibilitychange` must bubble (`new Event("visibilitychange", { bubbles: true })`), because Effect's focus signal listens on `window`.

In development, every render-phase seed and refresh is doubled by StrictMode; count production as the dev count with those doubles removed, and say so.
