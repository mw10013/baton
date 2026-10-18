import { createFileRoute, useLocation } from "@tanstack/react-router";
import { formatNumber } from "../../domain/platform.ts";
import {
  type OrdersIndexData,
  ORDERS_SHOW_LABEL,
  SETUP_FACTS,
  type SetupFact,
  type SetupFacts,
  setupFactHolds,
  setupIsComplete,
} from "../../domain/shop-work.ts";
import {
  merchantOrdersAtom,
  ORDERS_ARRIVAL_INPUT,
  ORDERS_STRIP,
  seedOrders,
} from "../client/shop-actor-client.ts";
import { useLiveRead } from "../components/live-read.ts";
import { useNavigateOnClick } from "../components/navigate.ts";
import { Lines } from "../components/screen/Lines.tsx";
import { SetupGuide, type SetupGuideStep } from "../components/screen/SetupGuide.tsx";
import { Strip } from "../components/screen/Strip.tsx";
import { setupFacts } from "../server/home.ts";
import { listOrders } from "../server/orders.ts";
import { appHref, appSearch } from "./-app-search.ts";

/** Each step's words and the screen where it is done, by its fact; the paths are bare. */
const STEP_COPY = {
  teamWithMember: {
    sentence: "Create a team and add a member",
    link: { label: "Teams", path: "/app/teams" },
  },
  activeWorkflow: {
    sentence: "Create a workflow and turn it on",
    link: { label: "Workflows", path: "/app/workflows" },
  },
  run: {
    sentence: "An item gets a workflow",
    body: "New orders arrive as they are placed.",
  },
} as const satisfies Record<
  SetupFact,
  {
    readonly sentence: string;
    readonly body?: string;
    readonly link?: { readonly label: string; readonly path: string };
  }
>;

/**
 * The setup guide's steps, one per `SETUP_FACTS` fact, in its order. Each step's sentence is the
 * `line` slot and the third's "New orders arrive as they are placed." its `body`. A step's way
 * out is a link named for the screen where it is done (the `link` slot: the target screen's
 * heading), not a button, because the create modals open in-page and have no URL to send a
 * merchant to; the third has none, for the reason on `SetupFacts`. The help links wait for the
 * help pages.
 */
const setupSteps = (
  facts: SetupFacts,
  link: (path: string) => { readonly href: string; readonly onClick: (event: Event) => void },
): readonly SetupGuideStep[] =>
  SETUP_FACTS.map((fact) => {
    const done = setupFactHolds(facts, fact);
    const copy: (typeof STEP_COPY)[SetupFact] = STEP_COPY[fact];
    return {
      key: fact,
      done,
      state: done ? "Done" : "Not done",
      sentence: copy.sentence,
      ...("body" in copy ? { body: copy.body } : {}),
      ...("link" in copy ? { link: { label: copy.link.label, ...link(copy.link.path) } } : {}),
    };
  });

/**
 * The orders strip, as links: the orders index's five cells, labels and counts, each a link to
 * the orders index with that value chosen (Making, the default there, with no `show`), so
 * "Making 34" here lands on a list under a cell that says "Making 34". Live, refreshed over the
 * socket like the orders index, and it costs nothing extra: it reads `listOrders` with the index's
 * arrival input, so the two share one memo entry in the actor and one atom node here
 * ({@link ORDERS_ARRIVAL_INPUT}). The rows of that page are read for the memo entry anyway and
 * ignored here.
 */
function OrdersStrip({ orders }: { readonly orders: OrdersIndexData }) {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const navigate = useNavigateOnClick();
  const read = useLiveRead({
    atom: merchantOrdersAtom(ORDERS_ARRIVAL_INPUT),
    key: "arrival",
    loaded: orders,
    seed: (registry, data) => {
      seedOrders(registry, { input: ORDERS_ARRIVAL_INPUT, data });
    },
  });
  return (
    <Strip
      cells={ORDERS_STRIP.map((key) => ({
        key,
        label: ORDERS_SHOW_LABEL[key],
        count: read.value.page.counts[key],
        ...navigate(appHref("/app/orders", searchStr, key === "making" ? {} : { show: key })),
      }))}
    />
  );
}

/**
 * The App Home: the setup guide while any of its facts does not hold (legacy's "is Baton set
 * up"), the Orders strip ({@link OrdersStrip}), then the ways to Orders, Teams and Members. The
 * guide is derived and stores nothing, it comes back when a fact stops holding, and it is read by
 * the loader only: the first two facts change by the merchant's own writes on other screens, and
 * the loader runs again when they come back here. The links keep the raw search Shopify sent,
 * because the `/app` guards read it on every navigation ({@link appHref}). The strip is live, so
 * the socket holder's banner above every page says when its counts are stale.
 */
export const Route = createFileRoute("/app/")({
  loader: async ({ location }) => {
    const idToken = appSearch(location.searchStr).id_token;
    const [facts, orders] = await Promise.all([
      setupFacts({ data: { idToken } }),
      listOrders({ data: { idToken, ...ORDERS_ARRIVAL_INPUT } }),
    ]);
    return { facts, orders };
  },
  component: function AppHome() {
    const { shop } = Route.useRouteContext();
    const { facts, orders } = Route.useLoaderData();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const navigate = useNavigateOnClick();
    const steps = setupSteps(facts, (path) => navigate(appHref(path, searchStr)));
    const doneCount = steps.filter(({ done }) => done).length;
    return (
      <s-page heading="Baton">
        {!setupIsComplete(facts) && (
          <SetupGuide
            heading="Getting started"
            // The `count` slot; three is `SETUP_FACTS`.
            count={`${formatNumber(doneCount)} of 3 done`}
            steps={steps}
          />
        )}
        <s-section heading="Orders">
          <OrdersStrip orders={orders} />
        </s-section>
        <s-section heading={shop}>
          <Lines>
            <s-link {...navigate(appHref("/app/orders", searchStr))}>Orders</s-link>
            <s-link {...navigate(appHref("/app/teams", searchStr))}>Teams</s-link>
            <s-link {...navigate(appHref("/app/members", searchStr))}>Members</s-link>
          </Lines>
        </s-section>
      </s-page>
    );
  },
});
