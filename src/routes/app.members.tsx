import * as React from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { Repository } from "@/lib/Repository";
import { shopifyServerFnMiddleware } from "@/lib/ShopifyServerFnMiddleware";

const MemberInput = Schema.Struct({
  email: Schema.String.check(
    Schema.isNonEmpty({ message: "Email is required" }),
  ),
});
type MemberInput = typeof MemberInput.Type;

const MemberEmailInput = Schema.Struct({ email: Schema.String });

const decodeEmail = Schema.decodeUnknownEffect(Domain.Email);

const sessionShop = (shop: string) =>
  Schema.decodeUnknownEffect(Domain.Shop)(shop);

/** See the teams list route for why tagged failures are replaced by copy. */
const failWith = (message: string) => () => Effect.fail(new Error(message));

const MEMBER_GONE = "That member no longer exists.";

const getLoaderData = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        const repository = yield* Repository;
        return {
          members: yield* repository.listMembers(shop),
          soleMemberships: yield* repository.listSoleMemberships(shop),
        } satisfies Domain.MembersLoaderData;
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

function RouteComponent() {
  const { members, soleMemberships } = Route.useLoaderData();
  const router = useRouter();
  const addMember = useServerFn(addMemberFn);
  const deleteMember = useServerFn(deleteMemberFn);
  /** Which member's delete is awaiting its inline confirmation. */
  const [confirming, setConfirming] = React.useState<Domain.MemberId | null>(
    null,
  );

  const addMutation = useMutation({
    mutationFn: (data: MemberInput) => addMember({ data }),
    onSuccess: async () => {
      form.reset();
      await router.invalidate({ sync: true });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (email: string) => deleteMember({ data: { email } }),
    onSuccess: async () => {
      setConfirming(null);
      await router.invalidate({ sync: true });
    },
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
    { mutation: deleteMutation, fallback: "Could not delete the member." },
  ].find(({ mutation }) => mutation.isError);
  const mutationError =
    failedMutation &&
    mutationErrorMessage(
      failedMutation.mutation.error,
      failedMutation.fallback,
    );

  /** The teams this member is the only person on: the delete would empty them. */
  const emptiedTeams = (member: Domain.Member) =>
    soleMemberships
      .filter((row) => row.memberId === member.id)
      .map((row) => row.teamName);

  const confirmRow = (member: Domain.Member) => {
    const emptied = emptiedTeams(member);
    return (
      <s-table-row key={`${member.id}-confirm`} id={`${member.id}-confirm`}>
        <s-table-cell>
          <s-banner
            tone={emptied.length > 0 ? "warning" : "critical"}
            heading={`Delete ${member.email}?`}
          >
            <s-stack gap="small-300">
              <s-paragraph>
                {emptied.length > 0
                  ? `They leave their teams and can no longer sign in. This will leave ${emptied.join(", ")} with no members.`
                  : "They leave their teams and can no longer sign in. Their past work stays on the record."}
              </s-paragraph>
              <s-stack direction="inline" gap="small-300">
                <s-button
                  variant="primary"
                  tone="critical"
                  {...(deleteMutation.isPending ? { loading: true } : {})}
                  onClick={() => {
                    deleteMutation.mutate(member.email);
                  }}
                >
                  Delete
                </s-button>
                <s-button
                  variant="tertiary"
                  onClick={() => {
                    setConfirming(null);
                  }}
                >
                  Cancel
                </s-button>
              </s-stack>
            </s-stack>
          </s-banner>
        </s-table-cell>
        <s-table-cell> </s-table-cell>
        <s-table-cell> </s-table-cell>
      </s-table-row>
    );
  };

  return (
    <s-page heading="Members" inlineSize="large">
      <s-section heading="Add member" accessibilityLabel="Add member">
        <s-stack gap="base">
          <s-paragraph color="subdued">
            Members sign in with their email on the web member area — no Shopify
            login needed. Adding an email grants access; deleting a member
            removes them from their teams and revokes access. Their past work
            stays on the record under their email. Add your own email to sign in
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
                {members.flatMap((member) => [
                  <s-table-row key={member.id} id={member.id}>
                    <s-table-cell>
                      <s-text>{member.email}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {new Date(member.createdAt).toLocaleDateString()}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          setConfirming(member.id);
                        }}
                      >
                        Delete
                      </s-button>
                    </s-table-cell>
                  </s-table-row>,
                  ...(confirming === member.id ? [confirmRow(member)] : []),
                ])}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
