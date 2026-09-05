import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";

const membersSearchSchema = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
});

const MemberInput = Schema.Struct({
  email: Schema.String.check(
    Schema.isNonEmpty({ message: "Email is required" }),
  ),
});
type MemberInput = typeof MemberInput.Type;

const MemberArchivedInput = Schema.Struct({
  email: Schema.String,
  archived: Schema.Boolean,
});

const decodeEmail = Schema.decodeUnknownEffect(Domain.Email);

const sessionShop = (shop: string) =>
  Schema.decodeUnknownEffect(Domain.Shop)(shop);

/** See the teams list route for why tagged failures are replaced by copy. */
const failWith = (message: string) => () => Effect.fail(new Error(message));

const MEMBER_GONE = "That member no longer exists.";

/**
 * Filtered here rather than in the component so the client never receives
 * archived rows it will not show.
 */
const getMembers = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(membersSearchSchema))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const members = yield* (yield* Repository).listMembers(shop);
        return {
          members:
            data.archived === true
              ? members
              : members.filter((member) => member.archivedAt === null),
        };
      }),
    ),
  );

const addMemberFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MemberInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* repository.addMember({
          shop: yield* sessionShop(session.shop),
          email: yield* decodeEmail(data.email),
        });
      }),
    ),
  );

const setMemberArchivedFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MemberArchivedInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* repository.setMemberArchived({
          shop: yield* sessionShop(session.shop),
          email: yield* decodeEmail(data.email),
          archived: data.archived,
        });
      }).pipe(Effect.catchTag("MemberNotFoundError", failWith(MEMBER_GONE))),
    ),
  );

export const Route = createFileRoute("/app/members")({
  validateSearch: Schema.toStandardSchemaV1(membersSearchSchema),
  loaderDeps: ({ search }) => ({ archived: search.archived }),
  loader: ({ deps }) => getMembers({ data: deps }),
  component: RouteComponent,
});

function RouteComponent() {
  const { members } = Route.useLoaderData();
  const { archived } = Route.useSearch();
  const router = useRouter();
  const addMember = useServerFn(addMemberFn);
  const setMemberArchived = useServerFn(setMemberArchivedFn);

  const addMutation = useMutation({
    mutationFn: (data: MemberInput) => addMember({ data }),
    onSuccess: async () => {
      form.reset();
      await router.invalidate({ sync: true });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (data: { email: string; archived: boolean }) =>
      setMemberArchived({ data }),
    onSuccess: () => router.invalidate({ sync: true }),
  });

  const form = useForm({
    defaultValues: { email: "" } satisfies MemberInput,
    validators: { onSubmit: Schema.toStandardSchemaV1(MemberInput) },
    onSubmit: ({ value }) => {
      void addMutation.mutateAsync(value);
    },
  });

  const failedMutation = [
    { mutation: addMutation, fallback: "Could not add the member." },
    { mutation: archiveMutation, fallback: "Could not update the member." },
  ].find(({ mutation }) => mutation.isError);
  const mutationError =
    failedMutation &&
    mutationErrorMessage(
      failedMutation.mutation.error,
      failedMutation.fallback,
    );

  return (
    <s-page heading="Members" inlineSize="large">
      <s-section heading="Add member" accessibilityLabel="Add member">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Members sign in with their email on the web member area — no Shopify
            login needed. Adding an email grants access; archiving it revokes
            access. Archived members keep their history and can be restored, and
            adding an archived email restores it. Add your own email to sign in
            yourself.
          </s-paragraph>
          {mutationError && (
            <s-banner tone="critical">{mutationError}</s-banner>
          )}
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
              <s-stack alignItems="start">
                <s-button
                  type="submit"
                  variant="primary"
                  {...(addMutation.isPending ? { loading: true } : {})}
                >
                  Add member
                </s-button>
              </s-stack>
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section heading="Members" accessibilityLabel="Members">
        <s-stack gap="base">
          <s-checkbox
            label="Show archived"
            checked={archived === true}
            onChange={() => {
              void router.navigate({
                to: "/app/members",
                search: { archived: archived === true ? undefined : true },
              });
            }}
          />
          {members.length === 0 ? (
            <s-paragraph color="subdued">
              No members yet. Add an email above to grant access.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Email</s-table-header>
                <s-table-header>Added</s-table-header>
                <s-table-header> </s-table-header>
              </s-table-header-row>
              <s-table-body>
                {members.map((member) => (
                  <s-table-row key={member.id} id={member.id}>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-300">
                        <s-text>{member.email}</s-text>
                        {member.archivedAt !== null && (
                          <s-badge tone="info">Archived</s-badge>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(member.createdAt).toLocaleDateString()}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        {...(member.archivedAt === null
                          ? { tone: "critical" as const }
                          : {})}
                        disabled={archiveMutation.isPending}
                        onClick={() => {
                          archiveMutation.mutate({
                            email: member.email,
                            archived: member.archivedAt === null,
                          });
                        }}
                      >
                        {member.archivedAt === null ? "Archive" : "Restore"}
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
