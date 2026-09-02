import { describe, it } from "@effect/vitest";
import { assertTrue, strictEqual } from "@effect/vitest/utils";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { afterEach } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import {
  Repository,
  TeamNameTakenError,
  TeamNotFoundError,
} from "@/lib/Repository";

const layer = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

const run = <A, E>(effect: Effect.Effect<A, E, Repository>) =>
  effect.pipe(Effect.provide(layer));

const shopOf = (s: string) => Schema.decodeUnknownSync(Domain.Shop)(s);
const shopGid = Schema.decodeUnknownSync(Domain.ShopGid)(
  "gid://shopify/Shop/1",
);

const makeShopSession = (
  overrides: Partial<Domain.ShopSession> & { readonly shop: Domain.Shop },
): Domain.ShopSession => ({
  shopGid,
  shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)(
    `agent-${overrides.shop}`,
  ),
  scope: "read_products",
  accessTokenExpiresAt: 1000,
  accessToken: "shpat_x",
  refreshToken: "shprt_x",
  refreshTokenExpiresAt: 2000,
  planHandle: null,
  planHandleExpiresAt: null,
  ...overrides,
});

const seed = (repo: Repository["Service"], shops: readonly string[]) =>
  Effect.forEach(
    shops,
    (s) => repo.upsertShopSession(makeShopSession({ shop: shopOf(s) })),
    { discard: true },
  );

const emailOf = (e: string) => Schema.decodeUnknownSync(Domain.Email)(e);

afterEach(async () => {
  await env.D1.exec("delete from TeamMember");
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from Member");
  await env.D1.exec("delete from ShopSession");
});

describe("Repository SQL (D1 ShopSession)", () => {
  it.effect(
    "upsertShopSession inserts then conflict-updates; findShopSession round-trips",
    () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("a.myshopify.com");
          yield* repo.upsertShopSession(
            makeShopSession({ shop, scope: "read_products" }),
          );
          const first = Option.getOrThrow(yield* repo.findShopSession(shop));
          strictEqual(first.scope, "read_products");
          yield* repo.upsertShopSession(
            makeShopSession({
              shop,
              scope: "write_products",
              accessToken: "shpat_new",
            }),
          );
          const second = Option.getOrThrow(yield* repo.findShopSession(shop));
          strictEqual(second.scope, "write_products");
          strictEqual(second.accessToken, "shpat_new");
        }),
      ),
  );

  it.effect("findShopSession returns none for a missing shop", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const missing = yield* repo.findShopSession(
          shopOf("missing.myshopify.com"),
        );
        assertTrue(Option.isNone(missing));
      }),
    ),
  );

  it.effect("clearShopSessionAccessToken nulls only the access token", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const shop = shopOf("clear.myshopify.com");
        yield* repo.upsertShopSession(
          makeShopSession({
            shop,
            accessToken: "shpat_x",
            refreshToken: "shprt_x",
          }),
        );
        yield* repo.clearShopSessionAccessToken(shop);
        const shopSession = Option.getOrThrow(
          yield* repo.findShopSession(shop),
        );
        strictEqual(shopSession.accessToken, null);
        strictEqual(shopSession.refreshToken, "shprt_x");
      }),
    ),
  );

  it.effect("updateShopSessionTokens rewrites the token fields", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const shop = shopOf("tokens.myshopify.com");
        yield* repo.upsertShopSession(makeShopSession({ shop }));
        yield* repo.updateShopSessionTokens({
          shop,
          accessToken: "shpat_2",
          accessTokenExpiresAt: 5,
          refreshToken: "shprt_2",
          refreshTokenExpiresAt: 6,
        });
        const shopSession = Option.getOrThrow(
          yield* repo.findShopSession(shop),
        );
        strictEqual(shopSession.accessToken, "shpat_2");
        strictEqual(shopSession.accessTokenExpiresAt, 5);
        strictEqual(shopSession.refreshToken, "shprt_2");
        strictEqual(shopSession.refreshTokenExpiresAt, 6);
      }),
    ),
  );

  it.effect("updateShopSessionPlan rewrites only the plan cache fields", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const shop = shopOf("plan.myshopify.com");
        yield* repo.upsertShopSession(makeShopSession({ shop }));
        yield* repo.updateShopSessionPlan({
          shop,
          planHandle: "baton-pro-test",
          planHandleExpiresAt: 3000,
        });
        const shopSession = Option.getOrThrow(
          yield* repo.findShopSession(shop),
        );
        strictEqual(shopSession.planHandle, "baton-pro-test");
        strictEqual(shopSession.planHandleExpiresAt, 3000);
        strictEqual(shopSession.accessToken, "shpat_x");
        strictEqual(shopSession.refreshToken, "shprt_x");
        strictEqual(shopSession.scope, "read_products");
      }),
    ),
  );

  it.effect("updateShopSessionScope rewrites the scope", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const shop = shopOf("scope.myshopify.com");
        yield* repo.upsertShopSession(
          makeShopSession({ shop, scope: "read_products" }),
        );
        yield* repo.updateShopSessionScope(
          shop,
          "read_products,write_products",
        );
        const shopSession = Option.getOrThrow(
          yield* repo.findShopSession(shop),
        );
        strictEqual(shopSession.scope, "read_products,write_products");
      }),
    ),
  );

  it.effect("deleteShopSession removes the row", () =>
    run(
      Effect.gen(function* () {
        const repo = yield* Repository;
        const shop = shopOf("delete.myshopify.com");
        yield* repo.upsertShopSession(makeShopSession({ shop }));
        yield* repo.deleteShopSession(shop);
        assertTrue(Option.isNone(yield* repo.findShopSession(shop)));
      }),
    ),
  );

  describe("getShopSessionRedactedPage", () => {
    it.effect("forward first page reports the next cursor", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          yield* seed(repo, [
            "a.myshopify.com",
            "b.myshopify.com",
            "c.myshopify.com",
          ]);
          const page = yield* repo.getShopSessionRedactedPage({ limit: 2 });
          strictEqual(page.shopSessions.length, 2);
          strictEqual(page.shopSessions[0].shop, "a.myshopify.com");
          strictEqual(page.shopSessions[1].shop, "b.myshopify.com");
          strictEqual(page.hasNextPage, true);
          strictEqual(page.hasPreviousPage, false);
          strictEqual(page.startCursor, "a.myshopify.com");
          strictEqual(page.endCursor, "b.myshopify.com");
        }),
      ),
    );

    it.effect("forward page with an after cursor reaches the end", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          yield* seed(repo, [
            "a.myshopify.com",
            "b.myshopify.com",
            "c.myshopify.com",
          ]);
          const page = yield* repo.getShopSessionRedactedPage({
            limit: 2,
            after: "b.myshopify.com",
          });
          strictEqual(page.shopSessions.length, 1);
          strictEqual(page.shopSessions[0].shop, "c.myshopify.com");
          strictEqual(page.hasNextPage, false);
          strictEqual(page.hasPreviousPage, true);
        }),
      ),
    );

    it.effect("forward page applies the filter (like)", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          yield* seed(repo, [
            "alpha.myshopify.com",
            "alphabeta.myshopify.com",
            "beta.myshopify.com",
          ]);
          const page = yield* repo.getShopSessionRedactedPage({
            limit: 10,
            filter: "alpha",
          });
          strictEqual(page.shopSessions.length, 2);
          assertTrue(page.shopSessions.every((s) => s.shop.includes("alpha")));
          strictEqual(page.hasNextPage, false);
        }),
      ),
    );

    it.effect(
      "backward page reverses ordering and reports previous cursor",
      () =>
        run(
          Effect.gen(function* () {
            const repo = yield* Repository;
            yield* seed(repo, [
              "a.myshopify.com",
              "b.myshopify.com",
              "c.myshopify.com",
              "d.myshopify.com",
            ]);
            const page = yield* repo.getShopSessionRedactedPage({
              limit: 2,
              before: "d.myshopify.com",
            });
            strictEqual(page.shopSessions.length, 2);
            strictEqual(page.shopSessions[0].shop, "b.myshopify.com");
            strictEqual(page.shopSessions[1].shop, "c.myshopify.com");
            strictEqual(page.hasPreviousPage, true);
            strictEqual(page.hasNextPage, true);
          }),
        ),
    );

    it.effect("backward page applies the filter (like)", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          yield* seed(repo, [
            "alpha1.myshopify.com",
            "alpha2.myshopify.com",
            "beta.myshopify.com",
          ]);
          const page = yield* repo.getShopSessionRedactedPage({
            limit: 10,
            before: "zzz.myshopify.com",
            filter: "alpha",
          });
          strictEqual(page.shopSessions.length, 2);
          strictEqual(page.shopSessions[0].shop, "alpha1.myshopify.com");
          strictEqual(page.shopSessions[1].shop, "alpha2.myshopify.com");
          assertTrue(page.shopSessions.every((s) => s.shop.includes("alpha")));
        }),
      ),
    );

    it.effect(
      "projects hasAccessToken / hasRefreshToken from null checks",
      () =>
        run(
          Effect.gen(function* () {
            const repo = yield* Repository;
            yield* repo.upsertShopSession(
              makeShopSession({
                shop: shopOf("has.myshopify.com"),
                accessToken: "shpat_x",
                refreshToken: null,
              }),
            );
            yield* repo.upsertShopSession(
              makeShopSession({
                shop: shopOf("none.myshopify.com"),
                accessToken: null,
                refreshToken: "shprt_y",
              }),
            );
            const page = yield* repo.getShopSessionRedactedPage({ limit: 10 });
            strictEqual(page.shopSessions.length, 2);
            strictEqual(page.shopSessions[0].shop, "has.myshopify.com");
            strictEqual(page.shopSessions[0].hasAccessToken, true);
            strictEqual(page.shopSessions[0].hasRefreshToken, false);
            strictEqual(page.shopSessions[1].shop, "none.myshopify.com");
            strictEqual(page.shopSessions[1].hasAccessToken, false);
            strictEqual(page.shopSessions[1].hasRefreshToken, true);
          }),
        ),
    );
  });

  describe("Member", () => {
    it.effect("addMember inserts idempotently; listMembers round-trips", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("m.myshopify.com");
          yield* seed(repo, [shop]);
          const email = emailOf("worker@example.com");
          yield* repo.addMember({ shop, email });
          const first = yield* repo.listMembers(shop);
          strictEqual(first.length, 1);
          strictEqual(first[0].email, email);
          yield* repo.addMember({ shop, email });
          const second = yield* repo.listMembers(shop);
          strictEqual(second.length, 1);
          strictEqual(second[0].id, first[0].id);
        }),
      ),
    );

    it.effect("Email decode trims and lowercases", () =>
      Effect.gen(function* () {
        const email = yield* Schema.decodeUnknownEffect(Domain.Email)(
          "  Worker@Example.COM ",
        );
        strictEqual(email, "worker@example.com");
      }),
    );

    it.effect("deleteMember removes the row; findMember reflects it", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("m.myshopify.com");
          yield* seed(repo, [shop]);
          const email = emailOf("worker@example.com");
          yield* repo.addMember({ shop, email });
          strictEqual(
            Option.getOrThrow(yield* repo.findMember({ shop, email })).email,
            email,
          );
          yield* repo.deleteMember({ shop, email });
          assertTrue(Option.isNone(yield* repo.findMember({ shop, email })));
        }),
      ),
    );

    it.effect("listMemberShops spans shops for one email", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          yield* seed(repo, ["a.myshopify.com", "b.myshopify.com"]);
          const email = emailOf("multi@example.com");
          yield* repo.addMember({ shop: shopOf("b.myshopify.com"), email });
          yield* repo.addMember({ shop: shopOf("a.myshopify.com"), email });
          const shops = yield* repo.listMemberShops(email);
          strictEqual(shops.length, 2);
          strictEqual(shops[0], "a.myshopify.com");
          strictEqual(shops[1], "b.myshopify.com");
        }),
      ),
    );

    it.effect("deleteShopSession cascades that shop's members only", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          yield* seed(repo, ["a.myshopify.com", "b.myshopify.com"]);
          const email = emailOf("multi@example.com");
          yield* repo.addMember({ shop: shopOf("a.myshopify.com"), email });
          yield* repo.addMember({ shop: shopOf("b.myshopify.com"), email });
          yield* repo.deleteShopSession(shopOf("a.myshopify.com"));
          const shops = yield* repo.listMemberShops(email);
          strictEqual(shops.length, 1);
          strictEqual(shops[0], "b.myshopify.com");
        }),
      ),
    );
  });

  describe("Team", () => {
    const teamNameOf = Schema.decodeUnknownSync(Domain.TeamName);

    const seedTeam = (shop: Domain.Shop, name: string) =>
      Effect.gen(function* () {
        const repo = yield* Repository;
        return yield* repo.createTeam({ shop, name: teamNameOf(name) });
      });

    it.effect("createTeam trims, lists active-only, and counts members", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("t.myshopify.com");
          yield* seed(repo, [shop]);
          const team = yield* seedTeam(shop, "  Cut & Sew  ");
          strictEqual(team.name, "Cut & Sew");
          const email = emailOf("worker@example.com");
          yield* repo.addMember({ shop, email });
          const [member] = yield* repo.listMembers(shop);
          yield* repo.setTeamMember({
            shop,
            teamId: team.id,
            memberId: member.id,
            inTeam: true,
          });
          const listed = yield* repo.listTeams({
            shop,
            includeArchived: false,
          });
          strictEqual(listed.length, 1);
          strictEqual(listed[0].memberCount, 1);
        }),
      ),
    );

    it.effect("createTeam rejects a case-insensitive duplicate name", () =>
      run(
        Effect.gen(function* () {
          const shop = shopOf("t.myshopify.com");
          yield* seed(yield* Repository, [shop]);
          yield* seedTeam(shop, "Cut");
          assertTrue(
            (yield* Effect.flip(seedTeam(shop, "  cut  "))) instanceof
              TeamNameTakenError,
          );
        }),
      ),
    );

    it.effect("renameTeam reports conflicts and missing teams distinctly", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("t.myshopify.com");
          yield* seed(repo, [shop]);
          const cut = yield* seedTeam(shop, "Cut");
          yield* seedTeam(shop, "Sew");
          assertTrue(
            (yield* Effect.flip(
              repo.renameTeam({ shop, id: cut.id, name: teamNameOf("sew") }),
            )) instanceof TeamNameTakenError,
          );
          yield* repo.renameTeam({
            shop,
            id: cut.id,
            name: teamNameOf("Cutting"),
          });
          const listed = yield* repo.listTeams({
            shop,
            includeArchived: false,
          });
          strictEqual(listed.map((team) => team.name).join(","), "Cutting,Sew");
          assertTrue(
            (yield* Effect.flip(
              repo.renameTeam({
                shop,
                id: Schema.decodeUnknownSync(Domain.TeamId)("nope"),
                name: teamNameOf("Whatever"),
              }),
            )) instanceof TeamNotFoundError,
          );
        }),
      ),
    );

    it.effect("setTeamArchived hides then restores, keeping the instant", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("t.myshopify.com");
          yield* seed(repo, [shop]);
          const team = yield* seedTeam(shop, "Cut");
          yield* repo.setTeamArchived({ shop, id: team.id, archived: true });
          const first = yield* repo.listTeams({ shop, includeArchived: true });
          strictEqual(
            (yield* repo.listTeams({ shop, includeArchived: false })).length,
            0,
          );
          yield* repo.setTeamArchived({ shop, id: team.id, archived: true });
          const second = yield* repo.listTeams({ shop, includeArchived: true });
          strictEqual(second[0].archivedAt, first[0].archivedAt);
          yield* repo.setTeamArchived({ shop, id: team.id, archived: false });
          strictEqual(
            (yield* repo.listTeams({ shop, includeArchived: false })).length,
            1,
          );
        }),
      ),
    );

    it.effect("setTeamMember refuses cross-shop pairs and archived teams", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("t.myshopify.com");
          const other = shopOf("o.myshopify.com");
          yield* seed(repo, [shop, other]);
          const team = yield* seedTeam(shop, "Cut");
          const email = emailOf("worker@example.com");
          yield* repo.addMember({ shop: other, email });
          const [foreign] = yield* repo.listMembers(other);
          assertTrue(
            (yield* Effect.flip(
              repo.setTeamMember({
                shop,
                teamId: team.id,
                memberId: foreign.id,
                inTeam: true,
              }),
            )) instanceof TeamNotFoundError,
          );
          yield* repo.addMember({ shop, email });
          const [member] = yield* repo.listMembers(shop);
          yield* repo.setTeamArchived({ shop, id: team.id, archived: true });
          assertTrue(
            (yield* Effect.flip(
              repo.setTeamMember({
                shop,
                teamId: team.id,
                memberId: member.id,
                inTeam: true,
              }),
            )) instanceof TeamNotFoundError,
          );
          yield* repo.setTeamMember({
            shop,
            teamId: team.id,
            memberId: member.id,
            inTeam: false,
          });
        }),
      ),
    );

    it.effect("findTeamDetail flags every shop member, in or out", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("t.myshopify.com");
          yield* seed(repo, [shop]);
          const team = yield* seedTeam(shop, "Cut");
          yield* repo.addMember({ shop, email: emailOf("in@example.com") });
          yield* repo.addMember({ shop, email: emailOf("out@example.com") });
          const members = yield* repo.listMembers(shop);
          const [inMember] = members.filter(
            (m) => m.email === "in@example.com",
          );
          yield* repo.setTeamMember({
            shop,
            teamId: team.id,
            memberId: inMember.id,
            inTeam: true,
          });
          yield* repo.setTeamMember({
            shop,
            teamId: team.id,
            memberId: inMember.id,
            inTeam: true,
          });
          const detail = Option.getOrThrow(
            yield* repo.findTeamDetail({ shop, id: team.id }),
          );
          strictEqual(detail.members.length, 2);
          strictEqual(
            detail.members
              .map((m) => `${m.email}:${m.inTeam ? "in" : "out"}`)
              .toSorted()
              .join(","),
            "in@example.com:in,out@example.com:out",
          );
          assertTrue(
            Option.isNone(
              yield* repo.findTeamDetail({
                shop: shopOf("o.myshopify.com"),
                id: team.id,
              }),
            ),
          );
        }),
      ),
    );

    it.effect("deleting a member cascades their team edges", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("t.myshopify.com");
          yield* seed(repo, [shop]);
          const team = yield* seedTeam(shop, "Cut");
          const email = emailOf("worker@example.com");
          yield* repo.addMember({ shop, email });
          const [member] = yield* repo.listMembers(shop);
          yield* repo.setTeamMember({
            shop,
            teamId: team.id,
            memberId: member.id,
            inTeam: true,
          });
          yield* repo.deleteMember({ shop, email });
          strictEqual(
            (yield* repo.listTeams({ shop, includeArchived: false }))[0]
              .memberCount,
            0,
          );
        }),
      ),
    );

    it.effect("deleteShopSession cascades that shop's teams", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("t.myshopify.com");
          yield* seed(repo, [shop]);
          yield* seedTeam(shop, "Cut");
          yield* repo.deleteShopSession(shop);
          strictEqual(
            (yield* repo.listTeams({ shop, includeArchived: true })).length,
            0,
          );
        }),
      ),
    );

    it.effect("findMemberAccess carries active teams and only those", () =>
      run(
        Effect.gen(function* () {
          const repo = yield* Repository;
          const shop = shopOf("t.myshopify.com");
          yield* seed(repo, [shop]);
          const email = emailOf("worker@example.com");
          yield* repo.addMember({ shop, email });
          const [member] = yield* repo.listMembers(shop);
          const teamless = Option.getOrThrow(
            yield* repo.findMemberAccess({ shop, email }),
          );
          strictEqual(teamless.memberId, member.id);
          strictEqual(teamless.teams.length, 0);
          const cut = yield* seedTeam(shop, "Cut");
          const sew = yield* seedTeam(shop, "Sew");
          for (const team of [cut, sew])
            yield* repo.setTeamMember({
              shop,
              teamId: team.id,
              memberId: member.id,
              inTeam: true,
            });
          strictEqual(
            Option.getOrThrow(yield* repo.findMemberAccess({ shop, email }))
              .teams.map((team) => team.name)
              .join(","),
            "Cut,Sew",
          );
          yield* repo.setTeamArchived({ shop, id: sew.id, archived: true });
          strictEqual(
            Option.getOrThrow(yield* repo.findMemberAccess({ shop, email }))
              .teams.map((team) => team.name)
              .join(","),
            "Cut",
          );
          assertTrue(
            Option.isNone(
              yield* repo.findMemberAccess({
                shop,
                email: emailOf("stranger@example.com"),
              }),
            ),
          );
        }),
      ),
    );
  });
});
