import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Option, Schema } from "effect";

import { LocalDateTime } from "@/components/LocalDateTime";
import { UsedByCard } from "@/components/UsedByCard";
import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { useShopAgent, withSocketRecovery } from "@/lib/ShopAgentContext";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import {
  decodeDeleteTeamResult,
  decodeName,
  deleteTeamResultMessage,
  deleteTeamWarning,
  failWith,
  NAME_TAKEN,
  NO_COUNTS,
  sessionShop,
  TEAM_GONE,
} from "@/lib/teams";

const RENAME_MODAL = "rename-team";
const DELETE_MODAL = "delete-team";
const REMOVE_MODAL = "remove-team-member";
const NO_CANDIDATES_MODAL = "no-team-candidates";

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

const AddTeamMembersInput = Schema.Struct({
  teamId: Schema.String,
  memberIds: Schema.Array(Schema.String),
});

const decodeTeamId = Schema.decodeUnknownEffect(Domain.TeamId);
const decodeMemberId = Schema.decodeUnknownEffect(Domain.MemberId);
const decodeMemberIds = Schema.decodeUnknownEffect(
  Schema.Array(Domain.MemberId),
);

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(TeamIdInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const repository = yield* Repository;
        const detail = yield* repository.findTeamDetail({
          shop,
          id: yield* decodeTeamId(data.teamId),
        });
        if (Option.isNone(detail)) return yield* Effect.fail(notFound());
        const memberTeams = yield* repository.listMemberTeams(shop);
        const client = yield* ShopAgentClient;
        const ownedSteps = yield* client.listStepsOwnedBy(shop, {
          teamId: detail.value.team.id,
        });
        const stepCounts =
          (yield* client.countStepsByTeam(shop)).find(
            (row) => row.teamId === detail.value.team.id,
          ) ?? NO_COUNTS;
        return {
          ...detail.value,
          memberTeams,
          ownedSteps,
          stepCounts,
        } satisfies Domain.TeamLoaderData;
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

const addTeamMembersFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(AddTeamMembersInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        yield* (yield* Repository).addTeamMembers({
          shop: yield* sessionShop(session.shop),
          teamId: yield* decodeTeamId(data.teamId),
          memberIds: yield* decodeMemberIds(data.memberIds),
        });
      }).pipe(Effect.catchTag("TeamNotFoundError", failWith(TEAM_GONE))),
    ),
  );

/**
 * Polaris' empty-state composition without the illustration: a heading, one
 * sentence, one action, centered with block padding. An empty team is a state
 * to explain, not a footnote, and centering is what keeps it from reading as a
 * stray line in a box.
 */
const emptyState = (heading: string, body: string, action: React.ReactNode) => (
  <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
    <s-grid justifyItems="center" maxInlineSize="380px" gap="base">
      <s-stack alignItems="center" gap="small-300">
        <s-heading>{heading}</s-heading>
        <s-paragraph color="subdued">{body}</s-paragraph>
      </s-stack>
      {action}
    </s-grid>
  </s-grid>
);

export const Route = createFileRoute("/app/teams/$teamId")({
  loader: ({ params }) => getLoaderData({ data: { teamId: params.teamId } }),
  component: RouteComponent,
});

/**
 * The team page is about people: its members are the one table, adding is the
 * primary action, and the workflows that use the team are a link list rather
 * than a step table above the roster (steps are edited on the workflow pages).
 * Rename and delete live behind More actions, as on the workflow page.
 *
 * Laid out as Polaris' details template, like the order and workflow detail
 * pages: the roster owns the main column under its own heading, and the
 * reference material a merchant checks before renaming or deleting — where the
 * team is used, when it was made — sits in aside cards. That keeps `s-page`'s
 * children sections, which is the only thing it lays out, so nothing floats on
 * the page background. `inlineSize` must stay "base": `s-page` drops the aside
 * slot entirely at "large".
 */
function RouteComponent() {
  const { team, members, memberTeams, ownedSteps, stepCounts } =
    Route.useLoaderData();
  const router = useRouter();
  const shopify = useAppBridge();
  const renameTeam = useServerFn(renameTeamFn);
  const setTeamMember = useServerFn(setTeamMemberFn);
  const addTeamMembers = useServerFn(addTeamMembersFn);
  const { agent, identified } = useShopAgent();
  const [deleteBanner, setDeleteBanner] = React.useState<string | null>(null);
  const [nameError, setNameError] = React.useState<string | null>(null);
  /** Which member the Remove dialog is about; one modal serves every row. */
  const [removing, setRemoving] = React.useState<Domain.MemberId | null>(null);

  const current = members.filter((member) => member.inTeam);
  const candidates = members.filter((member) => !member.inTeam);
  const removingMember = current.find((member) => member.id === removing);

  const renameMutation = useMutation({
    mutationFn: (name: string) =>
      renameTeam({ data: { teamId: team.id, name } }),
    onSuccess: async () => {
      await shopify.modal.hide(RENAME_MODAL);
      await router.invalidate({ sync: true });
    },
    onError: (error: Error) => {
      const message = mutationErrorMessage(error, "Could not rename the team.");
      if (message === NAME_TAKEN) setNameError(message);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      setTeamMember({ data: { teamId: team.id, memberId, inTeam: false } }),
    onSuccess: async () => {
      await shopify.modal.hide(REMOVE_MODAL);
      setRemoving(null);
      await router.invalidate({ sync: true });
    },
  });

  const addMutation = useMutation({
    mutationFn: (memberIds: readonly string[]) =>
      addTeamMembers({ data: { teamId: team.id, memberIds: [...memberIds] } }),
    onSuccess: () => router.invalidate({ sync: true }),
  });

  /**
   * Delete goes through the Durable Object: it deletes the D1 row and then
   * nulls every step pointer in the object's SQLite, in that order, so a step
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

  const renameError = renameMutation.isError
    ? mutationErrorMessage(renameMutation.error, "Could not rename the team.")
    : null;
  const failedMutation = [
    { mutation: addMutation, fallback: "Could not add members." },
    { mutation: removeMutation, fallback: "Could not remove the member." },
    { mutation: deleteMutation, fallback: "Could not delete the team." },
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

  const otherTeams = (memberId: Domain.MemberId) =>
    memberTeams
      .filter((row) => row.memberId === memberId)
      .map((row) => row.teamName);

  /**
   * App Bridge's Picker API: the platform's own "choose from my app's data"
   * dialog, with native search and multi-select, rendered by the admin host
   * outside this iframe. It lists only members not yet on the team; the
   * empty cases (no members in the shop, or everyone already here) open a
   * small modal that points at the Members page instead, since the picker
   * cannot add a brand-new email.
   */
  const pickMembers = async () => {
    if (candidates.length === 0) {
      await shopify.modal.show(NO_CANDIDATES_MODAL);
      return;
    }
    const picker = await shopify.picker({
      heading: `Add members to ${team.name}`,
      multiple: true,
      headers: [{ content: "Member" }, { content: "Other teams" }],
      items: candidates.map((member) => {
        const names = otherTeams(member.id);
        return {
          id: member.id,
          heading: member.email,
          data: [names.length === 0 ? "No teams" : names.join(", ")],
        };
      }),
    });
    const selected = await picker.selected;
    if (selected !== undefined && selected.length > 0)
      addMutation.mutate(selected);
  };

  const addButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      loading={addMutation.isPending}
      onClick={() => {
        void pickMembers();
      }}
    >
      Add members
    </s-button>
  );

  const renderMembers = () => {
    if (members.length === 0)
      return emptyState(
        "No members yet",
        "This shop has no members yet. Add them once, then put them on teams.",
        <s-button href="/app/members">Add members</s-button>,
      );
    if (current.length === 0)
      return emptyState(
        "No members yet",
        "Nobody is on this team, so its steps sit unclaimed until someone joins.",
        addButton(false),
      );
    return (
      /* Bordered box around the table, as Polaris' details template does: the
         section keeps its own padding (a `padding="none"` section loses the
         inset on its heading too), so the table needs its own frame to stop
         floating inside the card. */
      <s-box border="base" borderRadius="base" overflow="hidden">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Member</s-table-header>
            <s-table-header>On team since</s-table-header>
            <s-table-header>
              <s-stack alignItems="end">Actions</s-stack>
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {current.map((member) => (
              <s-table-row key={member.id} id={member.id}>
                <s-table-cell>
                  <s-text>{member.email}</s-text>
                </s-table-cell>
                <s-table-cell>
                  {member.inTeamSince !== null && (
                    <LocalDateTime value={member.inTeamSince} />
                  )}
                </s-table-cell>
                <s-table-cell>
                  <s-stack alignItems="end">
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      disabled={removeMutation.isPending}
                      onClick={() => {
                        setRemoving(member.id);
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
      </s-box>
    );
  };

  return (
    <s-page heading={team.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/teams">
        Teams
      </s-link>
      {current.length === 0 && (
        <s-badge slot="accessory" tone="warning">
          No members
        </s-badge>
      )}
      {addButton(true)}
      <s-button slot="secondary-actions" commandFor="team-actions">
        More actions
      </s-button>
      <s-menu id="team-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_MODAL} command="--show">
          Rename
        </s-button>
        <s-button
          icon="delete"
          tone="critical"
          commandFor={DELETE_MODAL}
          command="--show"
        >
          Delete
        </s-button>
      </s-menu>

      <SocketBanner />

      <s-section heading="Members" accessibilityLabel="Team members">
        <s-stack gap="base">
          {mutationError && (
            <s-banner tone="critical">{mutationError}</s-banner>
          )}
          {deleteBanner !== null && (
            <s-banner tone="warning">{deleteBanner}</s-banner>
          )}
          {renderMembers()}
        </s-stack>
      </s-section>

      <UsedByCard steps={ownedSteps} />

      <s-section slot="aside" heading="Details" accessibilityLabel="Details">
        <s-grid
          gridTemplateColumns="max-content 1fr"
          gap="small-200 base"
          alignItems="center"
        >
          <s-text color="subdued">Members</s-text>
          <s-text>{String(current.length)}</s-text>
          <s-text color="subdued">Created</s-text>
          <s-text>
            <LocalDateTime value={team.createdAt} />
          </s-text>
        </s-grid>
      </s-section>

      <s-modal
        id={RENAME_MODAL}
        heading="Rename team"
        onShow={() => {
          form.reset({ name: team.name });
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
          commandFor={RENAME_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={renameMutation.isPending}
          onClick={() => {
            void form.handleSubmit();
          }}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal id={DELETE_MODAL} heading={`Delete ${team.name}?`}>
        <s-paragraph>{deleteTeamWarning(stepCounts)}</s-paragraph>
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
          Delete
        </s-button>
      </s-modal>

      <s-modal
        id={REMOVE_MODAL}
        heading={
          removingMember === undefined
            ? "Remove member?"
            : `Remove ${removingMember.email}?`
        }
      >
        {removingMember !== undefined && (
          <s-paragraph>
            {`Remove ${removingMember.email} from ${team.name}? They keep access to the shop and their other teams.`}
            {current.length === 1 && ` ${team.name} will have no members.`}
          </s-paragraph>
        )}
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
          loading={removeMutation.isPending}
          disabled={removingMember === undefined}
          onClick={() => {
            if (removingMember !== undefined)
              removeMutation.mutate(removingMember.id);
          }}
        >
          Remove
        </s-button>
      </s-modal>

      <s-modal id={NO_CANDIDATES_MODAL} heading="Add members">
        <s-paragraph>
          {members.length === 0
            ? "This shop has no members yet."
            : "Everyone is already on this team."}
        </s-paragraph>
        <s-button
          slot="secondary-actions"
          commandFor={NO_CANDIDATES_MODAL}
          command="--hide"
        >
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" href="/app/members">
          Go to Members
        </s-button>
      </s-modal>
    </s-page>
  );
}
