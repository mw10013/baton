# Bang follow-up: timestamps break hydration, not Polaris slots

Research date: 2026-09-09. Written from the Baton side after acting on
`docs/baton-followups-research.md`. Baton ran the reload test that doc
proposed, and the answer to its Part 2 question is neither of the two it
offered. This doc records what was measured, what Baton changed, and the
matching change for Bang. Baton's files are the reference; copy them rather
than re-deriving. Nothing here depends on Bang's domain.

## What was measured

Probe: Playwright, embedded admin over the Shopify CLI tunnel, hard reload
five times on `/app/workflows/<id>`, collecting `console` and `pageerror`
events from the iframe. Then the SSR document body (from the `response`
event) diffed against the hydrated DOM.

**Every reload** raised

> Hydration failed because the server rendered text didn't match the client.
> As a result this tree will be regenerated on the client.

The differing text:

| Side                              | Text                             |
| --------------------------------- | -------------------------------- |
| SSR (workerd, UTC)                | `Last updated on Sep 8, 9:23 PM` |
| Browser (America/New_York, en-US) | `Last updated on Sep 8, 5:23 PM` |

`formatDateTime` in `src/lib/format.ts` calls `toLocaleString(undefined, …)`,
which formats in the **runtime's** timezone. SSR runs in workerd, whose
timezone is UTC in dev and in production, and the browser formats in the
merchant's. Any timestamp that reaches SSR from loader data therefore
hydrates to different text. React 19 treats that as recoverable: it logs,
discards the whole SSR tree, and re-renders the root on the client. Not a
crash, so nobody saw it; but every load paid a full client render and the
SSR HTML was a preview thrown away.

That discarded tree is what the original commit `21c53d2` described as the
"intermittent blank Updated column in `s-table`": the memory table's Updated
cell is `formatDateTime(entry.updatedAt)`. Wrapping the table in
`ClientOnly` removed the timestamp from SSR, which removed the mismatch,
which looked like a Polaris `s-table` fix. Polaris was never involved; the
wrapper was hiding a formatting bug.

After Baton moved every timestamp out of SSR, the fatal error was gone on
all six probed pages (workflows list/detail, orders list/detail, teams
list/detail). One warning remains, dev-only:

> A tree hydrated but some attributes of the server rendered HTML didn't
> match the client properties. This won't be patched up.

with diffs of the form

```
<s-badge slot="accessory" tone="success"
-  style={{display:"none"}}
>
```

on every `s-page` slot child, **including `slot="breadcrumb-actions"`**.
This is the real Polaris behavior: `s-page`'s upgrade sets
`style="display:none"` on each slotted light-DOM child and renders its own
copy in shadow DOM. React finds an attribute it did not render and warns.
It does **not** discard the tree (the message says so), production React
does not perform the attribute check at all, and the warning does not go
through `onRecoverableError`. So it is console noise in dev, on every page
with a slotted child, and it is present with or without `ClientOnly` on
some of them, because the breadcrumb link is always slotted and never
wrapped in either repo. `ClientOnly` around slot children buys nothing:
it trades SSR content for silence on a warning that has no runtime effect.

## What Baton changed (the port list)

1. **`src/components/LocalDateTime.tsx`** (new). `useHydrated()` gate:
   renders `null` on the server and first client render, the formatted
   string from the commit onward. The page body is `inert` until that same
   commit, so the timestamp appears exactly when the page becomes
   interactive; nothing is lost. Optional `format="time"` for time-only
   text. The JSDoc carries the measurement above so it stays with the
   code. Copy the file.
2. **`src/lib/format.ts`**: JSDoc on `formatDateTime` says never to call it
   from a server-rendered branch and points at `LocalDateTime`; adds
   `formatTime`. `formatDateTime` stays exported for post-hydration strings
   (toasts, `useQuery` data that is never SSR'd).
3. **Every render-time call site** rewritten to `<LocalDateTime value={…} />`.
   Template strings become JSX text: `` `Last updated on ${formatDateTime(x)}` ``
   → `Last updated on <LocalDateTime value={x} />`. Nullable columns
   guard first: `x === null ? null : <LocalDateTime value={x} />`, so
   helpers that treat `null` as "omit the row" keep working. Where a helper
   accepted `value?: string | null`, widen it to `ReactNode`.
4. **Dropped `ClientOnly` around `s-table`** in `admin.shops.tsx` and
   updated the root-route JSDoc that lists where `useHydrated()` is read.
   Probe after: no fatal error.
5. **`src/client.tsx`** (new): Start's default client entry plus an
   `onRecoverableError` that logs with a stable `hydration.recoverable:`
   prefix. It is the permanent detector for this class of bug; text
   mismatches are silent otherwise. Takes effect after a dev-server
   restart (Start resolves the entry at startup). Copy the file.
6. **`scripts/refresh-shopify-playwright-auth.ts`**: `Flag.boolean("dry-run")`
   needs `Flag.withDefault(false)`. Under effect `4.0.0-rc.112` a boolean
   flag without a default is required, so the e2e `setup` project failed
   with `Missing required flag: --dry-run` whenever the saved admin session
   had expired. Bang's script has the same two lines and the same pin.

## What Bang should do

Bang's timestamp call sites (all reach SSR from loader data):

- `src/routes/app.memory.tsx:445` — the Updated cell. This is the one that
  started the whole `ClientOnly` story.
- `src/routes/admin.shops.tsx:164,167,175` — three cells.
- `src/routes/admin.shop.$shop.tsx:313,374,401,496,500` — `Field` values
  and a "Last active" line.

Steps, in order, each verifiable on its own:

1. Copy `LocalDateTime.tsx` and `client.tsx` from Baton; add `formatTime`
   and the JSDoc to `format.ts`. Restart the dev server so the client entry
   is picked up.
2. Convert the nine call sites. Widen `Field`'s `value` to `ReactNode`.
3. Run Bang's e2e suite. `memory.spec.ts` or whichever spec asserts on the
   Updated column should still pass: the text arrives at hydration, which
   `awaitHydration` already waits for.
4. Run the probe (a throwaway spec: `gotoApp`, navigate, reload five times,
   collect `pageerror`; Baton's version is described above and takes ten
   minutes to rewrite). Expect zero `Hydration failed` events. The
   attribute warning will remain; that is the expected state.
5. Remove the five `ClientOnly` wrappers: `app.index.tsx:220`,
   `app.memory.tsx:281,286,299`, `LivePage.tsx:738`, `admin.shops.tsx:89`.
   Delete the JSDocs that attribute them to Polaris hoisting
   (`app.index.tsx:105`, `app.memory.tsx:163`, `LivePage.tsx:478`); they
   describe a mechanism that does not exist. Keep the `SocketBanner`
   wrapper: `identified` is genuinely false on the server. Re-run the
   probe.
6. Fix the `--dry-run` default.
7. Update Bang's root-route JSDoc the way Baton did, and add a line to
   `docs/baton-parity-research.md` retiring its "keep Bang's wrappers"
   position.

## Decision record

- Do not reinstate slot wrappers in Baton; remove them in Bang. Verified
  against the CDN `polaris.js` on 2026-09-09; the `display:none` behavior
  is Polaris's and could change, but the only consequence of a change would
  be a different dev warning, never a discarded tree, because no
  server-rendered text depends on it.
- Any future "blank column" or "flash of re-render" report should start
  with a grep for `formatDateTime`, `toLocale`, `Intl.`, `Date.now()` in a
  render path, and with the `hydration.recoverable:` prefix in the console.
