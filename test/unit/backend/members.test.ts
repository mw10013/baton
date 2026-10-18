import { describe, it } from "@effect/vitest";
import { assertTrue, strictEqual } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DatabaseSync } from "node:sqlite";
import {
  MemberCeilingError,
  TeamLimitError,
  TeamNameTakenError,
  TeamNotFoundError,
} from "../../../src/contract/members.ts";
import { ShopKey } from "../../../src/contract/shop.ts";
import {
  EMAIL_MAX_LENGTH,
  EMAIL_TOO_LONG,
  Email,
  ShopLimits,
} from "../../../src/domain/platform.ts";
import { type Team, TeamId, TeamName } from "../../../src/domain/shop-work.ts";
import { Members } from "../../../src/backend/members.ts";
import { ShopSessions } from "../../../src/backend/shop-sessions.ts";
import { makeD1Test, seedD1 } from "./layers.ts";

/**
 * Legacy `repository.test.ts`'s `Member` and `Team` blocks, titles unchanged, over the real
 * {@link Members} on a fresh in-memory D1 per test. Legacy's `listMembers`, `listTeams` and
 * `countMembers`/`countTeams` are not ported (no production caller): the tests read back
 * through `listMembersPage`/`listTeamsPage` or raw SQL. Legacy's `deleteShopSession` is
 * `ShopSessions.remove` over the same database.
 */
const run = <A, E>(
  body: (members: Members["Service"], db: DatabaseSync) => Effect.Effect<A, E, ShopSessions>,
) =>
  Effect.gen(function* () {
    const { db, raw } = yield* makeD1Test;
    return yield* Effect.gen(function* () {
      return yield* body(yield* Members, db);
    }).pipe(Effect.provide(Layer.merge(Members.layerWith(raw), ShopSessions.layerWith(raw))));
  });

const shopOf = (s: string) => Schema.decodeUnknownSync(ShopKey)(s);
const emailOf = (e: string) => Schema.decodeUnknownSync(Email)(e);
const teamNameOf = Schema.decodeUnknownSync(TeamName);

/** An address of exactly `length` characters. */
const emailOfLength = (length: number) =>
  `${"a".repeat(length - "@example.com".length)}@example.com`;

/** The shop's members in email order, every page of them. */
const listMembers = (members: Members["Service"], shop: ShopKey) =>
  Effect.map(
    members.listMembersPage({ shop, limit: 1000, after: null, q: null }),
    (page) => page.rows,
  );

/** The shop's teams in name order with their member counts, every page of them. */
const listTeams = (members: Members["Service"], shop: ShopKey) =>
  Effect.map(
    members.listTeamsPage({ shop, limit: 1000, after: null, q: null }),
    (page) => page.rows,
  );

const countOf = (db: DatabaseSync, table: "Member" | "Team", shop: ShopKey) =>
  Number(db.prepare(`select count(*) as n from ${table} where shop = ?`).get(shop)?.n);

describe("Member", () => {
  it.effect("addMember inserts idempotently; listMembers round-trips", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("m.myshopify.com");
        seedD1(db, { shops: [shop] });
        const email = emailOf("worker@example.com");
        yield* repo.addMember({ shop, email });
        const first = yield* listMembers(repo, shop);
        strictEqual(first.length, 1);
        strictEqual(first[0]?.email, email);
        yield* repo.addMember({ shop, email });
        const second = yield* listMembers(repo, shop);
        strictEqual(second.length, 1);
        strictEqual(second[0]?.id, first[0]?.id);
      }),
    ),
  );

  it.effect(
    "addMember refuses at the ceiling and says so, and is a no-op for an existing email",
    () =>
      run((repo, db) =>
        Effect.gen(function* () {
          const shop = shopOf("m.myshopify.com");
          seedD1(db, { shops: [shop] });
          const { maxMembers } = ShopLimits;
          for (let index = 0; index < maxMembers; index += 1)
            yield* repo.addMember({ shop, email: emailOf(`m${String(index)}@example.com`) });
          strictEqual(countOf(db, "Member", shop), maxMembers);
          const refused = yield* Effect.flip(
            repo.addMember({ shop, email: emailOf("over@example.com") }),
          );
          assertTrue(refused instanceof MemberCeilingError);
          strictEqual(refused.limit, maxMembers);
          // At the ceiling, re-adding somebody who is already a member is still a no-op rather
          // than a refusal.
          yield* repo.addMember({ shop, email: emailOf("m0@example.com") });
          strictEqual(countOf(db, "Member", shop), maxMembers);
        }),
      ),
  );

  it.effect("Email decode trims and lowercases", () =>
    Effect.gen(function* () {
      const email = yield* Schema.decodeUnknownEffect(Email)("  Worker@Example.COM ");
      strictEqual(email, "worker@example.com");
    }),
  );

  it.effect(
    "deleteMember removes the row, cascades its team edges, and refuses an unknown email",
    () =>
      run((repo, db) =>
        Effect.gen(function* () {
          const shop = shopOf("m.myshopify.com");
          seedD1(db, { shops: [shop] });
          const email = emailOf("worker@example.com");
          yield* repo.addMember({ shop, email });
          const team = yield* repo.createTeam({ shop, name: teamNameOf("Cut") });
          const [member] = yield* listMembers(repo, shop);
          yield* repo.setTeamMember({
            shop,
            teamId: team.id,
            memberId: member!.id,
            inTeam: true,
          });
          yield* repo.deleteMember({ shop, email });
          assertTrue(Option.isNone(yield* repo.findMember({ shop, email })));
          strictEqual((yield* listTeams(repo, shop))[0]?.memberCount, 0);
          const missing = yield* repo.deleteMember({ shop, email }).pipe(Effect.flip);
          strictEqual(missing._tag, "MemberNotFoundError");
        }),
      ),
  );

  it.effect("addMember after deleteMember mints a new id", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("m.myshopify.com");
        seedD1(db, { shops: [shop] });
        const email = emailOf("worker@example.com");
        yield* repo.addMember({ shop, email });
        const original = Option.getOrThrow(yield* repo.findMember({ shop, email }));
        yield* repo.deleteMember({ shop, email });
        yield* repo.addMember({ shop, email });
        const readded = Option.getOrThrow(yield* repo.findMember({ shop, email }));
        assertTrue(readded.id !== original.id);
      }),
    ),
  );

  it.effect("listMemberShops omits shops where the member was deleted", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        seedD1(db, { shops: [shopOf("a.myshopify.com"), shopOf("b.myshopify.com")] });
        const email = emailOf("multi@example.com");
        yield* repo.addMember({ shop: shopOf("a.myshopify.com"), email });
        yield* repo.addMember({ shop: shopOf("b.myshopify.com"), email });
        yield* repo.deleteMember({ shop: shopOf("a.myshopify.com"), email });
        const shops = yield* repo.listShopsOf(email);
        strictEqual(shops.join(","), "b.myshopify.com");
      }),
    ),
  );

  it.effect(
    "a member's teams are added as a batch and removed one at a time from either side",
    () =>
      run((repo, db) =>
        Effect.gen(function* () {
          const shop = shopOf("m.myshopify.com");
          const other = shopOf("o.myshopify.com");
          seedD1(db, { shops: [shop, other] });
          const member = yield* repo.addMember({ shop, email: emailOf("worker@example.com") });
          const a = yield* repo.createTeam({ shop, name: teamNameOf("A") });
          const b = yield* repo.createTeam({ shop, name: teamNameOf("B") });
          const c = yield* repo.createTeam({ shop, name: teamNameOf("C") });
          const foreign = yield* repo.createTeam({ shop: other, name: teamNameOf("F") });
          const names = () =>
            Effect.map(
              repo.findMemberDetail({ shop, id: member.id, teamsAfter: null, limit: 10 }),
              (detail) =>
                Option.getOrThrow(detail)
                  .teams.map((team) => team.name)
                  .join(","),
            );
          // From the member's side: a batch, and a team from another shop is dropped by the
          // join.
          yield* repo.addMemberTeams({
            shop,
            memberId: member.id,
            teamIds: [a.id, b.id, foreign.id],
          });
          strictEqual(yield* names(), "A,B");
          strictEqual((yield* listTeams(repo, other))[0]?.memberCount, 0);
          // From the team's side: the same edge table, so the member's teams show it.
          yield* repo.addTeamMembers({ shop, teamId: c.id, memberIds: [member.id] });
          strictEqual(yield* names(), "A,B,C");
          // Removed one at a time, through the one write both pages use.
          yield* repo.setTeamMember({ shop, teamId: b.id, memberId: member.id, inTeam: false });
          strictEqual(yield* names(), "A,C");
          // A repeat add is a no-op, and a member of another shop is refused.
          yield* repo.addMemberTeams({ shop, memberId: member.id, teamIds: [a.id] });
          strictEqual(yield* names(), "A,C");
          const refused = yield* repo
            .addMemberTeams({ shop: other, memberId: member.id, teamIds: [foreign.id] })
            .pipe(Effect.flip);
          strictEqual(refused._tag, "MemberNotFoundError");
        }),
      ),
  );

  it.effect("findMemberDetail pages a member's teams by name", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("m.myshopify.com");
        seedD1(db, { shops: [shop] });
        const member = yield* repo.addMember({ shop, email: emailOf("worker@example.com") });
        const other = yield* repo.addMember({ shop, email: emailOf("other@example.com") });
        const teams: Array<Team> = [];
        for (const name of ["E", "B", "D", "A", "C"])
          teams.push(yield* repo.createTeam({ shop, name: teamNameOf(name) }));
        const byName = (name: string) =>
          teams.find((team) => team.name === name)?.id ?? Schema.decodeUnknownSync(TeamId)("nope");
        yield* repo.addMemberTeams({
          shop,
          memberId: member.id,
          teamIds: ["A", "B", "C", "D"].map(byName),
        });
        yield* repo.setTeamMember({
          shop,
          teamId: byName("A"),
          memberId: other.id,
          inTeam: true,
        });
        const first = Option.getOrThrow(
          yield* repo.findMemberDetail({ shop, id: member.id, teamsAfter: null, limit: 3 }),
        );
        strictEqual(first.member.email, "worker@example.com");
        strictEqual(first.teams.map((team) => team.name).join(","), "A,B,C");
        strictEqual(first.teamCount, 4);
        strictEqual(first.nextCursor, "C");
        strictEqual(first.candidates.map((team) => team.name).join(","), "E");
        const second = Option.getOrThrow(
          yield* repo.findMemberDetail({
            shop,
            id: member.id,
            teamsAfter: first.nextCursor,
            limit: 3,
          }),
        );
        strictEqual(second.teams.map((team) => team.name).join(","), "D");
        strictEqual(second.nextCursor, null);
        assertTrue(
          Option.isNone(
            yield* repo.findMemberDetail({
              shop: shopOf("o.myshopify.com"),
              id: member.id,
              teamsAfter: null,
              limit: 3,
            }),
          ),
        );
      }),
    ),
  );

  it.effect(
    "listMembersPage pages by email, counts each member's teams, and searches every page",
    () =>
      run((repo, db) =>
        Effect.gen(function* () {
          const shop = shopOf("m.myshopify.com");
          seedD1(db, { shops: [shop] });
          for (const email of ["c@x.com", "a@x.com", "b@y.com"])
            yield* repo.addMember({ shop, email: emailOf(email) });
          const team = yield* repo.createTeam({ shop, name: teamNameOf("Cut") });
          const [a] = (yield* listMembers(repo, shop)).filter(
            (member) => member.email === "a@x.com",
          );
          yield* repo.addMemberTeams({ shop, memberId: a!.id, teamIds: [team.id] });
          const first = yield* repo.listMembersPage({ shop, limit: 2, after: null, q: null });
          strictEqual(
            first.rows.map((row) => `${row.email}:${String(row.teamCount)}`).join(","),
            "a@x.com:1,b@y.com:0",
          );
          strictEqual(first.nextCursor, "b@y.com");
          strictEqual(first.matches, null);
          const second = yield* repo.listMembersPage({
            shop,
            limit: 2,
            after: first.nextCursor,
            q: null,
          });
          strictEqual(second.rows.map((row) => row.email).join(","), "c@x.com");
          strictEqual(second.nextCursor, null);
          const searched = yield* repo.listMembersPage({
            shop,
            limit: 1,
            after: null,
            q: "X.COM",
          });
          strictEqual(searched.rows.map((row) => row.email).join(","), "a@x.com");
          strictEqual(searched.matches, 2);
        }),
      ),
  );

  it.effect("an email over 254 characters is refused and never stored", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("m.myshopify.com");
        seedD1(db, { shops: [shop] });
        const longest = yield* Schema.decodeUnknownEffect(Email)(emailOfLength(EMAIL_MAX_LENGTH));
        yield* repo.addMember({ shop, email: longest });
        const refused = yield* Schema.decodeUnknownEffect(Email)(
          emailOfLength(EMAIL_MAX_LENGTH + 1),
        ).pipe(Effect.flip);
        assertTrue(String(refused).includes(EMAIL_TOO_LONG));
        // The trim runs first: padding does not count.
        yield* Schema.decodeUnknownEffect(Email)(`  ${emailOfLength(EMAIL_MAX_LENGTH)}  `);
        // The D1 check refuses the same length past the app.
        yield* Effect.try(() =>
          db
            .prepare("insert into Member (id, shop, email, createdAt) values (?, ?, ?, 0)")
            .run("long", shop, emailOfLength(EMAIL_MAX_LENGTH + 1)),
        ).pipe(Effect.flip);
        strictEqual(
          (yield* listMembers(repo, shop)).map((member) => member.email.length).join(","),
          String(EMAIL_MAX_LENGTH),
        );
      }),
    ),
  );

  it.effect("listMemberShops spans shops for one email", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        seedD1(db, { shops: [shopOf("a.myshopify.com"), shopOf("b.myshopify.com")] });
        const email = emailOf("multi@example.com");
        yield* repo.addMember({ shop: shopOf("b.myshopify.com"), email });
        yield* repo.addMember({ shop: shopOf("a.myshopify.com"), email });
        const shops = yield* repo.listShopsOf(email);
        strictEqual(shops.length, 2);
        strictEqual(shops[0], "a.myshopify.com");
        strictEqual(shops[1], "b.myshopify.com");
      }),
    ),
  );

  it.effect("deleteShopSession cascades that shop's members only", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        seedD1(db, { shops: [shopOf("a.myshopify.com"), shopOf("b.myshopify.com")] });
        const email = emailOf("multi@example.com");
        yield* repo.addMember({ shop: shopOf("a.myshopify.com"), email });
        yield* repo.addMember({ shop: shopOf("b.myshopify.com"), email });
        yield* (yield* ShopSessions).remove(shopOf("a.myshopify.com"));
        const shops = yield* repo.listShopsOf(email);
        strictEqual(shops.length, 1);
        strictEqual(shops[0], "b.myshopify.com");
      }),
    ),
  );
});

describe("Team", () => {
  const seedTeam = (repo: Members["Service"], shop: ShopKey, name: string) =>
    repo.createTeam({ shop, name: teamNameOf(name) });

  it.effect("createTeam trims, lists, and counts members", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        const team = yield* seedTeam(repo, shop, "  Cut & Sew  ");
        strictEqual(team.name, "Cut & Sew");
        const email = emailOf("worker@example.com");
        yield* repo.addMember({ shop, email });
        const [member] = yield* listMembers(repo, shop);
        yield* repo.setTeamMember({ shop, teamId: team.id, memberId: member!.id, inTeam: true });
        const listed = yield* listTeams(repo, shop);
        strictEqual(listed.length, 1);
        strictEqual(listed[0]?.memberCount, 1);
      }),
    ),
  );

  it.effect("createTeam rejects an exact duplicate name and accepts a case variant", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        yield* seedTeam(repo, shop, "Cut");
        assertTrue(
          (yield* Effect.flip(seedTeam(repo, shop, "  Cut  "))) instanceof TeamNameTakenError,
        );
        yield* seedTeam(repo, shop, "cut");
      }),
    ),
  );

  it.effect("createTeam refuses past ShopLimits.maxTeams", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        yield* Effect.forEach(
          Array.from({ length: ShopLimits.maxTeams }, (_, n) => `Team ${String(n)}`),
          (name) => seedTeam(repo, shop, name),
          { discard: true },
        );
        strictEqual(countOf(db, "Team", shop), ShopLimits.maxTeams);
        const refused = yield* Effect.flip(seedTeam(repo, shop, "One too many"));
        assertTrue(refused instanceof TeamLimitError);
      }),
    ),
  );

  it.effect("renameTeam reports conflicts and missing teams distinctly", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        const cut = yield* seedTeam(repo, shop, "Cut");
        yield* seedTeam(repo, shop, "Sew");
        assertTrue(
          (yield* Effect.flip(
            repo.renameTeam({ shop, id: cut.id, name: teamNameOf("Sew") }),
          )) instanceof TeamNameTakenError,
        );
        yield* repo.renameTeam({ shop, id: cut.id, name: teamNameOf("Cutting") });
        const listed = yield* listTeams(repo, shop);
        strictEqual(listed.map((team) => team.name).join(","), "Cutting,Sew");
        assertTrue(
          (yield* Effect.flip(
            repo.renameTeam({
              shop,
              id: Schema.decodeUnknownSync(TeamId)("nope"),
              name: teamNameOf("Whatever"),
            }),
          )) instanceof TeamNotFoundError,
        );
      }),
    ),
  );

  it.effect(
    "deleteTeam removes the row and its edges, frees the name, and refuses an unknown id",
    () =>
      run((repo, db) =>
        Effect.gen(function* () {
          const shop = shopOf("t.myshopify.com");
          seedD1(db, { shops: [shop] });
          const team = yield* seedTeam(repo, shop, "Cut");
          const email = emailOf("worker@example.com");
          yield* repo.addMember({ shop, email });
          const [member] = yield* listMembers(repo, shop);
          yield* repo.setTeamMember({
            shop,
            teamId: team.id,
            memberId: member!.id,
            inTeam: true,
          });
          yield* repo.deleteTeam({ shop, id: team.id });
          strictEqual((yield* listTeams(repo, shop)).length, 0);
          strictEqual(
            Option.getOrThrow(yield* repo.findMemberAccess({ shop, email })).teams.length,
            0,
          );
          const again = yield* seedTeam(repo, shop, "Cut");
          assertTrue(again.id !== team.id);
          assertTrue(
            (yield* Effect.flip(repo.deleteTeam({ shop, id: team.id }))) instanceof
              TeamNotFoundError,
          );
        }),
      ),
  );

  it.effect("setTeamMember refuses cross-shop pairs", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        const other = shopOf("o.myshopify.com");
        seedD1(db, { shops: [shop, other] });
        const team = yield* seedTeam(repo, shop, "Cut");
        const email = emailOf("worker@example.com");
        yield* repo.addMember({ shop: other, email });
        const [foreign] = yield* listMembers(repo, other);
        assertTrue(
          (yield* Effect.flip(
            repo.setTeamMember({ shop, teamId: team.id, memberId: foreign!.id, inTeam: true }),
          )) instanceof TeamNotFoundError,
        );
        yield* repo.setTeamMember({ shop, teamId: team.id, memberId: foreign!.id, inTeam: false });
      }),
    ),
  );

  it.effect(
    "addTeamMembers adds many, ignores present and cross-shop members, refuses a missing team",
    () =>
      run((repo, db) =>
        Effect.gen(function* () {
          const shop = shopOf("t.myshopify.com");
          const other = shopOf("o.myshopify.com");
          seedD1(db, { shops: [shop, other] });
          const team = yield* seedTeam(repo, shop, "Cut");
          for (const email of ["a@example.com", "b@example.com"])
            yield* repo.addMember({ shop, email: emailOf(email) });
          yield* repo.addMember({ shop: other, email: emailOf("f@example.com") });
          const [a, b] = yield* listMembers(repo, shop);
          const [foreign] = yield* listMembers(repo, other);
          yield* repo.setTeamMember({ shop, teamId: team.id, memberId: a!.id, inTeam: true });
          yield* repo.addTeamMembers({
            shop,
            teamId: team.id,
            memberIds: [a!.id, b!.id, foreign!.id],
          });
          strictEqual((yield* listTeams(repo, shop))[0]?.memberCount, 2);
          yield* repo.addTeamMembers({ shop, teamId: team.id, memberIds: [] });
          assertTrue(
            (yield* Effect.flip(
              repo.addTeamMembers({ shop: other, teamId: team.id, memberIds: [foreign!.id] }),
            )) instanceof TeamNotFoundError,
          );
        }),
      ),
  );

  it.effect("findTeamDetail pages a team's members by email and lists the rest as candidates", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        const team = yield* seedTeam(repo, shop, "Cut");
        for (const email of ["c@x.com", "a@x.com", "b@x.com", "out@x.com"])
          yield* repo.addMember({ shop, email: emailOf(email) });
        const members = yield* listMembers(repo, shop);
        yield* repo.addTeamMembers({
          shop,
          teamId: team.id,
          memberIds: members.filter((m) => m.email !== "out@x.com").map((m) => m.id),
        });
        const first = Option.getOrThrow(
          yield* repo.findTeamDetail({ shop, id: team.id, membersAfter: null, limit: 2 }),
        );
        strictEqual(first.members.map((m) => m.email).join(","), "a@x.com,b@x.com");
        strictEqual(first.memberCount, 3);
        strictEqual(first.nextCursor, "b@x.com");
        strictEqual(first.candidates.map((m) => m.email).join(","), "out@x.com");
        const second = Option.getOrThrow(
          yield* repo.findTeamDetail({
            shop,
            id: team.id,
            membersAfter: first.nextCursor,
            limit: 2,
          }),
        );
        strictEqual(second.members.map((m) => m.email).join(","), "c@x.com");
        strictEqual(second.nextCursor, null);
        assertTrue(
          Option.isNone(
            yield* repo.findTeamDetail({
              shop: shopOf("o.myshopify.com"),
              id: team.id,
              membersAfter: null,
              limit: 2,
            }),
          ),
        );
      }),
    ),
  );

  it.effect("listTeamsPage pages by name and searches every page", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        for (const name of ["Sewing", "Cutting", "Engraving"]) yield* seedTeam(repo, shop, name);
        const first = yield* repo.listTeamsPage({ shop, limit: 2, after: null, q: null });
        strictEqual(first.rows.map((row) => row.name).join(","), "Cutting,Engraving");
        strictEqual(first.nextCursor, "Engraving");
        const second = yield* repo.listTeamsPage({
          shop,
          limit: 2,
          after: first.nextCursor,
          q: null,
        });
        strictEqual(second.rows.map((row) => row.name).join(","), "Sewing");
        strictEqual(second.nextCursor, null);
        const searched = yield* repo.listTeamsPage({ shop, limit: 1, after: null, q: "ING" });
        strictEqual(searched.rows.map((row) => row.name).join(","), "Cutting");
        strictEqual(searched.matches, 3);
      }),
    ),
  );

  it.effect("removing via setTeamMember drops memberCount", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        const team = yield* seedTeam(repo, shop, "Cut");
        const email = emailOf("worker@example.com");
        yield* repo.addMember({ shop, email });
        const [member] = yield* listMembers(repo, shop);
        yield* repo.setTeamMember({ shop, teamId: team.id, memberId: member!.id, inTeam: true });
        strictEqual((yield* listTeams(repo, shop))[0]?.memberCount, 1);
        yield* repo.setTeamMember({ shop, teamId: team.id, memberId: member!.id, inTeam: false });
        strictEqual((yield* listTeams(repo, shop))[0]?.memberCount, 0);
      }),
    ),
  );

  it.effect("findMemberAccess is none for a deleted member", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        const email = emailOf("worker@example.com");
        yield* repo.addMember({ shop, email });
        assertTrue(Option.isSome(yield* repo.findMemberAccess({ shop, email })));
        yield* repo.deleteMember({ shop, email });
        assertTrue(Option.isNone(yield* repo.findMemberAccess({ shop, email })));
      }),
    ),
  );

  it.effect("deleteShopSession cascades that shop's teams", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        yield* seedTeam(repo, shop, "Cut");
        yield* (yield* ShopSessions).remove(shop);
        strictEqual((yield* listTeams(repo, shop)).length, 0);
      }),
    ),
  );

  it.effect("findMemberAccess carries the member's teams and only those", () =>
    run((repo, db) =>
      Effect.gen(function* () {
        const shop = shopOf("t.myshopify.com");
        seedD1(db, { shops: [shop] });
        const email = emailOf("worker@example.com");
        yield* repo.addMember({ shop, email });
        const [member] = yield* listMembers(repo, shop);
        const teamless = Option.getOrThrow(yield* repo.findMemberAccess({ shop, email }));
        strictEqual(teamless.memberId, member!.id);
        strictEqual(teamless.teams.length, 0);
        const cut = yield* seedTeam(repo, shop, "Cut");
        const sew = yield* seedTeam(repo, shop, "Sew");
        for (const team of [cut, sew])
          yield* repo.setTeamMember({ shop, teamId: team.id, memberId: member!.id, inTeam: true });
        strictEqual(
          Option.getOrThrow(yield* repo.findMemberAccess({ shop, email }))
            .teams.map((team) => team.name)
            .join(","),
          "Cut,Sew",
        );
        yield* repo.deleteTeam({ shop, id: sew.id });
        strictEqual(
          Option.getOrThrow(yield* repo.findMemberAccess({ shop, email }))
            .teams.map((team) => team.name)
            .join(","),
          "Cut",
        );
        assertTrue(
          Option.isNone(
            yield* repo.findMemberAccess({ shop, email: emailOf("stranger@example.com") }),
          ),
        );
      }),
    ),
  );
});
