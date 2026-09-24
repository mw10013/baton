# Orders filters round trip plan

Date: 2026-09-24. Research and decisions: `docs/orders-filters-round-trip-research.md`. Read it first; this plan does not repeat the reasoning, only what to build.

## Outcome

On the embedded app, a merchant who sets filters and pages on `/app/orders`, opens an order, and comes back by breadcrumb, nav link or browser Back lands on the same filters and the same page. The same holds for `/app/workflows` and its `?status=` filter. Mechanism: a layout route per subtree owns the search schema and `retainSearchParams`, exactly as `src/routes/shop.$shop.tsx` does for the member area.

## Ground rules for the implementing agent

- Follow `AGENTS.md`. In particular: no commits, `pnpm fmt` repo-wide and keep everything it touches, JSDoc carries reasoning inline, predicates are `Domain` functions.
- The member area is the reference implementation. Before writing, read `src/routes/shop.$shop.tsx` (`MemberSearch`, the `search.middlewares` block) and `src/routes/shop.$shop.index.tsx` (`loaderDeps`, `selectTab`, `showMore`, `workLocation`). Match its shape; where this plan differs, the plan says why.
- TanStack facts this depends on, verified in `refs/tan-router/packages/router-core/src/router.ts`: a `navigate` without `search` builds an empty search (`applySearchMiddleware` returns `{}` when `dest.search` is absent); `retainSearchParams` in a route's `search.middlewares` runs for every destination under that route and copies the named keys from the current location. Do not restate these in JSDoc beyond a sentence; `MemberSearch`'s JSDoc already carries the rule and new JSDoc should `{@link}` or name it.
- Chrome MCP (`mcp__chrome-devtools__*`) is available for looking at the embedded app while working. `pnpm port` gives the dev port. The embedded app runs inside the Shopify admin iframe; `e2e/app.ts` (`gotoApp`, `appFrame`) shows how tests reach it.
- Record every deviation from this plan, and every issue found, in the last section of this file.

## Step 1: `src/routes/app.orders.tsx`, the orders layout

New file. File-route conventions make `app.orders.tsx` the parent of `app.orders.index.tsx`, `app.orders.$orderId.tsx` and `app.orders.from-shopify.tsx`; `src/routeTree.gen.ts` regenerates on `pnpm typecheck` or dev. Do not edit the generated file.

Contents:

- Move `OrdersSearch` out of `app.orders.index.tsx` into this file and add `after`:

  ```ts
  const OrdersSearch = Schema.Struct({
    q: Schema.optionalKey(Domain.OrderSearch),
    status: Schema.optionalKey(Domain.OrdersStatus),
    need: Schema.optionalKey(Domain.OrderNeed),
    team: Schema.optionalKey(Domain.TeamId),
    after: Schema.optionalKey(Domain.OrdersCursor),
  });
  ```

  Apply the `MemberSearch` "no value of these keys fails" rule: each key gets `Schema.catchDecoding` that answers a value, not `Option.none`. For these five the recovery is "drop the filter", which in this schema means the key is absent. `catchDecoding(() => Effect.succeedNone)` would hand the route the raw text (see `MemberSearch`'s JSDoc, "A recovery has to name a value, not drop the key"), so instead recover to a sentinel the component treats as null, or wrap the whole struct so a failing key is removed before decoding. Pick one, state it in the JSDoc, and test it (Step 6). Today a bad `?status=` on the index puts the router error boundary over the page; that is a bug this step fixes as a side effect, and the JSDoc should say so.

- Route:

  ```ts
  export const Route = createFileRoute("/app/orders")({
    validateSearch: Schema.toStandardSchemaV1(OrdersSearch),
    search: {
      middlewares: [retainSearchParams(["q", "status", "need", "team", "after"])],
    },
    component: () => <Outlet />,
  });
  ```

  No `stripSearchParams`: the index already keeps defaults out of the URL by omitting null keys, and there is no default value to strip.

- JSDoc on `OrdersSearch`, the normative statement for the subtree: the five keys are the merchant's context on the orders list; they live on the layout so the detail page's URL may carry them; `retainSearchParams` is what puts them on every link and navigation under `/app/orders`, including the `shopify:navigate` bridge's `navigate({ to })` in `src/routes/app.tsx`, which names no search. Say why the layout is `/app/orders` and not `/app`: the workflows index has its own `status` key and the two would collide, and orders filters do not belong on `/app/teams` URLs. `{@link}` `MemberSearch` as the pattern's origin rather than restating its reasoning.

- `from-shopify`: it now sits under a validated parent. Its own `validateSearch` is a passthrough and the router merges child over parent, so `shop`, `host` and `id_token` should reach the redirect as before. Verify by hand once (Step 7). If the layout's `Schema.Struct` turns out to strip them, switch the layout to a schema that preserves unknown keys and record the deviation.

## Step 2: `src/routes/app.orders.index.tsx`, the index

- Remove `OrdersSearch` and the route's `validateSearch`; the search type now comes from the parent. `Route.useSearch()` gains `after`.
- `loaderDeps` adds `after: search.after ?? null`. `OrdersLoaderInput` adds `after: Schema.NullOr(Domain.OrdersCursor)` and the loader passes it as `cursor`. Rewrite the loader JSDoc: it currently says "Paging past the first page is component state, so only the filter is a loader dep", which becomes false. The new sentence: the page is in the URL like the filters, so the SSR paint is the page the merchant left.
- Delete `cursors`, `setCursors`, `cursorRef` and the effect that publishes the ref then invalidates. The cursor is `after` from the URL and goes into `ordersQueryKey` (add it as a sixth element) and into `subscribeOrders` directly. Delete the JSDoc paragraphs about the ref and the stack.
- `setFilters` becomes a navigation with `replace: true` (decision 2) that also clears `after`. Use the functional form so retained keys are not re-spelled:

  ```ts
  void navigate({
    search: (prev) => ({ ...prev, q: next.q ?? undefined, status: ..., need: ..., team: ..., after: undefined }),
    replace: true,
  });
  ```

  JSDoc: a filter is a new list, so the page resets; `replace` because filters are a screen's state, not a trail (the run list's `selectTab` says the same, `{@link}` it or quote the rule once here and link from there).

- Paging. Next navigates to `after: view.page.nextCursor` with push (the default). Previous follows decision 4: `router.history.back()` when the previous history entry is this list one page up, otherwise navigate to `after: undefined` with `replace: true`. The router cannot say what the previous entry was, so keep a per-mount record of the pages this component itself pushed, seeded from the URL the way `seededSearch` is:

  ```ts
  const [pushed, setPushed] = React.useState<{
    readonly after: string | null;
    readonly depth: number;
  }>({ after, depth: 0 });
  if (pushed.after !== after) {
    // The URL moved under us (browser Back or Forward, a deep link, a filter change): the trail is unknown again.
    setPushed({ after, depth: 0 });
  }
  ```

  Next: navigate, then `setPushed({ after: next, depth: pushed.depth + 1 })`. Previous: if `pushed.depth > 0`, `router.history.back()` and `setPushed({ after: ???, depth: depth - 1 })` is not knowable, so on Back the seeded reset above fires and depth returns to 0; that is acceptable and means a second Previous goes to page one. State this limit in the JSDoc plainly. `hasPreviousPage` is `after !== null`.

  Deviation allowed: if while implementing you find `depth` never survives a `history.back()` anyway, drop the record and make Previous always `after: undefined` (page one) when `router.history.canGoBack()` is false, `history.back()` otherwise. Record which you did and why.

- Row link (decision 5). Replace `orderDetailHref`'s string with a location built through the router, as `workLocation` does in the run list:

  ```ts
  const router = useRouter();
  const orderLocation = (order: Domain.ShopOrder) =>
    ({ to: "/app/orders/$orderId", params: { orderId: String(order.legacyId) } }) as const;
  <s-link href={router.buildLocation(orderLocation(row.order)).href}>
  ```

  Check whether `orderDetailHref` has other callers (`grep -rn orderDetailHref src e2e`) before deleting it. The `shopify:navigate` bridge receives the full href including the query and calls `navigate({ to: href })`; confirm in the browser that the query survives that call (Step 7). If it does not, change the bridge in `app.tsx` to `navigate({ href })`, which `buildLocation` parses (`parseHref` branch in `router.ts`), and record it.

- The search draft's re-seed comment mentions "a back button"; leave it, it is now truer.

## Step 3: `src/routes/app.orders.$orderId.tsx`, the detail page

- No behaviour change is needed for the breadcrumb: `href="/app/orders"` goes through the bridge and the layout retains the keys. Leave the three breadcrumb `s-link`s as they are.
- Add one comment on the main breadcrumb saying the link names no search because the layout's middleware carries the merchant's filters and page back (`{@link}` `OrdersSearch` in `app.orders.tsx`). Mirror of the run list's `workLocation` comment.
- `Route.useSearch()` here now types the five keys. Nothing on this page reads them; do not start.

## Step 4: `src/routes/app.workflows.tsx`, the workflows layout (decision 3)

- New file, same shape as Step 1 with one key:

  ```ts
  const WorkflowsSearch = Schema.Struct({
    status: Schema.optionalKey(Schema.Literals(["active", "inactive"])),
  });
  ```

  with the same no-fail recovery. Middleware `retainSearchParams(["status"])`.

- `app.workflows.index.tsx`: remove the hand-written `validateSearch` and the `WorkflowsSearch` interface (the layout's type replaces it). Its JSDoc's point about a stale value reading as "no filter" moves to the layout schema's JSDoc. `setFilters` gets `replace: true` for the same reason as orders.
- `app.workflows.$workflowId.tsx` and `app.workflows.$workflowId_.edit.tsx` are children of the new layout (the `_` escapes only `$workflowId`). Their `href="/app/workflows"` breadcrumbs and `navigate({ to: "/app/workflows" })` calls after delete and after closing the editor now retain `status`. That is the intended behaviour; no code change. The edit route is opened as an `s-app-window`; a `?status=` on its URL is harmless. Add the same one-line comment on the detail page's breadcrumb as Step 3.

## Step 5: JSDoc alignment across the sites that state the rule

The rule "the list's context lives on the layout and travels by `retainSearchParams`" is now stated in three places. Per `AGENTS.md`, one is normative and the others link to it.

- Normative: `MemberSearch` in `shop.$shop.tsx`. Its JSDoc already says so and says "and so will any later child of this layout". Add one sentence naming that `/app/orders` and `/app/workflows` follow the same rule (`app.orders.tsx`, `app.workflows.tsx`) so a reader finds the siblings.
- `OrdersSearch` and `WorkflowsSearch`: `{@link}` `MemberSearch`, then state only what differs: which keys, why the layout is the subtree and not `/app`, that there are no defaults to strip, and (orders) that `after` is a page and the run list's `limit` is not a page, which is why Previous needs the history rule in Step 2.
- `shop.$shop.index.tsx` `selectTab` JSDoc carries the `replace: true` reasoning. Make it the normative statement ("filters are a screen's state, not a trail") and have the orders and workflows `setFilters` link to it.
- The `shopify:navigate` bridge in `app.tsx` (`AppProvider`): add a sentence that it passes no `search`, and that any subtree whose links must keep their context does so with `retainSearchParams` on its layout, not here.
- Remove every sentence that is now false: the orders loader's "only the filter is a loader dep", the `cursorRef` and stack paragraphs, the workflows index's hand-written-validator justification.

## Step 6: Tests

Rules get tests whose title is the rule (`AGENTS.md`). Look at `e2e/orders.spec.ts` for how the existing tests read the URL (`new URL(page.url()).searchParams.get("need")`) and click inside the frame, and `e2e/member-runs.member.spec.ts` for how the member side tests its round trip, if it does.

E2E, `e2e/orders.spec.ts`:

1. "the orders list keeps its filters and page across the order page": seed enough orders for two pages (`ORDERS_PAGE_SIZE` is 25; check `e2e/seed.ts` for a bulk seed helper), set a status filter and a team filter, press Next, open an order, click the Orders breadcrumb, assert the URL carries `status`, `team` and `after` and the table shows the second page. Then browser Back twice and Forward, and assert the same.
2. "a filter change resets the page and replaces history": on page two, change a filter, assert `after` is gone from the URL and that one browser Back leaves the orders list (lands on whatever preceded it, such as `/app`).
3. "a bad filter value reads as no filter": `goto` the orders URL with `?status=nonsense&after=nonsense` and assert the page renders with the Open view and no error boundary.

E2E, `e2e/workflows.spec.ts`: one test, "the workflows list keeps its status filter across the workflow page", mirroring test 1 without paging.

Unit, if the schema recovery in Step 1 has any logic of its own (a wrapper that drops failing keys), a Vitest test for it next to where it lives.

Run `npm run test:e2e -- e2e/orders.spec.ts e2e/workflows.spec.ts` and the full suite once at the end. Report failures with output; do not paper over them.

## Step 7: Manual verification with Chrome MCP

With `pnpm app:dev` running, in the dev store's admin:

1. Orders: filter, Next, open an order, breadcrumb back. Watch the URL of the admin page and the iframe (`mcp__chrome-devtools__list_pages`, `evaluate_script` on `location.href` inside the frame).
2. The "Orders waiting on this team" button on a team page still lands on `?team=` filtered orders.
3. The Shopify admin order-page link (`from-shopify`) still opens the order detail; check the Worker log for `render-app-bridge-missing-shop-host` (it must not appear).
4. Workflows: set Active, open a workflow, breadcrumb back; delete a workflow and confirm the list returns filtered.
5. Middle-click an order row (or read its `href`) and confirm the href carries the query.

## Step 8: Finish

`pnpm typecheck`, `pnpm lint`, `pnpm fmt` (keep everything it touches), `pnpm test`, the e2e runs above. Then fill in the section below. Do not commit.

## Deviations and issues

The implementing agent records here, as it goes, anything that differs from the plan and why, anything the plan got wrong about the code, and anything found along the way that is out of scope. One bullet each, dated. Leave nothing implied in chat only.

- 2026-09-24, Step 1 recovery. Picked a per-key recovery to an explicit `undefined`, written once as `lenientSearchKey` in `src/lib/searchParams.ts` and used by both layouts. A wrapper that drops failing keys would not work: the router computes a match's search as `{ ...rawSearch, ...validated }` (`matchRoutesInternal` in `router.ts`), so an omitted key keeps the raw text, while a key set to `undefined` replaces it and is left out of any URL the router writes. Unit test: `test/integration/search-params.test.ts`.
- 2026-09-24, Step 1 `from-shopify`. No change needed. The same spread keeps the handshake keys; verified by loading `app/orders/from-shopify?id=seed-9701` in the dev store: the detail page rendered with `admin_theme, embedded, hmac, host, id_token, locale, session, shop, timestamp` on its URL, and `render-app-bridge-missing-shop-host` did not appear in `logs/server.log`.
- 2026-09-24, Step 2 Previous. Neither the per-mount depth record nor the `canGoBack()` fallback. The depth record races the async `navigate` (the seeded reset fires before the URL moves), and `canGoBack()` is true whenever any entry precedes this one, including the order page. Instead Next pushes with history state `{ ordersNextPage: true }` (declared by module augmentation in `app.orders.tsx`), and Previous is `history.back()` on a marked entry and `after: undefined` with `replace` otherwise. The marker is per entry, so it survives Back, Forward and reload, and a second Previous works as long as each page was reached by Next.
- 2026-09-24, Step 2 `setFilters`. Takes a patch applied over `prev` instead of the full filter set from the render. The URL commits before the component re-renders with the new search, so a second control used in that window wrote the first control's old value back. The first e2e run hit this (In production, then the team select, left `status` unset). The workflows index got the same functional form.
- 2026-09-24, Step 2 bridge. Changed the `shopify:navigate` bridge in `app.tsx` to `navigate({ href })`. Row hrefs now carry a query, and `to` is treated as a path, so the query would not have been parsed as search. `href` runs the same search middlewares.
- 2026-09-24, Step 2 `orderDetailHref` had no other callers; deleted. `legacyId` is already a string, so no `String()`.
- 2026-09-24, Step 4 workflows `setFilters`. Removing the filter now has to pass `status: undefined`. Leaving the key out (the old `setFilters({})`) would let `retainSearchParams` put the old value back.
- 2026-09-24, Step 6 test 2. The plan's assertion "on page two, change a filter, one Back leaves the orders list" does not hold with Next pushing: Back from a filter change made on page two returns to page one of the old filter, which is the entry before the replaced one. The test checks that one Back leaves Orders after filters set on page one, and separately that a filter change on page two clears `after`.
- 2026-09-24, e2e helpers. `gotoApp` takes an optional `path`, the embedded counterpart of `gotoMember(page, path)`, so test 3 can land on `app/orders?status=nonsense&need=nonsense&after=nonsense` with the tunnel's reload rescue. URLs are read from `page.url()`, which the admin keeps in step with the app, as the existing orders tests do. The hoisted breadcrumb is drawn twice in the admin title bar (a back arrow with `aria-label` and a text button), so tests click `button[aria-label="Orders"]`.
- 2026-09-24, found while testing. `after=nonsense` decodes (any string up to 128 characters is an `OrdersCursor`), the repository reads it as page one, and Previous shows as enabled. Clicking it goes to page one. Harmless; not changed.
- 2026-09-24, workflows editor test. `workflows.spec.ts` "a fresh workflow turns on from the editor, then edits go through the draft" failed with and without this change. Three causes, all in the spec: (1) `closeEditor` located the admin's window by its hashed class `AppWindowModalDialog`, which the admin no longer renders; it now uses `getByRole("dialog")` and the Close button's role and name. (2) The admin now animates the window out, and an Edit pressed during that animation left no window open; `closeEditor` now waits for the editor iframe to go. (3) Nothing waited for the editor window to hydrate before the first click in it, and on a slow run the click was dropped; `openEditor` and the Create path now `awaitHydration(editor)`. `closeDevConsole` in `e2e/app.ts` also matched a hashed class (`ExtensionsTable`) and did nothing when it failed to match; it now reads the "Dev Console" heading by role. No class selectors remain in `e2e/`. Full suite: 62 passed.
- 2026-09-24, review. `Domain.OrdersCursor` now checks the `<processedAt>:<id>` shape as well as the length, so `after=nonsense` is dropped by the layout like the other keys and Previous stays off; the earlier "harmless; not changed" bullet is superseded. Unit test in `test/integration/domain.test.ts`; the "bad filter value" e2e test asserts Previous is disabled. Two JSDoc sentences fixed: `OrdersSearch` still described the bridge as `navigate({ to })` after the bridge moved to `navigate({ href })`, and the orders `setFilters` sentence about `null` versus `undefined` was garbled.
