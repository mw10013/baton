import { describe, it } from "@effect/vitest";
import {
  assertFalse,
  assertInstanceOf,
  assertTrue,
  strictEqual,
} from "@effect/vitest/utils";
import { exports as workerExports } from "cloudflare:workers";
import { Effect } from "effect";

import { CurrentRequest } from "@/lib/CurrentRequest";
import { ResponseError, Shopify } from "@/lib/Shopify";
import { APP_BRIDGE_URL, CDN_URL, POLARIS_URL } from "@/lib/shopifyConstants";

import { shopifyTestLayer } from "./shopify-test-layer";

const SHOP = "test.myshopify.com";
const HOST = btoa("admin.shopify.com/store/test").replace(/=+$/u, "");
const APP_BRIDGE_SCRIPT = `<script data-api-key="test_api_key" src="${APP_BRIDGE_URL}"></script>`;

const authenticate = (request: Request) =>
  Effect.gen(function* () {
    const shopify = yield* Shopify;
    const error = yield* shopify.authenticateAdmin.pipe(
      Effect.provideService(CurrentRequest, request),
      Effect.flip,
    );
    assertInstanceOf(error, ResponseError);
    return error.response;
  }).pipe(Effect.provide(shopifyTestLayer()));

const assertMinimalAppBridge = (response: Response, shop?: string) =>
  Effect.gen(function* () {
    strictEqual(response.status, 200);
    strictEqual(response.headers.get("location"), null);
    strictEqual(
      response.headers.get("content-type"),
      "text/html;charset=utf-8",
    );
    assertTrue(
      (yield* Effect.promise(() => response.text())).includes(
        APP_BRIDGE_SCRIPT,
      ),
    );
    if (shop) {
      strictEqual(
        response.headers.get("link"),
        `<${CDN_URL}>; rel="preconnect", <${APP_BRIDGE_URL}>; rel="preload"; as="script", <${POLARIS_URL}>; rel="preload"; as="script"`,
      );
      assertTrue(
        response.headers
          .get("content-security-policy")
          ?.includes(`frame-ancestors https://${shop} `) ?? false,
      );
    }
  });

describe("Shopify.authenticateAdmin document recovery", () => {
  it.effect("renders minimal App Bridge when shop and host are missing", () =>
    Effect.gen(function* () {
      yield* assertMinimalAppBridge(
        yield* authenticate(new Request("https://example.com/app/memory")),
      );
    }),
  );

  it.effect("renders minimal App Bridge when host is missing", () =>
    Effect.gen(function* () {
      yield* assertMinimalAppBridge(
        yield* authenticate(
          new Request(`https://example.com/app/memory?shop=${SHOP}`),
        ),
        SHOP,
      );
    }),
  );

  it.effect("renders minimal App Bridge when host is invalid", () =>
    Effect.gen(function* () {
      yield* assertMinimalAppBridge(
        yield* authenticate(
          new Request(
            `https://example.com/app/memory?shop=${SHOP}&host=${btoa("evil.example")}`,
          ),
        ),
        SHOP,
      );
    }),
  );

  it.effect("recovers when host is base64 but cannot form a URL", () =>
    Effect.gen(function* () {
      yield* assertMinimalAppBridge(
        yield* authenticate(
          new Request(
            `https://example.com/app/memory?shop=${SHOP}&host=${btoa("\u0000")}`,
          ),
        ),
        SHOP,
      );
    }),
  );

  it.effect("does not reflect invalid shop or host into document headers", () =>
    Effect.gen(function* () {
      const response = yield* authenticate(
        new Request(
          "https://example.com/app/memory?shop=evil.example&host=not-base64!",
        ),
      );
      yield* assertMinimalAppBridge(response);
      strictEqual(response.headers.get("link"), null);
      strictEqual(response.headers.get("content-security-policy"), null);
    }),
  );

  it.effect(
    "returns 401 for a headerless TanStack server-function request",
    () =>
      Effect.gen(function* () {
        const response = yield* authenticate(
          new Request("https://example.com/_serverFn/test", {
            headers: { "x-tsr-serverFn": "true" },
          }),
        );
        strictEqual(response.status, 401);
        strictEqual(response.headers.get("location"), null);
        strictEqual(
          response.headers.get("X-Shopify-Retry-Invalid-Session-Request"),
          null,
        );
      }),
  );

  it.effect(
    "skips document guards for a bearer-authenticated server function",
    () =>
      Effect.gen(function* () {
        const response = yield* authenticate(
          new Request("https://example.com/_serverFn/test", {
            headers: {
              authorization: "Bearer invalid",
              "x-tsr-serverFn": "true",
            },
          }),
        );
        strictEqual(response.status, 401);
        strictEqual(
          response.headers.get("X-Shopify-Retry-Invalid-Session-Request"),
          "1",
        );
        assertFalse(
          (yield* Effect.promise(() => response.text())).includes(
            APP_BRIDGE_SCRIPT,
          ),
        );
      }),
  );

  it.effect("keeps normal document embedding behavior with valid context", () =>
    Effect.gen(function* () {
      const response = yield* authenticate(
        new Request(`https://example.com/app?shop=${SHOP}&host=${HOST}`),
      );
      strictEqual(response.status, 302);
      strictEqual(
        new URL(response.headers.get("location") ?? "").href,
        "https://admin.shopify.com/store/test/apps/test_api_key",
      );
    }),
  );
});

describe("Shopify auth routes", () => {
  it.effect(
    "returns minimal App Bridge through the app document boundary",
    () =>
      Effect.gen(function* () {
        yield* assertMinimalAppBridge(
          yield* Effect.promise(() =>
            workerExports.default.fetch(
              new Request("https://example.com/app/memory"),
            ),
          ),
        );
      }),
  );

  it.effect("does not serve a login form at the removed /auth/login path", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        workerExports.default.fetch(
          new Request("https://example.com/auth/login"),
        ),
      );
      const body = yield* Effect.promise(() => response.text());
      strictEqual(response.status, 200);
      assertFalse(body.includes("Shop domain"));
      assertTrue(body.includes(APP_BRIDGE_SCRIPT));
    }),
  );

  it.effect("exits to the Shopify App Pricing page", () =>
    Effect.gen(function* () {
      const destination =
        "https://admin.shopify.com/store/test/charges/baton-test/pricing_plans";
      const response = yield* Effect.promise(() =>
        workerExports.default.fetch(
          new Request(
            `https://example.com/auth/exit-iframe?shop=${SHOP}&exitIframe=${encodeURIComponent(destination)}`,
          ),
        ),
      );
      strictEqual(response.status, 200);
      const body = yield* Effect.promise(() => response.text());
      assertTrue(body.includes(APP_BRIDGE_SCRIPT));
      assertTrue(
        body.includes(`window.open(${JSON.stringify(destination)}, "_top")`),
      );
    }),
  );

  it.effect("rejects untrusted exit-iframe destinations", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        workerExports.default.fetch(
          new Request(
            `https://example.com/auth/exit-iframe?shop=${SHOP}&exitIframe=${encodeURIComponent("https://evil.example/steal")}`,
          ),
        ),
      );
      strictEqual(response.status, 400);
      strictEqual(yield* Effect.promise(() => response.text()), "Bad Request");
    }),
  );

  it.effect("rejects non-pricing Shopify Admin destinations", () =>
    Effect.gen(function* () {
      const destination = "https://admin.shopify.com/store/test/apps/other";
      const response = yield* Effect.promise(() =>
        workerExports.default.fetch(
          new Request(
            `https://example.com/auth/exit-iframe?shop=${SHOP}&exitIframe=${encodeURIComponent(destination)}`,
          ),
        ),
      );
      strictEqual(response.status, 400);
    }),
  );

  it.effect(
    "keeps script terminators encoded in exit-iframe destinations",
    () =>
      Effect.gen(function* () {
        const destination =
          "https://example.com/</script><script>alert(1)</script>";
        const response = yield* Effect.promise(() =>
          workerExports.default.fetch(
            new Request(
              `https://example.com/auth/exit-iframe?shop=${SHOP}&exitIframe=${encodeURIComponent(destination)}`,
            ),
          ),
        );
        strictEqual(response.status, 200);
        const body = yield* Effect.promise(() => response.text());
        assertFalse(body.includes("</script><script>alert(1)</script>"));
        assertTrue(
          body.includes("%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E"),
        );
      }),
  );
});
