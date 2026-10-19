# Loader and socket reads: research

Status: research, 2026-10-19. The 2026-10-18 brief, deepened. The libraries were read from installed source (`node_modules/effect/src/reactivity`, `node_modules/@effect/atom-react/src`, `refs/tan-router/packages/router-core/src`, which is identical to the installed 1.171.34 core), the reference app `refs/effect-tanstack-start`, legacy's `useLiveQuery` and effect-app's Atom query engine (§3.3) were compared, and reads were counted in the embedded dev app. No code has changed. The questions are in §6, each with a recommendation. 2026-10-19: every recommendation in §6 was accepted, Q3 with the 5-minute window spelled out under it.

## 0. Verdict on the brief

The brief has the right symptom and the wrong mechanism, and it undercounts.

- **Its read 1 rarely happens on a plain revisit.** The registry is built with `defaultIdleTTL: 400` (`getRouter`), so a node is swept 400 to 600 ms after its last subscriber leaves (§2.1). A page left for longer has no node, and `seed` creates one from the loader's answer with no fetch. Read 1 happens only when the next page shares the node (home ↔ orders index share the arrival page and the usage), or within that window.
- **Read 3 happens on every revisit.** The first render seeds a new node from the router's cached answer. The router then reloads in the background, the new `loaded` arrives, the node now exists, and `seed` refreshes it.
- **It misses a whole layer.** `/app`'s `beforeLoad` runs on every navigation and calls two server functions: `getShopifyApp` (a constant) and `authenticateApp` (Website, then Backend, then a token check and a plan resolve). That is two Worker round trips per click, before any page read.
- **It misses the usage read.** `orderUsage` and `homePlan` read the usage over HTTP on every navigation, and the usage node, shared by both pages, is refreshed over the socket as well.
- **In development every render-phase seed runs twice.** `useLiveRead` seeds inside `useMemo`, and StrictMode calls it twice, so a refresh is sent twice and the first is interrupted. Production sends one. The counts below remove these doubles.

The root cause is not a tuning knob. **Two caches hold one read**: the router's match cache (staleness `staleTime` 0, retention `gcTime` 5 min) and the atom registry (retention 400 ms, freshness from socket notices). Neither defers to the other. `useLiveRead` joins them in render and refreshes whenever either one changes. Both libraries document the opposite idiom: one cache owns freshness and the router only coordinates (§3).

## 1. Measured reads (embedded dev app, `mw10013-dev-shop-00`, 2026-10-19)

Instrumented in the app frame: `WebSocket.prototype.send` (RPC `Request` tags), a `PerformanceObserver` on `/_serverFn/`, and the router's `onResolved`. Navigations were `router.navigate`, the same call App Bridge's replayed Back makes. Each count is a production count (StrictMode doubles removed); "guards" means `getShopifyApp` plus `authenticateApp`.

| Navigation                            | HTTP (server fns)                                   | Socket RPCs                                                    | Total |
| ------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | ----- |
| Home → orders index, first visit      | guards 2 + `listOrders` + `orderUsage`              | `ListOrders` (shared arrival node) + `GetUsage` + `SyncStatus` | 7     |
| Filter change (`show=all`, new deps)  | guards 2 + `listOrders` + `orderUsage`              | `GetUsage`                                                     | 5     |
| Next page                             | guards 2 + `listOrders` + `orderUsage`              | `GetUsage`                                                     | 5     |
| Previous page (a cached match)        | guards 2 + `listOrders` + `orderUsage`              | `GetUsage` ×2 + `ListOrders`                                   | 7     |
| Index → order page, first visit       | guards 2 + `orderDetail`                            | none                                                           | 3     |
| Order page → index, revisit after 5 s | guards 2 + `listOrders` + `orderUsage`              | `SyncStatus` + `ListOrders` + `GetUsage`                       | 7     |
| Orders → home, revisit                | guards 2 + `listOrders` + `setupFacts` + `homePlan` | `GetUsage` ×2 + `ListOrders`                                   | 8     |
| Window becomes visible (on home)      | none                                                | `ListOrders` + `GetUsage`                                      | 2     |

What one click on Previous should cost is one read of page one, or none if nothing changed. It costs seven requests, three of them the orders index.

Not measured: a notice. From the code (§2.2) it refetches every live node that exists, mounted or within its idle TTL, at once, with no throttle and no hidden-tab deferral. Also not measured: the actor memo's hits. Nothing logs them. From the code, `Runs.listOrders` reads the D1 teams and the sync status live on every call, and the memo answers the page only when no `ORDERS_KEY` notice came in between.

## 2. Effect Atom, as installed (effect 4.0.1)

### 2.1 Node lifetime (`AtomRegistry.ts`, `RegistryImpl`, `NodeImpl`)

- A node is keyed by its serialization key when it has one (`atomKey`), otherwise by the atom object. It is created by the first `get`, `subscribe`, `mount`, `set` or `refresh`.
- `canBeRemoved` is `!keepAlive && listeners.size === 0 && children.size === 0`. On the last unsubscribe, `removeNode` either deletes the node or, when the atom has a TTL, puts it in a timeout bucket (`setNodeTimeout`). Bucket resolution defaults to `defaultIdleTTL / 2`, so our 400 ms means removal 400 to 600 ms after the last subscriber. Access within that window cancels the removal.
- Per atom: `Atom.setIdleTTL(d)`, `Atom.keepAlive`, `Atom.autoDispose`; on an RPC query, the `timeToLive` option (outermost atom only).
- An unmounted node within its TTL keeps its lifetime, so its fiber and its subscriptions stay live.
- **Every atom is lazy** (`isObserved` is `!lazy || listeners > 0 || observedChildren > 0`). An invalidated node that nothing observes goes `stale`, disposes its lifetime (interrupting its fiber) and fetches nothing. It rebuilds on the next `value()`, which is the next mount, and `makeEffect` shows the old value with `waiting: true` meanwhile (`AsyncResult.waitingFrom`). **This is "mark stale, refetch on the next mount", built in.** `Node.currentState()` returns `"stale" | "valid" | …`, so a loader can ask.

### 2.2 `withReactivity` defeats that laziness (`Atom.ts`, `factory.withReactivity`)

```ts
transform(
  atom,
  (get) => {
    get.addFinalizer(
      reactivity.registerUnsafe(keys, () => {
        get.refresh(atom);
      }),
    );
    get.subscribe(atom, (value) => get.setSelf(value));
    return get.once(atom);
  },
  { initialValueTarget: atom },
);
```

The wrapper subscribes to the query, so while the wrapper exists (mounted, or within its TTL) the query counts as observed, and an invalidation refetches it at once. Once the wrapper is swept, the query has no handler at all: if the query outlives the wrapper, it keeps a stale value and nothing marks it. `refreshOnWindowFocus` has the same shape. Neither carries the query's serialization key (`WithoutSerializable`), which is why `seed` writes to the inner query.

### 2.3 Seeding and hydration

- `registry.setSerializable(key, encoded)` only stores the value. **Every** `ensureNode` for that key consumes it, not only node creation, and for a node with no `initialValueTarget` it calls `setValue`: valid, with no build and no fetch. `seed`'s JSDoc ("consumes the value when it first creates the node") is wrong about an existing node, though `seed` never takes that path.
- Through an `initialValueTarget` (for example `ShopActorClient.query(…, { reactivityKeys, serializationKey })`), the value goes to `setInitialValue`, and `build` still runs `read`, so the RPC fires anyway. That is why our hand-built `.pipe(Atom.withReactivity(…))` over a serializable inner query is the right shape for seeding, and `reactivityKeys` is not.
- `Hydration.dehydrate` and `HydrationBoundary` (`@effect/atom-react`, `ReactHydration.ts`) are the documented SSR handoff. They are the reference app's pattern: the loader returns `dehydrate(atom, value)`, and the route renders `<HydrationBoundary state={[…]}>`. The boundary hydrates new keys during render and existing keys after commit, and it never compares `dehydratedAt`.
- `seed` stamps `AsyncResult.success(value)` with the browser's `Date.now()`, not the loader's read time.

### 2.4 Built-in freshness tools we don't use

- `Atom.swr({ staleTime, revalidateOnMount, revalidateOnFocus, focusSignal })`: revalidates on build when `Success.timestamp` is older than `staleTime`.
- `Atom.setLazy(false)`, `Atom.withRefresh(d)` (polling), `Atom.withFallback`, `Atom.optimistic`.
- `useAtomSuspense`.
- Mutations: `ShopActorClient.mutation` takes `reactivityKeys` per call, which invalidates them locally on success. We don't need this, because the actor's notice does it for every tab.

## 3. TanStack Router and Start, as installed (router-core 1.171.34)

### 3.1 Reload rules (`load-client.ts`, `createLoaderTask`)

- A match with no data always loads. A `success` match reloads when any of these holds:
  - it is `invalid`;
  - `shouldReload` returns true;
  - with `shouldReload` unset, it is older than `staleTime` (`preloadStaleTime` for a preloaded match) **and** one of: `cause === 'enter'`, its id changed within the route, or the href is unchanged.
- A layout that stays matched (`cause: 'stay'`) does not reload its loader. Its `beforeLoad` runs on every navigation; it is not cached.
- A reload of a `success` match runs in the background by default (`defaultStaleReloadMode: 'background'`): the cached `loaderData` renders and the new data is published after commit. `match.isFetching === 'loader'` meanwhile. `router.state.status` goes `idle` before the reload ends.
- Defaults:
  - `defaultStaleTime` 0;
  - `defaultPreloadStaleTime` 30 s;
  - `defaultGcTime` and `defaultPreloadGcTime` 5 min. GC runs at commit (`commitMatches`), with no timer.
- The cache key is `routeId + interpolatedPath + JSON.stringify(loaderDeps)`.
- Back and Forward have no special case. In the embedded admin they are a fresh `navigate` anyway (App Bridge).
- `router.invalidate()` marks every committed and cached match invalid, then reloads the active ones (blocking with `sync: true`). Cached ones reload when next used.
- After SSR, hydrated `success` matches do not reload in the browser (`hydrate`). The first client load only runs after an `ssr: false` or `'data-only'` boundary.
- The loader context has `cause` (`'enter' | 'stay' | 'preload'`), `preload` and `abortController`; `shouldReload` gets the same context.
- `loaderData` is a new object on each reload. Structural sharing is opt-in (`defaultStructuralSharing`) and skips class instances.

### 3.2 The documented idiom with an external cache

- `external-data-loading.md`: the router is the coordinator. The loader _ensures_ the data is in the external cache (`queryClient.ensureQueryData`, now `queryClient.query`), and the component reads the cache, not `loaderData`.
- `data-loading.md` ("Passing all loader events to an external cache"): keep the router's defaults, set `defaultPreloadStaleTime: 0`, and let the cache decide whether a fetch happens.
- Start's TanStack Query guide adds a Query `staleTime` of 30 s "to prevent an immediate repeat read when the browser receives fresh SSR data".

Legacy followed this half way. It had React Query `staleTime: Infinity` with notices as the only trigger, `gcTime` 30 min "so a retained loader match never outlives its Query data", `initialData` from the loader, `placeholderData: keepPreviousData`, a 2 s leading-and-trailing throttle on invalidations, and deferral while the tab is hidden (`refs/baton-legacy/src/lib/useLiveQuery.ts`, `useLiveQuery`). It also set `defaultPreloadStaleTime: 0`. The port kept the loader-plus-socket shape and dropped every one of these knobs.

### 3.3 Prior art: effect-app's Atom query engine

`effect-app/libs` (`packages/vue`, read at `c64841e`, 2026-10-13) replaced `@tanstack/vue-query` with Effect Atom (effect 4) and hit our exact problem. Vue-specific glue aside, `packages/vue/src/atomQuery.ts` (`buildQueryFamily`, `withQueryOptions`) and `queryLifetime.ts` are an atom recipe for TanStack Query semantics, with tests. The sibling `packages/vue-components` has no atom code.

- **Cache identity.** One `Atom.family` atom per handler and input.
- **gcTime is `Atom.setIdleTTL(…, 5 min)`, applied last**, so the whole chain stays alive through the idle window.
- **Invalidation marks idle queries stale and refetches only observed ones** (TanStack's `refetchType: "active"`).
  - `observeQueryAtom` counts the wrapper's observers on a `QueryLifetime` (`observers`, `invalidated`).
  - `atomsToRefetch` refreshes the atoms with observers and sets `invalidated` on the rest.
  - The next mount sees `invalidated` and refreshes once.
  - They do not rely on Reactivity's laziness. They refresh the atoms themselves (`invalidateSoft`, `invalidateAndAwait`) instead of `Reactivity.invalidate`. Its JSDoc gives the reason: "sending the whole key set through `Reactivity.invalidate` invokes one atom's registered callback once per matching key, repeatedly superseding the same fetch".
  - Pinned by `test/inactiveInvalidation.test.ts`: "does not refetch an unmounted query; remount does".
- **Freshness.** `Atom.swr({ staleTime: 5 s, revalidateOnFocus, focusSignal })`, with the signal combining window focus and the `online` event, plus a mount-time check (`isStaleResult` in `onMounted`).
- **A pitfall they found and fixed.** An interrupted refetch leaves the atom `Success` with `waiting: true` and no fiber running, so `swr` and every later mount skip it forever. That happens when the last subscriber leaves mid-fetch or a refresh supersedes one. `recoverStuckWaitingOnMount` counts in-flight fetches and refetches a waiting atom with none. Pinned by `test/interrupt-refetch-repro.test.ts`.
  - This matters to us twice: a longer TTL (§5.2) makes the case reachable, and `seed`'s render-time refreshes already interrupt one another under StrictMode.
- **Live queries** (`liveQueryInvalidation.ts`):
  - **Fine-grained matching.** Server-recorded read dependencies are matched against the writes a push reports, so only queries whose reads intersect are invalidated, not a coarse key like `ORDERS_KEY`.
  - **Throttle.** A per-query `maxDelayMs` coalesces a burst into one trailing refetch; with observers at different delays, the smallest wins.
  - **No lost writes.** Writes that arrive while a fetch is still discovering its dependencies are buffered and replayed when it ends.
  - **Reset.** A source reset (a reconnect) invalidates every live query.
- **Structural sharing.** `replaceEqualDeep` compares leaves with `Equal.equals`, so decoded Schema class instances keep their identity across refetches.
- **`initialData` is display-only.** It shows while the atom is `Initial` and is never written to the cache, so the mount still fetches. We already do better: `seed` writes the loader's answer, valid, with no fetch (§2.3).

## 4. Diagnosis

1. **No owner of freshness.**
   - The router reloads every live loader on every `enter`, because its cached answer could be stale.
   - The registry is refetched from render whenever a node exists or a new `loaded` arrives, because _its_ answer could be stale.
   - Each one compensates for the other, so both read.
2. **Retention mismatch.** Loader data is kept for 5 min, nodes for 400 ms. The router therefore renders cached answers whose node is gone, and `useLiveRead` has to reconcile them.
3. **Eager refetch of unseen nodes.** `withReactivity` refetches a node within its TTL on every notice. At 400 ms that is cheap, but it would make any longer retention costly. So the short TTL is load-bearing, which is how the port ended up there.
4. **Side effects in render.** `seed` runs from `useMemo`, so StrictMode doubles it, and React may also replay a render.
5. **Guards per click.** `/app`'s `beforeLoad` makes two Worker round trips on every navigation. One of them returns constants. The other repeats work every loader call does anyway (each one verifies the session token), and the socket already covers plan changes (`revoke` on any plan change → `paymentRequiredAtom` → `router.invalidate`).

## 5. Recommended design: the registry owns live data, the router coordinates

This is the TanStack external-cache idiom, with Effect Atom as the cache and socket notices as the invalidation. It keeps A2 (the first render is a server function, and the socket query is seeded from it) and A3 (one socket per tab, held by the layout).

1. **Refetch what is shown; mark the rest stale.** A notice refetches a live query only while a page observes it. A kept but unobserved query is marked invalidated and refetches once when it is next mounted. This is effect-app's `observeQueryAtom` and `atomsToRefetch` pattern (§3.3), already tested in production, ported into `shop-actor-client.ts`:
   - an observer-counting wrapper replaces `Atom.withReactivity`;
   - `noticesAtom` refreshes the observed atoms for each key and marks the others, instead of calling `Reactivity.invalidate`;
   - one refresh per atom, however many keys the notice names.

   Also port `recoverStuckWaitingOnMount`. The lighter alternative, registering reactivity on the query node itself so Atom's own laziness marks it stale (§2.1), is untested; S1 compares the two.

2. **Align the retentions.** Give live queries an idle TTL equal to the router's `gcTime`, both stated explicitly (5 min, the router's default). Remove the registry's 400 ms default for live atoms only; presses and the socket keep theirs.
3. **The loader asks the registry first.** The router context already carries `registry`. In the browser, a live loader checks the node:
   - `valid` → return its value, no read;
   - `stale` → return its value, and the mount refetches it over the socket: one socket read, shown as `waiting`;
   - absent → call the server function and seed the node: one HTTP read.

   On the server it always calls the server function. One helper (`liveLoad`) does this for every live route. Seeding moves out of render into the loader. The loader runs again on every `enter` (router defaults), and that is now cheap because the cache decides.

4. **`useLiveRead` shrinks.** Before hydration it renders `loaded` and reads the idle atom (unchanged: the holder still names the socket during hydration). Once hydrated it seeds the node only if it is absent (the hydrated first page, whose loader ran on the server), then reads the atom. It no longer refreshes on a key change or a new `loaded`.
5. **Router options:**
   - `defaultPreloadStaleTime: 0`, as legacy and both guides set it, so a preload asks the registry too;
   - `defaultPreload: 'intent'` becomes free for live routes, because a fresh node answers a hover with no read;
   - `staleTime` stays 0.
6. **Guards once per document** (Q3).
7. **Notices like legacy's** (Q4): a throttle, and deferral while hidden.

Expected cost, from the rules above:

| Navigation               | Now | After                                                          |
| ------------------------ | --- | -------------------------------------------------------------- |
| Revisit, no change since | 7   | 0                                                              |
| Revisit after a change   | 7   | 1 socket read                                                  |
| New page or new filter   | 5   | 1 HTTP read per page read (2 on the orders index: page, usage) |
| Previous                 | 7   | 0 or 1                                                         |
| A notice, _n_ pages kept | _n_ | the mounted ones only                                          |

The guards' two requests come off each row too if Q3 is accepted.

Rejected:

- **Socket-first SPA (brief's 2):** breaks A2 and preloading, and buys nothing over this design.
- **Drop only the refreshes (brief's 3)** and **router knobs only (brief's 4):** each leaves one cache second-guessing the other.
- **`staleTime: Infinity` on live routes (brief's 1):** with a 400 ms registry, the router would render cached answers the socket stopped watching minutes ago.
- **`HydrationBoundary` instead of `seed`:** the reference app's pattern. It is equivalent in effect, and it needs the server registry to build socket atoms, which `protocol` forbids by design. Keep `seed` and fix its JSDoc.

Spikes before a plan:

- **S1.** The live query wrapper, as unit tests on a test registry, adapted from effect-app's `inactiveInvalidation.test.ts` and `interrupt-refetch-repro.test.ts`:
  - a mounted query refetches on a notice;
  - an unmounted one does not, and refetches once on remount;
  - an interrupted refetch is never left `waiting` forever;
  - a notice naming two keys refetches once.

  Run the cases against both §5.1 variants, and keep the simpler one that passes.

- **S2.** A live loader reading the registry: the Previous and revisit rows above come out at 0 and 1 in the embedded app (recount with this doc's instrumentation).
- **S3.** The hydrated first page still keeps one `s-page` from SSR through hydration, with no extra read.

## 6. Questions, with recommendations

1. **Who owns a live read's freshness?** _Recommend: the registry (§5)._ The router only coordinates and never decides staleness for live data.
2. **How long are pages kept?** _Recommend: 5 min for both caches, stated in `getRouter` and on the live query helper._ Legacy kept 30 min. With laziness (§5.1) a kept node costs memory, not reads, so the number only bounds how stale a revisit can paint before its refetch: never stale, only `waiting`.
3. **Should `/app`'s guards run on every client navigation?** _Recommend: no. Run them on the document load and on `router.invalidate()`, and reuse the context in between._
   - Every loader's server function still verifies the session token.
   - A plan change already closes the socket and invalidates the router (`usePaymentRequired`).
   - `getShopifyApp` returns constants; read it once.

   This saves two Worker round trips per click. It is a security posture change, so it is yours to decide.

   **What each check does today, and the hole if it stops running on a click.** Code read: `Route.beforeLoad` in `app.tsx`, `BackendApi.authenticateAdmin`, `BackendApi.installedShop`, `SubscriptionPlan.resolve`.

   | Check                                                   | Today, per click                                                                     | Hole if it runs once per document                                                                                                                                                        | Size                                                                 |
   | ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
   | `shop`, `host`, `embedded`, `id_token` present (search) | Synchronous, no request                                                              | A client navigation built without `appHref` would no longer be bounced                                                                                                                   | None if kept: these checks cost nothing, so keep them on every click |
   | `getShopifyApp` (`apiKey`, `appUrl`)                    | One server function                                                                  | None: deploy-time constants                                                                                                                                                              | None                                                                 |
   | Session token valid                                     | `authenticateApp` verifies the bearer                                                | None: every loader's server function verifies the bearer too (`embeddedSessionToken`, `installedShop`), and the socket verifies at connect                                               | None                                                                 |
   | Shop installed                                          | `authenticateAdmin` (token exchange path)                                            | None for reads: `installedShop` refuses a shop with no `ShopSession` on every loader. Uninstall also closes the socket (`uninstalledAtom`)                                               | None                                                                 |
   | Offline token exchanged                                 | Only when missing; the dev log shows `exchanged` about once a session, not per click | A token lost mid-session (a cloud reset, an uninstall and reinstall in another tab) is not re-exchanged until the next document load, so the actor's Admin API calls fail until a reload | Small, and rare: a reload fixes it                                   |
   | Plan subscribed (`SubscriptionPlan.resolve`)            | Reads the D1 plan cache; a stale entry costs a Partner API read                      | **The real hole.** Loaders check the token and installation, never the plan. After a lapse, a tab keeps reading pages over HTTP until something reruns the guards                        | Bounded: see below                                                   |
   | Billing redirect re-read (`plan_handle`)                | Only when Shopify's redirect brings the merchant back                                | None: that redirect is a full document load, which still runs the guards                                                                                                                 | None                                                                 |

   **How the plan hole is bounded.** It is smaller than it looks.

   `SubscriptionPlan`'s cache already decides how fast a lapse is seen. Its JSDoc ("a ceiling on ignorance") gives a fresh window of up to a day, because Shopify sends no webhook for a freeze, a cancellation or an expiry. A per-click guard only re-reads the plan when that entry has expired, so today's detection latency is set by the cache, not by the click.

   And whenever the cache learns of a change, it revokes every open socket of the shop. `SubscriptionPlan.revalidate` calls `revoke({ by: "all" })` on any change of handle, whichever path learned it: a navigation, a socket connect, or the daily `revalidateStalePlans`. The tab's reconnect then gets a `402`, `paymentRequiredAtom` runs `router.invalidate()`, the guards rerun, and the merchant is redirected. With guards once per document, a lapse therefore reaches an open tab as fast as it does today.

   Two windows remain:
   - **A socket that cannot connect or reconnect** (a network that blocks WebSockets, or a revoke that failed and was only logged). Nothing reruns the guards, so loader-only pages (members, teams, workflows) keep reading over HTTP until a reload. Today the next click would redirect, if the cache entry had expired.
   - **A lapse that only a per-click `resolve` would have found**: a cache entry that expires while the tab is open and that nothing else re-reads before the daily check. Today a click re-reads it. Without per-click guards, it waits for a socket reconnect or the daily check, up to a day.

   What leaks in either window is reads of the shop's own data, by its own authenticated admin, after their plan lapsed. Nothing crosses shops, and no writes go through, because every write is a socket procedure and the socket is gated.

   **Ways to close the windows**, cheapest first:
   - (a) A maximum age on the reused context: rerun `authenticateApp` when it is older than 5 minutes, the same number as Q2. That bounds both windows at 5 minutes, for one request per 5 minutes instead of two per click.
   - (b) Check the plan inside `installedShop`. Every loader then pays the D1 plan read, which is close to today's per-click cost.

   _Recommend: once per document, plus (a). Keep the synchronous search checks on every click, and read `getShopifyApp` once._

   **Decided (2026-10-19): accepted as recommended.** Guards run on every full page load and on `router.invalidate()`. A client-side navigation reuses the last answer while it is under 5 minutes old, and reruns `authenticateApp` after that. The search checks run on every navigation.

4. **Port legacy's throttle and hidden-tab deferral?** _Recommend: yes, both, in `noticesAtom`:_ a 2 s leading-and-trailing throttle per key, and invalidations held while `document.visibilityState` is hidden and released on visible. Then remove `refreshOnFocus`: the socket's reconnect notice already covers a lost notice, which is legacy's reasoning for turning off refetch-on-focus. Today a webhook burst refetches every mounted read once per notice. effect-app's `maxDelayMs` (one trailing refetch per burst) is the same idea, and it also buffers writes that arrive during a fetch rather than interrupting it. That matters for us, because an interrupt reaches the actor after the SQL may already have run.
5. **Keep `loading` on the table during a background refetch?** _Recommend: yes, as legacy (`isFetching`)._ After §5 a revisit has at most one window, not two, and the orders spec's settle-wait can then be simplified, not removed. Polaris drops a press while it is loading, and that stays true.
6. **Should the loader carry the read's server time into `seed` (`AsyncResult.success`'s timestamp)?** _Recommend: yes, cheaply, as `updatedAt`._ `swr` and any later "last updated" UI then tell the truth. Low priority.
7. **Instrument the actor memo?** _Recommend: one debug log per lookup (`Runs.listOrders: shop=… memo=hit|miss`)._ §1 then measures the memo instead of inferring it. Ship it with the plan, not before.
8. **Do members, teams and the merchant's workflows pages become live?** _Recommend: not in this work._ They are loader-only and call `router.invalidate({ sync: true })` after a press, which is correct today. §5 makes them cheap to convert later.
9. **Finer invalidation than `ORDERS_KEY`?** _Recommend: not now._ effect-app matches the server's recorded reads against each write (§3.3). For us that would mean the actor's notice naming tables or rows, and the orders memo being keyed the same way. Revisit after §5 if the memo misses or the notice rate are measured to be a cost (Q7).
10. **Structural sharing on refetch?** _Recommend: yes, cheaply_, effect-app's `Equal`-based `replaceEqualDeep` as one combinator on live queries. A refetch that changed nothing then re-renders nothing. Low priority.
