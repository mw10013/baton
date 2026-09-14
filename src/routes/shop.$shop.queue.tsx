import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";
import { requireMember } from "@/lib/MemberAccess";
import { memberServerFnMiddleware } from "@/lib/MemberServerFnMiddleware";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { withSocketRecovery } from "@/lib/ShopAgentContext";
import { SocketBanner } from "@/lib/SocketBanner";
import { useSubscribedQuery } from "@/lib/useSubscribedQuery";

const ShopParamInput = Schema.Struct({ shop: Schema.String });

/** A blank text field on the wire is "cleared", which the object stores as `null`. */
const textOrNull = (value: string) =>
  value.trim().length === 0 ? null : value;

/**
 * The queue's first paint. SSR, so it cannot be a socket call: `requireMember`
 * resolves the shop and the member's teams from the cookie, and `listQueue`
 * reads the object through `ShopAgentClient`.
 *
 * The five actions below go the other way — over the member socket, where the
 * same `requireMember` result is already on the connection. Either way
 * `teamIds`, `memberId`, and `memberEmail` are resolved server-side and never
 * sent by the browser; the browser sends only the id of what was clicked.
 */
const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ShopParamInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const { shop, teams } = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        const items = yield* (yield* ShopAgentClient).listQueue(shop, {
          teamIds: teams.map((team) => team.id),
        });
        return { shop, teams, items } satisfies Domain.QueueLoaderData;
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/queue")({
  loader: ({ params }) => getLoaderData({ data: { shop: params.shop } }),
  component: RouteComponent,
});

const runResultMessage = Match.typeTags<Domain.RunResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That work no longer exists.",
  NotAllowed: () => "This step belongs to another team.",
  NotReady: () =>
    "Someone finished an earlier step just now, or this step is waiting on another team. Refresh.",
  Terminal: () => "This workflow is already finished or cancelled.",
});

const flagMessage = (run: Domain.WorkflowRun) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<string>(),
        // Also covers a full refund and a line shipped ahead: all three zero
        // the units to make, and the maker's response is the same.
        Match.when("item_removed", () =>
          Domain.isOrderRun(run)
            ? `No longer needed: ${run.flagDetail?.item ?? ""}`
            : "No longer needed: this item was removed, refunded, or shipped.",
        ),
        Match.when(
          "quantity_changed",
          () =>
            `Quantity changed from ${formatNumber(run.flagDetail?.from ?? 0)} to ${formatNumber(run.flagDetail?.to ?? run.quantity ?? 0)}.`,
        ),
        Match.when("item_added", () =>
          run.flagDetail?.item === undefined
            ? "A new item was added to this order after it was ready."
            : `New item: ${run.flagDetail.item}`,
        ),
        Match.when("order_cancelled", () => "The order was cancelled."),
        Match.when("order_deleted", () => "The order was deleted."),
        Match.when(
          "order_fulfilled",
          () => "This order was already shipped in Shopify.",
        ),
        Match.when("blocked", () =>
          run.flagDetail?.reason === undefined
            ? "Blocked."
            : `Blocked: ${run.flagDetail.reason}`,
        ),
        Match.exhaustive,
      );

/** Item runs only: an order run has no line item of its own (`items` carries them). */
const lineItemLabel = ({ run }: Domain.QueueItem) =>
  `${run.lineItemTitle ?? ""}${run.variantTitle === null ? "" : ` — ${run.variantTitle}`} ×${formatNumber(run.quantity ?? 0)}`;

const orderItemLabel = ({
  title,
  variantTitle,
  quantity,
}: Domain.QueueOrderItem) =>
  `${title}${variantTitle === null ? "" : ` — ${variantTitle}`} ×${formatNumber(quantity)}`;

const ITEM_STATUS = {
  pending: { label: "Not started", tone: "info" },
  active: { label: "In progress", tone: "success" },
  done: { label: "Done", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "critical" },
} as const satisfies Record<
  Domain.RunStatus,
  { readonly label: string; readonly tone: string }
>;

const personalization = (attributes: readonly Domain.OrderAttribute[]) =>
  attributes.map(({ key, value }) => `${key}: ${value ?? ""}`).join(", ");

/**
 * Every action is a `@callable()` on the member socket, reached through
 * `withSocketRecovery` so a zombie connection is healed rather than waited out
 * (`ShopAgentContext.tsx` describes both recovery layers). `identified` gates
 * them: the socket is the only path these mutations have, so a click before
 * the handshake has nothing to send on and says so rather than failing
 * opaquely.
 *
 * The inputs carry no identity. `memberId`, `memberEmail`, and `teamIds` live
 * on the connection the Worker's gate authorized, so the browser sends only
 * the id of the step or run it clicked and the text that was typed — see
 * `Domain.ConnectionState`.
 */
const CONNECTING = "Still connecting. Try again in a moment.";

function RouteComponent() {
  const { shop, teams, items: initialItems } = Route.useLoaderData();
  /**
   * The subscribe pattern (`Domain.Subscription`): the loader's rows paint
   * first, then `subscribeQueue` re-reads them over the socket and registers
   * this connection for pushes, so work another member finishes lands here
   * without a reload. The subscription's scope is the teams on the connection,
   * so nothing about it is named by the browser.
   */
  const {
    data: items,
    invalidate,
    agent,
    identified,
  } = useSubscribedQuery({
    queryKey: ["shop-queue", shop],
    subscribe: (stub, subscriberId) => stub.subscribeQueue({ subscriberId }),
    initialData: initialItems,
  });
  const call = React.useCallback(
    <A,>(run: (stub: NonNullable<typeof agent>["stub"]) => Promise<A>) =>
      agent && identified
        ? withSocketRecovery(agent)(() => run(agent.stub))
        : Promise.reject(new Error(CONNECTING)),
    [agent, identified],
  );
  /** Which step's note editor is open and its draft; one at a time. */
  const [noteDraft, setNoteDraft] = React.useState<{
    runStepId: string;
    note: string;
  } | null>(null);
  /** Which run's block form is open and its draft reason; one at a time. */
  const [blockDraft, setBlockDraft] = React.useState<{
    runId: string;
    reason: string;
  } | null>(null);

  /**
   * The write's own publish would refetch this eventually, but the throttle in
   * `useSubscribedQuery` means "eventually" is up to two seconds — too long
   * for the person who just pressed the button. Invalidating here paints their
   * own action immediately; the push still covers everyone else.
   */
  const onSuccess = () => invalidate();
  const startMutation = useMutation({
    mutationFn: (runStepId: string) =>
      call((stub) => stub.startStep({ runStepId })),
    onSuccess,
  });
  const completeMutation = useMutation({
    mutationFn: (runStepId: string) =>
      call((stub) => stub.completeStep({ runStepId })),
    onSuccess,
  });
  const noteMutation = useMutation({
    mutationFn: ({ runStepId, note }: { runStepId: string; note: string }) =>
      call((stub) => stub.setStepNote({ runStepId, note: textOrNull(note) })),
    onSuccess: async (result) => {
      if (result._tag === "Ok") setNoteDraft(null);
      await onSuccess();
    },
  });
  const blockMutation = useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: string }) =>
      call((stub) => stub.blockRun({ runId, reason: textOrNull(reason) })),
    onSuccess: async (result) => {
      if (result._tag === "Ok") setBlockDraft(null);
      await onSuccess();
    },
  });
  const dismissMutation = useMutation({
    mutationFn: (runId: string) => call((stub) => stub.dismissFlag({ runId })),
    onSuccess,
  });

  const mutations = [
    startMutation,
    completeMutation,
    noteMutation,
    blockMutation,
    dismissMutation,
  ];
  /**
   * Disabled while a write is in flight, and while the socket is not
   * identified: these actions have no other transport, so offering them before
   * the handshake would only queue a click that cannot be sent. `SocketBanner`
   * explains the second case after its own grace period.
   */
  const pending =
    mutations.some((mutation) => mutation.isPending) || !identified;
  const banner =
    mutations.find((mutation) => mutation.error)?.error?.message ??
    mutations
      .map((mutation) => mutation.data && runResultMessage(mutation.data))
      .find((message) => typeof message === "string") ??
    null;

  const renderStep = (item: Domain.QueueItem, step: Domain.QueueStep) => {
    const started = step.startedAt !== null;
    const editingNote = noteDraft?.runStepId === step.id;
    return (
      <s-box
        key={step.id}
        padding="small"
        borderWidth="base"
        borderRadius="base"
        background="subdued"
      >
        <s-stack gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-text type="strong">
              {`Step ${String(step.stage)} of ${String(item.stageCount)} · ${step.name}`}
            </s-text>
            {step.siblings.length > 0 && (
              <s-text color="subdued">
                {`together with: ${step.siblings
                  .map((sibling) => `${sibling.name} (${sibling.teamName})`)
                  .join(", ")}`}
              </s-text>
            )}
          </s-stack>
          {step.instructions !== null && (
            <s-text>{`Instructions: ${step.instructions}`}</s-text>
          )}
          {started && (
            <s-text color="subdued">
              In progress since{" "}
              <LocalDateTime value={step.startedAt ?? 0} format="time" />
              {step.startedByEmail === null ? "" : ` by ${step.startedByEmail}`}
            </s-text>
          )}
          {!editingNote && step.note !== null && (
            <s-text color="subdued">{`Note: ${step.note}`}</s-text>
          )}
          {editingNote && (
            <s-stack direction="inline" gap="small-300" alignItems="end">
              <s-text-field
                label="Note"
                labelAccessibilityVisibility="exclusive"
                placeholder="Note about this item"
                value={noteDraft.note}
                disabled={pending}
                onInput={(event) => {
                  setNoteDraft({
                    runStepId: step.id,
                    note: event.currentTarget.value,
                  });
                }}
              />
              <s-button
                variant="primary"
                disabled={pending}
                onClick={() => {
                  noteMutation.mutate({
                    runStepId: step.id,
                    note: noteDraft.note,
                  });
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
          )}
          <s-stack direction="inline" gap="base">
            {!started && (
              <s-button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  startMutation.mutate(step.id);
                }}
              >
                Start
              </s-button>
            )}
            <s-button
              variant="primary"
              disabled={pending}
              onClick={() => {
                completeMutation.mutate(step.id);
              }}
            >
              Done
            </s-button>
            {!editingNote && (
              <s-button
                variant="tertiary"
                disabled={pending}
                onClick={() => {
                  setNoteDraft({ runStepId: step.id, note: step.note ?? "" });
                }}
              >
                {step.note === null ? "Note" : "Edit note"}
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-box>
    );
  };

  const renderItem = (item: Domain.QueueItem) => {
    const flag = flagMessage(item.run);
    const blocking = blockDraft?.runId === item.run.id;
    return (
      <s-box
        key={item.run.id}
        padding="base"
        borderWidth="base"
        borderRadius="base"
      >
        <s-stack gap="small-300">
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-heading>{item.run.orderName}</s-heading>
            <s-badge tone="info">{item.run.workflowName}</s-badge>
            {item.run.status === "active" && (
              <s-badge tone="success">In progress</s-badge>
            )}
          </s-stack>
          {Domain.isOrderRun(item.run) ? (
            <s-stack gap="small-300">
              {item.items.map((orderItem) => (
                <s-stack key={orderItem.lineItemId} gap="small-500">
                  <s-stack
                    direction="inline"
                    gap="small-300"
                    alignItems="center"
                  >
                    <s-text>{orderItemLabel(orderItem)}</s-text>
                    {/* "No steps", not "No workflow": a worker never sees
                        definitions, so an absence stated in definition terms
                        is nothing they can act on. What the packer needs is
                        that nothing was made for this item. */}
                    {orderItem.runStatus === null ? (
                      <s-badge>No steps</s-badge>
                    ) : (
                      <s-badge tone={ITEM_STATUS[orderItem.runStatus].tone}>
                        {ITEM_STATUS[orderItem.runStatus].label}
                      </s-badge>
                    )}
                  </s-stack>
                  {orderItem.customAttributes.length > 0 && (
                    <s-text color="subdued">
                      {personalization(orderItem.customAttributes)}
                    </s-text>
                  )}
                </s-stack>
              ))}
            </s-stack>
          ) : (
            <>
              <s-text>{lineItemLabel(item)}</s-text>
              {item.run.customAttributes !== null &&
                item.run.customAttributes.length > 0 && (
                  <s-text>{personalization(item.run.customAttributes)}</s-text>
                )}
            </>
          )}
          {item.note !== null && item.note.length > 0 && (
            <s-text color="subdued">{`Order note: ${item.note}`}</s-text>
          )}
          {flag !== null && (
            <s-banner tone="warning" heading="Needs attention">
              {flag}
            </s-banner>
          )}
          {item.steps.map((step) => renderStep(item, step))}
          {blocking && (
            <s-stack direction="inline" gap="small-300" alignItems="end">
              <s-text-field
                label="Reason"
                labelAccessibilityVisibility="exclusive"
                placeholder="Why is this blocked? (optional)"
                value={blockDraft.reason}
                disabled={pending}
                onInput={(event) => {
                  setBlockDraft({
                    runId: item.run.id,
                    reason: event.currentTarget.value,
                  });
                }}
              />
              <s-button
                variant="primary"
                tone="critical"
                disabled={pending}
                onClick={() => {
                  blockMutation.mutate({
                    runId: item.run.id,
                    reason: blockDraft.reason,
                  });
                }}
              >
                Mark blocked
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => {
                  setBlockDraft(null);
                }}
              >
                Cancel
              </s-button>
            </s-stack>
          )}
          <s-stack direction="inline" gap="base">
            {!blocking && (
              <s-button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  setBlockDraft({ runId: item.run.id, reason: "" });
                }}
              >
                Block
              </s-button>
            )}
            {flag !== null && (
              <s-button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  dismissMutation.mutate(item.run.id);
                }}
              >
                Dismiss
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </s-box>
    );
  };

  /**
   * With several teams, a run appears under each team that owns one of its
   * ready steps; the card still shows every step the member may act on.
   */
  const groups =
    teams.length > 1
      ? teams.map((team) => ({
          team,
          items: items.filter((item) =>
            item.steps.some((step) => step.teamId === team.id),
          ),
        }))
      : [{ team: null, items }];

  return (
    <s-page heading="Your work" inlineSize="small">
      <SocketBanner />
      <s-section accessibilityLabel="Your work">
        <s-stack gap="base">
          <Link to="/shop/$shop" params={{ shop }}>
            Back to shop
          </Link>
          {banner !== null && <s-banner tone="critical">{banner}</s-banner>}
          {items.length === 0 && (
            <s-paragraph color="subdued">Nothing to do right now.</s-paragraph>
          )}
          {groups.map(({ team, items: groupItems }) =>
            groupItems.length === 0 ? null : (
              <s-stack key={team?.id ?? "all"} gap="small-300">
                {team !== null && <s-heading>{team.name}</s-heading>}
                {groupItems.map(renderItem)}
              </s-stack>
            ),
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
