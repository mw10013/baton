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
 * The one place a page's `ShopAgent` socket health is surfaced — to merchants
 * on `/app` and to members on `/shop/$shop`, whose run actions have no
 * transport but this socket.
 *
 * Renders nothing while the socket is healthy, because connected is the
 * expected state and a permanent green badge trains people to ignore the one
 * moment it matters. When the socket stays down past `GRACE_MS` the page's
 * writes are disabled and invalidations have stopped, so the banner says what that
 * costs rather than just naming the state.
 *
 * Hardcodes `slot="supplemental-start"`, the slot `s-page` renders above its
 * sections. A banner rendered as a plain child instead falls into the flow
 * between sections, and there is no reason for a call site to want that.
 *
 * `ClientOnly` because `identified` is false during SSR — without it every
 * page would ship the warning in its HTML and then hydrate it away.
 *
 * A displaced socket (`displaced`, a `Domain.CONNECTION_CLOSE_DISPLACED`
 * close: the member opened Baton on another screen past
 * `Domain.ShopLimits.maxConnectionsPerMember`) gets its own banner at once,
 * with no grace period, because the socket will not come back on its own.
 * The banner slot of the copy table on `CopySlot` (`src/lib/Screen.ts`)
 * holds its copy. Only a member is displaced; a merchant's socket never
 * receives the code.
 */
export function SocketBanner() {
  const { identified, displaced } = useShopAgent();
  return <ClientOnly>{bannerOf({ identified, displaced })}</ClientOnly>;
}

function bannerOf({
  identified,
  displaced,
}: {
  readonly identified: boolean;
  readonly displaced: boolean;
}) {
  if (identified) return null;
  if (displaced) return <DisplacedBanner />;
  return <DisconnectedBanner />;
}

/**
 * Reconnect opens a new socket, which displaces the member's other screen in
 * its turn: newest wins, whichever screen the person is at.
 */
function DisplacedBanner() {
  const { agent } = useShopAgent();
  return (
    <s-banner slot="supplemental-start" tone="warning">
      Signed in elsewhere. Reconnect to keep working here.
      <s-button
        slot="secondary-actions"
        onClick={() => {
          agent?.reconnect();
        }}
      >
        Reconnect
      </s-button>
    </s-banner>
  );
}

/**
 * Mounted for exactly as long as the socket is down, so the grace period is
 * the component's own lifetime: a reconnect unmounts it and a later drop
 * mounts a fresh one that waits out `GRACE_MS` again. Holding the elapsed
 * flag in `SocketBanner` instead would mean resetting it whenever `identified`
 * flipped back — state kept alive past the condition it describes, and a
 * second render to correct it every time the socket recovers.
 */
function DisconnectedBanner() {
  const [graceElapsed, setGraceElapsed] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setGraceElapsed(true);
    }, GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, []);

  if (!graceElapsed) return null;
  return (
    <s-banner slot="supplemental-start" tone="warning">
      Baton lost its connection. This page won&apos;t update, and you can&apos;t
      make changes until it reconnects.
    </s-banner>
  );
}
