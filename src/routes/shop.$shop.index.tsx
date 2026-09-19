import * as React from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
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
import { TIER_LABEL, TIERS } from "@/lib/queueTiers";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import { useMemberRunActions } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

const ShopParamInput = Schema.Struct({ shop: Schema.String });

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
 * The loader reads the default query, which is what lets its rows serve as the
 * socket query's `initialData` until the member presses a chip or a Show more.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ShopParamInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const { shop, memberId, teams } = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        const view = yield* (yield* ShopAgentClient).listQueue(shop, {
          teamIds: teams.map((team) => team.id),
          memberEmail: user.email,
          query: Domain.DEFAULT_QUEUE_QUERY,
        });
        return {
          shop,
          memberId,
          memberEmail: user.email,
          teams,
          view,
        } satisfies Domain.QueueLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/")({
  loader: ({ params }) => getLoaderData({ data: { shop: params.shop } }),
  head: () => ({ meta: [{ title: "Queue — Baton" }] }),
  component: RouteComponent,
});

/** Who finished a Done-tier entry; empty rather than "nobody" for a row written before the role column. */
const doneActorLabel = (step: Domain.WorkflowRunStep) => {
  const actor = Domain.stepCompletedBy(step);
  return actor === null ? "" : Domain.actorLabel(actor);
};

function RouteComponent() {
  const { shop, memberEmail, teams, view: loaderView } = Route.useLoaderData();
  /**
   * The queue the browser is asking for: which of its own teams, and how far
   * each tier is expanded. Client state, not a search param — a bench does not
   * share URLs — and part of the query key, because every one of these is a
   * different read of the object.
   */
  const [query, setQuery] = React.useState<Domain.QueueQuery>(
    Domain.DEFAULT_QUEUE_QUERY,
  );
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
  const { data, invalidate, agent, identified } = useSubscribedQuery({
    queryKey: ["shop-queue", shop, query],
    subscribe: (stub, subscriberId) =>
      stub.subscribeQueue({ subscriberId, query }),
    initialData: Domain.isDefaultQuery(query) ? loaderView : undefined,
  });
  /**
   * Chip counts are the same for every query (they are over every team), so
   * the loader's stand in while a new key is in flight. The tiers are not:
   * for a non-default query with no previous rows to keep, the page says it
   * is loading rather than paint the unnarrowed loader rows under a pressed
   * chip.
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
    () =>
      new Set<string>(
        TIERS.flatMap((tier) =>
          view.tiers[tier].items.map((item) => item.run.id),
        ),
      ),
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

  /** A chip resets every limit: "Show 10 more" on All is not a promise about Engraving. */
  const selectTeam = (team: Domain.TeamId | null) => {
    setQuery({ team, limits: Domain.DEFAULT_QUEUE_LIMITS });
  };

  const showMore = (tier: keyof Domain.QueueLimits) => {
    setQuery((current) => ({
      ...current,
      limits: {
        ...current.limits,
        [tier]: Math.min(
          current.limits[tier] + Domain.QUEUE_PAGE,
          Domain.QUEUE_LIMIT_MAX,
        ),
      },
    }));
  };

  const setDone = (limit: number) => {
    setQuery((current) => ({
      ...current,
      limits: { ...current.limits, done: limit },
    }));
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
    tier: Domain.QueueTier,
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
        background={!flagged && tier === "mine" ? "subdued" : "base"}
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
                <s-text color="subdued">{detailLine()}</s-text>
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
   * "Show 10 more of N". The button is the only way past a tier's cap and it
   * asks the object for the deeper read rather than revealing rows the page
   * already holds, so the count it names is the object's count.
   */
  const renderMore = (tier: keyof Domain.QueueLimits, hidden: number) => (
    <s-box padding="small-300 base">
      <s-button
        variant="tertiary"
        inlineSize="fill"
        disabled={query.limits[tier] >= Domain.QUEUE_LIMIT_MAX}
        onClick={() => {
          showMore(tier);
        }}
      >
        {`Show ${String(Domain.QUEUE_PAGE)} more of ${String(hidden)}`}
      </s-button>
    </s-box>
  );

  const teamCount = (teamId: string) =>
    view.teamCounts.find((count) => count.teamId === teamId)?.count ?? 0;

  const chips =
    teams.length > 1 ? (
      <s-stack direction="inline" gap="small-300">
        <s-button
          variant={query.team === null ? "primary" : "secondary"}
          onClick={() => {
            selectTeam(null);
          }}
        >
          {`All · ${String(view.total)}`}
        </s-button>
        {teams.map((team) => (
          <s-button
            key={team.id}
            variant={query.team === team.id ? "primary" : "secondary"}
            onClick={() => {
              selectTeam(team.id);
            }}
          >
            {`${team.name} · ${String(teamCount(team.id))}`}
          </s-button>
        ))}
      </s-stack>
    ) : null;

  const shown = TIERS.reduce((sum, tier) => sum + view.tiers[tier].total, 0);

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
                {chips}
                {loading && (
                  <s-paragraph color="subdued">Loading&hellip;</s-paragraph>
                )}
                {!loading && shown === 0 && (
                  <s-paragraph color="subdued">
                    Nothing to do right now.
                  </s-paragraph>
                )}
                {!loading &&
                  TIERS.map((tier) => {
                    const { items, total } = view.tiers[tier];
                    if (total === 0) return null;
                    const hidden = total - items.length;
                    return (
                      <s-stack key={tier} gap="small-300">
                        {/* The heading counts the whole tier; "showing N" is
                          the only place the page admits it is holding less,
                          so the number a member reads is the number of things
                          waiting. */}
                        <s-stack
                          direction="inline"
                          gap="small-300"
                          alignItems="center"
                        >
                          <s-heading>
                            {`${TIER_LABEL[tier]} · ${String(total)}`}
                          </s-heading>
                          {hidden > 0 && (
                            <s-text color="subdued">
                              {`showing ${String(items.length)}`}
                            </s-text>
                          )}
                        </s-stack>
                        <s-box borderWidth="base" borderRadius="base">
                          {items.map((item, index) =>
                            renderItem(item, tier, index === 0),
                          )}
                          {hidden > 0 && renderMore(tier, hidden)}
                        </s-box>
                      </s-stack>
                    );
                  })}
                {!loading && view.done.total > 0 && (
                  <s-stack gap="small-300">
                    <s-stack
                      direction="inline"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-heading>
                        {`Done today · ${String(view.done.total)}`}
                      </s-heading>
                      <s-button
                        variant="tertiary"
                        onClick={() => {
                          setDone(
                            query.limits.done === 0 ? Domain.QUEUE_PAGE : 0,
                          );
                        }}
                      >
                        {query.limits.done === 0 ? "Show" : "Hide"}
                      </s-button>
                    </s-stack>
                    {query.limits.done > 0 && view.done.items.length > 0 && (
                      <s-box borderWidth="base" borderRadius="base">
                        {view.done.items.map((entry, index) =>
                          renderDone(entry, index === 0),
                        )}
                        {view.done.items.length < view.done.total &&
                          renderMore(
                            "done",
                            view.done.total - view.done.items.length,
                          )}
                      </s-box>
                    )}
                  </s-stack>
                )}
              </>
            )}
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}
