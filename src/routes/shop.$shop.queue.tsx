import type * as Domain from "@/lib/Domain";

import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import { formatNumber } from "@/lib/format";
import {
  memberServerFnMiddleware,
  requireMember,
} from "@/lib/MemberServerFnMiddleware";
import { ShopAgentClient } from "@/lib/ShopAgentClient";

const ShopParamInput = Schema.Struct({ shop: Schema.String });

const CompleteStepFormInput = Schema.Struct({
  shop: Schema.String,
  runStepId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});

const DismissFlagFormInput = Schema.Struct({
  shop: Schema.String,
  runId: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});

/**
 * `teamIds` and `memberId` never come from the browser: `requireMember`
 * resolves them from the session and the URL shop, and the Durable Object
 * trusts them because the Worker is its only caller for these methods. The
 * browser sends only the shop and the id of what it clicked; scope is
 * enforced on the object against the resolved teams.
 */
const getQueue = createServerFn({ method: "GET" })
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
        return { shop, teams, items };
      }),
    ),
  );

const completeStepFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(CompleteStepFormInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const { shop, memberId, teams } = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        return yield* (yield* ShopAgentClient).completeStep(shop, {
          runStepId: data.runStepId,
          memberId,
          teamIds: teams.map((team) => team.id),
        });
      }),
    ),
  );

const dismissFlagFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(DismissFlagFormInput))
  .middleware([memberServerFnMiddleware])
  .handler(({ data, context: { runEffect, user } }) =>
    runEffect(
      Effect.gen(function* () {
        const { shop, memberId, teams } = yield* requireMember({
          shop: data.shop,
          email: user.email,
        });
        return yield* (yield* ShopAgentClient).dismissFlag(shop, {
          runId: data.runId,
          memberId,
          teamIds: teams.map((team) => team.id),
        });
      }),
    ),
  );

export const Route = createFileRoute("/shop/$shop/queue")({
  loader: ({ params }) => getQueue({ data: { shop: params.shop } }),
  component: RouteComponent,
});

const runResultMessage = Match.typeTags<Domain.RunResult, string | null>()({
  Ok: () => null,
  NotFound: () => "That work no longer exists.",
  NotAllowed: () => "This step belongs to another team.",
  NotCurrent: () =>
    "This step is not up next: an earlier step is still open, or someone already completed it.",
  Terminal: () => "This workflow is already finished or cancelled.",
});

const flagMessage = (run: Domain.WorkflowRun) =>
  run.flag === null
    ? null
    : Match.value(run.flag).pipe(
        Match.withReturnType<string>(),
        Match.when(
          "item_removed",
          () => "This item was removed from the order.",
        ),
        Match.when(
          "quantity_changed",
          () =>
            `Quantity changed from ${formatNumber(run.flagDetail?.from ?? 0)} to ${formatNumber(run.flagDetail?.to ?? run.quantity)}.`,
        ),
        Match.when("order_cancelled", () => "The order was cancelled."),
        Match.when("order_deleted", () => "The order was deleted."),
        Match.exhaustive,
      );

const lineItemLabel = ({ run }: Domain.QueueItem) =>
  `${run.lineItemTitle}${run.variantTitle === null ? "" : ` — ${run.variantTitle}`} ×${formatNumber(run.quantity)}`;

const personalization = (attributes: readonly Domain.OrderAttribute[]) =>
  attributes.map(({ key, value }) => `${key}: ${value ?? ""}`).join(", ");

function RouteComponent() {
  const { shop, teams, items } = Route.useLoaderData();
  const router = useRouter();
  const completeStep = useServerFn(completeStepFn);
  const dismissFlag = useServerFn(dismissFlagFn);

  const completeMutation = useMutation({
    mutationFn: (runStepId: string) =>
      completeStep({ data: { shop, runStepId } }),
    onSuccess: () => router.invalidate(),
  });
  const dismissMutation = useMutation({
    mutationFn: (runId: string) => dismissFlag({ data: { shop, runId } }),
    onSuccess: () => router.invalidate(),
  });

  const pending = completeMutation.isPending || dismissMutation.isPending;
  const banner =
    completeMutation.error?.message ??
    dismissMutation.error?.message ??
    (completeMutation.data && runResultMessage(completeMutation.data)) ??
    (dismissMutation.data && runResultMessage(dismissMutation.data)) ??
    null;

  const renderItem = (item: Domain.QueueItem) => {
    const flag = flagMessage(item.run);
    return (
      <s-box
        key={item.step.id}
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
          <s-text>{lineItemLabel(item)}</s-text>
          <s-text type="strong">{`Step: ${item.step.name}`}</s-text>
          {item.run.customAttributes.length > 0 && (
            <s-text>{personalization(item.run.customAttributes)}</s-text>
          )}
          {item.note !== null && item.note.length > 0 && (
            <s-text color="subdued">{`Order note: ${item.note}`}</s-text>
          )}
          {flag !== null && (
            <s-banner tone="warning" heading="Needs attention">
              {flag}
            </s-banner>
          )}
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              disabled={pending}
              onClick={() => {
                completeMutation.mutate(item.step.id);
              }}
            >
              Done
            </s-button>
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

  const groups =
    teams.length > 1
      ? teams.map((team) => ({
          team,
          items: items.filter((item) => item.step.teamId === team.id),
        }))
      : [{ team: null, items }];

  return (
    <s-page heading="Your work" inlineSize="small">
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
