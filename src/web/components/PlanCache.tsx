import * as Match from "effect/Match";
import type { AdminShopPlanCache } from "../../domain/billing.ts";
import { Inline } from "./screen/Inline.tsx";

/**
 * The badge for each state of a shop's cached plan entry.
 *
 * | state         | tone     | label         |
 * | ------------- | -------- | ------------- |
 * | Subscribed    | success  | the plan      |
 * | Unsubscribed  | warning  | Unsubscribed  |
 * | Stale         | neutral  | Stale         |
 * | Never fetched | neutral  | Never fetched |
 * | Unrecognized  | critical | Unrecognized  |
 */
const badge = Match.typeTags<
  AdminShopPlanCache,
  {
    readonly tone: "success" | "warning" | "critical" | "neutral";
    readonly label: string;
  }
>()({
  Subscribed: ({ plan }) => ({ tone: "success", label: plan }),
  Unsubscribed: () => ({ tone: "warning", label: "Unsubscribed" }),
  Stale: () => ({ tone: "neutral", label: "Stale" }),
  NeverFetched: () => ({ tone: "neutral", label: "Never fetched" }),
  Unrecognized: () => ({ tone: "critical", label: "Unrecognized" }),
});

const storedHandle = Match.typeTags<AdminShopPlanCache, string | null>()({
  Subscribed: ({ handle }) => handle,
  Unsubscribed: () => null,
  Stale: ({ handle }) => handle,
  NeverFetched: () => null,
  Unrecognized: ({ handle }) => handle,
});

/**
 * A shop's cached plan entry as an admin needs to read it: the tier, or the reason there is no
 * tier, beside the handle exactly as stored.
 *
 * The handle is shown verbatim, including when it decodes to nothing. That is the point of
 * `ShopSession.planHandle` being a plain string rather than the allowlist: a handle this build
 * no longer recognizes reads as a cache miss everywhere else, and this is the one surface that
 * can say which handle it was.
 */
export function PlanCache({ plan }: { readonly plan: AdminShopPlanCache }) {
  const { tone, label } = badge(plan);
  const handle = storedHandle(plan);
  return (
    <Inline>
      <s-badge tone={tone}>{label}</s-badge>
      {handle === null ? null : <s-text>{handle}</s-text>}
    </Inline>
  );
}
