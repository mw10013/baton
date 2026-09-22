import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberBar } from "@/components/MemberBar";
import {
  flagBody,
  flagHeading,
  flagTone,
  liftFlagLabel,
} from "@/components/MemberRun";
import * as Domain from "@/lib/Domain";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { TAB_EMPTY, TAB_LABEL, TABS } from "@/lib/runTabs";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import { useMemberRunActions } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

const LoaderInput = Schema.Struct({
  shop: Schema.String,
  tab: Domain.RunTab,
  /** Text, not a {@link Domain.TeamId}: the roster resolves it (`MemberSearch` in `shop.$shop.tsx`). */
  team: Schema.String.check(Schema.isMaxLength(Domain.TEAM_SEARCH_MAX)),
  limit: Domain.RunLimit,
});

/**
 * The run list's first paint. SSR, so it cannot be a socket call: `requireMember`
 * resolves the shop and the member's teams from the cookie, and `listRuns`
 * reads the object through `ShopAgentClient`.
 *
 * The actions go the other way — over the member socket, where the same
 * `requireMember` result is already on the connection
 * (`useMemberRunActions`). Either way `teamIds`, `memberId`, and
 * `memberEmail` are resolved server-side and never sent by the browser.
 *
 * **The whole query comes from the URL, so the paint is the screen the member
 * left.** Tab, team and depth are the member's context (`MemberSearch` in
 * `shop.$shop.tsx`), which every link under `/shop/$shop` carries, so a return
 * from the work page server-renders narrowed and deepened rather than painting
 * page one of every team and correcting itself when the socket answers. The
 * query it read comes back beside the view, which is what lets these rows
 * serve as the socket query's `initialData` ({@link Domain.sameRunQuery}).
 *
 * `team` is resolved against the live roster here, not trusted: a member taken
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
          tab: data.tab,
          limit: data.limit,
        };
        const view = yield* (yield* ShopAgentClient).listRuns(shop, {
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
          view,
        } satisfies Domain.RunListLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/")({
  loaderDeps: ({ search }) => ({
    tab: search.tab ?? Domain.DEFAULT_RUN_TAB,
    team: search.team ?? "",
    limit: search.limit ?? Domain.RUN_PAGE,
  }),
  loader: ({ params, deps }) =>
    getLoaderData({ data: { shop: params.shop, ...deps } }),
  /**
   * A query is a different loader key, so its first visit runs the loader once
   * and that read is the socket query's `initialData` for the new key; after
   * that the socket owns the data and pushes keep it current. Without this the
   * default `staleTime: 0` would re-run the loader on every return to a tab,
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
 * Who finished a Done-tier entry, spelled as the waiting rows spell an actor:
 * `you` for the reader, the email for anybody else, `Merchant` for the
 * merchant. Your own address repeated down a page is the noisiest text on the
 * tier and the least informative line on it. Empty rather than "nobody" for a
 * row written before the role column.
 */
const doneActorLabel = (
  step: Domain.WorkflowRunStep,
  memberEmail: Domain.Email,
) => {
  const actor = Domain.stepCompletedBy(step);
  if (actor === null) return "";
  return Domain.actorIsMember(actor, memberEmail)
    ? "you"
    : Domain.actorLabel(actor);
};

function RouteComponent() {
  const {
    shop,
    memberEmail,
    teams,
    query: loaderQuery,
    view: loaderView,
  } = Route.useLoaderData();
  /**
   * Which list, narrowed to which team, how far down: all three from the URL
   * (`MemberSearch` in `shop.$shop.tsx`), with the defaults applied here at the
   * read. All three are part of the query key, because every one of them is a
   * different read of the object.
   *
   * A `team` the member is no longer on is read as All teams, the same
   * resolution the loader makes: the roster is what says which ids mean
   * something, the button above already falls back to that label, and the
   * alternative is a list that is empty for a reason nothing on screen states.
   */
  const {
    tab = Domain.DEFAULT_RUN_TAB,
    team: searchTeam = "",
    limit = Domain.RUN_PAGE,
  } = Route.useSearch();
  const team = teams.find(({ id }) => id === searchTeam)?.id ?? null;
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  /**
   * The subscribe pattern (`Domain.Subscription`): the loader's rows paint
   * first, then `subscribeRuns` re-reads them over the socket and registers
   * this connection for pushes, so work another member finishes lands here
   * without a reload. The subscription's scope is the teams on the connection,
   * so nothing about it is named by the browser — `query` only chooses among
   * them, and the object bounds what it can ask for.
   *
   * `initialData` only while the query is the loader's: any other key is a
   * read the SSR paint never made, and `keepPreviousData` in the hook holds
   * the previous rows on screen until it returns.
   */
  const query: Domain.RunQuery = { team, tab, limit };
  const { data, invalidate, agent, identified } = useSubscribedQuery({
    queryKey: ["shop-runs", shop, query],
    subscribe: (stub, subscriberId) =>
      stub.subscribeRuns({ subscriberId, query }),
    initialData: Domain.sameRunQuery(query, loaderQuery)
      ? loaderView
      : undefined,
  });
  /**
   * `total` and the team counts are the same for every query (they are over
   * every team), so the loader's stand in while a new key is in flight. The
   * rows are not: for a query the loader never read and with no previous rows
   * to keep, the page says it is loading rather than paint the unnarrowed
   * loader rows under a pressed tab.
   */
  const view = data ?? loaderView;
  const loading = data === undefined;
  const actions = useMemberRunActions({
    agent,
    identified,
    onSuccess: () => invalidate(),
  });

  /**
   * The three controls, all of them navigations, because all three are in the
   * URL. `replace: true` on every one so Back leaves the run list rather than
   * walking the member back through every tab and team they glanced at — the
   * filters are a screen's state, not a trail of places they have been.
   *
   * A tab or a team is a different list, so depth resets: "Show 25 more" of Up
   * next is not a promise about Blocked. `undefined` is how a key is removed,
   * which is what puts the default back and keeps it out of the URL.
   */
  const selectTab = (next: Domain.RunTab) => {
    if (next === tab) return;
    void navigate({
      search: (prev) => ({ ...prev, tab: next, limit: undefined }),
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
   * other way; the work page carries no breadcrumb of its own because that
   * mark is already a link to this screen.
   *
   * No `search`: the layout's middleware puts the member's context on this
   * link, and on the mark's link back, without either site naming the keys
   * (`MemberSearch` in `shop.$shop.tsx`).
   */
  const workLocation = (runId: string) =>
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
   * One row per run: the whole row is one link to the work page, and
   * the kebab beside it is the only thing in it that is not. It replaced
   * three targets with three results — order link, expand, action — of which
   * only the first looked interactive; the work page shows everything the
   * expanded row used to and the run history, the editors and a printable
   * ticket besides, for the same single tap.
   *
   * Line one is the order, the step, how many more of the run's steps are
   * ready, and the flag. Line two carries the item's title — here rather than
   * beside the step name, where the two ran together with no separator — and
   * then the one thing the reader needs and no more: why it stopped, who has
   * it, or where it is in the run.
   */
  const renderItem = (item: Domain.RunListItem, first: boolean) => {
    const { run, steps } = item;
    const flagged = Domain.runIsFlagged(run);
    const [step, ...rest] = steps;
    const started = step.startedAt !== null;
    const startedBy = Domain.stepStartedBy(step);
    const menuId = `run-actions-${run.id}`;
    const stepLine = `Step ${String(step.stage)} of ${String(item.stageCount)}${showTeam ? ` · ${step.teamName}` : ""}`;
    /**
     * A row you started says where it is in the run, not "In progress · you".
     * Starting a step is what puts the row in Mine ({@link Domain.tierOf}),
     * and Put back is the inverse that takes it out again, so those words are true of every row under that pressed tab and so
     * distinguish none of them. A row a teammate started says who instead,
     * which is the whole of what the Teammates tab is for. The test is the
     * starter rather than the open tab because a run can have several ready
     * steps on the member's teams and `steps[0]` is the lowest-positioned
     * one, not necessarily theirs.
     */
    const detailLine = () => {
      if (flagged) return flagBody(run) ?? stepLine;
      if (!started) return stepLine;
      if (startedBy === null) return "In progress";
      return Domain.actorIsMember(startedBy, memberEmail)
        ? stepLine
        : `In progress · ${Domain.actorLabel(startedBy)}`;
    };
    /**
     * Every verb the row offers, inside the row's menu — the shape Polaris's
     * own resource list gives a row
     * (`refs/shopify-docs/docs/api/app-home/latest/patterns/compositions/resource-list.md`,
     * "Provide search, filtering, and row selection for a resource list"):
     * one tertiary `menu-horizontal` button in the `auto` cell, no labelled
     * verb and no primary. Primary and secondary are a page's hierarchy, held
     * in `s-page`'s action slots; a row has neither. One fixed-size control
     * per row is also what stops the action column resizing itself row by row
     * and dragging the text column's edge with it.
     *
     * `flagged` leaves only the verb that lifts the flag. A flag means the
     * work has stopped or changed under the maker, so Start on a run reported
     * cancelled is the row arguing with itself. The fixer's extra step
     * (Unblock, then Done) is the price, and they are the rare reader.
     *
     * A single ready step gives the bare verb: the step is named on line one
     * of the row this menu belongs to. Several give one item each, because a
     * single verb would act on the first and say nothing about the rest.
     *
     * A started step also gets Put back, the one-press fix for a Start
     * pressed by mistake. It follows {@link Domain.stepActions}: wherever Done
     * is, on a started step, for the whole team, so a row a teammate started
     * offers it too. Every row here is open, ready and on the member's teams,
     * and a flagged row returned above.
     */
    const menuItems = () => {
      if (flagged)
        return [
          <s-button
            key="lift"
            onClick={() => {
              actions.dismiss.mutate(run.id);
            }}
          >
            {liftFlagLabel(run)}
          </s-button>,
        ];
      if (rest.length > 0)
        return steps.flatMap((each) =>
          each.startedAt === null ? (
            <s-button
              key={each.id}
              onClick={() => {
                actions.start.mutate(each.id);
              }}
            >
              {`Start · ${each.name}`}
            </s-button>
          ) : (
            [
              <s-button
                key={each.id}
                onClick={() => {
                  actions.complete.mutate(each.id);
                }}
              >
                {`Done · ${each.name}`}
              </s-button>,
              <s-button
                key={`${each.id}-put-back`}
                onClick={() => {
                  actions.unstart.mutate(each.id);
                }}
              >
                {`Put back · ${each.name}`}
              </s-button>,
            ]
          ),
        );
      return started
        ? [
            <s-button
              key={step.id}
              onClick={() => {
                actions.complete.mutate(step.id);
              }}
            >
              Done
            </s-button>,
            <s-button
              key={`${step.id}-put-back`}
              onClick={() => {
                actions.unstart.mutate(step.id);
              }}
            >
              Put back
            </s-button>,
          ]
        : [
            <s-button
              key={step.id}
              onClick={() => {
                actions.start.mutate(step.id);
              }}
            >
              Start
            </s-button>,
          ];
    };
    return (
      /* The separator above every row but the list's first, and nothing else.
         A flagged row used to draw a rule down its leading edge as well; it
         went the way of the subdued surface that marked a row in hand, and
         for the same reason. A flag puts the row in the Blocked tier
         ({@link Domain.tierOf}) and nowhere else, so the mark fired on every
         row of the only tab it could appear on and separated nothing. It also
         ran past the list container's rounded corner, which a radius does not
         clip without `overflow: hidden`. */
      <s-box key={run.id} borderWidth={first ? "none" : "base none none none"}>
        <s-clickable
          href={router.buildLocation(workLocation(run.id)).href}
          accessibilityLabel={`Open ${run.orderName}`}
          padding="small-100 base"
          onClick={(event) => {
            event.preventDefault();
            void router.navigate(workLocation(run.id));
          }}
        >
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="small-300"
            alignItems="center"
          >
            <s-stack gap="small-500">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text color="subdued">{run.orderName}</s-text>
                <s-text type="strong">{step.name}</s-text>
                {rest.length > 0 && (
                  <s-text color="subdued">{`+${String(rest.length)}`}</s-text>
                )}
                {/* Every flag but a hold. A held run's badge would read
                    "Blocked" under a pressed Blocked tab, beside an Unblock
                    item, above the reason as typed — one fact said four
                    times. The reconcile flags are the opposite: each names a
                    different thing Shopify did, which is the content of the
                    tab rather than a repeat of it. */}
                {flagged && !Domain.runIsBlocked(run) && (
                  <s-badge tone={flagTone(run) ?? "critical"}>
                    {flagHeading(run) ?? ""}
                  </s-badge>
                )}
              </s-stack>
              {/* `.run-detail-line` in `styles.css` cuts it to two lines. */}
              <div className="run-detail-line">
                <s-text color="subdued">{`${run.lineItemTitle} · ${detailLine()}`}</s-text>
              </div>
            </s-stack>
            <s-button
              icon="menu-horizontal"
              variant="tertiary"
              accessibilityLabel={`Actions for ${run.orderName}`}
              disabled={actions.pending}
              commandFor={menuId}
              onClick={insideRow}
            />
          </s-grid>
        </s-clickable>
        <s-menu id={menuId} accessibilityLabel={`Actions for ${run.orderName}`}>
          {menuItems()}
        </s-menu>
      </s-box>
    );
  };

  /** The same rule as the work page's Undo, {@link Domain.stepActions}, on the tier's own row. */
  const doneUndo = (entry: Domain.DoneItem) =>
    Domain.stepActions(
      entry.run,
      { ...entry.step, ready: false, undoBlockedBy: entry.undoBlockedBy },
      teams.map((team) => team.id),
    ).undo;

  /**
   * A finished step's row, the same shape as a waiting one: the row is a link
   * to the work page and a kebab beside it holds Undo.
   *
   * The kebab is there only while Undo is allowed. The rule used to be the
   * other way — a disabled button beside the clause naming its blocker, on
   * the reasoning that a missing control reads as a row that was never
   * undoable while a disabled one reads as the refusal it is. That holds
   * while refusal is the exception. Here it is the rule: undo is blocked the
   * moment anything downstream starts, so a running shop's tier was mostly
   * dead buttons each explaining itself in a third line. When most rows can
   * offer nothing, absence is the norm a reader learns in two rows and the
   * kebab is the signal. The refusal is not lost — the work page the row
   * links to states it in full, for the reader who went looking.
   */
  const renderDone = (entry: Domain.DoneItem, first: boolean) => {
    const menuId = `run-undo-${entry.step.id}`;
    const undoable = doneUndo(entry)?.blockedBy === null;
    return (
      <s-box
        key={entry.step.id}
        borderWidth={first ? "none" : "base none none none"}
      >
        <s-clickable
          href={router.buildLocation(workLocation(entry.run.id)).href}
          accessibilityLabel={`Open ${entry.run.orderName}`}
          padding="small-100 base"
          onClick={(event) => {
            event.preventDefault();
            void router.navigate(workLocation(entry.run.id));
          }}
        >
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="small-300"
            alignItems="center"
          >
            <s-stack gap="small-500">
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-text color="subdued">{entry.run.orderName}</s-text>
                <s-text type="strong">{entry.step.name}</s-text>
              </s-stack>
              <div className="run-detail-line">
                <s-text color="subdued">
                  {`${entry.run.lineItemTitle} · by ${doneActorLabel(entry.step, memberEmail)} at `}
                  <LocalDateTime
                    value={entry.step.completedAt ?? 0}
                    format="time"
                  />
                  {entry.step.note === null
                    ? ""
                    : ` · ${Domain.stepNoteLine(entry.step)}`}
                </s-text>
              </div>
            </s-stack>
            {undoable && (
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
        {undoable && (
          <s-menu
            id={menuId}
            accessibilityLabel={`Actions for ${entry.run.orderName}`}
          >
            <s-button
              onClick={() => {
                actions.uncomplete.mutate(entry.step.id);
              }}
            >
              Undo
            </s-button>
          </s-menu>
        )}
      </s-box>
    );
  };

  /**
   * "Show 25 more of N". The button is the only way past the open tab's cut
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
    view.counts.teamCounts.find((count) => count.teamId === teamId)?.count ?? 0;

  /**
   * A button naming the chosen team, with the list behind it, rather than a
   * full-width select: the filter only exists for a member on more than one
   * team, and as a select it was the widest and so the loudest control on a
   * screen whose subject is the list below it.
   *
   * It is rendered into `MemberBar`, beside the shop. On the run list it had a
   * line of its own above the tabs — it cannot share the tab row, where a
   * merchant-typed team name would decide how many tabs a phone has room for
   * — and a whole line above the fold is what a bench tablet has least of.
   * The bar already holds the two answers a member needs on every screen, and
   * a set-once filter is at home beside them.
   *
   * The button carries no count. The tab counts beside it are narrowed to the
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
            {`All teams · ${String(view.counts.total)}`}
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
   * The strip is the heading — literally, now that the page has none: every
   * tab with its count, the open one pressed. A zero-count tab stays — the
   * strip must not reflow when a count crosses zero — and stays enabled,
   * because an empty list with its empty state is a valid screen to land on,
   * a disabled button leaves the tab order altogether, and the count already
   * says zero. Blocked goes critical only while it has rows, so the one
   * colour on the strip always means something is stopped.
   *
   * Five tabs and nothing else; the team filter is in the member bar. Polaris
   * has no tab component — its index patterns filter with a search field, a
   * popover and a select — so a tab here is an `s-button`, pressed by
   * `variant="primary"`, which is the only selected state any of these
   * components has. `inlineSize="fill"` is what makes each one its grid
   * cell's width, so five buttons read as one strip rather than five
   * differently sized ones.
   */
  const strip = (
    /* Not `s-button-group`, which renders only its named action slots so
       buttons in its default slot never reach the page; and not `s-stack`,
       which wraps when it is inline. `.run-strip-tabs` in `styles.css` is
       the grid, and says why it is not a scroller. */
    <div className="run-strip-tabs">
      {TABS.map((each) => (
        <s-button
          key={each}
          variant={each === tab ? "primary" : "secondary"}
          inlineSize="fill"
          tone={
            each === "attention" && view.counts.attention > 0
              ? "critical"
              : "auto"
          }
          aria-pressed={each === tab}
          onClick={() => {
            selectTab(each);
          }}
        >
          {`${TAB_LABEL[each]} · ${String(view.counts[each])}`}
        </s-button>
      ))}
    </div>
  );

  const total = view.counts[tab];
  const rows = tab === "done" ? view.done : view.items;
  const hidden = total - rows.length;
  /**
   * The way out of an empty tab; `null` when there is nowhere worth sending
   * the reader. "Go to" rather than the bare label so the button cannot be
   * confused with the strip button above it that carries the same count.
   */
  const goTo = TAB_EMPTY[tab].goTo;
  const renderEmpty = () => (
    <s-stack gap="small-300">
      <s-paragraph color="subdued">{TAB_EMPTY[tab].text}</s-paragraph>
      {goTo !== null && view.counts[goTo] > 0 && (
        <s-button
          variant="tertiary"
          onClick={() => {
            selectTab(goTo);
          }}
        >
          {`Go to ${TAB_LABEL[goTo]} · ${String(view.counts[goTo])}`}
        </s-button>
      )}
    </s-stack>
  );
  const renderList = () => (
    <s-box borderWidth="base" borderRadius="base">
      {tab === "done"
        ? view.done.map((entry, index) => renderDone(entry, index === 0))
        : view.items.map((item, index) => renderItem(item, index === 0))}
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
      {/* No `heading`: the strip below says the same word and says more with
          it, and a heading block above the fold is what a bench tablet has
          least of. The document title says "Workflows" — that is the
          browser tab, which is the one place the app's own noun does work. */}
      <s-page inlineSize="small">
        <SocketBanner />
        <s-section accessibilityLabel="Workflows">
          <s-stack gap="base">
            {actions.banner !== null && (
              <s-banner tone="critical">{actions.banner}</s-banner>
            )}
            {teams.length === 0 ? (
              <s-paragraph color="subdued">
                You&rsquo;re not on a team yet. Ask the shop owner to add you to
                a team to see work.
              </s-paragraph>
            ) : (
              <>
                {/* `.run-strip` in `styles.css` keeps it on screen. */}
                <div className="run-strip">{strip}</div>
                {renderRuns()}
              </>
            )}
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}
