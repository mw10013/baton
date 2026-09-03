import * as React from "react";

import { ClientOnly } from "@tanstack/react-router";

import { useShopAgent } from "@/lib/ShopAgentContext";

/**
 * How long the socket may be unidentified before the banner appears. Every
 * page load and every reconnect starts unidentified and settles well inside
 * this window, so a shorter grace period turns the warning into a flash on
 * each navigation — which is worse than not warning at all, because a banner
 * that cries wolf on every page is one merchants learn to skip.
 */
const GRACE_MS = 4000;

/**
 * The one place the `/app` socket's health is surfaced to merchants.
 *
 * Renders nothing while the socket is healthy, because connected is the
 * expected state and a permanent green badge trains merchants to ignore the
 * one moment it matters. When the socket stays down past `GRACE_MS` the page's
 * writes are disabled and pushes have stopped, so the banner says what that
 * costs rather than just naming the state.
 *
 * Hardcodes `slot="supplemental-start"`, the slot `s-page` renders above its
 * sections. A banner rendered as a plain child instead falls into the flow
 * between sections, and there is no reason for a call site to want that.
 *
 * `ClientOnly` because `identified` is false during SSR — without it every
 * page would ship the warning in its HTML and then hydrate it away.
 */
export function SocketBanner() {
  const { identified } = useShopAgent();
  const [graceElapsed, setGraceElapsed] = React.useState(false);

  React.useEffect(() => {
    if (identified) setGraceElapsed(false);
    const timer = identified
      ? null
      : setTimeout(() => {
          setGraceElapsed(true);
        }, GRACE_MS);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [identified]);

  return (
    <ClientOnly>
      {!identified && graceElapsed && (
        <s-banner slot="supplemental-start" tone="warning">
          Not connected to this shop. Live updates are paused and changes on
          this page are disabled until the connection returns.
        </s-banner>
      )}
    </ClientOnly>
  );
}
