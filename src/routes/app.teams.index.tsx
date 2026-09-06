import * as React from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Match, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { formatDateTime } from "@/lib/format";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";

const TeamNameInput = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Name is required" })),
});
type TeamNameInput = typeof TeamNameInput.Type;

const decodeName = Schema.decodeUnknownEffect(Domain.TeamName);
const sessionShop = (shop: string) =>
  Schema.decodeUnknownEffect(Domain.Shop)(shop);

/**
 * Tagged repository failures are merchant-facing here, so they are replaced by
 * copy before they reach the worker seam: that seam renders whatever it catches
 * through `causeToErrorMessage`, which would otherwise surface the tag name in
 * a banner. A bare `Error` renders as its message alone.
 */
const failWith = (message: string) => () => Effect.fail(new Error(message));

const NAME_TAKEN = "A team with that name already exists.";
const TEAM_GONE = "That team no longer exists.";

const decodeDeleteTeamResult = Schema.decodeUnknownPromise(
  Schema.toType(Domain.DeleteTeamResult),
);

export const deleteTeamResultMessage = Match.typeTags<
  Domain.DeleteTeamResult,
  string | null
>()({
  Deleted: () => null,
  NotFound: () => TEAM_GONE,
});

const NO_COUNTS: Domain.TeamDeleteCounts = {
  workflowSteps: 0,
  draftSteps: 0,
  openRunSteps: 0,
};

const plural = (count: number, noun: string) =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The delete dialog's body, in the merchant copy of `Domain.Team`: what will
 * become unassigned, and what that means. Only true clauses are spoken.
 */
export const deleteTeamWarning = (counts: Domain.TeamDeleteCounts) => {
  const configured = counts.workflowSteps + counts.draftSteps;
  const parts = [
    ...(configured > 0 ? [plural(configured, "workflow step")] : []),
    ...(counts.openRunSteps > 0
      ? [plural(counts.openRunSteps, "in-progress step")]
      : []),
  ];
  if (parts.length === 0)
    return "No workflow steps are assigned to it. This can't be undone.";
  const verb = configured + counts.openRunSteps === 1 ? "is" : "are";
  const consequences = [
    ...(configured > 0
      ? ["Workflows with unassigned steps stop starting for new orders"]
      : []),
    ...(counts.openRunSteps > 0
      ? ["in-progress steps wait until you assign a team"]
      : []),
  ];
  return `${parts.join(" and ")} ${verb} assigned to it. They will become unassigned. ${consequences.join(", and ")}.`;
};

/** Counts are Durable Object data joined into a D1 page (the loader-versus-socket rule on `ShopAgentClient`). */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const teams = yield* (yield* Repository).listTeams({
          shop: yield* sessionShop(session.shop),
        });
        const stepCounts = yield* (yield* ShopAgentClient).countStepsByTeam(
          session.shop,
        );
        return { teams, stepCounts } satisfies Domain.TeamsIndexLoaderData;
      }),
    ),
  );

const createTeamFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(TeamNameInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        yield* (yield* Repository).createTeam({
          shop: yield* sessionShop(session.shop),
          name: yield* decodeName(data.name),
        });
      }).pipe(Effect.catchTag("TeamNameTakenError", failWith(NAME_TAKEN))),
    ),
  );

export const Route = createFileRoute("/app/teams/")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { teams, stepCounts } = Route.useLoaderData();
  const router = useRouter();
  const createTeam = useServerFn(createTeamFn);
  const { agent, identified } = useShopAgent();
  const [deleteBanner, setDeleteBanner] = React.useState<string | null>(null);
  /** Which team's delete is awaiting its inline confirmation. */
  const [confirming, setConfirming] = React.useState<Domain.TeamId | null>(
    null,
  );

  const createMutation = useMutation({
    mutationFn: (data: TeamNameInput) => createTeam({ data }),
    onSuccess: async () => {
      form.reset();
      await router.invalidate({ sync: true });
    },
  });

  /**
   * Delete goes through the Durable Object: it deletes the D1 row and then
   * nulls every step pointer in the object's SQLite, in that order, so a step
   * saved against the team meanwhile is caught by the nulling (see
   * `ShopAgent.deleteTeam`).
   */
  const deleteMutation = useMutation({
    mutationFn: (teamId: string) => {
      if (!agent)
        return Promise.reject(
          new Error("Still connecting. Try again in a moment."),
        );
      return withSocketRecovery(agent)(() =>
        agent.stub.deleteTeam({ teamId }),
      ).then(decodeDeleteTeamResult);
    },
    onSuccess: async (result) => {
      setDeleteBanner(deleteTeamResultMessage(result));
      setConfirming(null);
      await router.invalidate({ sync: true });
    },
  });

  const form = useForm({
    defaultValues: { name: "" } satisfies TeamNameInput,
    validators: { onSubmit: Schema.toStandardSchemaV1(TeamNameInput) },
    onSubmit: ({ value }) => {
      void createMutation.mutateAsync(value);
    },
  });

  const failedMutation = [
    { mutation: createMutation, fallback: "Could not create the team." },
    { mutation: deleteMutation, fallback: "Could not delete the team." },
  ].find(({ mutation }) => mutation.isError);
  const mutationError =
    failedMutation &&
    mutationErrorMessage(
      failedMutation.mutation.error,
      failedMutation.fallback,
    );

  const countsOf = (team: Domain.TeamSummary): Domain.TeamDeleteCounts =>
    stepCounts.find((row) => row.teamId === team.id) ?? NO_COUNTS;

  const confirmRow = (team: Domain.TeamSummary) => (
    <s-table-row key={`${team.id}-confirm`} id={`${team.id}-confirm`}>
      <s-table-cell>
        <s-banner tone="critical" heading={`Delete ${team.name}?`}>
          <s-stack gap="small-300">
            <s-paragraph>{deleteTeamWarning(countsOf(team))}</s-paragraph>
            <s-stack direction="inline" gap="small-300">
              <s-button
                variant="primary"
                tone="critical"
                disabled={!identified}
                {...(deleteMutation.isPending ? { loading: true } : {})}
                onClick={() => {
                  deleteMutation.mutate(team.id);
                }}
              >
                Delete
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => {
                  setConfirming(null);
                }}
              >
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-banner>
      </s-table-cell>
      <s-table-cell> </s-table-cell>
      <s-table-cell> </s-table-cell>
      <s-table-cell> </s-table-cell>
    </s-table-row>
  );

  return (
    <s-page heading="Teams" inlineSize="large">
      <s-section heading="Create team" accessibilityLabel="Create team">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Teams group members so work can be scoped to them. A member with no
            team sees nothing to do. Delete a team and its steps become
            unassigned until you assign another team.
          </s-paragraph>
          {mutationError && (
            <s-banner tone="critical">{mutationError}</s-banner>
          )}
          {deleteBanner !== null && (
            <s-banner tone="warning">{deleteBanner}</s-banner>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <s-stack gap="base">
              <form.Field name="name">
                {(field) => (
                  <s-text-field
                    label="Name"
                    name={field.name}
                    value={field.state.value}
                    error={fieldError(field.state.meta.errors)}
                    onInput={(event) => {
                      field.handleChange(event.currentTarget.value);
                    }}
                    onBlur={field.handleBlur}
                    required
                  />
                )}
              </form.Field>
              <s-stack alignItems="start">
                <s-button
                  type="submit"
                  variant="primary"
                  {...(createMutation.isPending ? { loading: true } : {})}
                >
                  Create team
                </s-button>
              </s-stack>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section heading="Teams" accessibilityLabel="Teams">
        <s-stack gap="base">
          {teams.length === 0 ? (
            <s-paragraph color="subdued">
              No teams yet. Create one above.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Name</s-table-header>
                <s-table-header>Members</s-table-header>
                <s-table-header>Created</s-table-header>
                <s-table-header> </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {teams.flatMap((team) => [
                  <s-table-row key={team.id} id={team.id}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-300">
                        <s-link href={`/app/teams/${team.id}`}>
                          {team.name}
                        </s-link>
                        {team.memberCount === 0 && (
                          <s-badge tone="warning">No members</s-badge>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{team.memberCount}</s-table-cell>
                    <s-table-cell>
                      {formatDateTime(team.createdAt)}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        disabled={deleteMutation.isPending || !identified}
                        onClick={() => {
                          setConfirming(team.id);
                        }}
                      >
                        Delete
                      </s-button>
                    </s-table-cell>
                  </s-table-row>,
                  ...(confirming === team.id ? [confirmRow(team)] : []),
                ])}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
