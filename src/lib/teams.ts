import { Effect, Match, Schema } from "effect";

import * as Domain from "@/lib/Domain";

/**
 * Copy and helpers shared by the team pages (`app.teams.index`,
 * `app.teams.$teamId`) and the members page. Lives here rather than on the
 * teams index route so the index does not own delete copy it no longer
 * renders: deletion happens on the detail page only.
 */

export const decodeName = Schema.decodeUnknownEffect(Domain.TeamName);
export const sessionShop = (shop: string) =>
  Schema.decodeUnknownEffect(Domain.Shop)(shop);

/**
 * Tagged repository failures are merchant-facing here, so they are replaced by
 * copy before they reach the worker seam: that seam renders whatever it catches
 * through `causeToErrorMessage`, which would otherwise surface the tag name in
 * a banner. A bare `Error` renders as its message alone.
 */
export const failWith = (message: string) => () =>
  Effect.fail(new Error(message));

export const NAME_TAKEN = "A team with that name already exists.";
export const TEAM_GONE = "That team no longer exists.";

export const decodeDeleteTeamResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DeleteTeamResult),
);

export const deleteTeamResultMessage = Match.typeTags<
  Domain.DeleteTeamResult,
  string | null
>()({
  Deleted: () => null,
  NotFound: () => TEAM_GONE,
});

export const NO_COUNTS: Domain.TeamDeleteCounts = {
  workflowSteps: 0,
  draftSteps: 0,
  openRunSteps: 0,
};

export const plural = (count: number, noun: string) =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The delete dialog's body, in the merchant copy of `Domain.Team`: what will
 * become unassigned, and what that means. Only true clauses are spoken.
 */
export const deleteTeamWarning = (counts: Domain.TeamDeleteCounts) => {
  const configured = counts.workflowSteps + counts.draftSteps;
  const parts = [
    ...(configured > 0 ? [plural(configured, "workflow step")] : []),
    ...(counts.openRunSteps > 0
      ? [plural(counts.openRunSteps, "in-progress step")]
      : []),
  ];
  if (parts.length === 0)
    return "No workflow steps are assigned to it. This can't be undone.";
  const verb = configured + counts.openRunSteps === 1 ? "is" : "are";
  const consequences = [
    ...(configured > 0
      ? ["Workflows with unassigned steps stop starting for new orders"]
      : []),
    ...(counts.openRunSteps > 0
      ? ["in-progress steps wait until you assign a team"]
      : []),
  ];
  return `${parts.join(" and ")} ${verb} assigned to it. They will become unassigned. ${consequences.join(", and ")}.`;
};
