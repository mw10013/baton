import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../../../src/contract/shop.ts";
import { Email } from "../../../../src/domain/platform.ts";
import { MemberId, TeamId, TeamName } from "../../../../src/domain/shop-work.ts";
import { MembershipRepository } from "../../../../src/backend/membership-repository.ts";
import { makeMembership } from "../../../../src/backend/shop-actor/membership.ts";
import { makeD1Test, QuietLogs, seedD1 } from "../layers.ts";

const shop = Schema.decodeUnknownSync(ShopKey)("membership.myshopify.com");
const email = Schema.decodeUnknownSync(Email);
const teamName = Schema.decodeUnknownSync(TeamName);

/**
 * A {@link makeMembership} over the real `MembershipRepository` on a fresh in-memory D1 holding `shop`, and
 * a recording `revoke`: each call's member ids, in order.
 */
const harness = Effect.gen(function* () {
  const { db, raw } = yield* makeD1Test;
  seedD1(db, { shops: [shop] });
  const membershipRepository = yield* MembershipRepository.pipe(
    Effect.provide(MembershipRepository.layerWith(raw)),
  );
  const revoked: Array<ReadonlyArray<MemberId>> = [];
  const membership = makeMembership({
    membershipRepository,
    revoke: (memberIds) =>
      Effect.sync(() => {
        revoked.push(memberIds);
        return memberIds.length;
      }),
    shop,
  });
  return { membership, revoked };
});

describe("Membership", () => {
  it.effect("adding a member, creating a team and renaming it revoke nobody", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      const member = yield* membership.addMember({ email: email("new@membership.test") });
      assert.strictEqual(member.email, "new@membership.test");
      const team = yield* membership.createTeam({ name: teamName("Cut") });
      yield* membership.renameTeam({ teamId: team.id, name: teamName("Cutting") });
      assert.deepStrictEqual(revoked, []);
    }).pipe(Effect.provide(QuietLogs)),
  );

  it.effect("each membership write revokes exactly the members it changed", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      const a = yield* membership.addMember({ email: email("a@membership.test") });
      const b = yield* membership.addMember({ email: email("b@membership.test") });
      const cut = yield* membership.createTeam({ name: teamName("Cut") });
      const sew = yield* membership.createTeam({ name: teamName("Sew") });
      yield* membership.addMemberTeams({ memberId: a.id, teamIds: [cut.id, sew.id] });
      yield* membership.setTeamMember({ teamId: sew.id, memberId: a.id, inTeam: false });
      yield* membership.addTeamMembers({ teamId: cut.id, memberIds: [b.id] });
      yield* membership.deleteMember({ email: b.email });
      assert.deepStrictEqual(revoked, [[a.id], [a.id], [b.id], [b.id]]);
    }).pipe(Effect.provide(QuietLogs)),
  );

  it.effect("deleteTeam revokes everyone who was on the team, read before the delete", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      const a = yield* membership.addMember({ email: email("a@membership.test") });
      const b = yield* membership.addMember({ email: email("b@membership.test") });
      yield* membership.addMember({ email: email("off@membership.test") });
      const team = yield* membership.createTeam({ name: teamName("Cut") });
      yield* membership.addTeamMembers({ teamId: team.id, memberIds: [a.id, b.id] });
      revoked.length = 0;
      assert.deepStrictEqual(yield* membership.deleteTeam({ teamId: team.id }), {
        _tag: "Deleted",
      });
      assert.deepStrictEqual(
        revoked.map((ids) => [...ids].sort()),
        [[a.id, b.id].sort()],
      );
    }).pipe(Effect.provide(QuietLogs)),
  );

  it.effect("deleteTeam of an unknown id is NotFound and revokes none", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      assert.deepStrictEqual(
        yield* membership.deleteTeam({ teamId: Schema.decodeUnknownSync(TeamId)("team-unknown") }),
        { _tag: "NotFound" },
      );
      assert.deepStrictEqual(revoked, []);
    }).pipe(Effect.provide(QuietLogs)),
  );

  it.effect("a refusal writes nothing and revokes none", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      const member = yield* membership.addMember({ email: email("a@membership.test") });
      const team = yield* membership.createTeam({ name: teamName("Cut") });
      const unknownTeam = Schema.decodeUnknownSync(TeamId)("team-unknown");
      const failures = [
        yield* membership
          .deleteMember({ email: email("nobody@membership.test") })
          .pipe(Effect.flip),
        yield* membership
          .addMemberTeams({
            memberId: Schema.decodeUnknownSync(MemberId)("member-unknown"),
            teamIds: [team.id],
          })
          .pipe(Effect.flip),
        yield* membership
          .setTeamMember({ teamId: unknownTeam, memberId: member.id, inTeam: true })
          .pipe(Effect.flip),
        yield* membership
          .addTeamMembers({ teamId: unknownTeam, memberIds: [member.id] })
          .pipe(Effect.flip),
        yield* membership.createTeam({ name: teamName("Cut") }).pipe(Effect.flip),
        yield* membership
          .renameTeam({ teamId: unknownTeam, name: teamName("Sew") })
          .pipe(Effect.flip),
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
