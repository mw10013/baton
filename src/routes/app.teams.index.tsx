import type * as Domain from "@/lib/Domain";

import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { decodeName, failWith, NAME_TAKEN, sessionShop } from "@/lib/teams";
import { groupUsedBy } from "@/lib/usedBy";

const CREATE_MODAL = "create-team";

const TeamNameInput = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Name is required" })),
});
type TeamNameInput = typeof TeamNameInput.Type;

/** Step ownership is Durable Object data joined into a D1 page (the loader-versus-socket rule on `ShopAgentClient`). */
const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const teams = yield* (yield* Repository).listTeams({
          shop: yield* sessionShop(session.shop),
        });
        const ownedSteps = yield* (yield* ShopAgentClient).listOwnedSteps(
          session.shop,
        );
        return { teams, ownedSteps } satisfies Domain.TeamsIndexLoaderData;
      }),
    ),
  );

/** Returns the row so the page can land on the new team, where the next thing is always adding people. */
const createTeamFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(TeamNameInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        return yield* (yield* Repository).createTeam({
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

/**
 * The teams page on the workflows pattern: a primary action that opens a
 * modal, a search once there is something to search, and no destructive
 * control on the index — deletion lives on the detail page, where the dialog
 * can say what the delete unassigns. "Used by" is derived from the object's
 * step ownership, grouped per team into workflow names.
 */
function RouteComponent() {
  const { teams, ownedSteps } = Route.useLoaderData();
  const router = useRouter();
  const shopify = useAppBridge();
  const createTeam = useServerFn(createTeamFn);
  const [query, setQuery] = React.useState("");
  /**
   * The name-taken failure is a field error, not a banner: the merchant fixes
   * it by editing the field. Held outside the form because it arrives from
   * the server after validation has already passed.
   */
  const [nameError, setNameError] = React.useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (data: TeamNameInput) => createTeam({ data }),
    onSuccess: async (created) => {
      await shopify.modal.hide(CREATE_MODAL);
      await router.invalidate({ sync: true });
      await router.navigate({
        to: "/app/teams/$teamId",
        params: { teamId: created.id },
      });
    },
    onError: (error: Error) => {
      const message = mutationErrorMessage(error, "Could not create the team.");
      if (message === NAME_TAKEN) setNameError(message);
    },
  });

  const form = useForm({
    defaultValues: { name: "" } satisfies TeamNameInput,
    validators: { onSubmit: Schema.toStandardSchemaV1(TeamNameInput) },
    onSubmit: ({ value }) => {
      createMutation.mutate(value);
    },
  });

  const createError = createMutation.isError
    ? mutationErrorMessage(createMutation.error, "Could not create the team.")
    : null;
  /** The name-taken case is shown on the field; everything else is a banner. */
  const banner = createError === NAME_TAKEN ? null : createError;

  const trimmed = query.trim().toLowerCase();
  const rows =
    trimmed === ""
      ? teams
      : teams.filter((team) => team.name.toLowerCase().includes(trimmed));

  const usedBy = (team: Domain.TeamSummary) =>
    groupUsedBy(ownedSteps.filter((step) => step.teamId === team.id));

  const createButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={CREATE_MODAL}
      command="--show"
    >
      Create team
    </s-button>
  );

  const renderRows = () => {
    if (teams.length === 0)
      return (
        <s-box padding="base">
          <s-stack gap="base" alignItems="start">
            <s-paragraph color="subdued">
              No teams yet. A team is who can work a step; assign one to each
              step in a workflow.
            </s-paragraph>
            {createButton(false)}
          </s-stack>
        </s-box>
      );
    if (rows.length === 0)
      return (
        <s-box padding="base">
          <s-stack gap="base" alignItems="start">
            <s-paragraph color="subdued">No teams match.</s-paragraph>
            <s-button
              variant="secondary"
              onClick={() => {
                setQuery("");
              }}
            >
              Clear filters
            </s-button>
          </s-stack>
        </s-box>
      );
    return (
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Team</s-table-header>
          <s-table-header>Members</s-table-header>
          <s-table-header>Used by</s-table-header>
          <s-table-header>Created</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((team) => {
            const workflows = usedBy(team);
            return (
              <s-table-row key={team.id} id={team.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-300">
                    <s-link href={`/app/teams/${team.id}`}>{team.name}</s-link>
                    {team.memberCount === 0 && (
                      <s-badge tone="warning">No members</s-badge>
                    )}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{team.memberCount}</s-table-cell>
                <s-table-cell>
                  {workflows.length === 0 ? (
                    <s-text color="subdued">—</s-text>
                  ) : (
                    <s-stack direction="inline" gap="small-300">
                      {workflows.map((workflow, index) => (
                        <React.Fragment key={workflow.workflowId}>
                          {index > 0 && <s-text color="subdued">,</s-text>}
                          <s-link href={workflow.href}>
                            {workflow.workflowName}
                          </s-link>
                          {workflow.draftOnly && <s-badge>draft</s-badge>}
                        </React.Fragment>
                      ))}
                    </s-stack>
                  )}
                </s-table-cell>
                <s-table-cell>
                  <LocalDateTime value={team.createdAt} />
                </s-table-cell>
              </s-table-row>
            );
          })}
        </s-table-body>
      </s-table>
    );
  };

  return (
    <s-page heading="Teams" inlineSize="large">
      <SocketBanner />
      {teams.length > 0 && createButton(true)}

      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {/* `padding="none"` so the table runs edge to edge; the description
          goes inside a padded intro box instead of a slotted heading. */}
      <s-section padding="none" accessibilityLabel="Teams">
        <s-box padding="base" paddingBlockEnd="none">
          <s-paragraph color="subdued">
            Teams are who can work a step. Assign a team to each step in a
            workflow.
          </s-paragraph>
        </s-box>

        {teams.length > 0 && (
          <s-box padding="base">
            <s-stack gap="small-300">
              <s-search-field
                label="Search teams by name"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by name"
                value={query}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                }}
              />
              {trimmed !== "" && (
                <s-paragraph color="subdued">
                  {`Showing ${String(rows.length)} of ${String(teams.length)} teams.`}
                </s-paragraph>
              )}
            </s-stack>
          </s-box>
        )}

        {renderRows()}
      </s-section>

      <s-modal
        id={CREATE_MODAL}
        heading="Create team"
        onShow={() => {
          form.reset();
          setNameError(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <s-text-field
                label="Name"
                name={field.name}
                details="You'll add members next."
                value={field.state.value}
                maxLength={64}
                error={nameError ?? fieldError(field.state.meta.errors)}
                onInput={(event) => {
                  setNameError(null);
                  field.handleChange(event.currentTarget.value);
                }}
                onBlur={field.handleBlur}
                required
              />
            )}
          </form.Field>
        </form>
        <s-button
          slot="secondary-actions"
          commandFor={CREATE_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={createMutation.isPending}
          onClick={() => {
            void form.handleSubmit();
          }}
        >
          Create
        </s-button>
      </s-modal>
    </s-page>
  );
}
