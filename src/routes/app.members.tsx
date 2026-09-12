import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Option, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { MemberTeamsFields } from "@/components/MemberTeamsFields";
import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository, RepositoryError } from "@/lib/Repository";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { failWith, sessionShop } from "@/lib/teams";

const ADD_MODAL = "add-member";
const EDIT_TEAMS_MODAL = "edit-member-teams";
const REMOVE_MODAL = "remove-member";

const AddMemberInput = Schema.Struct({
  email: Schema.String.check(
    Schema.isNonEmpty({ message: "Email is required" }),
  ),
  teamIds: Schema.Array(Schema.String),
});
type AddMemberInput = typeof AddMemberInput.Type;

const MemberTeamsInput = Schema.Struct({
  memberId: Schema.String,
  teamIds: Schema.Array(Schema.String),
});

const MemberEmailInput = Schema.Struct({ email: Schema.String });

const decodeEmail = Schema.decodeUnknownEffect(Domain.Email);
const decodeMemberId = Schema.decodeUnknownEffect(Domain.MemberId);
const decodeTeamIds = Schema.decodeUnknownEffect(Schema.Array(Domain.TeamId));

const MEMBER_GONE = "That member no longer exists.";

const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const repository = yield* Repository;
        const teams = yield* repository.listTeams({ shop });
        return {
          members: yield* repository.listMembers(shop),
          teams: teams.map(
            ({ id, name, memberCount }) =>
              ({ id, name, memberCount }) satisfies Domain.TeamRoster,
          ),
          memberTeams: yield* repository.listMemberTeams(shop),
        } satisfies Domain.MembersLoaderData;
      }),
    ),
  );

/**
 * Adding stays idempotent for the row (`Repository.addMember`), and now also
 * applies the chosen teams: re-adding an existing email with teams checked
 * replaces their team set with those; with nothing checked it leaves their
 * teams alone, so a stray re-add cannot strip access. The member is re-read
 * after the insert because `addMember` returns nothing; both run on the
 * primary connection, so a miss cannot happen and is reported as the
 * repository's own invariant failure.
 */
const addMemberFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(AddMemberInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const repository = yield* Repository;
        const shop = yield* sessionShop(session.shop);
        const email = yield* decodeEmail(data.email);
        yield* repository.addMember({ shop, email });
        if (data.teamIds.length === 0) return;
        const member = yield* repository.findMember({ shop, email }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                new RepositoryError({
                  message: "Member missing right after addMember",
                  cause: null,
                }),
              onSome: Effect.succeed,
            }),
          ),
        );
        yield* repository.setMemberTeams({
          shop,
          memberId: member.id,
          teamIds: yield* decodeTeamIds(data.teamIds),
        });
      }),
    ),
  );

const setMemberTeamsFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MemberTeamsInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        yield* (yield* Repository).setMemberTeams({
          shop: yield* sessionShop(session.shop),
          memberId: yield* decodeMemberId(data.memberId),
          teamIds: yield* decodeTeamIds(data.teamIds),
        });
      }),
    ),
  );

/**
 * Delete a member and they leave their teams (vocabulary on `Domain.Member`).
 * A plain server fn: a member owns nothing in the Durable Object, since run
 * steps snapshot the actor's email, so there is no second store to clean.
 */
const deleteMemberFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MemberEmailInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* repository.deleteMember({
          shop: yield* sessionShop(session.shop),
          email: yield* decodeEmail(data.email),
        });
      }).pipe(Effect.catchTag("MemberNotFoundError", failWith(MEMBER_GONE))),
    ),
  );

export const Route = createFileRoute("/app/members")({
  loader: () => getLoaderData(),
  component: RouteComponent,
});

/** Chips past this many collapse to "+N"; the full list is one click away in Edit teams. */
const MAX_CHIPS = 4;

/**
 * Members is a single page: a member is an email and a list of teams, which
 * is one table row, and everything a detail page would do is a modal here.
 * The Add member dialog offers teams up front because a member with no team
 * sees nothing to do — the trap a merchant otherwise learns about from a
 * paragraph. Edit teams and Add member share one checklist component.
 */
function RouteComponent() {
  const { members, teams, memberTeams } = Route.useLoaderData();
  const router = useRouter();
  const shopify = useAppBridge();
  const addMember = useServerFn(addMemberFn);
  const setMemberTeams = useServerFn(setMemberTeamsFn);
  const deleteMember = useServerFn(deleteMemberFn);
  const [query, setQuery] = React.useState("");
  /** Which member the Edit teams dialog is about, and its working selection. */
  const [editing, setEditing] = React.useState<Domain.Member | null>(null);
  const [editingTeamIds, setEditingTeamIds] = React.useState<readonly string[]>(
    [],
  );
  /** Which member the Remove dialog is about; one modal serves every row. */
  const [removing, setRemoving] = React.useState<Domain.Member | null>(null);

  const teamsOf = (member: Domain.Member) =>
    memberTeams.filter((row) => row.memberId === member.id);

  const addMutation = useMutation({
    mutationFn: (data: AddMemberInput) => addMember({ data }),
    onSuccess: async () => {
      await shopify.modal.hide(ADD_MODAL);
      await router.invalidate({ sync: true });
    },
  });

  const editMutation = useMutation({
    mutationFn: (data: { memberId: string; teamIds: readonly string[] }) =>
      setMemberTeams({
        data: { memberId: data.memberId, teamIds: [...data.teamIds] },
      }),
    onSuccess: async () => {
      await shopify.modal.hide(EDIT_TEAMS_MODAL);
      setEditing(null);
      await router.invalidate({ sync: true });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (email: string) => deleteMember({ data: { email } }),
    onSuccess: async () => {
      await shopify.modal.hide(REMOVE_MODAL);
      setRemoving(null);
      await router.invalidate({ sync: true });
    },
  });

  const form = useForm({
    defaultValues: {
      email: "",
      teamIds: [] as readonly string[],
    } satisfies AddMemberInput,
    validators: { onSubmit: Schema.toStandardSchemaV1(AddMemberInput) },
    onSubmit: ({ value }) => {
      addMutation.mutate(value);
    },
  });

  const failedMutation = [
    { mutation: addMutation, fallback: "Could not add the member." },
    { mutation: editMutation, fallback: "Could not update their teams." },
    { mutation: deleteMutation, fallback: "Could not remove the member." },
  ].find(({ mutation }) => mutation.isError);
  const mutationError =
    failedMutation &&
    mutationErrorMessage(
      failedMutation.mutation.error,
      failedMutation.fallback,
    );

  const trimmed = query.trim().toLowerCase();
  const rows =
    trimmed === ""
      ? members
      : members.filter((member) => member.email.includes(trimmed));

  /** The teams this member is the only person on: the remove would empty them. */
  const emptiedTeams = (member: Domain.Member) =>
    teamsOf(member)
      .filter((row) => row.teamMemberCount === 1)
      .map((row) => row.teamName);

  const addButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={ADD_MODAL}
      command="--show"
    >
      Add member
    </s-button>
  );

  const teamsCell = (member: Domain.Member) => {
    const memberTeamRows = teamsOf(member);
    if (memberTeamRows.length === 0)
      return <s-badge tone="warning">No teams</s-badge>;
    const shown = memberTeamRows.slice(0, MAX_CHIPS);
    const overflow = memberTeamRows.length - shown.length;
    return (
      <s-stack direction="inline" gap="small-300" alignItems="center">
        {shown.map((row) => (
          <s-chip key={row.teamId}>{row.teamName}</s-chip>
        ))}
        {overflow > 0 && (
          <s-text color="subdued">{`+${String(overflow)}`}</s-text>
        )}
      </s-stack>
    );
  };

  const renderRows = () => {
    if (members.length === 0)
      return (
        <s-box padding="base">
          <s-stack gap="base" alignItems="start">
            <s-paragraph color="subdued">
              No members yet. Add an email to grant access.
            </s-paragraph>
            {addButton(false)}
          </s-stack>
        </s-box>
      );
    if (rows.length === 0)
      return (
        <s-box padding="base">
          <s-stack gap="base" alignItems="start">
            <s-paragraph color="subdued">No members match.</s-paragraph>
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
          <s-table-header listSlot="primary">Email</s-table-header>
          <s-table-header>Teams</s-table-header>
          <s-table-header>Added</s-table-header>
          <s-table-header> </s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((member) => (
            <s-table-row key={member.id} id={member.id}>
              <s-table-cell>
                <s-text>{member.email}</s-text>
              </s-table-cell>
              <s-table-cell>{teamsCell(member)}</s-table-cell>
              <s-table-cell>
                <LocalDateTime value={member.createdAt} />
              </s-table-cell>
              <s-table-cell>
                <s-stack direction="inline" gap="small-300">
                  <s-button
                    variant="tertiary"
                    onClick={() => {
                      setEditing(member);
                      setEditingTeamIds(teamsOf(member).map((r) => r.teamId));
                      void shopify.modal.show(EDIT_TEAMS_MODAL);
                    }}
                  >
                    Edit teams
                  </s-button>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    onClick={() => {
                      setRemoving(member);
                      void shopify.modal.show(REMOVE_MODAL);
                    }}
                  >
                    Remove
                  </s-button>
                </s-stack>
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  const removingEmptied = removing === null ? [] : emptiedTeams(removing);

  return (
    <s-page heading="Members" inlineSize="large">
      <SocketBanner />
      {members.length > 0 && addButton(true)}

      {mutationError && <s-banner tone="critical">{mutationError}</s-banner>}

      {/* `padding="none"` so the table runs edge to edge; the description
          goes inside a padded intro box instead of a slotted heading. */}
      <s-section padding="none" accessibilityLabel="Members">
        <s-box padding="base" paddingBlockEnd="none">
          <s-paragraph color="subdued">
            Members sign in with their email on the member area. Put each one on
            a team, or they have nothing to do.
          </s-paragraph>
        </s-box>

        {members.length > 0 && (
          <s-box padding="base">
            <s-stack gap="small-300">
              <s-search-field
                label="Search members by email"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by email"
                value={query}
                onInput={(event) => {
                  setQuery(event.currentTarget.value);
                }}
              />
              {trimmed !== "" && (
                <s-paragraph color="subdued">
                  {`Showing ${String(rows.length)} of ${String(members.length)} members.`}
                </s-paragraph>
              )}
            </s-stack>
          </s-box>
        )}

        {renderRows()}
      </s-section>

      <s-modal
        id={ADD_MODAL}
        heading="Add member"
        onShow={() => {
          form.reset();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <s-stack gap="base">
            <form.Field name="email">
              {(field) => (
                <s-email-field
                  label="Email"
                  name={field.name}
                  details="They'll sign in with this email on the member area. No Shopify account needed."
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
            <form.Field name="teamIds">
              {(field) => (
                <MemberTeamsFields
                  teams={teams}
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </form.Field>
          </s-stack>
        </form>
        <s-button
          slot="secondary-actions"
          commandFor={ADD_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={addMutation.isPending}
          onClick={() => {
            void form.handleSubmit();
          }}
        >
          Add
        </s-button>
      </s-modal>

      <s-modal
        id={EDIT_TEAMS_MODAL}
        heading={editing === null ? "Teams" : `Teams for ${editing.email}`}
      >
        <MemberTeamsFields
          teams={teams}
          value={editingTeamIds}
          onChange={setEditingTeamIds}
        />
        <s-button
          slot="secondary-actions"
          commandFor={EDIT_TEAMS_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={editMutation.isPending}
          disabled={editing === null}
          onClick={() => {
            if (editing !== null)
              editMutation.mutate({
                memberId: editing.id,
                teamIds: editingTeamIds,
              });
          }}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal
        id={REMOVE_MODAL}
        heading={
          removing === null ? "Remove member?" : `Remove ${removing.email}?`
        }
      >
        <s-paragraph>
          {removingEmptied.length > 0
            ? `They leave their teams and can no longer sign in. This will leave ${removingEmptied.join(", ")} with no members.`
            : "They leave their teams and can no longer sign in. Their past work stays on the record."}
        </s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={REMOVE_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={deleteMutation.isPending}
          disabled={removing === null}
          onClick={() => {
            if (removing !== null) deleteMutation.mutate(removing.email);
          }}
        >
          Remove
        </s-button>
      </s-modal>
    </s-page>
  );
}
