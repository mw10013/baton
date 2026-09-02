import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { resolveEntitlements } from "@/lib/SubscriptionPlan";

/**
 * The skeleton's one merchant-facing page. It exists to show every seam of the
 * stack carrying real data, so each section below is a proof rather than a
 * feature:
 *
 * - **Shop** — the Durable Object called the Shopify Admin API with the shop's
 *   offline session out of D1.
 * - **Counter** — the Durable Object read and wrote its own private SQLite, and
 *   the write reached every open tab over the shared WebSocket.
 * - **Plan** — D1's cached plan handle resolved to an entitlement (granted
 *   unconditionally while `BILLING_ENABLED` is off).
 *
 * Delete the sections, keep the wiring.
 *
 * The plan is resolved server-side rather than read from `/app` route context,
 * even though `beforeLoad` already has it: this loader is isomorphic and runs
 * in the browser on every in-app navigation, so taking it from context would
 * mean the browser supplying its own tier on most page views.
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
        return yield* Effect.all(
          {
            entitlements: resolveEntitlements(shop),
            counter: client.getCounter(shop),
            shopInfo: client.getShopInfo(shop),
          },
          { concurrency: "unbounded" },
        );
      }),
    ),
  );

export const Route = createFileRoute("/app/")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

const counterQueryKey = (shop: string) => ["counter", shop] as const;

const decodeCounter = Schema.decodeUnknownPromise(Domain.Counter);

/**
 * Server pushes are untrusted bytes on a shared socket: the `/app` subtree may
 * one day carry more than one message type, and a malformed frame must not
 * throw inside an event listener. Anything that is not exactly an
 * `AgentMessage` decodes to `Option.none()` and is ignored.
 */
const decodeAgentMessage = (data: string) => {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  })();
  return Schema.decodeUnknownOption(Domain.AgentMessage)(parsed, {
    onExcessProperty: "error",
  });
};

/**
 * Home on the poke → invalidate → refetch model.
 *
 * One query per shop holds the counter. Its query function is
 * `activateCounter`, which both fetches and (re)registers this connection's
 * server-side attachment — so every refetch is also a (re)subscription. See
 * `ShopAgent.activateCounter` for the `activate<Feature>` convention. The route loader seeds it via
 * `initialData` for the SSR paint; `staleTime: Infinity` makes WebSocket pokes
 * (and the explicit invalidation on identify) the only refetch triggers.
 * `gcTime` matches Router's 30-minute route cache so a retained loader match
 * never outlives its Query data.
 *
 * `sessionToken` is a per-mount UUID stored in the connection attachment. The
 * socket is shared by the whole `/app` subtree and outlives this route, so a
 * stale `deactivate` from a previous mount must not clear a newer mount's
 * attachment; the token makes deactivate calls mount-scoped.
 *
 * `deactivate` is deferred by one task and canceled if the effect sets up
 * again. TanStack Start's development client uses React Strict Mode, whose
 * setup → cleanup → setup probe would otherwise detach the attachment created
 * by the first `activateCounter`. A real route unmount has no following setup, so its
 * deferred deactivate still runs.
 *
 * `agent` is `null` until the socket host first commits — on a fresh document
 * load this route can render before the host ever has (see
 * `ShopAgentContext.tsx`). No dedicated UI for that window: `identified` is
 * `false` whenever `agent` is `null`, so actions are already disabled and the
 * badge already reads "Connecting". Each remaining touch point guards
 * individually.
 *
 * Pokes are not throttled here because one merchant bumping a counter cannot
 * produce a burst. A real write path that can — a webhook fan-out, a bulk job —
 * wants a leading + trailing throttle around the invalidate, because
 * `invalidateQueries` defaults to `cancelRefetch: true` while a Durable Object
 * RPC cannot be aborted, so N pokes would run N activations and discard N−1.
 *
 * The status badge uses `ClientOnly` because Polaris upgrades and hoists
 * `s-page` slot children before React hydrates them. Omitting it from the SSR
 * hydration tree prevents Polaris's DOM mutations from causing a mismatch.
 */
function RouteComponent() {
  const { counter, entitlements, shopInfo } = Route.useLoaderData();
  const { shop, plan, managePlanUrl } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const shopify = useAppBridge();
  const { agent, identified } = useShopAgent();
  const agentRef = React.useRef(agent);
  agentRef.current = agent;
  const sessionTokenRef = React.useRef<string | null>(null);
  sessionTokenRef.current ??= crypto.randomUUID();
  const sessionToken = sessionTokenRef.current;
  const deactivateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [bumping, setBumping] = React.useState(false);

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- agent.stub is the stable per-shop socket and sessionToken is mount-scoped connection metadata; the cache identity is the shop (the loader seeds the same key)
  const counterQuery = useQuery({
    queryKey: counterQueryKey(shop),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    queryFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.activateCounter({ sessionToken }),
          ).then(decodeCounter)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    enabled: identified,
    initialData: counter,
  });

  /**
   * A reconnect creates a fresh server connection with no attachment, so pokes
   * stop until `activateCounter` runs again. Every identify (initial connect and
   * reconnect) invalidates the query, which refetches and thereby re-registers
   * the attachment. `cancelRefetch: false` reuses an activation already started
   * by mounting instead of executing a second unabortable Durable Object RPC.
   */
  React.useEffect(() => {
    if (identified)
      void queryClient.invalidateQueries(
        { queryKey: counterQueryKey(shop) },
        { cancelRefetch: false },
      );
  }, [identified, queryClient, shop]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      if (Option.isNone(decodeAgentMessage(event.data))) return;
      void queryClient.invalidateQueries({ queryKey: counterQueryKey(shop) });
    };
    agent?.addEventListener("message", onMessage);
    return () => {
      agent?.removeEventListener("message", onMessage);
    };
  }, [agent, queryClient, shop]);

  React.useEffect(() => {
    if (deactivateTimerRef.current) {
      clearTimeout(deactivateTimerRef.current);
      deactivateTimerRef.current = null;
    }
    return () => {
      deactivateTimerRef.current = setTimeout(() => {
        deactivateTimerRef.current = null;
        const closing = agentRef.current;
        /**
         * Best-effort, deliberately outside `withSocketRecovery`: the
         * attachment being closed is connection-scoped, so any failure mode
         * (timeout, close, zombie socket) means the old connection — and with
         * it the attachment — is already gone or going server-side, and
         * reconnecting the shared `/app` socket from a route the user just left
         * would be pure churn. The rejection is consumed so a timeout on a
         * zombie socket cannot surface as an unhandled promise rejection.
         */
        if (closing?.identified)
          void closing.stub.deactivate({ sessionToken }).catch(() => null);
      }, 0);
    };
  }, [sessionToken]);

  const bump = () => {
    if (!agent) return;
    setBumping(true);
    withSocketRecovery(agent)(() => agent.stub.bump())
      .then(decodeCounter)
      .then((next) => {
        queryClient.setQueryData(counterQueryKey(shop), next);
      })
      .catch((error: unknown) => {
        shopify.toast.show(
          error instanceof Error
            ? error.message
            : "Could not bump the counter.",
          { isError: true },
        );
      })
      .finally(() => {
        setBumping(false);
      });
  };

  const { count, updatedAt } = counterQuery.data;

  return (
    <s-page heading="Baton" inlineSize="large">
      <ClientOnly>
        <s-badge slot="header-actions" tone={identified ? "success" : "info"}>
          {identified ? "Connected" : "Connecting"}
        </s-badge>
      </ClientOnly>

      <s-section
        heading="Durable Object counter"
        accessibilityLabel="Durable Object counter"
      >
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Stored in this shop&apos;s Durable Object SQLite. Bumping it
            broadcasts over the WebSocket, so every open tab for this shop
            updates without a reload.
          </s-paragraph>
          <s-heading>{formatNumber(count)}</s-heading>
          <s-paragraph color="subdued">
            {updatedAt === null
              ? "Never bumped"
              : `Last bumped ${new Date(updatedAt).toLocaleString()}`}
          </s-paragraph>
          <s-stack alignItems="start">
            <s-button
              variant="primary"
              loading={bumping}
              disabled={!identified || bumping}
              onClick={bump}
            >
              Bump
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Shop" accessibilityLabel="Shop">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Read from the Shopify Admin API by the Durable Object, using the
            offline session stored in D1.
          </s-paragraph>
          <s-heading>{shopInfo.name}</s-heading>
          <s-paragraph>{shopInfo.myshopifyDomain}</s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Plan" accessibilityLabel="Plan">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Resolved from the plan handle cached on the shop&apos;s D1 session.
            Billing is disabled, so every shop is granted the widest tier.
          </s-paragraph>
          <s-heading>{plan}</s-heading>
          <s-paragraph>{`Daily action limit: ${formatNumber(entitlements.dailyActionLimit)}`}</s-paragraph>
          <s-stack alignItems="start">
            <s-button
              variant="secondary"
              onClick={() => {
                window.open(managePlanUrl, "_top");
              }}
            >
              Manage plan
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
