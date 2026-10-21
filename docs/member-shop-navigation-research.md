# Member sign-in and shop navigation research

Date: 2026-10-21. Status: findings and recommendations; no application changes implemented.

## Findings

The member experience has two independent issues:

1. A member with exactly one shop can land on **Your stores** after signing in, even though the default login destination skips that page. The result depends on where sign-in began.
2. Once inside a shop, members have no visible navigation back to **Your stores**. This affects members with multiple shops as well as members with one shop.

The product expectation is that most members belong to one shop, while multiple memberships remain supported. The normal path should take members directly to their work when there is no shop choice to make, and navigation must still let them change shops.

This investigation inspected application source, the installed Better Auth implementation, existing test source, and `refs/baton-legacy`. It did not inspect the reported member's email, verify their live membership count, or reproduce the interaction in a browser. The code establishes a path that explains the report; it does not establish which callback the particular email contained. Tests cited below were read, not run for this investigation.

## Current email link generation

The flow is:

1. `requireRole` in [the route guards](../src/web/routes/-guards.ts) sends a signed-out visitor to `/sign-in`, preserving the requested location as the `redirect` search parameter.
2. [The sign-in route](../src/web/routes/sign-in.tsx) validates that parameter and passes it to [SignInPage](../src/web/components/SignInPage.tsx) as `returnTo`.
3. The form submits `email` and `returnTo` through [requestMagicLink](../src/web/server/sign-in.ts).
4. `BackendApi.requestMagicLink` in [the backend API](../src/backend/api.ts) calls Better Auth with:

   ```ts
   callbackURL: returnTo ?? "/login-callback";
   errorCallbackURL: "/sign-in";
   ```

5. Better Auth's installed `node_modules/better-auth/dist/plugins/magic-link/index.mjs` constructs `/api/auth/magic-link/verify` with `token`, `callbackURL`, and `errorCallbackURL` query parameters.
6. [Auth](../src/backend/auth.ts) passes the generated URL to [MagicLinkDelivery](../src/backend/magic-link-delivery.ts). Mailed delivery places that URL unchanged in the email's text and HTML bodies.
7. [The website auth proxy](../src/web/routes/api.auth.$.ts) forwards verification to the backend and passes the redirect and session cookie back to the browser. Better Auth redirects to the callback encoded in the link.

For a sign-in initiated by visiting `/shop` while signed out, the generated URL has this shape (illustrative origin and token):

```text
https://<site>/api/auth/magic-link/verify?token=<token>&callbackURL=%2Fshop&errorCallbackURL=%2Fsign-in
```

The callback is selected when the link is requested. Shop membership is consulted later only if the callback reaches `/login-callback`.

| Entry point while signed out                                              | Callback in the generated email | Result after successful verification              |
| ------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------- |
| Public homepage's Sign in link, which opens `/sign-in` without a redirect | `/login-callback`               | Membership-aware landing                          |
| `/shop`                                                                   | `/shop`                         | Your stores, including for exactly one shop       |
| A protected workflow URL                                                  | The requested workflow URL      | Return to that workflow, subject to authorization |

[The public homepage](../src/web/components/HomePage.tsx) links directly to `/sign-in`. Existing [HTTP](../test/e2e/http.spec.ts) and [shell](../test/e2e/shell.spec.ts) test source explicitly expects the signed-out `/shop` redirect to be `/sign-in?redirect=%2Fshop`.

## Why one-shop members can see the chooser

[resolveLanding](../src/web/server/session.ts), used by [the login callback route](../src/web/routes/login-callback.tsx), fetches the signed-in user's memberships and delegates to [memberLanding](../src/web/client/session.ts):

| Memberships | Default member destination              |
| ----------- | --------------------------------------- |
| Zero        | `/shop`, with the no-access explanation |
| Exactly one | `/shop/<shop>/workflows`                |
| Multiple    | `/shop`, with the shop list             |

Admin sessions go to `/admin`. [The unit test](../test/unit/web/client/session.test.ts) covers the three member landing cases.

However, [the `/shop` index loader](../src/web/routes/shop.index.tsx) only calls `listMyShops`. It always renders [MemberHomePage](../src/web/components/MemberHomePage.tsx), which displays **Your stores** with a link for every membership. It does not redirect when there is one shop.

A member who is already signed in and opens `/sign-in` is sent to `/login-callback` by that route's `beforeLoad`, so that path already applies the landing rule. Only the emailed callback can skip it.

Consequently, an email with `callbackURL=/shop` bypasses `resolveLanding` and its single-shop rule entirely. Return-to-page support and the default landing rule are individually understandable, but disagree when the remembered page is the generic member entry point.

## Missing navigation between shops

[MemberBar](../src/web/components/MemberBar.tsx) renders above every member page. Inside a shop:

- The header title is the shop key, and its home link opens that shop's workflows list.
- The remaining controls are Help, the signed-in email, and Sign out.
- There is no Your stores link or shop switcher, regardless of membership count.

The No access state in [the shop layout](../src/web/routes/shop.$key.tsx) and [the subscription-inactive page](../src/web/components/LapsedPage.tsx) do link to Your stores. These recovery links do not provide navigation during ordinary work.

A member can use browser history when a suitable entry exists, or navigate to `/shop` manually. Neither provides a discoverable, reliable way to switch shops. This is a navigation gap for a supported membership model, rather than behavior intentionally limited to one-shop members.

## Legacy comparison

Legacy uses a simpler login flow:

- [Its member authentication middleware](../refs/baton-legacy/src/lib/MemberServerFnMiddleware.ts) redirects signed-out members to `/login` without preserving their requested page.
- [Its login handler](../refs/baton-legacy/src/routes/login.tsx), `loginFn`, always requests `callbackURL: "/login-callback"`.
- [Its callback](../refs/baton-legacy/src/routes/login-callback.tsx), `resolveLoginCallback`, sends exactly-one-shop members to workflows and zero-or-multiple-shop members to Your stores. Admins go to `/admin`.
- [Its shop index](../refs/baton-legacy/src/routes/shop.index.tsx) still displays Your stores when explicitly visited, even with one shop.

Legacy therefore avoids the inconsistent login destination by always passing through the membership-aware callback. It does not preserve workflow deep links across sign-in.

Legacy has the same navigation gap: [MemberBar](../refs/baton-legacy/src/components/MemberBar.tsx) offers Help, email, and Sign out, while [TopBar](../refs/baton-legacy/src/components/screen/TopBar.tsx) links the mark and shop name to workflows. There is no ordinary link back to the chooser. [Its member-area end-to-end test](../refs/baton-legacy/e2e/member-area.member.spec.ts) reaches Your stores by navigating directly to `/shop`.

| Concern                                          | Legacy                                   | Current project                                     |
| ------------------------------------------------ | ---------------------------------------- | --------------------------------------------------- |
| Callback generated by the login form             | Always `/login-callback`                 | Remembered destination, otherwise `/login-callback` |
| Single-shop default landing                      | Workflows                                | Workflows                                           |
| Login started at signed-out `/shop`              | Passes through membership-aware callback | Returns directly to Your stores                     |
| Specific workflow preserved across login         | No                                       | Yes                                                 |
| Visible way back to Your stores during shop work | Missing                                  | Missing                                             |

The login inconsistency comes from the current return-destination behavior. The missing shop navigation is inherited from legacy.

## Decision

Settled with the user on 2026-10-21. Most members belong to one shop, and multiple memberships stay supported. A member of one shop should never see anything about shops: no Your stores page and no link to it. Switching shops should be simple, not designed, because few members will ever use it.

This replaces the earlier recommendations here. Those recommendations were to normalize the callback in `requireRole` and keep Your stores reachable for one-shop members, with an unconditional header link.

## Implemented changes

### Your stores sends a one-shop member to their shop

[The `/shop` index loader](../src/web/routes/shop.index.tsx) applies `memberLanding`. A member of exactly one shop is redirected to that shop's workflows list, however they arrive. That includes a magic link whose callback is `/shop`, `/shop/` typed by hand, and the admin side's redirect. Callbacks need no normalization, and the guard and the Backend are unchanged. Links issued before the change behave the same way.

The earlier objection to this redirect, that an explicit Your stores link would bounce back into the shop, no longer applies. A one-shop member is never shown such a link.

### Your stores links only for a member with a choice

`hasShopChoice` in [session.ts](../src/web/client/session.ts) is true when a member belongs to more than one shop. [MemberBar](../src/web/components/MemberBar.tsx) shows **Your stores**, ahead of Help, only inside a shop and only when `hasShopChoice` holds. [The subscription-inactive page](../src/web/components/LapsedPage.tsx) follows the same rule. For a member of the lapsed shop alone, the link would send them straight back to that page.

To decide this, [the `/shop` layout](../src/web/routes/shop.tsx) reads the member's shops with `staleTime: Infinity`. It is one `myShops` read per document load, or per router invalidation, and none per navigation. Your stores still reads its own fresh list.

### Left as is

- The shop title in the header, which names the shop and opens its workflows list.
- The No access page's Your stores link. In every case it leads somewhere useful: the no-access explanation for a member with no shops, their own shop for a member with one, and the list for a member with several.
- No shop dropdown.

## Verification

Run on 2026-10-21. `vp check` passes.

- Browser tests: [MemberBar](../test/browser/web/components/MemberBar.test.tsx) shows Your stores for a member of two shops and not for a member of one. [LapsedPage](../test/browser/web/components/LapsedPage.test.tsx) is covered both with and without the link.
- E2E, using [http](../test/e2e/http.spec.ts), [shell](../test/e2e/shell.spec.ts), shop and sign-in, 21 tests passed. A one-shop member requesting `/shop` gets a redirect to `/shop/<shop>/workflows`. `/admin` ends at that member's workflows list. Inside the shop there is no Your stores link.
- Not run: the full e2e suite. There is no e2e coverage for a member of several shops, because the e2e environment has one store.
