import { describe, it } from "@effect/vitest";
import { assertFalse, assertTrue, strictEqual } from "@effect/vitest/utils";
import { exports as workerExports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { afterEach } from "vitest";

import { Auth, magicLinkKvKey } from "@/lib/Auth";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { Email } from "@/lib/Email";
import { KV } from "@/lib/KV";
import { makeEnvLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

const envLayer = makeEnvLayer(env);
const repositoryLayer = Layer.provideMerge(
  Repository.layerNoDeps,
  Layer.mergeAll(
    D1Session.layer(env.D1),
    Layer.provide(D1Primary.layerNoDeps, envLayer),
    envLayer,
  ),
);
const kvLayer = Layer.provideMerge(KV.layerNoDeps, envLayer);
const layer = Layer.mergeAll(
  Layer.provideMerge(
    Auth.layerNoDeps,
    Layer.mergeAll(
      kvLayer,
      repositoryLayer,
      Layer.provide(Email.layerNoDeps, envLayer),
      envLayer,
    ),
  ),
  kvLayer,
  repositoryLayer,
);

const run = <A, E>(effect: Effect.Effect<A, E, Auth | KV | Repository>) =>
  effect.pipe(Effect.provide(layer));

const shopOf = Schema.decodeUnknownSync(Domain.Shop);
const emailOf = Schema.decodeUnknownSync(Domain.Email);
const SHOP = shopOf("member-area.myshopify.com");
const OTHER_SHOP = shopOf("other-shop.myshopify.com");
const MEMBER = emailOf("member@example.com");
const ADMIN = emailOf("admin@example.com");

const fetchWorker = (url: string, init?: RequestInit) =>
  Effect.promise(() =>
    workerExports.default.fetch(
      new Request(url, { redirect: "manual", ...init }),
    ),
  );

const seedShop = (shop: Domain.Shop) =>
  Effect.gen(function* () {
    const repository = yield* Repository;
    yield* repository.upsertShopSession({
      shop,
      shopGid: Schema.decodeUnknownSync(Domain.ShopGid)("gid://shopify/Shop/1"),
      shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)(
        `agent-${shop}`,
      ),
      scope: "read_products",
      accessTokenExpiresAt: null,
      accessToken: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
  });

/**
 * The full magic-link hop the way a browser performs it: the link is minted
 * through the `Auth` service (demo mode caches it in KV, exactly as `/login`
 * reads it back), then followed through `workerExports.default.fetch` so the
 * `/api/auth/$` catch-all, its allowlist middleware, and better-auth's verify
 * handler are all on the path — not just the service. Returns the `cookie`
 * header a browser would carry from there on.
 */
const signInThroughWorker = (email: Domain.Email) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const kv = yield* KV;
    yield* auth.signInMagicLink({
      headers: new Headers(),
      email,
      callbackURL: "/login-callback",
    });
    const url = yield* kv.get(magicLinkKvKey(email));
    if (url === null) return yield* Effect.die("magic link not cached in KV");
    const response = yield* fetchWorker(url);
    strictEqual(response.status, 302);
    assertFalse((response.headers.get("location") ?? "").includes("error="));
    return response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
  });

afterEach(async () => {
  await env.D1.batch([
    env.D1.prepare("delete from Session"),
    env.D1.prepare("delete from User"),
    env.D1.prepare("delete from Verification"),
    env.D1.prepare("delete from TeamMember"),
    env.D1.prepare("delete from Team"),
    env.D1.prepare("delete from Member"),
    env.D1.prepare("delete from ShopSession"),
  ]);
});

describe("api.auth allowlist", () => {
  it.effect("serves the magic-link verify endpoint", () =>
    run(
      Effect.gen(function* () {
        const response = yield* fetchWorker(
          "http://localhost/api/auth/magic-link/verify?token=bogus&callbackURL=/login-callback",
        );
        strictEqual(response.status, 302);
        assertTrue((response.headers.get("location") ?? "").includes("error="));
      }),
    ),
  );

  it.effect("404s every other better-auth route", () =>
    run(
      Effect.gen(function* () {
        for (const [method, path] of [
          ["GET", "/api/auth/get-session"],
          ["POST", "/api/auth/sign-in/magic-link"],
          ["POST", "/api/auth/sign-out"],
          ["POST", "/api/auth/admin/list-users"],
          ["POST", "/api/auth/magic-link/verify"],
        ] as const) {
          const response = yield* fetchWorker(`http://localhost${path}`, {
            method,
          });
          strictEqual(
            response.status,
            404,
            `${method} ${path} should be blocked`,
          );
        }
      }),
    ),
  );
});

describe("member area", () => {
  it.effect("redirects an anonymous visitor from /shop to /login", () =>
    run(
      Effect.gen(function* () {
        const response = yield* fetchWorker("http://localhost/shop");
        strictEqual(response.status, 307);
        strictEqual(response.headers.get("location"), "/login");
      }),
    ),
  );

  it.effect("signs a member in and lists their shops on /shop", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* seedShop(SHOP);
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        const cookie = yield* signInThroughWorker(MEMBER);
        const response = yield* fetchWorker("http://localhost/shop", {
          headers: { cookie },
        });
        strictEqual(response.status, 200);
        const body = yield* Effect.promise(() => response.text());
        assertTrue(body.includes(MEMBER));
        assertTrue(body.includes(SHOP));
      }),
    ),
  );

  it.effect("hides a shop the signed-in member has no membership in", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* seedShop(SHOP);
        yield* seedShop(OTHER_SHOP);
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        const cookie = yield* signInThroughWorker(MEMBER);
        const response = yield* fetchWorker(
          `http://localhost/shop/${OTHER_SHOP}`,
          { headers: { cookie } },
        );
        strictEqual(response.status, 404);
      }),
    ),
  );

  /**
   * Revocation is asserted as a status *change*, not as `200 -> 404`: the
   * member's own shop page renders `getShopInfo`, whose Durable Object runs in
   * its own isolate where the in-process Shopify fetch stub cannot reach, so a
   * seeded shop with no real offline token can only reach `500`. What matters
   * — and what only the pre/post pair can show — is that `500` proves the
   * `requireMember` gate was passed before the shop lookup failed, so the
   * later `404` is the gate closing rather than the page having been
   * unreachable all along.
   */
  it.effect("closes the shop page the moment membership is deleted", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* seedShop(SHOP);
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        const cookie = yield* signInThroughWorker(MEMBER);
        const shopUrl = `http://localhost/shop/${SHOP}`;
        strictEqual(
          (yield* fetchWorker(shopUrl, { headers: { cookie } })).status,
          500,
        );
        yield* repository.deleteMember({ shop: SHOP, email: MEMBER });
        strictEqual(
          (yield* fetchWorker(shopUrl, { headers: { cookie } })).status,
          404,
        );
        const listing = yield* fetchWorker("http://localhost/shop", {
          headers: { cookie },
        });
        strictEqual(listing.status, 200);
        assertFalse(
          (yield* Effect.promise(() => listing.text())).includes(SHOP),
        );
      }),
    ),
  );
});

describe("member queue", () => {
  /**
   * `/shop/$shop/queue` is a sibling of the shop index under the `/shop/$shop`
   * layout, which owns no loader of its own — each child's server fn calls
   * `requireMember` itself. So unlike the shop index (whose `getShopInfo`
   * call can only reach `500` here for the reason documented on the
   * revocation test above), the queue read hits only the Durable Object and
   * renders `200`. The `404` on another shop proves the queue route is behind
   * the same gate. Step-level queue behavior is covered against the Durable
   * Object in `shop-agent-workflows.test.ts`.
   */
  it.effect("is gated by membership like the shop page", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* seedShop(SHOP);
        yield* seedShop(OTHER_SHOP);
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        const cookie = yield* signInThroughWorker(MEMBER);
        strictEqual(
          (yield* fetchWorker(`http://localhost/shop/${SHOP}/queue`, {
            headers: { cookie },
          })).status,
          200,
        );
        strictEqual(
          (yield* fetchWorker(`http://localhost/shop/${OTHER_SHOP}/queue`, {
            headers: { cookie },
          })).status,
          404,
        );
      }),
    ),
  );
});

describe("admin console", () => {
  it.effect("redirects an anonymous visitor from /admin to /login", () =>
    run(
      Effect.gen(function* () {
        const response = yield* fetchWorker("http://localhost/admin");
        strictEqual(response.status, 307);
        strictEqual(response.headers.get("location"), "/login");
      }),
    ),
  );

  it.effect("bounces a signed-in member from /admin to /shop", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* seedShop(SHOP);
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        const cookie = yield* signInThroughWorker(MEMBER);
        const response = yield* fetchWorker("http://localhost/admin", {
          headers: { cookie },
        });
        strictEqual(response.status, 307);
        strictEqual(response.headers.get("location"), "/shop");
      }),
    ),
  );

  it.effect(
    "admits an ADMIN_EMAILS user and keeps them off the member area",
    () =>
      run(
        Effect.gen(function* () {
          const cookie = yield* signInThroughWorker(ADMIN);
          const response = yield* fetchWorker("http://localhost/admin", {
            headers: { cookie },
          });
          strictEqual(response.status, 200);
          assertTrue(
            (yield* Effect.promise(() => response.text())).includes("Admin v"),
          );
          const listing = yield* fetchWorker("http://localhost/shop", {
            headers: { cookie },
          });
          strictEqual(listing.status, 307);
          strictEqual(listing.headers.get("location"), "/admin");
        }),
      ),
  );
});

describe("login-callback", () => {
  it.effect("sends a freshly signed-in browser on to /shop", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* seedShop(SHOP);
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        const cookie = yield* signInThroughWorker(MEMBER);
        const response = yield* fetchWorker("http://localhost/login-callback", {
          headers: { cookie },
        });
        strictEqual(response.status, 307);
        strictEqual(response.headers.get("location"), "/shop");
      }),
    ),
  );

  it.effect("sends a freshly signed-in admin on to /admin", () =>
    run(
      Effect.gen(function* () {
        const cookie = yield* signInThroughWorker(ADMIN);
        const response = yield* fetchWorker("http://localhost/login-callback", {
          headers: { cookie },
        });
        strictEqual(response.status, 307);
        strictEqual(response.headers.get("location"), "/admin");
      }),
    ),
  );

  it.effect("renders the failure state for a spent link", () =>
    run(
      Effect.gen(function* () {
        const response = yield* fetchWorker(
          "http://localhost/login-callback?error=INVALID_TOKEN",
        );
        strictEqual(response.status, 200);
        assertTrue(
          (yield* Effect.promise(() => response.text())).includes(
            "invalid or has expired",
          ),
        );
      }),
    ),
  );
});
