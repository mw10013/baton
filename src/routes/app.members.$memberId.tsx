import * as React from "react";

import { useAppBridge } from "@shopify/app-bridge-react";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
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
import { Things } from "@/components/screen/Things";
import { Token } from "@/components/screen/Token";
import * as Domain from "@/lib/Domain";
import { mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { lenientSearchKey } from "@/lib/searchParams";
import { ShopAgentClient } from "@/lib/ShopAgentClient";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useNextPageEntry } from "@/lib/tablePages";
import {
  DELETE_CONFIRM,
  DELETED_TOAST,
  DETAILS_PAGE_SIZE,
  failWith,
  SEARCH_FROM,
  sessionShop,
} from "@/lib/teams";

const ADD_MODAL = "add-member-teams";
const DELETE_MODAL = "delete-member";

const MEMBER_GONE = "That member no longer exists.";

/**
 * The member page's URL: `teamsAfter` is the last team name of the Teams
 * table's page before (`Repository.findMemberDetail`), lenient for the
 * reason on `OrdersSearch` (`app.orders.tsx`).
 */
const MemberSearch = Schema.Struct({
  teamsAfter: lenientSearchKey(Domain.TeamName),
});

const MemberLoaderInput = Schema.Struct({
  memberId: Schema.String,
  teamsAfter: Schema.NullOr(Domain.TeamName),
});

const MemberTeamInput = Schema.Struct({
  memberId: Schema.String,
  teamId: Schema.String,
});

const AddMemberTeamsInput = Schema.Struct({
  memberId: Schema.String,
  teamIds: Schema.Array(Schema.String),
});

const MemberEmailInput = Schema.Struct({ email: Schema.String });

const decodeEmail = Schema.decodeUnknownEffect(Domain.Email);
const decodeMemberId = Schema.decodeUnknownEffect(Domain.MemberId);
const decodeTeamId = Schema.decodeUnknownEffect(Domain.TeamId);
const decodeTeamIds = Schema.decodeUnknownEffect(Schema.Array(Domain.TeamId));

/** `null` is not found, as on the workflow page. */
type MemberLoaderData = Domain.MemberDetail | null;

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(MemberLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const detail = yield* (yield* Repository).findMemberDetail({
          shop: yield* sessionShop(session.shop),
          id: yield* decodeMemberId(data.memberId),
          teamsAfter: data.teamsAfter,
          limit: DETAILS_PAGE_SIZE,
        });
        return Option.getOrNull(detail) satisfies MemberLoaderData;
      }).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(null))),
    ),
  );

/**
 * Every write here changes what the member may act on, and a signed-in
 * member holds a socket whose `teamIds` were resolved when it connected
 * (`Domain.ConnectionState`), so each ends by revoking the member's
 * connections, as the team page's member writes do: they reconnect through
 * the Worker's gate with the teams this write left them.
 */
const removeFromTeamFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MemberTeamInput))
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
          inTeam: false,
        });
        yield* (yield* ShopAgentClient).revokeMemberConnections(shop, {
          memberIds: [memberId],
        });
      }),
    ),
  );

const addMemberTeamsFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(AddMemberTeamsInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const memberId = yield* decodeMemberId(data.memberId);
        yield* (yield* Repository).addMemberTeams({
          shop,
          memberId,
          teamIds: yield* decodeTeamIds(data.teamIds),
        });
        yield* (yield* ShopAgentClient).revokeMemberConnections(shop, {
          memberIds: [memberId],
        });
      }).pipe(Effect.catchTag("MemberNotFoundError", failWith(MEMBER_GONE))),
    ),
  );

/**
 * Delete a member and they leave their teams (vocabulary on `Domain.Member`).
 * There is no second store to clean — a member owns nothing in the Durable
 * Object, since run tasks snapshot the actor's email — but there may be a live
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
        const shop = yield* sessionShop(session.shop);
        const memberId = yield* (yield* Repository).deleteMember({
          shop,
          email: yield* decodeEmail(data.email),
        });
        yield* (yield* ShopAgentClient).revokeMemberConnections(shop, {
          memberIds: [memberId],
        });
      }).pipe(Effect.catchTag("MemberNotFoundError", failWith(MEMBER_GONE))),
    ),
  );

export const Route = createFileRoute("/app/members/$memberId")({
  validateSearch: Schema.toStandardSchemaV1(MemberSearch),
  loaderDeps: ({ search }) => ({ teamsAfter: search.teamsAfter ?? null }),
  loader: ({ params, deps }) =>
    getLoaderData({
      data: { memberId: params.memberId, teamsAfter: deps.teamsAfter },
    }),
  component: RouteComponent,
});

/**
 * The member page, the mirror of the team page: the member's teams are the
 * one table, Add to teams is the primary action, and Remove on a row takes
 * them off that team with no modal, since Add to teams puts them back on
 * this screen. Delete is the one other action, a secondary button rather
 * than a More actions menu of one entry.
 *
 * Headed by the email, as a Shopify customer page is headed by the name: a
 * title bar cuts a long one, so the Details card prints it whole as its
 * first row (the token row of the parts table on `ScreenPart`). The Delete
 * modal is headed "Delete member?" and names the email in its body, the
 * heading row of the copy table on `CopySlot`.
 *
 * Laid out as the team page is, on Polaris' details template; `inlineSize`
 * stays "base" because `s-page` drops the aside slot at "large".
 */
function RouteComponent() {
  const detail: MemberLoaderData = Route.useLoaderData();
  const { teamsAfter } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const nextPageEntry = useNextPageEntry("teamsAfter");
  const shopify = useAppBridge();
  const removeFromTeam = useServerFn(removeFromTeamFn);
  const addMemberTeams = useServerFn(addMemberTeamsFn);
  const deleteMember = useServerFn(deleteMemberFn);
  const [addQuery, setAddQuery] = React.useState("");
  const [selected, setSelected] = React.useState<readonly string[]>([]);

  const memberId = detail?.member.id ?? "";

  const removeMutation = useMutation({
    mutationFn: (teamId: string) =>
      removeFromTeam({ data: { memberId, teamId } }),
    onSuccess: () => router.invalidate({ sync: true }),
  });

  const addMutation = useMutation({
    mutationFn: (teamIds: readonly string[]) =>
      addMemberTeams({ data: { memberId, teamIds: [...teamIds] } }),
    onSuccess: async () => {
      await shopify.modal.hide(ADD_MODAL);
      setSelected([]);
      await router.invalidate({ sync: true });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      deleteMember({ data: { email: detail?.member.email ?? "" } }),
    onSuccess: async () => {
      await shopify.modal.hide(DELETE_MODAL);
      /* Toast, then navigate, as the workflow page does: the admin's toast
         outlives the page. */
      shopify.toast.show(DELETED_TOAST.member);
      await navigate({ to: "/app/members" });
    },
  });

  if (detail === null)
    return (
      <s-page heading="Member not found">
        <s-link slot="breadcrumb-actions" href="/app/members">
          Members
        </s-link>
        <s-paragraph color="subdued">{MEMBER_GONE}</s-paragraph>
      </s-page>
    );

  const { member, teams, teamCount, nextCursor, candidates } = detail;

  const failedMutation = [
    { mutation: addMutation, fallback: "Couldn't add to teams." },
    { mutation: removeMutation, fallback: "Couldn't remove from the team." },
    { mutation: deleteMutation, fallback: "Couldn't delete the member." },
  ].find(({ mutation }) => mutation.isError);
  const mutationError =
    failedMutation &&
    mutationErrorMessage(
      failedMutation.mutation.error,
      failedMutation.fallback,
    );

  const nextPage = (cursor: Domain.TeamName) => {
    void navigate({
      search: (prev) => ({ ...prev, teamsAfter: cursor }),
      state: { nextPageOf: "teamsAfter" },
    });
  };
  const previousPage = () => {
    if (nextPageEntry) {
      router.history.back();
      return;
    }
    void navigate({
      search: (prev) => ({ ...prev, teamsAfter: undefined }),
      replace: true,
    });
  };

  const addTrimmed = addQuery.trim().toLowerCase();
  const matches =
    addTrimmed === ""
      ? candidates
      : candidates.filter((team) =>
          team.name.toLowerCase().includes(addTrimmed),
        );

  /** The team page's `changeSelected`, for the same reason: ticks survive a search. */
  const changeSelected = (values: readonly string[]) => {
    const rendered = new Set<string>(matches.map((team) => team.id));
    setSelected([...selected.filter((id) => !rendered.has(id)), ...values]);
  };

  const addButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={ADD_MODAL}
      command="--show"
    >
      {`${Domain.RECORD_VERB_LABEL.add} to teams`}
    </s-button>
  );

  /** No team at all in the shop, which only page one can tell. */
  const shopHasNoTeams =
    teamCount === 0 && candidates.length === 0 && teamsAfter === undefined;

  const renderTeams = () => {
    if (shopHasNoTeams)
      return (
        <EmptyLine
          heading="No teams yet"
          action={<s-button href="/app/teams">Go to Teams</s-button>}
        >
          This store has no teams yet. Create one on Teams, then add this
          member.
        </EmptyLine>
      );
    if (teamCount === 0)
      return (
        <EmptyLine heading="Not on a team yet" action={addButton(false)}>
          A member with no team has nothing to do.
        </EmptyLine>
      );
    return (
      /* Framed inside the card ({@link TableFrame}). */
      <TableFrame>
        <s-table
          paginate={teamsAfter !== undefined || nextCursor !== null}
          hasPreviousPage={teamsAfter !== undefined}
          hasNextPage={nextCursor !== null}
          onPreviousPage={previousPage}
          onNextPage={() => {
            if (nextCursor !== null) nextPage(nextCursor);
          }}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Team</s-table-header>
            <s-table-header>On team since</s-table-header>
            <s-table-header>
              <End>Actions</End>
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {teams.map((team) => (
              <s-table-row key={team.id} id={team.id}>
                <s-table-cell>
                  <s-link href={`/app/teams/${team.id}`}>{team.name}</s-link>
                </s-table-cell>
                <s-table-cell>
                  <LocalDateTime value={team.inTeamSince} />
                </s-table-cell>
                <s-table-cell>
                  <End>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      disabled={removeMutation.isPending}
                      onClick={() => {
                        removeMutation.mutate(team.id);
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

  return (
    <s-page heading={member.email} inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app/members">
        Members
      </s-link>
      {addButton(true)}
      <s-button
        slot="secondary-actions"
        tone="critical"
        commandFor={DELETE_MODAL}
        command="--show"
      >
        {Domain.RECORD_VERB_LABEL.delete}
      </s-button>

      <SocketBanner />

      <s-section heading="Teams">
        <Things>
          {mutationError && (
            <s-banner tone="critical">{mutationError}</s-banner>
          )}
          {renderTeams()}
        </Things>
      </s-section>

      <s-section slot="aside" heading="Details" accessibilityLabel="Details">
        <Pairs
          pairs={[
            {
              key: "email",
              label: "Email",
              value: <Token>{member.email}</Token>,
            },
            {
              key: "created",
              label: "Created",
              value: <LocalDateTime value={member.createdAt} />,
            },
          ]}
        />
      </s-section>

      <s-modal id={DELETE_MODAL} heading="Delete member?">
        <s-paragraph>
          Delete <Token>{member.email}</Token>? {DELETE_CONFIRM}
        </s-paragraph>
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
          onClick={() => {
            deleteMutation.mutate();
          }}
        >
          {Domain.RECORD_VERB_LABEL.delete}
        </s-button>
      </s-modal>

      {/* The team page's Add members dialog, mirrored: candidates only, a
          search from SEARCH_FROM of them, ticks kept across searches. */}
      <s-modal
        id={ADD_MODAL}
        heading="Add to teams"
        /* Cleared on the way out, not on the way in: `show` can fire after a
           search was typed or a box checked, and clearing there loses it. */
        onAfterHide={() => {
          setAddQuery("");
          setSelected([]);
        }}
      >
        {candidates.length === 0 ? (
          <s-paragraph>
            {teamCount === 0
              ? "This store has no teams yet. Create one on Teams, then add this member."
              : "This member is on every team."}
          </s-paragraph>
        ) : (
          <Things>
            {candidates.length >= SEARCH_FROM && (
              <s-search-field
                label="Search teams by name"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search by name"
                value={addQuery}
                onInput={(event) => {
                  setAddQuery(event.currentTarget.value);
                }}
              />
            )}
            {matches.length === 0 ? (
              <s-paragraph color="subdued">No teams match.</s-paragraph>
            ) : (
              <s-choice-list
                label="Teams"
                labelAccessibilityVisibility="exclusive"
                name="teamIds"
                multiple
                values={[...selected]}
                onChange={(event) => {
                  changeSelected([...event.currentTarget.values]);
                }}
              >
                {matches.map((team) => (
                  <s-choice key={team.id} value={team.id}>
                    {team.name}
                    {team.memberCount === 0 && (
                      <s-text slot="details">No members</s-text>
                    )}
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
        {candidates.length === 0 ? (
          <s-button slot="primary-action" variant="primary" href="/app/teams">
            Go to Teams
          </s-button>
        ) : (
          <s-button
            slot="primary-action"
            variant="primary"
            loading={addMutation.isPending}
            disabled={selected.length === 0}
            onClick={() => {
              addMutation.mutate(selected);
            }}
          >
            {selected.length === 0 ? "Add" : `Add ${String(selected.length)}`}
          </s-button>
        )}
      </s-modal>
    </s-page>
  );
}
