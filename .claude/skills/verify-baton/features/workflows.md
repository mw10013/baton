# Workflows

A workflow names the steps an item goes through and the team doing each one. It follows the products carrying its tag. The index filters by state (All, Active, Inactive) and searches by name. A workflow's page shows its tasks and banners such as `Needs a team`. The steps are edited in an editor window.

## Sub-features

- `workflows-state` filters by `Active` or `Inactive`, and the filter survives a visit to a workflow page.
- `workflows-search` finds by name, and `Clear search` goes back.
- `workflows-page` shows a workflow's tasks, its tag and its banners.
- `workflows-tag` edits the tag from the page with `Edit tag`. It writes at once, refuses a tag another workflow holds and starts no draft.
- `workflows-create` opens `Create workflow` from the title bar, asks for `Name` and `Tag`, and opens the editor window.
- `workflows-duplicate` copies a workflow under a new name and tag, as inactive.

## How to get to it (user POV)

- App nav **Workflows**.
- `V goto app/workflows`.

## Driving it with verify.sh

Preconditions:

- A run is open. The dev fixture is loaded: `Cut, engrave and oil` is active with tag `engraved-cutting-board`, `Frame and glaze` is inactive, and `Embroider and fold` has a pending draft.

- **State filter.** Run `V goto app/workflows`, then `V in click "getByRole('button', { name: 'Active', exact: true })"`. `Frame and glaze` is not listed, and `Cut, engrave and oil` is. Open it with `V in click "getByRole('link', { name: 'Cut, engrave and oil', exact: true })"`. `s-page[heading="Cut, engrave and oil"]` shows. Return with `V top click "getByRole('button', { name: 'Workflows', exact: true })"`, and the list is still filtered. Run `V proof active`.
- **Search.** Fill `getByRole('searchbox', { name: 'Search', exact: true })` with `glaze` and `V top press Enter`. Only `Frame and glaze` is listed. `Clear search` restores the list.
- **Edit tag, refused.** Open `Cut, engrave and oil`, click `Edit tag`, fill `Tag` with `wall-clock` and `Save`. The field shows `is already Clock assembly's tag` and the dialog stays open. Cancel. Nothing changed.
- **Create.** Run `V goto app/workflows`, then `V top click "getByRole('button', { name: 'Create workflow' })"`. Fill `Name` with `Verify <run-id>` and `Tag` with `verify-<run-id>`, then `Create`. The editor window opens: `V app 'await page.frameLocator(`iframe[src*="chrome=window"]`).locator(`s-page[heading="Verify <run-id>"]`).waitFor(); return 1;'`. Run `V proof editor`.

## Gotchas

- `Create workflow` is in the admin's title bar. Click it with `V top`.
- The editor is a second embedded iframe (`chrome=window`) beside the app's frame. `V in` never reaches it. Close it with the admin's `Close` in the window header, and wait for the iframe to go before clicking `Edit` again.
- After the editor closes, the title bar's `Edit` can read enabled before it works. Retry the click until the editor iframe appears.
- A workflow made under `Verify <run-id>` stays in the store. This map has no proved delete step yet. Report it so the user can remove it, or prove and add the delete path here.
- The tag edit on a fixture workflow writes at once. Change it only to prove the refusal, never to a new value.
