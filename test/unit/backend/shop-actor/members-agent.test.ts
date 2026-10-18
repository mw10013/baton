import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../../../src/contract/shop.ts";
import { Email } from "../../../../src/domain/platform.ts";
import { MemberId, TeamId, TeamName } from "../../../../src/domain/shop-work.ts";
import { Members } from "../../../../src/backend/members.ts";
import { makeMembersAgent } from "../../../../src/backend/shop-actor/members-agent.ts";
import { makeD1Test, QuietLogs, seedD1 } from "../layers.ts";

const shop = Schema.decodeUnknownSync(ShopKey)("agent.myshopify.com");
const email = Schema.decodeUnknownSync(Email);
const teamName = Schema.decodeUnknownSync(TeamName);

/**
 * A {@link makeMembersAgent} over the real `Members` on a fresh in-memory D1 holding `shop`, and
 * a recording `revoke`: each call's member ids, in order.
 */
const harness = Effect.gen(function* () {
  const { db, raw } = yield* makeD1Test;
  seedD1(db, { shops: [shop] });
  const members = yield* Members.pipe(Effect.provide(Members.layerWith(raw)));
  const revoked: Array<ReadonlyArray<MemberId>> = [];
  const agent = makeMembersAgent({
    members,
    revoke: (memberIds) =>
      Effect.sync(() => {
        revoked.push(memberIds);
        return memberIds.length;
      }),
    shop,
  });
  return { agent, revoked };
});

describe("MembersAgent", () => {
  it.effect("adding a member, creating a team and renaming it revoke nobody", () =>
    Effect.gen(function* () {
      const { agent, revoked } = yield* harness;
      const member = yield* agent.addMember({ email: email("new@agent.test") });
      assert.strictEqual(member.email, "new@agent.test");
      const team = yield* agent.createTeam({ name: teamName("Cut") });
      yield* agent.renameTeam({ teamId: team.id, name: teamName("Cutting") });
      assert.deepStrictEqual(revoked, []);
    }).pipe(Effect.provide(QuietLogs)),
  );

  it.effect("each membership write revokes exactly the members it changed", () =>
    Effect.gen(function* () {
      const { agent, revoked } = yield* harness;
      const a = yield* agent.addMember({ email: email("a@agent.test") });
      const b = yield* agent.addMember({ email: email("b@agent.test") });
      const cut = yield* agent.createTeam({ name: teamName("Cut") });
      const sew = yield* agent.createTeam({ name: teamName("Sew") });
      yield* agent.addMemberTeams({ memberId: a.id, teamIds: [cut.id, sew.id] });
      yield* agent.setTeamMember({ teamId: sew.id, memberId: a.id, inTeam: false });
      yield* agent.addTeamMembers({ teamId: cut.id, memberIds: [b.id] });
      yield* agent.deleteMember({ email: b.email });
      assert.deepStrictEqual(revoked, [[a.id], [a.id], [b.id], [b.id]]);
    }).pipe(Effect.provide(QuietLogs)),
  );

  it.effect("deleteTeam revokes everyone who was on the team, read before the delete", () =>
    Effect.gen(function* () {
      const { agent, revoked } = yield* harness;
      const a = yield* agent.addMember({ email: email("a@agent.test") });
      const b = yield* agent.addMember({ email: email("b@agent.test") });
      yield* agent.addMember({ email: email("off@agent.test") });
      const team = yield* agent.createTeam({ name: teamName("Cut") });
      yield* agent.addTeamMembers({ teamId: team.id, memberIds: [a.id, b.id] });
      revoked.length = 0;
      assert.deepStrictEqual(yield* agent.deleteTeam({ teamId: team.id }), { _tag: "Deleted" });
      assert.deepStrictEqual(
        revoked.map((ids) => [...ids].sort()),
        [[a.id, b.id].sort()],
      );
    }).pipe(Effect.provide(QuietLogs)),
  );

  it.effect("deleteTeam of an unknown id is NotFound and revokes none", () =>
    Effect.gen(function* () {
      const { agent, revoked } = yield* harness;
      assert.deepStrictEqual(
        yield* agent.deleteTeam({ teamId: Schema.decodeUnknownSync(TeamId)("team-unknown") }),
        { _tag: "NotFound" },
      );
      assert.deepStrictEqual(revoked, []);
    }).pipe(Effect.provide(QuietLogs)),
  );

  it.effect("a refusal writes nothing and revokes none", () =>
    Effect.gen(function* () {
      const { agent, revoked } = yield* harness;
      const member = yield* agent.addMember({ email: email("a@agent.test") });
      const team = yield* agent.createTeam({ name: teamName("Cut") });
      const unknownTeam = Schema.decodeUnknownSync(TeamId)("team-unknown");
      const failures = [
        yield* agent.deleteMember({ email: email("nobody@agent.test") }).pipe(Effect.flip),
        yield* agent
          .addMemberTeams({
            memberId: Schema.decodeUnknownSync(MemberId)("member-unknown"),
            teamIds: [team.id],
          })
          .pipe(Effect.flip),
        yield* agent
          .setTeamMember({ teamId: unknownTeam, memberId: member.id, inTeam: true })
          .pipe(Effect.flip),
        yield* agent
          .addTeamMembers({ teamId: unknownTeam, memberIds: [member.id] })
          .pipe(Effect.flip),
        yield* agent.createTeam({ name: teamName("Cut") }).pipe(Effect.flip),
        yield* agent.renameTeam({ teamId: unknownTeam, name: teamName("Sew") }).pipe(Effect.flip),
      ];
      assert.deepStrictEqual(
        failures.map((failure) => failure._tag),
        [
          "MemberNotFoundError",
          "MemberNotFoundError",
          "TeamNotFoundError",
          "TeamNotFoundError",
          "TeamNameTakenError",
          "TeamNotFoundError",
        ],
      );
      assert.deepStrictEqual(revoked, []);
    }).pipe(Effect.provide(QuietLogs)),
  );
});
