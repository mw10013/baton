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
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { SocketBanner } from "@/lib/SocketBanner";
import { useMemberRunActions } from "@/lib/useMemberRunActions";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

const ParamsInput = Schema.Struct({
  shop: Schema.String,
  runId: Schema.String,
});

/**
 * The work page's first paint, SSR like the queue's. `getRunForMember`
 * answers `null` for a run that is not there *or* not on one of the member's
 * teams — one answer, so a member cannot probe run ids — and the page renders
 * its not-found state for both.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ParamsInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const { shop, memberId, teams } = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        const view = yield* (yield* ShopAgentClient).getRunForMember(shop, {
          runId: data.runId,
          teamIds: teams.map((team) => team.id),
        });
        return {
          shop,
          memberId,
          memberEmail: user.email,
          teams,
          view,
        } satisfies Domain.RunLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/work/$runId")({
  loader: ({ params }) =>
    getLoaderData({ data: { shop: params.shop, runId: params.runId } }),
  component: RouteComponent,
});

/** What a step's state line says, in the order a worker asks: done, under way, ready, waiting. */
const stepState = (
  step: Domain.RunStepView,
): {
  readonly text: React.ReactNode;
  readonly badge: {
    readonly label: string;
    readonly tone: "neutral" | "success" | "info";
  } | null;
} => {
  const completedBy = Domain.stepCompletedBy(step);
  const startedBy = Domain.stepStartedBy(step);
  if (step.completedAt !== null)
    return {
      badge: { label: "Done", tone: "neutral" },
      text: (
        <>
          {completedBy === null
            ? "Done · "
            : `Done by ${Domain.actorLabel(completedBy)} · `}
          <LocalDateTime value={step.completedAt} />
        </>
      ),
    };
  if (step.startedAt !== null)
    return {
      badge: { label: "In progress", tone: "success" },
      text: (
        <>
          In progress since{" "}
          <LocalDateTime value={step.startedAt} format="time" />
          {startedBy === null ? "" : ` by ${Domain.actorLabel(startedBy)}`}
        </>
      ),
    };
  if (step.ready)
    return { badge: { label: "Ready", tone: "info" }, text: "Ready" };
  return { badge: null, text: `Waiting on step ${String(step.stage - 1)}` };
};

function RouteComponent() {
  const { shop, teams, view: initialView } = Route.useLoaderData();
  const { runId } = Route.useParams();
  const {
    data: view,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ["shop-run", shop, runId],
    subscribe: (stub, subscriberId) =>
      stub.subscribeRun({ subscriberId, runId }),
    initialData: initialView,
  });
  const actions = useMemberRunActions({
    agent,
    identified,
    onSuccess: () => invalidate(),
  });
  /** Which step's note editor is open and its draft; one at a time. */
  const [noteDraft, setNoteDraft] = React.useState<{
    runStepId: string;
    note: string;
  } | null>(null);
  const [reason, setReason] = React.useState("");
  const teamIds = teams.map((team) => team.id);
  const mine = (step: Domain.RunStepView) =>
    step.teamId !== null && teamIds.includes(step.teamId);
  const open =
    view !== null &&
    (view.run.status === "pending" || view.run.status === "active");

  const renderStep = (step: Domain.RunStepView) => {
    if (view === null) return null;
    const state = stepState(step);
    /** Shown only while the slot is filled: the next Done clears it (`Domain.WorkflowRunStep`). */
    const reopenedBy = Domain.stepReopenedBy(step);
    const editingNote = noteDraft?.runStepId === step.id;
    const canAct = mine(step) && open;
    const ready = canAct && step.ready && step.completedAt === null;
    const finished = canAct && step.completedAt !== null;
    return (
      <s-box
        key={step.id}
        padding="small"
        borderWidth="base"
        borderRadius="base"
        background={ready ? "subdued" : "base"}
      >
        <s-stack gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">{step.name}</s-text>
            <s-text color="subdued">
              {`${step.teamName} · stage ${String(step.stage)}`}
            </s-text>
            {state.badge !== null && (
              <s-badge tone={state.badge.tone}>{state.badge.label}</s-badge>
            )}
          </s-stack>
          {state.text !== null && <s-text color="subdued">{state.text}</s-text>}
          {reopenedBy !== null && step.reopenedAt !== null && (
            <s-text color="subdued">
              {`Reopened by ${Domain.actorLabel(reopenedBy)} · `}
              <LocalDateTime value={step.reopenedAt} format="relative" />
            </s-text>
          )}
          {step.instructions !== null && <s-text>{step.instructions}</s-text>}
          {!editingNote && step.note !== null && (
            <s-text color="subdued">{Domain.stepNoteLine(step)}</s-text>
          )}
          {editingNote && (
            <s-stack gap="small-300">
              <s-text-field
                label="Note"
                labelAccessibilityVisibility="exclusive"
                placeholder="Note about this step"
                value={noteDraft.note}
                disabled={actions.pending}
                onInput={(event) => {
                  setNoteDraft({
                    runStepId: step.id,
                    note: event.currentTarget.value,
                  });
                }}
              />
              <s-stack direction="inline" gap="small-300">
                <s-button
                  variant="primary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.note.mutate(
                      { runStepId: step.id, note: noteDraft.note },
                      {
                        onSuccess: (result) => {
                          if (result._tag === "Ok") setNoteDraft(null);
                        },
                      },
                    );
                  }}
                >
                  Save note
                </s-button>
                <s-button
                  variant="tertiary"
                  onClick={() => {
                    setNoteDraft(null);
                  }}
                >
                  Cancel
                </s-button>
              </s-stack>
            </s-stack>
          )}
          {canAct && (
            <s-stack direction="inline" gap="base" alignItems="center">
              {ready && step.startedAt === null && (
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
              {ready && (
                <s-button
                  variant="primary"
                  disabled={actions.pending}
                  onClick={() => {
                    actions.complete.mutate(step.id);
                  }}
                >
                  Done
                </s-button>
              )}
              {finished &&
                (step.undoBlockedBy === null ? (
                  <s-button
                    variant="secondary"
                    disabled={actions.pending}
                    onClick={() => {
                      actions.uncomplete.mutate(step.id);
                    }}
                  >
                    Undo
                  </s-button>
                ) : (
                  <s-text color="subdued">
                    {`${step.undoBlockedBy.teamName} started ${step.undoBlockedBy.stepName} · ask them`}
                  </s-text>
                ))}
              {!editingNote && (
                <s-button
                  variant="tertiary"
                  disabled={actions.pending}
                  onClick={() => {
                    setNoteDraft({ runStepId: step.id, note: step.note ?? "" });
                  }}
                >
                  {step.note === null ? "Note" : "Edit note"}
                </s-button>
              )}
            </s-stack>
          )}
        </s-stack>
      </s-box>
    );
  };

  if (view === null)
    return (
      <>
        <MemberBar shop={shop} />
        <s-page heading="Not found" inlineSize="small">
          <s-section accessibilityLabel="Not found">
            <s-stack gap="base">
              <s-paragraph color="subdued">
                This work is not on one of your teams, or it no longer exists.
              </s-paragraph>
              <Link to="/shop/$shop" params={{ shop }}>
                Back to your work
              </Link>
            </s-stack>
          </s-section>
        </s-page>
      </>
    );

  const { run } = view;
  const others = view.items.filter(
    (item) => item.lineItemId !== run.lineItemId,
  );
  return (
    <>
      <MemberBar shop={shop} />
      <s-page heading={run.orderName} inlineSize="small">
        <SocketBanner />
        <s-section accessibilityLabel={run.orderName}>
          <s-stack gap="base">
            <div className="print-hide">
              <Link to="/shop/$shop" params={{ shop }}>
                ‹ Your work
              </Link>
            </div>
            <s-stack direction="inline" gap="small-300" alignItems="center">
              <s-badge>{run.workflowName}</s-badge>
              {run.status === "done" && <s-badge tone="neutral">Done</s-badge>}
              {run.status === "cancelled" && (
                <s-badge tone="critical">Cancelled</s-badge>
              )}
              <s-text color="subdued">
                ordered{" "}
                <LocalDateTime value={run.orderProcessedAt} format="relative" />
              </s-text>
            </s-stack>
            {actions.banner !== null && (
              <s-banner tone="critical">{actions.banner}</s-banner>
            )}
            <FlagBanner run={run} />
          </s-stack>
        </s-section>
        <s-section heading="This item" accessibilityLabel="Item">
          <RunItem run={run} />
        </s-section>
        <s-section heading="Steps" accessibilityLabel="Steps">
          <s-stack gap="small-300">{view.steps.map(renderStep)}</s-stack>
        </s-section>
        {others.length > 0 && (
          <s-section
            heading="Also on this order"
            accessibilityLabel="Also on this order"
          >
            <OrderItems items={others} />
          </s-section>
        )}
        {view.note !== null && view.note.length > 0 && (
          <s-section heading="Order note" accessibilityLabel="Order note">
            <s-paragraph>{view.note}</s-paragraph>
          </s-section>
        )}
        {open && (
          <s-section
            heading={run.flag === null ? "Block this work" : "Blocked"}
            accessibilityLabel="Block"
          >
            <div className="print-hide">
              {run.flag === null ? (
                <s-stack gap="small-300">
                  <s-text-field
                    label="Reason"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="What is stopping this? (optional)"
                    value={reason}
                    disabled={actions.pending}
                    onInput={(event) => {
                      setReason(event.currentTarget.value);
                    }}
                  />
                  <s-stack direction="inline" gap="small-300">
                    <s-button
                      variant="primary"
                      tone="critical"
                      disabled={actions.pending}
                      onClick={() => {
                        actions.block.mutate(
                          { runId: run.id, reason },
                          {
                            onSuccess: (result) => {
                              if (result._tag === "Ok") setReason("");
                            },
                          },
                        );
                      }}
                    >
                      Block
                    </s-button>
                  </s-stack>
                </s-stack>
              ) : (
                <s-stack gap="small-300">
                  <s-paragraph color="subdued">
                    Unblock once the reason is resolved; the card goes back to
                    its place in the queue.
                  </s-paragraph>
                  <s-stack direction="inline" gap="small-300">
                    <s-button
                      variant="secondary"
                      disabled={actions.pending}
                      onClick={() => {
                        actions.dismiss.mutate(run.id);
                      }}
                    >
                      Unblock
                    </s-button>
                  </s-stack>
                </s-stack>
              )}
            </div>
          </s-section>
        )}
      </s-page>
    </>
  );
}
