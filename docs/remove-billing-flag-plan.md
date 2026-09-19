# Remove `BILLING_ENABLED`: implementation plan

Hand-off for an implementer. Self-contained; the reasoning is in
`docs/plan-limits-and-downgrade-research.md` §7 and does not need re-reading.

**Status: implemented** on 2026-09-19 against HEAD `0444dd5`; working tree left uncommitted for review.

## 0. Why

`BILLING_ENABLED` was added when Baton had no App Pricing plans. Plans now exist for the local
app and will be created for staging and production when those apps are created. The flag is
`"true"` in all three environments, while the comment beside it in `wrangler.jsonc` and the
README still describe it as `"false"`. A production var that grants every shop the widest tier
without a Partner API call is a standing risk with no remaining purpose. Remove it entirely;
do not replace it with another switch.

Staging and production have an empty `SHOPIFY_PARTNER_APP_ID`. That is expected: those
environments are not deployed and their apps do not exist yet. Do not fill them in and do not
add fallbacks for them.

## 1. Rules for the implementer

1. **No migration files, no schema changes.** This change touches no SQL.
2. **Effect idioms.** Copy the surrounding style of each file.
3. **JSDoc carries its reasoning inline and never references `docs/`.** When a JSDoc paragraph
   about the flag is removed, do not leave a sentence that only makes sense with it.
4. **Run after the change:** `pnpm typecheck` (regenerates `worker-configuration.d.ts`; do not
   edit that file by hand), `pnpm lint`, `pnpm test`, `pnpm fmt` repo-wide keeping every file it
   touches.
5. **Do not commit.** Leave the working tree for review.
6. **Record deviations** in §6 as you go.

## 2. Inventory

Every site that names the flag or exists only because of it. Verified with
`grep -rn "BILLING_ENABLED\|DEFAULT_PLAN_HANDLE" src test e2e README.md wrangler.jsonc .env.example`.

| File                                         | What is there                                                                                                        | Action                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `src/lib/SubscriptionPlan.ts`                | `Config.boolean("BILLING_ENABLED")` branch in `layerNoDeps`, its JSDoc, `Config.ConfigError` in the layer type       | Remove the branch, JSDoc, and error type   |
| `src/lib/Domain.ts`                          | `DEFAULT_PLAN_HANDLE` and its JSDoc; a paragraph in the `PlanHandle` JSDoc                                           | Remove the constant; rewrite the paragraph |
| `src/lib/MemberAccess.ts`                    | Last two sentences of the `requireMember` JSDoc                                                                      | Rewrite                                    |
| `src/routes/app.index.tsx`                   | Loader JSDoc mentions the flag; a JSX comment about not claiming the flag's state                                    | Rewrite both                               |
| `test/integration/vitest.config.ts`          | Comment and the `BILLING_ENABLED: "true"` binding                                                                    | Remove both                                |
| `test/integration/member-fixtures.ts`        | `seedShop` JSDoc mentions the flag; seeds `Domain.DEFAULT_PLAN_HANDLE`                                               | Rewrite JSDoc; use a local fixture handle  |
| `test/integration/worker-agent-gate.test.ts` | JSDoc on the lapsed-member test says "while `BILLING_ENABLED` is off in production"                                  | Rewrite                                    |
| `wrangler.jsonc`                             | Comment block and `"BILLING_ENABLED": "true"` in the top-level `vars`, `env.staging.vars`, and `env.production.vars` | Remove all three plus the comment          |
| `.env.example`                               | `# Only needed when BILLING_ENABLED is "true".` above `SHOPIFY_PARTNER_API_TOKEN`                                    | Rewrite the comment                        |
| `README.md`                                  | Paragraph under "Billing" describing the flag; step 3 of "Turning billing on"                                        | Remove the paragraph; renumber the steps   |

`MAX_ENTITLEMENTS` stays. It is "the widest tier as a ceiling" for fixtures with no shop and no
plan, and has nothing to do with the flag. `Domain.PlanHandle`, `planOfHandle`, `ENTITLEMENTS`,
and every gate stay exactly as they are.

## 3. Steps

### 3.1 `src/lib/SubscriptionPlan.ts`

In `layerNoDeps`:

- Delete the JSDoc block above `static readonly layerNoDeps` that begins "Billing is off until
  the app has real plans in Partners." Replace it with one sentence stating what the layer
  needs: the repository for the cache row, the Partner client for revalidation, and the
  `ShopAgent` client for revoking sockets on lapse.
- Change the layer type from
  `Layer.Layer<SubscriptionPlan, Config.ConfigError, Repository | ShopifyPartner | ShopAgentClient>`
  to `Layer.Layer<SubscriptionPlan, never, Repository | ShopifyPartner | ShopAgentClient>`.
- Delete the `billingEnabled` read and the `if (!billingEnabled) { ... }` block, including the
  `granted` constant and the "billing disabled, granting default plan" log line.
- Remove `Config` from the `effect` import if nothing else in the file uses it (nothing does).

The `revalidate`, `resolve`, and `refresh` definitions are unchanged.

### 3.2 `src/lib/Domain.ts`

- Delete `DEFAULT_PLAN_HANDLE` and its JSDoc ("The handle every shop is granted while
  `BILLING_ENABLED` is `false`...").
- In the `PlanHandle` JSDoc, delete the final paragraph ("No plan exists in Partners yet —
  `BILLING_ENABLED` is `false`, so ... Rename them to the real handles before flipping that var
  on."). The two paragraphs above it (why two handles, why the allowlist is total) stay. Add
  one sentence in their place: the literals are the handles configured in the Partner
  Dashboard for every environment's app, and a rename there is a rename here.

### 3.3 `src/lib/MemberAccess.ts`

In the `requireMember` JSDoc, the last paragraph ends with: "With `BILLING_ENABLED` off
`SubscriptionPlan.resolve` grants every shop the default plan, so this arm is exercised only by
tests until billing is turned on; it is here now so that turning it on does not open the member
area to lapsed shops." Delete those two sentences. The paragraph's earlier sentences about the
lapsed page and the `402` stay.

### 3.4 `src/routes/app.index.tsx`

- The loader JSDoc says the plan is "the one the shop is granted while `BILLING_ENABLED` is
  off" or similar (around line 19). Rewrite so it says the plan is resolved from the cached
  handle on the shop's session row.
- The JSX comment around line 75 ("No claim about whether billing is switched on:
  `BILLING_ENABLED` ...") is deleted entirely. The rendered copy already makes no such claim.

### 3.5 `test/integration/vitest.config.ts`

- Delete `BILLING_ENABLED: "true"` from `miniflare.bindings`.
- Rewrite the comment above `bindings` so it no longer mentions the flag. Keep the part that
  matters: `wrangler.jsonc` holds placeholder Partner ids for the test environment, so the
  values that make `SubscriptionPlan`'s cache, revalidation, and boundary-clamp paths reachable
  are supplied here.

### 3.6 `test/integration/member-fixtures.ts`

- In `seedShop`, replace `Domain.DEFAULT_PLAN_HANDLE` with a module-level constant:

  ```ts
  /** The tier a seeded shop holds. Pro so no fixture trips a member cap. */
  const SEEDED_PLAN_HANDLE: Domain.PlanHandle = "baton-pro";
  ```

- Rewrite the `seedShop` JSDoc's second sentence. It currently says "the test runner has
  `BILLING_ENABLED` on, so a bare `ShopSession` row would send `SubscriptionPlan` to the
  Partner API." Say instead that a bare `ShopSession` row has no cached plan and would send
  `SubscriptionPlan` to the Partner API, so the cache is seeded to keep the check hermetic.

Check whether any other test imports `DEFAULT_PLAN_HANDLE`; the grep in §2 found none, but
re-run it.

### 3.7 `test/integration/worker-agent-gate.test.ts`

The JSDoc on "402s a member of a shop whose subscription lapsed" opens with "The member half of
the subscription check, exercised now while `BILLING_ENABLED` is off in production:". Rewrite
the opening to "The member half of the subscription check:" and keep the rest.

### 3.8 `wrangler.jsonc`

- Delete the comment block that begins "App Pricing plans do not exist yet." and the
  `"BILLING_ENABLED": "true",` line from the top-level `vars`.
- Delete `"BILLING_ENABLED": "true",` from `env.staging.vars` and `env.production.vars`.
- Leave `SHOPIFY_PARTNER_APP_ID`, `SHOPIFY_PARTNER_ORG_ID`, and `SHOPIFY_APP_HANDLE` as they
  are in every block.

`pnpm typecheck` regenerates `worker-configuration.d.ts`; confirm the `Env` type no longer has
`BILLING_ENABLED`.

### 3.9 `.env.example`

Replace `# Only needed when BILLING_ENABLED is "true".` with a comment describing the token:
a Partner API client token with the Manage apps permission, used to read each shop's plan.

### 3.10 `README.md`

Under "Billing":

- Delete the paragraph beginning "While `BILLING_ENABLED` is `"false"` in `wrangler.jsonc`".
- Under "Turning billing on", delete step 3 ("Set `BILLING_ENABLED` to `"true"` for that
  environment only in `wrangler.jsonc`.") and renumber. Consider renaming the heading to
  "Enabling an environment", since billing is no longer something that is turned on.

## 4. Verification

1. `grep -rn "BILLING_ENABLED\|DEFAULT_PLAN_HANDLE" src test e2e README.md wrangler.jsonc .env.example scripts`
   returns nothing.
2. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm fmt`: green. The subscription-plan tests
   were already running with the flag on, so no test behaviour changes; a test that starts
   failing has found a hidden dependency on the bypass and the fix is a seeded cache entry as
   in `member-fixtures.ts`, never a re-added switch.
3. Local dev against the dev store: open the app, confirm `/app` loads on the existing plan,
   confirm `/admin/shop/<shop>` shows the handle and its "fresh until" time, click Refresh plan
   and confirm the handle is re-read.
4. `pnpm seed` still succeeds. The seed route passes `MAX_ENTITLEMENTS.maxMembers` to
   `addMember` and does not touch the plan cache, so it is unaffected, but run it.

## 5. Out of scope

Everything else in `docs/plan-limits-and-downgrade-research.md`: derived member seats, caching
`pendingUpdate`, moving the order counter to the billing cycle, overage billing, shortening the
cache on the Manage plan click. Touch none of it here.

## 6. Deviations

| Step                      | Plan said                                                                                     | Done instead                                                                                              | Why                                                                                                                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §2 inventory              | `README.md` "Billing" paragraph and step 3                                                    | Also renamed the heading "Turning billing on" → "Enabling an environment"                                 | §3.10 offered it as a consideration; taken, because with the flag gone nothing is turned on.                                                                                              |
| §3.6 `member-fixtures.ts` | `SEEDED_PLAN_HANDLE` as a module-level constant                                               | Placed it immediately above `seedShop`'s JSDoc rather than with the other top-of-file constants           | Its only reader is `seedShop`, and the JSDoc directly below explains why the cache is seeded at all.                                                                                      |
| §4.3 verification         | Manual dev-store pass: `/app` loads, `/admin/shop/<shop>` shows handle, Refresh plan re-reads | Ran the full local E2E suite (`npm run test:e2e`) instead of driving a browser by hand: 41 passed in 3.2m | The suite's embedded project exercises the same `/app` boundary through `SubscriptionPlan.resolve` with no bypass; the by-hand pass against a live Partner contract is still unperformed. |

## 7. Results

- `pnpm typecheck` (regenerated `worker-configuration.d.ts` without `BILLING_ENABLED`), `pnpm lint`,
  `pnpm fmt`: clean.
- `pnpm test`: 348 passed, 20 files.
- `npm run test:e2e`: 41 passed in 3.2m across the embedded, admin, and member projects.
- `pnpm seed`: seeded `sandbox-shop-01.myshopify.com` — 10 members, 8 teams, 11 workflows, 69 orders.
- The §4.1 grep over `src test e2e README.md wrangler.jsonc .env.example scripts` returns nothing.
- Not done: the by-hand pass against a live Partner contract (§6).

## 8. Issues encountered

None. No test or type depended on the bypass: `layerNoDeps`'s error channel narrowed from
`Config.ConfigError` to `never` with no caller change, `Config` dropped out of the `effect`
import unused, and the integration suite was already running with the flag on so no fixture
needed a new seeded cache entry.
