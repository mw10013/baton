import { assert, describe, it } from "@effect/vitest";
import * as SQL from "alchemy/SQL/D1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BETTER_AUTH_TABLES, D1_TABLES } from "../../../src/backend/d1-tables.ts";
import { MembershipRepository } from "../../../src/backend/membership-repository.ts";
import { Email } from "../../../src/domain/platform.ts";
import { makeD1Test } from "./layers.ts";

/** `SQL.D1` over {@link makeD1Test}'s database, as the Backend's D1 services build theirs. */
const withSql = <A, E>(
  body: (
    sql: Effect.Success<ReturnType<typeof SQL.D1>>,
    db: Effect.Success<typeof makeD1Test>["db"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const { db, raw } = yield* makeD1Test;
    const sql = yield* SQL.D1(Effect.succeed(raw));
    return yield* body(sql, db);
  }).pipe(Effect.scoped);

describe("D1Test", () => {
  it.effect("a batch rolls back whole when its second statement fails", () =>
    withSql((sql, db) =>
      Effect.gen(function* () {
        const failed = yield* sql
          .batch([
            sql`insert into ShopSession (shop, shopGid, shopActorId) values (${"a.myshopify.com"}, ${"gid"}, ${"a"})`,
            sql`insert into ShopSession (shop, shopGid, shopActorId) values (${"b.myshopify.com"}, ${"gid"}, ${"a"})`,
          ])
          .pipe(Effect.flip);
        assert.strictEqual(failed._tag, "SqlError");
        const rows = db.prepare("select count(*) as n from ShopSession").get();
        assert.strictEqual(rows?.n, 0);
      }),
    ),
  );

  it.effect("a member delete cascades its TeamMember rows", () =>
    withSql((sql, db) =>
      Effect.gen(function* () {
        yield* sql.batch([
          sql`insert into ShopSession (shop, shopGid, shopActorId) values (${"a.myshopify.com"}, ${"gid"}, ${"a"})`,
          sql`insert into Member (id, shop, email, createdAt) values (${"m1"}, ${"a.myshopify.com"}, ${"a@x.com"}, ${0})`,
          sql`insert into Team (id, shop, name, createdAt) values (${"t1"}, ${"a.myshopify.com"}, ${"Cut"}, ${0})`,
          sql`insert into TeamMember (teamId, memberId, createdAt) values (${"t1"}, ${"m1"}, ${0})`,
        ]);
        yield* sql`delete from Member where id = ${"m1"}`;
        assert.strictEqual(db.prepare("select count(*) as n from TeamMember").get()?.n, 0);
        assert.strictEqual(db.prepare("select count(*) as n from Team").get()?.n, 1);
      }),
    ),
  );

  it.effect("insert or ignore … returning answers no row on a conflict", () =>
    withSql((sql) =>
      Effect.gen(function* () {
        yield* sql`insert into ShopSession (shop, shopGid, shopActorId) values (${"a.myshopify.com"}, ${"gid"}, ${"a"})`;
        const insert = (id: string) =>
          sql`insert or ignore into Team (id, shop, name, createdAt) values (${id}, ${"a.myshopify.com"}, ${"Cut"}, ${0}) returning id`;
        assert.deepStrictEqual(yield* insert("t1"), [{ id: "t1" }]);
        assert.deepStrictEqual(yield* insert("t2"), []);
      }),
    ),
  );
});

/**
 * The `schema` and `schema+app` member and team rows of the data-model table on
 * {@link D1_TABLES}, and the test that pins the table's names. Each title is the row's rule
 * verbatim. Each rule test writes the forbidden row with raw SQL, bypassing `MembershipRepository`, so it
 * proves the database refuses it and not merely that the write paths tried so far avoid it.
 *
 * "A team never crosses shops" is not here: the database does not refuse a cross-shop edge, and
 * the row is pinned by `setTeamMember refuses cross-shop pairs` in the `MembershipRepository` tests.
 */
describe("D1 data model", () => {
  const NOW = Date.UTC(2026, 0, 1);

  /** A fresh database and its insert helpers, which throw where the database refuses. */
  const fresh = Effect.map(makeD1Test, ({ db, raw }) => ({
    db,
    raw,
    insertShop: (shop: string, shopActorId = `actor-${shop}`) =>
      db
        .prepare("insert into ShopSession (shop, shopGid, shopActorId) values (?, ?, ?)")
        .run(shop, "gid://shopify/Shop/1", shopActorId),
    insertMember: (id: string, shop: string, email: string) =>
      db
        .prepare("insert into Member (id, shop, email, createdAt) values (?, ?, ?, ?)")
        .run(id, shop, email, NOW),
    insertTeam: (id: string, shop: string, name: string) =>
      db
        .prepare("insert into Team (id, shop, name, createdAt) values (?, ?, ?, ?)")
        .run(id, shop, name, NOW),
    insertTeamMember: (teamId: string, memberId: string) =>
      db
        .prepare("insert into TeamMember (teamId, memberId, createdAt) values (?, ?, ?)")
        .run(teamId, memberId, NOW),
  }));

  it.effect(
    "a member is identified by shop and email; the email is stored lowercase and trimmed",
    () =>
      Effect.gen(function* () {
        const { insertShop, insertMember } = yield* fresh;
        insertShop("a.myshopify.com");
        insertShop("b.myshopify.com");
        assert.throws(() => insertMember("m0", "a.myshopify.com", " A@X.com"));
        assert.throws(() => insertMember("m0", "a.myshopify.com", "A@x.com"));
        insertMember("m1", "a.myshopify.com", "a@x.com");
        assert.throws(() => insertMember("m2", "a.myshopify.com", "a@x.com"));
        insertMember("m3", "b.myshopify.com", "a@x.com");
      }),
  );

  it.effect(
    "delete a member and they leave their teams; nothing else structural points at a member",
    () =>
      Effect.gen(function* () {
        const { db, insertShop, insertMember, insertTeam, insertTeamMember } = yield* fresh;
        insertShop("a.myshopify.com");
        insertMember("m1", "a.myshopify.com", "a@x.com");
        insertTeam("t1", "a.myshopify.com", "Cut");
        insertTeamMember("t1", "m1");
        db.prepare("delete from Member where id = ?").run("m1");
        assert.strictEqual(db.prepare("select count(*) as n from TeamMember").get()?.n, 0);
        assert.deepStrictEqual(
          db
            .prepare("select id from Team")
            .all()
            .map((row) => row.id),
          ["t1"],
        );
        const references = [...D1_TABLES, ...BETTER_AUTH_TABLES].flatMap((table) =>
          db
            .prepare(
              `select "table" as target, "from" as col from pragma_foreign_key_list('${table}')`,
            )
            .all()
            .filter((key) => key.target === "Member")
            .map((key) => `${table}.${String(key.col)}`),
        );
        assert.deepStrictEqual(references, ["TeamMember.memberId"]);
      }),
  );

  it.effect(
    "a member is matched to a user by email at sign-in and nothing points between them",
    () =>
      Effect.gen(function* () {
        const { db, raw, insertShop, insertMember } = yield* fresh;
        insertShop("a.myshopify.com");
        insertShop("b.myshopify.com");
        insertMember("m1", "a.myshopify.com", "a@x.com");
        insertMember("m2", "b.myshopify.com", "a@x.com");
        db.prepare(
          "insert into user (id, name, email, emailVerified, createdAt, updatedAt) values ('u1', 'A', 'a@x.com', 0, '', '')",
        ).run();
        // One person on two shops is one user and two members, joined by the email the sign-in
        // path reads and by nothing stored.
        const shops = yield* Effect.gen(function* () {
          return yield* (yield* MembershipRepository).listShopsOf(
            Schema.decodeUnknownSync(Email)("a@x.com"),
          );
        }).pipe(Effect.provide(MembershipRepository.layerWith(raw)));
        assert.deepStrictEqual(shops.toSorted(), ["a.myshopify.com", "b.myshopify.com"]);
        const pointers = ["Member", "user"].flatMap((table) =>
          db
            .prepare(`select "table" as target from pragma_foreign_key_list('${table}')`)
            .all()
            .map((key) => `${table} -> ${String(key.target)}`),
        );
        assert.deepStrictEqual(pointers, ["Member -> ShopSession"]);
        const memberColumns = db.prepare("select name from pragma_table_info('Member')").all();
        assert.deepStrictEqual(
          memberColumns.filter((column) => String(column.name).toLowerCase().includes("user")),
          [],
        );
        db.prepare("delete from user where id = 'u1'").run();
        assert.strictEqual(db.prepare("select count(*) as n from Member").get()?.n, 2);
      }),
  );

  it.effect(
    "a team is identified by its name within a shop, compared exactly; the name is trimmed and non-empty",
    () =>
      Effect.gen(function* () {
        const { insertShop, insertTeam } = yield* fresh;
        insertShop("a.myshopify.com");
        insertShop("b.myshopify.com");
        insertTeam("t1", "a.myshopify.com", "Cut");
        assert.throws(() => insertTeam("t2", "a.myshopify.com", "Cut"));
        insertTeam("t6", "a.myshopify.com", "cut");
        assert.throws(() => insertTeam("t3", "a.myshopify.com", " Sew"));
        assert.throws(() => insertTeam("t4", "a.myshopify.com", ""));
        insertTeam("t5", "b.myshopify.com", "Cut");
      }),
  );

  it.effect("the migrations create exactly D1_TABLES and better-auth's tables", () =>
    Effect.gen(function* () {
      const { db } = yield* fresh;
      const names = db
        .prepare("select name from sqlite_master where type = 'table'")
        .all()
        .map((row) => String(row.name))
        .filter((name) => !name.startsWith("sqlite_"));
      assert.deepStrictEqual(new Set(names), new Set([...D1_TABLES, ...BETTER_AUTH_TABLES]));
    }),
  );
});
