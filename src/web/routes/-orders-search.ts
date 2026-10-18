import * as Schema from "effect/Schema";
import { OrdersCursor, OrdersShow, TeamId } from "../../domain/shop-work.ts";
import { lenientSearchKey, ListSearchParam } from "./-search-params.ts";

/**
 * **The merchant's context on the orders index, and it travels.** `q`, `show`, `team` and `after`
 * are on the layout, so every page under it reads them; the index's links to an order and the
 * order page's breadcrumb carry them (`appHref`), so the breadcrumb and the browser's Back land on
 * the filters and the page the merchant left. A nav click drops them (`PAGE_KEYS`), as the
 * workflows layout's do.
 *
 * `?show=` is the main filter (`OrdersShow`; `made` is the packer's queue, `issues` the
 * merchant's, `all` the whole history), and an absent `show` is Making. `?q=` is the search
 * (`searchTerm`): it searches every stored order and the filters are then ignored
 * (`ListOrdersInput`), though they stay in the URL so Clear search returns to them. `?team=` keeps
 * only orders waiting on that team. `?after=` is the page, as the keyset cursor it starts after;
 * an absent `after` is page one. None of the keys has a default value: absence is the default,
 * and the index writes it by leaving the key out.
 *
 * **No value of these keys fails** ({@link lenientSearchKey}): an unreadable value reads as that
 * filter being off, so a stale or hand-edited URL still opens the list. An `after` that is not
 * shaped like a cursor (`OrdersCursor`) is dropped here, so Previous stays off; one that is
 * shaped like a cursor but no longer names a row is the repository's to absorb: its keyset seek
 * lands on the next row.
 */
export const OrdersSearch = Schema.Struct({
  q: lenientSearchKey(ListSearchParam),
  show: lenientSearchKey(OrdersShow),
  team: lenientSearchKey(TeamId),
  after: lenientSearchKey(OrdersCursor),
});

/** {@link OrdersSearch} from a location's parsed search; never fails. */
export const decodeOrdersSearch = Schema.decodeUnknownSync(OrdersSearch);
