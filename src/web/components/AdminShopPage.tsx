import * as Match from "effect/Match";
import { type ReactNode, useState } from "react";
import type { AdminShopData } from "../../contract/admin.ts";
import { formatNumber, ShopLimits, type ShopKey } from "../../domain/platform.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import type { PageLink } from "./MembersIndexPage.tsx";
import { PlanCache } from "./PlanCache.tsx";
import { Inline } from "./screen/Inline.tsx";
import { Lines } from "./screen/Lines.tsx";
import { Things } from "./screen/Things.tsx";
import { Tiles } from "./screen/Tiles.tsx";
import { Token } from "./screen/Token.tsx";
import SignOutButton from "./SignOutButton.tsx";

/** Refresh plan's banner when the failure carries no message of its own. */
export const REFRESH_PLAN_FAILED = "Could not refresh the plan from Shopify.";

/** {@link AdminShopPage}'s props: the loader's data and the route's navigation. */
export interface AdminShopProps {
  readonly shop: ShopKey;
  readonly data: AdminShopData;
  readonly shopsLink: PageLink;
  /**
   * Refresh plan's press: the POST, then the loader re-read. Answers `null` once the new plan is
   * in hand, else the banner's sentence.
   */
  readonly onRefresh: () => Promise<string | null>;
}

/** A label over its value, "—" when the value is empty. */
function Field({
  label,
  value,
  children,
}: {
  readonly label: string;
  readonly value?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <Lines>
      <s-text tone="neutral">{label}</s-text>
      {children ?? (
        <Token>{value === null || value === undefined || value === "" ? "—" : value}</Token>
      )}
    </Lines>
  );
}

/** A timestamp field's value, `null` (shown as "—") when there is none. */
const at = (value: number | null) => (value === null ? null : <LocalDateTime value={value} />);

/** A token's presence, never the token: the redacted read projected it away in D1. */
export function Presence({ present }: { readonly present: boolean }) {
  return (
    <s-badge tone={present ? "success" : "critical"}>{present ? "Present" : "Missing"}</s-badge>
  );
}

/**
 * The admin console's shop page, point in time. Nothing here is live: an admin has no socket,
 * and an admin looking at a shop is not a reason to open a connection on it.
 */
export default function AdminShopPage(props: AdminShopProps) {
  return (
    <s-page heading={props.shop} inlineSize="large">
      <s-link slot="breadcrumb-actions" {...props.shopsLink}>
        Shops
      </s-link>
      <SignOutButton variant="secondary" slot="secondary-actions" leave />
      {Match.value(props.data).pipe(
        Match.tagsExhaustive({
          NotFound: () => (
            <s-banner tone="warning" heading="No session">
              No stored session for this shop. Uninstall deletes the row, so the app is not
              installed here.
            </s-banner>
          ),
          Found: (found) => <FoundShop data={found} onRefresh={props.onRefresh} />,
        }),
      )}
    </s-page>
  );
}

function FoundShop({
  data: { shopSession, plan, entitlements, usage, memberCount },
  onRefresh,
}: {
  readonly data: Extract<AdminShopData, { readonly _tag: "Found" }>;
  readonly onRefresh: () => Promise<string | null>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = () => {
    setRefreshError(null);
    setRefreshing(true);
    void onRefresh()
      .then(setRefreshError, () => {
        setRefreshError(REFRESH_PLAN_FAILED);
      })
      .finally(() => {
        setRefreshing(false);
      });
  };
  const ofIncluded = (used: number, included: number | undefined) =>
    `${formatNumber(used)} of ${included === undefined ? "—" : formatNumber(included)}`;
  return (
    <>
      {refreshError !== null && <s-banner tone="critical">{refreshError}</s-banner>}

      <s-section heading="Plan" accessibilityLabel="Cached plan entry">
        <Things>
          <Tiles>
            <Field label="Cached plan">
              <PlanCache plan={plan} />
            </Field>
            <Field label="Fresh until" value={at(shopSession.planHandleExpiresAt)} />
            <Field
              label="Orders this billing cycle"
              value={ofIncluded(usage.ordersThisCycle, entitlements?.ordersPerCycle)}
            />
            <Field
              label="Billing cycle"
              value={
                usage.cycleStartAt === null ? null : (
                  <>
                    <LocalDateTime value={usage.cycleStartAt} />
                    {" – "}
                    {usage.cycleEndAt === null ? (
                      "open"
                    ) : (
                      <LocalDateTime value={usage.cycleEndAt} />
                    )}
                  </>
                )
              }
            />
            <Field label="Plan boundary" value={at(shopSession.planBoundaryAt)} />
            {/* Non-zero for long is a queue that is not draining: an admin's signal
                (`ShopUsage.pendingUsageEvents`). */}
            <Field label="Usage events pending" value={formatNumber(usage.pendingUsageEvents)} />
            <Field label="Orders limited" value={at(usage.ordersLimitedAt)} />
            <Field label="Members" value={ofIncluded(memberCount, entitlements?.membersIncluded)} />
            <Field label="Members high-water" value={formatNumber(usage.seatsThisCycle)} />
            {/* One decimal, not a rounded integer: a healthy shop sits well under a megabyte,
                and "0 MB" reads as "not measured". */}
            <Field
              label="Database size"
              value={`${(usage.databaseSize / 1_000_000).toFixed(1)} MB`}
            />
            {/* The ceiling's quantity against the ceiling: the admin's signal for a shop
                approaching it (`openOrdersAtCeiling`), beside the storage it drives. */}
            <Field
              label="Open orders"
              value={`${formatNumber(usage.openOrders)} of ${formatNumber(ShopLimits.maxOpenOrders)}`}
            />
            <Field label="Last retention sweep" value={at(usage.lastSweepAt)} />
          </Tiles>
          <Lines>
            <Inline>
              <s-button variant="secondary" loading={refreshing} onClick={refresh}>
                Refresh plan
              </s-button>
            </Inline>
            <s-paragraph color="subdued">
              Asks Shopify for the current app subscription and rewrites the cache. Use it when a
              merchant reports a subscription change that has not taken effect.
            </s-paragraph>
          </Lines>
        </Things>
      </s-section>

      <s-section heading="Shopify session" accessibilityLabel="Stored Shopify session">
        <Tiles>
          <Field label="Shop GID" value={shopSession.shopGid} />
          <Field label="Scope" value={shopSession.scope} />
          <Field label="Shop actor ID" value={shopSession.shopActorId} />
          <Field label="Access token expires" value={at(shopSession.accessTokenExpiresAt)} />
          <Field label="Refresh token expires" value={at(shopSession.refreshTokenExpiresAt)} />
          <Field label="Access token">
            <Presence present={shopSession.hasAccessToken} />
          </Field>
          <Field label="Refresh token">
            <Presence present={shopSession.hasRefreshToken} />
          </Field>
        </Tiles>
      </s-section>
    </>
  );
}
