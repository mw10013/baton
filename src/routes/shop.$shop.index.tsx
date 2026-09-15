import * as React from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberBar } from "@/components/MemberBar";
import { FlagBanner, OrderItems, RunItem } from "@/components/MemberRun";
import * as Domain from "@/lib/Domain";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { TIER_LABEL, TIERS, tierQueue, type Tier } from "@/lib/queueTiers";
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
  head: () => ({ meta: [{ title: "Your work — Baton" }] }),
  component: RouteComponent,
});

/** The status badge that encodes the tier; "Up next" carries none. */
const TIER_BADGE = {
  attention: { label: "Blocked", tone: "critical" },
  mine: { label: "Mine", tone: "success" },
  inProgress: { label: "In progress", tone: "info" },
  upNext: null,
} as const satisfies Record<
  Tier,
  { readonly label: string; readonly tone: string } | null
>;

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

  const visible =
    teamFilter === null
      ? view.items
      : view.items.filter((item) => onTeam(item, teamFilter));
  const tiers = tierQueue(visible, memberEmail);
  const doneVisible =
    teamFilter === null
      ? view.done
      : view.done.filter((entry) => entry.step.teamId === teamFilter);

  const renderStep = (item: Domain.QueueItem, step: Domain.QueueStep) => {
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
          <s-text type="strong">
            {`${step.name} · step ${String(step.stage)} of ${String(item.stageCount)}`}
          </s-text>
          {step.siblings.length > 0 && (
            <s-text color="subdued">
              {`together with: ${step.siblings
                .map((sibling) => `${sibling.name} (${sibling.teamName})`)
                .join(", ")}`}
            </s-text>
          )}
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
            <s-text color="subdued">{Domain.stepNoteLine(step)}</s-text>
          )}
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
        </s-stack>
      </s-box>
    );
  };

  const renderItem = (item: Domain.QueueItem, tier: Tier) => {
    const badge = TIER_BADGE[tier];
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
            <s-badge>{item.run.workflowName}</s-badge>
            {badge !== null && (
              <s-badge tone={badge.tone}>{badge.label}</s-badge>
            )}
            <s-text color="subdued">
              ordered{" "}
              <LocalDateTime
                value={item.run.orderProcessedAt}
                format="relative"
              />
            </s-text>
          </s-stack>
          {Domain.isOrderRun(item.run) ? (
            <OrderItems items={item.items} />
          ) : (
            <RunItem run={item.run} />
          )}
          {item.note !== null && item.note.length > 0 && (
            <s-text color="subdued">{`Order note: ${item.note}`}</s-text>
          )}
          <FlagBanner run={item.run} />
          {item.run.flag !== null && (
            <s-stack direction="inline" gap="base">
              <s-button
                variant="secondary"
                disabled={actions.pending}
                onClick={() => {
                  actions.dismiss.mutate(item.run.id);
                }}
              >
                Dismiss
              </s-button>
            </s-stack>
          )}
          {item.steps.map((step) => renderStep(item, step))}
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
          <s-text color="subdued">
            {Domain.isOrderRun(entry.run)
              ? entry.run.workflowName
              : (entry.run.lineItemTitle ?? "")}
          </s-text>
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
      <MemberBar shop={shop} />
      <s-page heading="Your work" inlineSize="small">
        <SocketBanner />
        <s-section accessibilityLabel="Your work">
          <s-stack gap="base">
            <s-text color="subdued">{memberEmail}</s-text>
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
                {TIERS.map((tier) =>
                  tiers[tier].length === 0 ? null : (
                    <s-stack key={tier} gap="small-300">
                      <s-heading>
                        {`${TIER_LABEL[tier]} · ${String(tiers[tier].length)}`}
                      </s-heading>
                      {tiers[tier].map((item) => renderItem(item, tier))}
                    </s-stack>
                  ),
                )}
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
