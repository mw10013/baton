import { describe, it } from "@effect/vitest";
import { strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env, exports as workerExports } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { afterEach, expect } from "vitest";

import * as Domain from "@/lib/Domain";
import { Repository } from "@/lib/Repository";

import {
  emailOf,
  resetMemberTables,
  run,
  seedShop,
  shopOf,
  signInThroughWorker,
  teamNameOf,
} from "./member-fixtures";

/**
 * The Worker's WebSocket connect gate, end to end: a real upgrade through the
 * worker entry, then the identity it forwarded read back off the live
 * connection inside the Durable Object. Asserting the object's state rather
 * than the forwarded headers is deliberate — the headers are an implementation
 * detail of the hop, while `connection.state` is what every callable actually
 * authorizes against.
 *
 * A merchant token needs no Partner API: `SubscriptionPlan.resolve` serves a
 * `ShopSession` whose cached `planHandle` has not expired, so seeding one makes
 * the subscription check cheap and hermetic.
 */
const MEMBER = emailOf("gate-member@example.com");
const STRANGER = emailOf("gate-stranger@example.com");
const ADMIN = emailOf("admin@example.com");

const seedSubscribedShop = seedShop;

const base64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const encodeSegment = (value: unknown) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

/**
 * An App Bridge ID token the way Shopify mints one: HS256 over the app's API
 * secret, `aud` the API key, `dest` the shop. The test config supplies both
 * (`test_api_secret` / `test_api_key`), so the gate's `decodeSessionToken` is
 * exercised for real rather than stubbed.
 */
const mintSessionToken = async (shop: string) => {
  const now = Math.floor(Date.now() / 1000);
  const body = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment({
    iss: `https://${shop}/admin`,
    dest: `https://${shop}`,
    aud: "test_api_key",
    sub: "42",
    exp: now + 60,
    nbf: now - 10,
    iat: now,
    jti: crypto.randomUUID(),
    sid: "session-id",
  })}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test_api_secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${base64Url(new Uint8Array(signature))}`;
};

const upgrade = (url: string, headers: Record<string, string>) =>
  Effect.promise(() =>
    workerExports.default.fetch(
      new Request(url, { headers: { Upgrade: "websocket", ...headers } }),
    ),
  );

const connectionStatesOf = (shop: string) =>
  Effect.promise(() =>
    runInDurableObject(env.SHOP_AGENT.getByName(shop), (instance) =>
      [...instance.getConnections()].map((connection) => connection.state),
    ),
  );

afterEach(async () => {
  await resetMemberTables();
});

describe("ShopAgent connect gate", () => {
  it.effect("forwards a merchant role for a valid session token", () =>
    run(
      Effect.gen(function* () {
        const shop = shopOf("gate-merchant.myshopify.com");
        yield* seedSubscribedShop(shop);
        const token = yield* Effect.promise(() => mintSessionToken(shop));
        const response = yield* upgrade(
          `http://localhost/agents/shop-agent/${shop}?token=${token}`,
          {},
        );
        strictEqual(response.status, 101);
        expect(yield* connectionStatesOf(shop)).toEqual([
          { role: "merchant", subscription: null },
        ]);
      }),
    ),
  );

  it.effect("forwards the member identity resolved from the cookie", () =>
    run(
      Effect.gen(function* () {
        const shop = shopOf("gate-member.myshopify.com");
        yield* seedSubscribedShop(shop);
        const repository = yield* Repository;
        const team = yield* repository.createTeam({
          shop,
          name: teamNameOf("Cut & Sew"),
        });
        yield* repository.addMember({
          shop,
          email: MEMBER,
          limit: Domain.MAX_ENTITLEMENTS.maxMembers,
        });
        const access = yield* repository.findMemberAccess({
          shop,
          email: MEMBER,
        });
        const { memberId } = Option.isNone(access)
          ? yield* Effect.die("member missing right after addMember")
          : access.value;
        yield* repository.setMemberTeams({
          shop,
          memberId,
          teamIds: [team.id],
        });
        const cookie = yield* signInThroughWorker(MEMBER);
        const response = yield* upgrade(
          `http://localhost/agents/shop-agent/${shop}`,
          { cookie },
        );
        strictEqual(response.status, 101);
        expect(yield* connectionStatesOf(shop)).toEqual([
          {
            role: "member",
            memberId,
            memberEmail: MEMBER,
            teamIds: [team.id],
            subscription: null,
          },
        ]);
      }),
    ),
  );

  /**
   * The spoof case the rebuild exists for: a non-browser client can set
   * `x-baton-role` on an upgrade, so the gate must not carry the inbound
   * headers forward. The connection comes out `member` regardless.
   */
  it.effect("strips a forged role header from a member upgrade", () =>
    run(
      Effect.gen(function* () {
        const shop = shopOf("gate-spoof.myshopify.com");
        yield* seedSubscribedShop(shop);
        yield* (yield* Repository).addMember({
          shop,
          email: MEMBER,
          limit: Domain.MAX_ENTITLEMENTS.maxMembers,
        });
        const cookie = yield* signInThroughWorker(MEMBER);
        const response = yield* upgrade(
          `http://localhost/agents/shop-agent/${shop}`,
          { cookie, [Domain.CONNECTION_ROLE_HEADER]: "merchant" },
        );
        strictEqual(response.status, 101);
        expect(yield* connectionStatesOf(shop)).toMatchObject([
          { role: "member", memberEmail: MEMBER },
        ]);
      }),
    ),
  );

  it.effect("404s a signed-in non-member of that shop", () =>
    run(
      Effect.gen(function* () {
        const shop = shopOf("gate-notmine.myshopify.com");
        const otherShop = shopOf("gate-theirs.myshopify.com");
        yield* seedSubscribedShop(shop);
        yield* seedSubscribedShop(otherShop);
        yield* (yield* Repository).addMember({
          shop: otherShop,
          email: STRANGER,
          limit: Domain.MAX_ENTITLEMENTS.maxMembers,
        });
        const cookie = yield* signInThroughWorker(STRANGER);
        const response = yield* upgrade(
          `http://localhost/agents/shop-agent/${shop}`,
          { cookie },
        );
        strictEqual(response.status, 404);
      }),
    ),
  );

  it.effect("403s an operator cookie", () =>
    run(
      Effect.gen(function* () {
        const shop = shopOf("gate-admin.myshopify.com");
        yield* seedSubscribedShop(shop);
        const cookie = yield* signInThroughWorker(ADMIN);
        const response = yield* upgrade(
          `http://localhost/agents/shop-agent/${shop}`,
          { cookie },
        );
        strictEqual(response.status, 403);
      }),
    ),
  );

  /**
   * The member half of the subscription check: a cached `planHandle` of `null`
   * inside its deadline is `SubscriptionPlan`'s "verified absence of a
   * contract", so `requireMember` redirects and the gate answers `402` — the
   * same status the merchant gate gives a lapsed shop.
   */
  it.effect("402s a member of a shop whose subscription lapsed", () =>
    run(
      Effect.gen(function* () {
        const shop = shopOf("gate-lapsed.myshopify.com");
        yield* seedSubscribedShop(shop);
        const repository = yield* Repository;
        yield* repository.updateShopSessionPlan({
          shop,
          planHandle: null,
          planHandleExpiresAt: Date.now() + 60 * 60 * 1000,
          pendingPlanHandle: null,
          planBoundaryAt: null,
          planCycleStartAt: null,
          planCancelAtEndOfCycle: false,
        });
        yield* repository.addMember({
          shop,
          email: MEMBER,
          limit: Domain.MAX_ENTITLEMENTS.maxMembers,
        });
        const cookie = yield* signInThroughWorker(MEMBER);
        const response = yield* upgrade(
          `http://localhost/agents/shop-agent/${shop}`,
          { cookie },
        );
        strictEqual(response.status, 402);
        expect(yield* connectionStatesOf(shop)).toEqual([]);
      }),
    ),
  );

  /**
   * The seat half of the same check. `requireMember` answers a seatless member
   * with the same redirect a lapse gets, and the gate must not distinguish
   * them: the reason is the shop's business, and the client's answer is `402`
   * either way.
   */
  it.effect("402s a member the plan has no seat for", () =>
    run(
      Effect.gen(function* () {
        const shop = shopOf("gate-seatless.myshopify.com");
        yield* seedSubscribedShop(shop);
        const repository = yield* Repository;
        yield* repository.updateShopSessionPlan({
          shop,
          planHandle: "baton-basic",
          planHandleExpiresAt: Date.now() + 60 * 60 * 1000,
          pendingPlanHandle: null,
          planBoundaryAt: null,
          planCycleStartAt: null,
          planCancelAtEndOfCycle: false,
        });
        const seats = Domain.entitlementsOfPlan("basic").maxMembers;
        // Sorted before MEMBER so the tiebreak on email is unambiguous when every
        // add lands in the same millisecond.
        for (let index = 0; index < seats; index += 1)
          yield* repository.addMember({
            shop,
            email: emailOf(`aaa-seated-${String(index)}@example.com`),
            limit: Domain.MAX_ENTITLEMENTS.maxMembers,
          });
        yield* repository.addMember({
          shop,
          email: MEMBER,
          limit: Domain.MAX_ENTITLEMENTS.maxMembers,
        });
        const cookie = yield* signInThroughWorker(MEMBER);
        const response = yield* upgrade(
          `http://localhost/agents/shop-agent/${shop}`,
          { cookie },
        );
        strictEqual(response.status, 402);
        expect(yield* connectionStatesOf(shop)).toEqual([]);
      }),
    ),
  );

  it.effect("401s an upgrade with neither a token nor a session", () =>
    run(
      Effect.gen(function* () {
        const shop = shopOf("gate-anon.myshopify.com");
        yield* seedSubscribedShop(shop);
        const response = yield* upgrade(
          `http://localhost/agents/shop-agent/${shop}`,
          {},
        );
        strictEqual(response.status, 401);
      }),
    ),
  );
});
