import * as Schema from "effect/Schema";
import { Email, ShopLimits, ShopKey } from "../domain/platform.ts";
import { ListSearch, MemberId, TeamId, TeamName } from "../domain/shop-work.ts";

/**
 * The shop's members are at their ceiling (`membersAtCeiling`) and the email is not already a
 * member.
 */
export class MemberCeilingError extends Schema.TaggedError<MemberCeilingError>()(
  "MemberCeilingError",
  { shop: ShopKey, limit: Schema.Number },
) {}

/** The shop is at `ShopLimits.maxTeams`. */
export class TeamLimitError extends Schema.TaggedError<TeamLimitError>()("TeamLimitError", {
  shop: ShopKey,
  limit: Schema.Number,
}) {}

/**
 * The shop already has a team by that exact name. Detected by the
 * write returning no row under `or ignore` rather than by matching D1's
 * constraint-violation text, which is neither typed nor stable.
 */
export class TeamNameTakenError extends Schema.TaggedError<TeamNameTakenError>()(
  "TeamNameTakenError",
  { shop: ShopKey, name: TeamName },
) {}

/**
 * No team in this shop is addressable by that id for the attempted write.
 * Membership removal never fails this way (see `MembershipRepository.setTeamMember`).
 */
export class TeamNotFoundError extends Schema.TaggedError<TeamNotFoundError>()(
  "TeamNotFoundError",
  { shop: ShopKey, teamId: TeamId },
) {}

/**
 * No member in this shop is addressable by that email or id for the attempted
 * write; `member` is whichever the caller addressed it by. Membership removal
 * never fails this way (see `MembershipRepository.setTeamMember`).
 */
export class MemberNotFoundError extends Schema.TaggedError<MemberNotFoundError>()(
  "MemberNotFoundError",
  { shop: ShopKey, member: Schema.String },
) {}

/** `MerchantAddMember`'s payload: the email to add, trimmed and lowercased on decode. */
export const AddMemberInput = Schema.Struct({ email: Email });
export type AddMemberInput = typeof AddMemberInput.Type;

/**
 * `MerchantDeleteMember`'s payload: by email, because the delete answers the id the revoke
 * closes.
 */
export const DeleteMemberInput = Schema.Struct({ email: Email });
export type DeleteMemberInput = typeof DeleteMemberInput.Type;

/** `MerchantAddMemberTeams`' payload: one member onto at most `ShopLimits.maxTeams` teams. */
export const AddMemberTeamsInput = Schema.Struct({
  memberId: MemberId,
  teamIds: Schema.Array(TeamId).check(Schema.isMaxLength(ShopLimits.maxTeams)),
});
export type AddMemberTeamsInput = typeof AddMemberTeamsInput.Type;

/** `MerchantSetTeamMember`'s payload: puts the member on the team, or takes them off. */
export const SetTeamMemberInput = Schema.Struct({
  teamId: TeamId,
  memberId: MemberId,
  inTeam: Schema.Boolean,
});
export type SetTeamMemberInput = typeof SetTeamMemberInput.Type;

/** `MerchantCreateTeam`'s payload: the name, trimmed on decode. */
export const CreateTeamInput = Schema.Struct({ name: TeamName });
export type CreateTeamInput = typeof CreateTeamInput.Type;

/** `MerchantRenameTeam`'s payload. */
export const RenameTeamInput = Schema.Struct({ teamId: TeamId, name: TeamName });
export type RenameTeamInput = typeof RenameTeamInput.Type;

/** `MerchantAddTeamMembers`' payload: at most `ShopLimits.maxMembers` members onto one team. */
export const AddTeamMembersInput = Schema.Struct({
  teamId: TeamId,
  memberIds: Schema.Array(MemberId).check(Schema.isMaxLength(ShopLimits.maxMembers)),
});
export type AddTeamMembersInput = typeof AddTeamMembersInput.Type;

/** `MerchantDeleteTeam`'s payload. */
export const DeleteTeamInput = Schema.Struct({ teamId: TeamId });
export type DeleteTeamInput = typeof DeleteTeamInput.Type;

/**
 * Rows per page of a merchant table, the controls table's "a merchant table
 * with more rows than its page" row: 25 on an index, 10 on a details page. The Backend's page reads use them, and the screens'
 * paging reads the page they answer.
 */
export const INDEX_PAGE_SIZE = 25;
export const DETAILS_PAGE_SIZE = 10;

const sessionToken = Schema.NonEmptyString;

/**
 * `BackendApi.membersPage`' input: the merchant's session token, which names the shop, then the
 * members index's search and page (`MembershipRepository.listMembersPage`). The route reads both leniently
 * from its URL, so a value here has already decoded.
 */
export const MembersPageRequest = Schema.Struct({
  sessionToken,
  q: Schema.NullOr(ListSearch),
  after: Schema.NullOr(Email),
});
export type MembersPageRequest = typeof MembersPageRequest.Type;

/** `BackendApi.memberDetail`' input: the member, and the Teams table's page. */
export const MemberDetailRequest = Schema.Struct({
  sessionToken,
  memberId: MemberId,
  teamsAfter: Schema.NullOr(TeamName),
});
export type MemberDetailRequest = typeof MemberDetailRequest.Type;

/** `BackendApi.teamsPage`' input: the teams index's search and page (`MembershipRepository.listTeamsPage`). */
export const TeamsPageRequest = Schema.Struct({
  sessionToken,
  q: Schema.NullOr(ListSearch),
  after: Schema.NullOr(TeamName),
});
export type TeamsPageRequest = typeof TeamsPageRequest.Type;

/** `BackendApi.teamDetail`' input: the team, and the Members table's page. */
export const TeamDetailRequest = Schema.Struct({
  sessionToken,
  teamId: TeamId,
  membersAfter: Schema.NullOr(Email),
});
export type TeamDetailRequest = typeof TeamDetailRequest.Type;
