import * as Schema from "effect/Schema";
import { TeamId, TeamName } from "../domain/shop-work.ts";
import { ShopKey } from "./shop.ts";

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
 * Membership removal never fails this way (see `Members.setTeamMember`).
 */
export class TeamNotFoundError extends Schema.TaggedError<TeamNotFoundError>()(
  "TeamNotFoundError",
  { shop: ShopKey, teamId: TeamId },
) {}

/**
 * No member in this shop is addressable by that email or id for the attempted
 * write; `member` is whichever the caller addressed it by. Membership removal
 * never fails this way (see `Members.setTeamMember`).
 */
export class MemberNotFoundError extends Schema.TaggedError<MemberNotFoundError>()(
  "MemberNotFoundError",
  { shop: ShopKey, member: Schema.String },
) {}
