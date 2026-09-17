import * as React from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberBar } from "@/components/MemberBar";
import { FlagBanner, Prose, RunItem } from "@/components/MemberRun";
import * as Domain from "@/lib/Domain";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { TIER_LABEL, TIERS, tierQueue } from "@/lib/queueTiers";
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

/**
 * How many Up next cards render before the "Show all" button. The tier is
 * oldest-order-first, so the top of it *is* the work: a member reaches past
 * ten only to find one order by name, and that is the rarer trip. It is also
 * the whole of the scaling story for 1.0 — the other tiers are small by
 * construction (one person holds a few things; a team has a few benches),
 * and Up next is the only unbounded one.
 */
const UP_NEXT_CAP = 10;

/** Who finished a Done-tier entry; empty rather than "nobody" for a row written before the role column. */
const doneActorLabel = (step: Domain.WorkflowRunStep) => {
  const actor = Domain.stepCompletedBy(step);
  return actor === null ? "" : Domain.actorLabel(actor);
};

/** Whether the card has a step for `teamId`: the chip filter and the chip counts. */
const onTeam = (item: Domain.QueueItem, teamId: string) =>
  item.steps.some((step) => step.teamId === teamId);

function RouteComponent() {
  const { shop, memberEmail, teams, view: initialView } = Route.useLoaderData();
  /**
   * The subscribe pattern (`Domain.Subscription`): the loader's rows paint
   * first, then `subscribeQueue` re-reads them over the socket and registers
   * this connection for pushes, so work another member finishes lands here
   * without a reload. The subscription's scope is the teams on the connection,
   * so nothing about it is named by the browser.
   */
  const {
    data: view,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ["shop-queue", shop],
    subscribe: (stub, subscriberId) => stub.subscribeQueue({ subscriberId }),
    initialData: initialView,
  });
  const actions = useMemberRunActions({
    agent,
    identified,
    onSuccess: () => invalidate(),
  });
  /** The team chip; client state, not a search param — a bench does not share URLs. */
  const [teamFilter, setTeamFilter] = React.useState<string | null>(null);
  const [doneOpen, setDoneOpen] = React.useState(false);
  /** Reset by the chip: "Show all 37" on All is not a promise about Engraving. */
  const [upNextAll, setUpNextAll] = React.useState(false);

  const visible =
    teamFilter === null
      ? view.items
      : view.items.filter((item) => onTeam(item, teamFilter));
  const tiers = tierQueue(visible, memberEmail);
  const doneVisible =
    teamFilter === null
      ? view.done
      : view.done.filter((entry) => entry.step.teamId === teamFilter);

  /**
   * `flagged` hides Start and Done. A flag means the work has stopped or
   * changed under the maker, so a Start button beneath a banner that says
   * "Blocked" is the card arguing with itself; the one action offered is the
   * one in the banner. The fixer's extra tap (Unblock, then Done) is the
   * price, and they are the rare reader.
   */
  const renderStep = (step: Domain.QueueStep, flagged: boolean) => {
    const started = step.startedAt !== null;
    /** The viewer's own name is noise on their own card; anyone else's is the point. */
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
          {!flagged && (
            <s-stack direction="inline" gap="base">
              {!started && (
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

  const renderItem = (item: Domain.QueueItem) => {
    const flagged = item.run.flag !== null;
    return (
      <s-box
        key={item.run.id}
        padding="base"
        borderWidth="base"
        borderRadius="base"
      >
        <s-stack gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <Link
              to="/shop/$shop/work/$runId"
              params={{ shop, runId: item.run.id }}
            >
              <s-heading>{item.run.orderName}</s-heading>
            </Link>
            <s-text color="subdued">
              ordered{" "}
              <LocalDateTime
                value={item.run.orderProcessedAt}
                format="relative"
              />
            </s-text>
          </s-stack>
          <RunItem run={item.run} />
          {item.note !== null && item.note.length > 0 && (
            <Prose color="subdued">{`Order note: ${item.note}`}</Prose>
          )}
          <FlagBanner
            run={item.run}
            actions={
              <s-button
                slot="secondary-actions"
                variant="secondary"
                disabled={actions.pending}
                onClick={() => {
                  actions.dismiss.mutate(item.run.id);
                }}
              >
                {item.run.flag === "blocked" ? "Unblock" : "Dismiss"}
              </s-button>
            }
          />
          {item.steps.map((step) => renderStep(step, flagged))}
        </s-stack>
      </s-box>
    );
  };

  const renderDone = (entry: Domain.DoneItem) => (
    <s-box
      key={entry.step.id}
      padding="small"
      borderWidth="base"
      borderRadius="base"
    >
      <s-stack gap="small-500">
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <Link
            to="/shop/$shop/work/$runId"
            params={{ shop, runId: entry.run.id }}
          >
            {entry.run.orderName}
          </Link>
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
        <s-stack direction="inline" gap="base" alignItems="center">
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
        </s-stack>
      </s-stack>
    </s-box>
  );

  const chips =
    teams.length > 1 ? (
      <s-stack direction="inline" gap="small-300">
        <s-button
          variant={teamFilter === null ? "primary" : "secondary"}
          onClick={() => {
            setTeamFilter(null);
            setUpNextAll(false);
          }}
        >
          {`All · ${String(view.items.length)}`}
        </s-button>
        {teams.map((team) => (
          <s-button
            key={team.id}
            variant={teamFilter === team.id ? "primary" : "secondary"}
            onClick={() => {
              setTeamFilter(team.id);
              setUpNextAll(false);
            }}
          >
            {`${team.name} · ${String(
              view.items.filter((item) => onTeam(item, team.id)).length,
            )}`}
          </s-button>
        ))}
      </s-stack>
    ) : null;

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
                {visible.length === 0 && (
                  <s-paragraph color="subdued">
                    Nothing to do right now.
                  </s-paragraph>
                )}
                {TIERS.map((tier) => {
                  if (tiers[tier].length === 0) return null;
                  const capped =
                    tier === "upNext" && !upNextAll
                      ? tiers[tier].slice(0, UP_NEXT_CAP)
                      : tiers[tier];
                  const hidden = tiers[tier].length - capped.length;
                  return (
                    <s-stack key={tier} gap="small-300">
                      {/* The heading counts the whole tier; the cap is a
                          rendering, not a filter, so the number a member
                          reads is the number of things waiting. */}
                      <s-heading>
                        {`${TIER_LABEL[tier]} · ${String(tiers[tier].length)}`}
                      </s-heading>
                      {capped.map(renderItem)}
                      {hidden > 0 && (
                        <s-button
                          variant="secondary"
                          onClick={() => {
                            setUpNextAll(true);
                          }}
                        >
                          {`Show all ${String(tiers[tier].length)}`}
                        </s-button>
                      )}
                    </s-stack>
                  );
                })}
                {doneVisible.length > 0 && (
                  <s-stack gap="small-300">
                    <s-stack
                      direction="inline"
                      gap="small-300"
                      alignItems="center"
                    >
                      <s-heading>
                        {`Done today · ${String(doneVisible.length)}`}
                      </s-heading>
                      <s-button
                        variant="tertiary"
                        onClick={() => {
                          setDoneOpen((open) => !open);
                        }}
                      >
                        {doneOpen ? "Hide" : "Show"}
                      </s-button>
                    </s-stack>
                    {doneOpen && doneVisible.map(renderDone)}
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
