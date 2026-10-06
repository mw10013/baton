import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Option, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { EmptyLine } from "@/components/screen/EmptyLine";
import { End } from "@/components/screen/End";
import { Pairs } from "@/components/screen/Pairs";
import { TableFrame } from "@/components/screen/TableFrame";
import { textLimitError } from "@/components/screen/TextLimit";
import { Things } from "@/components/screen/Things";
import { Token } from "@/components/screen/Token";
import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { lenientSearchKey } from "@/lib/searchParams";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useNextPageEntry } from "@/lib/tablePages";
import {
  decodeDeleteTeamResult,
  decodeName,
  DELETE_CONFIRM,
  DELETED_TOAST,
  deleteTeamResultMessage,
  DETAILS_PAGE_SIZE,
  failWith,
  NAME_TAKEN,
  SEARCH_FROM,
  sessionShop,
  TEAM_GONE,
} from "@/lib/teams";

const RENAME_MODAL = "rename-team";
const DELETE_MODAL = "delete-team";
const ADD_MODAL = "add-team-members";

/**
 * The team page's URL: the page of each of its two tables, as the last
 * value of the page before (`Repository.findTeamDetail`,
 * `Domain.TeamWorkflowsInput`). Each Next keeps the other key, so paging one
 * table leaves the other where it was. Lenient for the reason on
 * `OrdersSearch` (`app.orders.tsx`).
 */
const TeamSearch = Schema.Struct({
  membersAfter: lenientSearchKey(Domain.Email),
  workflowsAfter: lenientSearchKey(Domain.WorkflowName),
});

const TeamLoaderInput = Schema.Struct({
  teamId: Schema.String,
  membersAfter: Schema.NullOr(Domain.Email),
  workflowsAfter: Schema.NullOr(Domain.WorkflowName),
});

const NameInput = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty({ message: "Enter a name" })),
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

const AddTeamMembersInput = Schema.Struct({
  teamId: Schema.String,
  memberIds: Schema.Array(Schema.String),
});

const decodeTeamId = Schema.decodeUnknownEffect(Domain.TeamId);
const decodeMemberId = Schema.decodeUnknownEffect(Domain.MemberId);
const decodeMemberIds = Schema.decodeUnknownEffect(
  Schema.Array(Domain.MemberId),
);

/**
 * `teamWorkflows` is Durable Object data joined into a D1 page by the
 * loader — see the loader-versus-socket rule on
 * `ShopAgentClient`.
 */
interface TeamLoaderData extends Domain.TeamDetail {
  readonly teamWorkflows: Domain.TeamWorkflowsPage;
}

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(TeamLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const repository = yield* Repository;
        const detail = yield* repository.findTeamDetail({
          shop,
          id: yield* decodeTeamId(data.teamId),
          membersAfter: data.membersAfter,
          limit: DETAILS_PAGE_SIZE,
        });
        if (Option.isNone(detail)) return yield* Effect.fail(notFound());
        const client = yield* ShopAgentClient;
        const teamWorkflows = yield* client.listTeamWorkflows(shop, {
          teamId: detail.value.team.id,
          after: data.workflowsAfter,
          limit: DETAILS_PAGE_SIZE,
        });
        return {
          ...detail.value,
          teamWorkflows,
        } satisfies TeamLoaderData;
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

/**
 * A change to a team's members changes what the member may act on, and a member who is signed
 * in is holding a socket whose `teamIds` were resolved when it connected
 * (`Domain.ConnectionState`). So every one of these writes ends by revoking
 * the affected members' connections: they reconnect through the Worker's gate
 * and come back with the teams this edit just wrote. Unbatched, one RPC per
 * edit — these are merchant actions on one team at a time, so the cost is a
 * round trip nobody is waiting on.
 */
const setTeamMemberFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(TeamMemberInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const memberId = yield* decodeMemberId(data.memberId);
        yield* (yield* Repository).setTeamMember({
          shop,
          teamId: yield* decodeTeamId(data.teamId),
          memberId,
          inTeam: data.inTeam,
        });
        yield* (yield* ShopAgentClient).revokeMemberConnections(shop, {
          memberIds: [memberId],
        });
      }).pipe(Effect.catchTag("TeamNotFoundError", failWith(TEAM_GONE))),
    ),
  );

const addTeamMembersFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(AddTeamMembersInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const memberIds = yield* decodeMemberIds(data.memberIds);
        yield* (yield* Repository).addTeamMembers({
          shop,
          teamId: yield* decodeTeamId(data.teamId),
          memberIds,
        });
        yield* (yield* ShopAgentClient).revokeMemberConnections(shop, {
          memberIds,
        });
      }).pipe(Effect.catchTag("TeamNotFoundError", failWith(TEAM_GONE))),
    ),
  );

export const Route = createFileRoute("/app/teams/$teamId")({
  validateSearch: Schema.toStandardSchemaV1(TeamSearch),
  loaderDeps: ({ search }) => ({
    membersAfter: search.membersAfter ?? null,
    workflowsAfter: search.workflowsAfter ?? null,
  }),
  loader: ({ params, deps }) =>
    getLoaderData({ data: { teamId: params.teamId, ...deps } }),
  component: RouteComponent,
});

/**
 * The team page is about people: its members are the first table, adding is
 * the primary action, and the workflows that use the team are a table of
 * links under it (tasks are edited on the workflow pages). Rename and delete
 * live behind More actions, as on the workflow page. Remove on a member's row
 * has no modal: Add members puts them back on this screen.
 *
 * Laid out as Polaris' details template, like the order and workflow detail
 * pages: the two tables own the main column, each under its own heading and
 * paged from the server, and the facts a merchant checks before renaming or
 * deleting sit in the Details aside. That keeps `s-page`'s children
 * sections, which is the only thing it lays out, so nothing floats on the
 * page background. `inlineSize` must stay "base": `s-page` drops the aside
 * slot entirely at "large".
 */
function RouteComponent() {
  const { team, members, memberCount, nextCursor, candidates, teamWorkflows } =
    Route.useLoaderData();
  const { membersAfter, workflowsAfter } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const membersNextEntry = useNextPageEntry("membersAfter");
  const workflowsNextEntry = useNextPageEntry("workflowsAfter");
  const shopify = useAppBridge();
  const renameTeam = useServerFn(renameTeamFn);
  const setTeamMember = useServerFn(setTeamMemberFn);
  const addTeamMembers = useServerFn(addTeamMembersFn);
  const { agent, identified } = useShopAgent();
  const [deleteBanner, setDeleteBanner] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [addQuery, setAddQuery] = React.useState("");
  const [selected, setSelected] = React.useState<readonly string[]>([]);

  /**
   * Next keeps the other table's key (`search: prev`), so paging one table
   * leaves the other where it was; Previous is Back when this table's Next
   * pushed the entry ({@link useNextPageEntry}), page one otherwise.
   */
  const pageMembers = (cursor: Domain.Email | null) => {
    if (cursor === null && membersNextEntry) {
      router.history.back();
      return;
    }
    void navigate({
      search: (prev) => ({ ...prev, membersAfter: cursor ?? undefined }),
      ...(cursor === null
        ? { replace: true }
        : { state: { nextPageOf: "membersAfter" } }),
    });
  };
  const pageWorkflows = (cursor: Domain.WorkflowName | null) => {
    if (cursor === null && workflowsNextEntry) {
      router.history.back();
      return;
    }
    void navigate({
      search: (prev) => ({ ...prev, workflowsAfter: cursor ?? undefined }),
      ...(cursor === null
        ? { replace: true }
        : { state: { nextPageOf: "workflowsAfter" } }),
    });
  };

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      renameTeam({ data: { teamId: team.id, name } }),
    onSuccess: async () => {
      await router.invalidate({ sync: true });
      await shopify.modal.hide(RENAME_MODAL);
    },
    onError: (error: Error) => {
      const message = mutationErrorMessage(error, "Couldn't rename the team.");
      if (message === NAME_TAKEN) setNameError(message);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      setTeamMember({ data: { teamId: team.id, memberId, inTeam: false } }),
    onSuccess: () => router.invalidate({ sync: true }),
  });

  const addMutation = useMutation({
    mutationFn: (memberIds: readonly string[]) =>
      addTeamMembers({ data: { teamId: team.id, memberIds: [...memberIds] } }),
    onSuccess: async () => {
      await shopify.modal.hide(ADD_MODAL);
      setSelected([]);
      await router.invalidate({ sync: true });
    },
  });

  /**
   * Delete goes through the Durable Object: it deletes the D1 row and then
   * nulls every task pointer in the object's SQLite, in that order, so a task
   * saved against the team meanwhile is caught by the nulling (see
   * `ShopAgent.deleteTeam`).
   */
  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!agent)
        return Promise.reject(
          new Error("Still connecting. Try again in a moment."),
        );
      return withSocketRecovery(agent)(() =>
        agent.stub.deleteTeam({ teamId: team.id }),
      ).then(decodeDeleteTeamResult);
    },
    onSuccess: async (result) => {
      if (result._tag === "Deleted") {
        await shopify.modal.hide(DELETE_MODAL);
        /* Toast, then navigate, as the workflow page does: the admin's toast
           outlives the page. */
        shopify.toast.show(DELETED_TOAST.team);
        await router.navigate({ to: "/app/teams" });
        return;
      }
      await shopify.modal.hide(DELETE_MODAL);
      setDeleteBanner(deleteTeamResultMessage(result));
    },
  });

  const defaultValues: NameInput = { name: team.name };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: Schema.toStandardSchemaV1(NameInput) },
    onSubmit: ({ value }) => {
      renameMutation.mutate(value.name);
    },
  });

  /** The cap is the field's own error before the schema's words can be (the text-limit control on `Control`). */
  const submitRename = () => {
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

  const renameError = renameMutation.isError
    ? mutationErrorMessage(renameMutation.error, "Couldn't rename the team.")
    : null;
  const failedMutation = [
    { mutation: addMutation, fallback: "Couldn't add members." },
    { mutation: removeMutation, fallback: "Couldn't remove the member." },
    { mutation: deleteMutation, fallback: "Couldn't delete the team." },
  ].find(({ mutation }) => mutation.isError);
  /** The name-taken case is shown on the rename field; everything else is a banner. */
  const mutationError =
    renameError !== null && renameError !== NAME_TAKEN
      ? renameError
      : failedMutation &&
        mutationErrorMessage(
          failedMutation.mutation.error,
          failedMutation.fallback,
        );

  const addTrimmed = addQuery.trim().toLowerCase();
  const matches =
    addTrimmed === ""
      ? candidates
      : candidates.filter((member) =>
          member.email.toLowerCase().includes(addTrimmed),
        );

  /**
   * `s-choice-list` reports only the choices it has rendered, so a member ticked
   * before the search narrowed the list would be dropped by the next change
   * event. The rendered ids are replaced wholesale and the rest of the selection
   * is kept, which is what lets a merchant search, tick, search again, and add
   * both.
   */
  const changeSelected = (values: readonly string[]) => {
    const rendered = new Set<string>(matches.map((member) => member.id));
    setSelected([...selected.filter((id) => !rendered.has(id)), ...values]);
  };

  const addButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={ADD_MODAL}
      command="--show"
    >
      {`${Domain.RECORD_VERB_LABEL.add} members`}
    </s-button>
  );

  const renderMembers = () => {
    if (memberCount === 0)
      return (
        <EmptyLine heading="Nobody on this team yet" action={addButton(false)}>
          Nobody is on this team, so its tasks wait until a member joins.
        </EmptyLine>
      );
    return (
      /* Framed inside the card ({@link TableFrame}). */
      <TableFrame>
        <s-table
          paginate={membersAfter !== undefined || nextCursor !== null}
          hasPreviousPage={membersAfter !== undefined}
          hasNextPage={nextCursor !== null}
          onPreviousPage={() => {
            pageMembers(null);
          }}
          onNextPage={() => {
            if (nextCursor !== null) pageMembers(nextCursor);
          }}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Member</s-table-header>
            <s-table-header>
              <End>Actions</End>
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {members.map((member) => (
              <s-table-row key={member.id} id={member.id}>
                <s-table-cell>
                  <Token href={`/app/members/${member.id}`}>
                    {member.email}
                  </Token>
                </s-table-cell>
                <s-table-cell>
                  <End>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      disabled={removeMutation.isPending}
                      onClick={() => {
                        removeMutation.mutate(member.id);
                      }}
                    >
                      {Domain.RECORD_VERB_LABEL.remove}
                    </s-button>
                  </End>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </TableFrame>
    );
  };

  const renderWorkflows = () => {
    if (teamWorkflows.workflows.length === 0 && workflowsAfter === undefined)
      return (
        <s-paragraph color="subdued">Not used by any workflow yet.</s-paragraph>
      );
    return (
      <TableFrame>
        <s-table
          paginate={
            workflowsAfter !== undefined || teamWorkflows.nextCursor !== null
          }
          hasPreviousPage={workflowsAfter !== undefined}
          hasNextPage={teamWorkflows.nextCursor !== null}
          onPreviousPage={() => {
            pageWorkflows(null);
          }}
          onNextPage={() => {
            if (teamWorkflows.nextCursor !== null)
              pageWorkflows(teamWorkflows.nextCursor);
          }}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Workflow</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {teamWorkflows.workflows.map((workflow) => (
              <s-table-row key={workflow.workflowId} id={workflow.workflowId}>
                <s-table-cell>
                  <s-link href={`/app/workflows/${workflow.workflowId}`}>
                    {workflow.workflowName}
                  </s-link>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </TableFrame>
    );
  };

  return (
    <s-page heading={team.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/teams">
        Teams
      </s-link>
      {/* No "No members" badge in the header: the members card below is
          the empty state for that, with the consequence and the Add button,
          and a second mark for one fault reads as two. The teams index keeps
          its badge, where the row is the only place the fact shows. */}
      {addButton(true)}
      {/* No link to this team's orders: this page is the team's members
          and the workflows that use it, which is configuration, not order
          state. The orders screen's Team filter answers "is this team backed
          up?", and a link here would pick one order state over the others. */}
      <s-button slot="secondary-actions" commandFor="team-actions">
        More actions
      </s-button>
      <s-menu id="team-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_MODAL} command="--show">
          {Domain.RECORD_VERB_LABEL.rename}
        </s-button>
        <s-button
          icon="delete"
          tone="critical"
          commandFor={DELETE_MODAL}
          command="--show"
        >
          {Domain.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-menu>

      <SocketBanner />

      <s-section heading="Members">
        <Things>
          {mutationError && (
            <s-banner tone="critical">{mutationError}</s-banner>
          )}
          {deleteBanner !== null && (
            <s-banner tone="warning">{deleteBanner}</s-banner>
          )}
          {renderMembers()}
        </Things>
      </s-section>

      {/* A table in the main column, not a list in the aside: a team may
          be used by up to every workflow in the shop, and Shopify pages a
          details page's tables, not its asides. */}
      <s-section heading="Used by">{renderWorkflows()}</s-section>

      <s-section slot="aside" heading="Details" accessibilityLabel="Details">
        <Pairs
          pairs={[
            { key: "members", label: "Members", value: String(memberCount) },
            {
              key: "created",
              label: "Created",
              value: <LocalDateTime value={team.createdAt} />,
            },
          ]}
        />
      </s-section>

      <s-modal
        id={RENAME_MODAL}
        heading="Rename team"
        /* The form's defaults are the current name, so a first open needs no
           seeding. Reset on the way out, not on the way in: `show` can fire
           after the field has already taken input, and a reset there wipes
           what was typed (the members index's create dialog did
           exactly that). Rename invalidates before it hides so this reseed
           reads the new name. */
        onAfterHide={() => {
          form.reset({ name: team.name });
          setNameError(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitRename();
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
          commandFor={RENAME_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={renameMutation.isPending}
          onClick={submitRename}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal id={DELETE_MODAL} heading={`Delete ${team.name}?`}>
        <s-paragraph>{DELETE_CONFIRM}</s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={DELETE_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleteMutation.isPending}
          disabled={!identified || deleteMutation.isPending}
          onClick={() => {
            deleteMutation.mutate();
          }}
        >
          {Domain.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-modal>

      {/* Our own dialog rather than App Bridge's Picker API. The picker is
          rendered by the admin host outside this iframe and takes no layout
          input beyond its columns, so a short list came out as a full-bleed
          table with a header row and a scrollbar for one row. A modal keeps
          the inset, drops the search field when there is nothing to search,
          and folds in the two nobody-to-add cases App Bridge's had to hand to a second dialog. The
          member page's Add to teams dialog is its mirror, editing the same
          membership from the other side. */}
      <s-modal
        id={ADD_MODAL}
        heading={`Add members to ${team.name}`}
        /* Cleared on the way out, not on the way in: `show` can fire after a
           search was typed or a box checked, and clearing there loses it
           (the members index's create dialog did exactly that). */
        onAfterHide={() => {
          setAddQuery("");
          setSelected([]);
        }}
      >
        {candidates.length === 0 ? (
          <s-paragraph>
            {memberCount === 0 ? (
              <>
                No members yet. Add them on{" "}
                <s-link href="/app/members">Members</s-link>.
              </>
            ) : (
              "Everyone is already on this team."
            )}
          </s-paragraph>
        ) : (
          <Things>
            {candidates.length >= SEARCH_FROM && (
              <s-search-field
                label="Search members by email"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by email"
                value={addQuery}
                onInput={(event) => {
                  setAddQuery(event.currentTarget.value);
                }}
              />
            )}
            {matches.length === 0 ? (
              <s-paragraph color="subdued">No members match.</s-paragraph>
            ) : (
              <s-choice-list
                label="Members"
                labelAccessibilityVisibility="exclusive"
                name="memberIds"
                multiple
                values={[...selected]}
                onChange={(event) => {
                  changeSelected([...event.currentTarget.values]);
                }}
              >
                {matches.map((member) => (
                  <s-choice key={member.id} value={member.id}>
                    {member.email}
                  </s-choice>
                ))}
              </s-choice-list>
            )}
          </Things>
        )}
        <s-button
          slot="secondary-actions"
          commandFor={ADD_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        {candidates.length > 0 && (
          <s-button
            slot="primary-action"
            variant="primary"
            loading={addMutation.isPending}
            disabled={selected.length === 0}
            onClick={() => {
              addMutation.mutate(selected);
            }}
          >
            Add
          </s-button>
        )}
      </s-modal>
    </s-page>
  );
}
