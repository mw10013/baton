import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type {
  AddMemberInput,
  AddMemberTeamsInput,
  AddTeamMembersInput,
  CreateTeamInput,
  DeleteMemberInput,
  DeleteTeamInput,
  RenameTeamInput,
  SetTeamMemberInput,
} from "../../contract/members.ts";
import type { ShopKey } from "../../contract/shop.ts";
import type { DeleteTeamResult, MemberId } from "../../domain/shop-work.ts";
import type { Members } from "../members.ts";

/**
 * The merchant's member and team writes, one method per `Merchant…` procedure, as the shop's
 * actor runs them. Built once per activation over the Backend's `Members`, the actor's `revoke`
 * (which closes every socket of each member with 3401 and answers how many it closed) and its
 * shop.
 *
 * Identity on a socket is a connect-time snapshot (member id, team ids), so every write that
 * changes a member's membership or teams closes that member's sockets after the D1 write, and
 * each reconnects through the gate with what now holds: remove from a team, add to teams, add
 * members to a team, delete a member, delete a team (its members, read before the delete). Not
 * after adding a member (no sockets yet), creating a team, or renaming one (sockets carry ids,
 * not names). A refusal writes nothing and closes nothing. The close is best effort: a failure
 * is logged and the write stands.
 *
 * Team delete is where E's half joins, after the D1 delete and before the closes: null the
 * actor's task pointers to the team and to any team already gone from D1, reconcile, and notify.
 */
export const makeMembersAgent = ({
  members,
  revoke,
  shop,
}: {
  readonly members: (typeof Members)["Service"];
  readonly revoke: (memberIds: ReadonlyArray<MemberId>) => Effect.Effect<number>;
  readonly shop: ShopKey;
}) => {
  /** {@link revoke}, best effort: a failure is logged and closes none. */
  const close = (operation: string, memberIds: ReadonlyArray<MemberId>) =>
    revoke(memberIds).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`${operation}: shop=${shop}: close failed`, cause).pipe(
          Effect.annotateLogs({ shop }),
          Effect.as(0),
        ),
      ),
    );

  const log = (message: string, annotations: Record<string, unknown>) =>
    Effect.logInfo(message).pipe(Effect.annotateLogs({ shop, ...annotations }));

  const addMember = Effect.fn("MembersAgent.addMember")(function* ({ email }: AddMemberInput) {
    const member = yield* members.addMember({ shop, email });
    yield* log(`MembersAgent.addMember: shop=${shop} memberId=${member.id}: added closed=0`, {
      memberId: member.id,
      closed: 0,
    });
    return member;
  });

  const deleteMember = Effect.fn("MembersAgent.deleteMember")(function* ({
    email,
  }: DeleteMemberInput) {
    const memberId = yield* members.deleteMember({ shop, email });
    const closed = yield* close("MembersAgent.deleteMember", [memberId]);
    yield* log(
      `MembersAgent.deleteMember: shop=${shop} memberId=${memberId}: deleted closed=${closed}`,
      {
        memberId,
        closed,
      },
    );
  });

  const addMemberTeams = Effect.fn("MembersAgent.addMemberTeams")(function* ({
    memberId,
    teamIds,
  }: AddMemberTeamsInput) {
    yield* members.addMemberTeams({ shop, memberId, teamIds });
    const closed = yield* close("MembersAgent.addMemberTeams", [memberId]);
    yield* log(
      `MembersAgent.addMemberTeams: shop=${shop} memberId=${memberId}: added teams=${teamIds.length} closed=${closed}`,
      { memberId, teams: teamIds.length, closed },
    );
  });

  const setTeamMember = Effect.fn("MembersAgent.setTeamMember")(function* ({
    teamId,
    memberId,
    inTeam,
  }: SetTeamMemberInput) {
    yield* members.setTeamMember({ shop, teamId, memberId, inTeam });
    const closed = yield* close("MembersAgent.setTeamMember", [memberId]);
    const outcome = inTeam ? "added" : "removed";
    yield* log(
      `MembersAgent.setTeamMember: shop=${shop} teamId=${teamId}: ${outcome} memberId=${memberId} closed=${closed}`,
      { teamId, memberId, outcome, closed },
    );
  });

  const createTeam = Effect.fn("MembersAgent.createTeam")(function* ({ name }: CreateTeamInput) {
    const team = yield* members.createTeam({ shop, name });
    yield* log(`MembersAgent.createTeam: shop=${shop} teamId=${team.id}: created closed=0`, {
      teamId: team.id,
      closed: 0,
    });
    return team;
  });

  const renameTeam = Effect.fn("MembersAgent.renameTeam")(function* ({
    teamId,
    name,
  }: RenameTeamInput) {
    yield* members.renameTeam({ shop, id: teamId, name });
    yield* log(`MembersAgent.renameTeam: shop=${shop} teamId=${teamId}: renamed closed=0`, {
      teamId,
      closed: 0,
    });
  });

  const addTeamMembers = Effect.fn("MembersAgent.addTeamMembers")(function* ({
    teamId,
    memberIds,
  }: AddTeamMembersInput) {
    yield* members.addTeamMembers({ shop, teamId, memberIds });
    const closed = yield* close("MembersAgent.addTeamMembers", memberIds);
    yield* log(
      `MembersAgent.addTeamMembers: shop=${shop} teamId=${teamId}: added members=${memberIds.length} closed=${closed}`,
      { teamId, members: memberIds.length, closed },
    );
  });

  /**
   * Legacy's `deleteTeam` callable: `NotFound` is an answer, not a failure, and closes
   * nobody; `Members.deleteTeam` reads the team's members before the edges cascade.
   */
  const deleteTeam = Effect.fn("MembersAgent.deleteTeam")(function* ({ teamId }: DeleteTeamInput) {
    const deleted = yield* members.deleteTeam({ shop, id: teamId }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("TeamNotFoundError", () =>
        Effect.succeed(Option.none<ReadonlyArray<MemberId>>()),
      ),
    );
    const closed = Option.isSome(deleted)
      ? yield* close("MembersAgent.deleteTeam", deleted.value)
      : 0;
    const outcome = Option.isSome(deleted) ? "deleted" : "not-found";
    yield* log(
      `MembersAgent.deleteTeam: shop=${shop} teamId=${teamId}: ${outcome} closed=${closed}`,
      {
        teamId,
        outcome,
        closed,
      },
    );
    const result: DeleteTeamResult = Option.isSome(deleted)
      ? { _tag: "Deleted" }
      : { _tag: "NotFound" };
    return result;
  });

  return {
    addMember,
    deleteMember,
    addMemberTeams,
    setTeamMember,
    createTeam,
    renameTeam,
    addTeamMembers,
    deleteTeam,
  };
};
