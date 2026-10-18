import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type ReactNode, useState } from "react";
import {
  type MemberDetail,
  type MemberId,
  RECORD_VERB_LABEL,
  type TeamId,
  type TeamName,
} from "../../domain/shop-work.ts";
import { hideModal, toast } from "../client/app-bridge.ts";
import {
  addMemberTeamsAtom,
  deleteMemberAtom,
  setTeamMemberAtom,
} from "../client/shop-actor-client.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import type { PageLink } from "./MembersIndexPage.tsx";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { End } from "./screen/End.tsx";
import { Pairs } from "./screen/Pairs.tsx";
import { TableFrame } from "./screen/TableFrame.tsx";
import { Things } from "./screen/Things.tsx";
import { Token } from "./screen/Token.tsx";
import {
  DELETE_CONFIRM,
  DELETED_TOAST,
  MEMBER_GONE,
  pressFailureCopy,
  SEARCH_FROM,
} from "./teams.ts";

export const ADD_TEAMS_MODAL = "add-member-teams";
export const DELETE_MEMBER_MODAL = "delete-member";

/** {@link MemberPage}'s props: the loader's detail and the route's navigation. */
export interface MemberPageProps {
  /** `null` is no such member in this shop. */
  readonly detail: MemberDetail | null;
  /** The Teams table's page cursor in the URL, `null` when absent. */
  readonly teamsAfter: TeamName | null;
  /**
   * The breadcrumb to the members index. App Bridge hoists it into the title bar and hands its
   * click to the `/app` layout's `shopify:navigate` bridge only while its `href` is a bare path;
   * an `href` with a search reloads the frame. The bridge adds the search.
   */
  readonly membersLink: PageLink;
  readonly teamsLink: PageLink;
  readonly teamLink: (id: TeamId) => PageLink;
  readonly onNextPage: (cursor: TeamName) => void;
  readonly onPreviousPage: () => void;
  /** After a write: re-read the loader. */
  readonly onChanged: () => Promise<void>;
  /** After Delete member: back to the members index. */
  readonly onDeleted: () => Promise<void>;
}

/** A press's answer to the screen: `null` when it wrote, else the banner's sentence. */
type Press<A> = (input: A) => Promise<string | null>;

interface Presses {
  readonly adding: boolean;
  readonly deleting: boolean;
  readonly addTeams: Press<ReadonlyArray<TeamId>>;
  readonly deleteMember: Press<void>;
  readonly removeButton: (team: { readonly id: TeamId }) => ReactNode;
  /** The last row Remove's failure, beside the screen's own presses'. */
  readonly removeFailure: string | null;
}

/** A team row's Remove, before hydration or while its own press runs. */
function RemoveButton({
  loading,
  onClick,
}: {
  readonly loading: boolean;
  readonly onClick: () => void;
}) {
  return (
    <s-button variant="tertiary" tone="critical" loading={loading} onClick={onClick}>
      {RECORD_VERB_LABEL.remove}
    </s-button>
  );
}

function MemberScreen(
  props: MemberPageProps & { readonly detail: MemberDetail; readonly presses: Presses },
) {
  const { member, teams, teamCount, nextCursor, candidates } = props.detail;
  const { presses, teamsAfter } = props;
  const [banner, setBanner] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);

  const addTrimmed = addQuery.trim().toLowerCase();
  const matches =
    addTrimmed === ""
      ? candidates
      : candidates.filter((team) => team.name.toLowerCase().includes(addTrimmed));

  /** Ticks survive a search: a box not rendered under the current search keeps its tick. */
  const changeSelected = (values: ReadonlyArray<string>) => {
    const rendered = new Set<string>(matches.map((team) => team.id));
    setSelected([...selected.filter((id) => !rendered.has(id)), ...values]);
  };

  const addButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={ADD_TEAMS_MODAL}
      command="--show"
    >
      {`${RECORD_VERB_LABEL.add} to teams`}
    </s-button>
  );

  const renderTeams = () => {
    if (teamCount === 0)
      return (
        <EmptyLine heading="Not on a team yet" action={addButton(false)}>
          A member with no team has nothing to do.
        </EmptyLine>
      );
    return (
      <TableFrame>
        <s-table
          paginate={teamsAfter !== null || nextCursor !== null}
          hasPreviousPage={teamsAfter !== null}
          hasNextPage={nextCursor !== null}
          onPreviousPage={props.onPreviousPage}
          onNextPage={() => {
            if (nextCursor !== null) props.onNextPage(nextCursor);
          }}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Team</s-table-header>
            <s-table-header>
              <End>Actions</End>
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {teams.map((team) => (
              <s-table-row key={team.id} id={team.id}>
                <s-table-cell>
                  <s-link {...props.teamLink(team.id)}>{team.name}</s-link>
                </s-table-cell>
                <s-table-cell>
                  <End>{presses.removeButton(team)}</End>
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
      <s-link slot="breadcrumb-actions" {...props.membersLink}>
        Members
      </s-link>
      {addButton(true)}
      <s-button
        slot="secondary-actions"
        tone="critical"
        commandFor={DELETE_MEMBER_MODAL}
        command="--show"
      >
        {`${RECORD_VERB_LABEL.delete} member`}
      </s-button>

      <s-section heading="Teams">
        <Things>
          {(banner ?? presses.removeFailure) !== null && (
            <s-banner tone="critical">{banner ?? presses.removeFailure}</s-banner>
          )}
          {renderTeams()}
        </Things>
      </s-section>

      <s-section slot="aside" heading="Details" accessibilityLabel="Details">
        <Pairs
          pairs={[
            { key: "email", label: "Email", value: <Token>{member.email}</Token> },
            { key: "added", label: "Added", value: <LocalDateTime value={member.createdAt} /> },
          ]}
        />
      </s-section>

      <s-modal id={DELETE_MEMBER_MODAL} heading="Delete member?">
        <s-paragraph>
          Delete <Token>{member.email}</Token>? {DELETE_CONFIRM}
        </s-paragraph>
        <s-button slot="secondary-actions" commandFor={DELETE_MEMBER_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={presses.deleting}
          onClick={() => {
            void presses.deleteMember(undefined).then(setBanner);
          }}
        >
          {RECORD_VERB_LABEL.delete}
        </s-button>
      </s-modal>

      {/* Candidates only, a search from SEARCH_FROM of them, ticks kept across searches. */}
      <s-modal
        id={ADD_TEAMS_MODAL}
        heading="Add to teams"
        // Cleared on the way out, not on the way in: `show` can fire after a search was typed or
        // a box checked, and clearing there loses it.
        onAfterHide={() => {
          setAddQuery("");
          setSelected([]);
        }}
      >
        {candidates.length === 0 ? (
          <s-paragraph>
            {teamCount === 0 ? (
              <>
                No teams yet. Create one on <s-link {...props.teamsLink}>Teams</s-link>.
              </>
            ) : (
              "This member is on every team."
            )}
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
                  </s-choice>
                ))}
              </s-choice-list>
            )}
          </Things>
        )}
        <s-button slot="secondary-actions" commandFor={ADD_TEAMS_MODAL} command="--hide">
          Cancel
        </s-button>
        {candidates.length > 0 && (
          <s-button
            slot="primary-action"
            variant="primary"
            loading={presses.adding}
            disabled={selected.length === 0}
            onClick={() => {
              const ids = candidates
                .filter((team) => selected.includes(team.id))
                .map((team) => team.id);
              void presses.addTeams(ids).then((failure) => {
                setBanner(failure);
                if (failure === null) setSelected([]);
              });
            }}
          >
            Add
          </s-button>
        )}
      </s-modal>
    </s-page>
  );
}

/**
 * A team row's Remove once hydrated: `MerchantSetTeamMember` with `inTeam: false` through the
 * row's own {@link setTeamMemberAtom}, whose state is the button's loading.
 */
function LiveRemoveButton({
  teamId,
  memberId,
  onRemoved,
}: {
  readonly teamId: TeamId;
  readonly memberId: MemberId;
  readonly onRemoved: (failure: string | null) => Promise<void>;
}) {
  const atom = setTeamMemberAtom(`${teamId}/${memberId}`);
  const loading = AsyncResult.isWaiting(useAtomValue(atom));
  const remove = useAtomSet(atom, { mode: "promiseExit" });
  return (
    <RemoveButton
      loading={loading}
      onClick={() => {
        void remove({ teamId, memberId, inTeam: false }).then((exit) =>
          onRemoved(
            Exit.match(exit, {
              onSuccess: () => null,
              onFailure: (cause) => pressFailureCopy(cause, "Couldn't remove from the team."),
            }),
          ),
        );
      }}
    />
  );
}

/**
 * The screen once hydrated: each write a mutation over its procedure on the layout's socket, its
 * answer read as an `Exit`; written, the route re-reads the loader. Delete member hides its
 * modal, toasts "Member deleted" and goes back to the index (toast first: the admin's toast
 * outlives the page).
 */
function LiveMember(props: MemberPageProps & { readonly detail: MemberDetail }) {
  const { member } = props.detail;
  const adding = AsyncResult.isWaiting(useAtomValue(addMemberTeamsAtom));
  const deleting = AsyncResult.isWaiting(useAtomValue(deleteMemberAtom));
  const addTeams = useAtomSet(addMemberTeamsAtom, { mode: "promiseExit" });
  const deleteMember = useAtomSet(deleteMemberAtom, { mode: "promiseExit" });
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);

  const presses: Presses = {
    adding,
    deleting,
    addTeams: async (teamIds) =>
      Exit.match(await addTeams({ payload: { memberId: member.id, teamIds } }), {
        onSuccess: async () => {
          await hideModal(ADD_TEAMS_MODAL);
          await props.onChanged();
          return null;
        },
        onFailure: async (cause) => pressFailureCopy(cause, "Couldn't add to teams."),
      }),
    deleteMember: async () =>
      Exit.match(await deleteMember({ payload: { email: member.email } }), {
        onSuccess: async () => {
          await hideModal(DELETE_MEMBER_MODAL);
          toast(DELETED_TOAST.member);
          await props.onDeleted();
          return null;
        },
        onFailure: async (cause) => {
          await hideModal(DELETE_MEMBER_MODAL);
          return pressFailureCopy(cause, "Couldn't delete the member.");
        },
      }),
    removeButton: (team) => (
      <LiveRemoveButton
        teamId={team.id}
        memberId={member.id}
        onRemoved={async (failure) => {
          setRemoveFailure(failure);
          if (failure === null) await props.onChanged();
        }}
      />
    ),
    removeFailure,
  };
  return <MemberScreen {...props} detail={props.detail} presses={presses} />;
}

/**
 * The member page, the mirror of the team page: the member's teams are the one table, Add to
 * teams is the primary action, and Remove on a row takes them off that team with no modal, since
 * Add to teams puts them back on this screen. Delete member is the one other action, a
 * secondary button rather than a More actions menu of one entry, and it names its noun because
 * it sits in the title bar; the modal's primary is Delete alone.
 *
 * Headed by the email, as a Shopify customer page is headed by the name: a title bar cuts a long
 * one, so the Details card prints it whole as its first row (`Token`). The Delete modal is headed
 * "Delete member?" and names the email in its body.
 *
 * Laid out on Polaris' details template; `inlineSize` stays "base" because `s-page` drops the
 * aside slot at "large". Its data is the loader's (no live read); until React has hydrated
 * nothing presses.
 */
export default function MemberPage(props: MemberPageProps) {
  const hydrated = useHydrated();
  if (props.detail === null)
    return (
      <s-page heading="Member not found">
        <s-link slot="breadcrumb-actions" {...props.membersLink}>
          Members
        </s-link>
        <s-paragraph color="subdued">{MEMBER_GONE}</s-paragraph>
      </s-page>
    );
  if (hydrated) return <LiveMember {...props} detail={props.detail} />;
  const idle = async () => null;
  return (
    <MemberScreen
      {...props}
      detail={props.detail}
      presses={{
        adding: false,
        deleting: false,
        addTeams: idle,
        deleteMember: idle,
        removeButton: () => <RemoveButton loading={false} onClick={() => {}} />,
        removeFailure: null,
      }}
    />
  );
}
