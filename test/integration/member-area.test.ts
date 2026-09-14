import { describe, it } from "@effect/vitest";
import { assertFalse, assertTrue, strictEqual } from "@effect/vitest/utils";
import { Effect } from "effect";
import { afterEach } from "vitest";

import { Repository } from "@/lib/Repository";

import {
  emailOf,
  fetchWorker,
  resetMemberTables,
  run,
  seedShop,
  shopOf,
  signInThroughWorker,
} from "./member-fixtures";

const SHOP = shopOf("member-area.myshopify.com");
const OTHER_SHOP = shopOf("other-shop.myshopify.com");
const MEMBER = emailOf("member@example.com");
const ADMIN = emailOf("admin@example.com");

afterEach(async () => {
  await resetMemberTables();
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
   * `200 -> 404 -> 200`, with the `404` being the gate and nothing else. The
   * shop page reads only D1 now — it stopped calling the Shopify Admin API
   * when the member area settled on showing the `myshopify.com` domain rather
   * than the display name — so a healthy render is an ordinary `200` and the
   * middle state is unambiguous.
   */
  it.effect("closes the shop page the moment membership is deleted", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* seedShop(SHOP);
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        const cookie = yield* signInThroughWorker(MEMBER);
        const shopUrl = `http://localhost/shop/${SHOP}`;
        const page = yield* fetchWorker(shopUrl, { headers: { cookie } });
        strictEqual(page.status, 200);
        assertTrue((yield* Effect.promise(() => page.text())).includes(SHOP));
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
        // Re-adding restores; the same session cookie works again.
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        strictEqual(
          (yield* fetchWorker(shopUrl, { headers: { cookie } })).status,
          200,
        );
      }),
    ),
  );
});

describe("member queue", () => {
  /**
   * The queue is `/shop/$shop` itself, the index under the `/shop/$shop`
   * layout, which owns no loader of its own — each child's server fn calls
   * `requireMember` itself. The queue read hits only the Durable Object and
   * renders `200`; the `404` on another shop proves the route is behind the
   * same gate. The work page is a sibling and is gated the same way. The page's own actions are socket callables and are covered
   * against the object in `member-queue-socket.test.ts` and
   * `shop-agent-workflows.test.ts`.
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
          (yield* fetchWorker(`http://localhost/shop/${SHOP}`, {
            headers: { cookie },
          })).status,
          200,
        );
        strictEqual(
          (yield* fetchWorker(`http://localhost/shop/${SHOP}/work/none`, {
            headers: { cookie },
          })).status,
          200,
        );
        strictEqual(
          (yield* fetchWorker(`http://localhost/shop/${OTHER_SHOP}`, {
            headers: { cookie },
          })).status,
          404,
        );
        strictEqual(
          (yield* fetchWorker(`http://localhost/shop/${OTHER_SHOP}/work/none`, {
            headers: { cookie },
          })).status,
          404,
        );
      }),
    ),
  );

  /**
   * A member of a shop whose subscription lapsed is sent to the lapsed page,
   * and only a member: the stranger still gets `404`, because `requireMember`
   * checks membership before the plan so a lapse is never disclosed to someone
   * who does not belong to the shop. The lapsed page itself renders without
   * a loader, so it must not redirect back.
   */
  it.effect("redirects a member of a lapsed shop to the lapsed page", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* seedShop(SHOP);
        yield* repository.updateShopSessionPlan({
          shop: SHOP,
          planHandle: null,
          planHandleExpiresAt: Date.now() + 60 * 60 * 1000,
        });
        yield* repository.addMember({ shop: SHOP, email: MEMBER });
        // A magic link is only minted for someone who is a member somewhere.
        yield* seedShop(OTHER_SHOP);
        const STRANGER = emailOf("stranger@example.com");
        yield* repository.addMember({ shop: OTHER_SHOP, email: STRANGER });
        const cookie = yield* signInThroughWorker(MEMBER);
        const stranger = yield* signInThroughWorker(STRANGER);
        for (const path of [`/shop/${SHOP}`, `/shop/${SHOP}/work/none`]) {
          const response = yield* fetchWorker(`http://localhost${path}`, {
            headers: { cookie },
          });
          strictEqual(response.status, 307);
          strictEqual(response.headers.get("location"), `/shop/${SHOP}/lapsed`);
        }
        strictEqual(
          (yield* fetchWorker(`http://localhost/shop/${SHOP}/lapsed`, {
            headers: { cookie },
          })).status,
          200,
        );
        strictEqual(
          (yield* fetchWorker(`http://localhost/shop/${SHOP}`, {
            headers: { cookie: stranger },
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
  /**
   * One membership lands on that shop's queue; two land on the picker. The
   * picker is a page with one link when there is one shop, and a bench wants
   * the work, not a menu.
   */
  it.effect(
    "sends a one-shop member to their queue and a two-shop member to /shop",
    () =>
      run(
        Effect.gen(function* () {
          const repository = yield* Repository;
          yield* seedShop(SHOP);
          yield* repository.addMember({ shop: SHOP, email: MEMBER });
          const cookie = yield* signInThroughWorker(MEMBER);
          const one = yield* fetchWorker("http://localhost/login-callback", {
            headers: { cookie },
          });
          strictEqual(one.status, 307);
          strictEqual(one.headers.get("location"), `/shop/${SHOP}`);

          yield* seedShop(OTHER_SHOP);
          yield* repository.addMember({ shop: OTHER_SHOP, email: MEMBER });
          const two = yield* fetchWorker("http://localhost/login-callback", {
            headers: { cookie },
          });
          strictEqual(two.status, 307);
          strictEqual(two.headers.get("location"), "/shop");
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
