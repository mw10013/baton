import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { formatDateTime } from "@/lib/format";
import { Repository } from "@/lib/Repository";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";

const teamsSearchSchema = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
});

const TeamNameInput = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Name is required" })),
});
type TeamNameInput = typeof TeamNameInput.Type;

const TeamArchivedInput = Schema.Struct({
  teamId: Schema.String,
  archived: Schema.Boolean,
});

const decodeName = Schema.decodeUnknownEffect(Domain.TeamName);
const decodeTeamId = Schema.decodeUnknownEffect(Domain.TeamId);
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

const getTeams = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(teamsSearchSchema))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const teams = yield* (yield* Repository).listTeams({
          shop: yield* sessionShop(session.shop),
          includeArchived: data.archived === true,
        });
        return { teams };
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

const setTeamArchivedFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(TeamArchivedInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        yield* (yield* Repository).setTeamArchived({
          shop: yield* sessionShop(session.shop),
          id: yield* decodeTeamId(data.teamId),
          archived: data.archived,
        });
      }).pipe(Effect.catchTag("TeamNotFoundError", failWith(TEAM_GONE))),
    ),
  );

export const Route = createFileRoute("/app/teams/")({
  validateSearch: Schema.toStandardSchemaV1(teamsSearchSchema),
  loaderDeps: ({ search }) => ({ archived: search.archived }),
  loader: ({ deps }) => getTeams({ data: deps }),
  component: RouteComponent,
});

function RouteComponent() {
  const { teams } = Route.useLoaderData();
  const { archived } = Route.useSearch();
  const router = useRouter();
  const createTeam = useServerFn(createTeamFn);
  const setTeamArchived = useServerFn(setTeamArchivedFn);

  const createMutation = useMutation({
    mutationFn: (data: TeamNameInput) => createTeam({ data }),
    onSuccess: async () => {
      form.reset();
      await router.invalidate({ sync: true });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (data: { teamId: string; archived: boolean }) =>
      setTeamArchived({ data }),
    onSuccess: () => router.invalidate({ sync: true }),
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
    { mutation: archiveMutation, fallback: "Could not update the team." },
  ].find(({ mutation }) => mutation.isError);
  const mutationError =
    failedMutation &&
    mutationErrorMessage(
      failedMutation.mutation.error,
      failedMutation.fallback,
    );

  return (
    <s-page heading="Teams" inlineSize="large">
      <s-section heading="Create team" accessibilityLabel="Create team">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Teams group members so work can be scoped to them. A member with no
            team sees nothing to do. Teams are archived, never deleted, so past
            work stays readable.
          </s-paragraph>
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
          <s-checkbox
            label="Show archived"
            checked={archived === true}
            onChange={() => {
              void router.navigate({
                to: "/app/teams",
                search: { archived: archived === true ? undefined : true },
              });
            }}
          />
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
                {teams.map((team) => (
                  <s-table-row key={team.id} id={team.id}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-300">
                        <s-link href={`/app/teams/${team.id}`}>
                          {team.name}
                        </s-link>
                        {team.archivedAt !== null && (
                          <s-badge tone="info">Archived</s-badge>
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
                        disabled={archiveMutation.isPending}
                        onClick={() => {
                          archiveMutation.mutate({
                            teamId: team.id,
                            archived: team.archivedAt === null,
                          });
                        }}
                      >
                        {team.archivedAt === null ? "Archive" : "Restore"}
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
