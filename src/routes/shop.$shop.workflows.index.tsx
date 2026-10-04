import * as React from "react";

import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { ListSearchField } from "@/components/ListSearchField";
import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberBar } from "@/components/MemberBar";
import { ClosedLine } from "@/components/MemberRun";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { ANY_OPTION_VALUE } from "@/lib/Screen";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import { useMemberRunActions } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";
import {
  SEARCH_EMPTY,
  STATE_EMPTY,
  STATE_LABEL,
  STATES,
} from "@/lib/workflowsListStates";

const LoaderInput = Schema.Struct({
  shop: Schema.String,
  state: Domain.WorkflowsListState,
  /** Text, not a {@link Domain.TeamId}: the member's teams resolve it (`MemberSearch` in `shop.$shop.tsx`). */
  team: Schema.String.check(Schema.isMaxLength(Domain.TEAM_SEARCH_MAX)),
  limit: Domain.RunLimit,
  q: Schema.NullOr(Domain.ListSearch),
});

/**
 * The member's
 * workflows list, which is the member area's landing page (`/shop/$shop`
 * redirects to it). `list` is the read of `query` — the state from the URL, every
 * team, one page deep — which is why `memberEmail` is here to be *sent* on
 * the socket's later reads rather than to group rows the page holds; it and
 * `memberId` come out of the same `requireMember` that resolved `teams`.
 * `query` travels with the list so the page can tell whether the socket is
 * about to ask for the same read ({@link Domain.sameRunQuery}) and hand these rows
 * over as `initialData`. `shop` is the `myshopify.com` domain — the Admin
 * API's display name is not stored anywhere in Baton, and the domain is what
 * the URL and every membership row key on.
 */
interface RunListLoaderData {
  readonly shop: Domain.Shop;
  readonly memberId: Domain.MemberId;
  readonly memberEmail: Domain.Email;
  readonly teams: Domain.MemberAccess["teams"];
  readonly query: Domain.RunQuery;
  readonly list: Domain.WorkflowsListData;
}

/**
 * The workflows list's first paint. SSR, so it cannot be a socket call: `requireMember`
 * resolves the shop and the member's teams from the cookie, and `listRuns`
 * reads the object through `ShopAgentClient`.
 *
 * The actions go the other way — over the member socket, where the same
 * `requireMember` result is already on the connection
 * (`useMemberRunActions`). Either way `teamIds`, `memberId`, and
 * `memberEmail` are resolved server-side and never sent by the browser.
 *
 * **The whole query comes from the URL, so the paint is the screen the member
 * left.** State, team, depth and search are the member's context (`MemberSearch` in
 * `shop.$shop.tsx`), which every link under `/shop/$shop` carries, so a return
 * from the workflow page server-renders narrowed and deepened rather than painting
 * page one of every team and correcting itself when the socket answers. The
 * query it read comes back beside the list, which is what lets these rows
 * serve as the socket query's `initialData` ({@link Domain.sameRunQuery}).
 *
 * `team` is resolved against the shop's live teams here, not trusted: a member taken
 * off a team keeps the id in their URL, and this is where it becomes "Any
 * team" rather than a read that returns nothing.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(LoaderInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const { shop, memberId, teams } = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        const query: Domain.RunQuery = {
          team: teams.find((team) => team.id === data.team)?.id ?? null,
          state: data.state,
          limit: data.limit,
          q: data.q,
        };
        const list = yield* (yield* ShopAgentClient).listRuns(shop, {
          teamIds: teams.map((team) => team.id),
          memberEmail: user.email,
          query,
        });
        return {
          shop,
          memberId,
          memberEmail: user.email,
          teams,
          query,
          list,
        } satisfies RunListLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/workflows/")({
  loaderDeps: ({ search }) => ({
    state: search.state ?? Domain.DEFAULT_WORKFLOWS_LIST_STATE,
    team: search.team ?? "",
    limit: search.limit ?? Domain.RUN_PAGE,
    q: search.q ?? null,
  }),
  loader: ({ params, deps }) =>
    getLoaderData({ data: { shop: params.shop, ...deps } }),
  /**
   * A query is a different loader key, so its first visit runs the loader once
   * and that read is the socket query's `initialData` for the new key; after
   * that the socket owns the data and pushes keep it current. Without this the
   * default `staleTime: 0` would re-run the loader on every return to a state,
   * team, depth or search whose data the socket already holds — which, now that all
   * four are in the URL, is every way back to this screen.
   */
  staleTime: Infinity,
  head: () => ({ meta: [{ title: "Workflows — Baton" }] }),
  component: RouteComponent,
});

/**
 * What every button inside a row must do first.
 *
 * `s-clickable` renders an `<a href>` in its shadow root and slots the row
 * into it — the shape Polaris's own resource-list composition uses
 * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/resource-list.md`,
 * "Provide search, filtering, and row selection for a resource list") — so a
 * click on a button inside the row reaches that anchor. `preventDefault` is
 * what stops the anchor navigating and `stopPropagation` is what stops the
 * row's own handler: neither does the other's job, because `stopPropagation`
 * silences listeners rather than an ancestor's default action. Verified
 * against the CDN `polaris.js` for both mouse and Enter.
 *
 * `s-menu` is the one thing this cannot cover: the menu puts an item's
 * activation on the row whatever the item's own handler does, so a row's menu
 * is rendered beside its clickable rather than inside it.
 */
const insideRow = (event: {
  preventDefault: () => void;
  stopPropagation: () => void;
}) => {
  event.preventDefault();
  event.stopPropagation();
};

/**
 * Line one of every row: the piece ({@link Domain.itemPiece}), its name
 * clamped to two lines and `×n` beside it outside the clamp, and the order
 * number in a cell of its own at the end. The count and the order number sit
 * outside the clamp because a clamp never reaches them: a long title ends in
 * an ellipsis and both stay on screen. The workflow name is not here. The
 * simple setup names a workflow after its product, so beside the item it
 * read as the item said twice, and the item already says which workflow the
 * row is; the name is line three's, beside the step.
 *
 * No Blocked badge: under Blocked it would repeat the filter, and elsewhere
 * the block line says it.
 */
function PieceLine({ run }: { readonly run: Domain.RunListRun | Domain.Run }) {
  const piece = Domain.itemPiece(run);
  return (
    <s-grid
      gridTemplateColumns="minmax(0, 1fr) auto"
      gap="small-300"
      alignItems="start"
    >
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <div className="run-line">
          {/* `.run-title-clip` in `styles.css` cuts it to two lines. */}
          <div className="run-title-clip">
            <s-text type="strong">{piece.name}</s-text>
          </div>
          {piece.quantity !== null && (
            <Keep>
              <s-text type="strong">{` ${piece.quantity}`}</s-text>
            </Keep>
          )}
        </div>
      </s-stack>
      <div className="run-order">
        <s-text color="subdued">{run.orderName}</s-text>
      </div>
    </s-grid>
  );
}

/**
 * A line of the row other than the first, in one line: its {@link Clip}
 * parts are the free-length names (a task, a team, a reason, a workflow),
 * cut with an ellipsis, and its {@link Keep} parts are the short fixed words
 * (a state, the step, who did it), which are never cut. So a long name never
 * pushes the row taller and never pushes the fixed words off it.
 */
function RowLine({ children }: { readonly children: React.ReactNode }) {
  return <div className="run-line">{children}</div>;
}

/** The part of a {@link RowLine} that ends in an ellipsis when the line is full. */
function Clip({ children }: { readonly children: React.ReactNode }) {
  return <div className="run-line-clip">{children}</div>;
}

/** The part of a {@link RowLine} that is never cut; it keeps its leading space. */
function Keep({ children }: { readonly children: React.ReactNode }) {
  return <div className="run-line-keep">{children}</div>;
}

/**
 * Who did a Done or closed task entry, spelled as the waiting rows spell an actor:
 * `you` for the reader, the email for anybody else, `Merchant` for the
 * merchant. Your own address repeated down a page is the noisiest text on the
 * list and the least informative line on it. Empty rather than "nobody" for a
 * row written before the role column.
 */
const doneActorLabel = (task: Domain.RunTask, memberEmail: Domain.Email) => {
  const actor = Domain.taskDoneBy(task);
  if (actor === null) return "";
  return Domain.actorIsMember(actor, memberEmail)
    ? "you"
    : Domain.actorLabel(actor);
};

function RouteComponent() {
  const {
    shop,
    memberId,
    memberEmail,
    teams,
    query: loaderQuery,
    list: loaderList,
  } = Route.useLoaderData();
  /** The member as the actor every row's action set is computed for. */
  const actor: Domain.Actor = {
    role: "member",
    memberId,
    email: memberEmail,
    teamIds: teams.map((team) => team.id),
  };
  /**
   * Which list, narrowed to which team, how far down, and the search: all four from the URL
   * (`MemberSearch` in `shop.$shop.tsx`), with the defaults applied here at the
   * read. All four are part of the query key, because every one of them is a
   * different read of the object.
   *
   * A `team` the member is no longer on is read as Any team, the same
   * resolution the loader makes: the teams are what say which ids mean
   * something, the Team select has no option for any other id, and the
   * alternative is a list that is empty for a reason nothing on screen states.
   */
  const {
    state = Domain.DEFAULT_WORKFLOWS_LIST_STATE,
    team: searchTeam = "",
    limit = Domain.RUN_PAGE,
    q = null,
  } = Route.useSearch();
  const team = teams.find(({ id }) => id === searchTeam)?.id ?? null;
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  /**
   * The subscribe pattern (`Domain.Subscription`): the loader's rows paint
   * first, then `subscribeRuns` re-reads them over the socket and registers
   * this connection for pushes, so another member's Done lands here
   * without a reload. The subscription's scope is the teams on the connection,
   * so nothing about it is named by the browser — `query` only chooses among
   * them, and the object bounds what it can ask for.
   *
   * `initialData` only while the query is the loader's: any other key is a
   * read the SSR paint never made, and `keepPreviousData` in the hook holds
   * the previous rows on screen until it returns.
   */
  const query: Domain.RunQuery = { team, state, limit, q };
  const { data, invalidate, agent, identified } = useSubscribedQuery({
    queryKey: ["shop-runs", shop, query],
    subscribe: (stub, subscriberId) =>
      stub.subscribeRuns({ subscriberId, query }),
    initialData: Domain.sameRunQuery(query, loaderQuery)
      ? loaderList
      : undefined,
  });
  /**
   * The loader's list stands in while a new key is in flight, so the strip
   * keeps its five cells rather than blinking out. The rows do not: for a
   * query the loader never read and with no previous rows to keep, the page
   * says it is loading rather than paint the unnarrowed loader rows under a
   * chosen state.
   */
  const list = data ?? loaderList;
  const loading = data === undefined;
  const actions = useMemberRunActions({
    agent,
    identified,
    onSuccess: () => invalidate(),
  });

  /**
   * The controls, all of them navigations, because all of them are in the
   * URL. **Filters are a screen's state, not a trail:** `replace: true` on
   * every one so Back leaves the workflows list rather than walking the member back
   * through every state, team and search they glanced at. The embedded app's orders and
   * workflows filters follow this rule (`setFilters` in `app.orders.index.tsx`
   * and `app.workflows.index.tsx`).
   *
   * A state, a team or a search is a different list, so depth resets: "Show
   * 25 more" of Ready is not a promise about Blocked. `undefined` is how a key
   * is removed, which is what puts the default back and keeps it out of the
   * URL.
   */
  const selectState = (next: Domain.WorkflowsListState) => {
    if (next === state) return;
    void navigate({
      search: (prev) => ({ ...prev, state: next, limit: undefined }),
      replace: true,
    });
  };

  const setSearch = (next: Domain.ListSearch | null) => {
    void navigate({
      search: (prev) => ({ ...prev, q: next ?? undefined, limit: undefined }),
      replace: true,
    });
  };

  const selectTeam = (next: Domain.TeamId | null) => {
    void navigate({
      search: (prev) => ({
        ...prev,
        team: next ?? undefined,
        limit: undefined,
      }),
      replace: true,
    });
  };

  const showMore = () => {
    void navigate({
      search: (prev) => ({
        ...prev,
        limit: Math.min(
          (prev.limit ?? Domain.RUN_PAGE) + Domain.RUN_PAGE,
          Domain.RUN_LIMIT_MAX,
        ),
      }),
      replace: true,
    });
  };

  /**
   * The row's link target, built once here. A real `href` — built through the
   * router rather than written as a string — is what keeps middle-click and
   * open-in-new-tab working on a row; the click handler beside it turns an
   * ordinary tap into a client navigation so the socket and the query cache
   * survive it. `MemberBar`'s mark is the same pattern pointing back the
   * other way; the workflow page carries no breadcrumb of its own because that
   * mark is already a link to this screen.
   *
   * No `search`: the layout's middleware puts the member's context on this
   * link, and on the mark's link back, without either site naming the keys
   * (`MemberSearch` in `shop.$shop.tsx`).
   */
  const workflowLocation = (runId: string) =>
    ({ to: "/shop/$shop/workflows/$runId", params: { shop, runId } }) as const;

  const showTeam = Domain.rowShowsTeam(teams.length, team, q);

  /**
   * One row per run: the whole row is one link to the workflow page, and
   * the kebab beside it is the only thing in it that is not. It replaced
   * three targets with three results — order link, expand, action — of which
   * only the first looked interactive; the workflow page shows everything the
   * expanded row used to and the run history, the editors and a printable
   * ticket besides, for the same single tap.
   *
<   * Three parts, one kind of fact each. Line one is the piece
   * ({@link PieceLine}): what to make, and for which order. Then the work:
   * one line per current task, `Task (Team) · <state>`, then the block when
   * there is one. Last the recipe: `<workflow> · Step k of n`. What each line
   * prints, and when, is {@link Domain.runRowLines}; the row only lays it out.
   */
  const renderItem = (item: Domain.RunListItem, first: boolean) => {
    const { run, tasks } = item;
    const blocked = Domain.runIsBlocked(run);
    const [, ...rest] = tasks;
    const menuId = `run-actions-${run.id}`;
    const lines = Domain.runRowLines(item, {
      memberEmail,
      showTeam,
      state: q === null ? state : null,
    });
    /**
     * Every verb the row offers, inside the row's menu — the shape Polaris's
     * own resource list gives a row
     * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/resource-list.md`,
     * "Provide search, filtering, and row selection for a resource list"):
     * one tertiary `menu-horizontal` button in the `auto` cell, no labelled
     * verb and no primary ({@link Domain.taskActions}). One fixed-size control
     * per row is also what stops the action column resizing itself row by row
     * and dragging the text column's edge with it.
     *
     * Every verb is a field of {@link Domain.runActions} or
     * {@link Domain.taskActions}; the row decides only which of the allowed
     * verbs it lists. A blocked run lists Unblock alone, and the action sets
     * already refuse Start and Done under a block: Start on a held run is the
     * row arguing with itself. The fixer's extra step (Unblock, then Done) is
     * the price, and they are the rare reader.
     *
     * An unstarted task lists Start and not Done, although Done is allowed
     * there: the row walks the member through the task one verb at a time,
     * and Done straight from the list is one tap on the workflow page.
     *
     * A single current task gives the bare verb: the task is named on its own
     * line of the row this menu belongs to. Several give one item each, because a
     * single verb would act on the first and say nothing about the rest.
     *
     * A started task also gets Put back, the one-press fix for a Start
     * pressed by mistake, wherever the action set allows it: for the whole
     * team, so a row a teammate started offers it too.
     *
     * The list sets `current: true` on every task of a row because the query
     * returns current tasks only (`RunRepository.runListItems`), and
     * `laterStepStarted: false` because the row holds no done task; a list that
     * one day carried a waiting task would need `RunListTask` to carry
     * `current`.
     */
    const menuItems = () => {
      if (blocked)
        return Domain.runActions(
          actor,
          item.order,
          run,
          tasks.map((each) => ({ ...each, current: true })),
        ).unblock
          ? [
              <s-button
                key="unblock"
                onClick={() => {
                  actions.unblock.mutate(run.id);
                }}
              >
                {Domain.VERB_LABEL.unblock.member}
              </s-button>,
            ]
          : [];
      const named = (
        verb: "start" | "done" | "putBack",
        each: Domain.RunListTask,
      ) => {
        const label = Domain.VERB_LABEL[verb].member;
        return rest.length > 0 ? `${label} · ${each.name}` : label;
      };
      return tasks.flatMap((each) => {
        /* Every task on a row is current: that is what put it on the
           list (`RunRepository.runListItems`). */
        const can = Domain.taskActions(actor, item.order, run, {
          ...each,
          current: true,
          doneAt: null,
          laterStepStarted: false,
        });
        if (can.start)
          return [
            <s-button
              key={each.id}
              onClick={() => {
                actions.start.mutate(each.id);
              }}
            >
              {named("start", each)}
            </s-button>,
          ];
        return [
          ...(can.done
            ? [
                <s-button
                  key={each.id}
                  onClick={() => {
                    actions.markDone.mutate(each.id);
                  }}
                >
                  {named("done", each)}
                </s-button>,
              ]
            : []),
          ...(can.putBack
            ? [
                <s-button
                  key={`${each.id}-put-back`}
                  onClick={() => {
                    actions.putBack.mutate(each.id);
                  }}
                >
                  {named("putBack", each)}
                </s-button>,
              ]
            : []),
        ];
      });
    };
    const items = menuItems();
    return (
      /* The separator above every row but the list's first, and nothing else.
         A blocked row used to draw a rule down its leading edge as well; it
         went the way of the subdued surface that marked a row in hand, and
         for the same reason. A block puts the row in the Blocked state
         ({@link Domain.listStateOf}) and nowhere else, so the mark fired on every
         row of the only state it could appear on and separated nothing. It also
         ran past the list container's rounded corner, which a radius does not
         clip without `overflow: hidden`. */
      <s-box key={run.id} borderWidth={first ? "none" : "base none none none"}>
        <s-clickable
          href={router.buildLocation(workflowLocation(run.id)).href}
          accessibilityLabel={`Open ${Domain.itemTitle(run)} on ${run.orderName}`}
          padding="small-100 base"
          onClick={(event) => {
            event.preventDefault();
            void router.navigate(workflowLocation(run.id));
          }}
        >
          <s-grid
            gridTemplateColumns="minmax(0, 1fr) auto"
            gap="small-300"
            alignItems="center"
          >
            <s-stack gap="small-500">
              <PieceLine run={run} />
              {lines.tasks.map((each) => (
                <RowLine key={each.id}>
                  <Clip>
                    <s-text>{each.name}</s-text>
                    {each.team !== null && (
                      <s-text color="subdued">{` (${each.team})`}</s-text>
                    )}
                  </Clip>
                  {each.state !== null && (
                    <Keep>
                      <s-text color="subdued">{` · ${each.state}`}</s-text>
                    </Keep>
                  )}
                </RowLine>
              ))}
              {lines.block !== null && (
                <RowLine>
                  <Clip>
                    <s-text color="subdued">{lines.block}</s-text>
                  </Clip>
                </RowLine>
              )}
              <RowLine>
                <Clip>
                  <s-text color="subdued">{lines.recipe.workflow}</s-text>
                </Clip>
                <Keep>
                  <s-text color="subdued">{` · ${lines.recipe.step}`}</s-text>
                </Keep>
              </RowLine>
            </s-stack>
            {items.length > 0 && (
              <s-button
                icon="menu-horizontal"
                variant="tertiary"
                accessibilityLabel={`Actions for ${run.orderName}`}
                disabled={actions.pending}
                commandFor={menuId}
                onClick={insideRow}
              />
            )}
          </s-grid>
        </s-clickable>
        {items.length > 0 && (
          <s-menu
            id={menuId}
            accessibilityLabel={`Actions for ${run.orderName}`}
          >
            {items}
          </s-menu>
        )}
      </s-box>
    );
  };

  /** The same rule as the workflow page's Undo, {@link Domain.taskActions}' `reopen`, on the list's own row. */
  const reopenOf = (entry: Extract<Domain.RecentItem, { kind: "task" }>) =>
    Domain.taskActions(actor, entry.order, entry.run, {
      ...entry.task,
      current: false,
      laterStepStarted: entry.laterStepStarted,
    }).reopen;

  /**
   * A done task's row, the same shape as an open one: the row is a link
   * to the workflow page and a kebab beside it holds Undo. Line one is the
   * piece, as on every row ({@link PieceLine}), so a member scanning Done or
   * closed for the thing they marked by mistake reads the same column they
   * read everywhere else. Line two is the task and who did it when; line
   * three the workflow name alone, without the step: a done task's step is
   * history, and a {@link Domain.RecentItem} carries no step count.
   *
   * The kebab is there only while Undo is allowed. The rule used to be the
   * other way — a disabled button beside the clause naming its blocker, on
   * the reasoning that a missing control reads as a row that was never
   * reopenable while a disabled one reads as the refusal it is. That holds
   * while refusal is the exception. Here it is the rule: reopen is blocked the
   * moment anything downstream starts, so a busy shop's Done or closed list was mostly
   * dead buttons each explaining itself in a third line. When most rows can
   * offer nothing, absence is the norm a reader learns in two rows and the
   * kebab is the signal. The workflow page the row links to shows the later
   * step's task started, for the reader who went looking.
   */
  const renderDone = (
    entry: Extract<Domain.RecentItem, { kind: "task" }>,
    first: boolean,
  ) => {
    const menuId = `run-reopen-${entry.task.id}`;
    const reopenable = reopenOf(entry);
    return (
      <s-box
        key={entry.task.id}
        borderWidth={first ? "none" : "base none none none"}
      >
        <s-clickable
          href={router.buildLocation(workflowLocation(entry.run.id)).href}
          accessibilityLabel={`Open ${Domain.itemTitle(entry.run)} on ${entry.run.orderName}`}
          padding="small-100 base"
          onClick={(event) => {
            event.preventDefault();
            void router.navigate(workflowLocation(entry.run.id));
          }}
        >
          <s-grid
            gridTemplateColumns="minmax(0, 1fr) auto"
            gap="small-300"
            alignItems="center"
          >
            <s-stack gap="small-500">
              <PieceLine run={entry.run} />
              <RowLine>
                <Clip>
                  <s-text>{entry.task.name}</s-text>
                </Clip>
                <Keep>
                  <s-text color="subdued">
                    {` · ${Domain.TASK_STATE_LABEL.done} by ${doneActorLabel(entry.task, memberEmail)} at `}
                    <LocalDateTime
                      value={entry.task.doneAt ?? 0}
                      format="time"
                    />
                  </s-text>
                </Keep>
                {entry.run.note !== null && (
                  <Clip>
                    <s-text color="subdued">{` · Note: ${entry.run.note}`}</s-text>
                  </Clip>
                )}
              </RowLine>
              <RowLine>
                <Clip>
                  <s-text color="subdued">{entry.run.workflowName}</s-text>
                </Clip>
              </RowLine>
            </s-stack>
            {reopenable && (
              <s-button
                icon="menu-horizontal"
                variant="tertiary"
                accessibilityLabel={`Actions for ${entry.run.orderName}`}
                disabled={actions.pending}
                commandFor={menuId}
                onClick={insideRow}
              />
            )}
          </s-grid>
        </s-clickable>
        {reopenable && (
          <s-menu
            id={menuId}
            accessibilityLabel={`Actions for ${entry.run.orderName}`}
          >
            <s-button
              onClick={() => {
                actions.reopen.mutate(entry.task.id);
              }}
            >
              {Domain.VERB_LABEL.reopen.member}
            </s-button>
          </s-menu>
        )}
      </s-box>
    );
  };

  /**
   * A closed run's Done or closed row ({@link Domain.RecentItem}): line one is the
   * piece, as on every row ({@link PieceLine}), line two "Closed · <reason> ·
   * <time>" ({@link ClosedLine}), line three the workflow name. A link to
   * the workflow page and nothing else: closing is a notice, not a to-do, and a
   * closed run offers no verb but the note.
   */
  const renderClosed = (
    entry: Extract<Domain.RecentItem, { kind: "closed" }>,
    first: boolean,
  ) => (
    <s-box
      key={`closed-${entry.run.id}`}
      borderWidth={first ? "none" : "base none none none"}
    >
      <s-clickable
        href={router.buildLocation(workflowLocation(entry.run.id)).href}
        accessibilityLabel={`Open ${Domain.itemTitle(entry.run)} on ${entry.run.orderName}`}
        padding="small-100 base"
        onClick={(event) => {
          event.preventDefault();
          void router.navigate(workflowLocation(entry.run.id));
        }}
      >
        <s-stack gap="small-500">
          <PieceLine run={entry.run} />
          <RowLine>
            <Clip>
              <ClosedLine run={entry.run} viewer="member" prefix />
            </Clip>
          </RowLine>
          <RowLine>
            <Clip>
              <s-text color="subdued">{entry.run.workflowName}</s-text>
            </Clip>
          </RowLine>
        </s-stack>
      </s-clickable>
    </s-box>
  );

  const renderRecent = (entry: Domain.RecentItem, first: boolean) =>
    entry.kind === "task"
      ? renderDone(entry, first)
      : renderClosed(entry, first);

  /**
   * "Show 25 more of N". The button is the only way past the chosen state's cut
   * and it asks the object for the deeper read rather than revealing rows the
   * page already holds, so the count it names is the object's count.
   */
  const renderMore = (hidden: number) => (
    <s-box padding="small-300 base">
      <s-button
        variant="tertiary"
        inlineSize="fill"
        disabled={limit >= Domain.RUN_LIMIT_MAX}
        onClick={showMore}
      >
        {`Show ${String(Math.min(Domain.RUN_PAGE, hidden))} more of ${String(hidden)}`}
      </s-button>
    </s-box>
  );

  /**
   * The team filter, a select rather than buttons because the team list is
   * unbounded, as on the orders index. Its options are names only: the strip
   * beside it counts the chosen team's states, so a count in the closed select
   * would be a number over a different set of rows from the numbers next to
   * it. The first option is Any team, valued `ANY_OPTION_VALUE` (`Screen.ts`
   * says why not `""`). An id the member is not on is already
   * read as Any team (`team` above), so unlike the orders index there is no
   * Deleted team option: the list under Any team really is every team.
   *
   * Its label is hidden on screen and kept for screen readers (the controls
   * table's row for a filter beside a search).
   *
   * Rendered only for a member on more than one team: with one team there is
   * no choice to make, whereas a merchant on the orders index always has one.
   * Disabled under a search, which ignores the team (`Domain.RunQuery`): a
   * filter that looks set but does nothing is the controls table's "never"
   * (`Control` in `Screen.ts`). It keeps its value, so Clear search restores
   * the list it describes.
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
          selectTeam(teams.find(({ id }) => id === value)?.id ?? null);
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
   * One cell of the strip, the metrics-card composition
   * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/metrics-card.md`)
   * as on the orders index: the state's name over its count, the whole cell a
   * one-click filter. The strip is the heading, now that the page has none:
   * every state with its count, the chosen one filled.
   *
   * The strip is the state filter and the only one: every state is on it,
   * so there is no State select, which on the orders index holds the
   * values its strip has no cell for. The chosen cell is filled
   * (`background="subdued"`). Not `aria-current`: `s-clickable` leaves it on
   * the host, and the native button in its shadow root, which is what a
   * screen reader reads, never gets it; the accessibility label says
   * "selected" instead, since that label does reach the button.
   *
   * A count always renders, at zero if need be, so nothing on the strip
   * appears or disappears with the data, and a zero-count state stays
   * enabled, because an empty list with its empty state is a valid screen to
   * land on and the count already says zero. Done or closed is a cell like
   * the others, history and all: it is the member's undo, and its count is
   * bounded to the last day. No cell is red: a member is not usually the one
   * who clears a block.
   *
   * On a phone the three-word labels wrap and "Ready" does not, so the cell
   * fills its grid track and the count sits at the cell's foot: the counts
   * on a line share a baseline and the chosen cell's fill is the line's full
   * height, whatever each label did.
   */
  const stripCell = (each: Domain.WorkflowsListState) => {
    const chosen = each === state;
    const n = list.counts[each];
    return (
      <s-clickable
        key={each}
        paddingBlock="small-400"
        paddingInline="small-100"
        borderRadius="base"
        blockSize="100%"
        background={chosen ? "subdued" : "transparent"}
        accessibilityLabel={`${STATE_LABEL[each]}, ${formatNumber(n)}${chosen ? ", selected" : ""}`}
        onClick={() => {
          selectState(each);
        }}
      >
        <s-grid gap="small-300" blockSize="100%" alignContent="space-between">
          <s-heading>{STATE_LABEL[each]}</s-heading>
          <s-text>{formatNumber(n)}</s-text>
        </s-grid>
      </s-clickable>
    );
  };

  /**
   * Three columns at every width, so the strip is always two lines: the three
   * states with work in hand, then Blocked and Done or closed. Not five where
   * there is room, as on the orders index: the page is `inlineSize="small"`,
   * so the section is under 600px wide at every viewport, and five cells in
   * it wrap "Started by you" and "Done or closed" onto two lines while Ready
   * and Blocked keep one, which leaves the counts at two heights. In three
   * columns every label is one line from a 600px viewport up. A grid rather
   * than a scroller or a wrapping row, so a count crossing a digit changes a
   * cell and never the layout. Not sticky: it scrolls away with the page.
   */
  const strip = (
    <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="small">
      {STATES.map(stripCell)}
    </s-grid>
  );

  /**
   * The filter row under the strip: the search, then the Team select. It
   * renders under a search too, so the field stays where the member typed.
   * With one team the search is alone and full width.
   */
  const filterRow =
    teamSelect === null ? (
      <ListSearchField value={q} onSubmit={setSearch} />
    ) : (
      <s-query-container>
        <s-grid
          gridTemplateColumns="@container (inline-size > 480px) 1fr 12rem, 1fr"
          gap="small-300"
          alignItems="end"
        >
          <ListSearchField value={q} onSubmit={setSearch} />
          {teamSelect}
        </s-grid>
      </s-query-container>
    );

  /** The search as the screen prints it (`Domain.searchTermText`): `#1001`, or the typed words. */
  const term = q === null ? null : Domain.searchTermText(Domain.searchTerm(q));
  const clearSearch = () => {
    setSearch(null);
  };

  const total = list.counts[state];
  const rows = Domain.workflowsListStateIsDone(state)
    ? list.recent
    : list.items;
  const hidden = total - rows.length;
  /**
   * The way out of an empty state; `null` when there is nowhere worth sending
   * the reader. "Go to" rather than the bare label so the button cannot be
   * confused with the strip cell above it that carries the same count.
   */
  const goTo = STATE_EMPTY[state].goTo;
  const renderEmpty = () => (
    <s-stack gap="small-300">
      <s-paragraph color="subdued">{STATE_EMPTY[state].text}</s-paragraph>
      {goTo !== null && list.counts[goTo] > 0 && (
        <s-button
          variant="tertiary"
          onClick={() => {
            selectState(goTo);
          }}
        >
          {`Go to ${STATE_LABEL[goTo]} · ${String(list.counts[goTo])}`}
        </s-button>
      )}
    </s-stack>
  );
  const renderList = () => (
    <s-box borderWidth="base" borderRadius="base">
      {Domain.workflowsListStateIsDone(state)
        ? list.recent.map((entry, index) => renderRecent(entry, index === 0))
        : list.items.map((item, index) => renderItem(item, index === 0))}
      {hidden > 0 && renderMore(hidden)}
    </s-box>
  );
  /**
   * Under a search (`Domain.RunQuery`, which ignores the state and the team):
   * the strip gives way to one line, how many rows match and Clear search
   * (`Control` in `Screen.ts`, "a search is on"); the rows are the open
   * matches, then the Done or closed matches under a divider, so a member who
   * marked the wrong thing done finds it by number. N is every match before
   * the cut (`Domain.WorkflowsListData.matches`), each half is cut to the
   * depth, and Show more deepens both, so a match past the cut is reachable.
   * Nothing matching is one sentence and Clear search.
   */
  const renderSearch = (text: string) => {
    const shown = list.items.length + list.recent.length;
    const matches = list.matches ?? shown;
    if (matches === 0)
      return (
        <s-stack gap="small-300">
          <s-paragraph color="subdued">{`${SEARCH_EMPTY} ${text}`}</s-paragraph>
          <s-button variant="tertiary" onClick={clearSearch}>
            Clear search
          </s-button>
        </s-stack>
      );
    return (
      <>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-text>
            {matches === 1
              ? `1 workflow matches ${text}`
              : `${formatNumber(matches)} workflows match ${text}`}
          </s-text>
          <s-button onClick={clearSearch}>Clear search</s-button>
        </s-stack>
        {list.items.length > 0 && (
          <s-box borderWidth="base" borderRadius="base">
            {list.items.map((item, index) => renderItem(item, index === 0))}
          </s-box>
        )}
        {list.items.length > 0 && list.recent.length > 0 && <s-divider />}
        {list.recent.length > 0 && (
          <s-box borderWidth="base" borderRadius="base">
            {list.recent.map((entry, index) =>
              renderRecent(entry, index === 0),
            )}
          </s-box>
        )}
        {matches > shown && renderMore(matches - shown)}
      </>
    );
  };
  const renderRuns = () => {
    if (loading)
      return <s-paragraph color="subdued">Loading&hellip;</s-paragraph>;
    if (total === 0) return renderEmpty();
    return renderList();
  };

  const renderBody = () => {
    if (teams.length === 0)
      return (
        <s-paragraph color="subdued">
          You&rsquo;re not on a team yet. Ask the merchant to add you to a team.
        </s-paragraph>
      );
    return (
      <>
        {term === null && strip}
        {filterRow}
        {term === null ? renderRuns() : renderSearch(term)}
      </>
    );
  };

  return (
    <>
      <MemberBar shop={shop} email={memberEmail} />
      {/* No `heading`: the strip below says the same word and says more with
          it, and a heading block above the fold is what a bench tablet has
          least of. "Workflows", the rows' noun, is in the document title and
          the section's accessibility label: the browser tab and the
          landmark are the places the page's own noun does work. */}
      <s-page inlineSize="small">
        <SocketBanner />
        <s-section accessibilityLabel="Workflows">
          <s-stack gap="base">
            {actions.banner !== null && (
              <s-banner tone="critical">{actions.banner}</s-banner>
            )}
            {renderBody()}
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}
