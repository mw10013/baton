# Teams

A merchant creates a team, adds members to it, renames it, removes a member and deletes it. The teams index lists every team and searches them by name.

## Sub-features

- `teams-create` creates a team from the index and lands on its page.
- `teams-duplicate` refuses a name another team holds, with a field error.
- `teams-search` finds a team by name and shows `No teams match.` for a miss.
- `teams-members` adds members through `Add members` and removes one with `Remove`.
- `teams-rename` renames through **More actions**, and the new name becomes the heading.
- `teams-delete` deletes through **More actions**, with the `Team deleted` toast.

## How to get to it (user POV)

- App nav **Teams**, then the title bar's **Create team**.
- App nav **Teams**, search, then the team's link.

## Driving it with verify.sh

Preconditions:

- `V doctor` passes and a run is open.
- No team named `Verify <run-id>` or `Verify <run-id> renamed` exists. Names are at most 32 characters, so keep the run id short.
- The store has at least one member to add. The dev fixture has seven, `ana@example.com` among them.

- **Open the index.** Run `V goto app/teams`. The `s-page[heading="Teams"]` shows.
- **Create.** Run `V top click "getByRole('button', { name: 'Create team' })"`, then `V in fill "getByRole('textbox', { name: 'Name', exact: true })" "Verify <run-id>"` and `V in click "getByRole('button', { name: 'Create', exact: true })"`. The page heading becomes `Verify <run-id>` and the page shows `Nobody is on this team`. Run `V proof created`.
- **Duplicate refused.** Run `V top click "getByRole('link', { name: 'Teams', exact: true })"`, then **Create team** again with the same name. `A team with that name already exists.` shows under the field. Choose `Cancel` with `V in click "getByRole('button', { name: 'Cancel' })"`.
- **Search.** Run `V in fill "getByRole('searchbox', { name: 'Search' })" "Verify <run-id>"` and `V top press Enter` (keys go to the focused field, wherever it is). Only the new team's link is listed. Open it with `V in click "getByRole('link', { name: 'Verify <run-id>', exact: true })"`.
- **Add a member.** Run `V in click "getByRole('button', { name: 'Add members' })"`, then `V in check "locator('s-modal#add-team-members').getByRole('checkbox', { name: 'ana@example.com', exact: true })"` and `V in click "locator('s-modal#add-team-members').getByRole('button', { name: 'Add', exact: true })"`. The members table lists `ana@example.com`. Run `V proof member-added`.
- **Rename.** Run `V app 'await frame.locator("s-menu#team-actions s-button", { hasText: "Rename" }).evaluate(el => el.click());'`, fill `Name` with `Verify <run-id> renamed`, then choose `Save`. The heading becomes the new name.
- **Second view.** Run `V goto app/teams`, search for the new name and open it. The heading and `ana@example.com` both persist. Run `V proof persisted`.
- **Remove.** Run `V in click "getByRole('button', { name: 'Remove', exact: true })"`. `Nobody is on this team` returns.
- **Delete.** Run the **More actions** click with `hasText: "Delete"`, then `V in click "locator('s-modal#delete-team').getByRole('button', { name: 'Delete', exact: true })"`. The index shows and the admin shows the toast `Team deleted`. Search for the name again: `No teams match.` Run `V proof deleted`.

## Gotchas

- **Create team** and **More actions** are in the admin's title bar, not the frame. An `in` click on them finds nothing.
- **More actions** never opens a menu Playwright can see. Click the hidden in-frame `s-menu#team-actions` item natively, as above.
- Removing the last member of a team whose step a workflow uses gives that workflow a `Needs a team` banner. Use a team of your own.
- Names are trimmed when saved. Assert the heading, not the value you typed.
