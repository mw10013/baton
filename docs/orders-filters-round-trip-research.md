# Orders filters round trip research

Date: 2026-09-24

Problem: on the embedded app, set filters on `/app/orders`, open an order, press the breadcrumb (or the Orders nav link) and the list comes back unfiltered. The member area does not have this problem. This doc says why, and how to bring the member area's mechanism over.

## Why the member area keeps its filters

Three pieces, all in `src/routes/shop.$shop.tsx` and `src/routes/shop.$shop.index.tsx`.

1. **The search schema lives on the layout route, not the index.** `MemberSearch` (`tab`, `team`, `limit`) is the `validateSearch` of `/shop/$shop`, the layout above both the run list and the work page. So the work page URL is allowed to carry `?tab=&team=&limit=` even though the work page never reads them.
2. **`retainSearchParams` on that layout copies the keys onto every navigation whose destination is under it.** This is the actual mechanism. TanStack drops the search entirely on any navigation that does not name one (`applySearchMiddleware` in `refs/tan-router/packages/router-core/src/router.ts` returns `{}` when `dest.search` is absent), so a bare `to: "/shop/x/workflows/123"` would lose the filters. The middleware reads them off the current location and puts them back. The row link and the `MemberBar` mark both navigate without naming the keys, and both carry them.
3. **`stripSearchParams` keeps defaults out of the URL**, so the bare `/shop/$shop` stays canonical.

Two related but separate choices on the run list:

- Filter changes navigate with `replace: true`, so Back leaves the list rather than replaying every tab the member pressed.
- `staleTime: Infinity` on the index, because the socket owns the rows after the first read and the loader should not re-run on every return.

The row link is built with `router.buildLocation(...).href`, so the real `<a href>` carries the search too (middle-click, open in new tab).

## What the embedded orders pages do today

- `/app/orders/` (`src/routes/app.orders.index.tsx`) owns `OrdersSearch` (`q`, `status`, `need`, `team`) as its own `validateSearch`. The `/app` layout has no search schema and no middleware.
- The row link is a string: `orderDetailHref` returns `/app/orders/${legacyId}` with no query. It is an `s-link`, so App Bridge fires `shopify:navigate` and the bridge in `src/routes/app.tsx` calls `navigate({ to: href })`. No `search` in that call, so the router builds the detail URL with an empty search. The filters are gone from the history entry the moment the detail page is entered.
- The detail page's breadcrumb is `s-link href="/app/orders"`, same path, same loss. Browser Back does work today, because the list's own history entry still has its query string. It is only forward links back to the list that lose it.
- Filter changes on the index navigate with push (no `replace`), so Back from the detail page walks through every filter the merchant set.
- Pagination is a cursor stack in React state (`cursors` in the index component). It is not in the URL at all, so it is lost on any navigation, including Back.
- `/app/orders/from-shopify` forwards the whole Shopify handshake search to the detail page and has a passthrough `validateSearch`.

`/app/workflows/` has the same shape: `?status=` on the index only, a bare `href="/app/workflows"` breadcrumb on the detail page. It loses its filter the same way.

## Approaches

### A. Search schema and `retainSearchParams` on the `/app` layout

Move `OrdersSearch` to `src/routes/app.tsx` and add `retainSearchParams(["q", "status", "need", "team"])`. This is the member area's exact shape.

Cost: every link under `/app` carries the orders filters. Go from a filtered orders list to Workflows and the URL is `/app/workflows?status=all&team=...`, and `status` collides with the workflows index's own `status`. Rejected for that collision alone.

### B. A layout route for `/app/orders` (recommended)

Add `src/routes/app.orders.tsx` as a layout route with `validateSearch: OrdersSearch` and `retainSearchParams(["q", "status", "need", "team"])`. The index, `$orderId` and `from-shopify` become its children. The index keeps its `loaderDeps` and `useSearch`, minus its own `validateSearch`.

What this gives, with no change to the links themselves:

- Row link to the detail page carries the filters (the middleware puts them on the `navigate({ to })` the bridge makes).
- Breadcrumb and the Orders nav link from the detail page land on the filtered list.
- Nav to Orders from Workflows or Teams carries nothing, because the current location has none of the keys.
- The Teams page's `?team=` link still works as before: it names its search explicitly.

Things to verify while implementing:

- `from-shopify` under the layout. The layout's Effect `Schema.Struct` validates before the child's passthrough, and the child result is merged over it, so `shop`, `host` and `id_token` should survive to the redirect. Check it in the dev store link once, since this is what broke the first time that route shipped.
- The detail page's `useSearch` type now includes the four keys. Nothing there should read them.

### C. Fix each link by hand

Have `orderDetailHref` and the breadcrumb build their href from the current search. Works for the two links, but every future link under `/app/orders` has to remember, and the `shopify:navigate` bridge would still need to pass search through. The member area's JSDoc calls this out as the reason for the middleware. Rejected.

## Companion changes, each optional

1. **`replace: true` on filter changes** on the orders index, matching the run list. Back from the detail page then returns to the list once rather than replaying every chip.
2. **Build the row href through the router** (`router.buildLocation({ to: "/app/orders/$orderId", params }).href`) as the run list does, so open-in-new-tab also carries the filters. Without it the middle-click target is the unfiltered detail URL, which is harmless (the detail page ignores the filters) but inconsistent.
3. **Same treatment for workflows**: a `src/routes/app.workflows.tsx` layout with `status` retained. Same bug, same fix, but the `_.edit` route and delete redirects live under it, so it is a second, separate change.
4. **Pagination cursor.** See the next section.

## Pagination in the URL

The member side does have pagination in the URL, but of a different kind. The run list pages by `limit` ("Show 25 more"): one number, monotonic, no cursor. That is why it went into `MemberSearch` without ceremony.

The orders index pages by keyset cursor (`Domain.OrdersCursor`, `<processedAt>:<id>`, forward only, `ORDERS_PAGE_SIZE` rows per page) with an `s-table paginate` Previous/Next control. Forward-only means "Previous" is a stack of cursors already visited, held in React state. The stack is the only thing that does not fit a URL cleanly: it is unbounded and it is a trail, not a place.

What goes wrong today: open an order from page three, press the breadcrumb, land on page one with the filters (once B lands) but not the page. Same for Back. For a merchant working down a long list this is the same bug the filters had.

Why the first draft said leave it out: the cursor is plumbed through a ref rather than the query key, the loader always reads page one, and touching that felt like a second change. That is a cost, not a reason. The harm of doing it is small.

How it would work, one key `after`:

- `after` joins `OrdersSearch` on the layout, retained like the other four. A filter change navigates with `after: undefined` (the "new list, new cursor" rule the index already states).
- Next navigates to `after: view.page.nextCursor` with push, not replace. Each page is then a history entry, which is what makes Previous cheap.
- Previous is `router.history.back()` when the previous entry is this list, else navigate to `after: undefined`. Simplest rule that stays right on a deep link: a merchant who lands on `?after=...` from a shared URL has no previous page, and Previous takes them to page one.
- The loader reads `after` through `loaderDeps` and passes it to `listOrders`, so the SSR paint is the page the merchant left. The `cursorRef` plumbing goes away: the cursor is in the query key like the filters are.
- A cursor that no longer resolves (the row was deleted, or someone hand-edited it) is a keyset seek that lands on the next row after that position, so it degrades to a near-enough page rather than an error. Same "no value fails" rule as `MemberSearch`.

What it costs: `hasPreviousPage` becomes "this URL has `after`" rather than "the stack has depth", which is the same answer except on a deep link, where it now says yes and takes the merchant to page one. Acceptable.

Alternative considered: switch the orders index to `limit` like the run list. It would make the URL trivially right, but the Polaris table pattern is Previous/Next and the merchant list is far longer than a bench's; "show more" over a few hundred orders grows the DOM without bound. Not recommended.

Recommendation, revised: put `after` in the URL as part of this change. It is the same mechanism and the same bug.

## Decisions

1. Layout route on `/app/orders` only (approach B).
2. Filter changes use `replace: true`, like the run list.
3. `/app/workflows` gets the same treatment in this change: a `src/routes/app.workflows.tsx` layout retaining `status`.
4. `after` goes in the URL as described in "Pagination in the URL". Next pushes; Previous is `history.back()` when the previous entry is this list, page one otherwise.
5. Row hrefs are built through the router so the `<a href>` carries the search.

No open questions remain. The implementation plan is `docs/orders-filters-round-trip-plan.md`.
