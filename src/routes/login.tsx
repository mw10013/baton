import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn, useServerFn } from "@tanstack/react-start";
import { Config, Effect, Schema } from "effect";

import { BatonMark } from "@/components/screen/BatonMark";
import { FootLine } from "@/components/screen/FootLine";
import { Inline } from "@/components/screen/Inline";
import { Things } from "@/components/screen/Things";
import { Auth, magicLinkKvKey } from "@/lib/Auth";
import { CloudflareEnv } from "@/lib/CloudflareEnv";
import { CurrentRequest } from "@/lib/CurrentRequest";
import * as Domain from "@/lib/Domain";
import { fieldError, mutationErrorMessage } from "@/lib/form";
import { KV } from "@/lib/KV";
import { Repository } from "@/lib/Repository";

interface LoginLoaderData {
  readonly isDemoMode: boolean;
}

const getLoaderData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.map(
        Config.Boolean("DEMO_MODE").pipe(Config.withDefault(false)),
        (isDemoMode) => ({ isDemoMode }) satisfies LoginLoaderData,
      ),
    ),
);

type LoginResult =
  | { readonly ok: true; readonly magicLink: string | null }
  | { readonly ok: false; readonly error: string };

/**
 * The invite gate runs before the send: an email with no `Member` row (and not
 * in `ADMIN_EMAILS`) gets the same "check your email" response with no link ever issued, so the form
 * cannot be used to enumerate members (`databaseHooks.user.create.before` in
 * `Auth.ts` is the authoritative backstop). Better-auth awaits
 * `sendMagicLink` before resolving, so by the time `signInMagicLink` returns,
 * the URL is already cached in KV; the demo-mode read-back below can never
 * race it. Real mode simply stops returning the link.
 */
const loginFn = createServerFn({ method: "POST" })
  .validator(Schema.toStandardSchemaV1(Domain.LoginInput))
  .handler(({ data, context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const env = yield* CloudflareEnv;
        const request = yield* CurrentRequest;
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = yield* Effect.promise(() =>
          env.LOGIN_LIMITER.limit({ key: `login:${ip}` }),
        );
        if (!success)
          return {
            ok: false,
            error: "Too many attempts. Try again later.",
          } as const satisfies LoginResult;
        const auth = yield* Auth;
        const repository = yield* Repository;
        const shops = yield* repository.listMemberShops(data.email);
        if (shops.length === 0 && !auth.isAdminEmail(data.email)) {
          yield* Effect.logInfo(
            `login: email=${data.email}: no membership, link not sent`,
          ).pipe(Effect.annotateLogs({ email: data.email }));
          return { ok: true, magicLink: null } as const satisfies LoginResult;
        }
        yield* auth.signInMagicLink({
          headers: request.headers,
          email: data.email,
          callbackURL: "/login-callback",
        });
        const isDemoMode = yield* Config.Boolean("DEMO_MODE").pipe(
          Config.withDefault(false),
        );
        const kv = yield* KV;
        const magicLink = isDemoMode
          ? yield* kv.get(magicLinkKvKey(data.email))
          : null;
        return { ok: true, magicLink } as const satisfies LoginResult;
      }),
    ),
  );

export const Route = createFileRoute("/login")({
  loader: () => getLoaderData(),
  head: () => ({ meta: [{ title: "Sign in — Baton" }] }),
  component: RouteComponent,
});

function RouteComponent() {
  const { isDemoMode } = Route.useLoaderData();
  const login = useServerFn(loginFn);
  const loginMutation = useMutation({
    mutationFn: (data: typeof Domain.LoginInput.Encoded) => login({ data }),
  });
  const form = useForm({
    defaultValues: { email: "" },
    validators: { onSubmit: Schema.toStandardSchemaV1(Domain.LoginInput) },
    onSubmit: ({ value }) => {
      void loginMutation.mutateAsync(value);
    },
  });

  const sent = loginMutation.isSuccess && loginMutation.data.ok;
  const failedResult =
    loginMutation.isSuccess && !loginMutation.data.ok
      ? loginMutation.data.error
      : undefined;
  const resultError =
    failedResult ??
    (loginMutation.isError
      ? mutationErrorMessage(
          loginMutation.error,
          "Couldn't send the sign-in link.",
        )
      : undefined);

  return (
    <s-page heading="Sign in" inlineSize="small">
      <s-section accessibilityLabel="Baton">
        <Inline>
          <BatonMark size={32} />
          {/* The semantic `<strong>` only: the wordmark beside the logo,
              not a heading over the form. */}
          <s-text type="strong">Baton</s-text>
        </Inline>
      </s-section>
      {sent ? (
        <s-section heading="Check your email">
          <Things>
            <s-paragraph color="subdued">
              If that email has access to a shop, a sign-in link has been sent.
            </s-paragraph>
            {loginMutation.data.ok && loginMutation.data.magicLink && (
              <s-link href={loginMutation.data.magicLink}>
                Open your sign-in link
              </s-link>
            )}
          </Things>
        </s-section>
      ) : (
        <s-section heading="Sign in" accessibilityLabel="Sign in">
          <Things>
            <s-paragraph color="subdued">
              {isDemoMode
                ? "Demo mode: no emails are sent. The sign-in link appears here after you press Send sign-in link."
                : "Enter your email to receive a sign-in link."}
            </s-paragraph>
            {resultError && <s-banner tone="critical">{resultError}</s-banner>}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
              }}
            >
              <Things>
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
                <Inline>
                  <s-button
                    type="submit"
                    variant="primary"
                    {...(loginMutation.isPending ? { loading: true } : {})}
                  >
                    Send sign-in link
                  </s-button>
                </Inline>
              </Things>
            </form>
            {/* Not on "Check your email": that state's one job is the link
                in the email. */}
            <FootLine>
              Learn more in{" "}
              <s-link href="/help/members/signing-in">Signing in</s-link>.
            </FootLine>
          </Things>
        </s-section>
      )}
    </s-page>
  );
}
