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

| Check                                         | Result                                                |
| --------------------------------------------- | ----------------------------------------------------- |
| Cancel's rect in the editor frame             | `x 756.9, y 419.5`                                    |
| The editor iframe's box in the admin          | `x 8, y 113`                                          |
| Playwright's page-coordinate box for Cancel   | `x 764.9, y 532.5` — translation exact                |
| `document.elementFromPoint` **in the frame**  | `s-button` — nothing occluding                        |
| `document.elementsFromPoint` **in the admin** | `table._ExtensionsTable_…`, `div._ContentContainer_…` |
| A listener on the button after `.click()`     | never fired                                           |
| `el.click()` (synthetic)                      | fired, modal closed                                   |

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

## 4. `clickHoisted` fired at a disabled button

The last failure was **not** the product bug the first draft of this doc
predicted. Probed live 2026-09-12, editor open on a workflow with a draft:

| Reading                                                     | Result                                                                                        |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The hoisted `Discard changes` proxy, as HTML                | a Polaris `<button>` with `aria-disabled="true"`, `Polaris-Button--disabled`, `tabindex="-1"` |
| `#discard-draft` dialog after `clickHoisted`                | still closed                                                                                  |
| `showOverlay()` on that element                             | opens it                                                                                      |
| `Apply changes` (same `commandFor` + `--show`, workflow on) | **modal opened**                                                                              |

Apply is the control: an identical `commandFor="apply-draft" command="--show"`
on a hoisted title-bar button opened a modal living in the window's document.
So App Bridge relays `--show` across the `s-app-window` boundary just fine, and
no `showModal` mirroring `hideModal` is needed. (`hideModal` is still needed —
`shopify.modal.hide` resolves ids in the host registry, which is a different
mechanism. The two directions are not symmetric.)

What was actually wrong: `Discard changes` is `disabled={!identified || busy}`,
and `identified` comes from the `ShopAgent` socket handshake. `clickHoisted`
asserted only visibility and then fired a native `el.click()` — a silent no-op
on a disabled button. The window paints fast enough that the spec's click landed
inside that gap; the old in-iframe navigation was slow enough that it did not.
Same silent-no-op failure shape as the Dev Console occlusion above, for an
unrelated reason.

Phases of a fresh editor-window open, from the click on Edit (measured
2026-09-12, local dev, first open then reopen):

| Phase                                     | First  | Reopen  |
| ----------------------------------------- | ------ | ------- |
| Editor document requested                 | 317ms  | 270ms   |
| SSR heading painted                       | 1069ms | 965ms   |
| Hydrated, `Discard changes` proxy visible | 1933ms | ~1600ms |
| `ShopAgent` socket open                   | 2071ms | 1603ms  |
| Identified, proxy enabled                 | 2328ms | 1880ms  |

So the socket is only ~390ms of it and the merchant-visible dead-control window
is that same ~390ms — the rest is the window loading and hydrating a whole
document, and ~860ms of that hydration is Vite's unbundled dev module graph,
which production does not pay. Reopening pays the load again: the window resets
`src` on hide, so nothing is kept warm.

Fixed in `clickHoisted` by polling `hoistedEnabled` before the click, which is
the actionability guarantee an ordinary Playwright `.click()` gives and the
`aria-disabled` ancestor takes away. That made the `expect.poll(() =>
hoistedEnabled(...)).toBe(true)` preambles in the spec redundant; the
`.toBe(false)` assertions stayed, because those assert product behaviour.

## Where it stands

| File                    | Change                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/app.ts`            | `appFrame` excludes `chrome=window`; new `editorFrame`; `closeDevConsole` called from `gotoApp`; `clickHoisted` waits for `hoistedEnabled`. All carry the reasoning above as JSDoc.                                                 |
| `e2e/workflows.spec.ts` | Editor interactions scoped to `editor`; `stepName` for the editor's step forms; `closeEditor` targets the app-window X; Apply-on-an-active-workflow now covered inside the window (it was the one `commandFor` path no test drove). |

Full suite: **14 passed**, `e2e/workflows.spec.ts` 4 passed in 42s.
`pnpm typecheck`, `pnpm lint`, `pnpm fmt` clean.

## Environment notes

- Two runs burned 10 and 15 minutes on a dev server that had stopped hydrating:
  `body[data-hydrated="true"]` never appears, every locator eats its full
  timeout, and one run died with `Protocol error … session closed`. A healthy
  run of this spec is ~42s (the whole suite ~1.6 min). **Restart `pnpm app:dev`
  before concluding anything from a slow run.**
- These specs seed through `/api/dev/seed`, so the shop is left with `E2E *`
  fixtures. `pnpm d1:reset` (plus clearing `.wrangler`) is how to get an empty
  shop back.
- The suite's storage state is decrypted from the real Chrome profile, so admin
  UI state — the Dev Console among it — leaks into runs from whatever that
  browser was last doing.
