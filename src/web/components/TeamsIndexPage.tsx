import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useForm } from "@tanstack/react-form";
import { useHydrated } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { useState } from "react";
import type { Page } from "../../backend/membership-repository.ts";
import {
  type ListSearch,
  RECORD_VERB_LABEL,
  type Team,
  type TeamId,
  TEAM_NAME_MAX_LENGTH,
  TeamName,
  type TeamSummary,
} from "../../domain/shop-work.ts";
import { hideModal } from "../client/app-bridge.ts";
import { createTeamAtom } from "../client/shop-actor-client.ts";
import { fieldError, schemaForm } from "./form.ts";
import type { PageLink } from "./MembersIndexPage.tsx";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { FilterRow } from "./screen/FilterRow.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";
import { Inline } from "./screen/Inline.tsx";
import { ListSearchField } from "./screen/ListSearchField.tsx";
import { SearchLine } from "./screen/SearchLine.tsx";
import { textLimitError } from "./screen/TextLimit.tsx";
import { NAME_TAKEN, pressFailureCopy } from "./teams.ts";

export const CREATE_TEAM_MODAL = "create-team";

/** The Create team field as typed: an empty field is the field's own error. */
const TeamNameForm = schemaForm(
  Schema.Struct({ name: Schema.String.check(Schema.isNonEmpty({ message: "Enter a name" })) }),
);

/** The typed field to the name Create sends, trimmed; a blank field is none. */
export const decodeTeamName = Schema.decodeUnknownOption(TeamName);

/** {@link TeamsIndexPage}'s props: the loader's page and the route's navigation. */
export interface TeamsIndexProps {
  readonly page: Page<TeamSummary, TeamName>;
  /** The search and the page cursor in the URL, `null` when absent. */
  readonly q: ListSearch | null;
  readonly after: TeamName | null;
  readonly teamLink: (id: TeamId) => PageLink;
  readonly onSearch: (next: ListSearch | null) => void;
  readonly onNextPage: (cursor: TeamName) => void;
  readonly onPreviousPage: () => void;
  /** After Create team: re-read the loader, then land on the new team's page. */
  readonly onCreated: (team: Team) => Promise<void>;
}

/** What a press of Create answers the screen: `null` when it created, else the refusal's copy. */
type CreateTeam = (name: TeamName) => Promise<string | null>;

function TeamsIndexScreen(
  props: TeamsIndexProps & { readonly creating: boolean; readonly createTeam: CreateTeam },
) {
  const { page, q, after } = props;
  const teams = page.rows;
  const [banner, setBanner] = useState<string | null>(null);
  /**
   * The name-taken failure is a field error, not a banner: the merchant fixes it by editing the
   * field. Held outside the form because it arrives from the actor after validation has passed.
   */
  const [nameError, setNameError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { name: "" },
    ...TeamNameForm.options,
    onSubmit: async ({ value }) => {
      const name = decodeTeamName(TeamNameForm.decode(value).name);
      if (Option.isNone(name)) return setNameError("Enter a name");
      const failure = await props.createTeam(name.value);
      if (failure === NAME_TAKEN) setNameError(failure);
      else setBanner(failure);
    },
  });

  /** The cap is the field's own error before the schema's words can be (`TextLimit`). */
  const submit = () => {
    const limit = textLimitError(form.getFieldValue("name"), TEAM_NAME_MAX_LENGTH);
    if (limit !== null) {
      setNameError(limit);
      return;
    }
    void form.handleSubmit();
  };

  /** No search and page one: an empty page here means the shop has no teams. */
  const unfiltered = q === null && after === null;

  const createButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={CREATE_TEAM_MODAL}
      command="--show"
    >
      {`${RECORD_VERB_LABEL.create} team`}
    </s-button>
  );

  const renderRows = () => {
    if (unfiltered && teams.length === 0)
      return (
        <EmptyLine heading="No teams yet" action={createButton(false)}>
          A team is who can work a task. Assign one to each task in a workflow.
        </EmptyLine>
      );
    if (q !== null && teams.length === 0)
      return (
        <EmptyLine
          action={
            <s-button
              variant="secondary"
              onClick={() => {
                props.onSearch(null);
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
        paginate={after !== null || page.nextCursor !== null}
        hasPreviousPage={after !== null}
        hasNextPage={page.nextCursor !== null}
        onPreviousPage={props.onPreviousPage}
        onNextPage={() => {
          if (page.nextCursor !== null) props.onNextPage(page.nextCursor);
        }}
      >
        <s-table-header-row>
          <s-table-header listSlot="primary">Team</s-table-header>
          <s-table-header>Members</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {teams.map((team) => (
            <s-table-row key={team.id} id={team.id}>
              <s-table-cell>
                <Inline>
                  <s-link {...props.teamLink(team.id)}>{team.name}</s-link>
                  {team.memberCount === 0 && <s-badge tone="warning">No members</s-badge>}
                </Inline>
              </s-table-cell>
              <s-table-cell>{team.memberCount}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  return (
    <s-page heading="Teams" inlineSize="large">
      {/* Unconditional, empty list included: the resource-index template keeps the title-bar
          primary action and lets the empty state carry a second copy, so "create is top right"
          holds on the visit where it matters most. App Bridge hoists this one out of the iframe,
          so the in-card twin is not a duplicate in the frame's DOM. */}
      {createButton(true)}

      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {/* The search is submitted on Enter and reads every team, not only this page; while it is
          on, how many match and Clear search sit above it (`SearchLine`). */}
      <IndexSection
        label="Teams"
        head={
          !(unfiltered && teams.length === 0) && (
            <>
              {q !== null && page.matches !== null && page.matches > 0 && (
                <SearchLine
                  count={page.matches}
                  noun={["team", "teams"]}
                  term={q}
                  onClear={() => {
                    props.onSearch(null);
                  }}
                />
              )}
              <FilterRow
                search={
                  <ListSearchField
                    value={q}
                    placeholder="Search by name"
                    onSubmit={props.onSearch}
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
        id={CREATE_TEAM_MODAL}
        heading={`${RECORD_VERB_LABEL.create} team`}
        // Reset on the way out, not on the way in: `show` can fire after a field has already
        // taken input, and a reset there wipes what was typed.
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
        <s-button slot="secondary-actions" commandFor={CREATE_TEAM_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" loading={props.creating} onClick={submit}>
          {RECORD_VERB_LABEL.create}
        </s-button>
      </s-modal>
    </s-page>
  );
}

/**
 * The screen once hydrated: Create team is `MerchantCreateTeam` on the layout's socket
 * ({@link createTeamAtom}), its answer read as an `Exit`. Created, the modal hides and the route
 * re-reads the loader and lands on the team's page, since the next thing is always adding people.
 */
function LiveTeamsIndex(props: TeamsIndexProps) {
  const creating = AsyncResult.isWaiting(useAtomValue(createTeamAtom));
  const create = useAtomSet(createTeamAtom, { mode: "promiseExit" });
  const createTeam: CreateTeam = async (name) =>
    Exit.match(await create({ payload: { name } }), {
      onSuccess: async (team) => {
        await hideModal(CREATE_TEAM_MODAL);
        await props.onCreated(team);
        return null;
      },
      onFailure: async (cause) => pressFailureCopy(cause, "Couldn't create the team."),
    });
  return <TeamsIndexScreen {...props} creating={creating} createTeam={createTeam} />;
}

/**
 * The teams page on the resource-index pattern: a primary action that opens a modal, a search
 * once there is something to search, and no destructive control on the index: deletion lives on
 * the detail page, where the dialog is. Its data is the loader's (no live read); until React has
 * hydrated nothing presses.
 */
export default function TeamsIndexPage(props: TeamsIndexProps) {
  const hydrated = useHydrated();
  if (hydrated) return <LiveTeamsIndex {...props} />;
  return <TeamsIndexScreen {...props} creating={false} createTeam={async () => null} />;
}
