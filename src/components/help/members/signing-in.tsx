import { NumberedList } from "@/components/screen/NumberedList";
import { Things } from "@/components/screen/Things";

/**
 * Signing in (`members/signing-in`): the magic link, Your stores, Sign out,
 * and the lapsed sentence. Read against `src/routes/login.tsx` (the form and
 * its "Check your email" answer, the same for an email nobody added),
 * `MAGIC_LINK_EXPIRES_IN_SECONDS` in `src/lib/Auth.ts` (five minutes),
 * `src/routes/login-callback.tsx` (one shop goes straight to its Workflows
 * list, more go to Your stores), `src/routes/shop.index.tsx` and
 * `src/routes/shop.$shop_.lapsed.tsx`.
 */
export function SigningIn() {
  return (
    <>
      <s-section heading="Sign in with your email">
        <Things>
          <s-paragraph>
            Baton has no password. You sign in with the email the merchant added
            you with, and a link sent to it.
          </s-paragraph>
          <NumberedList
            items={[
              <>
                On the <strong>Sign in</strong> page, enter your email and press{" "}
                <strong>Send magic link</strong>.
              </>,
              <>
                Open the email from Baton and press its <strong>Sign in</strong>{" "}
                link. The link works for five minutes. After that, send another.
              </>,
            ]}
          />
          <s-paragraph>
            If no email arrives, the merchant may have added a different
            address. Ask them which one is on their Members page.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Choose a store">
        <Things>
          <s-paragraph>
            If you work for one store, the link opens its Workflows list. If you
            work for more than one, it opens <strong>Your stores</strong>: press
            a store to see its work. Each store&apos;s merchant adds you
            separately.
          </s-paragraph>
          <s-paragraph>
            If a store&apos;s Baton subscription is not active, the store reads{" "}
            <strong>Subscription inactive</strong> and its workflows are
            unavailable until the merchant renews it.
          </s-paragraph>
        </Things>
      </s-section>
      <s-section heading="Sign out">
        <s-paragraph>
          Press <strong>Sign out</strong> at the top of any screen. On a tablet
          the whole team shares, sign out when you leave: the email at the top
          is who every Start and Done is recorded for.
        </s-paragraph>
      </s-section>
    </>
  );
}
