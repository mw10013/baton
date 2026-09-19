# Member queue at scale: implementation plan

Companion to `docs/member-queue-scale-research.md`, which holds the measurements, the
options, and the decisions (§7 and §9 there). This document is the hand-off: an implementer
should be able to work from it without re-reading the research, but every "why" lives there.
The row layout being built is mocked in `docs/member-queue-ux/queue-rows-mock.html`; open it
in a browser before starting step 5.

**Status: implemented** (2026-09-18, against commit `5703f69`), not committed. Deviations are in §9.

## 0. Rules for the implementer

1. **No migration files.** Durable Objects and D1 are reset from scratch during prototyping.
   Any schema change goes inline into the `1_initialize schema` migration in
   `src/lib/ShopAgent.ts` (around line 402). This plan needs one new index (§3.3) and nothing
   else.
2. **Every cap constant carries a provisional JSDoc** saying the number is a proposal, not a
   tuned figure. JSDocs must not reference files under `docs/`. Template in §2.1.
3. **Effect idioms throughout**: `Effect.fn`, `Effect.gen`, `sql` template literals, tagged
   errors, `Effect.annotateLogs` for structured log fields. Copy the surrounding style of each
   file you touch.
4. **Lowercase SQL keywords, positional parameters** (the `sql` tag does this).
5. **Log format** from CLAUDE.md: `<operation>: shop=<shop> key=<value>: <detail>`; every value
   in the message also goes in `annotateLogs`.
6. **Run after each step:** `pnpm typecheck`, `pnpm lint`, `pnpm test`, then `pnpm fmt`
   repo-wide, keeping every file it touches. Run the member E2E project after step 5 and step 7
   (`npm run test:e2e -- --project member`).
7. **Do not commit.** Leave the working tree for review.
8. **Record deviations in §9 as you go**, not at the end. A deviation is anything this plan
   says that turned out wrong, impossible, or worse than an alternative you took.
9. Steps are ordered so each leaves the app working. Do them in order.
10. **Keep the invalidate-and-refetch model.** The push stays `{ type: "invalidated" }` with no
    payload. Do not add delta pushes, sequence numbers, or client-side patching. Do not add
    virtualization.

## 1. Scope

| Step | Change                                                                                                          | Files                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | Constants and new Domain shapes (`QueueLimits`, `QueueView` v2)                                                 | `src/lib/Domain.ts`, `src/lib/queueTiers.ts`                       |
| 2    | Repository: `listQueue` returns tiered, capped, counted rows; `listDone` takes a limit of 0 and returns a total | `src/lib/WorkflowRunRepository.ts`, `src/lib/ShopAgent.ts` (index) |
| 3    | Object: `readQueue`, `listQueue`, `subscribeQueue` take `QueueQuery`                                            | `src/lib/ShopAgent.ts`, `src/lib/ShopAgentClient.ts`               |
| 4    | Hook: optional `initialData`, keep previous data across key changes                                             | `src/lib/useSubscribedQuery.ts`                                    |
| 5    | Route: row layout, server-driven tiers, Show more, Done on demand                                               | `src/routes/shop.$shop.index.tsx`, `src/components/MemberRun.tsx`  |
| 6    | Narrow the `"all"` publishers that touch one order or one run                                                   | `src/lib/ShopAgent.ts`, `src/lib/WorkflowRunRepository.ts`         |
| 7    | Tests: integration and E2E                                                                                      | `test/integration/*.test.ts`, `e2e/member-queue.member.spec.ts`    |

Out of scope: the version stamp (research §5 C) and any change to the work page
(`shop.$shop.work.$runId.tsx`), the merchant order pages, or the orders sync.

## 2. Constants and types (step 1)

All in `src/lib/Domain.ts` unless noted.

### 2.1 Constants

```ts
/**
 * Provisional. How many rows of a bounded tier (Blocked, Mine, In progress)
 * the queue read returns before the heading says "showing N" and offers
 * more. A proposal, not a tuned figure: no shop has run against it.
 */
export const QUEUE_TIER_CAP = 25;
/** Provisional: the page size for Up next, Done today, and every "Show 10 more". */
export const QUEUE_PAGE = 10;
/** Provisional: the most rows one tier may be expanded to in a single read. */
export const QUEUE_LIMIT_MAX = 100;
```

Keep `DONE_WINDOW_MS`. Delete `DONE_LIMIT` (its role is taken by `QueueLimits.done`).

### 2.2 `QueueLimits` and `QueueQuery`

```ts
export const QueueTier = Schema.Literals([
  "attention",
  "mine",
  "inProgress",
  "upNext",
]);
export type QueueTier = typeof QueueTier.Type;

const QueueLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: QUEUE_LIMIT_MAX }),
);

/**
 * How many rows of each tier the caller wants. The object always computes
 * every tier's total; the limit only bounds what is returned. `done: 0` skips
 * the Done today read entirely, which is the collapsed state.
 */
export const QueueLimits = Schema.Struct({
  attention: QueueLimit,
  mine: QueueLimit,
  inProgress: QueueLimit,
  upNext: QueueLimit,
  done: QueueLimit,
});
export type QueueLimits = typeof QueueLimits.Type;

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
  attention: QUEUE_TIER_CAP,
  mine: QUEUE_TIER_CAP,
  inProgress: QUEUE_TIER_CAP,
  upNext: QUEUE_PAGE,
  done: 0,
};

/**
 * What the browser may choose about its queue: one of its own teams to narrow
 * to (`null` is every team on the connection), and how deep each tier goes.
 * `team` is validated against the connection's `teamIds` by the object; a
 * team the member is not on reads as an empty queue, never as an error.
 */
export const QueueQuery = Schema.Struct({
  team: Schema.NullOr(TeamId),
  limits: QueueLimits,
});
export type QueueQuery = typeof QueueQuery.Type;
export const DEFAULT_QUEUE_QUERY: QueueQuery = {
  team: null,
  limits: DEFAULT_QUEUE_LIMITS,
};
```

### 2.3 Inputs

```ts
/** Loader read (SSR, Worker-resolved). `memberEmail` is what decides the Mine tier. */
export const ListQueueInput = Schema.Struct({
  teamIds: Schema.Array(BoundedId),
  memberEmail: Email,
  query: QueueQuery,
});

/** Socket read; `teamIds` and `memberEmail` come off the connection. */
export const SubscribeQueueInput = Schema.Struct({
  ...SubscriberIdInput.fields,
  query: QueueQuery,
});
```

### 2.4 `QueueView` v2

Replace the current `QueueView = { items, done }` with:

```ts
export const QueueTierView = Schema.Struct({
  items: Schema.Array(QueueItem),
  /** Rows in the tier before the limit; the number the heading shows. */
  total: Schema.Number,
});

export const QueueTeamCount = Schema.Struct({
  teamId: TeamId,
  count: Schema.Number,
});

/**
 * The member queue in one read, already tiered and capped by the object.
 * `teamCounts` and `total` are over every team on the connection regardless
 * of `query.team`, so the chips do not move under the chip just pressed.
 * `done.items` is empty when `limits.done` is 0; `done.total` is always the
 * count inside `DONE_WINDOW_MS`.
 */
export const QueueView = Schema.Struct({
  tiers: Schema.Struct({
    attention: QueueTierView,
    mine: QueueTierView,
    inProgress: QueueTierView,
    upNext: QueueTierView,
  }),
  teamCounts: Schema.Array(QueueTeamCount),
  total: Schema.Number,
  done: Schema.Struct({ items: Schema.Array(DoneItem), total: Schema.Number }),
});
```

`QueueItem`, `QueueStep`, `DoneItem` are unchanged. `QueueLoaderData` gains nothing; its `view`
is the new shape.

### 2.5 `tierOf` moves into Domain

Move `tierOf` and the `byAge` comparator from `src/lib/queueTiers.ts` into `Domain.ts` next to
`QueueItem` (the repository needs them and cannot import a route helper). Keep `TIERS` and
`TIER_LABEL` in `queueTiers.ts` for the route; delete `tierQueue` there (the object does the
grouping now). The `byAge` tiebreak changes from `orderName` to `run.id` only: sort key is
`(orderProcessedAt, id)`. `orderName` is not needed for stability and would complicate any
later cursor.

## 3. Repository (step 2)

`src/lib/WorkflowRunRepository.ts`.

### 3.1 `listQueue`

New signature:

```ts
readonly listQueue: (input: {
  readonly teamIds: readonly string[];
  readonly memberEmail: Domain.Email;
  readonly query: Domain.QueueQuery;
}) => Effect.Effect<Omit<Domain.QueueView, "done">, SqlError.SqlError | WorkflowRunRepositoryError>;
```

Implementation, in this order, all in TypeScript on rows already fetched. The two existing SQL
statements (ready steps, then runs with note and `stageCount`) stay exactly as they are, run
against **all** of `teamIds`, not the narrowed team. Row reads are not the cost (research §3);
the bound is on what leaves the object.

1. Build the `QueueRow[]` exactly as today (steps of my teams with cross-team siblings).
2. `teamCounts`: for each id in `teamIds`, the number of rows with at least one step whose
   `teamId` is that id. `total`: the number of rows.
3. Narrow: if `query.team` is non-null, keep rows with at least one step on that team, and
   within each kept row keep only that team's steps (`siblings` recomputed against the
   dropped ones is not needed; siblings are already "other teams' steps in the same stage").
   If `query.team` is not in `teamIds`, the narrowed set is empty.
4. Tier each row with `Domain.tierOf(item, memberEmail)`; sort each tier by
   `(orderProcessedAt, id)`.
5. For each tier: `total` = length, `items` = first `query.limits[tier]`.

Delete the `attention` tier's reliance on the SQL `order by r.flag is null` (it is harmless but
no longer meaningful; leave it or drop it, note which in §9).

### 3.2 `listDone`

Signature gains nothing; behavior changes:

- `limit: 0` returns `{ items: [], total }` without running the steps or runs statements.
- Always returns `total`: one `select count(*)` over `WorkflowRunStep` with
  `teamId in (…) and completedAt >= ?` joined to non-cancelled runs. This is served by
  `WorkflowRunStep_teamId_idx (teamId, completedAt)` and bounded by the 24-hour window, so it
  is not the unbounded `count(*)` the plans research forbids.
- Return type becomes `{ items: readonly Domain.DoneItem[]; total: number }`.

`teamIds` passed in is already narrowed by the object (§4.1), so no `team` parameter here.

### 3.3 Index

Add to the `1_initialize schema` DDL, after `WorkflowRun_status_idx`:

```sql
create index if not exists WorkflowRun_open_age_idx
  on WorkflowRun (orderProcessedAt, id) where status in ('pending', 'active');
```

This serves the runs statement's sort once the sort key is `(orderProcessedAt, id)` and keeps
the option of a cursor later. Change the runs statement's `order by` to
`r.orderProcessedAt, r.id`.

### 3.4 `listOrderTeamIds`

Add a third input variant `{ readonly orderId: string }` that skips the run lookup and reads
distinct `teamId` for every open step on every run of that order. Step 6 uses it.

## 4. Object and client (step 3)

`src/lib/ShopAgent.ts`.

### 4.1 `readQueue`

```ts
private readQueue(teamIds, memberEmail, query: Domain.QueueQuery) {
  // 1. tiers = repository.listQueue({ teamIds, memberEmail, query })
  // 2. doneTeamIds = query.team === null ? teamIds : teamIds.includes(query.team) ? [query.team] : []
  // 3. done = repository.listDone({ teamIds: doneTeamIds, since: now - DONE_WINDOW_MS, limit: query.limits.done })
  // 4. return { ...tiers, done }
}
```

Add one info log per read, after the work, so the fan-out can be measured on a real shop
(research §7 item 5):

```
ShopAgent.readQueue: shop=<shop> teams=<teamIds.length> team=<query.team ?? "all"> items=<sum of tier item lengths> done=<done.items.length> ms=<elapsed>
```

with the same fields in `annotateLogs`.

### 4.2 `listQueue` (plain RPC) and `subscribeQueue` (`@callable`)

- `listQueue(input: Domain.ListQueueInput)` passes `teamIds`, `memberEmail`, `query` through.
- `subscribeQueue(input)` decodes `SubscribeQueueInput` strict (`onExcessProperty: "error"`),
  takes `teamIds` and `memberEmail` from the connection via `memberCallableEffect`, registers
  the subscription as today, and calls `readQueue` with `input.query`.

The subscription registered on the connection does not change shape (`{ subscriberId,
orderId: null }`). A re-subscribe with a different `query` overwrites it, which is correct: one
tab holds one queue view.

### 4.3 `ShopAgentClient.listQueue`

Signature follows `Domain.ListQueueInput`; the `queueView` decoder picks up the new schema.
Nothing else.

## 5. Hook (step 4)

`src/lib/useSubscribedQuery.ts`. Two changes, both additive:

1. `initialData` becomes optional. When the route's current query differs from the loader's
   (the member pressed a chip or Show more), there is no SSR data for that key and the hook must
   not pretend there is. Callers that always have loader data (the work page, the orders index)
   keep passing it.
2. Pass `placeholderData: keepPreviousData` to `useQuery`, so a key change (new `query`) keeps
   the previous view on screen until the subscribing read returns, instead of flashing the
   page's connecting state.

The returned `data` becomes `A | undefined` when `initialData` is omitted; the queue route
handles `undefined` by rendering the loader view (see §6.2). Update the JSDoc on the hook to say
why `initialData` is optional.

## 6. Route (step 5)

`src/routes/shop.$shop.index.tsx`. This is the largest step. Match the mock.

### 6.1 State

```ts
const [query, setQuery] = React.useState<Domain.QueueQuery>(
  Domain.DEFAULT_QUEUE_QUERY,
);
const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set()); // run ids expanded by the member
```

- Chip press: `setQuery({ team, limits: DEFAULT_QUEUE_LIMITS })` (a chip resets every limit,
  including collapsing Done). `open` is not reset.
- "Show 10 more" on tier `t`: `limits[t] = min(limits[t] + QUEUE_PAGE, QUEUE_LIMIT_MAX)`.
- Done "Show": `limits.done = QUEUE_PAGE`; "Hide": `limits.done = 0`; "Show 10 more":
  `+ QUEUE_PAGE`.
- `useSubscribedQuery({ queryKey: ["shop-queue", shop, query], subscribe: (stub, id) => stub.subscribeQueue({ subscriberId: id, query }), initialData: isDefaultQuery(query) ? loaderView : undefined })`.
  `isDefaultQuery` is a structural equality against `DEFAULT_QUEUE_QUERY`; write it next to the
  constant in Domain.

### 6.2 Rendering

`const view = data ?? loaderView;` (the `undefined` case only happens for a non-default query
before its first read, and `keepPreviousData` makes it rare; the loader view is the safe
fallback).

Tier order and labels from `queueTiers.ts` (`TIERS`, `TIER_LABEL`). For each tier with
`total > 0`:

- Heading: `${TIER_LABEL[tier]} · ${total}`, and when `items.length < total`, a subdued
  `showing ${items.length}` on the same line.
- A bordered list container (`s-box` with border, one per tier) holding the rows.
- After the rows, when `items.length < total`: an `s-button` (tertiary, full width) reading
  `Show 10 more of ${total - items.length}`. Disabled when `limits[tier] >= QUEUE_LIMIT_MAX`.

### 6.3 The row

One row per `QueueItem`. Layout is a three-column grid: order link, main text, actions. The
whole row must not be one `s-clickable`, because the action button inside it would be a button
inside a button (the mock hit exactly this bug). Structure:

```
<s-box borderWidth="base" (top border only after the first)>
  <s-grid columns="auto 1fr auto" gap="base" alignItems="center">
    <s-link to work page>{orderName}</s-link>
    <s-clickable onClick={toggle open} accessibilityLabel={`${open ? "Collapse" : "Expand"} ${orderName}`}>
      line 1: <s-text type="strong">{step.name}</s-text> <s-text color="subdued">{lineItemTitle}</s-text> [flag badge]
      line 2: subdued, one line, truncated: flag body | "In progress · <actor>" | "Step k of n · <teamName>"
    </s-clickable>
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-text color="subdued"><LocalDateTime value={orderProcessedAt} format="relative" /></s-text>
      {primary action}
    </s-stack>
  </s-grid>
  {open && <expanded body>}
</s-box>
```

- **Line 1 step name**: when the item has several ready steps, show the first step's name and
  `+N` after it; the expanded body lists each step with its own buttons as today.
- **Flag badge**: `s-badge` with `tone` from `flagTone(run)` and text from `flagHeading(run)`
  (both already exported by `MemberRun.tsx`). Row background tinted `critical` for flagged
  rows and `success` for Mine rows (use `s-box background` tokens; if Polaris has no
  tinted background for rows, use a left border instead and note it in §9).
- **Primary action** (row level, collapsed or not): flagged → `Unblock` / `Dismiss` as today;
  a started step → `Done`; otherwise → `Start`. When the item has several ready steps the row
  action applies to the first one; the rest are in the expanded body.
- **Start expands the row**: `actions.start.mutate(step.id)` also adds the run id to `open`.
- **Default open**: on first render, every id in `tiers.mine.items` is added to `open`. After
  that, only the member's taps and Start change `open`. Do this with a lazy `useState`
  initializer from `loaderView`, not an effect.

### 6.4 The expanded body

Reuse the current card content verbatim, minus the order name line (it is in the row): `RunItem`
(attributes), `Order note`, `FlagBanner` with its action, then `renderStep` for every ready
step. Nothing about `renderStep` changes.

### 6.5 Done today

Heading `Done today · ${done.total}` with an `s-button` (tertiary) reading `Show` when
`limits.done === 0`, else `Hide`. Only rendered when `done.total > 0`. When open, rows use the
same three-column grid: order link, `step.name` + `lineItemTitle` on line 1, `by <actor> at
<time> · <note>` on line 2, and `Undo` or the `undoBlockedBy` text on the right. After the rows,
`Show 10 more of ${done.total - done.items.length}` while `done.items.length < done.total`.

### 6.6 Chips

Unchanged in behavior (only when `teams.length > 1`). Counts come from
`view.teamCounts` and `view.total`, not from a client-side filter. `All · ${view.total}`.

### 6.7 Delete

`UP_NEXT_CAP`, `upNextAll`, `doneOpen`, `visible`, `doneVisible`, `onTeam`, the client-side
`tierQueue` call, and the "Show all N" button.

## 7. Narrow the `"all"` publishers (step 6)

`src/lib/ShopAgent.ts`. Four sites; the rest stay `"all"` on purpose (research §5 G).

| Method                            | Today                                     | Change                                                                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `syncOrder` (webhook → reconcile) | `publish([orderId])` with `teams = "all"` | After reconcile, `teams = listOrderTeamIds({ orderId })`; publish `[orderId]` to those teams. If the list is empty, still publish `[orderId]` with `teams = []` so merchant detail pages update and no member refetches. |
| `cancelRun`                       | `publish("all")`                          | `publishToTeams({ runId })`                                                                                                                                                                                              |
| `uncancelRun`                     | `publish("all")`                          | `publishToTeams({ runId })`                                                                                                                                                                                              |
| `assignRunStepTeam`               | `publish("all")`                          | Read `listOrderTeamIds` **before and after** the write and publish to the union: the old team's queue loses the step and the new team's gains it.                                                                        |

`publishTo` treats `teams = []` for a member connection as "no team matches"; confirm by reading
`src/lib/ShopAgent.ts:1205-1240` and leave a one-line JSDoc on the `syncOrder` publish saying
an empty list is intended.

## 8. Tests (step 7)

### 8.1 Integration (`pnpm test`)

`test/integration/workflow-run-repository.test.ts`:

- Update every `listQueue` call to the new input and read rows from `tiers.*.items`.
- Add: a member with a started step sees it in `mine`, a teammate sees it in `inProgress`, a
  flagged run is in `attention` for both. Totals count what limits hide: seed 12 Up next
  rows, `limits.upNext = 10`, expect `items.length === 10` and `total === 12`.
- Add: `query.team` narrows items and each item's steps but not `teamCounts` or `total`.
- Add: `query.team` not in `teamIds` yields empty tiers with the unnarrowed counts.
- `listDone`: `limit: 0` returns `total` and no items and runs one statement (assert by
  behavior: the returned items are empty and total is right).

`test/integration/member-queue-socket.test.ts`: `subscribeQueue` calls gain `query:
DEFAULT_QUEUE_QUERY`; add one case where a second subscribe with `limits.upNext = 20` returns
more rows.

`test/integration/shop-agent-callables.test.ts`: whatever asserts on `listQueue` or
`subscribeQueue` shape follows the new schema. Search: `grep -rn "subscribeQueue\|listQueue"
test/`.

`test/integration/domain.test.ts`: if `tierOf` has no test, add one for the email-not-id rule
(research `queueTiers.ts:27-34` comment) since it now lives in Domain.

### 8.2 E2E (`npm run test:e2e -- --project member`)

`e2e/member-queue.member.spec.ts`:

- "Up next caps at ten…" becomes "Up next caps at ten, pages on Show more, and re-caps when the
  team changes": expect `Up next · 12`, ten order links, click `Show 10 more of 2`, expect
  twelve, then the chip, expect `Up next · 11` and `Show 10 more of 1`.
- Every `getByText("Done today")` assertion still holds (heading text is unchanged); the
  `Show` button now loads rows over the socket, so add `await expect(page.getByRole("button",
{ name: "Undo" })).toBeVisible()` after clicking `Show` where the test then clicks Undo.
- Tests that click `Start` then expect `In progress since`: the text is in the expanded body,
  and Start expands the row, so they hold. A test that expects it on a _teammate's_ page must
  first click the row (the `s-clickable` with the accessible name `Expand #9401`).
- Grep the other member specs for `Show all` and card-count assertions: `grep -rn "Show all\|ORDER_LINK" e2e/`.

`e2e/fixture.ts` and `scripts/seed.ts` need no change; the seeded volume is what the mock was
built from.

### 8.3 Verification checklist

1. `pnpm typecheck && pnpm lint && pnpm test` green.
2. Member project E2E green.
3. Open the seeded queue as `lead@m.com` in Chrome (`pnpm app:dev`, then
   `http://localhost:$(pnpm port)/shop/sandbox-shop-01.myshopify.com`). Confirm:
   - SSR HTML is under 100 KB (was 330 KB): `curl -s -b <cookie> <url> | wc -c`, or the
     Network panel.
   - Page height under 7,000 px with Mine expanded (was 19,791).
   - Chip counts equal the old client-side counts (99 / 32 / 12 / 12 / 22 / 1 / 13 / 31 for
     the current seed).
   - A `Done` on one tab moves the row on a second tab within the 2 s throttle.
   - `Show 10 more` on Up next appends without scrolling to the top.
4. `logs/server.log` shows `ShopAgent.readQueue` lines with `items=` at or below the sum of
   the limits.

## 9. Deviations

One entry per deviation: what the plan said, what was done instead, and why. The plan text
above is unchanged so the two can be read together. Open questions and risks are §10.

| #   | Plan section | What the plan said                                                                                                            | What was done                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                    |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §2.3, §3.1   | `ListQueueInput.teamIds: Schema.Array(BoundedId)`, repository takes `readonly string[]`                                       | Both are `Domain.TeamId`                                                                                                                                                                                                                                                                                                                              | `QueueTeamCount.teamId` is branded, so one `teamCounts` entry per input team needs branded ids. Every caller already holds them (`MemberAccess.teams`, `MemberConnectionState.teamIds`), so branding the input removes a cast rather than adding one.                                  |
| 2   | §3.1         | "Delete the `attention` tier's reliance on the SQL `order by r.flag is null` … note which"                                    | Dropped, and the runs statement now orders by `r.orderProcessedAt, r.id`                                                                                                                                                                                                                                                                              | The object tiers the rows, so the SQL order is only the input to a sort that replaces it; matching the new index (§3.3) keeps the two in step.                                                                                                                                         |
| 3   | §2.5         | Sort key `(orderProcessedAt, id)`                                                                                             | Kept — and three integration tests that read the queue by index now find their run by id                                                                                                                                                                                                                                                              | Run ids are UUIDs, so two runs of _one order_ tie on `orderProcessedAt` and then sort by a random id. Stable between refetches, which is what the key is for, but not the creation order those tests asserted; one of them was already flaky before the fix. See §10.1.                |
| 4   | §3.1         | `listQueue` runs the two statements and groups inline                                                                         | The two statements and the grouping moved to a `queueItems` helper beside the repository's other readers; `listQueue` narrows, tiers, and caps what it returns                                                                                                                                                                                        | Tiering, narrowing, and capping are decisions about the rows rather than about the query. Keeping them apart means the SQL is read once, in one place, and `listQueue` reads as the policy it is.                                                                                      |
| 5   | §5           | `initialData` becomes optional                                                                                                | It stays a required option whose type may be `undefined` (`initialData: Initial`, `Initial extends A \| undefined`)                                                                                                                                                                                                                                   | An optional property reads back as `Initial \| undefined`, which widened `data` to `A \| undefined` for _every_ caller and broke the work page and both order pages. Required-but-nullable infers per call site: loader-backed callers keep `data: A`.                                 |
| 6   | §6.3         | Row background tinted `critical` for flagged rows and `success` for Mine rows                                                 | Flagged rows get an inline-start `large-100 strong` rule beside their tone badge; Mine rows get `background="subdued"`                                                                                                                                                                                                                                | Polaris backgrounds are `subdued` / `base` / `strong` only — there is no critical or success surface — and the plan asked for the fallback to be noted here.                                                                                                                           |
| 7   | §7           | `syncOrder` publishes `[orderId]` to `listOrderTeamIds({ orderId })`; `assignRunStepTeam` publishes to the union of two reads | `publishToTeams` gained an optional `touched` scope and `syncOrder` calls `publishToTeams({ orderId }, [orderId])`; `assignRunStepTeam`'s two reads go through a module-scope `orderTeamIds` helper that swallows a failed read as `[]`                                                                                                               | One publish helper rather than two, and the empty-team case the plan describes is what the shared helper already does. The swallow keeps a publish from failing a write, which is the rule every other publish follows — but see §10.4.                                                |
| 8   | §8.1         | The socket test gains a second subscribe with `limits.upNext = 20` that returns more rows                                     | It subscribes with `upNext: 0` then `upNext: 20` against the one-row fixture, asserting `items` and `total` separately                                                                                                                                                                                                                                | That fixture seeds one step; 12 rows would be a second fixture for a fact the repository test (12 seeded, `total` 12, `items` 10) already proves. What only the socket can prove is that `query` reaches the object and bounds the read, which this does.                              |
| 9   | §8.1         | "if `tierOf` has no test, add one for the email-not-id rule"                                                                  | `domain.test.ts`'s two `tierQueue` cases became `Domain.tierOf` cases plus a `Domain.byAge` case                                                                                                                                                                                                                                                      | `tierQueue` is deleted, so its tests had to go somewhere. Asserting `tierOf` and `byAge` directly tests the functions the repository composes rather than a grouping helper the test would have had to re-implement.                                                                   |
| 10  | §8.2         | E2E: expand a teammate's row before asserting "In progress since"                                                             | Done, plus: `card()` is now `.last()`, an `expandRow` helper was added, the teammate assertion reads the row's own `In progress · <email>` line, the undo test reads `In progress · you`, and the Done clicks that follow a Start use `.first()`                                                                                                      | The tier's list container is an `s-box` around every row and matches the same filter as the row; an expanded row offers the step's action twice (§10.2); and a row that enters Mine _after_ the first paint stays collapsed (§10.3), so "In progress since" is not on the page for it. |
| 11  | §8.3         | SSR HTML under 100 KB (was 330 KB)                                                                                            | **135 KB** measured on the seeded shop as `lead@m.com`                                                                                                                                                                                                                                                                                                | 33 rows leave the object on first paint (7 Blocked + 16 Mine + 10 Up next) and the 16 Mine rows are expanded, which is the remaining weight. Nothing in the plan was skipped to reach it; see §10.6.                                                                                   |
| 12  | §8.3         | The rest of the checklist                                                                                                     | Met: page height 6,743 px with Mine expanded (was 19,791); chip counts 99 / 32 / 12 / 12 / 22 / 1 / 13 / 31; `Show 10 more` appends without scrolling to the top; a Done on one tab moved the other tab's Done today inside the throttle; `logs/server.log` shows `ShopAgent.readQueue … items=33` then `items=43`, at or below the sum of the limits | —                                                                                                                                                                                                                                                                                      |

## 10. Concerns

Not deviations: things the implementation is now living with. Each says what it is, when it
would bite, and what closing it would take. Nothing here is blocking — the queue works and the
suite is green — and none of it should be fixed without deciding it is worth the change.

### 10.1 Two runs of one order sort by a random id

`byAge` is `(orderProcessedAt, id)` and run ids are UUIDs, so two runs of the same order sit in
an arbitrary — stable, but arbitrary — order. A member with a four-item order sees its four rows
in no order they can name, where the old sort put them in creation order. It is invisible on the
seeded shop (rows are one per order) and obvious on a shop that runs several workflows per
order. Closing it means making the second key something ordered (`createdAt, id`), which is also
what a cursor would want.

### 10.2 An expanded row offers the same action twice

The row's primary action and the detail's step buttons act on the same first step, one above the
other, once a row is open. That is what the mock does and what §6.3 asks for, but it is two
Dones for one step, and it is why the E2E clicks need `.first()`. The alternative is for
`renderStep` to drop its buttons for the step the row already offers — a change to `renderStep`,
which §6.3 said not to make.

### 10.3 `open` is seeded once and never pruned

The expanded set is initialised from the loader's Mine tier and then only the member's taps and
their own Start change it. Two consequences: a row that _becomes_ theirs later (an Undo, a
teammate's push, a chip press) arrives collapsed, which the undo E2E now asserts rather than
works around; and ids stay in the set after their row leaves the queue, so a run that comes back
later reopens unasked and the set grows for the life of the mount. Neither is wrong, both are
surprises. Pruning against the current view on each render would fix the second.

### 10.4 A narrowed publish can now under-reach

§7 traded `"all"` for a team list at four sites, and the plan's own rule is that over-broad costs
a refetch while under-broad costs a queue that silently stops updating. Two ways to under-reach
now exist: `assignRunStepTeam` swallows a failed `listOrderTeamIds` as `[]`, which publishes to
nobody, and `syncOrder` publishes to the teams that own a step _after_ the reconcile, so a team
whose last step on the order was removed by that same reconcile is not told. Both leave a stale
queue until the tab's next subscribe (a reconnect, a route change, or any other write to a team
the member is on). Falling back to `"all"` on a failed read would close the first.

### 10.5 The read is bounded, the row scan is not

`listQueue` still reads every ready step of every team the member is on, then counts, narrows,
tiers, and cuts in TypeScript. Research §3 says the rows are not the cost and the bytes are, and
this shop agrees (3–4 ms per read). What the shop has not been asked is ten times the volume:
`items=` in the log is bounded by the limits, `ms=` is not. The log lines are there so the second
number can be watched before anyone decides a cursor is needed.

### 10.6 The first paint is 135 KB, not under 100 KB

Measured at 135 KB against a 330 KB baseline and a 100 KB target (§9 row 11). The weight is the
16 expanded Mine rows: `QUEUE_TIER_CAP` is 25, and every Mine row ships its attributes,
instructions, note, and step buttons. The two levers are a smaller cap and not expanding Mine by
default, and both are tuning decisions the constants' JSDocs say are still open — so neither was
taken here. A third lever, sending the detail only when a row is opened, would undo the
one-read model §0 rule 10 protects.

### 10.7 The cap has a ceiling with nothing to say about it

`QUEUE_LIMIT_MAX` is 100, so "Show 10 more of N" disables itself at the tenth press with no
explanation and no other way to reach row 101. A member hunting one order by name on a big
queue runs into a dead button. Search, not a higher ceiling, is the answer, and there is none on
this page yet.

### 10.8 Every queue read now counts Done, even collapsed

`listDone` runs its `count(*)` on every read because the heading shows the number while the tier
is shut. It is index-served and window-bounded, and it is one more statement per read per member
per invalidation. Cheap, and worth remembering when reads get busier.

### 10.9 A chip press can flash the wrong queue

For the first read of a non-default query there is no `initialData`, and the route falls back to
`view = data ?? loaderView` — the _unnarrowed_ loader view. `keepPreviousData` covers the common
case (the previous key's rows stay up), so this shows only when the previous key has been
garbage-collected or the query is mid-flight on a fresh mount. Rendering nothing, or the
previous tier skeleton, would be more honest than the wrong rows.

### 10.10 A chip press throws away the member's expansions

`selectTeam` resets every limit, Done included, which §6.1 asks for and which is right for the
tier caps — an expansion of All is not a promise about Engraving. It also closes Done today, which
the member may have opened for reasons that have nothing to do with the chip. Keeping `done` and
resetting only the tiers would be a one-line change if anyone complains.

### 10.11 The row's action is the first step's, silently

When a row has several ready steps it shows the first step's name, `+N`, and one button that acts
on that first step. The `+N` says there are more; nothing says the button is not about them. The
detail lists each step with its own buttons, which is the correct path, but the row is the thing
under the thumb.

## 11. Close-out (2026-09-18, second pass)

Review of the implementation above against the plan, and what was done about §10.

| §10        | Outcome                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10.1       | **Fixed.** `byAge` and `WorkflowRun_open_age_idx` are `(orderProcessedAt, lineItemId, id)`. `createdAt` would not have split two runs of one order (one reconcile inserts them in the same millisecond); the line item id is the order the customer added the lines and what `listRunsForOrder` already uses. The `.toSorted()` workaround in the repository test is gone, which also cleared the two lint errors the hand-off left. |
| 10.3       | **Fixed.** `open` is pruned to the rows on the page whenever the view changes, adjusted during render rather than in an effect. Rows that enter Mine after first paint still arrive collapsed.                                                                                                                                                                                                                                       |
| 10.4       | **Fixed.** A failed `listOrderTeamIds` now publishes to `"all"` rather than `[]`, in `publishToTeams` as well as `assignRunStepTeam`. `syncOrder` publishes to the union of the teams before and after the reconcile, so a team whose last step the reconcile removed is told.                                                                                                                                                       |
| 10.9       | **Fixed.** A non-default query with no rows to keep renders "Loading…" under the chips instead of the unnarrowed loader rows. Chip counts still come from the loader view, which is correct because they are query-independent.                                                                                                                                                                                                      |
| 10.6       | **Fixed.** Nothing is expanded on first paint, Mine included; the member's own Start still opens the row they took. `QUEUE_TIER_CAP` stays 25. The SSR size after this change has not been re-measured.                                                                                                                                                                                                                              |
| 10.2       | **Fixed.** `renderStep` takes `offered`: for the step whose action the row shows, the detail omits that button (Start when untouched, Done when in hand) and keeps only Done on an untouched step, so a maker can still finish without pressing Start.                                                                                                                                                                               |
| 10.11      | **Fixed.** A row with several ready steps offers an `Actions` button opening an `s-menu` with `Start · <step>` or `Done · <step>` per step; nothing is `offered`, so the detail keeps every step's buttons. Not exercised by E2E: the seed has one ready step per row.                                                                                                                                                               |
| 10.10      | Leave as designed.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10.5, 10.8 | Watch `ms=` on `ShopAgent.readQueue` on a real shop before adding a cursor.                                                                                                                                                                                                                                                                                                                                                          |
| 10.7       | Needs search on the page; out of scope.                                                                                                                                                                                                                                                                                                                                                                                              |

The unit-test lines `uncaught exception; source = Uncaught (in promise)` from `orders-sync-workflow.test.ts` are expected and documented on the test: workerd logs the mocked step failure as it crosses miniflare's Workflows RPC boundary, the engine handles it, and vitest passes. Present on wrangler 4.135 too.

Two things the hand-off got wrong: "the suite is green" (lint had two errors), and the E2E instruction in §0 rule 6. `test:e2e` already selects the `e2e`, `member`, and `admin` projects, so `npm run test:e2e -- --project member` runs all four including `setup`. The member project alone is `pnpm exec playwright test --project=member`.
