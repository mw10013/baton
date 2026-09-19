import { strictEqual, assertFalse } from "@effect/vitest/utils";
import { env, exports as workerExports } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";

import { Auth, magicLinkKvKey } from "@/lib/Auth";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { Email } from "@/lib/Email";
import { KV } from "@/lib/KV";
import { makeEnvLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

/**
 * The member-area test fixture: the service layer a `/shop/*` test needs, the
 * D1 seed a shop must have before anyone can be a member of it, and the full
 * magic-link sign-in hop that yields a browser's cookie header.
 *
 * Shared rather than copied because three suites now need the same starting
 * point — the member area's HTTP guards, the Worker's WebSocket connect gate,
 * and the member callables on `ShopAgent` — and a member session that is built
 * two different ways is a fixture that can disagree with itself about what
 * "signed in" means.
 */
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
export const memberFixtureLayer = Layer.mergeAll(
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

export const run = <A, E>(
  effect: Effect.Effect<A, E, Auth | KV | Repository>,
) => effect.pipe(Effect.provide(memberFixtureLayer));

export const shopOf = Schema.decodeUnknownSync(Domain.Shop);
export const emailOf = Schema.decodeUnknownSync(Domain.Email);
export const teamNameOf = Schema.decodeUnknownSync(Domain.TeamName);

export const fetchWorker = (url: string, init?: RequestInit) =>
  Effect.promise(() =>
    workerExports.default.fetch(
      new Request(url, { redirect: "manual", ...init }),
    ),
  );

/** The tier a seeded shop holds. Pro so no fixture trips a member cap. */
const SEEDED_PLAN_HANDLE: Domain.PlanHandle = "baton-pro";

/**
 * A shop with a cached, unexpired plan entry. Every member surface runs
 * `requireMember`, which resolves the plan after membership, and a bare
 * `ShopSession` row has no cached plan, so it would send `SubscriptionPlan` to
 * the Partner API. Seeding the cache keeps the check on its real path and
 * hermetic. A lapsed-shop test overwrites the handle with `null` afterwards.
 */
export const seedShop = (shop: Domain.Shop) =>
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
    yield* repository.updateShopSessionPlan({
      shop,
      planHandle: SEEDED_PLAN_HANDLE,
      planHandleExpiresAt: Date.now() + 60 * 60 * 1000,
      pendingPlanHandle: null,
      planBoundaryAt: null,
      planCycleStartAt: null,
      planCancelAtEndOfCycle: false,
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
export const signInThroughWorker = (email: Domain.Email) =>
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

/** Every table a member-area case writes, in dependency order. */
export const resetMemberTables = () =>
  env.D1.batch([
    env.D1.prepare("delete from Session"),
    env.D1.prepare("delete from User"),
    env.D1.prepare("delete from Verification"),
    env.D1.prepare("delete from TeamMember"),
    env.D1.prepare("delete from Team"),
    env.D1.prepare("delete from Member"),
    env.D1.prepare("delete from ShopSession"),
  ]);
