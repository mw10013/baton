import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { ManagePlanButton } from "@/components/ManagePlanButton";
import { QuotaBanners } from "@/components/QuotaBanners";
import { FootLine } from "@/components/screen/FootLine";
import { Inline } from "@/components/screen/Inline";
import { MeterTile } from "@/components/screen/MeterTile";
import {
  SetupGuide,
  type SetupGuideStep,
} from "@/components/screen/SetupGuide";
import { Strip } from "@/components/screen/Strip";
import { Things } from "@/components/screen/Things";
import { Tiles } from "@/components/screen/Tiles";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { findHelpPage, findHelpSection } from "@/lib/helpPages";
import {
  decodeOrdersIndexData,
  ORDERS_ARRIVAL_INPUT,
  ORDERS_STRIP,
  ordersQueryKey,
} from "@/lib/ordersIndexQuery";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { entitlementsOfStatus, SubscriptionPlan } from "@/lib/SubscriptionPlan";
import { useLiveQuery } from "@/lib/useLiveQuery";

/**
 * The entitlements come from the resolved {@link Domain.PlanStatus} rather
 * than from route context for the reason `resolveEntitlements` documents: this
 * loader is isomorphic, and taking the tier from context would mean the browser
 * naming it on every in-app navigation.
 */
interface AppIndexLoaderData {
  readonly entitlements: Domain.Entitlements;
  readonly usage: Domain.ShopUsage;
  /** `Member` rows in D1, against `Entitlements.membersIncluded`. */
  readonly memberCount: number;
  /** The guide's three facts, D1's and the object's together ({@link Domain.SetupFacts}). */
  readonly setupFacts: Domain.SetupFacts;
  /** The orders index's arrival read ({@link ORDERS_ARRIVAL_INPUT}), whose counts the strip shows. */
  readonly orders: Domain.OrdersIndexData;
}

/**
 * The home page's reads, in one request and in parallel: the plan status,
 * the shop's usage, the member count, the setup facts (D1's and the
 * object's), and the orders index's arrival read for the strip.
 *
 * The split is the design. The *entitlement* comes from the plan resolved
 * from the handle cached on the shop's D1 session row. The *order count*
 * comes from the shop's Durable Object, which meters usage and knows nothing
 * about plans. The *member count* and the first setup fact come from D1,
 * where members and teams live; the other two setup facts and the strip's
 * counts come from the object. Nothing compares them but this page and the
 * banners it renders.
 *
 * The plan is resolved server-side rather than read from `/app` route
 * context, even though `beforeLoad` already has it: this loader is
 * isomorphic and runs in the browser on every in-app navigation, so taking it
 * from context would mean the browser supplying its own tier on most page
 * views. The entitlements come off the status through
 * `entitlementsOfStatus`, rather than paying `resolveEntitlements` a second
 * read of the same row.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(
          session.shop,
        );
        const client = yield* ShopAgentClient;
        const repository = yield* Repository;
        const reads = yield* Effect.all(
          {
            status: (yield* SubscriptionPlan).resolve(shop),
            usage: client.getUsage(session.shop),
            memberCount: repository.countMembers(shop),
            teamWithMember: repository.teamWithMemberExists(shop),
            workflowSetupFacts: client.getWorkflowSetupFacts(session.shop),
            orders: client.listOrders(session.shop, ORDERS_ARRIVAL_INPUT),
          },
          { concurrency: "unbounded" },
        );
        return {
          entitlements: yield* entitlementsOfStatus(shop, reads.status),
          usage: reads.usage,
          memberCount: reads.memberCount,
          setupFacts: {
            teamWithMember: reads.teamWithMember,
            ...reads.workflowSetupFacts,
          },
          orders: reads.orders,
        } satisfies AppIndexLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/app/")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

/** The Getting started help pages, by slug: the guide's help links are their titles. */
const GETTING_STARTED = findHelpSection("getting-started");

/**
 * A help page as a {@link SetupGuideStep}'s help link: its title, and its
 * path. The help tree is static, so a slug it lacks is a typo here, and
 * `help-pages.test.ts` holds the tree.
 */
const helpLink = (slug: string) => {
  const page =
    GETTING_STARTED === undefined
      ? undefined
      : findHelpPage(GETTING_STARTED, slug);
  return {
    label: page?.title ?? slug,
    href: `/help/getting-started/${slug}`,
  };
};

/** Each step's words and links, by its fact. */
const STEP_COPY = {
  teamWithMember: {
    sentence: "Create a team and add a member",
    link: { label: "Teams", href: "/app/teams" },
    help: helpLink("first-team"),
  },
  activeWorkflow: {
    sentence: "Create a workflow and turn it on",
    link: { label: "Workflows", href: "/app/workflows" },
    help: helpLink("first-workflow"),
  },
  run: {
    sentence: "An item gets a workflow",
    body: "New orders arrive as they are placed.",
    help: helpLink("first-order"),
  },
} as const satisfies Record<
  Domain.SetupFact,
  Pick<SetupGuideStep, "sentence" | "body" | "link" | "help">
>;

/**
 * The setup guide's steps, one per {@link Domain.SETUP_FACTS} fact, in its
 * order. Each step's sentence is the `line` slot and the third's "New orders
 * arrive as they are placed." its `body` (the copy table on `CopySlot`). A
 * step's way out is a link named for the screen where it is done (the `link`
 * slot: the target screen's heading), not a button, because the create
 * modals open in-page and have no URL to send a merchant to; the third has
 * none, for the reason on {@link Domain.SetupFacts}.
 */
const setupSteps = (facts: Domain.SetupFacts): readonly SetupGuideStep[] =>
  Domain.SETUP_FACTS.map((fact) => {
    const done = Domain.setupFactHolds(facts, fact);
    return {
      key: fact,
      done,
      state: done ? "Done" : "Not done",
      ...STEP_COPY[fact],
    };
  });

/**
 * The home page answers four questions, top to bottom: is Baton set up,
 * does anything need me, where do I stand on my plan, where do I learn
 * more. The quota banners come first, since they are the one alarm.
 *
 * **Set up.** The setup guide, while any of its facts does not hold. It is
 * derived and stores nothing, it comes back when a fact stops holding, and
 * its third step has no action here: the rules are on
 * {@link Domain.SetupFacts}, and {@link Domain.setupIsComplete} hides it. It
 * is read by the loader only: the first two facts change by the merchant's
 * own writes on other screens, and the loader runs again when they come back
 * here; the third changes by webhook once in a shop's life, which is not
 * worth a read on every invalidation.
 *
 * **Needs me.** The orders strip, as links: the orders index's five cells,
 * labels and counts, each a link to the orders index with that value
 * chosen, so "Making 34" here lands on a list under a cell that says
 * "Making 34". It is live, refreshed over the socket like the orders index,
 * and it costs nothing extra: it reads `listOrders` with the orders index's
 * arrival input, so the two share one memo entry in the object and one
 * cache entry here (the rule on {@link ORDERS_ARRIVAL_INPUT}). The rows of
 * that page are read for the memo entry anyway and ignored here.
 *
 * **Plan.** Nothing here names a plan. A tier's name is Shopify's to change
 * in the Partner Dashboard without a deploy, and the meters state what the
 * merchant actually has — the numbers the app enforces — which is the same
 * information without a string to keep in sync. Manage plan is one click
 * from every one of them.
 *
 * The banners above the sections are the states that need a *remedy* named
 * ({@link QuotaBanners}). The steady-state numbers are not banners: the meters
 * carry them, and a banner that is present on the ordinary day is a banner
 * nobody reads on the bad one.
 *
 * The Members tile shows today's member count, not the seats billed this cycle
 * (`Domain.ShopUsage.seatsThisCycle`). The two differ only after a member
 * is removed during the cycle: the member count drops and the seats do not. The
 * members are what the merchant manages from the tile, so it stays the number.
 *
 * **Learn.** The foot line, and the guide's help links while it shows. No
 * primary action, no help cards and no paragraph: after setup there is no
 * one thing a merchant does from here, and how Baton works is a help page.
 */
function RouteComponent() {
  const {
    entitlements,
    usage,
    memberCount,
    setupFacts,
    orders: initialOrders,
  } = Route.useLoaderData();
  const { managePlanUrl, shop } = Route.useRouteContext();
  const router = useRouter();

  const { data } = useLiveQuery({
    queryKey: ordersQueryKey(shop, ORDERS_ARRIVAL_INPUT),
    read: (stub) =>
      stub.listOrders(ORDERS_ARRIVAL_INPUT).then(decodeOrdersIndexData),
    initialData: initialOrders,
  });

  const steps = setupSteps(setupFacts);
  const doneCount = steps.filter(({ done }) => done).length;

  const membersOverBy = memberCount - entitlements.membersIncluded;
  const ordersOverBy = usage.ordersThisCycle - entitlements.ordersPerCycle;

  /**
   * The orders tile's line: how far over and what that costs, then when the
   * cycle resets; a cycle the object has not been told about yet has no end
   * to name. Nothing when under and unknown: no sentence explains the
   * product beside its number (the copy table's body row on `CopySlot`).
   */
  const ordersDetail =
    ordersOverBy > 0 || usage.cycleEndAt !== null ? (
      <>
        {ordersOverBy > 0 &&
          `${formatNumber(ordersOverBy)} over. Extra orders are billed at your plan's rate. `}
        {usage.cycleEndAt !== null && (
          <>
            Resets <LocalDateTime value={usage.cycleEndAt} />.
          </>
        )}
      </>
    ) : undefined;

  return (
    <s-page heading="Baton" inlineSize="large">
      {/* The strip is live, so a dropped socket means its counts are stale;
          the banner says so, as it does on the orders index. */}
      <SocketBanner />
      <QuotaBanners usage={usage} />
      {!Domain.setupIsComplete(setupFacts) && (
        <SetupGuide
          heading="Getting started"
          /* The `count` slot; three is `Domain.SETUP_FACTS`. */
          count={`${formatNumber(doneCount)} of 3 done`}
          steps={steps}
        />
      )}
      <s-section heading="Orders">
        {/* Each cell a link to the orders index with its value chosen;
            Making is the default there, so its link has no `show`. */}
        <Strip
          cells={ORDERS_STRIP.map((key) => ({
            key,
            label: Domain.ORDERS_SHOW_LABEL[key],
            count: data.page.counts[key],
            href: router.buildLocation({
              to: "/app/orders",
              search: key === "making" ? {} : { show: key },
            }).href,
          }))}
        />
      </s-section>
      <s-section heading="Usage and capacity">
        <Things>
          <Tiles>
            {/* Used against included, in that order: the number a merchant is
                looking for is what they have spent, not what they were sold. */}
            <MeterTile
              heading="Orders this billing cycle"
              href="/app/orders"
              headline={`${formatNumber(usage.ordersThisCycle)} of ${formatNumber(entitlements.ordersPerCycle)} included`}
              count={usage.ordersThisCycle}
              limit={entitlements.ordersPerCycle}
              {...(ordersDetail === undefined ? {} : { detail: ordersDetail })}
            />
            <MeterTile
              heading="Members"
              href="/app/members"
              headline={`${formatNumber(memberCount)} ${memberCount === 1 ? "member" : "members"}, ${formatNumber(entitlements.membersIncluded)} included`}
              count={memberCount}
              limit={entitlements.membersIncluded}
              {...(membersOverBy > 0
                ? {
                    detail: `${formatNumber(membersOverBy)} past your plan's included seats ${membersOverBy === 1 ? "is" : "are"} billed at your plan's rate.`,
                  }
                : {})}
            />
          </Tiles>
          <Inline>
            <ManagePlanButton url={managePlanUrl} />
          </Inline>
        </Things>
      </s-section>
      <FootLine>
        Learn more in{" "}
        <s-link href="/help" target="_blank">
          Help
        </s-link>
        .
      </FootLine>
    </s-page>
  );
}
