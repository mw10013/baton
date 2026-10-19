import { assert, describe, it } from "@effect/vitest";

import { tunnelErrorMessage, tunnelServes } from "../../../../scripts/lib/server.ts";

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
