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
import { ORDERS_KEY } from "../../contract/shop-actor.ts";
import type { DeleteTeamResult, MemberId } from "../../domain/shop-work.ts";
import type { MembershipRepository } from "../membership-repository.ts";
import type { WorkflowRepository } from "./workflow-repository.ts";

/**
 * The merchant's member and team writes, one method per `Merchant…` procedure, as the shop's
 * actor runs them. Built once per activation over the Backend's `MembershipRepository`, the actor's `revoke`
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
 * Team delete also nulls the actor's task pointers (`deleteTeam`), over the actor's
 * workflow repository, then reconciles every stored order (`reconcileAll`, the runs service's)
 * and notifies.
 */
export const makeMembership = <R>({
  membershipRepository,
  workflowRepository,
  reconcileAll,
  notify,
  revoke,
  shop,
}: {
  readonly membershipRepository: (typeof MembershipRepository)["Service"];
  readonly workflowRepository: WorkflowRepository;
  readonly reconcileAll: (caller: string, id: string) => Effect.Effect<void, never, R>;
  readonly notify: (invalidated: ReadonlyArray<string>) => Effect.Effect<void, never, R>;
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

  const addMember = Effect.fn("Membership.addMember")(function* ({ email }: AddMemberInput) {
    const member = yield* membershipRepository.addMember({ shop, email });
    yield* log(`Membership.addMember: shop=${shop} memberId=${member.id}: added closed=0`, {
      memberId: member.id,
      closed: 0,
    });
    return member;
  });

  const deleteMember = Effect.fn("Membership.deleteMember")(function* ({
    email,
  }: DeleteMemberInput) {
    const memberId = yield* membershipRepository.deleteMember({ shop, email });
    const closed = yield* close("Membership.deleteMember", [memberId]);
    yield* log(
      `Membership.deleteMember: shop=${shop} memberId=${memberId}: deleted closed=${closed}`,
      {
        memberId,
        closed,
      },
    );
  });

  const addMemberTeams = Effect.fn("Membership.addMemberTeams")(function* ({
    memberId,
    teamIds,
  }: AddMemberTeamsInput) {
    yield* membershipRepository.addMemberTeams({ shop, memberId, teamIds });
    const closed = yield* close("Membership.addMemberTeams", [memberId]);
    yield* log(
      `Membership.addMemberTeams: shop=${shop} memberId=${memberId}: added teams=${teamIds.length} closed=${closed}`,
      { memberId, teams: teamIds.length, closed },
    );
  });

  const setTeamMember = Effect.fn("Membership.setTeamMember")(function* ({
    teamId,
    memberId,
    inTeam,
  }: SetTeamMemberInput) {
    yield* membershipRepository.setTeamMember({ shop, teamId, memberId, inTeam });
    const closed = yield* close("Membership.setTeamMember", [memberId]);
    const outcome = inTeam ? "added" : "removed";
    yield* log(
      `Membership.setTeamMember: shop=${shop} teamId=${teamId}: ${outcome} memberId=${memberId} closed=${closed}`,
      { teamId, memberId, outcome, closed },
    );
  });

  const createTeam = Effect.fn("Membership.createTeam")(function* ({ name }: CreateTeamInput) {
    const team = yield* membershipRepository.createTeam({ shop, name });
    yield* log(`Membership.createTeam: shop=${shop} teamId=${team.id}: created closed=0`, {
      teamId: team.id,
      closed: 0,
    });
    return team;
  });

  const renameTeam = Effect.fn("Membership.renameTeam")(function* ({
    teamId,
    name,
  }: RenameTeamInput) {
    yield* membershipRepository.renameTeam({ shop, id: teamId, name });
    yield* log(`Membership.renameTeam: shop=${shop} teamId=${teamId}: renamed closed=0`, {
      teamId,
      closed: 0,
    });
  });

  const addTeamMembers = Effect.fn("Membership.addTeamMembers")(function* ({
    teamId,
    memberIds,
  }: AddTeamMembersInput) {
    yield* membershipRepository.addTeamMembers({ shop, teamId, memberIds });
    const closed = yield* close("Membership.addTeamMembers", memberIds);
    yield* log(
      `Membership.addTeamMembers: shop=${shop} teamId=${teamId}: added members=${memberIds.length} closed=${closed}`,
      { teamId, members: memberIds.length, closed },
    );
  });

  /**
   * Legacy's `deleteTeam` callable: `NotFound` is an answer, not a failure, and closes
   * nobody; `MembershipRepository.deleteTeam` reads the team's members before the edges cascade.
   *
   * Delete a team and its tasks become unassigned. Two stores, two writes, D1 first: the two
   * cannot share a transaction, and the order is what closes the race with a concurrent
   * `addStep` / `updateTask` pointing at this team. Its `teamExists` check reads D1; if that
   * read lands after the D1 delete the write is refused, and if it lands before but the task
   * write lands before the nulling, the nulling catches it. The reverse order would let a task
   * written between the nulling and the D1 delete validate fine and dangle forever. What
   * remains is the nulling failing after the D1 row is gone; every read already treats an id
   * no team carries as unassigned, so that state is self-healing, and a retry of this call
   * (which answers `NotFound` for the row but still runs the nulling) repairs it. So does the
   * next delete of any team in the shop: it also nulls every pointer to a team gone from D1.
   * The actor's ids in use are read before the shop's teams, so a team created between the
   * two reads, and a task pointed at it, is not among the candidates and is never nulled.
   * Nothing is refused for being in use: the merchant decides.
   *
   * Then the reconcile seam (a workflow whose task lost its team stops being eligible), the
   * closes, and a notice on both answers: a `NotFound` still nulled pointers, which the lists
   * show.
   */
  const deleteTeam = Effect.fn("Membership.deleteTeam")(function* ({ teamId }: DeleteTeamInput) {
    const deleted = yield* membershipRepository.deleteTeam({ shop, id: teamId }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("TeamNotFoundError", () =>
        Effect.succeed(Option.none<ReadonlyArray<MemberId>>()),
      ),
    );
    const inUse = yield* workflowRepository.teamIdsInUse().pipe(Effect.orDie);
    const live = new Set<string>(
      (yield* membershipRepository.listTeams(shop)).map((team) => team.id),
    );
    const gone = new Set<string>([teamId, ...inUse.filter((candidate) => !live.has(candidate))]);
    yield* Effect.forEach(gone, (goneId) => workflowRepository.unassignTeam({ teamId: goneId }), {
      discard: true,
    }).pipe(Effect.orDie);
    yield* reconcileAll("deleteTeam", teamId);
    const closed = Option.isSome(deleted)
      ? yield* close("Membership.deleteTeam", deleted.value)
      : 0;
    const outcome = Option.isSome(deleted) ? "deleted" : "not-found";
    yield* log(
      `Membership.deleteTeam: shop=${shop} teamId=${teamId}: ${outcome} closed=${closed} unassigned=${gone.size}`,
      {
        teamId,
        outcome,
        closed,
        unassigned: gone.size,
      },
    );
    yield* notify([ORDERS_KEY]);
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
