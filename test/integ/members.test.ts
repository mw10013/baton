import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CONNECTION_CLOSE_REVOKED } from "../../src/contract/shop-actor.ts";
import { Email, ShopLimits, type ShopKey } from "../../src/domain/platform.ts";
import { MemberId, TeamId, TeamName } from "../../src/domain/shop-work.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { addToFixture, integ, nextCloseCode, openAs } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The merchant's member and team writes end to end on the test stack: each `Merchant…` procedure
 * on a forged merchant socket, its answer and its typed failures, the row as the Backend then
 * reads D1, and the member sockets the actor closes. Every case but the two ceilings writes
 * `SEED_SHOP` under names of its own; the ceilings fill `OTHER_SHOP`, which nothing else here
 * writes. The repository's own rules are unit tests over the same schema.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("members"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const email = Schema.decodeUnknownSync(Email);
const teamName = Schema.decodeUnknownSync(TeamName);
const unknownTeam = Schema.decodeUnknownSync(TeamId)("team-unknown");
const unknownMember = Schema.decodeUnknownSync(MemberId)("member-unknown");

/** A merchant's socket to `shop`, forged past the gate, open in the caller's scope. */
const merchant = (backendUrl: string, shop: ShopKey = SEED_SHOP) =>
  Effect.map(openAs(backendUrl, shop, { role: "merchant" }), ({ client }) => client);

/** A member's socket to `SEED_SHOP` as `memberId`, forged past the gate, open once answered. */
const memberSocket = (backendUrl: string, memberId: string, address: Email) =>
  Effect.gen(function* () {
    const socket = yield* openAs(backendUrl, SEED_SHOP, {
      role: "member",
      memberId,
      memberEmail: address,
      teamIds: [],
      userId: `user-${memberId}`,
      sessionId: `session-${memberId}`,
      sessionExpiresAt: Date.now() + 600_000,
    });
    yield* socket.client.MemberWhoAmI();
    return socket;
  });

/** The shop's member emails and team names, as the Backend reads them from D1. */
const identity = (backendUrl: string, shop: ShopKey = SEED_SHOP) =>
  integ(backendUrl, (c) => c.ShopIdentityNames({ shop }));

test(
  "MerchantAddMember adds a member the Backend then reads, and a repeat add answers the same row",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    assert.notInclude((yield* identity(backendUrl)).emails.map(String), "added@members.test");
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const added = yield* client.MerchantAddMember({ email: email("  Added@Members.Test ") });
      assert.strictEqual(added.email, "added@members.test");
      assert.strictEqual(String(added.shop), SEED_SHOP);
      assert.include((yield* identity(backendUrl)).emails.map(String), "added@members.test");
      const again = yield* client.MerchantAddMember({ email: email("added@members.test") });
      assert.strictEqual(again.id, added.id);
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantDeleteMember deletes the member, and an unknown email is MemberNotFoundError",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      yield* client.MerchantAddMember({ email: email("deleted@members.test") });
      yield* client.MerchantDeleteMember({ email: email("deleted@members.test") });
      assert.notInclude((yield* identity(backendUrl)).emails.map(String), "deleted@members.test");
      const missing = yield* client
        .MerchantDeleteMember({ email: email("deleted@members.test") })
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "MemberNotFoundError");
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantAddMemberTeams puts a member on teams, and an unknown member is MemberNotFoundError",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const member = yield* client.MerchantAddMember({ email: email("teams@members.test") });
      const a = yield* client.MerchantCreateTeam({ name: teamName("Member teams A") });
      const b = yield* client.MerchantCreateTeam({ name: teamName("Member teams B") });
      yield* client.MerchantAddMemberTeams({ memberId: member.id, teamIds: [a.id, b.id] });
      const missing = yield* client
        .MerchantAddMemberTeams({ memberId: unknownMember, teamIds: [a.id] })
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "MemberNotFoundError");
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantSetTeamMember adds and removes, and an unknown team is TeamNotFoundError",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const member = yield* client.MerchantAddMember({ email: email("set@members.test") });
      const team = yield* client.MerchantCreateTeam({ name: teamName("Set team") });
      yield* client.MerchantSetTeamMember({ teamId: team.id, memberId: member.id, inTeam: true });
      yield* client.MerchantSetTeamMember({ teamId: team.id, memberId: member.id, inTeam: false });
      const missing = yield* client
        .MerchantSetTeamMember({ teamId: unknownTeam, memberId: member.id, inTeam: true })
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "TeamNotFoundError");
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantCreateTeam creates a team the Backend then reads, and a taken name is TeamNameTakenError",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const team = yield* client.MerchantCreateTeam({ name: teamName("  Created team  ") });
      assert.strictEqual(team.name, "Created team");
      assert.include((yield* identity(backendUrl)).teams, "Created team");
      const taken = yield* client
        .MerchantCreateTeam({ name: teamName("Created team") })
        .pipe(Effect.flip);
      assert.strictEqual(taken._tag, "TeamNameTakenError");
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantRenameTeam renames, and refuses a taken name and an unknown team distinctly",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const team = yield* client.MerchantCreateTeam({ name: teamName("Rename from") });
      yield* client.MerchantCreateTeam({ name: teamName("Rename taken") });
      yield* client.MerchantRenameTeam({ teamId: team.id, name: teamName("Rename to") });
      const names = (yield* identity(backendUrl)).teams;
      assert.include(names, "Rename to");
      assert.notInclude(names, "Rename from");
      const taken = yield* client
        .MerchantRenameTeam({ teamId: team.id, name: teamName("Rename taken") })
        .pipe(Effect.flip);
      assert.strictEqual(taken._tag, "TeamNameTakenError");
      const missing = yield* client
        .MerchantRenameTeam({ teamId: unknownTeam, name: teamName("Rename nowhere") })
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "TeamNotFoundError");
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantAddTeamMembers adds members to a team, and an unknown team is TeamNotFoundError",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const a = yield* client.MerchantAddMember({ email: email("crew-a@members.test") });
      const b = yield* client.MerchantAddMember({ email: email("crew-b@members.test") });
      const team = yield* client.MerchantCreateTeam({ name: teamName("Crew") });
      yield* client.MerchantAddTeamMembers({ teamId: team.id, memberIds: [a.id, b.id] });
      const missing = yield* client
        .MerchantAddTeamMembers({ teamId: unknownTeam, memberIds: [a.id] })
        .pipe(Effect.flip);
      assert.strictEqual(missing._tag, "TeamNotFoundError");
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantDeleteTeam deletes the team, and an unknown id answers NotFound",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const team = yield* client.MerchantCreateTeam({ name: teamName("Deleted team") });
      assert.deepStrictEqual(yield* client.MerchantDeleteTeam({ teamId: team.id }), {
        _tag: "Deleted",
      });
      assert.notInclude((yield* identity(backendUrl)).teams, "Deleted team");
      assert.deepStrictEqual(yield* client.MerchantDeleteTeam({ teamId: team.id }), {
        _tag: "NotFound",
      });
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantAddMember refuses a new email at the member ceiling with MemberCeilingError",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const { emails } = yield* identity(backendUrl, OTHER_SHOP);
    yield* addToFixture(backendUrl, OTHER_SHOP, {
      members: Array.from(
        { length: ShopLimits.maxMembers - emails.length },
        (_, n) => `ceiling-${String(n)}@members.test`,
      ).map((address) => email(address)),
    });
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl, OTHER_SHOP);
      const refused = yield* client
        .MerchantAddMember({ email: email("over@members.test") })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "MemberCeilingError");
      assert.strictEqual(refused._tag === "MemberCeilingError" && refused.limit, 50);
      assert.strictEqual((yield* identity(backendUrl, OTHER_SHOP)).emails.length, 50);
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantCreateTeam refuses past the team limit with TeamLimitError",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const { teams } = yield* identity(backendUrl, OTHER_SHOP);
    yield* addToFixture(backendUrl, OTHER_SHOP, {
      teams: Array.from({ length: ShopLimits.maxTeams - teams.length }, (_, n) => ({
        name: teamName(`Limit ${String(n)}`),
        members: [],
      })),
    });
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl, OTHER_SHOP);
      const refused = yield* client
        .MerchantCreateTeam({ name: teamName("One too many") })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "TeamLimitError");
    }).pipe(Effect.scoped);
  }),
);

test(
  "a member socket closes 3401 when the merchant removes the member from a team",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const member = yield* client.MerchantAddMember({ email: email("removed@members.test") });
      const team = yield* client.MerchantCreateTeam({ name: teamName("Removed from") });
      yield* client.MerchantSetTeamMember({ teamId: team.id, memberId: member.id, inTeam: true });
      const socket = yield* memberSocket(backendUrl, member.id, member.email);
      yield* client.MerchantSetTeamMember({ teamId: team.id, memberId: member.id, inTeam: false });
      assert.strictEqual(yield* nextCloseCode(socket.closes), CONNECTION_CLOSE_REVOKED);
    }).pipe(Effect.scoped);
  }),
);

test(
  "a member socket closes 3401 when the merchant deletes the member",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const member = yield* client.MerchantAddMember({ email: email("gone@members.test") });
      const socket = yield* memberSocket(backendUrl, member.id, member.email);
      yield* client.MerchantDeleteMember({ email: member.email });
      assert.strictEqual(yield* nextCloseCode(socket.closes), CONNECTION_CLOSE_REVOKED);
    }).pipe(Effect.scoped);
  }),
);

test(
  "closes the sockets of everyone who was on the deleted team",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* merchant(backendUrl);
      const a = yield* client.MerchantAddMember({ email: email("on-team-a@members.test") });
      const b = yield* client.MerchantAddMember({ email: email("on-team-b@members.test") });
      const team = yield* client.MerchantCreateTeam({ name: teamName("Disbanded") });
      yield* client.MerchantAddTeamMembers({ teamId: team.id, memberIds: [a.id, b.id] });
      const socketA = yield* memberSocket(backendUrl, a.id, a.email);
      const socketB = yield* memberSocket(backendUrl, b.id, b.email);
      assert.deepStrictEqual(yield* client.MerchantDeleteTeam({ teamId: team.id }), {
        _tag: "Deleted",
      });
      assert.strictEqual(yield* nextCloseCode(socketA.closes), CONNECTION_CLOSE_REVOKED);
      assert.strictEqual(yield* nextCloseCode(socketB.closes), CONNECTION_CLOSE_REVOKED);
    }).pipe(Effect.scoped);
  }),
);

test(
  "a member socket is refused every member and team procedure with Forbidden",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* memberSocket(
        backendUrl,
        "mem-forbidden",
        email("forbidden@members.test"),
      );
      const someone = email("someone@members.test");
      const errors = [
        yield* client.MerchantAddMember({ email: someone }).pipe(Effect.flip),
        yield* client.MerchantDeleteMember({ email: someone }).pipe(Effect.flip),
        yield* client
          .MerchantAddMemberTeams({ memberId: unknownMember, teamIds: [] })
          .pipe(Effect.flip),
        yield* client
          .MerchantSetTeamMember({ teamId: unknownTeam, memberId: unknownMember, inTeam: true })
          .pipe(Effect.flip),
        yield* client.MerchantCreateTeam({ name: teamName("Forbidden") }).pipe(Effect.flip),
        yield* client
          .MerchantRenameTeam({ teamId: unknownTeam, name: teamName("Forbidden") })
          .pipe(Effect.flip),
        yield* client
          .MerchantAddTeamMembers({ teamId: unknownTeam, memberIds: [] })
          .pipe(Effect.flip),
        yield* client.MerchantDeleteTeam({ teamId: unknownTeam }).pipe(Effect.flip),
      ];
      assert.deepStrictEqual(
        errors.map((error) => error._tag),
        Array.from({ length: 8 }, () => "Forbidden"),
      );
    }).pipe(Effect.scoped);
  }),
);
