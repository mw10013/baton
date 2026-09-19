# Member queue tier views: implementation plan

Companion to `docs/member-queue-tier-views-research.md`, which holds the measurements, the
options, and the decisions (§6 and §8 there). This document is the hand-off: an implementer
should be able to work from it without re-reading the research, but every "why" lives there.

**Status: implemented 2026-09-19.** Deviations in §10, concerns in §11.

## 0. Rules for the implementer

1. **No migration files.** Durable Objects and D1 are reset from scratch during prototyping. This
   plan needs no schema change; if one turns out to be needed, it goes inline into the
   `1_initialize schema` migration in `src/lib/ShopAgent.ts` and is recorded in §10.
2. **Every cap constant carries a provisional JSDoc** saying the number is a proposal, not a
   tuned figure. JSDocs must not reference files under `docs/`.
3. **Effect idioms throughout**: `Effect.fn`, `Effect.gen`, `sql` template literals, tagged
   errors, `Effect.annotateLogs` for structured log fields. Copy the surrounding style of each
   file you touch.
4. **Lowercase SQL keywords, positional parameters** (the `sql` tag does this).
5. **Log format** from CLAUDE.md: `<operation>: shop=<shop> key=<value>: <detail>`; every value
   in the message also goes in `annotateLogs`.
6. **Run after each step:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, then `pnpm fmt`
   repo-wide, keeping every file it touches. Run the member E2E project after step 5 and step 6:
   `pnpm exec playwright test --project=member` (the `setup` project runs with it).
7. **Do not commit.** Leave the working tree for review.
8. **Record deviations in §10 as you go**, not at the end. A deviation is anything this plan
   says that turned out wrong, impossible, or worse than an alternative you took. Record
   concerns (things you are now living with) in §11.
9. Steps are ordered so each leaves the app working. Do them in order.
10. **Keep the invalidate-and-refetch model.** The push stays `{ type: "invalidated" }` with no
    payload. Do not add delta pushes, sequence numbers, tier-scoped pushes, content hashes, or
    client-side patching. Do not add virtualization. All of these were considered and rejected
    or deferred in the research.
11. **Polaris web components only** (`s-*`). No new dependencies.

## 1. Scope

| Step | Change                                                                               | Files                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Domain: `QueueTab`, `QueueQuery` v3, `QueueCounts`, `QueueView` v3, `sameQueueQuery` | `src/lib/Domain.ts`, `src/lib/queueTiers.ts`                                                                                        |
| 2    | Repository: `listQueue` returns counts plus one tab's rows                           | `src/lib/WorkflowRunRepository.ts`                                                                                                  |
| 3    | Object: `readQueue` assembles `QueueView` v3; log gains `tab=`                       | `src/lib/ShopAgent.ts`                                                                                                              |
| 4    | Route: search param, loader deps, tab strip, team select, one list, clamp            | `src/routes/shop.$shop.index.tsx`                                                                                                   |
| 5    | Integration tests                                                                    | `test/integration/workflow-run-repository.test.ts`, `member-queue-socket.test.ts`, `shop-agent-workflows.test.ts`, `domain.test.ts` |
| 6    | E2E                                                                                  | `e2e/member-queue.member.spec.ts`                                                                                                   |

Out of scope: the work page, the merchant order pages, the orders sync, `useSubscribedQuery`
(no change needed), `ShopAgentClient` (signature unchanged, types flow through), any push change.

## 2. Domain (step 1)

All in `src/lib/Domain.ts` unless noted. Delete what this section says to delete; do not leave
the old shapes beside the new ones.

### 2.1 Constants

Delete `QUEUE_TIER_CAP`, `QueueLimits`, `DEFAULT_QUEUE_LIMITS`, `isDefaultQuery`. Keep
`DONE_WINDOW_MS`, `QUEUE_LIMIT_MAX` (100). Replace `QUEUE_PAGE`:

```ts
/**
 * Provisional. The rows one tab returns before it offers "Show more", and the
 * size of each "more". One number for every tab: a member's own tab (Mine) is
 * the one they scroll least and the one that must fit, and at ~50 px a row 25
 * is under two phone screens. A proposal, not a tuned figure.
 */
export const QUEUE_PAGE = 25;
```

### 2.2 `QueueTab`

Keep `QueueTier` (the four tiers `tierOf` returns) as is. Add:

```ts
/**
 * The five screens of the member queue, in strip order: what I am finishing,
 * what I can start, what a teammate is holding, what has stopped, what can be
 * undone. Four are the tiers of `tierOf`; `done` is the finished-steps window.
 * The tab is the unit of a read: one read returns every tab's count and one
 * tab's rows.
 */
export const QueueTab = Schema.Literals([
  "mine",
  "upNext",
  "inProgress",
  "attention",
  "done",
]);
export type QueueTab = typeof QueueTab.Type;
export const DEFAULT_QUEUE_TAB: QueueTab = "mine";
```

### 2.3 `QueueQuery` v3

```ts
const QueueLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: QUEUE_LIMIT_MAX }),
);

/**
 * What the browser may choose about its queue: one of its own teams to narrow
 * to (`null` is every team on the connection), which tab, and how many rows of
 * that tab. `team` is validated against the connection's `teamIds` by the
 * object; a team the member is not on reads as an empty queue, never as an
 * error. The counts of every tab come back regardless of `tab`, so the strip
 * is always current.
 */
export const QueueQuery = Schema.Struct({
  team: Schema.NullOr(TeamId),
  tab: QueueTab,
  limit: QueueLimit,
});
export type QueueQuery = typeof QueueQuery.Type;

/**
 * Structural equality, for deciding whether the loader's rows may serve as
 * the socket query's `initialData`: the route rebuilds the value on every
 * press, and the loader's own query is built from the URL.
 */
export const sameQueueQuery = (a: QueueQuery, b: QueueQuery) =>
  a.team === b.team && a.tab === b.tab && a.limit === b.limit;
```

### 2.4 `QueueCounts` and `QueueView` v3

Delete `QueueTierView` and the old `QueueView`. Keep `QueueTeamCount`, `QueueItem`, `QueueStep`,
`DoneItem`.

```ts
/**
 * The strip. `mine`, `upNext`, `inProgress`, `attention` and `done` are the
 * counts of the five tabs **after** `query.team` narrows them, because they
 * describe the lists the member can switch to. `total` and `teamCounts` are
 * over every team on the connection regardless of `query.team`, so the team
 * select does not move under the finger.
 */
export const QueueCounts = Schema.Struct({
  mine: Schema.Number,
  upNext: Schema.Number,
  inProgress: Schema.Number,
  attention: Schema.Number,
  done: Schema.Number,
  total: Schema.Number,
  teamCounts: Schema.Array(QueueTeamCount),
});
export type QueueCounts = typeof QueueCounts.Type;

/**
 * One read of the member queue: every tab's count and one tab's rows. Exactly
 * one of `items` and `done` is populated: `items` when `query.tab` is a tier,
 * `done` when it is "done". The selected tab's total is `counts[query.tab]`.
 * One value rather than two reads so the loader and the socket paint the same
 * snapshot and the strip never disagrees with the list under it.
 */
export const QueueView = Schema.Struct({
  counts: QueueCounts,
  items: Schema.Array(QueueItem),
  done: Schema.Array(DoneItem),
});
export type QueueView = typeof QueueView.Type;
```

### 2.5 Loader data

`QueueLoaderData` gains the query the loader read, so the route can compare:

```ts
export interface QueueLoaderData {
  readonly shop: string;
  readonly memberId: string;
  readonly memberEmail: Email;
  readonly teams: readonly Team[]; // whatever it is today
  readonly query: QueueQuery;
  readonly view: QueueView;
}
```

`ListQueueInput` and `SubscribeQueueInput` are unchanged in shape (`query: QueueQuery`); the new
`QueueQuery` flows through.

### 2.6 `src/lib/queueTiers.ts`

Replace `TIERS` / `TIER_LABEL` with the strip:

```ts
import type * as Domain from "@/lib/Domain";

/** Strip order and labels. Presentation only; the object decides membership and counts. */
export const TABS = [
  "mine",
  "upNext",
  "inProgress",
  "attention",
  "done",
] as const satisfies readonly Domain.QueueTab[];

export const TAB_LABEL: Record<Domain.QueueTab, string> = {
  mine: "Mine",
  upNext: "Up next",
  inProgress: "In progress",
  attention: "Blocked",
  done: "Done today",
};

/** What an empty tab says, and which tab it points at. */
export const TAB_EMPTY: Record<
  Domain.QueueTab,
  { readonly text: string; readonly goTo: Domain.QueueTab | null }
> = {
  mine: { text: "Nothing in hand.", goTo: "upNext" },
  upNext: { text: "Nothing to start.", goTo: null },
  inProgress: {
    text: "Nobody on your teams has work in progress.",
    goTo: null,
  },
  attention: { text: "Nothing is blocked.", goTo: null },
  done: { text: "Nothing finished in the last day.", goTo: null },
};
```

Keep the existing JSDoc's reasoning about why the `attention` tier reads **Blocked**; move it
onto `TAB_LABEL`.

## 3. Repository (step 2)

`src/lib/WorkflowRunRepository.ts`. `queueItems`, `listDone`, `stepsForRuns` are unchanged.

### 3.1 `listQueue`

New return: `{ counts: Omit<Domain.QueueCounts, "done">, items: Domain.QueueItem[] }`. The
object adds `done`.

```ts
listQueue: Effect.fn("WorkflowRunRepository.listQueue")(function* ({
  teamIds,
  memberEmail,
  query,
}: {
  readonly teamIds: readonly Domain.TeamId[];
  readonly memberEmail: Domain.Email;
  readonly query: Domain.QueueQuery;
}) {
  const items = yield* queueItems(teamIds);
  const teamCounts = teamIds.map((teamId) => ({
    teamId,
    count: items.filter((item) =>
      item.steps.some((step) => step.teamId === teamId),
    ).length,
  }));
  const narrowed = /* unchanged: narrow to query.team */;
  const byTier = Map.groupBy(narrowed, (item) => Domain.tierOf(item, memberEmail));
  const tier = (wanted: Domain.QueueTier) => byTier.get(wanted) ?? [];
  const selected =
    query.tab === "done"
      ? []
      : tier(query.tab).toSorted(Domain.byAge).slice(0, query.limit);
  return {
    counts: {
      mine: tier("mine").length,
      upNext: tier("upNext").length,
      inProgress: tier("inProgress").length,
      attention: tier("attention").length,
      total: items.length,
      teamCounts,
    },
    items: selected,
  };
}),
```

Update the interface JSDoc on `listQueue` (around line 346) to say: every tier is counted, one
tier is returned, sorted oldest first and cut to `query.limit`; `tab: "done"` returns no items
and the caller reads `listDone`.

`Map.groupBy` is available on the Workers runtime (`compatibility_date` is recent); if
`pnpm typecheck` disagrees, use a `reduce` into a `Record<QueueTier, QueueItem[]>` and note it
in §10.

### 3.2 `listDone`

Unchanged. `limit: 0` remains the "count only" mode and is what every non-Done tab passes.

## 4. Object (step 3)

`src/lib/ShopAgent.ts`, `readQueue` (around line 3098).

```ts
private readQueue(
  teamIds: readonly Domain.TeamId[],
  memberEmail: Domain.Email,
  query: Domain.QueueQuery,
) {
  const shop = this.name;
  return Effect.gen(function* () {
    const repository = yield* WorkflowRunRepository;
    const started = yield* Clock.currentTimeMillis;
    const { counts, items } = yield* repository.listQueue({ teamIds, memberEmail, query });
    const doneTeamIds =
      query.team === null ? teamIds : teamIds.filter((teamId) => teamId === query.team);
    const done = yield* repository.listDone({
      teamIds: doneTeamIds,
      since: started - Domain.DONE_WINDOW_MS,
      limit: query.tab === "done" ? query.limit : 0,
    });
    const rows = query.tab === "done" ? done.items.length : items.length;
    const team = query.team ?? "all";
    const ms = (yield* Clock.currentTimeMillis) - started;
    yield* Effect.logInfo(
      `ShopAgent.readQueue: shop=${shop} teams=${String(teamIds.length)} team=${team} tab=${query.tab} rows=${String(rows)} ms=${String(ms)}`,
    ).pipe(Effect.annotateLogs({ shop, teams: teamIds.length, team, tab: query.tab, rows, ms }));
    return {
      counts: { ...counts, done: done.total },
      items,
      done: done.items,
    } satisfies Domain.QueueView;
  });
}
```

Update the JSDoc above it: one call so the strip and the list are one snapshot; `rows` in the log
is what left the object and must stay at or under `query.limit`. `listQueue` and
`subscribeQueue` need no change beyond the types.

## 5. Route (step 4)

`src/routes/shop.$shop.index.tsx`. This is a rewrite of the component's state and layout; the
row (`renderItem`), the step detail (`renderStep`), the Done row (`renderDone`), and the action
wiring (`useMemberRunActions`) are kept as they are, with the two changes in §5.6 and §5.7.

### 5.1 Search param

```ts
const QueueSearch = Schema.Struct({
  tab: Schema.optionalKey(Domain.QueueTab),
});

export const Route = createFileRoute("/shop/$shop/")({
  validateSearch: Schema.toStandardSchemaV1(QueueSearch),
  loaderDeps: ({ search }) => ({ tab: search.tab ?? Domain.DEFAULT_QUEUE_TAB }),
  loader: ({ params, deps }) =>
    getLoaderData({ data: { shop: params.shop, tab: deps.tab } }),
  /**
   * A tab is a different loader key, so its first visit runs the loader once
   * and that read is the socket query's `initialData` for the new key; after
   * that the socket owns the data and pushes keep it current. Without this the
   * default `staleTime: 0` would re-run the loader on every return to a tab
   * whose data the socket already holds.
   */
  staleTime: Infinity,
  head: () => ({ meta: [{ title: "Queue — Baton" }] }),
  component: RouteComponent,
});
```

`getLoaderData`'s validator becomes `Schema.Struct({ shop: Schema.String, tab: Domain.QueueTab })`
and it reads `{ team: null, tab, limit: Domain.QUEUE_PAGE }`, returning that query as
`query` beside `view`.

An invalid `?tab=` value fails `validateSearch`; the router's default error boundary shows.
Acceptable: nothing on the page links to a bad value.

### 5.2 Component state

```ts
const {
  shop,
  memberEmail,
  teams,
  query: loaderQuery,
  view: loaderView,
} = Route.useLoaderData();
const { tab = Domain.DEFAULT_QUEUE_TAB } = Route.useSearch();
const navigate = useNavigate({ from: Route.fullPath });
/** Client state, not URL: a bench does not share team or depth. */
const [team, setTeam] = React.useState<Domain.TeamId | null>(null);
const [limit, setLimit] = React.useState(Domain.QUEUE_PAGE);
const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
const query: Domain.QueueQuery = { team, tab, limit };

const { data, invalidate, agent, identified } = useSubscribedQuery({
  queryKey: ["shop-queue", shop, query],
  subscribe: (stub, subscriberId) =>
    stub.subscribeQueue({ subscriberId, query }),
  initialData: Domain.sameQueueQuery(query, loaderQuery)
    ? loaderView
    : undefined,
});
const view = data ?? loaderView;
const loading = data === undefined;
```

Keep the existing JSDocs on `open` (nothing expanded on first paint; the member's own Start opens
the row) and on the subscribe pattern, edited for the new names.

Transitions:

```ts
const selectTab = (next: Domain.QueueTab) => {
  if (next === tab) return;
  setLimit(Domain.QUEUE_PAGE);
  setOpen(new Set());
  void navigate({ search: { tab: next }, replace: true });
};
/** A team change is a new list: depth resets, expansions close. */
const selectTeam = (next: Domain.TeamId | null) => {
  setTeam(next);
  setLimit(Domain.QUEUE_PAGE);
  setOpen(new Set());
};
const showMore = () => {
  setLimit((current) =>
    Math.min(current + Domain.QUEUE_PAGE, Domain.QUEUE_LIMIT_MAX),
  );
};
```

`replace: true` so Back leaves the queue rather than walking through tabs; the previous design's
reasoning about benches not sharing URLs still holds for team and depth, which stay client state.

`open` pruning against the rows on the page stays as it is, reading `view.items` instead of the
tiers.

### 5.3 Layout

```tsx
<s-page heading="Queue" inlineSize="small">
  <SocketBanner />
  <s-section accessibilityLabel="Queue">
    <s-stack gap="base">
      {actions.banner !== null && (
        <s-banner tone="critical">{actions.banner}</s-banner>
      )}
      {teams.length === 0 ? (
        <s-paragraph color="subdued">You’re not on a team yet. …</s-paragraph>
      ) : (
        <>
          {teamSelect}
          {strip}
          {list}
        </>
      )}
    </s-stack>
  </s-section>
</s-page>
```

**Sticky strip.** Wrap `teamSelect` and `strip` in one `s-box` with `position: sticky; top: 0`
and the page background. Polaris `s-box` has no `position` prop; use a plain `<div>` with an
inline style for the two properties, since a style block per route is not a pattern this repo
has. If `s-page`'s scroll container defeats `sticky` (check in the browser: scroll the list and
watch the strip), record it in §10 and leave the strip static; do not fight the container.

### 5.4 Team select

Rendered only when `teams.length > 1`, replacing the chips:

```tsx
const teamSelect =
  teams.length > 1 ? (
    <s-select
      label="Team"
      labelAccessibilityVisibility="exclusive"
      value={team ?? ""}
      onChange={(event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        selectTeam(value === "" ? null : (value as Domain.TeamId));
      }}
    >
      <s-option value="">{`All teams · ${String(view.counts.total)}`}</s-option>
      {teams.map((each) => (
        <s-option key={each.id} value={each.id}>
          {`${each.name} · ${String(teamCount(each.id))}`}
        </s-option>
      ))}
    </s-select>
  ) : null;
```

Copy the event typing and `s-option` usage from `app.orders.index.tsx` (around line 902) rather
than inventing it. The `as Domain.TeamId` cast is the one cast this plan allows; the ids come
from `teams`, which the loader resolved. If a decode through `Schema.decodeUnknownOption(TeamId)`
reads cleaner, use that instead.

### 5.5 Tab strip

```tsx
const strip = (
  <div style={{ overflowX: "auto" }}>
    <s-button-group>
      {TABS.map((each) => (
        <s-button
          key={each}
          variant={each === tab ? "primary" : "secondary"}
          tone={
            each === "attention" && view.counts.attention > 0
              ? "critical"
              : "auto"
          }
          aria-pressed={each === tab}
          onClick={() => {
            selectTab(each);
          }}
        >
          {`${TAB_LABEL[each]} · ${String(view.counts[each])}`}
        </s-button>
      ))}
    </s-button-group>
  </div>
);
```

Check `s-button`'s `tone` values in `node_modules/@shopify/app-bridge-ui-types` (or wherever the
`s-button` JSX typing resolves; `grep -rn "tone" node_modules/@shopify/*/build/**/button*.d.ts`)
before using `critical`; if the button has no critical tone, render a `s-badge tone="critical"`
beside the label instead and note it in §10. A zero-count tab stays in the strip (the strip must
not reflow when a count crosses zero); it is not disabled, because an empty list with its empty
state is a valid screen.

Two rows of chips are gone. Counts in the strip are `view.counts`, which the loader provides on
first paint and the socket thereafter, so they never wait on a tier read.

### 5.6 The list

```tsx
const total = view.counts[tab];
const rows = tab === "done" ? view.done : view.items;
const hidden = total - rows.length;
const list = loading ? (
  <s-paragraph color="subdued">Loading…</s-paragraph>
) : total === 0 ? (
  <s-stack gap="small-300">
    <s-paragraph color="subdued">{TAB_EMPTY[tab].text}</s-paragraph>
    {TAB_EMPTY[tab].goTo !== null && view.counts[TAB_EMPTY[tab].goTo] > 0 && (
      <s-button
        variant="tertiary"
        onClick={() => {
          selectTab(TAB_EMPTY[tab].goTo);
        }}
      >
        {`${TAB_LABEL[TAB_EMPTY[tab].goTo]} · ${String(view.counts[TAB_EMPTY[tab].goTo])}`}
      </s-button>
    )}
  </s-stack>
) : (
  <s-box borderWidth="base" borderRadius="base">
    {tab === "done"
      ? view.done.map((entry, index) => renderDone(entry, index === 0))
      : view.items.map((item, index) => renderItem(item, tab, index === 0))}
    {hidden > 0 && renderMore(hidden)}
  </s-box>
);
```

The tier headings (`Blocked · 7`, `Mine · 16`) are gone; the strip is the heading. `renderMore`
loses its `tier` parameter and reads `limit`:

```tsx
const renderMore = (hidden: number) => (
  <s-box padding="small-300 base">
    <s-button
      variant="tertiary"
      inlineSize="fill"
      disabled={limit >= Domain.QUEUE_LIMIT_MAX}
      onClick={showMore}
    >
      {`Show ${String(Math.min(Domain.QUEUE_PAGE, hidden))} more of ${String(hidden)}`}
    </s-button>
  </s-box>
);
```

`renderItem`'s `tier` parameter becomes `tab: Domain.QueueTab`; it is only used for the Mine
background (`tab === "mine"`), which still holds.

TypeScript: `TAB_EMPTY[tab].goTo` is narrowed inside the `&&`, but not inside the `onClick`
closure. Bind it to a `const goTo = TAB_EMPTY[tab].goTo;` above the JSX.

### 5.7 Clamp the second line

In `renderItem`, line two (`detailLine()`) is wrapped so a long blocked reason is two lines with
an ellipsis; the expanded row still shows the full `FlagBanner`:

```tsx
<div
  style={{
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
  }}
>
  <s-text color="subdued">{detailLine()}</s-text>
</div>
```

If `s-text` renders its own block that defeats the clamp (check `#1026` on the seeded shop),
apply the style to the text's slot or move the clamp to a `span` around the string; note what
worked in §10.

### 5.8 Imports

`useNavigate` from `@tanstack/react-router`; `TABS`, `TAB_LABEL`, `TAB_EMPTY` from
`@/lib/queueTiers` replacing `TIERS`, `TIER_LABEL`.

## 6. Tests (step 5)

### 6.1 `test/integration/workflow-run-repository.test.ts`

- The `queueRows` helper (around line 79) that flattens `view.tiers.*` into one list: replace
  with a helper that calls `listQueue` once per tier tab and concatenates in strip order, or,
  where a test only needs one tier, calls with that tab. Prefer the second; it makes each test
  say which tab it is about.
- "listQueue shows only current steps … flagged first" (≈1400): assert through
  `tab: "attention"` then `tab: "upNext"`.
- "listQueue tiers by the reader" (≈1552): read `counts` for both readers and assert the four
  numbers, then read `tab: "mine"` for each and assert the ids.
- "listQueue counts the whole tier and returns only the limit; the team counts ignore the
  narrowing" (≈1610): `tab: "upNext", limit: QUEUE_PAGE` with 12 seeded → `items.length` is
  `min(12, QUEUE_PAGE)` and `counts.upNext` is 12; `limit: 20` → 12 items. **`QUEUE_PAGE` is now
  25**, so the fixture must seed more than 25 rows for the cap to bite, or the test must pass a
  smaller `limit` explicitly. Pass `limit: 10` explicitly; the constant's value is not what the
  test is about.
- Add: `tab: "done"` returns `items: []` and `counts.upNext` still counted (counts are
  tab-independent).
- Add: `team` narrows `counts.mine/upNext/inProgress/attention` and leaves `counts.total` and
  `teamCounts` alone.

### 6.2 `test/integration/member-queue-socket.test.ts`

- `subscribeQueue` calls pass the new `query` shape. The `queueRows` helper (≈196) becomes a call
  per tab or a single `tab: "upNext"` read where that is what the test checks.
- The `upNext: 0` / `upNext: 20` case (≈250): becomes `limit: 1` against the one-row fixture
  asserting `items.length === 1` and `counts.upNext === 1`, then `tab: "done"` asserting
  `items.length === 0` and `counts.upNext === 1`. What the socket proves is that `query` reaches
  the object and selects the tab.

### 6.3 `test/integration/shop-agent-workflows.test.ts`

The `listQueue` helper (≈114) flattening tiers: same treatment as 6.1. The "reads
`startedByEmail` after the member is deleted" case (≈923) reads `tab: "mine"` as the deleted
member's email and asserts the row is there.

### 6.4 `test/integration/domain.test.ts`

Add a `sameQueueQuery` case (equal, and each field differing). `tierOf` and `byAge` cases are
unchanged.

### 6.5 `test/integration/shop-agent-callables.test.ts`

No change expected; `subscribeQueue` stays `member`.

## 7. E2E (step 6)

`e2e/member-queue.member.spec.ts`. The file's assertions read tier headings that no longer
exist. Map each:

| Today                                                       | Under this plan                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getByText("Up next · 2")` visible                          | Strip button `getByRole("button", { name: "Up next · 2" })` visible                                                                                                                                                                                                                                                                                                                                               |
| `getByText("Up next")` hidden                               | Strip button `Up next · 0` visible (the tab never hides)                                                                                                                                                                                                                                                                                                                                                          |
| `getByText("Mine · 1")` visible                             | Strip button `Mine · 1` visible                                                                                                                                                                                                                                                                                                                                                                                   |
| Row assertions under a heading                              | Click the tab first (`selectTab` helper: click the strip button, wait for `aria-pressed`), then assert rows                                                                                                                                                                                                                                                                                                       |
| "Up next caps at ten, pages on Show more, re-caps on team"  | Fixture stays 12 rows; the default page is now 25, so the cap does not bite. Change the test to assert `Show 25 more` is **absent** at 12, and add a `withBulk` count that crosses 25 (`BULK_COUNT = 25`, 26 Up next rows for the mate) so `Show 25 more of 1` appears. The team re-cap moves to the select: choose a team via `selectOption` on the `s-select`'s inner `select`, assert the strip counts change. |
| `getByText("Done today")` hidden / `Done today · 1` visible | Strip button `Done today · 0` / `Done today · 1`; click it to see the Undo row                                                                                                                                                                                                                                                                                                                                    |
| `EMPTY = "Nothing to do right now."`                        | Per-tab empty text from `TAB_EMPTY`; the "removing a member empties their queue" test asserts `Mine · 0` and `Up next · 0` in the strip **and** the Mine empty text                                                                                                                                                                                                                                               |

Add one test: **the tab is in the URL.** Click `Up next`, assert `page.url()` contains
`tab=upNext`; `page.goto` the same URL directly, assert the Up next rows render on first paint
(no click), then `page.goBack()` leaves the queue route entirely (`replace: true`).

Add a `selectTab(page, label)` helper in the spec (or `e2e/member.ts` if it reads better) that
clicks the strip button matching `^<label> · \d+$` and waits for its `aria-pressed="true"`.

The `awaitEnabled` / `clickWhenEnabled` helpers keep working; the strip buttons are `s-button`.

## 8. Acceptance

Measured on the seeded shop as `lead@m.com` (`pnpm seed`, sign in through `/login`), headless
1280 × 720, after step 6:

- [x] First paint is the Mine tab with 16 rows; page height under 1,400 px.
- [x] Strip reads `Mine · 16  Up next · 76  In progress · 0  Blocked · 7  Done today · 128`
      (numbers per the seed at the time; the shape is what matters).
- [x] SSR HTML under 70 KB; dehydrated loader data under 25 KB (`document.documentElement.outerHTML.length` and the largest `<script>` body, as the research measured).
- [x] `logs/server.log` shows `ShopAgent.readQueue … tab=mine rows=16` on first paint, `tab=upNext rows=25` after clicking Up next, `tab=done rows=25` after clicking Done today, and `rows=` never above `limit`.
- [x] Clicking a tab does not scroll the page to the top when the strip is sticky; if the strip
      is not sticky (§5.3), it does not matter.
- [x] `#1026`'s row is at most two lines of reason; expanding it shows the full banner.
- [x] Two tabs open as two members: a Done on one moves the other's strip counts inside the 2 s
      throttle, whatever tab the other is on.
- [x] `?tab=attention` pasted into the address bar paints Blocked on first load.
- [x] Back from `/shop/<shop>?tab=upNext` leaves the queue route in one step.
- [x] Team select to `Engraving` changes the strip counts and the list; `All teams` returns
      them.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm exec playwright test --project=member`
      all green; `pnpm fmt` run repo-wide with its changes kept.
- [x] `git grep -n "QUEUE_TIER_CAP\|QueueLimits\|DEFAULT_QUEUE_LIMITS\|isDefaultQuery\|QueueTierView\|TIER_LABEL\|TIERS\b" src test e2e` returns nothing.

## 9. Order of work and checkpoints

1. Domain (§2) and `queueTiers.ts` (§2.6). Typecheck will fail in the repository, object, route
   and tests; that is expected. Do not stop here.
2. Repository (§3). Typecheck fails in object, route, tests.
3. Object (§4). Typecheck fails in route and tests.
4. Route (§5). Typecheck passes; `pnpm test` fails in the integration suites.
5. Integration tests (§6). `pnpm test` green. Run `pnpm fmt`.
6. E2E (§7). Member project green. Run `pnpm fmt` again.
7. Acceptance (§8). Record every unchecked box in §11 with why.

## 10. Deviations

One entry per deviation: what the plan said, what was done instead, and why. Leave the plan text
above unchanged so the two can be read together.

| #   | Plan section | What the plan said                                                                                                             | What was done                                                                                                                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | §3.1         | `Map.groupBy` is available; fall back to a reduce if typecheck disagrees                                                       | Reduce into a `Record<QueueTier, QueueItem[]>`                                                                                                                                                           | `pnpm typecheck` refused it. `tsconfig.json` targets ES2025, but TypeScript ships `Map.groupBy` in `lib.esnext.collection`, which the repo's `lib` does not include. The fallback the plan named, taken.                                                                                                                                                                                                                                                                                                                                               |
| 2   | §5.3, §5.7   | Sticky strip and the two-line clamp go in inline `style` props, "since a style block per route is not a pattern this repo has" | `.queue-strip`, `.queue-strip-tabs` and `.queue-detail-line` in `src/styles.css`                                                                                                                         | The repo does have the pattern — `styles.css` already owns `.member-prose`, `.member-bar` and the work page's print rules, all of them plain-element CSS for the member area. It also sidesteps React's `CSSProperties` deprecating `WebkitBoxOrient`, which `pnpm lint` flagged on the inline version.                                                                                                                                                                                                                                                |
| 3   | §5.5         | The strip is an `s-button-group`                                                                                               | `s-stack direction="inline"`, the container the chips used                                                                                                                                               | `s-button-group` renders only its named `primary-action` / `secondary-actions` slots; buttons in its default slot never reached the page. Caught in the browser: the accessibility snapshot of the queue held no buttons at all.                                                                                                                                                                                                                                                                                                                       |
| 4   | §5.6         | The empty tab's button reads `${TAB_LABEL[goTo]} · ${count}`                                                                   | It reads `Go to ${TAB_LABEL[goTo]} · ${count}`                                                                                                                                                           | Identical to the strip button's accessible name two rows above it, which is ambiguous to a screen reader and a strict-mode violation in Playwright.                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | §5.4         | `as Domain.TeamId` is the one cast this plan allows                                                                            | `teams.find(({ id }) => id === value)?.id ?? null`                                                                                                                                                       | The same lookup `app.orders.index.tsx` does, and it needs no cast: the id comes back off the list the loader resolved.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | §6.1, §6.3   | Prefer replacing the flattening test helpers with per-tab calls at each site                                                   | Kept a helper that concatenates the four tier tabs, with an optional `tab`                                                                                                                               | Twenty-odd call sites want "whatever is queued" and say nothing about tiers; converting them all would have rewritten tests this change is not about. The sites the plan named individually do pass a `tab`.                                                                                                                                                                                                                                                                                                                                           |
| 7   | §7           | `BULK_COUNT = 25` gives 26 Up next rows and a `Show 25 more of 1`                                                              | `BULK_COUNT = 25` gives the mate 27 and the maker 26; the buttons read `Show 2 more of 2` and `Show 1 more of 1`                                                                                         | Both named orders are Up next for the mate, and `renderMore` names `min(QUEUE_PAGE, hidden)` — the honest count, since asking for 25 more when 2 exist would be a promise the list cannot keep.                                                                                                                                                                                                                                                                                                                                                        |
| 8   | §1 (scope)   | `e2e/member-queue.member.spec.ts` is the only E2E file                                                                         | `e2e/member-area.member.spec.ts` changed too                                                                                                                                                             | Its "a member sees the teams they are on" case asserted the team **chips**, which §5.4 replaced with the select. Rewritten against the select's options.                                                                                                                                                                                                                                                                                                                                                                                               |
| 9   | §7           | —                                                                                                                              | Every `getByRole("button", { name: "Done" })` on the queue became `exact: true`                                                                                                                          | Playwright matches accessible names by substring, so `"Done"` also matched the strip's `Done today · N` and `.first()` clicked the tab instead of the row.                                                                                                                                                                                                                                                                                                                                                                                             |
| 10  | §2.1         | Names `QUEUE_TIER_CAP`, `QueueLimits`, `DEFAULT_QUEUE_LIMITS`, `isDefaultQuery` for deletion                                   | `DEFAULT_QUEUE_QUERY` deleted too                                                                                                                                                                        | It was built from `DEFAULT_QUEUE_LIMITS`, and there is no default query left to name: the loader's query carries the tab from the URL. Its callers build the query they mean, which is what §6 asks the tests to say anyway.                                                                                                                                                                                                                                                                                                                           |
| 11  | §7           | Back from `?tab=upNext` "leaves the queue route entirely"                                                                      | The test pushes a second entry, switches tabs, and asserts Back lands on the pre-tab URL                                                                                                                 | A context opened straight onto the queue has one history entry, so Back has nowhere to go and the assertion would pass for the wrong reason. What `replace: true` actually promises — that a tab switch overwrites rather than stacks — is what is now asserted.                                                                                                                                                                                                                                                                                       |
| 12  | §2.4         | "Keep `QueueTeamCount`, `QueueItem`, `QueueStep`, `DoneItem`"                                                                  | `QueueStep` drops `completedAt`, `completedBy`, `completedByEmail`, `completedByRole`; `stepStartedBy` / `stepReopenedBy` / `stepNoteLine` take the slot they read rather than a whole `WorkflowRunStep` | The §8 payload box was missed by 4% and no single field was fat — the weight was forty fields spread evenly over sixteen rows. These four are the only ones that can never say anything: readiness _is_ `completedAt is null` (`readyWhere`), and Undo clears the whole slot, so on a queue step all four are null by construction. Dropping them took the dehydrated loader data from 25,016 to 23,322 bytes and closed the box. A finished step is a `DoneItem`, which still carries the full `WorkflowRunStep` because there the slot is the point. |

## 11. Concerns

Not deviations: things the implementation is now living with. Each says what it is, when it
would bite, and what closing it would take. Add the acceptance boxes that stayed unchecked here.

Every acceptance box in §8 is checked. The payload box was missed on the first pass at 25,016
bytes and closed by §10.12; it now measures 23,322, with the SSR response at 58.7 KB against 70.

**1. The first paint still grows with the Mine tab.** At the seeded 16 rows the dehydrated loader
data is 23,322 bytes, ≈1.46 KB a row, and nothing cuts below `QUEUE_PAGE` — a member whose Mine
tab holds 25 would paint ≈36 KB. §10.12 took out the only fields that were provably dead; every
one that is left is read by the row or by its expanded detail. It bites on a shop where one
person holds far more work than the seed's busiest does. Closing it means the expanded detail
becoming a second read, so a collapsed row ships only the six fields it paints — a design change
this plan does not make, and one that trades a byte count for a round trip on every tap.

**2. Starting the last Up next row leaves a dead end.** Start moves a row to Mine, so the tab it
was started from empties, and `TAB_EMPTY.upNext.goTo` is `null` — the member reads "Nothing to
start." with no pointer to the row they are now holding. The strip's `Mine · 1` is the only way
back, one tap away and in view, which is why this is a concern and not a bug. It bites on a bench
with one piece of work at a time. Closing it means pointing `upNext` at `mine`, which needs a
rule for which way to point when both are non-empty.

**3. The strip scrolls sideways on a narrow phone.** Five `s-button`s with counts are wider than
a 360 px viewport, and `.queue-strip-tabs` scrolls rather than wraps (wrapping would put the list
under a second row that moves as counts change). Blocked and Done today are the ones off-screen.
It bites on the smallest bench devices. Closing it means shorter labels, dropping the counts from
the narrow layout, or a select instead of a strip below some width — none of which the research
measured.
