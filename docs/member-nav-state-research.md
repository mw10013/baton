# Member navigation: the mark as home, filters that survive a round trip, and the word for the screen

Research for the member area (`/shop/$shop/*`). Status: decided 2026-09-21; no open questions.
The implementation plan is `docs/member-nav-state-plan.md`.

---

## 1. What is there today

### 1.1 The bar

`MemberBar` (`src/components/MemberBar.tsx`) is the only chrome above `s-page` on every member
screen. Its leading group is one `Link` to `/shop/$shop` wrapping both the `BatonMark` and the
shop domain. So the mark already is a link home; nothing styles either as a link.

The work page renders no `s-page` breadcrumb on purpose: the bar's link is a stride above the
heading, and a second link to the same place is one too many. That stays.

### 1.2 Landing-screen state, and where each piece lives

| State   | Where it lives                                    | Survives drill-down and return? |
| ------- | ------------------------------------------------- | ------------------------------- |
| `tab`   | URL search param, validated on `shop.$shop.index` | Only via browser Back           |
| `team`  | `React.useState` in the route component           | No                              |
| `limit` | `React.useState` in the route component           | No                              |

`team` and `limit` are client state by a documented decision (the comment on `useState` in
`shop.$shop.index.tsx`: "a bench does not share a team or a scroll depth"). That reasoning was
about sharing a URL, not returning to one, and sharing is no longer a concern.

### 1.3 Why the round trip loses state

The row's link is built with `router.buildLocation({ to: "/shop/$shop/work/$runId", params })`
and passes no `search`, so the work URL carries none. The bar's home `Link` passes none either.

- Browser Back returns to the landing screen's history entry, so `?tab=` is restored. `team`
  and `limit` are lost because the component remounts.
- The bar's link navigates to `/shop/$shop` with no search, so even `tab` resets.

The loader ignores `team` and `limit` (it reads every team, one page deep). The socket query
key `["shop-queue", shop, { team, tab, limit }]` does the narrowing, with the loader's rows as
`initialData` only when `sameQueueQuery` matches.

---

## 2. Constraints

- **Per-tab.** A member can have several browser tabs open on one shop. State must not leak
  between them, which rules out cookies and `localStorage`.
- **Two entry points home.** Browser Back and the bar's mark must land on the same filtered
  screen.
- **The `tab` decision already made.** `replace: true` on tab switches, so Back leaves the
  screen in one press. Nothing added may undo that.

---

## 3. The approach: search params on the `$shop` layout, retained by middleware

Move `validateSearch` from `shop.$shop.index` up to `shop.$shop` (the layout) and add
`search: { middlewares: [retainSearchParams([...]), stripSearchParams(defaults)] }` there.

How it works (`refs/tan-router/docs/router/guide/search-params.md`, "Transforming search with
search middlewares"): a middleware on a route transforms the search for every link or
navigation built to that route or its descendants. `retainSearchParams` keeps the named keys
from the current location unless the link sets them explicitly. The landing screen and the
work page are both descendants of `/shop/$shop`, so:

- The row link to the work page carries the filters without the row code changing.
- The bar's home link carries them back, without `MemberBar` knowing the keys.
- Browser Back is unchanged, since the landing screen's URL is what it was.
- Any future child of `$shop` gets the same behaviour for free.

Child routes inherit parent search
(`refs/tan-router/docs/router/how-to/share-search-params-across-routes.md`), so the landing
screen keeps reading `Route.useSearch()`.

Details:

- `stripSearchParams` keeps defaults out of the URL, so the bare `/shop/$shop` stays the
  canonical home URL.
- The work page URL carries filters it does not use. Harmless, and honest: the URL describes
  the member's context, not just the page.
- A `team` the member is no longer on: the socket read is already scoped to the connection's
  teams, so a stale value narrows to nothing rather than leaking. The schema accepts any
  `TeamId` and the screen treats an unknown one as "All teams" rather than erroring.
- `limit` is bounded by `Domain.QueueLimit` (1..100). An out-of-range value is clamped, not
  rejected. The one thing depth in the URL does not restore is scroll position on the bar's
  link (TanStack scroll restoration is keyed on the history entry); that is a follow-on.
- Team and depth changes become `navigate({ search: (prev) => ({ ...prev, … }), replace: true })`,
  the same shape as the tab switch. Tab and team changes reset depth, as they do today.
- The loader reads `team` and `limit` from `loaderDeps`, so a return to a narrowed or deepened
  screen is server-rendered that way and `initialData` covers it. This removes the "Loading…"
  flash on exactly the navigation this work is meant to make seamless.

---

## 4. The mark as home

The bar stays the home control, and it stays one link wrapping both the mark and the shop
domain, for the touch target (Polaris's minimum is 44 px; the mark alone is 24 px). What
changes is the styling: hover and focus ring on the mark so it reads as the control, the domain
plain beside it. The link gets an accessible label naming where it goes. This matches Shopify
admin, where the app icon in the left nav is the app's home. Accepted on trial.

No `s-page` breadcrumb on the work page.

---

## 5. The word "queue"

The member-facing text no longer says "queue" anywhere a member reads, except the document
title `Queue — Baton` and the section's `accessibilityLabel="Queue"`. Internally the word is
everywhere (`QueueTab`, `QueueQuery`, `listQueue`, `subscribeQueue`, `queueTiers.ts`,
`.queue-strip`, the query key, the e2e file name, and about 400 mentions in comments).

### 5.1 What the screen shows

A row is a `WorkflowRun`: one workflow started on one order line item. Not the order (an order
has several line items) and not the workflow definition (the merchant's `/app/workflows` list,
which a member never sees). Opening a row shows the run's steps, the actions on each, and the
run-level actions (Block, Unblock). So the member's home is a list of runs, and the tabs sort
those runs by the member's relation to their steps.

The domain already has this pair of words: `Workflow` for the definition and `WorkflowRun`
(`run` in every function name) for the instance.

### 5.2 Decision

Three layers, because the internal name cannot follow the member-facing word:

- **Member-facing: "Workflows".** Exact (each row is a workflow in progress on one item), it is
  the product's own noun, and a member's context has no definition to confuse it with. "Work"
  was the runner-up: safe, but it says nothing in the one place the app names what it is.
  Rejected: Runs (a batch term, the opposite of made-to-order), Items (names the thing to make,
  not the process the member acts on), Bench (a metaphor the shop may not share), Board
  (promises kanban), Jobs (collides with run and with Shopify Jobs), Home (names the place).
- **Internal: `Run*`.** `Workflow*` would sit beside the definition's `Workflow`,
  `WorkflowRepository` and `WorkflowLayout`, told apart only by file. The instance already has
  its word, so the `Queue*` family becomes the `Run*` family. The full mapping is in the plan.
- **URL: `/shop/$shop/workflows/$runId`.** The merchant's `/app/workflows/$workflowId` is a
  definition, but different area, audience and id type, so the same segment costs nothing, and
  the address bar says the word the page does.

The rename is its own commit, before the navigation change, so the two diffs stay readable.
