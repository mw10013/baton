# Production deployment research

Status: updated 2026-10-22. The owner successfully deployed the production Shopify configuration with handle `baton-work` after Shopify rejected `baton` as non-unique. Cloudflare production was deployed successfully on 2026-10-22. Earlier sequencing below is retained as research history, not current execution instructions.

## Production app identity and current status

- Partner organization ID: `2798461` (shared with the other apps).
- Partner app ID: `438449864705`.
- Client ID: `5dbed6b0306c3bc52945dd24bd7b0ff9`.
- Dev Dashboard organization ID: `130059740`; this is distinct from the Partner organization ID used by Baton's Partner API configuration.
- [Partner overview](https://partners.shopify.com/2798461/apps/438449864705/overview).
- [Dev Dashboard](https://dev.shopify.com/dashboard/130059740/apps/438449864705).
- These public IDs are recorded in untracked `.env.production`. The runtime handle is `baton-work`. Production credentials are configured privately and the stage-config record has been published. Secrets remain untracked and must never be copied into this document.
- `baton` was rejected as non-unique. Treat it as unavailable for this release. Dashboard inspection did not expose this app's current App Home handle; there is no evidence that it owns `baton`. No automatic handle substitutions or app recreation.
- Local display name is now `Baton Dev`; the owner deployed that rename. Production display name remains `Baton`.

## Current launch checklist (2026-10-22)

- Done: production Shopify configuration deployed with handle `baton-work`; local app renamed `Baton Dev`.
- Done: production code committed as `3505dc1`; production credentials published to the stage-config stack.
- Done: Cloudflare production deployed at https://baton.mw10013.com. Chrome verified home, privacy, sign-in, and dev kit disabled.
- Done: shared usage event handles `production-orders` and `members` created with names Production orders and Members.
- Done (owner confirmation): both production public plans saved, `baton-basic` and `baton-pro`, with the billing runbook's prices, graduated usage tiers, 14-day trial, and `/app` redirect.
- Done: owner set display names Baton Basic and Baton Pro; added and saved five English top features for each plan, checked against README, billing runbook, code entitlements, metering rules, and platform limits.
- Done: installed on `mw10013-production-shop-00`, approved the free Basic test subscription, and verified embedded home and Basic allowances (200 orders, 3 members). App Pricing default billing frequency saved as Monthly.
- Closed blocker: [workflow editor loading bug](workflow-editor-loading-bug-research.md). Codex Browser Use held page loads in the tab it drove; not a Baton defect.
- Done (2026-10-22 smoke test): workflow step on the test team, turn on, order and webhooks (`orders/paid`, `orders/create`, `orders/fulfilled`), run created and completed, Shopify order link both ways, add member and put on team, member sign-in and member completes a task, order count on the plan, admin console shop row, Pro entitlements, switching Basic → Pro → Basic, uninstall teardown and reinstall. See the 07:26–07:33, 07:41–07:47 and 07:49–07:55 UTC log entries.
- Pending: usage events reaching Shopify. None can be sent during a trial; check the Dev Dashboard App events log in the first paid billing cycle. Record promotion and rollback procedures.
- Done (owner confirmation): production sign-in as `support@mw10013.com`, including email delivery and administrator access.
- Configured: owner explicitly authorized branch `production` as an exception to AGENTS.md. Production Website now watches `mw10013/baton` branch `production`; staging continues watching `main`. Production preview builds are disabled. Push-triggered production build verified: `b7828d7`, build `73750540-8354-411e-a8f1-b92c560b7a33`, succeeded in 54 seconds; Website version `b4c6cd51` is active at 100% traffic.
- Pending: remaining App Store listing and review requirements before general merchant distribution.
- Active work: inspect and complete App Store listing/review preparation. The editor blocker is closed and the development-store smoke test passed; only usage events reaching Shopify remain unverified, and they cannot be verified during a trial.
- Listing preparation update: saved factual copy, English/category, contact/resource links, sales-channel requirements, and corrected reviewer instructions. Validation reduced from 16 to 4 issues: feature media, screenshots, test account, and screencast URL. Owner confirmed the local reviewer video is not hosted. See [App Store submission research](app-store-submission-research.md) for saved copy, remaining work, and submission-summary observations.

## Confirmed decisions and constraints

- Production URL: **https://baton.mw10013.com**. The owner controls `mw10013.com`.
- Production Shopify app name: **Baton**. The app now exists; see the identity record above.
- Production Shopify App Home handle: **`baton-work`**, successfully deployed by the owner. The original preference `baton` was rejected as non-unique; preserve the new handle.
- **Do not run Shopify CLI to test or validate the production configuration.** Do not run production `app dev`, link, pull, info, validation, build, or exploratory deployment commands. Prepare and review the file as text. The initial production Shopify deployment is to happen once, deliberately, after preparation is complete.
- Do not experiment with temporary handle changes or assign `baton` to another app. Do not promise that the handle is available: availability and Shopify's reservation behavior have not been established.
- `main` already deploys staging through Cloudflare Workers Builds; preserve that connection.
- A separate production release branch is the owner's familiar approach and the current proposal, not an implemented decision. Current `AGENTS.md` permits only `main` and `wt-NN` branches: an explicit exception is needed before creating a production branch. No branches or commits have been created for this research.

## Current repository evidence

| Area              | Current behavior                                                                                    | Production work needed                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Stage model       | `src/backend/stage.ts` accepts only `staging` as a deployed stage; unknown stages fail              | Add production explicitly and resolve every exhaustive environment match                                                 |
| Infrastructure    | `alchemy.run.ts` deploys the Website and Backend together; Backend has no public URL                | Keep the service binding architecture; add the domain to production's Website                                            |
| Names             | Deployed Workers use `baton-<worker>-<stage>`                                                       | Preserve stable names: `baton-website-production`, `baton-backend-production`                                            |
| State             | `stageState` uses Cloudflare state for staging and local state for disposable environments          | Use Cloudflare state for production, isolated by stage                                                                   |
| Credentials       | Deployed app credentials and Partner settings come from the separate `baton-stage-config` stack     | Publish a production record before deploying the application                                                             |
| Runtime policy    | Staging disables dev endpoints and the dev kit; enables order-facts diagnostic logging              | Disable dev endpoints and kit in production; choose diagnostic logging deliberately                                      |
| Seed              | `seedFileFor` has an explicit file per environment; staging seeds one admin                         | Choose production admin identity and add its idempotent seed; no fixture shops or orders                                 |
| Destructive reset | `scripts/cloud-reset.ts` accepts the `Deployed` schema                                              | Restrict reset before extending that schema, so production cannot become resettable by accident                          |
| Migrations        | D1 and actor schemas are still developed by editing initial migrations and resetting                | Freeze initial migrations at launch; use forward migrations for both stores afterward                                    |
| Shopify config    | Local and staging TOMLs exist; staging pins `baton-staging`                                         | Add `shopify.app.production.toml` without changing the other app identities                                              |
| Extension         | `extensions/baton-order-link/shopify.extension.toml` contains the order admin link and a pinned UID | Include it in the initial release; confirm multi-app identity handling before release without production CLI experiments |
| Billing           | Partner API reads subscription handles; App Events API receives usage                               | Configure production plans and app-specific credentials; reuse existing billing implementation                           |

### Bang reference

Bang is in the sibling checkout `/Users/mw/Documents/src/bang`, not currently under Baton's `refs/`. Its `wrangler.jsonc` production configuration attaches `bang.mw10013.com` with `custom_domain: true`.

Baton uses Alchemy instead of Wrangler configuration. The installed Alchemy Worker props support `domain: "baton.mw10013.com"`; its documentation states that the custom domain becomes the Worker's primary `url` output. Apply only to production. Baton's auth origin and Shopify app URL already derive from the Website's URL. The domain's Cloudflare zone must exist in the deployment account; account access and build-token permissions still need checking.

## Separate release surfaces

1. **Cloudflare:** Workers, D1, Durable Objects, Workflow, bindings, migrations, and domain. Alchemy deploys the whole stack. Workers Builds can select a Git branch and a custom deploy command.
2. **Shopify app version:** app configuration and extensions. This does not host the Website or Backend.
3. **Shopify distribution and pricing:** dashboard configuration, listing content, plans, meters, and review. Plans are not defined in the app TOML.

Routine application code releases should deploy through Cloudflare without a Shopify deployment when configuration and extensions are unchanged. “Deploy once” here means one intentional initial production Shopify deployment, not a prohibition on future necessary version releases.

## Proposed launch order

### 1. Prepare locally

- Implement production stage support and domain attachment.
- Restrict destructive tooling and settle migration policy before production data exists.
- Select the production admin seed and logging policy.
- Prepare a production TOML draft with placeholders until the real client ID exists. Keep it outside any automated Shopify command path.
- Verify code using `vp check --fix` and appropriate local tests. No Shopify CLI commands against production.

### 2. Resolve app creation before executing anything

**Correction after owner review:** the earlier recommendation to create an identity in the Partner website and stop before any initial version was not sufficiently researched. The owner reports that this creation option is absent. Do not send the owner through that flow again or treat it as a prerequisite.

Shopify's documented route for an existing project is `app config link`, which can create a new remote app and generate an additional local configuration. A subsequent `app deploy` creates/releases the app version containing the project's configuration and extensions. This establishes that a separate deployment is not required merely to obtain a new app record, but does **not** establish that creation has no version or handle side effects.

Source inspection of Shopify CLI `main` on 2026-10-21 found:

- `services/app/config/link.ts`, `linkAppConfiguration`: selects/creates the remote app, loads local configuration, fetches remote configuration, writes the merged local TOML, and sets the default configuration preference. It is not a read-only command or just a local file generator.
- `utilities/developer-platform-client.ts`, `CreateAppOptions`: accepts the app name, launchability, scopes, directory, and embedded setting; no explicit App Home handle parameter.
- `utilities/developer-platform-client/app-management-client.ts`, `createApp`: calls the `CreateApp` mutation and returns the app key and credentials.
- The same file's `createAppVars`: sends an `initialVersion` containing App Home, branding, webhook API version, and access modules. URLs are defaults (`example.com` or Shopify's default App Home), and the App Home configuration has no explicit handle.
- `api/graphql/app-management/generated/create-app.ts`: confirms the mutation accepts `initialVersion` and organization ID. Creating an app is therefore not demonstrated to be a version-free operation. Whether that initial version is active/released, and how the server assigns a handle, are not established by these client-side inputs.

**Current recommendation: keep production uncreated while researching the handle boundary.** Do not run `app config link`, `app init`, `app dev`, `app deploy`, or validation to investigate. Do not call the internal creation API directly as a workaround. The owner has not authorized creation experiments.

Before choosing the actual creation procedure, determine from the installed CLI version's source and, if necessary, Shopify support:

1. At what operation is the App Home handle assigned/reserved: creation, initial version, or first explicit configuration deployment?
2. Can creation leave a generated handle that is changed once to `baton` without sacrificing the desired handle?
3. Does a supported creation path allow specifying the final handle atomically? The inspected `CreateAppOptions` does not.
4. Is the `initialVersion` immediately active, and can pricing/distribution be configured before the complete app deployment?

Do not substitute the app display name, app-record identifier, extension handle, or App Store listing slug for the App Home handle. Availability and reservation behavior remain unknown. If source/docs do not answer these questions, seek an authoritative Shopify answer rather than a live experiment.

Once the creation behavior is understood and the owner agrees to the concrete procedure, create exactly one production app in the correct Partner organization, capture its client ID and Partner app ID, and obtain its secret privately. The existing project's final TOML and extension release remain a separate deliberate operation.

### 3. Configure distribution and pricing

- Choose **Public distribution** for the existing Shopify App Pricing model and distribution to unrelated merchants. This choice is permanent.
- Limited listing visibility can be selected if desired; it still requires App Store review. It is not a route around review for live merchant installs.
- Create both public plans, their usage meters, and localized descriptions using [the billing runbook](billing-runbook.md), which is the detailed pricing source. Do not maintain a second independent pricing specification here.
- Check that dashboard access to pricing is available before a released version; if the dashboard requires one, defer pricing to immediately after the intentional initial release rather than making an exploratory release.

Current pricing, for orientation:

| Setting             | Basic                           | Pro                               |
| ------------------- | ------------------------------- | --------------------------------- |
| Plan handle         | `baton-basic`                   | `baton-pro`                       |
| Base price          | $29 monthly                     | $79 monthly                       |
| Trial               | 14 days                         | 14 days                           |
| `production-orders` | First 200 free; then $0.12 each | First 1,500 free; then $0.05 each |
| `members`           | First 3 free; then $12 each     | First 10 free; then $7 each       |
| Meter pricing       | Graduated tiers, cost per unit  | Graduated tiers, cost per unit    |
| Welcome link        | `/app`                          | `/app`                            |

Use monthly billing, both meters on each plan, and the exact handles expected by `src/domain/billing.ts`. Add descriptions for every published locale so plans appear. Leave Shopify's built-in private test plan untouched. Do not add or re-handle meters after subscriptions exist without a migration.

### 4. Publish credentials and bootstrap Cloudflare

Prepare untracked `.env.production` privately with all fields required by `StageConfigValues`:

- `SHOPIFY_API_KEY` (the production client ID)
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_HANDLE=baton-work`
- `SHOPIFY_PARTNER_ORG_ID`
- `SHOPIFY_PARTNER_APP_ID`
- `SHOPIFY_PARTNER_API_TOKEN` (Partner API client with Manage apps permission)

An existing Partner token can serve multiple apps in the same organization; confirm its access. App Events uses the production app credentials, not a separate token. Obtain credentials from dashboard settings without production Shopify CLI pulls. Never print credential files or read their secret-bearing state record into tool output.

After code and configuration review, publish the production stage-config record, then bootstrap the production Alchemy stack. These are proposed future operations, not commands to execute during research. Inspect the resulting resource plan before the first application deploy. Confirm the custom domain, HTTPS, public pages, admin sign-in, email delivery, and absence of dev endpoints before the Shopify release.

### 5. Connect release automation

- Leave staging's `main` trigger untouched.
- Once branch policy is explicitly resolved, connect production's Website Worker to the chosen release branch.
- Adapt the proven staging build/install commands; deploy the full Alchemy stack with `--stage production`. Do not use a default Wrangler deploy that bypasses Alchemy.
- Use one trigger for the stack, attached to the Website, rather than independent competing Website and Backend builds.
- Confirm build credentials can manage all required resources and access production's state. Do not enable arbitrary branch previews against production state.
- Record promotion and rollback procedures. Reverting code does not undo data migrations; releases must preserve compatibility with stored data.

### 6. Review and perform the initial Shopify release

The final `shopify.app.production.toml` must contain the actual production client ID, `name = "Baton"`, `handle = "baton-work"`, `application_url = "https://baton.mw10013.com"`, and `embedded = true`.

- Redirect URL: `https://baton.mw10013.com/api/auth`.
- Mirror staging's scopes, webhook topics, API version, payload fields, and compliance subscriptions at implementation time.
- Keep `[build].automatically_update_urls_on_dev = false`.
- Preserve the staging config's documented `web_directories = ["."]` discovery workaround; review its cross-config behavior before adding the file.
- Include the order-link extension with its correct identity; do not regenerate its UID speculatively.
- Confirm the app's client ID and dashboard identity match the production stage-config record; confirm the runtime handle and TOML handle both equal `baton-work`.
- Review the complete file as text. No production CLI validation, linking, dev session, or trial deploy.
- Perform the single initial Shopify deployment only when the reviewed release is ready and the owner authorizes it. If Shopify reports an unavailable handle or another unexpected identity issue, stop and inspect; do not automatically change handles or create replacement apps.

### 7. Verify and prepare merchant launch

- The store runbook records `mw10013-production-shop-00` as an existing development store. Verify its current ownership and suitability before installing.
- After the intentional release, install on that store and select a plan as the owner. Development-store plan testing is distinct from running production CLI experiments.
- Verify embedded loading, pricing redirect/return, both plans' entitlements, order link, order sync, webhook processing, and uninstall behavior on an appropriate test install.
- Usage during a trial may not produce billable events: verify the actual billing-cycle conditions and App Events logs rather than treating an empty log as success.
- Complete listing content, support/privacy details, protected customer data access as required by actual API fields, and Shopify review requirements.
- Hosting availability and a successful development-store install do not themselves authorize general live-merchant distribution.

## Open questions

1. Confirm the Partner organization for the new app and existing token's access.
2. Resolve the CLI creation/initial-version/handle lifecycle in §2; dashboard identity-only creation is no longer the proposed path. Can pricing be configured before the complete app deployment?
3. Who is the production admin? Retain staging's `support@mw10013.com` or choose another address?
4. Is `mw10013.com` active in the intended Cloudflare account, with suitable deployment permissions?
5. Which branch name and promotion process should be used? Explicitly resolve the repository branch restriction first.
6. Confirm extension UID behavior for the new app using docs/source inspection; no production CLI probes.
7. Fully visible or limited visibility listing? What listing/review material is already available?
8. Confirm rollback procedure and the precise point when initial migrations become immutable.

## Sources

Reviewed 2026-10-21. Dashboard details can change; verify the actual screen before an irreversible action.

- [Shopify: create apps using the Dev Dashboard](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard) — app identity, version, credentials, installation.
- [Shopify: migrate dashboard-managed apps to CLI](https://shopify.dev/docs/apps/build/cli-for-apps/migrate-from-dashboard) — CLI management and handle configuration.
- [Shopify: app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration) — handle, URLs, scopes, webhooks, and dev URL behavior.
- [Shopify: deploy app versions](https://shopify.dev/docs/apps/launch/deployment/deploy-app-versions) — configuration/extension releases.
- [Shopify: select distribution method](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method) — permanent choice and Partner organization requirement.
- [Shopify: listing visibility](https://shopify.dev/docs/apps/launch/distribution/visibility) and [review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process) — limited visibility still requires review.
- [Shopify: App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing), [plans](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/plans), and [usage charges](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/setup-usage-charges) — dashboard plans, localization, meters, and billing events.
- [Cloudflare: Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/) — branch selection and deployment commands.
- Local evidence: `alchemy.run.ts`, `src/backend/stage.ts`, `src/backend/stack.ts`, `src/backend/seed.ts`, `src/backend/resources.ts`, `src/backend/shop-actor.ts`, `stacks/stage-config.ts`, `scripts/cloud-reset.ts`, Shopify TOMLs and extension config.
- Local runbooks: [billing](billing-runbook.md), [stage configuration](stage-config-runbook.md), [Shopify stores](shopify-stores-runbook.md).
- Local dependency source: `node_modules/alchemy/src/Cloudflare/Workers/Worker.ts`, Worker props `domain` documentation.
- Reference checkout: `/Users/mw/Documents/src/bang/wrangler.jsonc`, production custom domain.

## Execution record

- 2026-10-21: repository, Bang configuration, installed Alchemy domain support, Shopify docs, and Cloudflare docs inspected. Research document created. No production app, branch, plans, secrets, infrastructure, or Shopify release created; no Shopify CLI commands run.

### Research correction, 2026-10-21

The first draft conflated app creation with a version-free identity operation and offered an unverified dashboard route. The revised §2 distinguishes documented create/link support from the source-confirmed `initialVersion` side effect and unknown server-side handle behavior. No CLI was executed and no production configuration was checked.

Additional primary sources:

- [Manage app config files](https://shopify.dev/docs/apps/build/cli-for-apps/manage-app-config-files) — creation/linking for existing projects, followed separately by deployment.
- [App config link reference](https://shopify.dev/docs/api/shopify-cli/app/app-config-link) — explicitly supports creating a new app.
- [CLI link service](https://github.com/Shopify/cli/blob/main/packages/app/src/cli/services/app/config/link.ts) — `linkAppConfiguration`, `selectOrCreateRemoteAppToLinkTo`.
- [CLI creation options](https://github.com/Shopify/cli/blob/main/packages/app/src/cli/utilities/developer-platform-client.ts) — `CreateAppOptions`.
- [CLI App Management client](https://github.com/Shopify/cli/blob/main/packages/app/src/cli/utilities/developer-platform-client/app-management-client.ts) — `createApp`, `createAppVars`.
- [CLI creation mutation](https://github.com/Shopify/cli/blob/main/packages/app/src/cli/api/graphql/app-management/generated/create-app.ts) — `initialVersion` input.

These source links track upstream `main`, not the installed executable's version. Match the implementation to the installed package by reading package metadata/source before relying on a final command procedure; do not run the executable to investigate production.

- 2026-10-22: owner confirmed successful production Shopify deployment using `baton-work`. Next: production hosting implementation, credentials, and Shopify pricing plans. Cloudflare production is not yet deployed.

- 2026-10-22: implemented local production stage support, custom domain, Cloudflare state and credentials wiring, admin seed, disabled dev tooling and diagnostic order-facts logging, and staging-only reset validation. Applied migrations must now be preserved. No infrastructure deployed; production credentials, plans, and build trigger remain outstanding.

- 2026-10-22: published the production stage-config record, reviewed an all-create application plan, and successfully deployed the Alchemy production stack (7 resources/actions succeeded). Website: https://baton.mw10013.com; Backend remains private. Chrome verified the home page, updated privacy policy, sign-in page, dev-kit not-found response, and a sign-in request for support@mw10013.com reaching “Check your email.” Inbox delivery and completing admin sign-in are not yet verified. Command-line HTTP probes received 403 responses while Chrome rendered successfully. Shopify pricing plans, development-store install verification, and the production Workers Builds trigger remain outstanding.

- 2026-10-22: prepared both pricing plans in Chrome using the billing runbook and verified meter identifiers against `src/domain/billing.ts`. Saved the shared event identifiers; the owner then confirmed saving both plan drafts. Localized listing descriptions and installation/billing verification remain pending. Shopify dashboard plan changes are external state, not Git changes.

- 2026-10-22: owner confirmed production admin sign-in. Saved five plan features per tier in the English listing; Shopify showed no unsaved changes afterward. Pricing and trial descriptions agree with saved plans; inclusion counts and global limits agree with code. No App Store review submission made.

- 2026-10-22: pushed main at `4d0c276` and observed its staging build start. CF CLI Builds API returned 401 Invalid token, so configured production through Chrome. Created/pushed release branch `production` with explicit owner authorization; connected production Website to it using deploy command `pnpm exec vp exec alchemy deploy --stage production --yes`, no separate build command, repo root `/`, existing Workers Builds token, and previews disabled. Testing with a subsequent documentation commit push.

- 2026-10-22: production push-triggered build succeeded for `b7828d7` with `Success: Deploy command completed` and `Success! Build completed.` Alchemy updated Website only; Backend and persistent resources were unchanged, seed/migrations skipped. Shopify installation review is open for `mw10013-production-shop-00`, awaiting permission confirmation before clicking Install.

- 2026-10-22: installed Baton on `mw10013-production-shop-00` with owner authorization. Saved App Pricing default frequency Monthly. Approved the free Basic test subscription with owner authorization; embedded home showed Basic, 200 included production orders and 3 included members. Created test team and draft workflow `Production smoke test`, tag `baton-production-smoke`, workflow ID `e349821d-0a33-446b-8356-500a321c7cce`. The editor app window remained a blank spinner on create and retry. Website telemetry recorded both editor document requests as HTTP 200, outcome ok; no browser error was captured. Reloading Shopify subsequently left the embedded app blank, while the production home page still rendered in a separate Chrome tab. Full order/webhook workflow, Pro entitlements, usage events and uninstall verification remain incomplete; do not treat the smoke test as passed. No Shopify configuration or deploy commands were run during this test.

- 2026-10-22: investigated editor spinner. Reproduced in the original automation-controlled Chrome tab; DevTools Timing showed the document stuck in Connection start → Stalled, zero transferred bytes, with no response headers. Foregrounding alone did not consistently resolve it; bypass-cache reload also stalled. Opened a fresh tab in the same Chrome profile using Chrome DevTools MCP: embedded home loaded, the same saved workflow editor opened successfully twice, and closing it followed by a full reload succeeded. No app/config/deployment changes were needed. Evidence isolates the failure to the original tab/session; the precise browser/automation mechanism is not established. Do not classify it as a confirmed Baton editor defect. Continue smoke testing in the fresh Chrome MCP tab.

- 2026-10-22 correction: the workflow editor loading failure remains an open production release blocker. Fresh-tab success is a workaround and does not establish an automation cause or rule out a Baton defect. The preceding investigation conclusion was premature. See [Workflow editor loading bug research](workflow-editor-loading-bug-research.md) for evidence, reproduction limits, investigation steps, and resolution criteria.

- 2026-10-22: production smoke test on `mw10013-production-shop-00`, 07:26–07:33 UTC. Chrome DevTools MCP in a new tab; Codex Browser Use and Claude in Chrome not used. No page stalled. No Shopify configuration, plan, deploy or uninstall actions. Times UTC; server lines are `cf o11y telemetry query` events on `baton-website-production` and `baton-backend-production`. Neither Worker logged a warning or error from 07:20 to 07:33.

  | Check                                    | Result             | Evidence                                                                                                                                                                                                                                                                                                                                                                 |
  | ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Editor: add step                         | Pass               | 07:26:29 editor document 200. Added Step 1 `Smoke step` on team `Production smoke test`; server function 200 at 07:26:39.                                                                                                                                                                                                                                                |
  | Turn on workflow                         | Pass               | 07:26:47 `Workflows.applyAndTurnOn workflowId=e349821d-…`, `Runs.reconcileAll orders=0 created=0`. Workflow page showed Active with Step 1.                                                                                                                                                                                                                              |
  | Tagged product                           | Pass               | The store had no products. Created `Baton production smoke product` (ID `16088482546033`, $10.00, inventory not tracked, tag `baton-production-smoke`) at 07:27:26.                                                                                                                                                                                                      |
  | Test order                               | Pass               | Draft #D1, Mark as paid (a manual payment record; nothing charged), order #1001, `gid://shopify/Order/18963848331633`, about 07:28:12.                                                                                                                                                                                                                                   |
  | Order webhooks                           | Pass               | 07:28:14.639 `Webhook received topic=ORDERS_PAID`; `Orders.syncOrderWebhook status=fetch`; `Orders.fetchAndUpsertOrder written=true changed=true`; `Runs.reconcileOrder created=1`; 07:28:15.433 `Webhooks.ordersWebhook status=stored`, POST `/webhooks/orders` 200. `ORDERS_CREATE` at 07:28:15.521 answered `status=stale`, 200, as designed for the second delivery. |
  | Run starts                               | Pass               | Baton order page: item `Not started`, `Step 1 of 1 · Smoke step`. Home: Not started 1, Orders this billing cycle 1 of 200.                                                                                                                                                                                                                                               |
  | Order link, Shopify→Baton                | Pass               | More actions › Open in Baton on order #1001. 07:28:53 `/app/orders/from-shopify` 307 → `/app/orders/18963848331633` 200, the order's page in Baton.                                                                                                                                                                                                                      |
  | Order link, Baton→Shopify                | Pass               | View in Shopify opened Shopify's order #1001 in a new tab.                                                                                                                                                                                                                                                                                                               |
  | Admin console                            | Pass               | 07:30:24 `/admin/shops` 200: shop GID `gid://shopify/Shop/109004980593`, scope `read_orders,read_products`, plan `basic`/`baton-basic`, access and refresh tokens present.                                                                                                                                                                                               |
  | Add member, put on team                  | Pass               | 07:30:41 `Membership.addMember memberId=8c3ac7ba-…`; 07:30:53 `Membership.addMemberTeams teams=1`. Member `smoke-member@mw10013.com` on `Production smoke test`. Home Members: 1 member, 3 included.                                                                                                                                                                     |
  | Task done, run completes                 | Pass               | Manage › Done as the merchant. 07:31:14 `Runs.merchantMarkTaskDone task=2971ac3f-…`. Page: "Every item is done." with Fulfill in Shopify; item Done · 1 step.                                                                                                                                                                                                            |
  | Fulfilled webhook                        | Pass               | Marked fulfilled in Shopify at about 07:31:55; Shopify archived the order. 07:31:57 `Webhooks.ordersWebhook topic=ORDERS_FULFILLED status=stored`, 200. Baton order page at 07:32:04 showed Fulfillment Fulfilled.                                                                                                                                                       |
  | Member sign-in                           | Not run            | `/shop` requires a member session; this Chrome profile is signed in as the administrator `support@mw10013.com` and goes to `/admin`. A member signs in by an emailed link, and this session cannot read mail. Tooling limit, not a defect. Passed later with a Gmail member; see the next entry.                                                                         |
  | Usage events sent                        | Not verifiable yet | 07:28:15 `Billing.flushUsageEvents sent=0 pending=1`, with no refusal warning. `UsageRepository.flushUsageEvents` sends nothing until the shop has a billing cycle. During a trial Shopify has no billing cycle, and Baton drops events queued before the first cycle by design. Check at the first paid billing cycle.                                                  |
  | Pro entitlements, plan switch, uninstall | Not run            | Each changes the plan or uninstalls. They need the owner's approval.                                                                                                                                                                                                                                                                                                     |

  Telemetry gap, not a defect: the `orders/fulfilled` delivery logged only the Backend's final `Webhooks.ordersWebhook … status=stored` line, without its `Webhook received` and actor `Orders.syncOrderWebhook` lines. A query 2 minutes later still returned only that line. `stored` is returned only after the fetch path, and the Baton page showed the fulfilled order. Test data left in the store: the product and order #1001 (fulfilled, archived). Member `smoke-member@mw10013.com` was deleted in the next entry.

- 2026-10-22: member flow on production, 07:41–07:47 UTC. Nobody can read mail at `smoke-member@mw10013.com`, so the owner chose a Gmail plus address. Magic links stay mailed-only in production; logging them was considered and rejected, because anyone with telemetry access could then sign in as any member for 5 minutes. The member signed in through an isolated Chrome DevTools MCP browser context, which left the administrator session in the normal profile untouched. The owner copied the link from Gmail without clicking it. Neither Worker logged a warning or error from 07:41 to 07:47.

  | Check                     | Result | Evidence                                                                                                                                                                                                                                           |
  | ------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Add Gmail member, on team | Pass   | Added `mw10013+baton-member@gmail.com` (member `20d44acf-…`) at about 07:41:44; the `+` address was accepted. 07:41:55 `Membership.addMemberTeams teams=1`.                                                                                        |
  | Delete old member         | Pass   | 07:42:14 `Membership.deleteMember memberId=8c3ac7ba-… deleted`.                                                                                                                                                                                    |
  | Sign-in email             | Pass   | 07:42:30 Send link, server function 200, page showed "The link expires in 5 minutes." The owner received "Your sign-in link" in Gmail.                                                                                                             |
  | Member sign-in            | Pass   | 07:45:19 `/api/auth/magic-link/verify` 302 → `/login-callback` 307 → `/shop/mw10013-production-shop-00.myshopify.com/workflows` 200; `Backend.shopAccess`. With one shop, the member landed on its Workflows list, signed in as the Gmail address. |
  | Second test order         | Pass   | Order #1002, `gid://shopify/Order/18963864551793`, Mark as paid at about 07:46:03. 07:46:06 `ORDERS_PAID status=stored`, `Runs.reconcileOrder created=1`, `ORDERS_CREATE status=stale`, both 200.                                                  |
  | Member sees the task      | Pass   | After a reload the member's Workflows showed Ready 1: `#1002 · Baton production smoke product`, `Smoke step`, `Production smoke test · Step 1 of 1`. The step page showed its instructions with Start and Done.                                    |
  | Member starts the task    | Pass   | 07:46:21 `Runs.memberStartTask task=9075a795-… memberId=20d44acf-…`. Page: Started, with the member's email and the start time.                                                                                                                    |
  | Member marks it done      | Pass   | 07:46:26 `Runs.memberMarkTaskDone task=9075a795-…`. Member page: Done, with Undo. The merchant's Baton order page for #1002 showed "Every item is done." and Done · 1 step.                                                                        |
  | Usage events              | Held   | 07:46:06 `Billing.flushUsageEvents sent=0 pending=2`. Held as in the previous entry.                                                                                                                                                               |

  The `Membership.addMember` line for the Gmail member was missing from the telemetry query, a second dropped log line after the `orders/fulfilled` gap. The member page opened and the next line, `addMemberTeams`, names the same member ID. Test data left in the store: order #1002, still open, unfulfilled, with its run done; and member `mw10013+baton-member@gmail.com` on the test team. The isolated browser context remains signed in as that member.

- 2026-10-22: plan switching and uninstall on production, 07:49–07:55 UTC, with owner approval. Every plan was "Free to test" at $0 on the development store; nothing was charged. Shopify configuration and deploys were not touched.

  | Check                    | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                           |
  | ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Manage plan              | Pass   | 07:49:15 `SubscriptionPlan.expectChange: plan deadline shortened` and `Billing.flushUsageEvents sent=0 pending=2`. Shopify's pricing page: Basic Current, both plans $0, "14 trial days remaining".                                                                                                                                                                                                                |
  | Switch Basic → Pro       | Pass   | Approved at about 07:49:50, charge `83328663921`. Returned to `/app?plan_handle=baton-pro` 200 at 07:49:52. 07:49:52 `ShopActor.revoke by=all closed=3`: a changed plan closes every socket of the shop, including the signed-in member's.                                                                                                                                                                         |
  | Pro entitlements         | Pass   | Home: Orders this billing cycle 2 of 1,500 included; Members 1 member, 10 included. These are Pro's only entitlements. Admin console: `pro`/`baton-pro`.                                                                                                                                                                                                                                                           |
  | Switch Pro → Basic       | Pass   | Approved at about 07:50:45, charge `83328696689`. 07:50:52 `ShopActor.revoke by=all closed=3`. Home: 2 of 200, 1 member of 3. Admin console: `basic`/`baton-basic`. The order count stayed at 2 across both switches: a trial has no billing cycle, so a switch during one starts no new cycle.                                                                                                                    |
  | Uninstall                | Pass   | Shopify Settings › Apps › Uninstall, about 07:53:09. 07:53:11 `Webhook received topic=APP_UNINSTALLED`; 07:53:12 WARN `webhooks.app.uninstalled pending=2: usage events unsent at uninstall`, expected because there was no billing cycle; `ShopActor.destroy sockets=3 closed=true: storage deleted`; sockets closed with code 4410; `ShopActors.destroy status=destroyed`; POST `/webhooks/app/uninstalled` 200. |
  | Uninstall, member side   | Pass   | The member's open tab showed "You no longer have access to this store." with Your stores.                                                                                                                                                                                                                                                                                                                          |
  | Uninstall, admin console | Pass   | `/admin/shops`: "No sessions."                                                                                                                                                                                                                                                                                                                                                                                     |
  | Reinstall                | Pass   | `/oauth/install?client_id=…`, Install at about 07:54:05. 07:54:11 `Shopify.authenticateAdmin: exchanged`; 07:54:12 `OrderFacts.install: triggers made, rebuild owed`; `/app` 200. Home started fresh: Getting started 0 of 3, every order count 0, 0 of 200 orders, 0 members. Admin console: new session, tokens present, `basic`/`baton-basic`.                                                                  |
  | Plan after reinstall     | Note   | Shopify's pricing page then read "Subscription expires November 05, 2026. Select a plan to keep using this app without interruption." with no plan Current. The cancelled Basic subscription stays active until its trial ends, and Baton correctly reads it as `baton-basic`. Approved Basic again at about 07:55:20, charge `83328729457`. The page then showed Basic Current, 14 trial days remaining.          |

  One backend event in this window had level `error`: a `ShopActor.jsrpc` `destroy` exception with message `uninstalled`. This is the intended abort: `ShopActor.destroy` aborts the actor mid-call after deleting storage, and `ShopActors.destroy` reads that rejection as success. Not a defect. A broad events query at first returned only the first of the two `ShopActor.revoke` lines; a search for "revoke" found both. The two earlier gaps (the `orders/fulfilled` sync lines and the Gmail member's `Membership.addMember`) were still missing on targeted searches.

  State after this entry: Baton's data for the shop is gone. The workflow, team, runs, both members, the order facts and usage counts were all deleted by the uninstall. Repeating the smoke test needs a new team, a workflow on tag `baton-production-smoke`, and the Gmail member added again. Shopify still has the tagged product, order #1001 (fulfilled, archived) and order #1002 (open, unfulfilled). The isolated browser context is still signed in as the Gmail member, now with no store.
