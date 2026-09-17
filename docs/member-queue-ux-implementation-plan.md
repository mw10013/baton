# Member queue UX: implementation plan

Status 2026-09-17: **done**. The reasoning and every product decision are in
[`docs/member-queue-ux-research.md`](./member-queue-ux-research.md); its Decisions list,
Conclusion, and §7 "The block model" are binding. This document is the order of work. It is
disposable once the code is in and any deviations are folded back into the research doc. Line
cites are as of commit `4fe44ae`; re-grep if they have drifted. Mockups:
`docs/member-queue-ux/mockups.html` (right-hand columns are the target; the compact rows drawn
there for In progress and Up next are **deferred**, not in this plan).

## What changes, in one paragraph

Two member routes and one shared component carry almost all of it. `FlagBanner` in
`src/components/MemberRun.tsx` gets a heading per flag kind, a body per flag kind, a subdued
attribution line, and an actions slot. The queue (`src/routes/shop.$shop.index.tsx`) is
retitled "Queue", loses the email line, the workflow badge, the tier badge, the "step k of n"
suffix and the "together with" line; hides Start/Done while a run is flagged; puts Unblock (for
`blocked`) or Dismiss (for reconcile flags) inside the banner; and caps Up next at ten with a
"Show all N" button. The work page (`src/routes/shop.$shop.work.$runId.tsx`) gets a
`breadcrumb-actions` link instead of the inline "‹ Your work", a header card with item and
workflow, the same banner with Unblock and Edit reason, a text area for notes and for the
block reason, notes rendered with line breaks, and no separate "Blocked" section. One new
write reaches the object: set the reason on an existing block, for members and for the
merchant. `MemberBar` gains the member email. Two e2e specs and the callable-role test change.
No SQL migration, no GraphQL.

## Ground rules for this work

- **Vocabulary.** Tier headings: `Blocked`, `Mine`, `In progress`, `Up next`, `Done today`.
  The banner heading for `blocked` is `Blocked`; the button that clears it is `Unblock`. The
  button that clears a reconcile flag stays `Dismiss`. The page heading is `Queue`. Nothing
  member-facing says "Needs attention" or "Your work" after this work.
- **Identifiers keep their names.** `dismissFlag`, `merchantDismissFlag`, `attention` (the
  tier key), `TIER_LABEL`, `FlagBanner`: all stay. Only copy changes.
- **Polaris web components only**, `s-*` tags as the files already use. `s-page`'s
  `breadcrumb-actions` slot accepts only link components (`s-link`). `s-banner` takes
  buttons in `slot="secondary-actions"`. `s-text-area` is the multi-line field.
- **Effect v4 idioms, namespace imports, `@/*` aliases.** JSDoc carries its reasoning inline
  and never references `docs/`. Rewrite, do not append to, any JSDoc whose claim this work
  falsifies; several are named below.
- **Free text is one rule.** Notes and block reasons are `Domain.StepNote` (trimmed, 1000
  chars), editable by anyone with access, last write wins, no history, no `editedBy`. Do not
  add columns for attribution of edits.
- **After each phase:** `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (repo-wide; keep every file
  it touches), `pnpm test`. No `#graphql` strings change. Run the member e2e specs
  (`npm run test:e2e -- member`) at the end of Phase 5.
- **Do not commit.**

## Phase 1: The banner (`src/components/MemberRun.tsx`)

1.1 Replace `flagMessage` with two functions and keep the exhaustive `Match`:

| Flag               | `flagHeading`      | `flagBody`                                                 | tone       |
| ------------------ | ------------------ | ---------------------------------------------------------- | ---------- |
| `blocked`          | `Blocked`          | `flagDetail.reason` as typed, or `null` when absent        | `critical` |
| `quantity_changed` | `Quantity changed` | `From {from} to {to}.` (existing `formatNumber` fallbacks) | `warning`  |
| `item_removed`     | `No longer needed` | `Removed, refunded, or shipped in Shopify.`                | `warning`  |
| `order_cancelled`  | `Order cancelled`  | `null`                                                     | `critical` |
| `order_deleted`    | `Order deleted`    | `null`                                                     | `critical` |
| `order_fulfilled`  | `Already shipped`  | `Fulfilled in Shopify.`                                    | `warning`  |

Export `flagTone` alongside. Keep `flagActor`.

1.2 `FlagBanner` signature becomes
`{ run, actions?: React.ReactNode }`. Render:

```tsx
<s-banner tone={flagTone(run)} heading={flagHeading(run)}>
  <s-stack gap="small-500">
    {body !== null && <s-paragraph>{body}</s-paragraph>}   // white-space: pre-wrap, see 1.3
    {attribution}                                          // subdued: "{actor} · {relative flagAt}"
  </s-stack>
  {actions}                                                // caller passes buttons with slot="secondary-actions"
</s-banner>
```

Attribution line: `flagActor(run)` and `run.flagAt` via `LocalDateTime format="relative"`.
Reconcile flags have no actor; show only the time. `run.flagAt` is nullable; omit the line
when null. Whether `slot` on a child passes through the React wrapper for `s-button`: check
how `app.tsx` spreads `rel` on `s-link` (line ~275) and use the same spread if the JSX type
omits `slot`.

1.3 Multi-line text. Add one class in `src/styles.css`, next to `.live-value-preview`
(line ~83), that sets `white-space: pre-wrap; overflow-wrap: anywhere;` and apply it to the
banner body and to every rendered note (Phase 3). Name it for what it is (`.member-prose`
or similar); a JSDoc-style CSS comment says why: notes and reasons are typed multi-line and
last-write-wins, so the line breaks are the only structure they have.

1.4 Rewrite the file-head JSDoc ("Pieces the queue card and the work page both render…") to
mention the banner's actions slot and the one-fact-once rule.

## Phase 2: The queue (`src/routes/shop.$shop.index.tsx`)

2.1 **Heading.** `s-page heading="Queue"`; `head` meta title `Queue — Baton`. Remove the
`<s-text color="subdued">{memberEmail}</s-text>` line. `memberEmail` stays in loader data
(tiers need it) and is passed to `MemberBar` (Phase 4).

2.2 **Tier labels.** In `src/lib/queueTiers.ts`, `TIER_LABEL.attention` becomes `"Blocked"`.
Rewrite the JSDoc above `TIERS` so it no longer says "Attention first"; say the tier is
"flagged" and the heading reads Blocked because a blocked run is the common case and the
reconcile flags read as their own banner heading inside it.

2.3 **Card header.** Delete `TIER_BADGE` and the `<s-badge>{item.run.workflowName}</s-badge>`.
The header row is the order link and `ordered 31m ago`; `RunItem` stays as the body below it.
The mockup draws the item title on the header line, which is a wide-screen rendering; on a
360px phone it wraps under the link anyway. Record a deviation if you move it.

2.4 **Step box.** Title is `step.name` alone; delete the `· step {stage} of {stageCount}`
suffix and the `together with:` line. `stageCount` and `siblings` stay in `Domain.QueueItem`
/ `Domain.QueueStep` (the work page and the object still use them). Instructions stay as
`s-text color="subdued"`. The "In progress since … by …" line moves onto the title line as a
subdued suffix only if it fits in one `s-stack direction="inline"` with wrap; otherwise keep
it as the line below. Either is fine; note which.

2.5 **Actions while flagged.** `renderStep` receives `flagged: boolean` and renders no
Start/Done when true. Delete the standalone Dismiss `s-stack` under the banner. Pass
actions into `FlagBanner`:

- `run.flag === "blocked"`: one `s-button variant="secondary" slot="secondary-actions"`
  labelled `Unblock` calling `actions.dismiss.mutate(item.run.id)`.
- any other flag: same button labelled `Dismiss`.

Both disabled by `actions.pending`.

2.6 **Up next cap.** `const UP_NEXT_CAP = 10`. State `upNextAll: boolean`, reset to `false`
when `teamFilter` changes. Render `tiers.upNext.slice(0, upNextAll ? undefined : UP_NEXT_CAP)`
and, when hidden > 0, a centred `s-button variant="secondary"` reading `Show all {N}` where
N is `tiers.upNext.length`. Tier heading count stays the full count. JSDoc on the constant:
oldest-first means the top ten is the work; the cap is the whole of 1.0 scaling.

2.7 **Order note.** Keep the `Order note:` line; apply the pre-wrap class.

2.8 Rewrite the JSDoc on `TIER_BADGE` (deleted) and on `renderStep`'s "viewer's own name is
noise" comment if the line moves.

## Phase 3: The work page (`src/routes/shop.$shop.work.$runId.tsx`)

3.1 **Breadcrumb.** Inside `s-page`, before the first section:

```tsx
<s-link slot="breadcrumb-actions" href={queueHref} onClick={onQueueClick}>
  Queue
</s-link>
```

where `queueHref` is built with `useRouter().buildLocation({ to: "/shop/$shop", params })`
and `onQueueClick` calls `event.preventDefault()` then `router.navigate(...)`, following the
`router.navigate` usage in `src/routes/admin.index.tsx`. Delete the `<div className="print-hide"><Link>‹ Your work</Link></div>`.
Same treatment for the not-found branch's "Back to your work" link (text `Queue`).

3.2 **Header section.** One `s-section` with: `RunItem` (item title, SKU, personalization),
then an inline row of `s-badge {run.workflowName}`, the Done/Cancelled badge as today, and
`ordered … ago`; then `actions.banner`; then `FlagBanner` with actions. Delete the separate
"This item" section.

3.3 **Banner actions on the work page.** For `blocked`: `Unblock` (as 2.5) and `Edit reason`
(`variant="secondary"`, `slot="secondary-actions"`). For reconcile flags: `Dismiss`. Edit
reason toggles `reasonEditing: boolean`; while true the banner body is replaced by:

```tsx
<s-text-area label="Reason" labelAccessibilityVisibility="exclusive" rows={3}
  value={reasonDraft} ... />
<s-button variant="primary">Save reason</s-button>
<s-button variant="tertiary">Cancel</s-button>
```

Open the editor with the current reason already in the field (never empty), same rule as
the merchant note editor's JSDoc in `app.orders.$orderId.tsx` ~line 887. Save calls
`actions.setBlockReason.mutate({ runId, reason })` (Phase 5) and closes on `Ok`.

3.4 **Delete the "Blocked" section.** The `open && run.flag !== null` branch of the last
section goes. The `Block this work` form stays for `open && run.flag === null`, with
`s-text-area rows={3}` replacing `s-text-field` and placeholder
`What is stopping this? Who needs to know?`. Reason stays optional.

3.5 **Steps.** Title row: `{stage} · {step.name}` then `teamName` subdued then the badge.
Drop `stage ` from the subdued text since the number leads. `stepState` unchanged. Step
actions (`Start`, `Done`, `Undo`, note button) render only when `canAct && run.flag === null`;
the note button is the exception and stays available while flagged (a blocked step may still
need a note). State this in a one-line JSDoc.

3.6 **Notes.** `s-text-field` → `s-text-area rows={3}`. Rendered note: `Domain.stepNoteLine`
stays for the prefix; wrap in the pre-wrap class. Button copy: `Add note` when
`step.note === null`, `Edit note` otherwise; `variant="secondary"`, never tertiary. `Cancel`
beside `Save note` stays tertiary.

3.7 Rewrite the JSDoc above `stepState` only if its wording changes; rewrite the loader JSDoc
if it mentions the back link (it does not).

## Phase 4: The bar (`src/components/MemberBar.tsx`)

4.1 Add an optional `email` prop. Render `<s-text color="subdued">{email}</s-text>` in the
right-hand inline stack before `Sign out`, hidden under ~400px via a class if it crowds the
shop name (check on a 360px viewport in Playwright; a wrapping bar is acceptable, an
overflowing one is not).

4.2 Both member routes pass `memberEmail`. The shop picker (`shop.index.tsx`) does not render
`MemberBar`; leave it.

4.3 Rewrite the component JSDoc: it now answers "where am I and who am I".

## Phase 5: The new write, and the hooks

5.1 **Domain** (`src/lib/Domain.ts`, near `BlockRunInput` ~line 2529):

```ts
/** Rewrites the reason on an existing `blocked` flag. `reason: null` clears the text and keeps the block. */
export const SetBlockReasonInput = Schema.Struct({
  runId: BoundedId,
  reason: Schema.NullOr(StepNote),
});
export interface SetBlockReasonCommand {
  readonly runId: string;
  readonly teamIds?: readonly string[] | undefined;
  readonly reason: StepNote | null;
}
```

5.2 **Repository** (`src/lib/WorkflowRunRepository.ts`, beside `dismissFlag` ~line 1636):
`setBlockReason`. Requires the run, `requireReadyTeam(runId, teamIds)` (merchant passes
undefined, as `dismissFlag` does), and `run.flag === "blocked"`; otherwise fail with
`RunNotAllowedError` (a reason cannot be set on a reconcile flag or an unflagged run). Update
`flagDetail` to `{ ...detail, reason }` (or drop `reason` when null), keep `by` and `flagAt`
untouched, set `updatedAt`. Add to the service interface with a JSDoc stating the
last-write-wins rule and that `by` is who blocked, not who last edited.

5.3 **ShopAgent** (`src/lib/ShopAgent.ts`): `@callable() setBlockReason` beside `dismissFlag`
(member; `memberCallableEffect`, publish to teams) and `@callable() merchantSetBlockReason`
beside `merchantDismissFlag`. Log lines follow the existing format:
`ShopAgent.setBlockReason: shop=… runId=… memberId=…`.

5.4 **Callable roles test** (`test/integration/shop-agent-callables.test.ts` ~line 34): add
`setBlockReason: "member"` and `merchantSetBlockReason: "merchant"`.

5.5 **Repository test** (`test/integration/workflow-run-repository.test.ts`, after the
`blockRun sets the flag…` case ~line 1870): `setBlockReason` rewrites the reason and keeps
`by`; refuses on an unflagged run; refuses for a team without a ready step; merchant needs
no team.

5.6 **Hook** (`src/lib/useMemberRunActions.ts`): add `setBlockReason` mutation using
`textOrNull`, include it in `mutations`, return it. Extend the file JSDoc's list if it
enumerates the actions (it does not; leave it).

5.7 **Merchant page** (`src/routes/app.orders.$orderId.tsx`): out of scope for the UI. The
callable exists so the merchant surface can add Edit reason later without a domain change.
Do not add UI there in this work.

## Phase 6: Tests

6.1 `e2e/member-queue.member.spec.ts`:

- Every `s-page[heading="Your work"]` → `s-page[heading="Queue"]` (lines ~183, 216, 452).
- Line ~437: `Note` button → `Add note`.
- Lines ~443–449 (block flow): after `Block`, expect the banner heading `Blocked` and the
  reason text `Waiting on stones` (no `Blocked:` prefix); expect **no** `Done` button; click
  `Unblock`; then `Done`; then `Undo` visible. Add: click `Edit reason`, fill `Reason` with
  two lines, `Save reason`, expect both lines visible.
- Line ~451: link name `‹ Your work` → `Queue`.
- Add one assertion in the blocked flow on the queue page: the card shows `Unblock` and no
  `Start`/`Done`.
- Add one Up next cap test only if the fixture has more than ten Up next runs for one team
  (it does not today: 6 total). Skip and record as a deviation-by-design, or extend the
  fixture with eleven cheap runs if a test is wanted; the latter is optional.

6.2 `e2e/member-area.member.spec.ts`: `s-page[heading="Your work"]` → `Queue` (lines ~71, 85,
108, 144).

6.3 `test/integration/domain.test.ts` tests `tierQueue` (~line 354) and nothing about
`flagMessage`; no change unless a new `flagHeading`/`flagBody` case is wanted. One table-driven
case over all six flags is cheap and recommended.

6.4 Run the full suite and the member e2e specs.

## Phase 7: Docs

7.1 In `docs/member-queue-ux-research.md`, add a line under Decisions: "Implemented
{date}, see plan." Fold any deviation that changes a product decision back into the relevant
section.

7.2 In `docs/member-ux-research.md`, under Conclusion item 9, add one sentence: heading is
now "Queue" (2026-09-17, `member-queue-ux-research.md`).

## Deviations

The implementing LLM fills this in. One bullet per deviation: **what the plan said**, **what
was done instead**, **why**. Include things the plan got wrong about the code (a line that
moved, a type that did not allow a `slot` prop, a test that did not exist), decisions the plan
left open and how they were resolved (2.3 header layout, 2.4 in-progress line placement, 4.1
bar overflow, 6.1 Up next test), and anything skipped. An empty section means the plan was
followed exactly; say so explicitly.

**Decisions the plan left open**

- **2.3 header layout.** Kept as the plan's fallback: the header row is the order link and
  `ordered 31m ago`, with `RunItem` (title, SKU, personalization) as the body below it. The
  mockup's one-line item title wraps under the link at 390px anyway; checked in Playwright.
- **2.4 in-progress line.** Left as the line below the title, not a suffix on it. The title
  is now bare (`Engrave crest`), so a suffix would be the widest thing in the box and the
  first thing to wrap.
- **4.1 bar overflow.** No hiding class. At 390px the bar wraps to two lines — shop on top,
  `lead@m.com  Sign out` under it — which the plan calls acceptable; nothing overflows.
- **6.1 Up next cap test.** Skipped at first, then added in review. The skip reasoned that
  "the constant is the whole of the logic"; it is not — the cap is a slice, a subtraction and
  two `setUpNextAll(false)` calls in separate handlers, and it is the one place in the member
  area where a heading's count is not the number of cards under it. `seedQueue` gained a
  `withBulk` option (ten filler Cut orders) and the spec a test over the three behaviours:
  the count staying full while the list is sliced, Show all expanding it, and a team chip
  re-capping. Confirmed non-vacuous with `UP_NEXT_CAP` temporarily at 100 (fails on the
  first count). Cost: the member project went from 43s to 1.2m.

**What the plan got wrong about the code**

- **1.2 `slot` on `s-button`.** No spread needed — `slot` is already in the JSX props
  (`admin.index.tsx` line 47 passes `slot="secondary-actions"`). The `rel` spread in
  `app.tsx` is specific to `rel`.
- **1.3 the pre-wrap class.** `className` is _not_ in the Polaris elements' JSX props, so the
  class could not go on `s-paragraph`. Added a `Prose` wrapper in `MemberRun.tsx` that puts
  `.member-prose` on a plain `div` around the Polaris element; `white-space` inherits through
  the shadow boundary, which was confirmed in the browser with a three-line reason.
- **3.1 `queueHref`.** `router.buildLocation(...).href`, not a bare `buildLocation`. The
  not-found branch lost its link entirely rather than gaining a second one: the page now has
  the breadcrumb, and a "Back to your work" link under the paragraph would be the same
  destination twice.
- **3.3 the reason editor.** `FlagBanner` needed a `children` prop as well as `actions` —
  the editor _replaces_ the banner body, and passing it as an action would have put a text
  area in the button slot.
- **6.1 the block flow.** The step title assertion `CUT_STEP` ("Cut · step 1 of 1") and the
  tier-badge assertion in the Mine/In-progress test (`card(...).getByText("Mine")`) both had
  to change; the plan listed neither. The first is now `"Cut"` exact, the second asserts the
  badge is _absent_, which is the one-fact-once rule under test.

**Added beyond the plan**

- `merchantSetBlockReason` publishes to teams like its siblings, and the repository test
  covers the merchant path (no `teamIds`) alongside the member one.
- The queue's "Order note" and both surfaces' step notes got `.member-prose`, not just the
  banner body — 1.3 says "every rendered note" and these are the ones that exist.

**Skipped**

- Nothing. 5.7 (merchant Edit reason UI) was out of scope by the plan's own instruction; the
  callable exists and no UI was added to `app.orders.$orderId.tsx`.

**Found in review, after the above**

- **The breadcrumb printed.** 3.1 replaced a `<div className="print-hide">` wrapper with a
  bare `s-link`, so the "Queue" link joined the printed job ticket. `class` is not in the
  Polaris JSX props and a wrapping div would take the slot in the link's place, so the rule
  is a selector in `styles.css` (`s-link[slot="breadcrumb-actions"]`), documented at both
  ends.
- **The reason draft outlived its hold.** `reasonDraft` was a bare string with nothing
  clearing it when `run.flag` stopped being `blocked`, so an Unblock mid-edit (this member's
  or a teammate's over the socket) left the text in state to reappear inside the _next_
  block's banner. Now stamped with the `flagAt` it was opened on and read through a derived
  `editingReason`; a stale stamp can never match, and no effect is needed (oxlint's
  `react(set-state-in-effect)` forbids the effect version anyway).
- **`setBlockReason` was not transactional.** It reads `flagDetail` and writes it back, so a
  `dismissFlag` landing in between left `flag = null` carrying a reason. Wrapped in
  `sql.withTransaction`, as `blockRun` already is; `dismissFlag` needs none because its write
  is blind.
- **The member's fields never counted down to the note cap.** 3.4 and 3.6 swapped
  `s-text-field` for `s-text-area` without the countdown the merchant's note editor has, so
  the only warning about `Domain.STEP_NOTE_MAX_LENGTH` was the write refusing a typed
  paragraph with the schema's own words ("Expected a value with a length of at most 1000",
  through `causeToErrorMessage` into the critical banner). `NOTE_COUNT_FROM` moved from
  `app.orders.$orderId.tsx` to `Domain.ts` beside the cap, and a `NoteCountdown` component
  carries it on all three member fields. No `maxlength`: it truncates a paste silently, which
  is worse than a late refusal for the case that reaches the cap at all.
- **A non-blocked run failed as `RunNotAllowedError`** with a placeholder `teamId: ""`, which
  the member read as "This step belongs to another team." New `RunNotBlockedError` →
  `Domain.RunResult` variant `NotBlocked` → "This work is no longer blocked.", with the
  merchant table carrying the tag too (the union is one union). Folded into the research doc.
