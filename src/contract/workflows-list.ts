/**
 * The member's two screens' first paints, as both sides of the binding read them: the
 * workflows list and the member's workflow page. The browser names the shop and what it asks
 * for; who the member is (`memberId`, `memberEmail`, `teamIds`) is resolved by the Backend's
 * gate from the cookie, never sent. The live reads and every write are socket procedures
 * (`MemberListRuns`, `MemberGetRun`, the member's run writes).
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { BoundedId, Email } from "../domain/platform.ts";
import {
  ListSearch,
  MemberAccess,
  MemberId,
  RunLimit,
  RunPageData,
  RunQuery,
  TEAM_SEARCH_MAX,
  WorkflowsListData,
  WorkflowsListState,
} from "../domain/shop-work.ts";
import { ShopKey } from "./shop.ts";

/**
 * `BackendApi.workflowsList`' input: the shop and the query the URL carries. `team` is the
 * URL's text, resolved by the Backend against the member's teams: a team the member is not on
 * (one they were taken off, a hand-edited id) reads as any team, never as an empty list.
 */
export const WorkflowsListRequest = Schema.Struct({
  key: ShopKey,
  state: WorkflowsListState,
  team: Schema.NullOr(Schema.String.check(Schema.isMaxLength(TEAM_SEARCH_MAX))),
  limit: RunLimit,
  q: Schema.NullOr(ListSearch),
});
export type WorkflowsListRequest = typeof WorkflowsListRequest.Type;

/**
 * The workflows list's first paint: who the member is, their teams (id and name, for the Team
 * select), the query as the Backend resolved it, and the list it read. The query comes back
 * beside the list so the rows can seed the socket query for exactly that query.
 */
export const WorkflowsListPageData = Schema.Struct({
  memberId: MemberId,
  memberEmail: Email,
  teams: MemberAccess.fields.teams,
  query: RunQuery,
  list: WorkflowsListData,
});
export type WorkflowsListPageData = typeof WorkflowsListPageData.Type;

/** `BackendApi.memberWorkflowPage`' input: the shop and the run the URL names. */
export const MemberWorkflowPageRequest = Schema.Struct({ key: ShopKey, runId: BoundedId });
export type MemberWorkflowPageRequest = typeof MemberWorkflowPageRequest.Type;

/**
 * The member's workflow page's first paint: who the member is, their teams, and the page, or
 * `null` for a run that is not there or holds no task of the member's teams (one answer for
 * both, so a member cannot probe run ids).
 */
export const MemberWorkflowPageData = Schema.Struct({
  memberId: MemberId,
  memberEmail: Email,
  teams: MemberAccess.fields.teams,
  page: Schema.NullOr(RunPageData),
});
export type MemberWorkflowPageData = typeof MemberWorkflowPageData.Type;
