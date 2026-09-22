# Implementation plan: member navigation state and the queue → run rename

Decisions and reasoning are in `docs/member-nav-state-research.md`. This plan is for an
implementer who has not read that conversation. Read `CLAUDE.md` first; its rules on JSDoc,
`Domain` predicates, formatting and logging apply to every step here.

Two commits, in this order. Do not commit unless told to; stage the work and report.

1. **Rename** `queue` → `run` internally and "Queue" → "Workflows" for the member. No behaviour
   change. Every test passes before and after with only names changed.
2. **Navigation state**: filters in the URL on the `$shop` layout, retained across the member
   area; the mark styled as home; loader reads every filter.

Record anything you did differently, could not do, or found wrong in §6 as you go.

---

## 0. Ground rules for this work

- Run `pnpm typecheck` and `pnpm lint` after each step, and `pnpm fmt` repo-wide at the end of
  each commit; keep every file `fmt` touches.
- The member e2e projects run with `npm run test:e2e -- --project=member` (see
  `playwright.config.ts` for the project names). Run them at the end of each commit. The
  embedded and admin projects should be untouched by this work; run the full suite once at the
  end.
- Chrome MCP (`mcp__chrome-devtools__*`) is available for looking at the member pages while you
  work. `pnpm port` gives the dev server port; `pnpm seed` seeds members, teams and workflows.
  The member sign-in is by magic link; `e2e/member.ts` shows how the tests obtain a session,
  and `e2e/member-queue.member.spec.ts` (`openQueue`, `seedQueue`) shows how a populated screen
  is produced. Playwright's `--headed` is the alternative.
- JSDoc rule from `CLAUDE.md`: a rule is stated once on the symbol that enforces it and other
  sites `{@link}` it. Every renamed symbol keeps its JSDoc; rewrite the words, not the
  reasoning. Do not cite `docs/` from JSDoc.
- Search params are validated with Effect `Schema` through `Schema.toStandardSchemaV1`, as the
  existing `QueueSearch` in `shop.$shop.index.tsx` does. Do not add zod.

---

## 1. Commit 1: rename

### 1.1 Symbol mapping

Apply everywhere in `src/`, `e2e/`, `scripts/` and `docs/` is out of scope. Identifiers first,
then prose in comments and JSDoc (the word "queue" as a noun for this screen becomes "the
member's runs" or "the run list"; "queue page" becomes "run list" or "the member home"; a
sentence that reads badly after substitution is rewritten, not left).

| Today                                                     | After                                                 | Notes                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Domain.QueueTab`, `DEFAULT_QUEUE_TAB`                    | `Domain.RunTab`, `DEFAULT_RUN_TAB`                    |                                                                                       |
| `Domain.QueueTier`, `tierOf`                              | `Domain.RunTier`, `tierOf`                            | `tierOf` stays.                                                                       |
| `Domain.QueueQuery`, `sameQueueQuery`                     | `Domain.RunQuery`, `sameRunQuery`                     |                                                                                       |
| `Domain.QueueLimit`, `QUEUE_PAGE`, `QUEUE_LIMIT_MAX`      | `Domain.RunLimit`, `RUN_PAGE`, `RUN_LIMIT_MAX`        | `RunLimit` becomes exported in commit 2.                                              |
| `Domain.QueueStep`, `QueueRun`, `QueueItem`               | `Domain.RunListStep`, `RunListRun`, `RunListItem`     | `RunRun` is not a name. `RunListRun` is the row's run projection.                     |
| `Domain.QueueTeamCount`, `QueueCounts`, `QueueView`       | `Domain.RunTeamCount`, `RunCounts`, `RunListView`     |                                                                                       |
| `Domain.QueueLoaderData`                                  | `Domain.RunListLoaderData`                            |                                                                                       |
| `Domain.ListQueueInput`, `SubscribeQueueInput`            | `Domain.ListRunsInput`, `SubscribeRunsInput`          |                                                                                       |
| `ShopAgent.listQueue`, `subscribeQueue`                   | `ShopAgent.listRuns`, `subscribeRuns`                 | Update `callableEffect("ShopAgent.listQueue", …)` strings and log messages too.       |
| `ShopAgentClient.listQueue`                               | `ShopAgentClient.listRuns`                            |                                                                                       |
| `WorkflowRunRepository.listQueue`, `decodeQueueRuns`      | `WorkflowRunRepository.listRuns`, `decodeRunListRuns` | `listRunsForOrder` already exists and is unrelated; leave it.                         |
| `src/lib/queueTiers.ts`                                   | `src/lib/runTabs.ts`                                  | `TABS`, `TAB_LABEL`, `TAB_EMPTY` keep their names.                                    |
| `.queue-strip`, `.queue-strip-tabs`, `.queue-detail-line` | `.run-strip`, `.run-strip-tabs`, `.run-detail-line`   | `src/styles.css` and the e2e locators.                                                |
| `["shop-queue", shop, query]`                             | `["shop-runs", shop, query]`                          | The React Query key in `shop.$shop.index.tsx`.                                        |
| `queue-actions-`, `queue-undo-`, `queue-team-menu`        | `run-actions-`, `run-undo-`, `run-team-menu`          | DOM ids; the e2e spec matches `commandfor="queue-team-menu"`.                         |
| `e2e/member-queue.member.spec.ts`                         | `e2e/member-runs.member.spec.ts`                      | `openQueue` → `openRuns`, `seedQueue` → `seedRuns`.                                   |
| `src/routes/shop.$shop.work.$runId.tsx`                   | `src/routes/shop.$shop.workflows.$runId.tsx`          | Route `/shop/$shop/workflows/$runId`. `routeTree.gen.ts` regenerates; do not edit it. |

Also in `ShopAgent.ts`: comments that say "queue" meaning the ready-work concept in the
repository (`readyWhere.ts`, the `(teamId, completedAt)` index comment, the publish fan-out
comments) refer to the same member read and get the same wording. The bulk-import status
literal `"queued"` in `IMPORT_IN_FLIGHT` is Shopify's word and stays.

### 1.2 Member-facing text

| Where                                                   | Today                           | After                            |
| ------------------------------------------------------- | ------------------------------- | -------------------------------- |
| `shop.$shop.index.tsx` `head`                           | `Queue — Baton`                 | `Workflows — Baton`              |
| `shop.$shop.index.tsx` `<s-section accessibilityLabel>` | `Queue`                         | `Workflows`                      |
| `shop.$shop_.lapsed.tsx` body                           | "its work queue is unavailable" | "its workflows are unavailable"  |
| `e2e/member-area.member.spec.ts` locators               | `accessibilityLabel="Queue"`    | `accessibilityLabel="Workflows"` |

The work page's document title and heading are unchanged (it is headed by the order name).
Every other member-facing string was already free of "queue"; grep `src/` for `queue` inside
JSX string literals to confirm nothing is left.

### 1.3 Verify

- `grep -rni queue src e2e` returns only `"queued"` (the Shopify import status) and nothing
  else. Record any hit you decided to keep in §6.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `npm run test:e2e -- --project=member` all pass.
- `pnpm fmt`.

---

## 2. Commit 2: navigation state

### 2.1 The layout owns the search schema (`src/routes/shop.$shop.tsx`)

Add to the layout route:

```ts
import { retainSearchParams, stripSearchParams } from "@tanstack/react-router";

const MemberSearch = Schema.Struct({
  tab: Schema.optionalKey(Domain.RunTab),
  team: Schema.optionalKey(Domain.TeamId),
  limit: Schema.optionalKey(Domain.RunLimit),
});

export const Route = createFileRoute("/shop/$shop")({
  validateSearch: Schema.toStandardSchemaV1(MemberSearch),
  search: {
    middlewares: [
      retainSearchParams(["tab", "team", "limit"]),
      stripSearchParams({ tab: Domain.DEFAULT_RUN_TAB, limit: Domain.RUN_PAGE }),
    ],
  },
  …
});
```

Points to get right:

- `retainSearchParams` and `stripSearchParams` are exported from `@tanstack/react-router`
  (`refs/tan-router/packages/react-router/src/index.tsx`). Read
  `refs/tan-router/packages/router-core/src/searchMiddleware.ts` before use: `retain` copies a
  key from the current search into the built link when the link does not set it; `strip` drops
  a key whose value deep-equals the default. Confirm what `stripSearchParams` does with a key
  that is absent, and with `team: null` vs an absent `team`, and pick one representation for
  "all teams" (absent, recommended) so the URL never carries `team=null`.
- **Clamp `limit`, never reject.** `Domain.RunLimit` today is `Schema.Number.check(isBetween(1, RUN_LIMIT_MAX))`,
  which fails validation for `?limit=1000` and would surface the router's error boundary for a
  URL a member can type. The search schema must accept any number and clamp it into range
  (an Effect `Schema` transform, or a plain `Schema.Number` in the search schema and a
  `Domain.clampRunLimit` applied where the query is built). State the rule once on
  `Domain.RunLimit`'s JSDoc: the object refuses out-of-range, the URL clamps, and why (a typed
  URL is not a bug report). Choose the mechanism, record it in §6.
- **Unknown `team`.** The schema validates the shape (`TeamId` is a branded non-empty string),
  not membership. The screen treats a `team` not in `teams` as "All teams": the team menu's
  button label falls back to "All teams" already; make sure the query sent over the socket does
  the same (send `team: null`), or the object returns an empty list for a team the connection
  is not on. Decide and record.
- **The rule lives here.** Write the JSDoc on `MemberSearch` that states it: which keys are the
  member's context, that they travel with every link built under `/shop/$shop` and why
  (browser Back and the bar's mark must land on the same screen; a bench tablet is one member's
  place, so nothing in the URL is a sharing risk), and that `limit` is included so a return
  lands on the row the member left rather than on page one. The index route and `MemberBar`
  `{@link}` this rule rather than restate it.

### 2.2 The index route reads everything from the URL (`src/routes/shop.$shop.index.tsx`)

- Remove the route's own `validateSearch` (the layout's is inherited).
- Delete `useState` for `team` and `limit` and the JSDoc that explained them as client state.
- `Route.useSearch()` gives `{ tab, team, limit }` with defaults applied at the read site:
  `tab ?? DEFAULT_RUN_TAB`, `team ?? null`, `limit ?? RUN_PAGE`.
- `loaderDeps` returns all three; `LoaderInput` gains `team` and `limit`; the loader passes
  them into `listRuns` so the SSR paint is the narrowed and deepened read. `staleTime: Infinity`
  stays; the reasoning in its JSDoc now covers three keys, so reword it.
- `sameRunQuery(query, loaderQuery)` now matches on every return, so `initialData` is the
  loader's rows for the screen the member came back to. Keep the `data ?? loaderView` and
  `loading` logic; it still matters for the first press of a new key.
- The three setters become navigations, all `replace: true`:

  ```ts
  const selectTab = (next) =>
    navigate({
      search: (prev) => ({ ...prev, tab: next, limit: undefined }),
      replace: true,
    });
  const selectTeam = (next) =>
    navigate({
      search: (prev) => ({
        ...prev,
        team: next ?? undefined,
        limit: undefined,
      }),
      replace: true,
    });
  const showMore = () =>
    navigate({
      search: (prev) => ({
        ...prev,
        limit: Math.min((prev.limit ?? RUN_PAGE) + RUN_PAGE, RUN_LIMIT_MAX),
      }),
      replace: true,
    });
  ```

  `undefined` removes the key; verify that `stripSearchParams` and `retainSearchParams` agree
  with that (a key explicitly set to `undefined` must not be re-retained from the previous
  location; `searchMiddleware.ts` tracks `explicit` keys for exactly this). Test it in the
  browser before trusting it.

- `workLocation` needs no `search`: the middleware adds it. Confirm in the DOM that a row's
  `href` carries `?tab=…&team=…&limit=…` when those are non-default.
- The "Show N more" button's `disabled` check uses the URL's `limit`.

### 2.3 The work page (`src/routes/shop.$shop.workflows.$runId.tsx`)

No code change beyond the rename. Confirm `Route.useSearch()` is not needed there. Update the
"No breadcrumb" comment to `{@link}` the layout rule for why the bar's link lands on the
filtered screen.

### 2.4 The bar (`src/components/MemberBar.tsx`, `src/styles.css`)

- The `Link` stays around both the mark and the domain. Add `aria-label="Workflows"` and a
  class (`member-bar-home`).
- In `styles.css`, next to `.member-bar`: on `.member-bar-home:hover` and `:focus-visible`,
  give the mark's `svg` a visible affordance (a ring via `outline` or `box-shadow` using
  `var(--s-color-border-emphasis, …)` if Polaris exposes it, otherwise a 2px cobalt ring) and
  keep the domain text unstyled. The link has `textDecoration: none` inline today; move it to
  the class.
- Rewrite the `MemberBar` JSDoc paragraph that says the mark plus shop "doubles as back to the
  start": it now says the link is home, that it returns to the screen the member left (link to
  the layout rule), and why the domain is inside the link (touch target).
- No change to the `filter` slot.

### 2.5 Tests

Titles are rules. Add to `e2e/member-runs.member.spec.ts`, next to "the tab is in the URL and
switching tabs replaces it":

- **"the team is in the URL and switching teams replaces it"**: mate opens Up next, picks Cut
  team, URL has `team=<id>`, `goBack` leaves the member area (one entry). Then load
  `/shop/<shop>?team=<id>` cold and assert the first paint is narrowed (no Cut-team name on
  rows, count on the pressed tab is the team's).
- **"depth is in the URL and a return lands on the same depth"**: seed the volume fixture
  (the existing "Show 25 more" test shows how), press Show more, URL has `limit=50`, 50 rows.
  Load `/shop/<shop>?tab=upNext&limit=50` cold and assert 50 rows on first paint. Load
  `?limit=1000` and assert it clamps (100 rows or "Show more" disabled) with no error page.
- **"the bar's mark returns to the screen the member left"**: mate sets tab Blocked and team
  Cut, opens a row, asserts the work URL carries both keys, clicks the bar link (by its new
  accessible name), asserts URL and pressed tab and team button label all held. Then the same
  round trip with `page.goBack()`.
- **"a team the member is no longer on reads as all teams"**: load `?team=not-a-team` and
  assert the button says "All teams" and rows are unnarrowed. If you chose the "object returns
  empty" behaviour in 2.1, assert that instead and record it.

Update the existing tests whose locators or helpers changed in the rename. The
`member-area.member.spec.ts` test that clicks the shop link by the domain's name: the link's
accessible name is now the `aria-label`; adjust.

### 2.6 Verify

- Walk the flow in Chrome MCP or headed Playwright at 375 px wide: filters set, drill in, mark
  home, Back home, reload on the work page then mark home. Note the "Loading…" flash is gone on
  return.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, full `npm run test:e2e --`, `pnpm fmt`.

---

## 3. Out of scope

- Scroll position on the bar's link (TanStack scroll restoration is per history entry). Note
  in §6 if it is worse than expected in practice.
- Any change to the merchant area.
- The `/shop` picker and `lapsed` pages beyond the one string.

---

## 4. Files touched

Commit 1: `src/lib/Domain.ts`, `src/lib/ShopAgent.ts`, `src/lib/ShopAgentClient.ts`,
`src/lib/WorkflowRunRepository.ts`, `src/lib/readyWhere.ts`, `src/lib/useSubscribedQuery.ts`,
`src/lib/useMemberRunActions.ts`, `src/lib/SocketBanner.tsx`, `src/components/MemberRun.tsx`,
`src/components/MemberBar.tsx`, `src/lib/queueTiers.ts` → `src/lib/runTabs.ts`,
`src/routes/shop.$shop.tsx`, `src/routes/shop.$shop.index.tsx`,
`src/routes/shop.$shop.work.$runId.tsx` → `src/routes/shop.$shop.workflows.$runId.tsx`,
`src/routes/shop.$shop_.lapsed.tsx`, `src/routes/login-callback.tsx`, `src/styles.css`,
`e2e/member-queue.member.spec.ts` → `e2e/member-runs.member.spec.ts`, `e2e/member.ts`,
`e2e/member-area.member.spec.ts`, `e2e/fixture.ts`, plus generated `src/routeTree.gen.ts`.

Commit 2: `src/routes/shop.$shop.tsx`, `src/routes/shop.$shop.index.tsx`,
`src/routes/shop.$shop.workflows.$runId.tsx`, `src/components/MemberBar.tsx`,
`src/styles.css`, `src/lib/Domain.ts` (`RunLimit` export and clamp rule),
`e2e/member-runs.member.spec.ts`, `e2e/member-area.member.spec.ts`.

---

## 5. Report

When done, report: the two commits' contents staged, the test commands run and their results
verbatim if anything failed, and §6.

---

## 6. Deviations and issues (implementer fills in)

Record here, as you go, anything the reviewer needs to know that the diff will not say on its
own. One bullet each, with the file and the reason. Examples of what belongs here:

- A name in §1.1 you changed to something else, and why.
- The mechanism chosen for clamping `limit` (§2.1) and for an unknown `team`.
- Anything `stripSearchParams` or `retainSearchParams` did that the plan did not predict.
- A test in §2.5 you could not write as titled, and what you wrote instead.
- A `grep` hit for "queue" you kept.
- Anything in the plan that turned out to be wrong about the code.

- **`QueueCounts` → `RunListCounts`, not `RunCounts` (§1.1).** `Domain.RunCounts` already
  exists: the merchant order page's per-run counts (`Domain.runCounts`). `QueueTeamCount`
  became `RunListTeamCount` to stay in the same family. Every other name in §1.1 is as the
  table wrote it.
- **Names §1.1 did not list**, renamed the same way: `ShopAgent.readQueue` → `readRuns`,
  `WorkflowRunRepository.queueItems` → `runListItems`, `ShopAgentClient`'s local `queueView` →
  `runListView`, the index route's `QueueSearch` → `RunSearch` (deleted again in commit 2) and
  `renderQueue` → `renderRuns`, and in the tests `queueRows` → `runListRows`, `queueItem` →
  `runListItem`, `test/integration/member-queue-socket.test.ts` →
  `member-runs-socket.test.ts` with its three `queue-*.myshopify.com` fixtures → `runs-*`.
  §4's file list did not mention `test/`, which held about sixty references.
- **`grep` hits kept**, all of them a different sense of the word: the Shopify bulk-import
  status `"queued"`; the usage-event queue (`OrderRepository.queueUsageEvent` and the comments
  around it, `ShopAgent.flushUsageEvents`, `Domain.ShopUsage`, `ShopifyAppEvents`,
  `ShopAgentClient`); the socket's call queueing (`ShopAgentContext`, `ShopAgentSocketHost`,
  `useMemberRunActions`); `polarisModal`'s "a check queued by"; Cloudflare Queues in
  `Shopify.ts`; and one merchant-authored seed string in `e2e/fixture.ts` ("this jumps the
  bench queue"), which is a shop's own words on a step.
- **Two stale things found on the way.** `e2e/member.ts` cited
  `src/routes/shop.$shop.queue.tsx`, a file that does not exist; it now cites
  `shop.$shop.index.tsx`. `test/integration/member-area.test.ts` fetched
  `/shop/<shop>/work/none`, which the route rename would have left 404-ing for the wrong
  reason; it now fetches `/workflows/none`.
- **Clamping `limit` (§2.1).** `Domain.RunLimit` is exported and carries the rule; the URL's
  half is `Domain.clampRunLimit`, applied by a `Schema.decode` transform inside `MemberSearch`.
  The object's schema stays strict, so out-of-range on the wire is still a failure.
- **The plan's recovery shape does not work in this router.** `Schema.catchDecoding` returning
  `Option.none` — "drop the key, let the read site default it" — makes TanStack hand the route
  the **raw** text that failed validation: `?limit=abc` arrived at the loader as the string and
  the server function's validator threw, showing the router's error boundary, which is the
  exact failure the clamp exists to prevent. `?limit=1000` clamped correctly at the same time,
  so the bug was invisible in the passing case. Found by walking the URLs in Chrome, not by a
  test. Every recovery in `MemberSearch` now answers with a value.
- **Unknown `team` (§2.1).** The key is carried as plain text (`Schema.String`, capped at
  `Domain.TEAM_SEARCH_MAX`) rather than as `Domain.TeamId`: the branded non-empty check made
  `?team=` a failure with no id to recover to, and which ids mean anything is the roster's
  answer, not the schema's. Both the loader and the component resolve it against the teams
  `requireMember` returned and send `team: null` for anything else, so an id the member is no
  longer on reads as All teams with the list unnarrowed — not the "object returns empty"
  alternative, which would have been an empty screen explaining nothing.
- **`tab` recovers to the default too**, which the plan did not ask for. The schema moved up to
  the layout, so it now guards the work page as well: a mistyped `?tab=` would have put the
  error boundary over the whole member area rather than over one screen.
- **`stripSearchParams` removes `tab=mine`**, so the e2e `selectTab` helper could no longer
  assert `tab=<name>` in the URL for the landing tab. It reads the param and compares it
  against the default instead. That was the only existing test the middleware changed.
- **`undefined` removes a key and is not re-retained**, as §2.2 hoped: Show more writes
  `limit=50`, a tab or team switch clears it, and the bare `/shop/$shop` stays the canonical
  home URL. Confirmed in the browser.
- **Test shapes that differ from §2.5.** The volume fixture is 27 rows, so "50 rows at
  `limit=50`" is not observable; the depth test asserts 27 at `limit=50` and uses `?limit=0` →
  exactly one row as the sharp end of the clamp, with `?limit=1000` asserted only to render.
  The team test's Back assertion lands on the bare `/shop/$shop` (the entry before the tab
  switch) rather than out of the app, because the fixture's first history entry is the list
  itself; it is the same claim about `replace: true`. A fifth test was added for the rule the
  plan did not have — "a value the search schema cannot read falls back to the default" — and
  a `serverRows` helper counts rows in the **SSR HTML** through `page.request`, so "the first
  paint is narrowed/deepened" is asserted on the server's bytes rather than on a DOM the
  socket has already touched.
- **The ring paints its fallback colour.** Neither `--s-color-border-emphasis` nor
  `--s-color-border` (which `.member-bar` already uses) resolves outside Polaris's own
  elements, checked in the browser, so the fallback is the real value. Said so in the CSS.
- **Scroll position** is as §3 predicted: the mark returns to the top of the list. No worse
  than before, since the old behaviour lost the filters as well, and with the filters held the
  member lands among the right rows.
- **Pre-existing, untouched:** the work page defines no `head`, so its document title is the
  `/shop` parent's "Your shops — Baton". Noticed while walking the flow; §1.2 says the work
  page's title is unchanged, so it is.
