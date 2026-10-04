import { describe, expect, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { reconnectAfterClose } from "@/lib/ShopAgentSocketHost";

/**
 * The tab's rows of the connection table on `Domain.ConnectionRole`. The
 * decision alone: the reconnect itself is the SDK's, and the e2e "removing
 * a member closes the shop page on their live session" proves it end to end.
 */
describe("ShopAgentSocketHost", () => {
  it("the tab reconnects on 4401 and not on 4403", () => {
    expect(reconnectAfterClose(Domain.CONNECTION_CLOSE_REVOKED)).toBe(true);
    expect(reconnectAfterClose(Domain.CONNECTION_CLOSE_FORBIDDEN)).toBe(false);
  });
});
