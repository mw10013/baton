import { Effect, Match, Schema } from "effect";

import * as Domain from "@/lib/Domain";

/**
 * Copy and helpers shared by the teams index, the team page, the members
 * index and the member page, and the delete copy the workflow pages read.
 * Lives here rather than on an index route so an index does not own delete
 * copy it never renders: deletion happens on the detail page only.
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
 * Every delete dialog's body ends with this, the `confirm` slot (`CopySlot`
 * in `Screen.ts`), and it never explains how the product works, so it never
 * goes stale. The heading names what is deleted; a member's dialog, whose
 * heading cannot carry an email, puts the email in a first sentence before
 * this one, and a workflow's names what it leaves going
 * (`DELETE_WORKFLOW_BODY` in `workflowShared.ts`).
 */
export const DELETE_CONFIRM = "This can't be undone.";

/**
 * The toast after a delete, the `toast` slot: "<Noun> deleted", shown on the
 * index the delete lands on.
 */
export const DELETED_TOAST = {
  team: "Team deleted",
  workflow: "Workflow deleted",
  member: "Member deleted",
} as const;

/**
 * Below this many candidates the Add members and Add to teams dialogs leave
 * their search field out: a search box over three rows is chrome the merchant
 * has to read past.
 */
export const SEARCH_FROM = 6;

/**
 * Rows per page of a merchant table, the controls table's "a merchant table
 * with more rows than its page" row (`Control` in `Screen.ts`): 25 on an
 * index, 10 on a details page.
 */
export const INDEX_PAGE_SIZE = 25;
export const DETAILS_PAGE_SIZE = 10;
