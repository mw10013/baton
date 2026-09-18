# Shopify App Pricing plans for Baton: what to configure and what actually gates access

Research date: 2026-09-18. Scope: which plans to create in the Partner Dashboard for the
`baton-local` app, whether separate test plans are needed, how plan switching gets tested
without paying, and what does and does not restrict which shops can use the app.

Every Shopify claim below cites `refs/shopify-docs` by path and line so it can be checked
without leaving the repo. Every code claim cites `src/` by path and line, checked against the
tree on 2026-09-18. §8 separates what is documented from what is inferred from what is unknown;
read it before acting on anything here.

**Status: research. The Partner Dashboard configuration described in §6 was performed during
this session. No code changed.**

## Result

1. **Two public plans, `baton-basic` and `baton-pro`.** Created. This is the merchant-facing
   catalog and also the only way to test switching between tiers. §6.
2. **You do not need to build your own test plans.** Shopify ships one, `shopify-test`, in the
   Private plans section, and same-organization dev stores get the real public plans at $0
   anyway. Bang's hand-made `bang-basic-test` / `bang-pro-test` are the pre-April-2026 pattern.
   §4, §5.
3. **There is no store allowlist for a public app, and the pricing allowlist is not one.**
   "Stores with plan access" controls who can _see one private plan_. It has nothing to do with
   who can install or use the app. §2, §3.
4. **What keeps outside shops out is that the listing is not published.** Not a setting you
   fill in. The only real store-scoped allowlist Shopify offers is Custom distribution, which
   cannot use Shopify billing at all, so it is unavailable to Baton. §3.
5. **One fix outstanding on the Partner site:** `shopify-test` has Redirect URL `/`. It should
   be `/app`. §6.
6. **Code consequences are deferred and not decided here.** If `shopify-test` is kept as a
   usable plan, `Domain.PlanHandle` has to accept it. §7.

## 1. Observed state of Baton Local

From the Partner Dashboard on 2026-09-18, app **Baton Local** (`baton-local`, Partner org
`2798461`, app id `417214922753`):

- Shopify App Pricing is enabled. The header shows "Draft and test plans" and "App Pricing
  enabled" both checked.
- Public plans: was 0/8, now 2/8.
  - `baton-basic` — invoice name `Basic`, redirect `/app`, monthly recurring, $29, 14-day free
    trial, "Free for partners and developers" unchecked, no usage charges.
  - `baton-pro` — invoice name `Pro`, redirect `/app`, monthly recurring, $79, trial 0, "Free
    for partners and developers" unchecked, no usage charges.
- Pricing details (listing copy): display names `Basic` and `Pro`, two top features each
  ("Up to 250 orders a month." / "3 team members." and "Up to 1,000 orders a month." /
  "10 team members."). The optional external pricing URL is blank. The checkbox "I have
  approval to charge merchants outside of the Shopify Billing API" is unchecked, which is
  correct — that is for charging outside Shopify's billing system and requires Shopify's
  approval.
- Private plans: 1/16, `shopify-test`, $0/month. Invoice name `Shopify Test` and handle
  `shopify-test` are both locked by Shopify. Display name `Test plan`. Redirect URL `/`.
  Stores with plan access, added during this session: `sandbox-shop-01.myshopify.com` and
  `stress-shop-01.myshopify.com`.

Both of those stores are the same ones `package.json` drives (`app:dev` uses
`sandbox-shop-01`, `app:dev:stress` uses `stress-shop-01`) and both belong to Partner org
`2798461`, the same organization that owns the app. That relationship is what makes §4 work.

## 2. Three different questions get called "access"

They have three different answers and conflating them is where the confusion came from.

**Who can install the app.** Governed by distribution method and listing publication. Not by
anything in the pricing screens.

**Who can see a given plan.** Public plans are visible to everyone by definition
(`refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing/plans.md:13`, `plans.md:19`). Private plans
are visible only to the stores listed in "Stores with plan access" — up to 15 private plans,
up to 20 stores each (`plans.md:62`). This is the only allowlist in the
pricing area, and its scope is plan visibility on the selection page.

**Who gets into the app once installed.** Baton's own subscription gate: `/app` resolves the
shop's plan and redirects to the plan selection page when there is no recognized active
contract (`src/routes/app.tsx:101-104`). The WebSocket connect performs the same check.

## 3. Why there is no store allowlist for a public app

Distribution is chosen once and cannot be changed afterward
(`refs/shopify-docs/docs/apps/launch/distribution/select-distribution-method.md:16`). Two
options exist for a new app:

- **Public distribution** — installable on many stores, requires Shopify review, and is the
  only method that can charge through Shopify's billing system.
- **Custom distribution** — installable on one store, or on multiple stores in a single Plus
  organization, via a generated install link. This is a genuine store allowlist. It is also
  documented as unable to charge merchants through Shopify's app billing system at all
  (`refs/shopify-docs/docs/apps/launch/distribution.md:26`).

So the one mechanism that would give a store allowlist is mutually exclusive with App Pricing.
Baton bills through App Pricing, therefore Baton is public distribution, therefore no store
allowlist exists for it.

What keeps unknown shops out today is that the App Store listing has not been submitted or
published. Development-store installs are driven from the dashboard's **Install app** action,
where you choose the store
(`refs/shopify-docs/docs/apps/launch/app-store-review/pass-app-review.md:41-53`), or through
Shopify CLI. See §8 for the limits of what is documented here versus inferred.

## 4. Testing at $0: two independent mechanisms

**Mechanism A — same-organization dev stores get every plan free.** The documented table
(`refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing.md:99-107`):

| App and dev store relationship  | Plans available at no charge                                 |
| ------------------------------- | ------------------------------------------------------------ |
| Same Partner organization       | Every plan available to the store                            |
| Different Partner organizations | Free plans, and paid plans the Partner marks as free to test |

Selecting a paid plan this way creates a real subscription contract with $0 effective prices
for its recurring and usage items (`shopify-app-pricing.md:109-110`). Restated from the dev
store side at `refs/shopify-docs/docs/apps/build/stores/development-stores.md:134`.

`sandbox-shop-01` and `stress-shop-01` are in org `2798461`; so is `baton-local`. Both public
plans are therefore already $0 on both stores, with no configuration.

The "Free for partners and developers" checkbox is a different thing: it lets _other_ Partners
select your paid plan at no charge on _their_ dev stores
(`shopify-app-pricing.md:112-114`, `plans.md:35`). Irrelevant here, correctly left unchecked.

**Mechanism B — the built-in private test plan.** "Shopify App Pricing includes a $0 private
test plan that you can use to configure and test your billing integration before you publish a
plan or when you want to limit testing to specific stores. The test plan is available in the
Private plans section" (`shopify-app-pricing.md:116-118`). Fixed pricing, $0/month subscription
and $0/unit usage, per the notice in its own editor.

The two mechanisms overlap. Mechanism A covers more: it is the only one that can exercise
switching between tiers, trials, and entitlement differences, because it uses the real plans.
Mechanism B covers one thing A does not: a contract that is explicitly restricted to named
stores.

## 5. Why Bang's test plans are not the model to copy

`refs/bang/README.md:56-66` defines `bang-basic-test` and `bang-pro-test` as private free plans
allowlisted to the same two dev stores, and `refs/bang/e2e/plan.spec.ts:48-53` drives the
pricing page by those plans' display names. Its header comment explains the reasoning: the dev
store is allowlisted for the private `-test` plans, so every charge is a free test charge.

That was built against the older model. Shopify states that before April 28, 2026, App Pricing
created test subscriptions when a development store selected a plan, and directs current
development-store testing to the no-charge options in §4
(`refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing.md:442`).

Baton's own decision record already reached this conclusion independently:
`docs/limits-and-plans-plan.md:572-575`, accepted 2026-09-17, recommends dropping
`baton-basic-test` / `baton-pro-test` because same-org dev stores get public plans at $0.

Two things worth carrying over from Bang's e2e work regardless of plan shape, both from the
header of `refs/bang/e2e/plan.spec.ts`:

- Shopify guards the pricing page with a Cloudflare bot-verification interstitial that
  challenges automated sessions, most readily headless ones and more readily after several
  plan changes in a short window. It cannot be solved programmatically. Run plan tests headed,
  serially, and not in a tight loop.
- A plan test mutates the shared dev store's real subscription, so it must restore the starting
  plan in a `finally` or a mid-test failure leaves the store on the wrong tier.

## 6. The configuration for `baton-local`

Done:

- `baton-basic` and `baton-pro` as public plans, values in §1.
- Display names and top features for the published locale. A plan renders on the selection page
  only if it has a description in the current language (`plans.md:52`).
- `shopify-test` allowlisted to the two dev stores.

Outstanding:

- **Set `shopify-test`'s Redirect URL to `/app`.** It is currently `/`. Shopify appends the
  `plan_handle` parameter to all redirect URLs
  (`refs/shopify-docs/docs/apps/launch/billing/shopify-app-pricing.md:92`), and `/app` is the
  route that reads it: `src/routes/app.tsx:129-138` treats any `plan_handle` in the search
  string as the billing redirect and forces a fresh Partner API read instead of trusting the
  24-hour cache. A redirect to `/` lands on the public landing page and that refresh never
  fires. The field appeared editable in the plan editor while name and handle were locked; see
  §8.

Not needed:

- No yearly option. Usage-based charges, if ever added, must be billed monthly
  (`shopify-app-pricing.md:346`).
- No usage meters on either plan.
- No external pricing URL.
- The "approval to charge outside the Shopify Billing API" checkbox stays unchecked.

Plans belong to an app, so this whole exercise repeats for `baton-staging` and for the
production app when those exist. Both currently have an empty `SHOPIFY_PARTNER_APP_ID` in
`wrangler.jsonc`, so neither app has been created.

## 7. Code consequences, not decided here

Stated as consequences, not recommendations. The decision about what the code should look like
was explicitly deferred.

`src/lib/Domain.ts:42-47` declares the accepted handles as `baton-basic`, `baton-pro`,
`baton-basic-test`, `baton-pro-test`. The handle Shopify reports for a contract is decoded
against that list at `src/lib/ShopifyPartner.ts:167-180`; an unrecognized handle is dropped,
logged as "contract carries no single known plan handle", and returned as `Option.none()`.
That becomes `Unsubscribed` at `src/lib/SubscriptionPlan.ts:259-260`, which `/app` turns into a
redirect back to the plan selection page at `src/routes/app.tsx:101-104`.

Therefore, as the tree stands: a shop subscribed to `shopify-test` is bounced from `/app` back
to the pricing page. Making that plan usable means adding `"shopify-test"` to
`Domain.PlanHandle` and deciding which tier `planOfHandle` maps it to. The two `baton-*-test`
handles are separately slated for removal by `docs/limits-and-plans-plan.md:96`.

Turning billing on at all is `BILLING_ENABLED` in `wrangler.jsonc`, currently `"false"` in all
three environments. While false, `SubscriptionPlan` grants every shop
`Domain.DEFAULT_PLAN_HANDLE` without a Partner API call and every downstream gate passes.

## 8. Verified, inferred, unknown

**Documented in `refs/shopify-docs`, quoted above with line numbers:** the $0 testing table and
its same-org rule; the $0 effective-price contract; the built-in private test plan; the
"free for partners and developers" semantics; private plan visibility, the 15-plan and
20-store limits; `plan_handle` appended to all redirect URLs; the per-language description
requirement; distribution methods, their permanence, and custom distribution's inability to use
Shopify billing; the April 28, 2026 removal of legacy test subscriptions; the dev-store install
procedure.

**Observed in the Partner Dashboard this session, not from documentation:** everything in §1,
including that `shopify-test`'s name and handle are locked while its redirect URL, display name,
description and store list are editable. Screenshots only; no second source.

**Inferred, not found stated in the docs:** that an unpublished public app cannot be installed
by an arbitrary merchant. The reasoning is that a public app reaches merchants through the
Shopify App Store listing, review is required before publication, and the documented install
path for a pre-review app is the dashboard's Install app action against a development store.
No line in `refs/shopify-docs` says outright "an unpublished app cannot be installed by other
stores". Treat this as the load-bearing assumption of §3 and verify it before relying on it as
a security boundary.

**Unknown:** whether Shopify permits saving the built-in `shopify-test` plan with an empty
store list; whether the `shopify-test` handle is stable across apps and organizations, or
whether it varies; whether a 14-day trial on `baton-basic` still applies on a $0 same-org dev
store contract, which decides whether `ActiveSubscription.boundaryAt` arrives from
`trialEndsAt` or `currentBillingCycle.endTime` on the first test; whether the draft-app locale
404 (`shopify-app-pricing.md:349`) affects `sandbox-shop-01`.

## 9. Next steps

1. Set `shopify-test`'s Redirect URL to `/app`.
2. Decide whether `shopify-test` is part of the testing story. If yes, the code must accept the
   handle; if no, remove the two stores from its access list so the card stops appearing.
3. Confirm `SHOPIFY_PARTNER_API_TOKEN` is present in `.env`.
4. Set `BILLING_ENABLED` to `"true"` in the local `vars` block of `wrangler.jsonc`.
5. Run against `sandbox-shop-01`, confirm the redirect to the plan selection page, select
   Basic, approve, confirm the return to `/app` and that `/admin/shop/<shop>` shows
   `baton-basic`. The plan cache is 24 hours; use that page's refresh button rather than
   waiting.
6. Switch to Pro and back to exercise both directions. Headed and serial, per §5.
7. Record what the trial did on the $0 contract, closing the open question in §8.
