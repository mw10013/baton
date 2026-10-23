import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  connectionStateAtom,
  lostAtom,
  merchantExpiredAtom,
  reconnectAtom,
  uninstalledAtom,
} from "../client/actor-connection.ts";

/** The copy for a socket a newer window displaced. */
const DISPLACED = "Signed in elsewhere. Reconnect to keep working here.";
/** The copy for a socket down past the grace (`lostAtom`). */
const LOST =
  "Baton lost its connection. This page won't update, and you can't make changes until it reconnects.";
const UNINSTALLED = "Baton was uninstalled from this shop.";
const EXPIRED = "Your Shopify session expired.";

/**
 * The one place the shop socket's health shows, rendered by the socket
 * holder above every page it holds the socket for. Nothing while the socket is healthy, because
 * connected is the expected state and a permanent badge trains people to ignore the one moment
 * it matters. Displaced (a newer window took a member's last socket) at once, with Reconnect,
 * because the socket will not come back on its own; Reconnect opens a new socket, which displaces
 * the other window in its turn. Lost only after `lostAtom`'s grace, since every load and
 * reconnect starts down and settles well inside it, and a banner that flashes on each navigation
 * is one people learn to skip; its copy says what being down costs.
 *
 * For a merchant it also says when the socket ended for good: the shop uninstalled Baton, or the
 * Shopify session token is no longer accepted. A member's token never expires, and an uninstall
 * reruns the member shop layout's loader instead (`membershipChangedAtom`), which then answers
 * "No access", so the member banner leaves both to it.
 *
 * Each sentence is the banner's `heading`: Polaris puts `role="alert"` on an element inside its
 * shadow root, and only the heading is rendered inside it.
 */
export function SocketBanner({ merchant }: { readonly merchant: boolean }) {
  const connection = useAtomValue(connectionStateAtom);
  const lost = useAtomValue(lostAtom);
  const uninstalled = useAtomValue(uninstalledAtom);
  const expired = useAtomValue(merchantExpiredAtom);
  const reconnect = useAtomSet(reconnectAtom);
  if (merchant && uninstalled) return <s-banner tone="critical" heading={UNINSTALLED} />;
  if (merchant && expired) return <s-banner tone="critical" heading={EXPIRED} />;
  if (connection === "displaced")
    return (
      <s-banner tone="warning" heading={DISPLACED}>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          onClick={() => reconnect((n) => n + 1)}
        >
          Reconnect
        </s-button>
      </s-banner>
    );
  if (connection === "lost" && lost) return <s-banner tone="warning" heading={LOST} />;
  return null;
}
