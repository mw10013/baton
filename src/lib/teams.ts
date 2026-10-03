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

/**
 * The delete dialog's body, the `confirm` slot (`CopySlot` in `Screen.ts`):
 * what the delete does, in the merchant copy of `Domain.Team`. One sentence
 * for every team, so the dialog reads nothing from the object.
 */
export const DELETE_TEAM_CONFIRM =
  "Tasks on this team become unassigned until you assign another team.";
