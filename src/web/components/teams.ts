import * as Cause from "effect/Cause";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  MemberCeilingError,
  MemberNotFoundError,
  TeamLimitError,
  TeamNameTakenError,
  TeamNotFoundError,
} from "../../contract/members.ts";
import { ShopLimits } from "../../domain/platform.ts";
import { thrownCopy } from "./form.ts";

/**
 * Copy and helpers shared by the teams index, the team page, the members index and the member
 * page. Lives here rather than on an index route so an index does not own delete copy it never
 * renders: deletion happens on the detail page only.
 */

export const NAME_TAKEN = "A team with that name already exists.";
export const TEAM_GONE = "That team no longer exists.";
export const MEMBER_GONE = "That member no longer exists.";
export const MEMBER_CEILING = `A shop can have ${String(ShopLimits.maxMembers)} members.`;

/** The team limit's refusal, naming the limit the refusal carries. */
export const teamLimitMessage = (limit: number) =>
  `A shop can have ${String(limit)} teams. Delete one to add another.`;

/**
 * Every delete dialog's body ends with this, the `confirm` slot, and it never explains how the
 * product works, so it never goes stale. The heading names what is deleted; a member's dialog,
 * whose heading cannot carry an email, puts the email in a first sentence before this one.
 */
export const DELETE_CONFIRM = "This can't be undone.";

/** The toast after a delete, the `toast` slot: "<Noun> deleted", shown on the index it lands on. */
export const DELETED_TOAST = {
  team: "Team deleted",
  member: "Member deleted",
  workflow: "Workflow deleted",
} as const;

/**
 * Below this many candidates the Add members and Add to teams dialogs leave their search field
 * out: a search box over three rows is chrome the merchant has to read past.
 */
export const SEARCH_FROM = 6;

const MemberTeamFailure = Schema.Union([
  MemberCeilingError,
  MemberNotFoundError,
  TeamLimitError,
  TeamNameTakenError,
  TeamNotFoundError,
]);
const isMemberTeamFailure = Schema.is(MemberTeamFailure);

/**
 * A member or team press that failed, as the page says it: a refusal the procedure declares in
 * merchant copy (legacy's `failWith`), anything else (a lost socket, a defect) in
 * {@link thrownCopy}'s, with `fallback`.
 */
export const pressFailureCopy = (cause: Cause.Cause<unknown>, fallback: string) => {
  const error = Cause.squash(cause);
  if (!isMemberTeamFailure(error)) return thrownCopy(error, fallback);
  return Match.valueTags(error, {
    MemberCeilingError: () => MEMBER_CEILING,
    MemberNotFoundError: () => MEMBER_GONE,
    TeamLimitError: ({ limit }) => teamLimitMessage(limit),
    TeamNameTakenError: () => NAME_TAKEN,
    TeamNotFoundError: () => TEAM_GONE,
  });
};
