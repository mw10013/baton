# Loader and socket reads: research brief

Status: brief, written 2026-10-18 at the close of slice G. **Deliberately shallow**: it states the problem, what the code does today and the candidate directions, so that another model can dig deeper (read the libraries' source, measure in a browser, and recommend). Nothing here is decided and no code has changed.

## The problem

Going back to a live page the tab has already shown reads the same data three times. Found while root-causing a flaky orders e2e test in slice G (`docs/billing-plan.md` §7, "Follow-up round 1", item 2). The user's concern: reads cost money and time, and the orders index read (counts, filters, search) is the most expensive one in the app.

## How a page gets its data today

Every live screen has two transports for the same read:

- **The route loader**: a TanStack Start server function. It goes from the Website to the Backend (`BackendApi.*`) to the actor stub method. It runs on the server for the first document load (SSR) and in the browser on every client navigation. Example: `src/web/routes/app.orders.index.tsx` (`listOrders`, `orderUsage`).
- **The live query**: an Effect Atom query over the tab's one actor socket (a role-prefixed procedure, e.g. `MerchantListOrders`), tagged with a reactivity key (`ORDERS_KEY`). Every write's notice refetches every live query on that key (`src/web/client/shop-actor-client.ts`). It also refetches on window focus (`refreshOnFocus`, `src/web/client/query.ts`).

`useLiveRead` (`src/web/components/live-read.ts`) joins them. Before hydration the page renders the loader's answer. After hydration it seeds the query's node from the loader's answer (`seed` in `shop-actor-client.ts`) and reads the node from then on. `seed` writes the value only if the node does not exist yet; if it exists (a page left less than its idle TTL ago), it calls `registry.refresh` instead.

The router is created with defaults (`src/web/router.tsx`), so the loader's `staleTime` is 0.

## The three reads on a revisit

1. **First render.** `useLiveRead` seeds the node. The node still exists, so `seed` refreshes it: one socket read.
2. **The router's background reload.** The router shows its cached loader answer and re-runs the loader in the background (stale-while-revalidate, `staleTime` 0). That is one HTTP read: Website, then Backend, then actor.
3. **The second refresh.** The new loader answer reaches `useLiveRead`. Its effect sees a new `loaded` for the same key and seeds again, which refreshes the node: a second socket read. The JSDoc on `useLiveRead` says this is intended, because the cached loader answer may be stale.

A first visit to a page costs one read (the loader); the live query is seeded from it without a fetch.

Side effect: the table is `loading` in two windows, about one loader round trip apart, and Polaris's table ignores Previous and Next clicks while it is loading. The e2e flake was that dropped click; the spec now waits it out. App Bridge also replays an admin Back as a new navigation inside the frame, so "Back" here is always a router navigation (`docs/billing-plan.md` §7, the same item).

## What a read costs

- **Actor SQL.** The orders index and the workflows list are memoized per activation (`ordersMemo` and `runsMemo` in `src/backend/shop-actor/runs.ts`) and cleared by any notice that names `ORDERS_KEY`. So reads 2 and 3 usually answer from memory, not SQL. **Unverified:** that the memo hits in practice for the revisit's exact input.
- **Per read regardless of the memo.** An actor request, plus a D1 read of the shop's teams (they are part of the memo's key; check whether it is read before the memo lookup). Read 2 adds a Website and a Backend invocation with a session token check.
- **Not memoized.** The order page (`getOrderDetail`), the member's workflow page, members, teams, workflows: each repeated read runs its SQL again.
- Legacy had the same shape: its loader plus React Query `useLiveQuery`, with an `isFetching` double window.

## Candidate directions (for the deeper research to compare)

1. **Trust the socket after the first load.** A live route gets a long `staleTime` (or `staleTime: Infinity` with invalidation on notices), so the router does not re-run its loader on a revisit. `useLiveRead` does not refresh a node that still exists. Revisit: zero reads; new page: one. Small and shared. Open question: does a node that is alive but unmounted still refetch on a notice (`Atom.withReactivity`), or only get marked stale, and what is the registry's idle TTL? If it only goes stale, a revisit needs exactly one read, not zero.
2. **Socket-first SPA.** Loaders read only during SSR. After hydration each page reads over the socket alone and shows its own loading state on a first visit. One transport after the first load, but it touches every route and the loading UX, and loses router preloading. This is an architecture change, so it needs a decision against roadmap §0.1 A2 ("a read a page needs on first render is a server function; the socket query is seeded from it").
3. **Keep both and drop only `useLiveRead`'s refreshes.** Two reads become one on a revisit, but the router's background reload stays.
4. **Router-side caching only.** Use `staleTime`, `gcTime` or `shouldReload` per route, and leave `useLiveRead` as is. Check how each interacts with seeding.

## Questions for the deeper research

1. Exactly how many reads happen per navigation kind (first load, new page, revisit, filter change, Next and Previous, window focus, a notice)? Count them in a browser (Network panel plus actor logs).
2. Effect Atom: the idle TTL of a query node, and what `withReactivity` does to an unmounted live node on invalidation (`refs/effect`, `effect/reactivity`).
3. TanStack Router and Start: the semantics of `staleTime`, `gcTime`, `shouldReload` and `preload` on a revisit and a Back, and whether a loader can skip its fetch in the browser while still serving SSR.
4. Does the actor memo hit on reads 2 and 3? What does each read cost in Durable Object requests, rows read and D1 queries?
5. Which direction keeps one `s-page` alive from SSR through hydration (slice E's lesson) and the loader-seeded first render that A2 requires?
6. How should a notice that arrives while a page is not mounted be handled, so that a revisit is never stale?

## Files

`src/web/components/live-read.ts`, `src/web/client/shop-actor-client.ts` (`seed`, the query atoms, `seedOrders` and friends), `src/web/client/query.ts`, `src/web/router.tsx`, the live routes under `src/web/routes/` (`app.orders.index.tsx`, `app.orders.$orderId.tsx`, `app.index.tsx`, `app.members.index.tsx`, `app.teams.index.tsx`, `app.workflows.index.tsx`, `shop.$key.workflows.index.tsx`, `shop.$key.workflows.$runId.tsx`), `src/backend/shop-actor/runs.ts` (memos), `docs/legacy-port-research.md` §0.1 A2–A3.
