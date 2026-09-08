# Workflow product tag editor research

Researched 2026-09-07. Scope: inspect the existing Baton editor, exercise Shopify Flow's tag dialog, and recommend a Polaris web component design. No application code changed.

## Recommendation

Replace the always-visible add field in the trigger card with a compact **Product tags** summary and a text-labeled **Manage tags** button. Open an `s-modal` containing an add field and clearly removable selected tags. Save the complete selection to the workflow draft; retain the page's existing **Apply changes** step before it affects production routing.

The immediate removal bug is a component mismatch: Baton renders `s-chip` with `removable` and `onRemove`, but `s-chip` is static. Removal belongs to `s-clickable-chip`. The handler already computes the remaining tags and calls the existing mutation; there is no visible button to invoke it. Confirmed in the live editor: the tag has no remove button, and the accessibility tree exposes “Remove workflow-01” as static text.

## What Flow actually does

Inspected the supplied [Flow workflow](https://admin.shopify.com/store/sandbox-shop-01/apps/flow/overview/01a07082-bf17-73f8-9a7e-f64547510ecb) in Chrome MCP.

- The overview shows a compact `Tags:` row, chips, and a pencil button.
- The centered dialog is titled `Manage tags for "Tag orders that include specific products"`.
- **Add tags** contains a text input, a `0/100` character counter, and an adjacent **Add** button. The placeholder gives comma-separated examples: `inventory, fulfillment, loyalty`.
- **Selected** contains checked checkbox rows with a subdued background; **Available** contains unchecked rows.
- There is a header close button and no Save/Cancel footer.
- Unchecking `inventory` started a loading state, removed it from Selected, and updated the overview behind the dialog. In this test it also disappeared from Available; do not assume deselected tags always remain available.
- Typing `inventory` and clicking Add restored it to Selected and to the overview, and cleared the field. The original selection (`orders`, `inventory`) was restored, with `sidekick` still available. Closed the dialog afterward.

Observed behavior supports immediate persistence per action. Reload persistence, duplicate handling, comma parsing, keyboard submission, and the source of the Available list were not independently tested. The placeholder alone does not prove parsing behavior.

These Flow tags organize workflows. They are not the product tags used by a workflow condition or an Add product tags action. Borrow the interaction layout while preserving Baton's routing semantics.

Screenshots of both the Baton editor and Flow dialog were captured and inspected in the conversation. Chrome MCP denied writing the PNG into this repository because its configured workspace roots did not include the requested path, so no screenshot files accompany this document.

## Baton findings

Sources: [workflow editor](../src/routes/app.workflows.$workflowId_.edit.tsx), [WorkflowRepository](../src/lib/WorkflowRepository.ts), [Domain](../src/lib/Domain.ts), and [workflowShared](../src/lib/workflowShared.ts).

- The trigger card repeats tags in its explanatory sentence and as chips, then keeps a full-width entry field visible. This makes configuration occupy the workflow canvas even when the merchant is editing steps.
- `tagsMutation` calls `updateWorkflowTags({ workflowId, tags })`. The repository ensures a draft and replaces its tag array in a transaction. This already supports adding and removing tags without a new backend operation.
- The page separately calls `applyDraft`. Tag dialog changes must not bypass that boundary.
- Domain normalization trims, lowercases, removes blanks, and deduplicates. Limits are 20 tags and 255 characters per normalized tag. Flow's displayed 100-character input limit is not Baton's rule.
- Empty tags are representable; the existing trigger copy explains that nothing starts without tags. Removing the last tag must remain possible and show this state clearly.

## Proposed interaction

1. Keep the trigger card in the flow with the heading **Product tags**, concise matching copy (“Items with any of these product tags enter this workflow”), wrapping static chips, and **Manage tags**. Preserve the existing activation-date explanation where relevant. Empty state: “No product tags selected. This workflow won't start.”
2. Open **Manage product tags** with a local working selection initialized from the current draft, or published tags when no draft exists. Explain: “Choose which product tags match this workflow. This does not change tags on your Shopify products.”
3. Show **Add a product tag**, an example placeholder, and **Add**. Support Enter. Start with one tag per entry, matching today's input behavior; comma-separated bulk input should be an explicit later choice rather than an accidental parser change.
4. Show selected values as `s-clickable-chip removable` with accessible removal names. Removal is local until saved. Keep values readable, allow wrapping, and make errors visible next to the field. Disable Add for blank or normalized duplicate input; use domain validation for length/count limits.
5. Footer: **Cancel** and **Save to draft**. Save sends the full normalized array through the existing mutation once. Show loading, prevent duplicate submission, preserve the selection on failure, and close only after success. A no-op session should not create a draft.
6. Keep **Apply changes** as the only publication action. Do not add a product-tag deletion API: removing a match value from Baton must never delete that tag from Shopify products.

The checkbox Selected/Available pattern becomes worthwhile when there is a real searchable catalog of shop product tags. The current editor accepts free text and does not load such a catalog. For the first implementation, removable chips provide complete functionality without an invented Available list. If suggestions are added, inspect the Admin API source, scopes, pagination, and loading/error behavior as a separate implementation concern; allow manually entered tags that are not yet on a product.

## Polaris and App Bridge choice

| Need                               | Component / behavior                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Compact read-only tags on canvas   | `s-chip`                                                                                         |
| Remove selected tags inside dialog | `s-clickable-chip removable`, `remove` event                                                     |
| Manage button                      | `s-button` targeting the modal ID with `commandFor` and `command="--show"`                       |
| Dialog                             | `s-modal` with heading and standard padding                                                      |
| Add field and action               | `s-text-field`, `s-button`, Polaris stack/grid layout                                            |
| Future catalog selection           | `s-checkbox` rows or a multiple-selection `s-choice-list`; verify events/types when implementing |
| Save / cancel footer               | `primary-action` / `secondary-actions` slots                                                     |

Shopify recommends Polaris modal for ordinary dialogs. Its current App Bridge app-window component is for fullscreen workflows loaded from another app route; that is unnecessary for this editor. The legacy `ui-modal` documentation URL currently redirects to app-window. Use the current Polaris component rather than introducing another route or a separate modal framework.

Existing [polarisModal helpers](../src/lib/polarisModal.ts) document an important implementation constraint: dragging from a field onto the backdrop can dismiss the dialog, and the undocumented dirty guard cannot prevent every host-side dismissal. Reuse the established backdrop guard, but do not rely on `dirty` as a public API guarantee. Preserve unsaved local selection across an unexpected close and offer to resume it on reopening; only explicit Cancel discards it. Exercise Escape, close, backdrop clicks, and cross-iframe drag releases in the embedded admin.

## Implementation verification

- Add and remove a tag, including removal of the last tag; verify the draft after reopening and reloading.
- Verify Cancel and a no-op dialog create no draft; verify Save to draft leaves published routing unchanged until Apply changes.
- Verify whitespace/case duplicates, the 20-tag limit, the 255-character limit, and server errors without losing input.
- Verify keyboard Add/removal, focus return, long tag wrapping, and narrow layouts in the embedded admin.
- Verify unexpected dismissal retains pending edits and overlapping mutations cannot restore stale selections.
- Run repository formatting, typecheck, and lint after implementation; add focused draft-persistence coverage where existing tests support it.

## References

Local references inspected:

- [Polaris chip](../refs/shopify-docs/docs/api/app-home/latest/web-components/typography-and-content/chip.md)
- [Polaris clickable chip](../refs/shopify-docs/docs/api/app-home/latest/web-components/actions/clickable-chip.md)
- [Polaris modal](../refs/shopify-docs/docs/api/app-home/latest/web-components/overlays/modal.md)
- [App Bridge app window](../refs/shopify-docs/docs/api/app-home/latest/app-bridge-web-components/app-window.md)

Current official pages checked against those references:

- [Clickable chip](https://shopify.dev/docs/api/app-home/latest/web-components/actions/clickable-chip)
- [Modal](https://shopify.dev/docs/api/app-home/latest/web-components/overlays/modal)
- [App window](https://shopify.dev/docs/api/app-home/latest/app-bridge-web-components/app-window)
