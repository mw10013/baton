import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberBar } from "@/components/MemberBar";
import { ClosedLine, QuantityBadge } from "@/components/MemberRun";
import * as Domain from "@/lib/Domain";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import { useMemberRunActions } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";
import { VIEW_EMPTY, VIEW_LABEL, VIEWS } from "@/lib/workflowsListViews";

const LoaderInput = Schema.Struct({
  shop: Schema.String,
  view: Domain.WorkflowsListView,
  /** Text, not a {@link Domain.TeamId}: the member's teams resolve it (`MemberSearch` in `shop.$shop.tsx`). */
  team: Schema.String.check(Schema.isMaxLength(Domain.TEAM_SEARCH_MAX)),
  limit: Domain.RunLimit,
});

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
 * left.** View, team and depth are the member's context (`MemberSearch` in
 * `shop.$shop.tsx`), which every link under `/shop/$shop` carries, so a return
 * from the workflow page server-renders narrowed and deepened rather than painting
 * page one of every team and correcting itself when the socket answers. The
 * query it read comes back beside the view, which is what lets these rows
 * serve as the socket query's `initialData` ({@link Domain.sameRunQuery}).
 *
 * `team` is resolved against the shop's live teams here, not trusted: a member taken
 * off a team keeps the id in their URL, and this is where it becomes "All
 * teams" rather than a read that returns nothing.
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
          view: data.view,
          limit: data.limit,
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
        } satisfies Domain.RunListLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/workflows/")({
  loaderDeps: ({ search }) => ({
    view: search.view ?? Domain.DEFAULT_WORKFLOWS_LIST_VIEW,
    team: search.team ?? "",
    limit: search.limit ?? Domain.RUN_PAGE,
  }),
  loader: ({ params, deps }) =>
    getLoaderData({ data: { shop: params.shop, ...deps } }),
  /**
   * A query is a different loader key, so its first visit runs the loader once
   * and that read is the socket query's `initialData` for the new key; after
   * that the socket owns the data and pushes keep it current. Without this the
   * default `staleTime: 0` would re-run the loader on every return to a view,
   * team or depth whose data the socket already holds — which, now that all
   * three are in the URL, is every way back to this screen.
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
 * Who did a Done or closed task entry, spelled as the waiting rows spell an actor:
 * `you` for the reader, the email for anybody else, `Merchant` for the
 * merchant. Your own address repeated down a page is the noisiest text on the
 * view and the least informative line on it. Empty rather than "nobody" for a
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
   * Which list, narrowed to which team, how far down: all three from the URL
   * (`MemberSearch` in `shop.$shop.tsx`), with the defaults applied here at the
   * read. All three are part of the query key, because every one of them is a
   * different read of the object.
   *
   * A `team` the member is no longer on is read as All teams, the same
   * resolution the loader makes: the teams are what say which ids mean
   * something, the button above already falls back to that label, and the
   * alternative is a list that is empty for a reason nothing on screen states.
   */
  const {
    view = Domain.DEFAULT_WORKFLOWS_LIST_VIEW,
    team: searchTeam = "",
    limit = Domain.RUN_PAGE,
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
  const query: Domain.RunQuery = { team, view, limit };
  const { data, invalidate, agent, identified } = useSubscribedQuery({
    queryKey: ["shop-runs", shop, query],
    subscribe: (stub, subscriberId) =>
      stub.subscribeRuns({ subscriberId, query }),
    initialData: Domain.sameRunQuery(query, loaderQuery)
      ? loaderList
      : undefined,
  });
  /**
   * `total` and the team counts are the same for every query (they are over
   * every team), so the loader's stand in while a new key is in flight. The
   * rows are not: for a query the loader never read and with no previous rows
   * to keep, the page says it is loading rather than paint the unnarrowed
   * loader rows under a pressed view.
   */
  const list = data ?? loaderList;
  const loading = data === undefined;
  const actions = useMemberRunActions({
    agent,
    identified,
    onSuccess: () => invalidate(),
  });

  /**
   * The three controls, all of them navigations, because all three are in the
   * URL. **Filters are a screen's state, not a trail:** `replace: true` on
   * every one so Back leaves the workflows list rather than walking the member back
   * through every view and team they glanced at. The embedded app's orders and
   * workflows filters follow this rule (`setFilters` in `app.orders.index.tsx`
   * and `app.workflows.index.tsx`).
   *
   * A view or a team is a different list, so depth resets: "Show 25 more" of Up
   * next is not a promise about Blocked. `undefined` is how a key is removed,
   * which is what puts the default back and keeps it out of the URL.
   */
  const selectView = (next: Domain.WorkflowsListView) => {
    if (next === view) return;
    void navigate({
      search: (prev) => ({ ...prev, view: next, limit: undefined }),
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

  /**
   * Whether a row names its team. The team name is on the row for the one
   * reader it tells something: a member on several teams looking at all of
   * them, for whom it is which bench to walk to. Narrow to a team and every
   * row of the list is that team, so the word is printed on each of them and
   * discriminates nothing; a member on one team never had a second team for
   * it to sort against. The same two facts decide whether the filter exists
   * at all, so the reader who has the filter is the reader who gets the name.
   */
  const showTeam = teams.length > 1 && team === null;

  /**
   * One row per run: the whole row is one link to the workflow page, and
   * the kebab beside it is the only thing in it that is not. It replaced
   * three targets with three results — order link, expand, action — of which
   * only the first looked interactive; the workflow page shows everything the
   * expanded row used to and the run history, the editors and a printable
   * ticket besides, for the same single tap.
   *
   * Line one is the item's title, then its workflow and order, and the
   * quantity badge after a Shopify change ({@link QuantityBadge}): what the
   * row is. The item leads because it is what to make; the workflow name is
   * the noun the merchant's order page uses for the same run, so the two
   * sides can talk about one thing; the order is the qualifier.
   * Line two is what to do on it ({@link Domain.runRowLine}): every current task
   * by name, then the one thing the reader needs and no more — why it
   * stopped, who has it, or where it is in the run. Every name rather than
   * the first and a `+n`, because a count says there is more work without
   * saying what it is.
   */
  const renderItem = (item: Domain.RunListItem, first: boolean) => {
    const { run, tasks } = item;
    const blocked = Domain.runIsBlocked(run);
    const [task, ...rest] = tasks;
    const started = task.startedAt !== null;
    const startedBy = Domain.taskStartedBy(task);
    const menuId = `run-actions-${run.id}`;
    const line = Domain.runRowLine(item, showTeam);
    /**
     * A row you started says where it is in the run, not "Started · you".
     * Starting a task is what puts the row in Started by you ({@link Domain.viewOf}),
     * and Put back is the inverse that takes it out again, so those words are true of every row under that pressed view and so
     * distinguish none of them. A row a teammate started says who instead,
     * which is the whole of what the Started by others view is for. The test is the
     * starter rather than the pressed view because a run can have several current
     * tasks on the member's teams and `tasks[0]` is the lowest-positioned
     * one, not necessarily theirs.
     */
    const detailLine = () => {
      if (blocked) return run.blockReason ?? line.step;
      if (!started) return line.step;
      if (startedBy === null) return Domain.RUN_STATE_LABEL.open;
      return Domain.actorIsMember(startedBy, memberEmail)
        ? line.step
        : `${Domain.TASK_STATE_LABEL.started} · ${Domain.actorLabel(startedBy)}`;
    };
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
     * A single current task gives the bare verb: the task is named on line two
     * of the row this menu belongs to. Several give one item each, because a
     * single verb would act on the first and say nothing about the rest.
     *
     * A started task also gets Put back, the one-press fix for a Start
     * pressed by mistake, wherever the action set allows it: for the whole
     * team, so a row a teammate started offers it too.
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
           list (`RunRepository.listRuns`). */
        const can = Domain.taskActions(actor, item.order, run, {
          ...each,
          current: true,
          doneAt: null,
          reopenBlockedBy: null,
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
         for the same reason. A block puts the row in the Blocked view
         ({@link Domain.viewOf}) and nowhere else, so the mark fired on every
         row of the only view it could appear on and separated nothing. It also
         ran past the list container's rounded corner, which a radius does not
         clip without `overflow: hidden`. */
      <s-box key={run.id} borderWidth={first ? "none" : "base none none none"}>
        <s-clickable
          href={router.buildLocation(workflowLocation(run.id)).href}
          accessibilityLabel={`Open ${run.lineItemTitle} on ${run.orderName}`}
          padding="small-100 base"
          onClick={(event) => {
            event.preventDefault();
            void router.navigate(workflowLocation(run.id));
          }}
        >
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="small-300"
            alignItems="center"
          >
            <s-stack gap="small-500">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text type="strong">{run.lineItemTitle}</s-text>
                <s-text color="subdued">{`${run.workflowName} · ${run.orderName}`}</s-text>
                {/* No Blocked badge: it would read "Blocked" under a pressed
                    Blocked view, beside an Unblock item, above the reason as
                    typed — one fact said four times. */}
                <QuantityBadge run={run} />
              </s-stack>
              {/* `.run-detail-line` in `styles.css` cuts it to two lines. */}
              <div className="run-detail-line">
                <s-text color="subdued">{`${line.names} · ${detailLine()}`}</s-text>
              </div>
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

  /** The same rule as the workflow page's Undo, {@link Domain.taskActions}' `reopen`, on the view's own row. */
  const reopenOf = (entry: Extract<Domain.RecentItem, { kind: "task" }>) =>
    Domain.taskActions(actor, entry.order, entry.run, {
      ...entry.task,
      current: false,
      reopenBlockedBy: entry.reopenBlockedBy,
    }).reopen;

  /**
   * A done task's row, the same shape as a waiting one: the row is a link
   * to the workflow page and a kebab beside it holds Undo. Line one leads
   * with the task, because the entry is the task that was done, and names
   * its run the way every run row does ({@link renderItem}): the item, its
   * workflow and order. Line two is who did it and when.
   *
   * The kebab is there only while Undo is allowed. The rule used to be the
   * other way — a disabled button beside the clause naming its blocker, on
   * the reasoning that a missing control reads as a row that was never
   * reopenable while a disabled one reads as the refusal it is. That holds
   * while refusal is the exception. Here it is the rule: reopen is blocked the
   * moment anything downstream starts, so a busy shop's Done or closed view was mostly
   * dead buttons each explaining itself in a third line. When most rows can
   * offer nothing, absence is the norm a reader learns in two rows and the
   * kebab is the signal. The refusal is not lost — the workflow page the row
   * links to states it in full, for the reader who went looking.
   */
  const renderDone = (
    entry: Extract<Domain.RecentItem, { kind: "task" }>,
    first: boolean,
  ) => {
    const menuId = `run-reopen-${entry.task.id}`;
    const reopenable = reopenOf(entry)?.blockedBy === null;
    return (
      <s-box
        key={entry.task.id}
        borderWidth={first ? "none" : "base none none none"}
      >
        <s-clickable
          href={router.buildLocation(workflowLocation(entry.run.id)).href}
          accessibilityLabel={`Open ${entry.run.lineItemTitle} on ${entry.run.orderName}`}
          padding="small-100 base"
          onClick={(event) => {
            event.preventDefault();
            void router.navigate(workflowLocation(entry.run.id));
          }}
        >
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="small-300"
            alignItems="center"
          >
            <s-stack gap="small-500">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text type="strong">{entry.task.name}</s-text>
                <s-text color="subdued">{`${entry.run.lineItemTitle} · ${entry.run.workflowName} · ${entry.run.orderName}`}</s-text>
              </s-stack>
              <div className="run-detail-line">
                <s-text color="subdued">
                  {`by ${doneActorLabel(entry.task, memberEmail)} at `}
                  <LocalDateTime value={entry.task.doneAt ?? 0} format="time" />
                  {entry.run.note === null ? "" : ` · Note: ${entry.run.note}`}
                </s-text>
              </div>
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
   * item, its workflow and order, as on every run row ({@link renderItem}),
   * then "Closed · <reason> · <time>" ({@link ClosedLine}). A link to
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
        accessibilityLabel={`Open ${entry.run.lineItemTitle} on ${entry.run.orderName}`}
        padding="small-100 base"
        onClick={(event) => {
          event.preventDefault();
          void router.navigate(workflowLocation(entry.run.id));
        }}
      >
        <s-stack gap="small-500">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">{entry.run.lineItemTitle}</s-text>
            <s-text color="subdued">{`${entry.run.workflowName} · ${entry.run.orderName}`}</s-text>
          </s-stack>
          <div className="run-detail-line">
            <ClosedLine run={entry.run} viewer="member" prefix />
          </div>
        </s-stack>
      </s-clickable>
    </s-box>
  );

  const renderRecent = (entry: Domain.RecentItem, first: boolean) =>
    entry.kind === "task"
      ? renderDone(entry, first)
      : renderClosed(entry, first);

  /**
   * "Show 25 more of N". The button is the only way past the pressed view's cut
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

  const teamCount = (teamId: string) =>
    list.counts.teamCounts.find((count) => count.teamId === teamId)?.count ?? 0;

  /**
   * A button naming the chosen team, with the list behind it, rather than a
   * full-width select: the filter only exists for a member on more than one
   * team, and as a select it was the widest and so the loudest control on a
   * screen whose subject is the list below it.
   *
   * It is rendered into `MemberBar`, beside the shop. On the workflows list it had a
   * line of its own above the views — it cannot share the view row, where a
   * merchant-typed team name would decide how many views a phone has room for
   * — and a whole line above the fold is what a bench tablet has least of.
   * The bar already holds the two answers a member needs on every screen, and
   * a set-once filter is at home beside them.
   *
   * The button carries no count. The view counts beside it are narrowed to the
   * chosen team while `counts.total` is over every team, so two numbers on
   * one row would be counting different things. Inside the menu the counts
   * stay, because there they are what is being chosen between — and they are
   * over every team whatever is selected, so the option just chosen does not
   * renumber itself.
   */
  const teamMenuId = "run-team-menu";
  const teamMenu =
    teams.length > 1 ? (
      <div>
        <s-button variant="secondary" commandFor={teamMenuId}>
          {team === null
            ? "All teams"
            : (teams.find(({ id }) => id === team)?.name ?? "All teams")}
        </s-button>
        <s-menu id={teamMenuId} accessibilityLabel="Team">
          <s-button
            onClick={() => {
              selectTeam(null);
            }}
          >
            {`All teams · ${String(list.counts.total)}`}
          </s-button>
          {teams.map((each) => (
            <s-button
              key={each.id}
              onClick={() => {
                selectTeam(each.id);
              }}
            >
              {`${each.name} · ${String(teamCount(each.id))}`}
            </s-button>
          ))}
        </s-menu>
      </div>
    ) : null;

  /**
   * The view row is the heading — literally, now that the page has none:
   * every view with its count, the selected one pressed. A zero-count view
   * stays — the row must not reflow when a count crosses zero — and stays
   * enabled, because an empty list with its empty state is a valid screen to
   * land on, a disabled button leaves the tab order altogether, and the count
   * already says zero.
   *
   * Five views and nothing else; the team filter is in the member bar.
   * Polaris has no view component either — its index pages put views in a
   * menu — so a view here is an `s-press-button`, as on the Orders index
   * (whose `viewButton` holds the rule for both view rows): `pressed`
   * reaches the native button as `aria-pressed`, and `onClick` first puts
   * `pressed` back to what React rendered, because the element flips it on
   * every click and pressing the pressed view re-renders nothing. Blocked has
   * no colour: `s-press-button` takes only `tone="neutral"`, and a member is
   * not usually the one who clears a block. Five in a grid so they never
   * wrap; `inlineSize="fill"` is what makes each one its grid cell's width,
   * so five buttons read as one row rather than five differently sized ones.
   */
  const viewRow = (
    /* Not `s-button-group`, which renders only its named action slots so
       buttons in its default slot never reach the page; and not `s-stack`,
       which wraps when it is inline. `.run-view-row` in `styles.css` is
       the grid, and says why it is not a scroller. */
    <div className="run-view-row">
      {VIEWS.map((each) => (
        <s-press-button
          key={each}
          pressed={each === view}
          inlineSize="fill"
          onClick={(event) => {
            event.currentTarget.pressed = each === view;
            selectView(each);
          }}
        >
          {`${VIEW_LABEL[each]} · ${String(list.counts[each])}`}
        </s-press-button>
      ))}
    </div>
  );

  const total = list.counts[view];
  const rows = view === "done" ? list.recent : list.items;
  const hidden = total - rows.length;
  /**
   * The way out of an empty view; `null` when there is nowhere worth sending
   * the reader. "Go to" rather than the bare label so the button cannot be
   * confused with the view-row button above it that carries the same count.
   */
  const goTo = VIEW_EMPTY[view].goTo;
  const renderEmpty = () => (
    <s-stack gap="small-300">
      <s-paragraph color="subdued">{VIEW_EMPTY[view].text}</s-paragraph>
      {goTo !== null && list.counts[goTo] > 0 && (
        <s-button
          variant="tertiary"
          onClick={() => {
            selectView(goTo);
          }}
        >
          {`Go to ${VIEW_LABEL[goTo]} · ${String(list.counts[goTo])}`}
        </s-button>
      )}
    </s-stack>
  );
  const renderList = () => (
    <s-box borderWidth="base" borderRadius="base">
      {view === "done"
        ? list.recent.map((entry, index) => renderRecent(entry, index === 0))
        : list.items.map((item, index) => renderItem(item, index === 0))}
      {hidden > 0 && renderMore(hidden)}
    </s-box>
  );
  const renderRuns = () => {
    if (loading)
      return <s-paragraph color="subdued">Loading&hellip;</s-paragraph>;
    if (total === 0) return renderEmpty();
    return renderList();
  };

  return (
    <>
      <MemberBar shop={shop} email={memberEmail} filter={teamMenu} />
      {/* No `heading`: the view row below says the same word and says more with
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
            {teams.length === 0 ? (
              <s-paragraph color="subdued">
                You&rsquo;re not on a team yet. Ask the merchant to add you to a
                team.
              </s-paragraph>
            ) : (
              <>
                {/* `.run-view-row-sticky` in `styles.css` keeps it on screen. */}
                <div className="run-view-row-sticky">{viewRow}</div>
                {renderRuns()}
              </>
            )}
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}
