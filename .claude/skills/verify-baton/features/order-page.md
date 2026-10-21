# Order page

One order, with a card per item. An item a workflow follows has a run: its steps, each a task for a team, with badges for the run's state. The merchant manages a run behind **Manage**: marks a task `Done`, reopens it, puts back a started task, assigns a team, blocks the run with a reason and notes it.

## Sub-features

- `order-cards` shows a card per item, headed by its title, with the order's note, SKUs and properties.
- `order-manage` opens the run's drawer of step cards with `Manage`.
- `order-done-reopen` marks a ready task `Done`, which shows `<team> · You · …`, and `Reopen` returns it to `Ready`.
- `order-put-back` returns a task a member started to `Ready`.
- `order-assign` opens `s-modal#assign-task` from `Assign team`, on the task's current team.
- `order-block` blocks with a reason (`s-banner[heading="Blocked"]`), and `Unblock` clears it.
- `order-note` adds or edits a run note with `Add note` or `Edit note`.

## How to get to it (user POV)

- Orders index, then an order's `#<n>` link.
- Orders index search by number, then the link.
- A direct `V goto app/orders/<orderId>` needs the id. Reach it from the index instead.

## Driving it with verify.sh

Preconditions:

- A run is open. The dev fixture is loaded. Its order whose note reads `Gift for Sam's wedding on the 14th.` has three items in three states, one of them a started `Engraved cutting board`.
- Find its number first: run `V goto app/orders`, set `Show` to `Open`, and open orders from `#1201` up until the page shows that note. Record the number with `V note`.

- **Open.** From the index, search the number and click `#<n>`. `s-page[heading="#<n>"]` shows. Run `V proof order`.
- **Manage.** Run `V in click "getByRole('button', { name: 'Manage', exact: true })"`. `Step 1` is visible. Before Manage, no `Done` button is visible.
- **Done and Reopen.** Pick a card showing `Ready`. Click its `Done` (`V in click "getByRole('button', { name: 'Done', exact: true }).first()"`). The line `<team> · You · …` appears. Run `V proof done`. Click `Reopen`. The line goes and `Ready` returns. The fixture data is now as it was.
- **Block and Unblock.** Run `V in click "getByRole('button', { name: 'Block', exact: true })"`, fill `getByRole('textbox', { name: 'Reason', exact: true })` in the modal with `Verify <run-id>`, and click the modal's `Block`. The card shows `s-banner[heading="Blocked"]` with the reason. Run `V proof blocked`. Click `Unblock`, and the banner goes.
- **Second view.** After each change, `V goto app/orders`, open the same order again and check the state held. The home strip's `Issues` count rises while the run is blocked and falls back after.

## Gotchas

- Every action is behind `Manage`. A collapsed card offers nothing else to click.
- `Done` buttons repeat per step. Scope to the item's card: `locator('s-section').filter({ has: getByRole('heading', { name: '<item title>', exact: true }) })`.
- `Reopen` is refused when the next step is already done. Pick a task whose next step is not.
- Restore every change (Reopen, Unblock, remove the note) before `V stop`. These are the user's fixture orders.
- An unpaid order has no runs until it is paid, and an order with only a gift card has none at all.
