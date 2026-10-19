import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { type Email, EmailFromInput, type ReturnPath } from "../../contract/auth.ts";
import { fieldError, schemaForm } from "./form.ts";
import type { MagicLinkResult } from "../server/sign-in.ts";
import { useNavigateOnClick } from "./navigate.ts";
import { FootLine } from "./screen/FootLine.tsx";
import { Inline } from "./screen/Inline.tsx";
import { Things } from "./screen/Things.tsx";

const SignInForm = schemaForm(Schema.Struct({ email: EmailFromInput }));

/** Copy for a request that did not go through; follows the copy rules on `RootDocument`. */
const SOMETHING_WENT_WRONG = "Something went wrong. Try again.";
const TOO_MANY_ATTEMPTS = "Too many attempts. Try again in a minute.";

/** The page's state after a submit: the answer, or the copy for a request that failed. */
type Outcome =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Sending" }
  | { readonly _tag: "Sent"; readonly link: string | undefined }
  | { readonly _tag: "Failed"; readonly message: string };

/**
 * Requests a magic link for an address. The reply is the same whether or not the address is a
 * member, so the page never says which. Under `alchemy dev` the answer carries the link, which
 * the page shows in place of the email.
 */
export default function SignInPage({
  returnTo,
  error,
  requestMagicLink,
}: {
  returnTo: ReturnPath | undefined;
  error: string | undefined;
  requestMagicLink: (input: {
    readonly email: Email;
    readonly returnTo: ReturnPath | undefined;
  }) => Promise<MagicLinkResult>;
}) {
  const [outcome, setOutcome] = useState<Outcome>({ _tag: "Idle" });
  const navigate = useNavigateOnClick();

  const form = useForm({
    defaultValues: { email: "" },
    ...SignInForm.options,
    onSubmit: async ({ value }) => {
      setOutcome({ _tag: "Sending" });
      const next = await requestMagicLink({ email: SignInForm.decode(value).email, returnTo }).then(
        (result): Outcome =>
          Match.valueTags(result, {
            Sent: ({ link }): Outcome => ({ _tag: "Sent", link }),
            TooManyRequests: (): Outcome => ({ _tag: "Failed", message: TOO_MANY_ATTEMPTS }),
          }),
        (): Outcome => ({ _tag: "Failed", message: SOMETHING_WENT_WRONG }),
      );
      setOutcome(next);
    },
  });

  const signInForm = (failure: string | undefined) => (
    <s-section accessibilityLabel="Sign in">
      <Things>
        <s-paragraph color="subdued">We'll email you a sign-in link.</s-paragraph>
        {error !== undefined && (
          <s-banner tone="critical" heading="That link didn't work. Request a new one." />
        )}
        {failure !== undefined && <s-banner tone="critical" heading={failure} />}
        <form
          noValidate
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
                  onInput={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                />
              )}
            </form.Field>
            <Inline>
              <s-button
                type="submit"
                variant="primary"
                {...(outcome._tag === "Sending" ? { loading: true } : {})}
              >
                Send link
              </s-button>
            </Inline>
          </Things>
        </form>
        {/* Not on "Check your email": that state's one job is the link in the email. */}
        <FootLine>
          Learn more in <s-link {...navigate("/help/members/signing-in")}>Signing in</s-link>.
        </FootLine>
      </Things>
    </s-section>
  );

  return (
    <s-page heading="Sign in" inlineSize="small">
      {Match.valueTags(outcome, {
        Idle: () => signInForm(undefined),
        Sending: () => signInForm(undefined),
        Failed: ({ message }) => signInForm(message),
        Sent: ({ link }) => (
          <s-section heading="Check your email">
            <Things>
              <s-paragraph color="subdued">The link expires in 5 minutes.</s-paragraph>
              {link !== undefined && (
                // A plain link, not a router navigation: the verify route is a server route.
                <s-link href={link}>Open link</s-link>
              )}
            </Things>
          </s-section>
        ),
      })}
    </s-page>
  );
}
