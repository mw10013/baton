import { NumberedList } from "../../screen/NumberedList.tsx";
import { Things } from "../../screen/Things.tsx";

/**
 * Signing in (`members/signing-in`): the sign-in link, Your stores, Sign out,
 * and the lapsed sentence. Read against `SignInPage` (the form and
 * its "Check your email" answer, the same for an email nobody added),
 * `MAGIC_LINK_TTL_SECONDS` (five minutes),
 * the sign-in callback (one shop goes straight to its Workflows
 * list, more go to Your stores), `MemberHomePage` and
 * the member's lapsed page.
 */
export function SigningIn() {
  return (
    <>
      <s-section heading="Sign in with your email">
        <Things>
          <s-paragraph>
            Baton has no password. You sign in with the email the merchant added you with, and a
            link sent to it.
          </s-paragraph>
          <NumberedList
            items={[
              <>
                On the <strong>Sign in</strong> page, enter your email and press{" "}
                <strong>Send link</strong>.
              </>,
              <>
                Open the email from Baton and press its <strong>Sign in</strong> link. The link
                works for five minutes. After that, send another.
              </>,
            ]}
          />
          <s-paragraph>
            If no email arrives, the merchant may have added a different address. Ask them which one
            is on their Members page.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Choose a store">
        <Things>
          <s-paragraph>
            If you work for one store, the link opens its Workflows list. If you work for more than
            one, it opens <strong>Your stores</strong>: press a store to see its work. Each
            store&apos;s merchant adds you separately.
          </s-paragraph>
          <s-paragraph>
            If a store&apos;s Baton subscription is not active, the store reads{" "}
            <strong>Subscription inactive</strong> and its workflows are unavailable until the
            merchant renews it.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Sign out">
        <s-paragraph>
          Press <strong>Sign out</strong> at the top of any screen. On a tablet the whole team
          shares, sign out when you leave: the email at the top is the name every Start and Done
          shows.
        </s-paragraph>
      </s-section>
    </>
  );
}
