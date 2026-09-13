# The workflows e2e spec after the editor moved into an `s-app-window`

Research date: 2026-09-12. Scope: `e2e/workflows.spec.ts` and `e2e/app.ts`. The
editor now opens in an App Bridge `s-app-window` (commits `560838d`, `7573637`)
and the spec was never updated for it. Three causes found and fixed, one failure
left. Work is uncommitted in the working tree. A follow-up agent can pick this
up cold.

## Where this started

`e2e/workflows.spec.ts` had two failing tests on `d6167a5`, **before** any of the
empty-state work in `28ceb59` — verified by stashing that work and rerunning. The
failure was:

```
strict mode violation: locator('iframe[src*="embedded=1"]') resolved to 2 elements
```

The other two tests in the file pass throughout; they never open the editor,
which is the whole tell.

## What changed under the spec

The editor used to be a route the app iframe navigated to. It now opens in an
App Bridge `s-app-window`: a second full-screen iframe the admin mounts as a
**sibling** of the app's own, not a child. See `src/lib/workflowEditorWindow.ts`.

Consequences the spec did not know about:

- Two iframes carry `embedded=1`, so `appFrame` is ambiguous while the editor
  is open.
- Nothing inside the editor is reachable through `appFrame` — it is a different
  document.
- Creating a workflow from the list **opens the editor immediately**
  (`app.workflows.index.tsx`, the `createMutation.onSuccess` calls
  `editor.open`). The detail page only appears once the window hides. The spec
  still expected create to land on the detail page.
- In window mode the editor renders no breadcrumb, so its Close is the X the
  admin draws in the window header, not the page's own.

## The three causes, and the evidence

### 1. `appFrame` matched both iframes

Fixed by excluding our own window flag:

```ts
page.frameLocator('iframe[src*="embedded=1"]:not([src*="chrome=window"])');
```

`chrome=window` is the flag the opener puts on `src` (`workflowEditorWindow.ts`),
so it is ours to rely on — unlike the admin's generated iframe `name`
(`frame://baton-local/modal/<uuid>/src`) or its hashed class
(`_AppWindowModalIframe_lth4g_1`). A companion `editorFrame` selects the editor
by the same flag.

### 2. The CLI Dev Console silently ate clicks

This one cost the most time and is worth remembering. With the Dev Console panel
expanded, `editor.getByRole("button", { name: "Cancel" }).click()` **reported
success and did nothing**: no listener fired, the modal stayed open, and the next
action failed somewhere unrelated.

Measured 2026-09-12, tag modal open in the editor window:

| Check | Result |
| --- | --- |
| Cancel's rect in the editor frame | `x 756.9, y 419.5` |
| The editor iframe's box in the admin | `x 8, y 113` |
| Playwright's page-coordinate box for Cancel | `x 764.9, y 532.5` — translation exact |
| `document.elementFromPoint` **in the frame** | `s-button` — nothing occluding |
| `document.elementsFromPoint` **in the admin** | `table._ExtensionsTable_…`, `div._ContentContainer_…` |
| A listener on the button after `.click()` | never fired |
| `el.click()` (synthetic) | fired, modal closed |

So the click was dispatched at the right page coordinates and landed on the Dev
Console's extensions table, which sits above the app window in the admin
document. **Playwright's actionability check cannot see this**: it runs inside
the frame, and the occluder is in the parent document. Any spec driving the app
window is exposed to it, and whether the console is expanded comes from whatever
admin session the storage state was exported from — so it varies by machine and
by run.

Fixed in `gotoApp` by collapsing the console once per page load
(`closeDevConsole` in `e2e/app.ts`). Expansion is read from the panel's own
geometry, because the toggle keeps the accessible name "Close Dev Console" in
both states — clicking it unconditionally would expand a collapsed console every
other run.

### 3. `closeEditor` looked for a breadcrumb that no longer exists

The editor's Close is now the X in `div._AppWindowModalHeaderActions_…`, inside
`div._AppWindowModalDialog_…`. Scope to `[class*="AppWindowModalDialog"]` —
`AppWindowModalHeader` matches three nested elements and trips strict mode, and a
bare `getByRole("button", { name: "Close" })` also catches the admin's portal
close and the Dev Console's.

## Where it stands

Uncommitted, in the working tree:

| File | Change |
| --- | --- |
| `e2e/app.ts` | `appFrame` excludes `chrome=window`; new `editorFrame`; `closeDevConsole` called from `gotoApp`. All three carry the reasoning above as JSDoc. |
| `e2e/workflows.spec.ts` | Editor interactions re-scoped to `editor`; `stepName` for the editor's step forms (the create dialog's Name field is a different element); `closeEditor` targets the app-window X; the file's header JSDoc explains the two frames. |

Last healthy run: **3 of 4 passed**. `pnpm typecheck`, `pnpm lint` and
`pnpm fmt` are clean.

## What is left

One failure, in `workflows create, edit, apply, and discard through the draft`:

```
locator.click: Test timeout
  waiting for locator('iframe[src*="chrome=window"]').contentFrame()
    .getByRole('button', { name: 'Discard', exact: true })
```

The step before it clicks the hoisted `Discard changes`, which is
`slot="secondary-actions"` with `commandFor={DISCARD_MODAL} command="--show"`
(`app.workflows.$workflowId_.edit.tsx:669`). App Bridge hoists that button out of
the editor's document into the admin's window header, so the `--show` command has
to be relayed back across the boundary to a modal that lives in the window's
document.

**The hypothesis to test first: that relay does not work, and this is a product
bug, not a test bug.** It is the same registry problem already documented for the
other direction in `src/lib/polarisModal.ts` — `shopify.modal.hide` cannot see an
`s-app-window` document's modals, which is why `hideModal` exists and calls
`hideOverlay` on the element. If `--show` fails the same way, a merchant clicking
**Discard changes** in the editor window gets nothing, and the fix is a `showModal`
mirroring `hideModal` (plus an `onClick` on that button instead of `commandFor`),
not a change to the spec.

How to tell them apart, with the editor open on a workflow that has a draft:

1. Click the hoisted `Discard changes`.
2. Read `s-modal#discard-draft`'s shadow `dialog` in the editor frame — is
   `open` set?
3. Call `showOverlay()` on that element directly. If step 2 says closed and step
   3 opens it, the relay is the bug.

A probe spec that does exactly this was written and deleted; rewriting it is ten
minutes. Drive it the way the probes in this doc were driven: a throwaway
`e2e/zz-probe.spec.ts`, `console.log` the readings, delete it afterwards.

Apply changes is worth checking at the same time: it takes the `commandFor`
branch only when the workflow is **on** (`hasDraft && isActive`), and no test
currently exercises that path inside the window. If `--show` is broken, Apply on
an active workflow is broken too, and that is the more damaging of the two.

## Environment notes

- Two runs burned 10 and 15 minutes on a dev server that had stopped hydrating:
  `body[data-hydrated="true"]` never appears, every locator eats its full
  timeout, and one run died with `Protocol error … session closed`. A healthy
  full run of this spec is ~3.4 minutes. **Restart `pnpm app:dev` before
  concluding anything from a slow run.**
- These specs seed through `/api/dev/seed`, so the shop is left with `E2E *`
  fixtures. `pnpm d1:reset` (plus clearing `.wrangler`) is how to get an empty
  shop back.
- The suite's storage state is decrypted from the real Chrome profile, so admin
  UI state — the Dev Console among it — leaks into runs from whatever that
  browser was last doing.
