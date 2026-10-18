import type { ReactNode } from "react";
import type { WorkflowsListPageData } from "../../contract/workflows-list.ts";
import { type Email, formatNumber } from "../../domain/platform.ts";
import {
  type Actor,
  actorIsMember,
  actorLabel,
  itemPiece,
  itemTitle,
  type ListSearch,
  type RecentItem,
  RUN_LIMIT_MAX,
  RUN_PAGE,
  type Run,
  type RunListItem,
  type RunListRun,
  type RunListTask,
  type RunTask,
  runActions,
  runIsBlocked,
  runRowLines,
  rowShowsTeam,
  searchTerm,
  searchTermText,
  TASK_STATE_LABEL,
  taskActions,
  taskDoneBy,
  type TeamId,
  VERB_LABEL,
  workflowNamesItem,
  type WorkflowsListState,
  workflowsListStateIsDone,
} from "../../domain/shop-work.ts";
import { memberRunsAtom, seedWorkflowsList } from "../client/shop-actor-client.ts";
import { ANY_OPTION_VALUE } from "./form.ts";
import { useLiveRead } from "./live-read.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import { useMemberRunActions } from "./member-run-actions.ts";
import { ClosedLine } from "./MemberRun.tsx";
import { Clamp } from "./screen/Clamp.tsx";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { FilterRow } from "./screen/FilterRow.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";
import { ListSearchField } from "./screen/ListSearchField.tsx";
import { Name } from "./screen/Name.tsx";
import { ResourceRow, type RowHead, RowLine } from "./screen/ResourceRow.tsx";
import { SearchLine } from "./screen/SearchLine.tsx";
import { ShowMore } from "./screen/ShowMore.tsx";
import { Strip } from "./screen/Strip.tsx";
import { SEARCH_EMPTY, STATE_EMPTY, STATE_LABEL, STATES } from "./workflows-list-states.ts";

/**
 * A change to the member's context in the URL: each key given replaces the URL's, `null` removes
 * it (the default). A state, a team or a search is a different list, so the route resets the
 * depth with each of them.
 */
export interface WorkflowsListPatch {
  readonly state?: WorkflowsListState;
  readonly team?: TeamId | null;
  readonly q?: ListSearch | null;
  readonly limit?: number;
}

/** A row's link to the member's workflow page: the real `href` and the client navigation. */
export interface WorkflowLink {
  readonly href: string;
  readonly onNavigate: () => void;
}

/**
 * Line one of every row ({@link ResourceRow}): the order number, then the piece
 * ({@link itemPiece}), then `×n`. The order number is the row's, not the piece's, so the row puts
 * it there.
 */
const headOf = (run: RunListRun | Run): RowHead => {
  const piece = itemPiece(run);
  return { lead: run.orderName, title: piece.name, trail: piece.quantity };
};

/**
 * The workflow name on a Done or closed row, when it differs from the item
 * ({@link workflowNamesItem}), as on an open row; no step, because a done task's step is history
 * and a {@link RecentItem} carries no step count.
 */
const workflowLine = (run: Run) =>
  workflowNamesItem(run) ? null : (
    <RowLine>
      <Name color="subdued">{run.workflowName}</Name>
    </RowLine>
  );

/**
 * Who did a Done or closed task entry, spelled as the open rows spell an actor: `you` for the
 * reader, the email for anybody else, `Merchant` for the merchant. Your own address repeated down
 * a page is the noisiest text on the list and the least informative line on it. Empty rather than
 * "nobody" for a task with no recorded doer.
 */
const doneActorLabel = (task: RunTask, memberEmail: Email) => {
  const actor = taskDoneBy(task);
  if (actor === null) return "";
  return actorIsMember(actor, memberEmail) ? "you" : actorLabel(actor, "member");
};

/**
 * The member's workflows list, the member area's landing page: their teams' current work by
 * state, a Team select for a member on two or more teams, the search, one row per run, and Show
 * more. A live screen, one tree from the server's render through hydration: the loader paints the
 * query the URL names, then `MemberListRuns` over the member's socket keeps it current
 * ({@link useLiveRead}), so another member's Done lands here without a reload. The list is
 * narrowed by the teams on the connection, so the browser names none of them: `query` only
 * chooses among them. No toasts in the member area: a write's answer is the list moving, or the
 * banner when it was refused.
 *
 * Every control is a navigation, because the whole query is in the URL (`MemberSearch`), so a
 * return from the workflow page paints the list the member left.
 */
export default function WorkflowsListPage({
  data,
  onSearch,
  workflowLink,
}: {
  readonly data: WorkflowsListPageData;
  readonly onSearch: (patch: WorkflowsListPatch) => void;
  readonly workflowLink: (runId: string) => WorkflowLink;
}) {
  const { memberId, memberEmail, teams, query } = data;
  const { state, team, limit, q } = query;
  const read = useLiveRead({
    atom: memberRunsAtom(query),
    key: JSON.stringify([state, team, limit, q]),
    loaded: data.list,
    seed: (registry, list) => {
      seedWorkflowsList(registry, { query, list });
    },
  });
  const list = read.value;
  const actions = useMemberRunActions();
  /** The member as the actor every row's action set is computed for. */
  const actor: Actor = {
    role: "member",
    memberId,
    email: memberEmail,
    teamIds: teams.map(({ id }) => id),
  };

  const selectState = (next: WorkflowsListState) => {
    if (next !== state) onSearch({ state: next });
  };
  const setSearch = (next: ListSearch | null) => {
    onSearch({ q: next });
  };
  const showMore = () => {
    onSearch({ limit: Math.min(limit + RUN_PAGE, RUN_LIMIT_MAX) });
  };

  const showTeam = rowShowsTeam(teams.length, team, q);

  /** The row's link: the real `href`, the client navigation, and a label that names the piece whole. */
  const linkOf = (run: RunListRun | Run) => ({
    ...workflowLink(run.id),
    accessibilityLabel: `Open ${itemTitle(run)} on ${run.orderName}`,
  });

  /**
   * One row per run ({@link ResourceRow}): the whole row is one link to the workflow page, and the
   * menu beside line one is the only thing in it that is not. One kind of fact per line: line one
   * is the order and the piece; then one line per current task, `Task (Team) · <state>`, then the
   * block reason clamped to two lines when there is one; last the recipe, `Step k of n`, after the
   * workflow name when it differs from the item. What each line prints, and when, is
   * {@link runRowLines}; the row only places them.
   */
  const renderItem = (item: RunListItem) => {
    const { run, tasks } = item;
    const lines = runRowLines(item, { memberEmail, showTeam, state: q === null ? state : null });
    /**
     * Every verb the row offers, inside the row's menu: no labelled verb and no primary. Each is a
     * field of {@link runActions} or {@link taskActions}; the row decides only which of the
     * allowed verbs it lists. A blocked run lists Unblock alone: Start on a held run is the row
     * arguing with itself. An unstarted task lists Start and not Done, although Done is allowed
     * there: the row walks the member through the task one verb at a time, and Done straight away
     * is one tap on the workflow page. A started task also gets Put back, the one-press fix for a
     * Start pressed by mistake, for the whole team. A single current task gives the bare verb;
     * several give one item each, named, because a single verb would act on the first and say
     * nothing about the rest.
     *
     * Every task on a row is current (the run repository's `runListItems` returns current tasks
     * only), and none is done, so no later step has started.
     */
    const menuItems = (): ReactNode[] => {
      if (runIsBlocked(run))
        return runActions(
          actor,
          item.order,
          run,
          tasks.map((each) => ({ ...each, current: true })),
        ).unblock
          ? [
              <s-button key="unblock" onClick={() => void actions.unblock(run.id)}>
                {VERB_LABEL.unblock.member}
              </s-button>,
            ]
          : [];
      const named = (verb: "start" | "done" | "putBack", each: RunListTask) =>
        tasks.length > 1 ? `${VERB_LABEL[verb].member} · ${each.name}` : VERB_LABEL[verb].member;
      return tasks.flatMap((each) => {
        const can = taskActions(actor, item.order, run, {
          ...each,
          current: true,
          doneAt: null,
          laterStepStarted: false,
        });
        if (can.start)
          return [
            <s-button key={each.id} onClick={() => void actions.start(each.id)}>
              {named("start", each)}
            </s-button>,
          ];
        return [
          ...(can.done
            ? [
                <s-button key={each.id} onClick={() => void actions.markDone(each.id)}>
                  {named("done", each)}
                </s-button>,
              ]
            : []),
          ...(can.putBack
            ? [
                <s-button key={`${each.id}-put-back`} onClick={() => void actions.putBack(each.id)}>
                  {named("putBack", each)}
                </s-button>,
              ]
            : []),
        ];
      });
    };
    const items = menuItems();
    return (
      <ResourceRow
        key={run.id}
        head={headOf(run)}
        menu={
          items.length > 0
            ? { label: `Actions for ${run.orderName}`, disabled: actions.pending, items }
            : null
        }
        {...linkOf(run)}
      >
        {lines.tasks.map((each) => (
          <RowLine key={each.id}>
            <Name>{each.name}</Name>
            {each.team !== null && <s-text color="subdued">{` (${each.team})`}</s-text>}
            {each.state !== null && <s-text color="subdued">{` · ${each.state}`}</s-text>}
          </RowLine>
        ))}
        {lines.block !== null && (
          <RowLine>
            <Clamp color="subdued">{lines.block}</Clamp>
          </RowLine>
        )}
        <RowLine>
          {lines.recipe.workflow !== null && <Name color="subdued">{lines.recipe.workflow}</Name>}
          <s-text color="subdued">
            {lines.recipe.workflow === null ? lines.recipe.step : ` · ${lines.recipe.step}`}
          </s-text>
        </RowLine>
      </ResourceRow>
    );
  };

  /** The same rule as the workflow page's Undo, {@link taskActions}' `reopen`, on the list's own row. */
  const reopenOf = (entry: Extract<RecentItem, { kind: "task" }>) =>
    taskActions(actor, entry.order, entry.run, {
      ...entry.task,
      current: false,
      laterStepStarted: entry.laterStepStarted,
    }).reopen;

  /**
   * A done task's row, the same shape as an open one: the row is a link to the workflow page and a
   * menu beside line one holds Undo. Then the task and who did it when, and the note clamped to
   * two lines when there is one. The menu is there only while Undo is allowed: reopen is refused
   * the moment anything downstream starts, so on a busy shop most rows could offer nothing, and a
   * disabled button explaining itself on each would be the noise. The workflow page the row links
   * to shows the later step's task started, for the reader who went looking.
   */
  const renderDone = (entry: Extract<RecentItem, { kind: "task" }>) => (
    <ResourceRow
      key={entry.task.id}
      head={headOf(entry.run)}
      menu={
        reopenOf(entry)
          ? {
              label: `Actions for ${entry.run.orderName}`,
              disabled: actions.pending,
              items: (
                <s-button onClick={() => void actions.reopen(entry.task.id)}>
                  {VERB_LABEL.reopen.member}
                </s-button>
              ),
            }
          : null
      }
      {...linkOf(entry.run)}
    >
      <RowLine>
        <Name>{entry.task.name}</Name>
        <s-text color="subdued">
          {` · ${TASK_STATE_LABEL.done} by ${doneActorLabel(entry.task, memberEmail)} · `}
          <LocalDateTime value={entry.task.doneAt ?? 0} format="time" />
        </s-text>
      </RowLine>
      {entry.run.note !== null && (
        <RowLine>
          <Clamp color="subdued">{`Note: ${entry.run.note}`}</Clamp>
        </RowLine>
      )}
      {workflowLine(entry.run)}
    </ResourceRow>
  );

  /**
   * A closed run's Done or closed row ({@link RecentItem}): line one the order and the piece, then
   * "Closed · <reason> · <time>" ({@link ClosedLine}), then the workflow name when it differs
   * from the item. A link to the workflow page and nothing else: closing is a notice, not a to-do,
   * and a closed run offers no verb but the note.
   */
  const renderClosed = (entry: Extract<RecentItem, { kind: "closed" }>) => (
    <ResourceRow
      key={`closed-${entry.run.id}`}
      head={headOf(entry.run)}
      menu={null}
      {...linkOf(entry.run)}
    >
      <RowLine>
        <ClosedLine run={entry.run} viewer="member" prefix />
      </RowLine>
      {workflowLine(entry.run)}
    </ResourceRow>
  );

  const renderRecent = (entry: RecentItem) =>
    entry.kind === "task" ? renderDone(entry) : renderClosed(entry);

  /**
   * The deeper read ({@link ShowMore}): it asks the actor for more rather than revealing rows the
   * page holds. At {@link RUN_LIMIT_MAX} there is no deeper read, so a sentence takes the button's
   * place: how many show and what narrows the list to the rest, the search, and the Team select
   * when there is one to choose. Under a search the team is ignored, so the search is the only
   * thing to narrow.
   */
  const renderMore = (shown: number, total: number) => {
    const narrow =
      q !== null
        ? "Narrow the search to find the rest."
        : teams.length > 1 && team === null
          ? "Search or choose a team to find the rest."
          : "Search to find the rest.";
    return (
      <ShowMore
        hidden={total - shown}
        page={RUN_PAGE}
        end={
          limit >= RUN_LIMIT_MAX
            ? `Showing ${formatNumber(shown)} of ${formatNumber(total)}. ${narrow}`
            : null
        }
        onShowMore={showMore}
      />
    );
  };

  /**
   * The team filter, a select rather than buttons because the team list is unbounded. Its options
   * are names only: the strip beside it counts the chosen team's states, so a count in the closed
   * select would be a number over a different set of rows. The first option is Any team
   * ({@link ANY_OPTION_VALUE}). A team the member is not on already reads as Any team (the
   * Backend resolves it), so there is no Deleted team option. Its label is hidden on screen and
   * kept for screen readers. Rendered only for a member on more than one team; disabled under a
   * search, which ignores the team, and it keeps its value so Clear search restores the list it
   * describes.
   */
  const teamSelect =
    teams.length > 1 ? (
      <s-select
        label="Team"
        labelAccessibilityVisibility="exclusive"
        value={team ?? ANY_OPTION_VALUE}
        disabled={q !== null}
        onChange={(event) => {
          const value = event.currentTarget.value;
          onSearch({ team: teams.find(({ id }) => id === value)?.id ?? null });
        }}
      >
        <s-option value={ANY_OPTION_VALUE}>Any team</s-option>
        {teams.map(({ id, name }) => (
          <s-option key={id} value={id}>
            {name}
          </s-option>
        ))}
      </s-select>
    ) : null;

  /**
   * The strip ({@link Strip}), the state filter and the only one, and the page's heading now that
   * the page has none: every state with its count, the chosen one filled. A zero-count state stays
   * enabled, because an empty list with its empty state is a valid screen to land on. No cell is
   * red: a member is not usually the one who clears a block.
   */
  const strip = (
    <Strip
      cells={STATES.map((each) => ({
        key: each,
        label: STATE_LABEL[each],
        count: list.counts[each],
        chosen: each === state,
        onSelect: () => {
          selectState(each);
        },
      }))}
    />
  );

  /** The search, then the Team select; with one team the search is alone and full width. */
  const filterRow = (
    <FilterRow
      search={
        <ListSearchField value={q} placeholder="Search by order or item" onSubmit={setSearch} />
      }
      secondary={teamSelect}
    />
  );

  const banner =
    actions.banner === null ? null : <s-banner tone="critical">{actions.banner}</s-banner>;

  /**
   * The way out of an empty state; none when there is nowhere worth sending the reader. "Go to"
   * rather than the bare label, so the button cannot be confused with the strip cell above it.
   */
  const renderEmpty = () => {
    const goTo = STATE_EMPTY[state].goTo;
    return (
      <EmptyLine
        action={
          goTo !== null && list.counts[goTo] > 0 ? (
            <s-button variant="tertiary" onClick={() => selectState(goTo)}>
              {`Go to ${STATE_LABEL[goTo]}`}
            </s-button>
          ) : undefined
        }
      >
        {STATE_EMPTY[state].text}
      </EmptyLine>
    );
  };

  const renderRows = () => {
    const total = list.counts[state];
    const done = workflowsListStateIsDone(state);
    const shown = done ? list.recent.length : list.items.length;
    if (total === 0) return renderEmpty();
    return (
      <>
        {done ? list.recent.map(renderRecent) : list.items.map(renderItem)}
        {total > shown && renderMore(shown, total)}
      </>
    );
  };

  /**
   * Under a search (`RunQuery`, which ignores the state and the team): the strip gives way to one
   * line, how many rows match and Clear search ({@link SearchLine}); the rows are the open matches,
   * then the Done or closed matches in a section of their own, so a member who marked the wrong
   * thing done finds it by number. N is every match before the cut, each half is cut to the depth,
   * and Show more, at the foot of the last list, deepens both. Nothing matching is one sentence and
   * Clear search in the list's place.
   */
  const renderSearch = (text: string) => {
    const shown = list.items.length + list.recent.length;
    const matches = list.matches ?? shown;
    const more = matches > shown ? renderMore(shown, matches) : null;
    const clear = () => {
      setSearch(null);
    };
    if (matches === 0)
      return (
        <IndexSection
          label="Workflows"
          head={
            <>
              {banner}
              {filterRow}
            </>
          }
        >
          <EmptyLine
            action={
              <s-button variant="tertiary" onClick={clear}>
                Clear search
              </s-button>
            }
          >{`${SEARCH_EMPTY} ${text}`}</EmptyLine>
        </IndexSection>
      );
    return (
      <>
        <IndexSection
          label="Workflows"
          head={
            <>
              {banner}
              <SearchLine
                count={matches}
                noun={["workflow", "workflows"]}
                term={text}
                onClear={clear}
              />
              {filterRow}
            </>
          }
        >
          {list.items.map(renderItem)}
          {list.recent.length === 0 && more}
        </IndexSection>
        {list.recent.length > 0 && (
          <IndexSection label={STATE_LABEL.done} head={<s-heading>{STATE_LABEL.done}</s-heading>}>
            {list.recent.map(renderRecent)}
            {more}
          </IndexSection>
        )}
      </>
    );
  };

  const renderBody = () => {
    if (teams.length === 0)
      return (
        <IndexSection label="Workflows">
          <EmptyLine>You’re not on a team yet. Ask the merchant to add you to a team.</EmptyLine>
        </IndexSection>
      );
    if (q !== null) return renderSearch(searchTermText(searchTerm(q)));
    return (
      <IndexSection
        label="Workflows"
        head={
          <>
            {banner}
            {strip}
            {filterRow}
          </>
        }
      >
        {renderRows()}
      </IndexSection>
    );
  };

  // No `heading`: the strip says the same word and more with it, and a heading block above the
  // fold is what a bench tablet has least of. "Workflows" is in the document title and the
  // section's accessibility label.
  return <s-page inlineSize="small">{renderBody()}</s-page>;
}
