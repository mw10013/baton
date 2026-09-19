import * as React from "react";

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberBar } from "@/components/MemberBar";
import {
  FlagBanner,
  flagBody,
  flagHeading,
  flagTone,
  Prose,
  RunItem,
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
   * Run ids whose detail is showing. Nothing is open on first paint, not even
   * Mine: every open row ships its attributes, instructions, note, and step
   * buttons, and sixteen of them expanded is what put the first paint at 135
   * KB against a 100 KB target. The member's own Start opens the row they just
   * took, which is the one they are about to look at; everything else opens on
   * a tap.
   */
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
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
   * `open` is pruned to the rows on the page whenever the view changes: an id
   * whose row has left the queue is forgotten, so a run that comes back later
   * (an Undo, a reconcile) arrives collapsed like any other newcomer rather
   * than reopening unasked, and the set cannot grow for the life of the mount.
   */
  const shownIds = React.useMemo(
    () => new Set<string>(view.items.map((item) => item.run.id)),
    [view],
  );
  // Adjusted during render, not in an effect, so the pruned set paints in the
  // same pass as the view that pruned it (React's "storing information from
  // previous renders" pattern).
  const [prunedFor, setPrunedFor] = React.useState(shownIds);
  if (prunedFor !== shownIds) {
    setPrunedFor(shownIds);
    const next = new Set([...open].filter((id) => shownIds.has(id)));
    if (next.size !== open.size) setOpen(next);
  }

  const toggle = (runId: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });
  };

  /**
   * A tab is a different list: depth resets and expansions close, because
   * "Show 25 more" of Up next is not a promise about Blocked. `replace: true`
   * so Back leaves the queue rather than walking the member back through every
   * tab they glanced at.
   */
  const selectTab = (next: Domain.QueueTab) => {
    if (next === tab) return;
    setLimit(Domain.QUEUE_PAGE);
    setOpen(new Set());
    void navigate({ search: { tab: next }, replace: true });
  };

  /** A team change is a new list too: same reset, and it stays out of the URL. */
  const selectTeam = (next: Domain.TeamId | null) => {
    setTeam(next);
    setLimit(Domain.QUEUE_PAGE);
    setOpen(new Set());
  };

  const showMore = () => {
    setLimit((current) =>
      Math.min(current + Domain.QUEUE_PAGE, Domain.QUEUE_LIMIT_MAX),
    );
  };

  /**
   * `flagged` hides Start and Done. A flag means the work has stopped or
   * changed under the maker, so a Start button beneath a banner that says
   * "Blocked" is the row arguing with itself; the one action offered is the
   * one in the banner. The fixer's extra tap (Unblock, then Done) is the
   * price, and they are the rare reader.
   */
  /**
   * `offered` is the step whose action the row already shows, so the detail
   * does not repeat that button under it: Start when the step is untouched,
   * Done once it is in hand. The one button the row cannot offer stays — Done
   * on an untouched step, for the maker who finished without pressing Start.
   */
  const renderStep = (
    step: Domain.QueueStep,
    flagged: boolean,
    offered: boolean,
  ) => {
    const started = step.startedAt !== null;
    /** The viewer's own name is noise on their own row; anyone else's is the point. */
    const startedBy = Domain.stepStartedBy(step);
    const startedBySomeoneElse =
      startedBy === null ||
      (startedBy.role === "member" && startedBy.email === memberEmail)
        ? null
        : startedBy;
    const reopenedBy = Domain.stepReopenedBy(step);
    return (
      <s-box
        key={step.id}
        padding="small"
        borderWidth="base"
        borderRadius="base"
        background="subdued"
      >
        <s-stack gap="small-300">
          <s-text type="strong">{step.name}</s-text>
          {step.instructions !== null && <s-text>{step.instructions}</s-text>}
          {started && (
            <s-text color="subdued">
              In progress since{" "}
              <LocalDateTime value={step.startedAt ?? 0} format="time" />
              {startedBySomeoneElse === null
                ? ""
                : ` by ${Domain.actorLabel(startedBySomeoneElse)}`}
            </s-text>
          )}
          {reopenedBy !== null && step.reopenedAt !== null && (
            <s-text color="subdued">
              {`Reopened by ${Domain.actorLabel(reopenedBy)} · `}
              <LocalDateTime value={step.reopenedAt} format="relative" />
            </s-text>
          )}
          {step.note !== null && (
            <Prose color="subdued">{Domain.stepNoteLine(step)}</Prose>
          )}
          {!flagged && !(offered && started) && (
            <s-stack direction="inline" gap="base">
              {!started && !offered && (
                <s-button
                  variant="secondary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.start.mutate(step.id);
                  }}
                >
                  Start
                </s-button>
              )}
              <s-button
                variant="primary"
                disabled={actions.pending}
                onClick={() => {
                  actions.complete.mutate(step.id);
                }}
              >
                Done
              </s-button>
            </s-stack>
          )}
        </s-stack>
      </s-box>
    );
  };

  /**
   * One row per queue item, in three columns: the order, the work, the action.
   * The row is not itself one `s-clickable` — the action button sits inside it
   * and a button inside a button is neither valid nor operable — so only the
   * middle column toggles the detail.
   *
   * Line two says the one thing the reader needs and no more: why it stopped,
   * who has it, or where it is in the run. Everything else is behind the tap.
   */
  const renderItem = (
    item: Domain.QueueItem,
    tab: Domain.QueueTab,
    first: boolean,
  ) => {
    const { run, steps } = item;
    const flagged = run.flag !== null;
    const [step, ...rest] = steps;
    const started = step.startedAt !== null;
    const startedBy = Domain.stepStartedBy(step);
    const expanded = open.has(run.id);
    const stepLine = `Step ${String(step.stage)} of ${String(item.stageCount)} · ${step.teamName}`;
    const detailLine = () => {
      if (flagged) return flagBody(run) ?? stepLine;
      if (!started) return stepLine;
      if (startedBy === null) return "In progress";
      const who =
        startedBy.role === "member" && startedBy.email === memberEmail
          ? "you"
          : Domain.actorLabel(startedBy);
      return `In progress · ${who}`;
    };
    const action = () => {
      if (flagged)
        return (
          <s-button
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              actions.dismiss.mutate(run.id);
            }}
          >
            {run.flag === "blocked" ? "Unblock" : "Dismiss"}
          </s-button>
        );
      /**
       * Several ready steps: one button would act on the first and say
       * nothing about the rest, so the row offers a menu naming each step
       * with its own action instead. The detail keeps every step's buttons
       * too, because nothing here is `offered`.
       */
      if (rest.length > 0) {
        const menuId = `queue-actions-${run.id}`;
        return (
          <>
            <s-button
              variant="secondary"
              disabled={actions.pending}
              commandFor={menuId}
            >
              Actions
            </s-button>
            <s-menu
              id={menuId}
              accessibilityLabel={`Steps of ${run.orderName}`}
            >
              {steps.map((each) =>
                each.startedAt === null ? (
                  <s-button
                    key={each.id}
                    onClick={() => {
                      actions.start.mutate(each.id);
                      setOpen((current) => new Set(current).add(run.id));
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
          </>
        );
      }
      if (started)
        return (
          <s-button
            variant="primary"
            disabled={actions.pending}
            onClick={() => {
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
          onClick={() => {
            actions.start.mutate(step.id);
            setOpen((current) => new Set(current).add(run.id));
          }}
        >
          Start
        </s-button>
      );
    };
    return (
      <s-box
        key={run.id}
        padding="small-100 base"
        /* Two marks rather than two tinted rows: Polaris backgrounds are
           subdued / base / strong, with no critical or success surface to tint
           one with. A flag gets an inline-start rule under its tone badge; a
           row the reader has in hand gets the subdued surface. */
        background={!flagged && tab === "mine" ? "subdued" : "base"}
        borderWidth={`${first ? "none" : "base"} none ${flagged ? "large-100" : "none"} none`}
        borderColor={flagged ? "strong" : "base"}
      >
        <s-stack gap="small-300">
          <s-grid
            gridTemplateColumns="auto 1fr auto"
            gap="small-300"
            alignItems="center"
          >
            <Link to="/shop/$shop/work/$runId" params={{ shop, runId: run.id }}>
              {run.orderName}
            </Link>
            <s-clickable
              accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${run.orderName}`}
              aria-expanded={expanded}
              onClick={() => {
                toggle(run.id);
              }}
            >
              <s-stack gap="small-500">
                <s-stack direction="inline" gap="small-500" alignItems="center">
                  <s-text type="strong">{step.name}</s-text>
                  {rest.length > 0 && (
                    <s-text color="subdued">{`+${String(rest.length)}`}</s-text>
                  )}
                  <s-text color="subdued">{run.lineItemTitle}</s-text>
                  {flagged && (
                    <s-badge tone={flagTone(run) ?? "critical"}>
                      {flagHeading(run) ?? ""}
                    </s-badge>
                  )}
                </s-stack>
                {/* `.queue-detail-line` in `styles.css` cuts it to two lines. */}
                <div className="queue-detail-line">
                  <s-text color="subdued">{detailLine()}</s-text>
                </div>
              </s-stack>
            </s-clickable>
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-text color="subdued">
                <LocalDateTime value={run.orderProcessedAt} format="relative" />
              </s-text>
              {action()}
            </s-stack>
          </s-grid>
          {expanded && (
            <s-stack gap="small-300">
              <RunItem run={run} />
              {item.note !== null && item.note.length > 0 && (
                <Prose color="subdued">{`Order note: ${item.note}`}</Prose>
              )}
              <FlagBanner
                run={run}
                actions={
                  <s-button
                    slot="secondary-actions"
                    variant="secondary"
                    disabled={actions.pending}
                    onClick={() => {
                      actions.dismiss.mutate(run.id);
                    }}
                  >
                    {run.flag === "blocked" ? "Unblock" : "Dismiss"}
                  </s-button>
                }
              />
              {steps.map((each) =>
                renderStep(
                  each,
                  flagged,
                  rest.length === 0 && each.id === step.id,
                ),
              )}
            </s-stack>
          )}
        </s-stack>
      </s-box>
    );
  };

  const renderDone = (entry: Domain.DoneItem, first: boolean) => (
    <s-box
      key={entry.step.id}
      padding="small-100 base"
      borderWidth={first ? "none" : "base none none none"}
    >
      <s-grid
        gridTemplateColumns="auto 1fr auto"
        gap="small-300"
        alignItems="center"
      >
        <Link
          to="/shop/$shop/work/$runId"
          params={{ shop, runId: entry.run.id }}
        >
          {entry.run.orderName}
        </Link>
        <s-stack gap="small-500">
          <s-stack direction="inline" gap="small-500" alignItems="center">
            <s-text type="strong">{entry.step.name}</s-text>
            <s-text color="subdued">{entry.run.lineItemTitle}</s-text>
          </s-stack>
          <s-text color="subdued">
            {`by ${doneActorLabel(entry.step)} at `}
            <LocalDateTime value={entry.step.completedAt ?? 0} format="time" />
            {entry.step.note === null
              ? ""
              : ` · ${Domain.stepNoteLine(entry.step)}`}
          </s-text>
        </s-stack>
        {entry.undoBlockedBy === null ? (
          <s-button
            variant="secondary"
            disabled={actions.pending}
            onClick={() => {
              actions.uncomplete.mutate(entry.step.id);
            }}
          >
            Undo
          </s-button>
        ) : (
          <s-text color="subdued">
            {`${entry.undoBlockedBy.teamName} started ${entry.undoBlockedBy.stepName} · ask them`}
          </s-text>
        )}
      </s-grid>
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
   * A select rather than a row of chips: the team list is unbounded, and a
   * select whose value is the team already reads as the pressed chip, so this
   * is one control where the chips were a row that wrapped. Its counts are
   * over every team whatever is selected, so the option just chosen does not
   * renumber itself.
   */
  const teamSelect =
    teams.length > 1 ? (
      <s-select
        label="Team"
        labelAccessibilityVisibility="exclusive"
        value={team ?? ""}
        onChange={(event) => {
          const value = event.currentTarget.value;
          selectTeam(teams.find(({ id }) => id === value)?.id ?? null);
        }}
      >
        <s-option value="">{`All teams · ${String(view.counts.total)}`}</s-option>
        {teams.map((each) => (
          <s-option key={each.id} value={each.id}>
            {`${each.name} · ${String(teamCount(each.id))}`}
          </s-option>
        ))}
      </s-select>
    ) : null;

  /**
   * The strip is the heading: every tab with its count, the open one pressed.
   * A zero-count tab stays — the strip must not reflow when a count crosses
   * zero — and stays enabled, because an empty list with its empty state is a
   * valid screen to land on. Blocked goes critical only while it has rows, so
   * the one colour on the strip always means something is stopped.
   */
  const strip = (
    <div className="queue-strip-tabs">
      {/* `s-stack`, not `s-button-group`: the group renders only its named
          action slots, so buttons in its default slot never reach the page. */}
      <s-stack direction="inline" gap="small-300">
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
      </s-stack>
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
        : view.items.map((item, index) => renderItem(item, tab, index === 0))}
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
      <s-page heading="Queue" inlineSize="small">
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
                    {teamSelect}
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
