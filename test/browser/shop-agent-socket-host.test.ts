import { isTerminalCloseEvent } from "agents/client";
import { describe, expect, it } from "vitest";

import * as Domain from "@/lib/Domain";

/**
 * The tab's row of the connection table on `Domain.ConnectionRole`. The
 * decision is the SDK's: whether it treats the close as terminal, which
 * stops partysocket's reconnect. The e2e "removing a member closes the shop
 * page on their live session" proves the reconnect end to end.
 */
const close = (code: number) => new CloseEvent("close", { code });

describe("ShopAgentSocketHost", () => {
  it("the tab reconnects on 3401 and not on 4403", () => {
    expect(isTerminalCloseEvent(close(Domain.CONNECTION_CLOSE_REVOKED))).toBe(
      false,
    );
    expect(isTerminalCloseEvent(close(Domain.CONNECTION_CLOSE_FORBIDDEN))).toBe(
      true,
    );
  });
});
