# App Home

The app's landing page in the Shopify admin. It shows a `Getting started` guide until setup is done, the Orders strip of five counts that each link into the orders index, and a capacity meter for each billed dimension.

## Sub-features

- `home-guide` shows `Getting started` with `N of 3 done` while a step is open, and nothing once all three are done.
- `home-strip` shows five cells (`No workflow`, `Not started`, `Making`, `Made`, `Issues`), each a link named `<label>, <count>`.
- `home-strip-link` opens the orders index with that cell chosen (`?show=<value>`).
- `home-meters` shows `progress` meters labelled `Orders this billing cycle` and `Members`.

## How to get to it (user POV)

- Open the app from the admin's Apps list or the **Baton** item in the sidebar.
- `V goto app`.

## Driving it with verify.sh

Preconditions:

- A run is open. The dev fixture is loaded.

- **Open.** Run `V goto app`. `s-section[heading="Orders"]` is visible.
- **Strip.** Run `V app 'return await frame.getByRole("link", { name: /^(No workflow|Not started|Making|Made|Issues), \d+$/ }).evaluateAll(els => els.map(e => e.getAttribute("aria-label")));'`. Five labels come back, in that order. Run `V proof home`.
- **Cell link.** Run `V in click "getByRole('link', { name: /^Issues, \\d+$/ })"`. The URL has `show=issues`, `s-page[heading="Orders"]` shows, and the button `Issues, <n>, selected` is there. Its count matches the home cell's. Run `V proof issues`.
- **Meters.** Run `V goto app`, then `V app 'return await frame.locator("progress[aria-label]").evaluateAll(els => els.map(e => e.getAttribute("aria-label")));'`. Both labels come back.
- **Guide.** Run `V app 'return await frame.locator(`s-section[accessibilityLabel="Getting started"]`).count();'`. With the dev fixture every step is done, so it is `0`. Report it as such. Proving the open guide needs a store where a step is open, which a merchant reaches by deleting every workflow. Do not do that to the dev store.

## Gotchas

- The strip's counts move whenever any order or run changes. Compare a cell with the index it opens in the same run, never with a number from earlier.
- The home cells are links. The orders index's cells are buttons with the same names.
- The guide is not live. It reflects the store at load, so `V goto app` again after a change.
