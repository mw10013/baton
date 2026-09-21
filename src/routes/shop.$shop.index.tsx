import * as React from "react";

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
import { TAB_EMPTY, TAB_LABEL, TABS } from "@/lib/queueTiers";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import { useMemberRunActions } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

const LoaderInput = Schema.Struct({
  shop: Schema.String,
  tab: Domain.QueueTab,
});

/**
 * The queue's first paint. SSR, so it cannot be a socket call: `requireMember`
 * resolves the shop and the member's teams from the cookie, and `listQueue`
 * reads the object through `ShopAgentClient`.
 *
 * The actions go the other way — over the member socket, where the same
 * `requireMember` result is already on the connection
 * (`useMemberRunActions`). Either way `teamIds`, `memberId`, and
 * `memberEmail` are resolved server-side and never sent by the browser.
 *
 * The query it reads comes back beside the view, which is what lets its rows
 * serve as the socket query's `initialData` until the member narrows to a team
 * or presses Show more. The tab is in the URL and so is the loader's to read;
 * team and depth are not, so the loader always reads every team one page deep.
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
        const query: Domain.QueueQuery = {
          team: null,
          tab: data.tab,
          limit: Domain.QUEUE_PAGE,
        };
        const view = yield* (yield* ShopAgentClient).listQueue(shop, {
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
        } satisfies Domain.QueueLoaderData;
      }),
    ),
  );

/**
 * The tab is the one thing about the queue worth putting in the URL: it is
 * what a member is looking at, so a link, a refresh, and the back button all
 * mean something. An invalid `?tab=` fails here and the router's error
 * boundary shows; nothing on the page links to one.
 */
const QueueSearch = Schema.Struct({
  tab: Schema.optionalKey(Domain.QueueTab),
});

export const Route = createFileRoute("/shop/$shop/")({
  validateSearch: Schema.toStandardSchemaV1(QueueSearch),
  loaderDeps: ({ search }) => ({ tab: search.tab ?? Domain.DEFAULT_QUEUE_TAB }),
  loader: ({ params, deps }) =>
    getLoaderData({ data: { shop: params.shop, tab: deps.tab } }),
  /**
   * A tab is a different loader key, so its first visit runs the loader once
   * and that read is the socket query's `initialData` for the new key; after
   * that the socket owns the data and pushes keep it current. Without this the
   * default `staleTime: 0` would re-run the loader on every return to a tab
   * whose data the socket already holds.
   */
  staleTime: Infinity,
  head: () => ({ meta: [{ title: "Queue — Baton" }] }),
  component: RouteComponent,
});

/**
 * What every button inside a queue row must do first.
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

/** Who finished a Done-tier entry; empty rather than "nobody" for a row written before the role column. */
const doneActorLabel = (step: Domain.WorkflowRunStep) => {
  const actor = Domain.stepCompletedBy(step);
  return actor === null ? "" : Domain.actorLabel(actor);
};

function RouteComponent() {
  const {
    shop,
    memberEmail,
    teams,
    query: loaderQuery,
    view: loaderView,
  } = Route.useLoaderData();
  const { tab = Domain.DEFAULT_QUEUE_TAB } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  /**
   * Which of the member's own teams, and how far the open tab goes. Client
   * state rather than search params — a bench does not share a team or a
   * scroll depth — while the tab, which is what the member is looking at, is
   * the URL's. All three are part of the query key, because every one of them
   * is a different read of the object.
   */
  const [team, setTeam] = React.useState<Domain.TeamId | null>(null);
  const [limit, setLimit] = React.useState(Domain.QUEUE_PAGE);
  /**
   * The subscribe pattern (`Domain.Subscription`): the loader's rows paint
   * first, then `subscribeQueue` re-reads them over the socket and registers
   * this connection for pushes, so work another member finishes lands here
   * without a reload. The subscription's scope is the teams on the connection,
   * so nothing about it is named by the browser — `query` only chooses among
   * them, and the object bounds what it can ask for.
   *
   * `initialData` only while the query is the loader's: any other key is a
   * read the SSR paint never made, and `keepPreviousData` in the hook holds
   * the previous rows on screen until it returns.
   */
  const query: Domain.QueueQuery = { team, tab, limit };
  const { data, invalidate, agent, identified } = useSubscribedQuery({
    queryKey: ["shop-queue", shop, query],
    subscribe: (stub, subscriberId) =>
      stub.subscribeQueue({ subscriberId, query }),
    initialData: Domain.sameQueueQuery(query, loaderQuery)
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
   * A tab is a different list, so depth resets: "Show 25 more" of Up next is
   * not a promise about Blocked. `replace: true` so Back leaves the queue
   * rather than walking the member back through every tab they glanced at.
   */
  const selectTab = (next: Domain.QueueTab) => {
    if (next === tab) return;
    setLimit(Domain.QUEUE_PAGE);
    void navigate({ search: { tab: next }, replace: true });
  };

  /** A team change is a new list too: same reset, and it stays out of the URL. */
  const selectTeam = (next: Domain.TeamId | null) => {
    setTeam(next);
    setLimit(Domain.QUEUE_PAGE);
  };

  const showMore = () => {
    setLimit((current) =>
      Math.min(current + Domain.QUEUE_PAGE, Domain.QUEUE_LIMIT_MAX),
    );
  };

  /**
   * The row's link target, built once here. A real `href` — built through the
   * router rather than written as a string — is what keeps middle-click and
   * open-in-new-tab working on a row; the click handler beside it turns an
   * ordinary tap into a client navigation so the socket and the query cache
   * survive it. `QueueBreadcrumb` on the work page is the same pattern
   * pointing back the other way.
   */
  const workLocation = (runId: string) =>
    ({ to: "/shop/$shop/work/$runId", params: { shop, runId } }) as const;

  /**
   * One row per queue item: the whole row is one link to the work page, and
   * the action button is the only thing in it that is not. It replaced three
   * targets with three results — order link, expand, action — of which only
   * the first looked interactive; the work page shows everything the expanded
   * row used to and the run history, the editors and a printable ticket
   * besides, for the same single tap.
   *
   * Line one is the order, the step, how many more of the run's steps are
   * ready, and the flag. Line two carries the item's title — here rather than
   * beside the step name, where the two ran together with no separator — and
   * then the one thing the reader needs and no more: why it stopped, who has
   * it, or where it is in the run.
   */
  const renderItem = (item: Domain.QueueItem, first: boolean) => {
    const { run, steps } = item;
    const flagged = Domain.runIsFlagged(run);
    const [step, ...rest] = steps;
    const started = step.startedAt !== null;
    const startedBy = Domain.stepStartedBy(step);
    const menuId = `queue-actions-${run.id}`;
    const stepLine = `Step ${String(step.stage)} of ${String(item.stageCount)} · ${step.teamName}`;
    const detailLine = () => {
      if (flagged) return flagBody(run) ?? stepLine;
      if (!started) return stepLine;
      if (startedBy === null) return "In progress";
      const who = Domain.actorIsMember(startedBy, memberEmail)
        ? "you"
        : Domain.actorLabel(startedBy);
      return `In progress · ${who}`;
    };
    /**
     * `flagged` hides Start and Done. A flag means the work has stopped or
     * changed under the maker, so a Start button on a row badged "Blocked" is
     * the row arguing with itself; the one action offered is the one that
     * lifts the flag. The fixer's extra tap (Unblock, then Done) is the
     * price, and they are the rare reader.
     */
    const action = () => {
      if (flagged)
        return (
          <s-button
            variant="secondary"
            disabled={actions.pending}
            onClick={(event) => {
              insideRow(event);
              actions.dismiss.mutate(run.id);
            }}
          >
            {liftFlagLabel(run)}
          </s-button>
        );
      /**
       * Several ready steps: one button would act on the first and say
       * nothing about the rest, so the row offers a menu naming each step
       * with its own action instead.
       */
      if (rest.length > 0)
        return (
          <s-button
            variant="secondary"
            disabled={actions.pending}
            commandFor={menuId}
            onClick={insideRow}
          >
            Actions
          </s-button>
        );
      if (started)
        return (
          <s-button
            variant="primary"
            disabled={actions.pending}
            onClick={(event) => {
              insideRow(event);
              actions.complete.mutate(step.id);
            }}
          >
            Done
          </s-button>
        );
      return (
        <s-button
          variant="secondary"
          disabled={actions.pending}
          onClick={(event) => {
            insideRow(event);
            actions.start.mutate(step.id);
          }}
        >
          Start
        </s-button>
      );
    };
    return (
      <s-box
        key={run.id}
        /* One mark, not two: a flagged row gets a rule down its leading edge
           under the tone badge. The subdued surface that used to mark a row
           in hand went with the expand — it fired on the Mine tab, where
           every row qualifies, so it tinted the whole list and separated
           nothing.

           The four values are block-start, inline-end, block-end,
           inline-start: the first is the separator above every row but the
           list's first, the last is the flag. The flag used to sit in the
           third slot, which put it under the row as a heavier separator
           belonging to whatever came next. */
        borderWidth={`${first ? "none" : "base"} none none ${flagged ? "large-100" : "none"}`}
        borderColor={flagged ? "strong" : "base"}
      >
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
                {flagged && (
                  <s-badge tone={flagTone(run) ?? "critical"}>
                    {flagHeading(run) ?? ""}
                  </s-badge>
                )}
              </s-stack>
              {/* `.queue-detail-line` in `styles.css` cuts it to two lines. */}
              <div className="queue-detail-line">
                <s-text color="subdued">{`${run.lineItemTitle} · ${detailLine()}`}</s-text>
              </div>
            </s-stack>
            {action()}
          </s-grid>
        </s-clickable>
        {rest.length > 0 && (
          <s-menu id={menuId} accessibilityLabel={`Steps of ${run.orderName}`}>
            {steps.map((each) =>
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
                <s-button
                  key={each.id}
                  onClick={() => {
                    actions.complete.mutate(each.id);
                  }}
                >
                  {`Done · ${each.name}`}
                </s-button>
              ),
            )}
          </s-menu>
        )}
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
   * A finished step's row, the same shape as a waiting one. Undo always has a
   * button — disabled when something downstream has started — because a
   * missing control reads as a row that was never undoable, while a disabled
   * one beside the reason reads as the refusal it is. The reason itself goes
   * on line two: the action column is for what the reader can do, not for a
   * sentence.
   */
  const renderDone = (entry: Domain.DoneItem, first: boolean) => (
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
            <div className="queue-detail-line">
              <s-text color="subdued">
                {`${entry.run.lineItemTitle} · by ${doneActorLabel(entry.step)} at `}
                <LocalDateTime
                  value={entry.step.completedAt ?? 0}
                  format="time"
                />
                {entry.step.note === null
                  ? ""
                  : ` · ${Domain.stepNoteLine(entry.step)}`}
              </s-text>
            </div>
            {/* Its own line, outside the clamp: this is the row's account of
                why the button beside it is dead, and a reason cut off at an
                ellipsis is the refusal without the reason. */}
            {entry.undoBlockedBy !== null && (
              <s-text color="subdued">
                {`Can’t undo: ${Domain.undoBlockerLine(entry.undoBlockedBy)}`}
              </s-text>
            )}
          </s-stack>
          <s-button
            variant="secondary"
            disabled={actions.pending || doneUndo(entry)?.blockedBy !== null}
            onClick={(event) => {
              insideRow(event);
              actions.uncomplete.mutate(entry.step.id);
            }}
          >
            Undo
          </s-button>
        </s-grid>
      </s-clickable>
    </s-box>
  );

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
        disabled={limit >= Domain.QUEUE_LIMIT_MAX}
        onClick={showMore}
      >
        {`Show ${String(Math.min(Domain.QUEUE_PAGE, hidden))} more of ${String(hidden)}`}
      </s-button>
    </s-box>
  );

  const teamCount = (teamId: string) =>
    view.counts.teamCounts.find((count) => count.teamId === teamId)?.count ?? 0;

  /**
   * A button naming the chosen team, with the list behind it, rather than a
   * full-width select: the filter only exists for a member on more than one
   * team, and as a select it was the widest and so the loudest control on a
   * screen whose subject is the list below it. As a button it leads the strip
   * and takes the width of a team name.
   *
   * The button carries no count. The tab counts beside it are narrowed to the
   * chosen team while `counts.total` is over every team, so two numbers on
   * one row would be counting different things. Inside the menu the counts
   * stay, because there they are what is being chosen between — and they are
   * over every team whatever is selected, so the option just chosen does not
   * renumber itself.
   */
  const teamMenuId = "queue-team-menu";
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
   * because an empty list with its empty state is a valid screen to land on.
   * Blocked goes critical only while it has rows, so the one colour on the
   * strip always means something is stopped.
   *
   * Five tabs and nothing else. The team filter sits on its own line above
   * rather than leading this row: a team name is merchant-typed and
   * unbounded, so sharing the row makes the strip's width a function of how
   * long somebody called a team — one long name and the tabs are pushed off
   * the end of a scroller on a screen that had room for them.
   */
  const strip = (
    /* Not `s-button-group`, which renders only its named action slots so
       buttons in its default slot never reach the page; and not `s-stack`,
       which wraps when it is inline. `.queue-strip-tabs` in `styles.css` is
       the row and the scroller both. */
    <div className="queue-strip-tabs">
      {TABS.map((each) => (
        <s-button
          key={each}
          variant={each === tab ? "primary" : "secondary"}
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
  const renderQueue = () => {
    if (loading)
      return <s-paragraph color="subdued">Loading&hellip;</s-paragraph>;
    if (total === 0) return renderEmpty();
    return renderList();
  };

  return (
    <>
      <MemberBar shop={shop} email={memberEmail} />
      {/* No `heading`: the strip below says the same word and says more with
          it, and a heading block above the fold is what a bench tablet has
          least of. The document title keeps "Queue" — that is the browser
          tab, which is the one place the app's own noun does work. */}
      <s-page inlineSize="small">
        <SocketBanner />
        <s-section accessibilityLabel="Queue">
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
                {/* `.queue-strip` in `styles.css` keeps it on screen. */}
                <div className="queue-strip">
                  <s-stack gap="small-300">
                    {teamMenu}
                    {strip}
                  </s-stack>
                </div>
                {renderQueue()}
              </>
            )}
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}
