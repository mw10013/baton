import { adminShopPlanCache } from "../../domain/billing.ts";
import type { ShopKey, ShopSessionRedactedPage } from "../../domain/platform.ts";
import type { ListSearch } from "../../domain/shop-work.ts";
import { Presence } from "./AdminShopPage.tsx";
import { LocalDateTime } from "./LocalDateTime.tsx";
import type { PageLink } from "./MembersIndexPage.tsx";
import { PlanCache } from "./PlanCache.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";
import { ListSearchField } from "./screen/ListSearchField.tsx";
import { Token } from "./screen/Token.tsx";
import SignOutButton from "./SignOutButton.tsx";

/** {@link AdminShopsPage}'s props: the loader's page and the route's navigation. */
export interface AdminShopsProps {
  readonly page: ShopSessionRedactedPage;
  /** The read's time, against which every row's cached plan is judged. */
  readonly now: number;
  /** The search in the URL, `null` when absent. */
  readonly filter: ListSearch | null;
  readonly adminLink: PageLink;
  readonly shopLink: (shop: ShopKey) => PageLink;
  readonly onSearch: (next: ListSearch | null) => void;
  readonly onNextPage: (after: ShopKey) => void;
  readonly onPreviousPage: (before: ShopKey) => void;
}

/**
 * The admin console's Shops list: every `ShopSession` row, tokens redacted, with its cached
 * plan, 25 a page either way, searched by shop. The search sits in the table's filters slot.
 */
export default function AdminShopsPage(props: AdminShopsProps) {
  const { page, now, filter } = props;
  return (
    <s-page heading="Shops" inlineSize="large">
      <s-link slot="breadcrumb-actions" {...props.adminLink}>
        Admin
      </s-link>
      <SignOutButton variant="secondary" slot="secondary-actions" leave />
      <IndexSection label="Shops table">
        <s-table
          paginate={page.hasPreviousPage || page.hasNextPage}
          hasPreviousPage={page.hasPreviousPage}
          hasNextPage={page.hasNextPage}
          onPreviousPage={() => {
            const first = page.shopSessions[0];
            if (first !== undefined) props.onPreviousPage(first.shop);
          }}
          onNextPage={() => {
            const last = page.shopSessions.at(-1);
            if (last !== undefined) props.onNextPage(last.shop);
          }}
        >
          <ListSearchField
            slot="filters"
            value={filter}
            placeholder="Search by shop"
            onSubmit={props.onSearch}
          />
          <s-table-header-row>
            <s-table-header listSlot="primary">Shop</s-table-header>
            <s-table-header>Shop actor ID</s-table-header>
            <s-table-header>Shop GID</s-table-header>
            <s-table-header>Scope</s-table-header>
            <s-table-header>Access token expires</s-table-header>
            <s-table-header>Refresh token expires</s-table-header>
            <s-table-header>Plan</s-table-header>
            <s-table-header>Plan expires</s-table-header>
            <s-table-header>Access token</s-table-header>
            <s-table-header>Refresh token</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {page.shopSessions.map((shopSession) => (
              <s-table-row key={shopSession.shop} id={shopSession.shop}>
                <s-table-cell>
                  <Token link={props.shopLink(shopSession.shop)}>{shopSession.shop}</Token>
                </s-table-cell>
                <s-table-cell>{shopSession.shopActorId}</s-table-cell>
                <s-table-cell>{shopSession.shopGid}</s-table-cell>
                <s-table-cell>{shopSession.scope ?? ""}</s-table-cell>
                <s-table-cell>
                  {shopSession.accessTokenExpiresAt === null ? null : (
                    <LocalDateTime value={shopSession.accessTokenExpiresAt} />
                  )}
                </s-table-cell>
                <s-table-cell>
                  {shopSession.refreshTokenExpiresAt === null ? null : (
                    <LocalDateTime value={shopSession.refreshTokenExpiresAt} />
                  )}
                </s-table-cell>
                <s-table-cell>
                  <PlanCache plan={adminShopPlanCache(shopSession, now)} />
                </s-table-cell>
                <s-table-cell>
                  {shopSession.planHandleExpiresAt === null ? null : (
                    <LocalDateTime value={shopSession.planHandleExpiresAt} />
                  )}
                </s-table-cell>
                <s-table-cell>
                  <Presence present={shopSession.hasAccessToken} />
                </s-table-cell>
                <s-table-cell>
                  <Presence present={shopSession.hasRefreshToken} />
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </IndexSection>
      {page.shopSessions.length === 0 && <s-banner tone="info">No sessions.</s-banner>}
    </s-page>
  );
}
