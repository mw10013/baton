import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";

const TeamIdInput = Schema.Struct({ teamId: Schema.String });

const NameInput = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Name is required" })),
});
type NameInput = typeof NameInput.Type;

const RenameTeamInput = Schema.Struct({
  teamId: Schema.String,
  ...NameInput.fields,
});

const TeamMemberInput = Schema.Struct({
  teamId: Schema.String,
  memberId: Schema.String,
  inTeam: Schema.Boolean,
});

const decodeName = Schema.decodeUnknownEffect(Domain.TeamName);
const decodeTeamId = Schema.decodeUnknownEffect(Domain.TeamId);
const decodeMemberId = Schema.decodeUnknownEffect(Domain.MemberId);
const sessionShop = (shop: string) =>
  Schema.decodeUnknownEffect(Domain.Shop)(shop);

/** See the sibling list route for why tagged failures are replaced by copy. */
const failWith = (message: string) => () => Effect.fail(new Error(message));

const NAME_TAKEN = "A team with that name already exists.";
const TEAM_GONE = "That team is no longer available.";

const decodeOwnedSteps = Schema.decodeUnknownPromise(
  Schema.toType(Schema.Array(Domain.OwnedStep)),
);

const getTeamDetail = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(TeamIdInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const detail = yield* (yield* Repository).findTeamDetail({
          shop: yield* sessionShop(session.shop),
          id: yield* decodeTeamId(data.teamId),
        });
        if (Option.isNone(detail)) return yield* Effect.fail(notFound());
        return detail.value;
      }),
    ),
  );

const renameTeamFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(RenameTeamInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        yield* (yield* Repository).renameTeam({
          shop: yield* sessionShop(session.shop),
          id: yield* decodeTeamId(data.teamId),
          name: yield* decodeName(data.name),
        });
      }).pipe(
        Effect.catchTag("TeamNameTakenError", failWith(NAME_TAKEN)),
        Effect.catchTag("TeamNotFoundError", failWith(TEAM_GONE)),
      ),
    ),
  );

const setTeamMemberFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(TeamMemberInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        yield* (yield* Repository).setTeamMember({
          shop: yield* sessionShop(session.shop),
          teamId: yield* decodeTeamId(data.teamId),
          memberId: yield* decodeMemberId(data.memberId),
          inTeam: data.inTeam,
        });
      }).pipe(Effect.catchTag("TeamNotFoundError", failWith(TEAM_GONE))),
    ),
  );

export const Route = createFileRoute("/app/teams/$teamId")({
  loader: ({ params }) => getTeamDetail({ data: { teamId: params.teamId } }),
  component: RouteComponent,
});

function RouteComponent() {
  const { team, members } = Route.useLoaderData();
  const router = useRouter();
  const renameTeam = useServerFn(renameTeamFn);
  const setTeamMember = useServerFn(setTeamMemberFn);
  const archived = team.archivedAt !== null;
  const { agent, identified } = useShopAgent();

  // oxlint-disable-next-line @tanstack/query/exhaustive-deps -- agent.stub is the stable per-shop socket; the cache identity is the shop plus the team
  const ownedStepsQuery = useQuery({
    queryKey: ["team-steps", team.shop, team.id],
    staleTime: Infinity,
    queryFn: () =>
      agent
        ? withSocketRecovery(agent)(() =>
            agent.stub.listStepsOwnedBy({ teamId: team.id }),
          ).then(decodeOwnedSteps)
        : Promise.reject(new Error("Still connecting. Try again in a moment.")),
    enabled: identified,
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      renameTeam({ data: { teamId: team.id, name } }),
    onSuccess: () => router.invalidate({ sync: true }),
  });

  const memberMutation = useMutation({
    mutationFn: (data: { memberId: string; inTeam: boolean }) =>
      setTeamMember({ data: { teamId: team.id, ...data } }),
    onSuccess: () => router.invalidate({ sync: true }),
  });

  const defaultValues: NameInput = { name: team.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: Schema.toStandardSchemaV1(NameInput) },
    onSubmit: ({ value }) => {
      void renameMutation.mutateAsync(value.name);
    },
  });

  const failedMutation = [
    { mutation: renameMutation, fallback: "Could not rename the team." },
    { mutation: memberMutation, fallback: "Could not update team members." },
  ].find(({ mutation }) => mutation.isError);
  const mutationError =
    failedMutation &&
    mutationErrorMessage(
      failedMutation.mutation.error,
      failedMutation.fallback,
    );

  const renderOwnedSteps = () => {
    if (ownedStepsQuery.isError)
      return (
        <s-banner tone="critical">
          {ownedStepsQuery.error instanceof Error
            ? ownedStepsQuery.error.message
            : "Could not load workflow steps."}
        </s-banner>
      );
    if (ownedStepsQuery.data === undefined)
      return <s-paragraph color="subdued">Loading…</s-paragraph>;
    if (ownedStepsQuery.data.length === 0)
      return (
        <s-paragraph color="subdued">
          No workflow steps are assigned to this team.
        </s-paragraph>
      );
    return (
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Workflow</s-table-header>
          <s-table-header>Step</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {ownedStepsQuery.data.map((owned, index) => (
            <s-table-row
              key={`${owned.workflowId}-${String(index)}`}
              id={`${owned.workflowId}-${String(index)}`}
            >
              <s-table-cell>
                <s-stack direction="inline" gap="small-300">
                  <s-link href={`/app/workflows/${owned.workflowId}`}>
                    {owned.workflowName}
                  </s-link>
                  {owned.workflowArchived && (
                    <s-badge tone="info">Archived</s-badge>
                  )}
                </s-stack>
              </s-table-cell>
              <s-table-cell>{owned.stepName}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  return (
    <s-page heading={team.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/teams">
        Teams
      </s-link>
      {archived && (
        <s-badge slot="accessory" tone="info">
          Archived
        </s-badge>
      )}
      <SocketBanner />
      <s-section heading="Name" accessibilityLabel="Team name">
        <s-stack gap="base">
          {mutationError && (
            <s-banner tone="critical">{mutationError}</s-banner>
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
                  {...(renameMutation.isPending ? { loading: true } : {})}
                >
                  Save
                </s-button>
              </s-stack>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section
        heading="Workflow steps"
        accessibilityLabel="Workflow steps owned by this team"
      >
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Steps this team owns. A team cannot be archived while any step still
            points at it; reassign those steps first.
          </s-paragraph>
          {renderOwnedSteps()}
        </s-stack>
      </s-section>

      <s-section heading="Members" accessibilityLabel="Team members">
        {members.length === 0 ? (
          <s-stack gap="base">
            <s-paragraph color="subdued">
              This shop has no members yet.
            </s-paragraph>
            <s-link href="/app/members">Add members</s-link>
          </s-stack>
        ) : (
          <s-stack gap="base">
            {archived && (
              <s-paragraph color="subdued">
                Restore this team to add members. Removing a member still works
                while archived.
              </s-paragraph>
            )}
            {members.map((member) => (
              <s-stack key={member.id} direction="inline" gap="small-300">
                <s-checkbox
                  label={member.email}
                  checked={member.inTeam}
                  disabled={
                    memberMutation.isPending || (archived && !member.inTeam)
                  }
                  onChange={() => {
                    memberMutation.mutate({
                      memberId: member.id,
                      inTeam: !member.inTeam,
                    });
                  }}
                />
                {member.archivedAt !== null && (
                  <s-badge tone="info">Archived</s-badge>
                )}
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
