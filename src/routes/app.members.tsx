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

const decodeEmail = Schema.decodeUnknownEffect(Domain.Email);

const sessionShop = (shop: string) =>
  Schema.decodeUnknownEffect(Domain.Shop)(shop);

const getMembers = createServerFn({ method: "GET" })
  .middleware([shopifyServerFnMiddleware])
  .handler(({ context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const shop = yield* sessionShop(session.shop);
        return { members: yield* (yield* Repository).listMembers(shop) };
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

const removeMemberFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(MemberInput))
  .middleware([shopifyServerFnMiddleware])
  .handler(({ data, context: { runEffect, session } }) =>
    runEffect(
      Effect.gen(function* () {
        const repository = yield* Repository;
        yield* repository.deleteMember({
          shop: yield* sessionShop(session.shop),
          email: yield* decodeEmail(data.email),
        });
      }),
    ),
  );

export const Route = createFileRoute("/app/members")({
  loader: () => getMembers(),
  component: RouteComponent,
});

function RouteComponent() {
  const { members } = Route.useLoaderData();
  const router = useRouter();
  const addMember = useServerFn(addMemberFn);
  const removeMember = useServerFn(removeMemberFn);

  const addMutation = useMutation({
    mutationFn: (data: MemberInput) => addMember({ data }),
    onSuccess: async () => {
      form.reset();
      await router.invalidate({ sync: true });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (email: string) => removeMember({ data: { email } }),
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
    { mutation: removeMutation, fallback: "Could not remove the member." },
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
            login needed. Adding an email grants access; removing it revokes
            access. Add your own email to sign in yourself.
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
                  <s-table-cell>{member.email}</s-table-cell>
                  <s-table-cell>
                    {new Date(member.createdAt).toLocaleDateString()}
                  </s-table-cell>
                  <s-table-cell>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      disabled={removeMutation.isPending}
                      onClick={() => {
                        removeMutation.mutate(member.email);
                      }}
                    >
                      Remove
                    </s-button>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}
