import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Option, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { ManagePlanButton } from "@/components/ManagePlanButton";
import { MemberTeamsFields } from "@/components/MemberTeamsFields";
import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { formatNumber } from "@/lib/format";
import { Repository, RepositoryError } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { resolveEntitlements } from "@/lib/SubscriptionPlan";
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
const memberLimitMessage = (limit: number) =>
  `Your plan allows ${formatNumber(limit)} ${limit === 1 ? "member" : "members"}. Upgrade to add more.`;

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
          maxMembers: (yield* resolveEntitlements(shop)).maxMembers,
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
        const { maxMembers } = yield* resolveEntitlements(shop);
        yield* repository.addMember({ shop, email, limit: maxMembers });
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
      }).pipe(
        Effect.catchTag("MemberLimitError", ({ limit }) =>
          Effect.fail(new Error(memberLimitMessage(limit))),
        ),
      ),
    ),
  );

/**
 * Replacing a member's team set changes what their open socket may act on, so
 * it revokes their connections for the same reason the team page's roster
 * edits do: identity on a connection is a connect-time snapshot, and a
 * reconnect is what re-reads it.
 */
const setMemberTeamsFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MemberTeamsInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const memberId = yield* decodeMemberId(data.memberId);
        yield* (yield* Repository).setMemberTeams({
          shop,
          memberId,
          teamIds: yield* decodeTeamIds(data.teamIds),
        });
        yield* (yield* ShopAgentClient).revokeMemberConnections(shop, {
          memberIds: [memberId],
        });
      }),
    ),
  );

/**
 * Delete a member and they leave their teams (vocabulary on `Domain.Member`).
 * There is no second store to clean — a member owns nothing in the Durable
 * Object, since run steps snapshot the actor's email — but there may be a live
 * socket carrying the membership this delete just removed, so the object is
 * told to close it. Without that, a member deleted mid-shift keeps working
 * until their connection next drops; the page guards catch them on the next
 * navigation either way, but the socket is the faster path.
 */
const deleteMemberFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MemberEmailInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const repository = yield* Repository;
        const shop = yield* sessionShop(session.shop);
        const memberId = yield* repository.deleteMember({
          shop,
          email: yield* decodeEmail(data.email),
        });
        yield* (yield* ShopAgentClient).revokeMemberConnections(shop, {
          memberIds: [memberId],
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
  const { members, teams, memberTeams, maxMembers } = Route.useLoaderData();
  const { managePlanUrl } = Route.useRouteContext();
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

  /**
   * Who holds no seat, by `Domain.memberHasSeat`. `members` arrives ordered
   * `createdAt, email` — the order that rule ranks by — so the cutoff is the
   * row index and no per-row flag has to cross the wire. Computed against the
   * unfiltered list, because the search box must not change who has a seat.
   */
  const seatless = new Set(
    members
      .filter((_, index) => !Domain.memberHasSeat(index, maxMembers))
      .map((member) => member.id),
  );

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
          <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
            <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
              <s-stack alignItems="center" gap="small-300">
                <s-heading>No members yet</s-heading>
                <s-paragraph color="subdued">
                  Add an email to grant access. Members sign in with it on the
                  member area; put each one on a team, or they have nothing to
                  do.
                </s-paragraph>
              </s-stack>
              {addButton(false)}
            </s-grid>
          </s-grid>
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
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text>{member.email}</s-text>
                  {seatless.has(member.id) && (
                    <s-badge tone="critical">No seat</s-badge>
                  )}
                </s-stack>
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
      {/* Unconditional, empty list included: the resource-index template keeps
          the title-bar primary action and lets the empty state carry a second
          copy, so "add is top right" holds on the visit where it matters most.
          App Bridge hoists this one out of the iframe, so the in-card twin is
          not a duplicate in the frame's DOM — frame- and page-scoped e2e
          locators stay disjoint.
          https://shopify.dev/docs/api/app-home/latest/patterns/templates/resource-index */}
      {addButton(true)}

      {mutationError && <s-banner tone="critical">{mutationError}</s-banner>}

      {/* The seat rule, stated where the merchant can act on it: Remove is on
          every row, and Manage plan is the other way out. Nothing was taken
          away from anybody — the seats simply belong to the oldest members
          while the plan says so. */}
      {seatless.size > 0 && (
        <s-banner tone="critical">
          {`Your plan includes ${formatNumber(maxMembers)} members. Only the ${formatNumber(maxMembers)} oldest can sign in until you remove members or upgrade.`}
          <ManagePlanButton url={managePlanUrl} />
        </s-banner>
      )}

      {/* `padding="none"` so the table runs edge to edge; the description
          goes inside a padded intro box instead of a slotted heading. */}
      <s-section padding="none" accessibilityLabel="Members">
        {/* Only with rows: on empty the centred empty state carries this same
            sentence, so showing both said it twice. */}
        {members.length > 0 && (
          <s-box padding="base" paddingBlockEnd="none">
            <s-paragraph color="subdued">
              Members sign in with their email on the member area. Put each one
              on a team, or they have nothing to do.
            </s-paragraph>
          </s-box>
        )}

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
        /* Reset on the way out, not on the way in: `show` can fire after the
           field has already taken input, and a reset there wipes what was
           typed, so Add submits an empty email. */
        onAfterHide={() => {
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
