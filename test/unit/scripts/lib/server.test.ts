import { assert, describe, it } from "@effect/vitest";

import { serverParams, tunnelErrorMessage, tunnelServes } from "../../../../scripts/lib/server.ts";
import { e2ePortOf } from "../../../../scripts/lib/worktree.ts";

describe("tunnelServes", () => {
  it("reads Cloudflare's 530 as a tunnel whose cloudflared is gone", () => {
    assert.isFalse(tunnelServes(530));
  });

  it("reads any other status, a redirect or an error included, as the server answering", () => {
    for (const status of [200, 302, 404, 500, 502]) assert.isTrue(tunnelServes(status));
  });
});

describe("tunnelErrorMessage", () => {
  const url = "https://a-b-c.trycloudflare.com";

  it("names public DNS when the lookup half failed", () => {
    assert.strictEqual(
      tunnelErrorMessage({ phase: "resolve", url, lastSeen: "ENOTFOUND", waitedMs: 90_400 }),
      `the tunnel ${url} does not resolve on public DNS after 90s (last: ENOTFOUND)`,
    );
  });

  it("names the answer through the tunnel when the fetch half failed", () => {
    assert.strictEqual(
      tunnelErrorMessage({ phase: "answer", url, lastSeen: "HTTP 530", waitedMs: 61_000 }),
      `the tunnel ${url} resolves but / does not answer through it after 61s (last: HTTP 530)`,
    );
  });
});

describe("serverParams", () => {
  it("keeps the dev server where it was: its store, port, lock, logs, tab and script", () => {
    const dev = serverParams("dev");
    assert.deepStrictEqual(
      [dev.storeVariable, dev.portOf(3900), dev.lock, dev.log, dev.tab, dev.script],
      ["SHOPIFY_DEV_STORE", 3900, ".logs/dev.lock", ".logs/dev/current", "dev", "app:dev"],
    );
  });

  it("puts the e2e server on its own store, port, lock, logs, tab and script", () => {
    const e2e = serverParams("e2e");
    assert.deepStrictEqual(
      [e2e.storeVariable, e2e.portOf(3900), e2e.lock, e2e.log, e2e.tab, e2e.script],
      [
        "SHOPIFY_E2E_STORE",
        e2ePortOf(3900),
        ".logs/e2e.lock",
        ".logs/e2e/current",
        "e2e",
        "e2e:serve",
      ],
    );
  });

  it("shares nothing between the two that would let one find or block the other", () => {
    const [dev, e2e] = [serverParams("dev"), serverParams("e2e")];
    for (const key of ["storeVariable", "lock", "log", "tab", "script"] as const)
      assert.notStrictEqual(dev[key], e2e[key], key);
    assert.notStrictEqual(dev.portOf(3900), e2e.portOf(3900));
  });
});
