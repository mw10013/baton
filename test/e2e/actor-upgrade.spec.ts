import * as Schema from "effect/Schema";
import http from "node:http";
import { ShopKey } from "../../src/contract/shop.ts";
import { CONNECTION_CLOSE_NOT_A_MEMBER } from "../../src/contract/shop-actor.ts";
import { awaitHydration, expect, ownMember, test } from "./fixtures.ts";
import { memberShop } from "./screens.ts";
import { E2E_SHOP } from "./shop-fixture.ts";

test.use({ storageState: "playwright/.auth/member.json" });

/**
 * Whether a WebSocket upgrade with the given headers opens. A browser cannot set `Origin`, and
 * Node's fetch refuses an `upgrade` header, so the handshake goes through node:http. Under
 * `alchemy dev` a refused upgrade reaches the client as a dropped connection, not as its status
 * (the 403 does not survive the dev server), so only open or not is observable.
 */
const upgradeOpens = (url: string, headers: Record<string, string>) =>
  new Promise<boolean>((resolve) => {
    const request = http.get(url, {
      headers: {
        ...headers,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(false);
    });
    request.on("upgrade", (_, socket) => {
      socket.destroy();
      resolve(true);
    });
    request.on("error", () => resolve(false));
  });

test("an upgrade from another site is refused, and the same one from this site opens", async ({
  baseURL,
  context,
}) => {
  if (baseURL === undefined) throw new Error("use.baseURL is not set");
  const url = new URL(`/api/actor/${E2E_SHOP}`, baseURL);
  const cookie = (await context.cookies(url.toString()))
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

  expect(await upgradeOpens(url.toString(), { cookie, origin: "https://evil.example" })).toBe(
    false,
  );
  expect(await upgradeOpens(url.toString(), { cookie, origin: url.origin })).toBe(true);
});

test("a visitor who is not a member sees the not-a-member page, and the gate closes its socket with 4404", async ({
  backend,
  browser,
}) => {
  // An own member is a member of the e2e store only; this shop has no rows at all, which the
  // gate answers as it answers a non-member.
  const { context, page } = await ownMember(browser, backend, "not-a-member");
  const otherShop = Schema.decodeUnknownSync(ShopKey)("no-such-shop.myshopify.com");
  await page.goto(`/shop/${otherShop}`);
  await awaitHydration(page);
  await expect(memberShop(page).noAccess).toBeVisible();
  await expect(memberShop(page).workflows).toHaveCount(0);

  const code = await page.evaluate(
    (path) =>
      new Promise<number>((resolve) => {
        const url = new URL(path, window.location.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        new WebSocket(url).addEventListener("close", (event) => resolve(event.code));
      }),
    `/api/actor/${otherShop}`,
  );
  expect(code).toBe(CONNECTION_CLOSE_NOT_A_MEMBER);
  await context.close();
});
