# Workflow editor chrome: breadcrumb "Close" vs Flow-style app window

Research date: 2026-09-12. Research only, not a spec.

Question: the workflow editor (`src/routes/app.workflows.$workflowId_.edit.tsx`, and
its twin `app.order-workflow.edit.tsx`) renders as an ordinary `s-page` with a
breadcrumb link labeled **Close**. That reads oddly: a breadcrumb names the parent
page, and "Close" is a dismiss verb. Shopify Flow's editor instead takes over the
admin viewport with a slide-up transition and an admin-owned **X**. Should Baton adopt
that, or something else?

Sources: `docs/shopify-flow-ux-research.md` (live Flow teardown, 2026-09-06, screenshots
in `docs/shopify-flow-ux/`), the Polaris/App Bridge docs under
`refs/shopify-docs/docs/api/app-home/latest/`, the design guidance under
`refs/shopify-docs/docs/apps/design/`, the Built for Shopify requirements, the Flow
merchant manual in `refs/flow-manual/`, and the competitor scrapes in `refs/`.

## Conclusion

1. **Flow's editor is not a modal.** It is App Bridge **fullscreen** ("app window")
   mode: the admin hides its sidebar, the app frame fills the viewport under the top
   bar, and the app's own title row (name, Draft badge, More actions, Discard, Apply)
   sits in a bar with an admin-controlled **X** at the far right
   (`docs/shopify-flow-ux/08-workflow-editor.png`). The slide-up animation is the
   admin's fullscreen transition, not a bottom sheet.
2. **Shopify exposes exactly this pattern to apps as `s-app-window`.** It is the
   documented, Built-for-Shopify-endorsed way to do a full-screen editor, and the
   design docs name "a complex editor with several columns" as its use case. There is
   no `size="max"` on `s-modal` in App Home, no `shopify.fullscreen` API, and the
   deprecated `FullscreenBar` is a BFS rejection reason.
3. **Recommendation: move the editor into an `s-app-window`.** It removes the
   breadcrumb problem entirely (the admin owns the exit), matches Flow one-for-one,
   and matches what Polaris says an editor should be. The cost is real but bounded:
   the editor route renders inside an iframe, so it needs its own shell, and the
   parent page must refresh when the window closes.
4. **Cheap interim fix if the window is deferred:** keep the page but make the
   breadcrumb a real breadcrumb. The Close link stays where it is, but the label
   becomes the parent page's name. See [Option A](#option-a-keep-the-page-fix-the-breadcrumb)
   for why that is still awkward.

## What Flow actually does

From the live teardown (`docs/shopify-flow-ux-research.md` §4–§7) and the manual
(`refs/flow-manual/create/workflow-editor.md`):

- Entry is always an explicit button: **Create workflow** on the list or **Edit** on the
  detail page. The editor is a separate route (`/apps/flow/editor/<id>/<version>`).
- The admin chrome switches to fullscreen: sidebar gone, top search bar kept, the app's
  header row rendered in a bar under it with **X** at the far right.
- Header contents, with a draft: `More actions ▾` · `Discard changes` · `Apply changes`
  · `X`. Clean: `More actions ▾` · `Turn on workflow` · `X`.
- Every change persists to a draft immediately. **Close (X) never confirms and never
  discards**; the draft survives close and reopen. Only Apply and Discard end a draft,
  and Discard confirms.
- The detail page shows Saved / Draft / Version history tabs so a merchant can see the
  draft without entering the editor.

Baton already copies the behavioural half of this (immediate draft persistence, Close
preserves the draft, Discard confirms, Apply confirms only when the workflow is on). What
it does not copy is the chrome. The breadcrumb "Close" is a page idiom standing in for
the fullscreen X.

## What Polaris and App Bridge offer

### `s-page` breadcrumb (what Baton uses today)

`refs/shopify-docs/docs/api/app-home/latest/web-components/layout-and-structure/page.md`

- The only back affordance on `s-page` is the `breadcrumb-actions` slot, which "only
  accepts link components" and renders as `‹ Label` before the heading. There is no
  `back-action` attribute and no close/X option.
- The design docs say breadcrumbs should let merchants "return to the previous page"
  (`apps/design/navigation.md:51`, `patterns/templates/details.md:18`). The label is
  expected to be the parent page's name, which is why "Close" reads wrong: it names an
  action, not a place.
- `apps/design/user-experience/forms.md:35`: "Avoid placing large forms inside max
  height, max width modals. Instead, create a new page." That is the case _for_ a page.
  But `apps/design/app-structure.md:199`: "a complex editor with several columns" is
  the case for routing into a dedicated surface, and §59–109 of the same file names
  that surface as the app window.

### `s-app-window` (what Flow's chrome maps to)

`refs/shopify-docs/docs/api/app-home/latest/app-bridge-web-components/app-window.md`
and `refs/shopify-docs/docs/apps/design/app-structure.md:59-109`.

- "Displays a fullscreen modal window for complex workflows that need dedicated screen
  space. The content is specified by the `src` property and should point to a route
  within your app. The app window covers the entire screen, with a top bar controlled
  by the Shopify admin that allows users to exit."
- The `src` route renders an `s-page`; its `heading`, `accessory` badge,
  `primary-action`, and `secondary-actions` (including an `s-menu` More actions) are
  hoisted into the admin's top bar. The documented examples are literally "Product
  editor" with a Draft badge, Save, and a More actions menu.
- Control: `<s-button command="--show" commandFor="id">`, or `show()` / `hide()` /
  `toggle()`; events `show` and `hide`; `contentWindow` for postMessage; `src` can be
  changed while open.
- Rules (design docs and BFS): open only from an explicit button in the app body,
  never on page load and never from the app nav; do not add your own close control
  ("redundant mechanisms to dismiss"); "Primary navigation for the app should be shown
  in the top bar of the app window and the primary actions should not be duplicated";
  "Return to context on close".
- `hide()` honours `data-save-bar` forms and prompts before closing. Baton does not use
  the save bar (see below), so the X closes silently, which is what Flow does.
- Types exist in the installed `@shopify/app-bridge-types` 0.7.2 (`SAppWindowAttributes`,
  `src` required). The React wrapper package does not need changing; the element is
  declared in `src/lib/shopifyAppBridgeElements.ts` alongside the others.

### `s-modal`

Sizes are `small` to `large-100` only; the shared Polaris type's `max` is excluded from
the App Home build. No `src`, inline only, always centred. The docs call modals "a last
resort for important decisions, not for contextual tools". Wrong tool for a two-column
editor; right tool for Rename, Discard, Apply, Delete, which Baton already does.

### Save bar

Not applicable to the editor as designed. Baton persists every step and tag change to
the Durable Object draft immediately, so there is nothing unsaved in the browser. That
is Flow's model. Note the tension for the record: `forms.md:39` says "auto-save for
forms is incongruous with the standard Shopify admin save UX", and BFS §4.1.5 rejects
forms that "reasonably" should use the contextual save bar. Flow ships the autosave
model inside Shopify itself, and the editor's Apply/Discard pair is the equivalent of
Save/Discard at the version level. If a reviewer ever objects, the answer is the Draft
badge plus the Apply/Discard buttons in the header, which is exactly Flow's answer.

### Competitors

The five scrapes in `refs/` are app-store listings and marketing pages with no source,
so nothing can be said about their chrome. Two have no editor at all (BenchCue,
Makers Production View), two configure through a settings page (Kanbanify,
MakerBatch), and Route to Ship describes a "drag-and-drop pipeline builder" without
showing it. No signal either way.

## Options

### Option A: keep the page, fix the breadcrumb

Change the link text from **Close** to the parent page's name so it is an honest
breadcrumb. Zero structural work.

- The parent of the editor is the workflow detail page, whose heading is the workflow
  name. So the editor would read `‹ Engraved  **Engraved** Draft`. The duplicate is
  why "Close" was chosen. The only clean escape is to retitle one of them, for example
  editor heading `Edit workflow` with breadcrumb `Engraved`, or breadcrumb
  `Workflows` with Close returning to the list instead of the detail page. Both drift
  from Flow, and the second changes where Close lands.
- Still a page: sidebar visible, canvas width capped at `inlineSize="base"`, and the
  editor competes with app navigation the merchant should not be using mid-edit.
- Browser back and a bookmarkable URL keep working. `?tag=edit` deep link keeps
  working.

### Option B: `s-app-window` (recommended)

Detail page and list get the window element; **Edit** and **Create workflow** open it
with `src` pointing at the editor route.

- Chrome matches Flow exactly: fullscreen, admin X, heading plus Draft badge plus
  More actions, Discard, Apply in the top bar. The breadcrumb question disappears.
- Aligned with the design docs' named use case and with BFS §4.1.6.
- **Iframe cost.** The editor becomes a separate document. It needs a shell that loads
  App Bridge and Polaris, authenticates the session, and renders no `s-app-nav`
  (`src/routes/app.tsx` renders the nav for everything under `/app`, so the editor
  moves to its own layout or the layout learns to skip the nav in window mode).
  App Bridge inside the iframe is a second instance; toasts and modals from the editor
  still work because App Bridge web components talk to the host through the frame.
- **Refresh on close.** The detail page must invalidate its loader on the window's
  `hide` event so the Draft badge, tag, and steps reflect what happened inside. Apply
  currently navigates to the detail page; in the window it calls `hide()` on the parent
  window instead (via `window.parent` postMessage or `contentWindow` from the parent
  side listening for a message).
- **Duplicate and not-found paths.** Duplicate navigates to the copy's editor today;
  in the window that is a `src` swap. The not-found branch renders a page with a
  breadcrumb to the list; inside the window it should just render a message and let
  the X do the rest.
- **URL is no longer addressable.** Refreshing the browser lands on the detail page,
  not the editor, and browser back does not close the window (the X and Escape do).
  Flow accepts the same. The `?tag=edit` deep link from the detail page still works as
  a `src` query, because it is triggered by a click, not on load.
- **Two editors.** The order-workflow editor is a near copy and would move at the same
  time, or the two chromes diverge.
- **Unknowns to verify in a spike before committing:** that the accessory badge and an
  `s-menu` hoist correctly into the top bar in the embedded dev tunnel; that Escape and
  the X leave the draft alone (they should, no `data-save-bar`); how the window behaves
  on a phone-width admin; whether TanStack Start's router and the session cookie work
  cleanly in the iframe document.

### Option C: fold editing into the detail page (Flow's Draft tab)

Drop the separate editor. The detail page grows Saved / Draft tabs, and step and tag
edits happen in the Draft tab's aside. No breadcrumb, no iframe.

- Biggest redesign of the three; the detail page's read-only canvas and the editor's
  editable canvas merge, and the "Edit" verb becomes "make a change and a Draft tab
  appears".
- Loses the focused, distraction-free surface that both Flow and Polaris recommend for
  multi-column editors. Flow keeps both the tabs _and_ the fullscreen editor; the tabs
  are for viewing, not editing.
- Not recommended on its own, but the Draft tab on the detail page is worth adding
  regardless of A or B, because it lets a merchant see a pending draft without opening
  the editor.

## Recommendation

Do **B**. The editor is the one surface in Baton that is an editor rather than a form,
and Polaris has a dedicated primitive for it that produces the chrome the merchant
already knows from Flow. Sequence:

1. Spike: a throwaway `s-app-window` whose `src` is the current edit route with the nav
   suppressed. Confirm header hoisting, Escape/X behaviour, and iframe auth. Half a day.
2. If the spike holds, give the editor its own layout without `s-app-nav`, replace
   Apply's navigate with a close message to the parent, and invalidate the detail
   loader on `hide`. Move both editors together.
3. Keep A as the fallback only if the spike fails: change the breadcrumb to the parent's
   name and retitle the editor heading to avoid the duplicate.

## Open questions

- Does the editor need a bookmarkable URL or browser-back support? The window gives
  those up, as Flow does.
- Should the order-workflow editor move in the same change, or lag?
- Is a Draft tab on the detail page (Option C's one good part) wanted now or later?
- Should the spike also test `s-app-window` on the create path, so a new workflow opens
  straight into the window from the list, matching Flow's **Create workflow**?

## Decisions (2026-09-12)

- **Try the app window and see how it comes out.** Match Flow's chrome, including the
  create path opening straight into the window.
- **Item workflow editor only for now.** The order-workflow editor stays a page until
  the item editor has been seen in the window.
- **No Draft tab on the detail page.** Flow needs one because version history is a
  product feature there. Baton's detail page already knows a draft exists, so a Draft
  badge next to Edit is enough; opening the editor is one click and writes nothing.
- **Bookmarkable URL: wanted, but probably not available.** Flow's editor has an admin
  URL because it is first-party. For an app, `s-app-window` is an iframe and the admin
  URL stays on the page that opened it. The spike records what the admin URL does while
  a window is open; if it does not change, the window wins and the URL is given up.

## Spike outcome (2026-09-12)

Built and verified live in `sandbox-shop-01`. Screenshots in
`docs/workflow-editor-chrome/`. Both editors now open in an `s-app-window`; the
order-workflow editor followed the same day once the item editor had been seen
(`11-order-workflow-after-apply.png`), sharing the hook with its own editor path.

What was seen:

- **The chrome matches Flow one-for-one** (`01-app-window-first-open.png`): sidebar
  gone, heading plus Draft badge plus More actions, Discard, Apply hoisted into the
  admin bar, admin X on the right. The `s-page` breadcrumb is dropped by the admin
  and is now not rendered in window mode at all.
- **The admin URL never changes** while the window is open. The bookmarkable
  editor URL is gone, as predicted. The plain `/edit` route still works as a page.
- **No shell change was needed.** The window document renders no `s-app-nav`
  because the admin ignores it in a window; the existing `/app` layout serves both.
- **`shopify.modal.hide(id)` does not work inside an app window**
  (`04-after-apply-inside-window.png`, `08-after-discard-inside-window.png`): it
  rejects with "Modal with ID … not found" even while the dialog is open, so Apply
  and Discard left their dialogs up and never reached their follow-up. Fixed with
  `hideModal` in `polarisModal.ts`, which calls the element's own `hideOverlay`.
- **The router JSON-decodes search values.** A `window=1` flag came back as the
  number 1 and the string check failed, so the editor navigated inside the window
  instead of closing it (`09-after-apply-fixed.png` shows the detail page rendered
  inside the window). The flag is now `chrome=window`.
- **A placeholder `src` of `about:blank` breaks later `src` assignment**: App Bridge
  rewrote `…/edit?chrome=window` to `…/edit&chrome=window`. The list page's window
  now carries a real placeholder URL with a query string.
- **Delete from a just-created window** hid the window, which fired the list page's
  "go to the new workflow" handler before the deleted handler ran. The hook now
  suppresses `onHide` while a delete is closing the window.

How the pieces talk (`src/lib/workflowEditorWindow.ts`): the editor posts
`applied` and `deleted` on a same-origin `BroadcastChannel`, because the window
iframe is a sibling of the app iframe under the admin and cannot reach it through
the DOM. The opener's `useWorkflowEditorWindow` hook owns the element, refetches
on every `hide`, hides on `applied`, and hides then calls `onDeleted` on `deleted`.
The list page opens the window straight after Create and navigates to the new
workflow's page when it closes, which is Flow's behaviour.

Left for later: cleaning up the sandbox test data (the Engraved workflow now has a
"Polish" step and its tag reads "engraving"; a "Window spike" workflow exists; the
order workflow has a "Pack" step).
