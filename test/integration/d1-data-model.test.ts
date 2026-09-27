import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { D1Primary } from "@/lib/D1Primary";
import { BETTER_AUTH_TABLES, D1_TABLES } from "@/lib/D1Schema";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { makeEnvLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

/**
 * The `schema` and `schema+app` rows of the data-model table on `D1_TABLES`
 * (`src/lib/D1Schema.ts`). Each title is the row's rule verbatim, which is
 * what `pnpm spec check` looks for. Each rule test writes the forbidden row
 * with raw SQL through `env.D1`, bypassing `Repository`, so it proves the
 * database refuses it and not merely that the write paths tried so far
 * avoid it. D1 enforces foreign keys and `on delete cascade` by default.
 * The last test reads `sqlite_master` so a migration that adds a table no
 * row describes fails here.
 *
 * "A team never crosses shops" is not here: the database does not refuse a
 * cross-shop edge, and the row is pinned by `setTeamMember refuses
 * cross-shop pairs` in `repository.test.ts`.
 */

const layer = Repository.layerNoDeps.pipe(
  Layer.provide(
    Layer.merge(
      D1Session.layer(env.D1),
      Layer.provide(D1Primary.layerNoDeps, makeEnvLayer(env)),
    ),
  ),
);

const NOW = "2026-01-01T00:00:00.000Z";

const insertShop = (shop: string, shopAgentId = `agent-${shop}`) =>
  env.D1.prepare(
    "insert into ShopSession (shop, shopGid, shopAgentId) values (?1, ?2, ?3)",
  )
    .bind(shop, "gid://shopify/Shop/1", shopAgentId)
    .run();

const insertMember = (id: string, shop: string, email: string) =>
  env.D1.prepare(
    "insert into Member (id, shop, email, createdAt) values (?1, ?2, ?3, ?4)",
  )
    .bind(id, shop, email, NOW)
    .run();

const insertTeam = (id: string, shop: string, name: string) =>
  env.D1.prepare(
    "insert into Team (id, shop, name, createdAt) values (?1, ?2, ?3, ?4)",
  )
    .bind(id, shop, name, NOW)
    .run();

const insertTeamMember = (teamId: string, memberId: string) =>
  env.D1.prepare(
    "insert into TeamMember (teamId, memberId, createdAt) values (?1, ?2, ?3)",
  )
    .bind(teamId, memberId, NOW)
    .run();

/** Asserts the database refuses the write. */
const rejects = (write: Promise<unknown>) => expect(write).rejects.toThrow();

afterEach(async () => {
  await env.D1.exec("delete from TeamMember");
  await env.D1.exec("delete from Team");
  await env.D1.exec("delete from Member");
  await env.D1.exec("delete from ShopSession");
});

describe("D1 data model", () => {
  it("a shop is identified by its domain and has exactly one object", async () => {
    await insertShop("a.myshopify.com", "agent-1");
    await rejects(insertShop("b.myshopify.com", "agent-1"));
    await rejects(insertShop("a.myshopify.com", "agent-2"));

    const shop = Schema.decodeUnknownSync(Domain.Shop)("a.myshopify.com");
    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository;
        yield* repo.upsertShopSession({
          shop,
          shopGid: Schema.decodeUnknownSync(Domain.ShopGid)(
            "gid://shopify/Shop/1",
          ),
          shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)(
            "agent-rewritten",
          ),
          scope: "read_products",
          accessTokenExpiresAt: 1000,
          accessToken: "shpat_x",
          refreshToken: "shprt_x",
          refreshTokenExpiresAt: 2000,
        });
        return yield* repo.findShopSession(shop);
      }).pipe(Effect.provide(layer)),
    );
    expect(session.pipe(Option.map(({ shopAgentId }) => shopAgentId))).toEqual(
      Option.some("agent-1"),
    );
  });

  it("a member is identified by shop and email; the email is stored lowercase and trimmed", async () => {
    await insertShop("a.myshopify.com");
    await insertShop("b.myshopify.com");
    await rejects(insertMember("m0", "a.myshopify.com", " A@X.com"));
    await rejects(insertMember("m0", "a.myshopify.com", "A@x.com"));
    await insertMember("m1", "a.myshopify.com", "a@x.com");
    await rejects(insertMember("m2", "a.myshopify.com", "a@x.com"));
    await insertMember("m3", "b.myshopify.com", "a@x.com");
  });

  it("delete a member and they leave their teams; nothing else structural points at a member", async () => {
    await insertShop("a.myshopify.com");
    await insertMember("m1", "a.myshopify.com", "a@x.com");
    await insertTeam("t1", "a.myshopify.com", "Cut");
    await insertTeamMember("t1", "m1");
    await env.D1.prepare("delete from Member where id = ?1").bind("m1").run();
    const edges = await env.D1.prepare(
      "select count(*) as n from TeamMember",
    ).first<{ n: number }>();
    expect(edges?.n).toBe(0);
    const teams = await env.D1.prepare("select id from Team").all<{
      id: string;
    }>();
    expect(teams.results.map((row) => row.id)).toEqual(["t1"]);

    // D1's authorizer refuses a pragma table function with a dynamic
    // argument, so each table is asked with a constant one.
    const references = await Promise.all(
      [...D1_TABLES, ...BETTER_AUTH_TABLES].map(async (table) => {
        const keys = await env.D1.prepare(
          `select "table" as target, "from" as col from pragma_foreign_key_list('${table}')`,
        ).all<{ target: string; col: string }>();
        return keys.results
          .filter((key) => key.target === "Member")
          .map((key) => `${table}.${key.col}`);
      }),
    );
    expect(references.flat()).toEqual(["TeamMember.memberId"]);
  });

  it("a team is identified by its name within a shop, case-insensitively; the name is trimmed and non-empty", async () => {
    await insertShop("a.myshopify.com");
    await insertShop("b.myshopify.com");
    await insertTeam("t1", "a.myshopify.com", "Cut");
    await rejects(insertTeam("t2", "a.myshopify.com", "cut"));
    await rejects(insertTeam("t3", "a.myshopify.com", " Sew"));
    await rejects(insertTeam("t4", "a.myshopify.com", ""));
    await insertTeam("t5", "b.myshopify.com", "Cut");
  });

  it("the migrations create exactly D1_TABLES and better-auth's tables", async () => {
    const tables = await env.D1.prepare(
      "select name from sqlite_master where type = 'table'",
    ).all<{ name: string }>();
    const names = tables.results
      .map((row) => row.name)
      .filter(
        (name) =>
          !name.startsWith("_cf_") &&
          !name.startsWith("sqlite_") &&
          name !== "d1_migrations",
      );
    expect(new Set(names)).toEqual(
      new Set([...D1_TABLES, ...BETTER_AUTH_TABLES]),
    );
  });
});
