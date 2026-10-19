import type { WebSocket } from "playwright/test";

import { storageStatePath } from "../../../playwright.config.ts";
import { expect, test } from "../fixtures.ts";
import { gotoApp } from "./app.ts";

/**
 * One socket per tab: the `/app` layout holds the merchant's socket, so moving between the App
 * Home and Orders inside the admin keeps the one it opened. The way back is the App nav's Home: its
 * item in the admin's chrome is the app's own name (`rel="home"` hides a Home entry), and its click
 * reaches the `/app` layout's `shopify:navigate` bridge, a navigation in the same document, as the
 * Orders link is. Not `history.back()`: in the admin that moves the admin's own history, and App
 * Bridge loads the frame afresh, a new document and so a new socket. The way forward again is the
 * App Home's Orders link. `page.on("websocket")` sees the app frame's sockets.
 */
test("Orders, the App Home and Orders again share one socket", async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStatePath });
  try {
    const page = await context.newPage();
    const sockets: Array<WebSocket> = [];
    page.on("websocket", (socket) => {
      if (socket.url().includes("/api/actor/")) sockets.push(socket);
    });
    const frame = await gotoApp(page);
    const orders = frame.locator('s-page[heading="Orders"]');
    const home = frame.getByRole("link", { name: "Orders", exact: true });

    await home.click();
    await expect(orders).toBeVisible();
    await expect.poll(() => sockets.length).toBeGreaterThan(0);

    // The App nav's Home: the app's item in the admin's nav, the one that carries an `appLoadId`.
    await page.locator('a[href*="appLoadId"]', { hasText: /^Baton/u }).click();
    await expect(home).toBeVisible();
    // Past the client's 400 ms idle release, so a socket held by the page alone would be gone.
    await page.waitForTimeout(1_500);

    await home.click();
    await expect(orders).toBeVisible();
    await page.waitForTimeout(1_500);

    expect(sockets.map((socket) => socket.url().replace(/\?.*$/u, ""))).toHaveLength(1);
    expect(sockets.filter((socket) => socket.isClosed())).toHaveLength(0);
  } finally {
    await context.close();
  }
});
