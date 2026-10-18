import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useForm } from "@tanstack/react-form";
import { useHydrated } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";
import type { Email } from "../../domain/platform.ts";
import {
  type MemberId,
  RECORD_VERB_LABEL,
  TEAM_NAME_MAX_LENGTH,
  type TeamDetail,
  type TeamName,
} from "../../domain/shop-work.ts";
import { hideModal, toast } from "../client/app-bridge.ts";
import {
  addTeamMembersAtom,
  deleteTeamAtom,
  renameTeamAtom,
  setTeamMemberAtom,
} from "../client/shop-actor-client.ts";
import { fieldError, schemaForm } from "./form.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import type { PageLink } from "./MembersIndexPage.tsx";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { End } from "./screen/End.tsx";
import { Pairs } from "./screen/Pairs.tsx";
import { TableFrame } from "./screen/TableFrame.tsx";
import { textLimitError } from "./screen/TextLimit.tsx";
import { Things } from "./screen/Things.tsx";
import { Token } from "./screen/Token.tsx";
import { decodeTeamName } from "./TeamsIndexPage.tsx";
import {
  DELETE_CONFIRM,
  DELETED_TOAST,
  NAME_TAKEN,
  pressFailureCopy,
  SEARCH_FROM,
  TEAM_GONE,
} from "./teams.ts";

export const RENAME_TEAM_MODAL = "rename-team";
export const DELETE_TEAM_MODAL = "delete-team";
export const ADD_TEAM_MEMBERS_MODAL = "add-team-members";

/** The Rename field as typed: an empty field is the field's own error. */
const NameForm = schemaForm(
  Schema.Struct({ name: Schema.String.check(Schema.isNonEmpty({ message: "Enter a name" })) }),
);

/** {@link TeamPage}'s props: the loader's detail and the route's navigation. */
export interface TeamPageProps {
  /** `null` is no such team in this shop. */
  readonly detail: TeamDetail | null;
  /** The Members table's page cursor in the URL, `null` when absent. */
  readonly membersAfter: Email | null;
  /** The breadcrumb to the teams index, a bare path, for the reason on `MemberPage`'s. */
  readonly teamsLink: PageLink;
  readonly membersLink: PageLink;
  readonly memberLink: (id: MemberId) => PageLink;
  readonly onNextPage: (cursor: Email) => void;
  readonly onPreviousPage: () => void;
  /** After a write: re-read the loader. */
  readonly onChanged: () => Promise<void>;
  /** After Delete team: back to the teams index. */
  readonly onDeleted: () => Promise<void>;
}

/** A press's answer to the screen: `null` when it wrote, else the refusal's copy. */
type Press<A> = (input: A) => Promise<string | null>;

interface Presses {
  readonly renaming: boolean;
  readonly adding: boolean;
  readonly deleting: boolean;
  readonly rename: Press<TeamName>;
  readonly addMembers: Press<ReadonlyArray<MemberId>>;
  /** `null` when deleted (the page then leaves), else a banner: a failure, or `TEAM_GONE`. */
  readonly deleteTeam: () => Promise<{
    readonly tone: "critical" | "warning";
    readonly text: string;
  } | null>;
  readonly removeButton: (member: { readonly id: MemberId }) => ReactNode;
  readonly removeFailure: string | null;
}

/** A member row's Remove, before hydration or while its own press runs. */
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

function TeamScreen(
  props: TeamPageProps & { readonly detail: TeamDetail; readonly presses: Presses },
) {
  const { team, members, memberCount, nextCursor, candidates } = props.detail;
  const { presses, membersAfter } = props;
  const [banner, setBanner] = useState<string | null>(null);
  const [deleteBanner, setDeleteBanner] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);

  const form = useForm({
    defaultValues: { name: String(team.name) },
    ...NameForm.options,
    onSubmit: async ({ value }) => {
      const name = decodeTeamName(NameForm.decode(value).name);
      if (Option.isNone(name)) return setNameError("Enter a name");
      const failure = await presses.rename(name.value);
      if (failure === NAME_TAKEN) setNameError(failure);
      else setBanner(failure);
    },
  });

  /** The cap is the field's own error before the schema's words can be (`TextLimit`). */
  const submitRename = () => {
    const limit = textLimitError(form.getFieldValue("name"), TEAM_NAME_MAX_LENGTH);
    if (limit !== null) {
      setNameError(limit);
      return;
    }
    void form.handleSubmit();
  };

  const addTrimmed = addQuery.trim().toLowerCase();
  const matches =
    addTrimmed === ""
      ? candidates
      : candidates.filter((member) => member.email.toLowerCase().includes(addTrimmed));

  /**
   * `s-choice-list` reports only the choices it has rendered, so a member ticked before the
   * search narrowed the list would be dropped by the next change event. The rendered ids are
   * replaced wholesale and the rest of the selection is kept, which is what lets a merchant
   * search, tick, search again, and add both.
   */
  const changeSelected = (values: ReadonlyArray<string>) => {
    const rendered = new Set<string>(matches.map((member) => member.id));
    setSelected([...selected.filter((id) => !rendered.has(id)), ...values]);
  };

  const addButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={ADD_TEAM_MEMBERS_MODAL}
      command="--show"
    >
      {`${RECORD_VERB_LABEL.add} members`}
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
      <TableFrame>
        <s-table
          paginate={membersAfter !== null || nextCursor !== null}
          hasPreviousPage={membersAfter !== null}
          hasNextPage={nextCursor !== null}
          onPreviousPage={props.onPreviousPage}
          onNextPage={() => {
            if (nextCursor !== null) props.onNextPage(nextCursor);
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
                  <Token link={props.memberLink(member.id)}>{member.email}</Token>
                </s-table-cell>
                <s-table-cell>
                  <End>{presses.removeButton(member)}</End>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </TableFrame>
    );
  };

  const failure = banner ?? presses.removeFailure;
  return (
    <s-page heading={team.name} inlineSize="base">
      <s-link slot="breadcrumb-actions" {...props.teamsLink}>
        Teams
      </s-link>
      {/* No "No members" badge in the header: the members card below is the empty state for
          that, with the consequence and the Add button, and a second mark for one fault reads
          as two. The teams index keeps its badge, where the row is the only place it shows. */}
      {addButton(true)}
      <s-button slot="secondary-actions" commandFor="team-actions">
        More actions
      </s-button>
      <s-menu id="team-actions" accessibilityLabel="More actions">
        <s-button icon="edit" commandFor={RENAME_TEAM_MODAL} command="--show">
          {RECORD_VERB_LABEL.rename}
        </s-button>
        <s-button icon="delete" tone="critical" commandFor={DELETE_TEAM_MODAL} command="--show">
          {RECORD_VERB_LABEL.delete}
        </s-button>
      </s-menu>

      <s-section heading="Members">
        <Things>
          {failure !== null && <s-banner tone="critical">{failure}</s-banner>}
          {deleteBanner !== null && <s-banner tone="warning">{deleteBanner}</s-banner>}
          {renderMembers()}
        </Things>
      </s-section>

      <s-section slot="aside" heading="Details" accessibilityLabel="Details">
        <Pairs
          pairs={[
            { key: "members", label: "Members", value: String(memberCount) },
            { key: "created", label: "Created", value: <LocalDateTime value={team.createdAt} /> },
          ]}
        />
      </s-section>

      <s-modal
        id={RENAME_TEAM_MODAL}
        heading="Rename team"
        // The form's defaults are the current name, so a first open needs no seeding. Reset on
        // the way out, not on the way in: `show` can fire after the field has already taken
        // input. Rename re-reads before it hides so this reseed reads the new name.
        onAfterHide={() => {
          form.reset({ name: String(team.name) });
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
        <s-button slot="secondary-actions" commandFor={RENAME_TEAM_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={presses.renaming}
          onClick={submitRename}
        >
          Save
        </s-button>
      </s-modal>

      <s-modal id={DELETE_TEAM_MODAL} heading={`Delete ${team.name}?`}>
        <s-paragraph>{DELETE_CONFIRM}</s-paragraph>
        <s-button slot="secondary-actions" commandFor={DELETE_TEAM_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={presses.deleting}
          onClick={() => {
            void presses.deleteTeam().then((answer) => {
              if (answer === null) return;
              if (answer.tone === "warning") setDeleteBanner(answer.text);
              else setBanner(answer.text);
            });
          }}
        >
          {RECORD_VERB_LABEL.delete}
        </s-button>
      </s-modal>

      {/* Our own dialog rather than App Bridge's Picker API, which the admin host renders
          outside this iframe with no layout input beyond its columns. The member page's Add to
          teams dialog is its mirror, editing the same membership from the other side. */}
      <s-modal
        id={ADD_TEAM_MEMBERS_MODAL}
        heading={`Add members to ${team.name}`}
        // Cleared on the way out, not on the way in: `show` can fire after a search was typed or
        // a box checked, and clearing there loses it.
        onAfterHide={() => {
          setAddQuery("");
          setSelected([]);
        }}
      >
        {candidates.length === 0 ? (
          <s-paragraph>
            {memberCount === 0 ? (
              <>
                No members yet. Add them on <s-link {...props.membersLink}>Members</s-link>.
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
        <s-button slot="secondary-actions" commandFor={ADD_TEAM_MEMBERS_MODAL} command="--hide">
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
                .filter((member) => selected.includes(member.id))
                .map((member) => member.id);
              void presses.addMembers(ids).then((answer) => {
                setBanner(answer);
                if (answer === null) setSelected([]);
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
 * A member row's Remove once hydrated: `MerchantSetTeamMember` with `inTeam: false` through the
 * row's own {@link setTeamMemberAtom}, whose state is the button's loading.
 */
function LiveRemoveButton({
  teamDetail,
  memberId,
  onRemoved,
}: {
  readonly teamDetail: TeamDetail;
  readonly memberId: MemberId;
  readonly onRemoved: (failure: string | null) => Promise<void>;
}) {
  const teamId = teamDetail.team.id;
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
              onFailure: (cause) => pressFailureCopy(cause, "Couldn't remove the member."),
            }),
          ),
        );
      }}
    />
  );
}

/**
 * The screen once hydrated: each write a mutation over its procedure on the layout's socket, its
 * answer read as an `Exit`; written, the route re-reads the loader. Delete team is
 * `MerchantDeleteTeam`: `Deleted` hides the modal, toasts "Team deleted" and goes back to the
 * index (toast first: the admin's toast outlives the page); `NotFound` is legacy's banner
 * sentence.
 */
function LiveTeam(props: TeamPageProps & { readonly detail: TeamDetail }) {
  const { team } = props.detail;
  const renaming = AsyncResult.isWaiting(useAtomValue(renameTeamAtom));
  const adding = AsyncResult.isWaiting(useAtomValue(addTeamMembersAtom));
  const deleting = AsyncResult.isWaiting(useAtomValue(deleteTeamAtom));
  const rename = useAtomSet(renameTeamAtom, { mode: "promiseExit" });
  const addMembers = useAtomSet(addTeamMembersAtom, { mode: "promiseExit" });
  const deleteTeam = useAtomSet(deleteTeamAtom, { mode: "promiseExit" });
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);

  const presses: Presses = {
    renaming,
    adding,
    deleting,
    rename: async (name) =>
      Exit.match(await rename({ payload: { teamId: team.id, name } }), {
        onSuccess: async () => {
          await props.onChanged();
          await hideModal(RENAME_TEAM_MODAL);
          return null;
        },
        onFailure: async (cause) => pressFailureCopy(cause, "Couldn't rename the team."),
      }),
    addMembers: async (memberIds) =>
      Exit.match(await addMembers({ payload: { teamId: team.id, memberIds } }), {
        onSuccess: async () => {
          await hideModal(ADD_TEAM_MEMBERS_MODAL);
          await props.onChanged();
          return null;
        },
        onFailure: async (cause) => pressFailureCopy(cause, "Couldn't add members."),
      }),
    deleteTeam: async () => {
      const exit = await deleteTeam({ payload: { teamId: team.id } });
      await hideModal(DELETE_TEAM_MODAL);
      return Exit.match(exit, {
        onSuccess: (result) =>
          Match.valueTags(result, {
            Deleted: async () => {
              toast(DELETED_TOAST.team);
              await props.onDeleted();
              return null;
            },
            NotFound: async () => ({ tone: "warning" as const, text: TEAM_GONE }),
          }),
        onFailure: async (cause) => ({
          tone: "critical" as const,
          text: pressFailureCopy(cause, "Couldn't delete the team."),
        }),
      });
    },
    removeButton: (member) => (
      <LiveRemoveButton
        teamDetail={props.detail}
        memberId={member.id}
        onRemoved={async (failure) => {
          setRemoveFailure(failure);
          if (failure === null) await props.onChanged();
        }}
      />
    ),
    removeFailure,
  };
  return <TeamScreen {...props} detail={props.detail} presses={presses} />;
}

/**
 * The team page is about people: its members are the one table, and adding is the primary
 * action. The workflows that use the team are not listed: tasks are edited on the workflow pages,
 * which name each task's team. Rename and delete live behind More actions. Remove on a member's
 * row has no modal: Add members puts them back on this screen.
 *
 * Laid out as Polaris' details template: the members table owns the main column, paged from the
 * server, and the facts a merchant checks before renaming or deleting sit in the Details aside.
 * `inlineSize` must stay "base": `s-page` drops the aside slot entirely at "large". Its data is
 * the loader's (no live read); until React has hydrated nothing presses.
 */
export default function TeamPage(props: TeamPageProps) {
  const hydrated = useHydrated();
  if (props.detail === null)
    return (
      <s-page heading="Team not found">
        <s-link slot="breadcrumb-actions" {...props.teamsLink}>
          Teams
        </s-link>
        <s-paragraph color="subdued">{TEAM_GONE}</s-paragraph>
      </s-page>
    );
  if (hydrated) return <LiveTeam {...props} detail={props.detail} />;
  const idle = async () => null;
  return (
    <TeamScreen
      {...props}
      detail={props.detail}
      presses={{
        renaming: false,
        adding: false,
        deleting: false,
        rename: idle,
        addMembers: idle,
        deleteTeam: idle,
        removeButton: () => <RemoveButton loading={false} onClick={() => {}} />,
        removeFailure: null,
      }}
    />
  );
}
