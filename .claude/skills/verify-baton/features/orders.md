# Orders index

The merchant's list of orders, filtered by where each order's work stands. A strip of five counts at the top doubles as the main filter. A `Show` select, a `Team` select and a search by order number narrow it. It pages 25 at a time. Title-bar actions sync orders from Shopify.

## Sub-features

- `orders-strip` shows the five cells as buttons named `<label>, <count>`, the chosen one ending `, selected`.
- `orders-show` filters with the `Show` combobox. The default is `Making`. `Open` shows every open order.
- `orders-team` filters with the `Team` combobox, and the strip's counts follow the team.
- `orders-search` finds an order by number across every filter, and `Clear search` goes back.
- `orders-paging` pages with `Go to next page` and `Go to previous page`, and the page survives opening an order and coming back.
- `orders-shopify-link` gives each row a link `Open #<n> in Shopify`.
- `orders-sync` brings open orders in with `Sync open orders` in the title bar.

## How to get to it (user POV)

- App nav **Orders** (the one under Baton, not the admin's own).
- A cell of the home page's strip.
- `V goto app/orders`.

## Driving it with verify.sh

Preconditions:

- A run is open. The dev fixture is loaded, so more than 25 orders are open and `#1201` and up exist.

- **Open.** Run `V goto app/orders`. `s-page[heading="Orders"]` shows, the URL has no `show=`, and the `Making, <n>, selected` button is there.
- **Strip as filter.** Run `V in click "getByRole('button', { name: /^Issues, \\d+$/ })"`. The URL takes `show=issues`. Read back the rows: `V app 'return { show: new URL(page.url()).searchParams.get("show"), rows: await frame.locator("s-table-row").count() };'`. The row count equals the Issues count when it is 25 or fewer. Run `V proof issues`.
- **Show.** Run `V in select "getByRole('combobox', { name: 'Show', exact: true })" "Open"`. The URL takes `show=open`, and no strip cell ends `, selected`.
- **Team.** Run `V in select "getByRole('combobox', { name: 'Team', exact: true })" "Engraving"`. The URL takes a `team=` and the strip's counts change to Engraving's.
- **Search.** Run `V in fill "getByRole('searchbox', { name: 'Search', exact: true })" "1201"` and `V top press Enter`. The link `#1201` is listed. Run `V in click "getByRole('button', { name: 'Clear search', exact: true })"`, and the filtered list returns.
- **Paging.** With `Show` on `Open` and no team, wait for the table to finish loading (`V app 'await frame.locator("s-table:not([loading])").waitFor(); return 1;'`), then `V in click "getByRole('button', { name: 'Go to next page', exact: true })"`. The URL takes `after=` and the rows change. Open one row's order link, then come back with the admin's breadcrumb `V top click "getByRole('button', { name: 'Orders', exact: true })"`. The URL keeps `show`, `team` and `after`. Run `V proof page-two`.

## Gotchas

- The admin's own sidebar has an Orders link. The app's is the one whose `href` contains `/apps/`.
- While `s-table` is loading, Polaris keeps the paging buttons enabled but ignores a press. Wait for it to finish first.
- Change a filter only after the URL has taken the previous one. A select changed before the navigation commits writes the old value back.
- A bad `show` or `team` value in the URL reads as no filter, by design.
- `Sync open orders` writes from Shopify into Baton's database. It changes counts, so take any count you compare after it.
