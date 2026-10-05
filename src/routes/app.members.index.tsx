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

import { LocalDateTime } from "@/components/LocalDateTime";
import { EmptyLine } from "@/components/screen/EmptyLine";
import { FilterRow } from "@/components/screen/FilterRow";
import { IndexSection } from "@/components/screen/IndexSection";
import { ListSearchField } from "@/components/screen/ListSearchField";
import { SearchLine } from "@/components/screen/SearchLine";
import { Token } from "@/components/screen/Token";
import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { lenientSearchKey, ListSearchParam } from "@/lib/searchParams";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";
import { SocketBanner } from "@/lib/SocketBanner";
import { useNextPageEntry } from "@/lib/tablePages";
import { INDEX_PAGE_SIZE, sessionShop } from "@/lib/teams";

const CREATE_MODAL = "create-member";

const CreateMemberInput = Schema.Struct({
  email: Schema.String.check(
    Schema.isNonEmpty({ message: "Enter an email" }),
    Schema.isMaxLength(Domain.EMAIL_MAX_LENGTH, {
      message: Domain.EMAIL_TOO_LONG,
    }),
  ),
});
type CreateMemberInput = typeof CreateMemberInput.Type;

const decodeEmail = Schema.decodeUnknownEffect(Domain.Email);

const MEMBER_CEILING =
  "This store has reached the maximum number of members. Contact support to raise it.";

/**
 * The members index's URL: the search and the page. `q` is matched anywhere
 * in the email, over every member, not only the rows on screen; `after` is
 * the last email of the page before (`Repository.listMembersPage`). Both are
 * lenient for the reason on `OrdersSearch` (`app.orders.tsx`): a stale or
 * hand-edited value reads as no search, or page one.
 */
const MembersSearch = Schema.Struct({
  q: lenientSearchKey(ListSearchParam),
  after: lenientSearchKey(Domain.Email),
});

const MembersLoaderInput = Schema.Struct({
  q: Schema.NullOr(Domain.ListSearch),
  after: Schema.NullOr(Domain.Email),
});

/** One page of members in email order, each with how many teams they are on. */
interface MembersIndexLoaderData {
  readonly members: readonly Domain.MemberSummary[];
  readonly nextCursor: Domain.Email | null;
  readonly matches: number | null;
}

const getLoaderData = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(MembersLoaderInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data: { q, after }, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const page = yield* (yield* Repository).listMembersPage({
          shop: yield* sessionShop(session.shop),
          limit: INDEX_PAGE_SIZE,
          after,
          q,
        });
        return {
          members: page.rows,
          nextCursor: page.nextCursor,
          matches: page.matches,
        } satisfies MembersIndexLoaderData;
      }),
    ),
  );

/**
 * Creating stays idempotent for the row (`Repository.createMember`), and
 * returns it so the page can land on the member page, where Add to teams is
 * the next step. It queues no seat event: the next revalidation raises the
 * seat mark to the member count (the "revalidation, same cycle start" row on
 * `Domain.ShopUsage`).
 */
const createMemberFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(CreateMemberInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        return yield* (yield* Repository).createMember({
          shop: yield* sessionShop(session.shop),
          email: yield* decodeEmail(data.email),
        });
      }).pipe(
        Effect.catchTag("MemberCeilingError", () =>
          Effect.fail(new Error(MEMBER_CEILING)),
        ),
      ),
    ),
  );

export const Route = createFileRoute("/app/members/")({
  validateSearch: Schema.toStandardSchemaV1(MembersSearch),
  loaderDeps: ({ search }) => ({
    q: search.q ?? null,
    after: search.after ?? null,
  }),
  loader: ({ deps }) => getLoaderData({ data: deps }),
  component: RouteComponent,
});

/**
 * The members index, on the resource-index pattern the teams and workflows
 * indexes share: a row per member, the email a link to the member page,
 * how many teams they are on, and no buttons on a row. Everything about one
 * member, their teams and the delete, is on the member page.
 */
function RouteComponent() {
  const { members, nextCursor, matches } = Route.useLoaderData();
  const { q, after } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const nextPageEntry = useNextPageEntry("after");
  const shopify = useAppBridge();
  const createMember = useServerFn(createMemberFn);

  const createMutation = useMutation({
    mutationFn: (data: CreateMemberInput) => createMember({ data }),
    onSuccess: async (created) => {
      await shopify.modal.hide(CREATE_MODAL);
      await router.invalidate({ sync: true });
      await navigate({
        to: "/app/members/$memberId",
        params: { memberId: created.id },
      });
    },
  });

  const form = useForm({
    defaultValues: { email: "" } satisfies CreateMemberInput,
    validators: { onSubmit: Schema.toStandardSchemaV1(CreateMemberInput) },
    onSubmit: ({ value }) => {
      createMutation.mutate(value);
    },
  });

  const banner = createMutation.isError
    ? mutationErrorMessage(createMutation.error, "Couldn't create the member.")
    : null;

  /** `replace: true`: a search is the screen's state, not a trail. */
  const setSearch = (next: Domain.ListSearch | null) => {
    void navigate({
      search: { q: next ?? undefined, after: undefined },
      replace: true,
    });
  };
  const nextPage = (cursor: Domain.Email) => {
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
  /** No search and page one: an empty page here means the shop has no members. */
  const unfiltered = q === undefined && after === undefined;

  const createButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "primary-action" as const } : {})}
      variant="primary"
      commandFor={CREATE_MODAL}
      command="--show"
    >
      {`${Domain.RECORD_VERB_LABEL.create} member`}
    </s-button>
  );

  const renderRows = () => {
    if (unfiltered && members.length === 0)
      return (
        <EmptyLine heading="No members yet" action={createButton(false)}>
          Members sign in with their email. Put each one on a team, or they have
          nothing to do.
        </EmptyLine>
      );
    if (q !== undefined && members.length === 0)
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
          No members match.
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
        <s-table-header-row>
          <s-table-header listSlot="primary">Email</s-table-header>
          <s-table-header>Teams</s-table-header>
          <s-table-header>Created</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {members.map((member) => (
            <s-table-row key={member.id} id={member.id}>
              <s-table-cell>
                <Token href={`/app/members/${member.id}`}>{member.email}</Token>
              </s-table-cell>
              <s-table-cell>
                {member.teamCount === 0 ? (
                  <s-badge tone="warning">No teams</s-badge>
                ) : (
                  member.teamCount
                )}
              </s-table-cell>
              <s-table-cell>
                <LocalDateTime value={member.createdAt} />
              </s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    );
  };

  return (
    <s-page heading="Members" inlineSize="large">
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
          only with rows: on empty the centred empty state carries this same
          sentence, so showing both said it twice. The search is submitted
          on Enter and reads every member, not only this page; while it is
          on, how many match and Clear search sit above it ({@link SearchLine}). */}
      <IndexSection
        label="Members"
        head={
          !(unfiltered && members.length === 0) && (
            <>
              <s-paragraph color="subdued">
                Members sign in with their email. Put each one on a team, or
                they have nothing to do.
              </s-paragraph>
              {q !== undefined && matches !== null && matches > 0 && (
                <SearchLine
                  count={matches}
                  noun={["member", "members"]}
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
                    placeholder="Search by email"
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
        heading="Create member"
        /* Reset on the way out, not on the way in: `show` can fire after the
           field has already taken input, and a reset there wipes what was
           typed, so Create submits an empty email. */
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
          <form.Field name="email">
            {(field) => (
              <s-email-field
                label="Email"
                name={field.name}
                details="They sign in with this email. No Shopify account needed."
                value={field.state.value}
                maxLength={Domain.EMAIL_MAX_LENGTH}
                error={fieldError(field.state.meta.errors)}
                onInput={(event) => {
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
          onClick={() => {
            void form.handleSubmit();
          }}
        >
          {Domain.RECORD_VERB_LABEL.create}
        </s-button>
      </s-modal>
    </s-page>
  );
}
