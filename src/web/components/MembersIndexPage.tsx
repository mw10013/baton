import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useForm } from "@tanstack/react-form";
import { useHydrated } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { useState } from "react";
import type { Page } from "../../backend/members.ts";
import { EMAIL_MAX_LENGTH, EMAIL_TOO_LONG, Email } from "../../domain/platform.ts";
import {
  type ListSearch,
  type Member,
  type MemberId,
  type MemberSummary,
  RECORD_VERB_LABEL,
} from "../../domain/shop-work.ts";
import { hideModal } from "../client/app-bridge.ts";
import { addMemberAtom } from "../client/shop-actor-client.ts";
import { fieldError, schemaForm } from "./form.ts";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { FilterRow } from "./screen/FilterRow.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";
import { ListSearchField } from "./screen/ListSearchField.tsx";
import { SearchLine } from "./screen/SearchLine.tsx";
import { textLimitError } from "./screen/TextLimit.tsx";
import { Token } from "./screen/Token.tsx";
import { pressFailureCopy } from "./teams.ts";

export const ADD_MEMBER_MODAL = "add-member";

/** The Add member field as typed: the cap and the empty field are the field's own errors. */
const AddMemberForm = schemaForm(
  Schema.Struct({
    email: Schema.String.check(
      Schema.isNonEmpty({ message: "Enter an email" }),
      Schema.isMaxLength(EMAIL_MAX_LENGTH, { message: EMAIL_TOO_LONG }),
    ),
  }),
);

/** The typed field to the email Add sends; a blank field, which the trim empties, is none. */
const decodeEmail = Schema.decodeUnknownOption(Email);

/** A link's `href` and the click that navigates to it, as the route builds them. */
export interface PageLink {
  readonly href: string;
  readonly onClick: (event: Event) => void;
}

/** {@link MembersIndexPage}'s props: the loader's page and the route's navigation. */
export interface MembersIndexProps {
  readonly page: Page<MemberSummary, Email>;
  /** The search and the page cursor in the URL, `null` when absent. */
  readonly q: ListSearch | null;
  readonly after: Email | null;
  readonly memberLink: (id: MemberId) => PageLink;
  readonly onSearch: (next: ListSearch | null) => void;
  readonly onNextPage: (cursor: Email) => void;
  readonly onPreviousPage: () => void;
  /** After Add member: re-read the loader, then land on the new member's page. */
  readonly onAdded: (member: Member) => Promise<void>;
}

/**
 * What a press of Add answers the screen: `null` when it added (the page then leaves), else the
 * banner's sentence.
 */
type AddMember = (email: Email) => Promise<string | null>;

function MembersIndexScreen(
  props: MembersIndexProps & { readonly adding: boolean; readonly addMember: AddMember },
) {
  const { page, q, after } = props;
  const members = page.rows;
  const [banner, setBanner] = useState<string | null>(null);
  /** The cap is the field's own error before the schema's words can be (`TextLimit`). */
  const [emailError, setEmailError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { email: "" },
    ...AddMemberForm.options,
    onSubmit: async ({ value }) => {
      const email = decodeEmail(AddMemberForm.decode(value).email);
      if (Option.isNone(email)) return setEmailError("Enter an email");
      setBanner(await props.addMember(email.value));
    },
  });

  const submit = () => {
    const limit = textLimitError(form.getFieldValue("email"), EMAIL_MAX_LENGTH);
    if (limit !== null) {
      setEmailError(limit);
      return;
    }
    void form.handleSubmit();
  };

  /** No search and page one: an empty page here means the shop has no members. */
  const unfiltered = q === null && after === null;

  const addButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={ADD_MEMBER_MODAL}
      command="--show"
    >
      {`${RECORD_VERB_LABEL.add} member`}
    </s-button>
  );

  const renderRows = () => {
    if (unfiltered && members.length === 0)
      return (
        <EmptyLine heading="No members yet" action={addButton(false)}>
          Members sign in with their email. Put each one on a team, or they have nothing to do.
        </EmptyLine>
      );
    if (q !== null && members.length === 0)
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
          No members match.
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
          <s-table-header listSlot="primary">Email</s-table-header>
          <s-table-header>Teams</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {members.map((member) => (
            <s-table-row key={member.id} id={member.id}>
              <s-table-cell>
                <Token link={props.memberLink(member.id)}>{member.email}</Token>
              </s-table-cell>
              <s-table-cell>
                {member.teamCount === 0 ? (
                  <s-badge tone="warning">No teams</s-badge>
                ) : (
                  member.teamCount
                )}
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  return (
    <s-page heading="Members" inlineSize="large">
      {/* Unconditional, empty list included: the resource-index template keeps the title-bar
          primary action and lets the empty state carry a second copy, so "add is top right"
          holds on the visit where it matters most. App Bridge hoists this one out of the
          iframe, so the in-card twin is not a duplicate in the frame's DOM. */}
      {addButton(true)}

      {banner !== null && <s-banner tone="critical">{banner}</s-banner>}

      {/* The search is submitted on Enter and reads every member, not only this page; while it
          is on, how many match and Clear search sit above it (`SearchLine`). */}
      <IndexSection
        label="Members"
        head={
          !(unfiltered && members.length === 0) && (
            <>
              {q !== null && page.matches !== null && page.matches > 0 && (
                <SearchLine
                  count={page.matches}
                  noun={["member", "members"]}
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
                    placeholder="Search by email"
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
        id={ADD_MEMBER_MODAL}
        heading={`${RECORD_VERB_LABEL.add} member`}
        // Reset on the way out, not on the way in: `show` can fire after the field has already
        // taken input, and a reset there wipes what was typed, so Add submits an empty email.
        onAfterHide={() => {
          form.reset();
          setEmailError(null);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <form.Field name="email">
            {(field) => (
              <s-email-field
                label="Email"
                name={field.name}
                details="They sign in with this email. No Shopify account needed."
                value={field.state.value}
                error={emailError ?? fieldError(field.state.meta.errors)}
                onInput={(event) => {
                  setEmailError(null);
                  field.handleChange(event.currentTarget.value);
                }}
                onBlur={field.handleBlur}
                required
              />
            )}
          </form.Field>
        </form>
        <s-button slot="secondary-actions" commandFor={ADD_MEMBER_MODAL} command="--hide">
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" loading={props.adding} onClick={submit}>
          {RECORD_VERB_LABEL.add}
        </s-button>
      </s-modal>
    </s-page>
  );
}

/**
 * The screen once hydrated: Add member is `MerchantAddMember` on the layout's socket
 * ({@link addMemberAtom}), its answer read as an `Exit`. Added, the modal hides and the route
 * re-reads the loader and lands on the member's page, where Add to teams is the next step.
 */
function LiveMembersIndex(props: MembersIndexProps) {
  const adding = AsyncResult.isWaiting(useAtomValue(addMemberAtom));
  const add = useAtomSet(addMemberAtom, { mode: "promiseExit" });
  const addMember: AddMember = async (email) =>
    Exit.match(await add({ payload: { email } }), {
      onSuccess: async (member) => {
        await hideModal(ADD_MEMBER_MODAL);
        await props.onAdded(member);
        return null;
      },
      onFailure: async (cause) => pressFailureCopy(cause, "Couldn't add the member."),
    });
  return <MembersIndexScreen {...props} adding={adding} addMember={addMember} />;
}

/**
 * The members index, on the resource-index pattern the teams index shares: a row per member, the
 * email a link to the member page, how many teams they are on, and no buttons on a row.
 * Everything about one member, their teams and the delete, is on the member page. Its data is
 * the loader's (no live read); until React has hydrated nothing presses.
 */
export default function MembersIndexPage(props: MembersIndexProps) {
  const hydrated = useHydrated();
  if (hydrated) return <LiveMembersIndex {...props} />;
  return <MembersIndexScreen {...props} adding={false} addMember={async () => null} />;
}
