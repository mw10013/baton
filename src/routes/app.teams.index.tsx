import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import { EmptyLine } from "@/components/screen/EmptyLine";
import { FilterRow } from "@/components/screen/FilterRow";
import { IndexSection } from "@/components/screen/IndexSection";
import { Inline } from "@/components/screen/Inline";
import { ListSearchField } from "@/components/screen/ListSearchField";
import { SearchLine } from "@/components/screen/SearchLine";
import { textLimitError } from "@/components/screen/TextLimit";
import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { lenientSearchKey, ListSearchParam } from "@/lib/searchParams";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useNextPageEntry } from "@/lib/tablePages";
import {
  decodeName,
  failWith,
  INDEX_PAGE_SIZE,
  NAME_TAKEN,
  sessionShop,
} from "@/lib/teams";

const CREATE_MODAL = "create-team";

const teamLimitMessage = (limit: number) =>
  `A shop can have ${String(limit)} teams. Delete one to add another.`;

const TeamNameInput = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Enter a name" })),
});
type TeamNameInput = typeof TeamNameInput.Type;

/**
 * The teams index's URL: the search and the page. `q` is matched anywhere
 * in the name, over every team; `after` is the last name of the page before
 * (`Repository.listTeamsPage`). Lenient for the reason on `OrdersSearch`
 * (`app.orders.tsx`).
 */
const TeamsSearch = Schema.Struct({
  q: lenientSearchKey(ListSearchParam),
  after: lenientSearchKey(Domain.TeamName),
});

const TeamsLoaderInput = Schema.Struct({
  q: Schema.NullOr(Domain.ListSearch),
  after: Schema.NullOr(Domain.TeamName),
});

/**
 * One page of teams in name order. `workflowCounts` is Durable Object data
 * joined into a D1 page by the loader (the loader-versus-socket rule on
 * `ShopAgentClient`): the Workflows column, one count per team that has
 * one.
 */
interface TeamsIndexLoaderData {
  readonly teams: readonly Domain.TeamSummary[];
  readonly nextCursor: Domain.TeamName | null;
  readonly matches: number | null;
  readonly workflowCounts: readonly Domain.TeamWorkflowCount[];
}

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(TeamsLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data: { q, after }, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const page = yield* (yield* Repository).listTeamsPage({
          shop: yield* sessionShop(session.shop),
          limit: INDEX_PAGE_SIZE,
          after,
          q,
        });
        const workflowCounts =
          yield* (yield* ShopAgentClient).countTeamWorkflows(session.shop);
        return {
          teams: page.rows,
          nextCursor: page.nextCursor,
          matches: page.matches,
          workflowCounts,
        } satisfies TeamsIndexLoaderData;
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
      }).pipe(
        Effect.catchTag("TeamNameTakenError", failWith(NAME_TAKEN)),
        Effect.catchTag("TeamLimitError", ({ limit }) =>
          Effect.fail(new Error(teamLimitMessage(limit))),
        ),
      ),
    ),
  );

export const Route = createFileRoute("/app/teams/")({
  validateSearch: Schema.toStandardSchemaV1(TeamsSearch),
  loaderDeps: ({ search }) => ({
    q: search.q ?? null,
    after: search.after ?? null,
  }),
  loader: ({ deps }) => getLoaderData({ data: deps }),
  component: RouteComponent,
});

/**
 * The teams page on the workflows pattern: a primary action that opens a
 * modal, a search once there is something to search, and no destructive
 * control on the index — deletion lives on the detail page, where the dialog
 * is. Workflows is how many workflows use each team, from one object read
 * of every team's count; the names are on the team page.
 */
function RouteComponent() {
  const { teams, nextCursor, matches, workflowCounts } = Route.useLoaderData();
  const { q, after } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const nextPageEntry = useNextPageEntry("after");
  const shopify = useAppBridge();
  const createTeam = useServerFn(createTeamFn);
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
      const message = mutationErrorMessage(error, "Couldn't create the team.");
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

  /** The cap is the field's own error before the schema's words can be (the text-limit control on `Control`). */
  const submit = () => {
    const limit = textLimitError(
      form.getFieldValue("name"),
      Domain.TEAM_NAME_MAX_LENGTH,
    );
    if (limit !== null) {
      setNameError(limit);
      return;
    }
    void form.handleSubmit();
  };

  const createError = createMutation.isError
    ? mutationErrorMessage(createMutation.error, "Couldn't create the team.")
    : null;
  /** The name-taken case is shown on the field; everything else is a banner. */
  const banner = createError === NAME_TAKEN ? null : createError;

  /** `replace: true`: a search is the screen's state, not a trail. */
  const setSearch = (next: Domain.ListSearch | null) => {
    void navigate({
      search: { q: next ?? undefined, after: undefined },
      replace: true,
    });
  };
  const nextPage = (cursor: Domain.TeamName) => {
    void navigate({
      search: (prev) => ({ ...prev, after: cursor }),
      state: { nextPageOf: "after" },
    });
  };
  const previousPage = () => {
    if (nextPageEntry) {
      router.history.back();
      return;
    }
    void navigate({
      search: (prev) => ({ ...prev, after: undefined }),
      replace: true,
    });
  };
  /** No search and page one: an empty page here means the shop has no teams. */
  const unfiltered = q === undefined && after === undefined;

  const workflowCount = (team: Domain.TeamSummary) =>
    workflowCounts.find((row) => row.teamId === team.id)?.workflowCount ?? 0;

  const createButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={CREATE_MODAL}
      command="--show"
    >
      {`${Domain.RECORD_VERB_LABEL.create} team`}
    </s-button>
  );

  const renderRows = () => {
    if (unfiltered && teams.length === 0)
      return (
        <EmptyLine heading="No teams yet" action={createButton(false)}>
          A team is who can work a task; assign one to each task in a workflow.
        </EmptyLine>
      );
    if (q !== undefined && teams.length === 0)
      return (
        <EmptyLine
          action={
            <s-button
              variant="secondary"
              onClick={() => {
                setSearch(null);
              }}
            >
              Clear search
            </s-button>
          }
        >
          No teams match.
        </EmptyLine>
      );
    return (
      <s-table
        paginate={after !== undefined || nextCursor !== null}
        hasPreviousPage={after !== undefined}
        hasNextPage={nextCursor !== null}
        onPreviousPage={previousPage}
        onNextPage={() => {
          if (nextCursor !== null) nextPage(nextCursor);
        }}
      >
        {/* No "orders waiting on this team" link per row, though the detail
            page carries one: this index is the teams, and the row already
            links to the page where that drill-in lives. */}
        <s-table-header-row>
          <s-table-header listSlot="primary">Team</s-table-header>
          <s-table-header>Members</s-table-header>
          <s-table-header>Workflows</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {teams.map((team) => {
            return (
              <s-table-row key={team.id} id={team.id}>
                <s-table-cell>
                  <Inline>
                    <s-link href={`/app/teams/${team.id}`}>{team.name}</s-link>
                    {team.memberCount === 0 && (
                      <s-badge tone="warning">No members</s-badge>
                    )}
                  </Inline>
                </s-table-cell>
                <s-table-cell>{team.memberCount}</s-table-cell>
                <s-table-cell>{workflowCount(team)}</s-table-cell>
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
      {/* Unconditional, empty list included: the resource-index template keeps
          the title-bar primary action and lets the empty state carry a second
          copy, so "create is top right" holds on the visit where it matters
          most. App Bridge hoists this one out of the iframe, so the in-card
          twin is not a duplicate in the frame's DOM — frame- and page-scoped
          e2e locators stay disjoint.
          https://shopify.dev/docs/api/app-home/latest/patterns/templates/resource-index */}
      {createButton(true)}

      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {/* The description sits in the section's head, above the search,
          only with rows: on empty the centred empty state already says what
          a team is, and this paragraph said it a second time. The search is
          submitted on Enter and reads every team, not only this page; while
          it is on, how many match and Clear search sit above it
          ({@link SearchLine}). */}
      <IndexSection
        label="Teams"
        head={
          !(unfiltered && teams.length === 0) && (
            <>
              {q !== undefined && matches !== null && matches > 0 && (
                <SearchLine
                  count={matches}
                  noun={["team", "teams"]}
                  term={q}
                  onClear={() => {
                    setSearch(null);
                  }}
                />
              )}
              <FilterRow
                search={
                  <ListSearchField
                    value={q ?? null}
                    placeholder="Search by name"
                    onSubmit={setSearch}
                  />
                }
              />
            </>
          )
        }
      >
        {renderRows()}
      </IndexSection>

      <s-modal
        id={CREATE_MODAL}
        heading={`${Domain.RECORD_VERB_LABEL.create} team`}
        /* Reset on the way out, not on the way in: `show` can fire after a field
           has already taken input, and a reset there wipes what was typed
           (the members index's Add member dialog did exactly that). */
        onAfterHide={() => {
          form.reset();
          setNameError(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <s-text-field
                label="Name"
                name={field.name}
                value={field.state.value}
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
          onClick={submit}
        >
          {Domain.RECORD_VERB_LABEL.create}
        </s-button>
      </s-modal>
    </s-page>
  );
}
