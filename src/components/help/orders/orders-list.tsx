import { HelpPicture } from "@/components/screen/HelpPicture";
import { Things } from "@/components/screen/Things";

/**
 * Reading the orders list (`orders/orders-list`), a concept page: the counts
 * at the top and the Show menu, the seven positions, a row, the Team menu
 * and the search. Read against `src/routes/app.orders.index.tsx` (`STRIP`, the Show
 * select's `SHOW` order, the Team select with Any team, the search field and
 * its placeholder, the columns Order, Placed, Payment, Status, Issues, Items
 * and Shopify, the Issues cell empty when there is none, the pager, the
 * strip replaced by `SearchLine` under a search, both selects disabled under
 * a search), `OrdersSearch` in `src/routes/app.orders.tsx` (the filters
 * travel to the order page and back), and in `src/lib/domain/ShopWork.ts`:
 * the order positions table in the vocabulary, `OrderPosition`,
 * `orderPosition` and `ORDER_POSITION_LABEL` (Unpaid and No workflow split
 * by payment; No workflow covers an untagged item, a cancelled workflow and
 * a removed item; Not started is an open workflow nobody has touched;
 * Making is a started task or a done workflow beside an open one; Made
 * becomes Fulfilled when Shopify says so), `OrdersShow` and
 * `ORDERS_SHOW_LABEL` (one value at a time, Making the default, All the only
 * value with closed orders), `OrderCounts` (over open orders, following the
 * Team select only), `OrderIssue` and `orderIssues` (one badge per issue,
 * open orders only), `OrderRow.itemUnits`, `ListOrdersInput` (`team`: an
 * open, unblocked workflow whose current task is on the team, a team with no
 * members still matching; `q`: the search ignores Show and Team) and
 * `searchTerm` (an order number matched whole, else the start of a word in
 * the item's title, variant or SKU).
 */
export function OrdersList() {
  return (
    <>
      <s-section heading="The counts at the top and the Show menu">
        <Things>
          <s-paragraph>
            The Orders page lists the orders Baton has from Shopify, each with
            where it stands. Across the top, the counts read{" "}
            <strong>No workflow</strong>, <strong>Not started</strong>,{" "}
            <strong>Making</strong> and <strong>Made</strong>, in the order an
            order moves through them, then <strong>Issues</strong>, which cuts
            across them. Each shows how many orders it has. Press one to list
            those orders.
          </s-paragraph>
          <HelpPicture name="ordersList1" />
          <s-paragraph>
            The page opens on <strong>Making</strong>, the orders members are
            working on now. The <strong>Show</strong> menu under the counts
            holds the same five choices and five more: <strong>Open</strong>,
            every open order, <strong>Unpaid</strong>,{" "}
            <strong>Fulfilled</strong>, <strong>Cancelled</strong> and{" "}
            <strong>All</strong>, every order Baton has, closed ones included.
            These five have no count at the top. The list shows one choice at a
            time, and pressing a count sets the Show menu to it.
          </s-paragraph>
          <s-paragraph>
            The counts at the top cover open orders only. They change with the{" "}
            <strong>Team</strong> menu, not with the Show menu or a search.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="What each position means">
        <Things>
          <s-paragraph>
            Each order is in one position, shown as the badge in its Status
            column.
          </s-paragraph>
          <s-unordered-list>
            <s-list-item>
              <strong>Unpaid</strong>: no item has a workflow yet, and the order
              is not fully paid. A matching workflow starts once it is paid.
            </s-list-item>
            <s-list-item>
              <strong>No workflow</strong>: the order is paid and no item has a
              workflow on it. Its products carry no workflow&apos;s tag, you
              cancelled the workflow, or Shopify removed the item.
            </s-list-item>
            <s-list-item>
              <strong>Not started</strong>: a workflow is on an item and nobody
              has started a task yet. A member can press Start.
            </s-list-item>
            <s-list-item>
              <strong>Making</strong>: a member has started a task, or one
              item&apos;s workflow is done while another&apos;s is still open.
            </s-list-item>
            <s-list-item>
              <strong>Made</strong>: no item&apos;s workflow is open and at
              least one is done, and the order waits for you to fulfill it in
              Shopify.
            </s-list-item>
            <s-list-item>
              <strong>Fulfilled</strong>: Shopify says the order is fulfilled. A
              Made order becomes Fulfilled on its own when you fulfill it in
              Shopify. Nothing in Baton is pressed for it.
            </s-list-item>
            <s-list-item>
              <strong>Cancelled</strong>: the order was cancelled in Shopify.
            </s-list-item>
          </s-unordered-list>
          <s-paragraph>
            An issue is not a position. A blocked order keeps its position, and
            its row shows the issue beside it. The badges on each item are in{" "}
            <s-link href="/help/reference/states-and-badges">Badges</s-link>.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Each row">
        <Things>
          <s-paragraph>
            A row shows the order&apos;s number, which opens its page, the date
            it was placed, a <strong>Paid</strong> or <strong>Unpaid</strong>{" "}
            badge, its position under Status, its issues, and its units under
            Items. The icon at the end opens the order in Shopify.
          </s-paragraph>
          <s-paragraph>
            The Issues column shows one red badge per issue:{" "}
            <strong>Multiple workflows match</strong>,{" "}
            <strong>Needs a team</strong> or <strong>Blocked</strong>. It is
            empty when the order has none. Show <strong>Issues</strong> lists
            every open order with at least one. What each means and how to clear
            it is in{" "}
            <s-link href="/help/orders/fixing-issues">Fixing an issue</s-link>.
          </s-paragraph>
          <HelpPicture name="fixingIssues1" />
          <s-paragraph>
            When the list is longer than one page, the buttons under the table
            go to the next and previous pages. The filters and the page stay
            when you open an order and come back by the <strong>Orders</strong>{" "}
            link at the top of its page.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="The Team menu and search">
        <Things>
          <s-paragraph>
            The <strong>Team</strong> menu reads <strong>Any team</strong> until
            you choose a team. With a team chosen, the list keeps the orders
            waiting on that team: an item&apos;s current task is on the team and
            the item is not blocked. A team with no members still matches, so
            you see the orders it needs a member for. A closed order waits on no
            team, so Fulfilled or Cancelled with a team chosen lists nothing.
          </s-paragraph>
          <s-paragraph>
            To find one order, search by its number, with or without the #, or
            by the start of a word in an item&apos;s title, variant or SKU. A
            search looks through every order Baton has, closed ones too, and
            ignores the Show and Team menus. A line saying how many orders match
            takes the place of the counts at the top. Press{" "}
            <strong>Clear search</strong> to go back to the list you had.
          </s-paragraph>
        </Things>
      </s-section>
    </>
  );
}
