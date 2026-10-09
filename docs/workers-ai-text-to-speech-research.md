# Workers AI text-to-speech test

Researched 2026-10-03; reviewed and updated 2026-10-04 against current public documentation, pinned local source, and dashboard token metadata. The local `cf` account config and credential template exist. The ignored credential file exists with mode `600`; whether it contains the new operator secret remains unverified. The user created the account-owned `cf` token during setup. The speech CLI remains a proposal; no speech inference was sent.

## Review verdict and next step

The core research is sound: Aura-1 supports `luna` and MP3, the model-specific REST endpoint is correct, and the published prices and daily allocation match the calculations. No Worker deployment, app change, R2 bucket, or AI Gateway is needed.

Token creation is complete. The user created one reusable, production-capable **account-owned** token named **`cf`** on the existing account, with **no expiration**, including **R2 and Queues**, and **no zone permissions**. It is not restricted to Baton or speech. The exact creation date is available in token metadata, so the name needs no date suffix. Next, confirm the secret is saved in the password manager and `.env.cf.local`, then obtain approval for read-only preflights and offline implementation. Root `tmp/` is accepted, but neither the ignore rule nor the speech CLI is implemented. Token creation does not authorize implementation or inference.

Corrections from this review:

- Separate the speech-only permission minimum from the confirmed broader operator goal. A worktree name does not restrict production access.
- Recommend account-owned ownership for the clarified reusable integration. Account-owned tokens are supported, but are not inherently safer; user-owned tokens remain suitable for ad hoc scripting.
- Current Workers authorization distinguishes **Admin** (including create/delete) from **Editor** (existing Workers only). The original Workers Scripts Edit row alone is not a sound modern description of full Worker lifecycle access.
- Load the credential file from an absolute repo-root path only for a real request, rather than requiring Node's current-directory-relative `--env-file` at startup. Dry-run must work even if the file is absent.
- Give mocked CLI tests an explicit Node runner: the current Vitest projects do not discover `scripts/tts.test.ts`.
- Strengthen file publication and timeout tests; a MIME type and non-empty body alone do not prove playable MP3.
- The fixed text is 85 characters: about 116 neurons and $0.001275 at the published Aura-1 overage rate. Saving half Aura-2's price saves about $0.001275 on this clip, not a meaningful quality-selection budget.

## Goal and scope

Generate one playable voice file from a short, fixed text using Cloudflare Workers AI. A local Effect CLI can call Cloudflare's REST endpoint directly. We do not need to deploy a Worker, add an AI binding, change the app, create an AI Gateway, or store anything in R2.

First-test decisions from review:

- Model: `@cf/deepgram/aura-1`, at half Aura-2's character price.
- Voice: `luna`, supported by both Aura-1 and Aura-2 English, selected explicitly for repeatability.
- Output: MP3. Recommend `tmp/tts/<attempt>/speech.mp3`; the temporary-file convention is proposed below, not yet installed.
- Text: `Hello from Baton. This is a short test of text to speech using Cloudflare Workers AI.`
- One request per invocation; no automatic retries or model fallback.
- Use the existing Workers Paid account. Small overage charges are acceptable; keep the text short and start with one model only.

This proves authentication, request construction, binary audio handling, and local playback. It does not prove production suitability, latency targets, or voice quality across languages.

## Available models and recommendation

The pinned local Cloudflare model catalogue contains four non-deprecated Text-to-Speech entries. Current public Aura-1 documentation and Aura-2 English's schema confirm the selected fields and shared `luna` speaker. This is a catalogue snapshot, not a guarantee of account availability or a permanent exhaustive list; recheck the account's model list and selected schema before executing the test.

| Model                    | Input and voice selection                                                                           | Published price                        | Use for this test                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `@cf/deepgram/aura-2-en` | English; `text`; many named speakers, default `luna`                                                | $0.030 / 1,000 input characters        | Possible later upgrade; not part of the first test                    |
| `@cf/deepgram/aura-2-es` | Spanish; `text`; named speakers, default `aquila`                                                   | $0.030 / 1,000 input characters        | Use if the test should be in Spanish                                  |
| `@cf/deepgram/aura-1`    | `text`; named speakers, default `angus`                                                             | $0.015 / 1,000 input characters        | Selected first model; override the default with shared speaker `luna` |
| `@cf/myshell-ai/melotts` | Multilingual; `prompt` and optional `lang`, default `en`; no speaker field in the Workers AI schema | About $0.0002 / generated audio minute | Reference only; not part of the first test                            |

MeloTTS's model page quotes $0.000205 per audio minute; the pricing table rounds this to $0.0002. Its 18.63 neurons/minute corresponds to approximately $0.000205 at the published neuron rate. These are not character prices.

Aura-1 is enough to prove the plumbing. Its schema and Aura-2 English's schema use the same relevant request fields and binary MP3 response. With explicit `speaker: "luna"` and `encoding: "mp3"`, moving this test to Aura-2 English should require changing only the model ID in the endpoint. Voice lists differ, so that is not true for every speaker. Their defaults also differ: Aura-1 defaults to `angus`, Aura-2 English to `luna`. A shared speaker name does not promise an identical voice or performance between model generations. Keep Aura-1 for the agreed plumbing test; evaluate Aura-2 separately if narration quality becomes the goal.

Aura-2's documentation describes context-aware pacing and expressiveness, but no quality comparison was measured here. Cloudflare marks Aura models as partner models and links Deepgram's terms; review those before using generated speech beyond a private test.

Whisper and Deepgram Nova are speech-to-text models, not choices for generating a voice file.

## Endpoint and audio response

Use the documented model-specific REST endpoint:

```text
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/deepgram/aura-1
Authorization: Bearer {CLOUDFLARE_API_TOKEN}
Content-Type: application/json
Accept: audio/mpeg
```

Request body:

```json
{
  "text": "Hello from Baton. This is a short test of text to speech using Cloudflare Workers AI.",
  "speaker": "luna",
  "encoding": "mp3"
}
```

The model schema describes binary `audio/mpeg` output. Save the bytes, not a UTF-8 string and not JSON. An HTTP response can arrive in chunks; for this small test, buffering the complete body before writing is simpler than incremental file output. Omit container, sample rate, and bitrate initially: their allowed combinations depend on encoding. The `Accept` header expresses the desired response type; it is not a guarantee that errors or other models return audio.

Response handling should:

1. Check HTTP status before treating the body as audio. On failure, decode a bounded error body and report status plus Cloudflare's error code/message where available.
2. For Aura, require the expected MP3 content type, allowing normal MIME parameters; reject JSON or unexpected content types even on HTTP 200.
3. Read all bytes within the timeout; reject an empty body. Bound audio buffering (recommend 10 MiB for this short experiment) and error decoding (recommend 8 KiB). These are local safety limits, not Cloudflare limits. Do not log an arbitrary error body; extract bounded code/message fields and redact the token if echoed.
4. Write to a uniquely created staging file beside the destination, then publish the completed file with no-replace semantics. A plain rename can overwrite on macOS; use a primitive with an exclusive destination guarantee, such as a same-filesystem hard link, and fail if unsupported. Remove only this invocation's staging file on failure. An existence precheck alone cannot prevent a concurrent overwrite. Verify that the destination parent can be created and written before inference; disk failure later can still leave a charged request without a clip.
5. Report output path, model, speaker, character count, byte count, elapsed time, and Cloudflare's `cf-ray` header when present. Do not print the token or Authorization header.

Use the fixed Cloudflare HTTPS origin and reject redirects. The 60-second deadline must cover fetching headers and consuming the entire body, aborting the underlying fetch on timeout. Never add retry middleware. MIME and size validation are transport checks, not an MP3 decoder; playback remains the real validity check.

If MeloTTS is added later, its request is different:

```json
{
  "prompt": "Hello from Baton. This is a short test of text to speech using Cloudflare Workers AI.",
  "lang": "en"
}
```

Its output schema allows binary MP3 or a JSON object containing base64 `audio`. A MeloTTS adapter must inspect content type, validate the JSON envelope/result where present, and decode base64 into bytes. Do not apply Aura's `text` or `speaker` fields to it.

There is also a generic endpoint, `POST /accounts/{ACCOUNT_ID}/ai/run`, with body `{ "model": "…", "input": { … } }`. The pinned `cf ai run` implementation uses that endpoint. The proposed Effect script should use the documented model-specific endpoint; do not mix the two body shapes.

## Authentication and environment variables

### Use the account ID already in the repo

`wrangler.jsonc` already contains account ID `87997fc2724b0127effb8e4524989975` at `vars.CLOUDFLARE_ACCOUNT_ID`. Its staging and production vars contain the same value. This is currently an application binding used by the admin Durable Object explorer, not a top-level Wrangler `account_id` property.

Recommendation for the Effect script: an explicit `CLOUDFLARE_ACCOUNT_ID` environment override wins; otherwise parse `wrangler.jsonc` with the already installed `jsonc-parser` and read the top-level vars value. Validate the result. Do not read `worker-configuration.d.ts` or hard-code the ID again. This makes the existing value accessible without moving configuration or importing Worker-only code into a Node script.

`cf` does not infer this binding from `wrangler.jsonc`. It now gets its account default from the checked-in `cloudflare.config.ts`. The Effect speech script should still read Wrangler's existing value as described above.

### Account config: created, separate from Wrangler

`cloudflare.config.ts` now contains only the non-secret account ID. Its comment states that it is for ad hoc `cf` API experiments, independent of the app's existing Wrangler/Vite setup. There is no Worker definition, app import, binding, or credential in it.

Its account setting is:

```ts
export default {
  accountId: "87997fc2724b0127effb8e4524989975",
};
```

The direct-object export is supported by the pinned CLI's settings loader. `CLOUDFLARE_ACCOUNT_ID` in the environment overrides it. The duplication with Wrangler is intentional; update both if the account changes.

Wrangler remains the app configuration authority. The existing Vite config does not enable `experimental.newConfig`, the package scripts do not use `--experimental-new-config`, and integration tests explicitly select `wrangler.jsonc`. No development, build, deployment, or test commands have been changed.

Cloudflare's new programmatic format is a migration direction, but it is still in beta. We are **not migrating**. Use `cf` only for selected API/auth commands. Do not run `cf init`, `cf migrate`, `cf dev`, `cf build`, `cf deploy` (even `--dry-run`), previews, or Worker build/upload commands. Do not enable the experimental config flags or `CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT`. Account-only configuration is not deployable Worker configuration.

### Where the credential lives

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are exported in the user's shell profile (`~/.zshrc`). The globally installed `cf` and `scripts/tts.ts` both read them from the process environment. There is no repo-local credential file, no `.env.cf*` file and no `--mode` flag. `cf` is installed globally, not as a dependency of this repo.

`cloudflare.config.ts` stays as the checked-in, non-secret account default for ad hoc `cf` API commands. Process values override it. Avoid putting the operator credential in `.env` or `.env.local`, which the app's env loading also reads.

### Setup verification

The following command outcomes were recorded by the 2026-10-03 research, not rerun as authenticated checks in this review. This review confirmed the checked-in config, dependency pins, ignore rules, test discovery configuration, and local credential file's existence and mode without reading its contents.

- `pnpm fmt`, `pnpm typecheck`, and `pnpm lint` passed after creating the files.
- `cf accounts tokens list --dry-run` resolved the expected account ID from the setup and printed the intended GET URL without making the token-list API request.
- Wrangler type generation still used `wrangler.jsonc`. No app configuration, deployment command, or running server was changed.

The dry-run verifies account resolution, not authentication. Confirm a nonblank local token value before authenticated commands; otherwise `cf` may fall back to stored OAuth credentials rather than the intended token.

### One token for account operations and AI

Use **one manually created API token**, exported as `CLOUDFLARE_API_TOKEN` in the shell profile. The same secret authorizes `cf` commands and the speech REST request. The account ID selects a target; the token's permissions authorize actions. The variable name does not grant permissions. No token manager, second AI token, Global API Key, Deepgram key, or token-creation scripts are needed.

For the clarified reusable operator goal, recommend an **account-owned custom token**, restricted to the existing paid account. It acts as an account-managed service principal independent of one user's continued membership. Cloudflare describes user tokens as a better fit for ad hoc scripting; a user-owned custom token on this account remains the fallback if your role cannot provision an account-owned token. Cloudflare's current compatibility matrix supports Workers, Workers AI, Workers Observability, Durable Objects, Workflows, D1, KV, R2, and DNS with account-owned tokens. Ownership does not reduce the permissions or production reach. Do not create both.

The user selected **no expiration**, superseding the earlier 180-day recommendation. A forgotten or leaked token remains usable until revoked. Review scopes periodically and revoke on suspected exposure; no second token or expiry reminder is required. No expiration does not limit spending.

### Created token and credential cleanup

Dashboard metadata verified on 2026-10-04:

- Name: `cf` (lowercase in the saved metadata).
- Ownership and scope: account-owned, entire account `87997fc2724b0127effb8e4524989975`, not a project restriction.
- Created (`issued_on`): `2026-10-04T20:20:43Z`. The dashboard also has a **Created** column; a date in the name is unnecessary.
- Status: active; no expiration.
- Exact saved grants: **Workers Admin**, **Workers AI Read**, **Workers AI Write**, **D1 Write**, **Workers KV Storage Write**, **Workers R2 Storage Write**, **Queues Write**, **Account Analytics Read**, and **Account Settings Read**.
- No separate legacy Workers Scripts, Tail, or Observability grants were added; the modern Workers Admin role was available in the account-token form.

The user reports credential cleanup complete. Keep the existing read-only Cloudflare Agent token, the two matched Workers Builds credentials, and Motio's separate read-only application credential. Motio's staging and production env values were verified against its token ID without printing the secret; both deployed Workers expose the corresponding secret name, not its value. Do not replace that narrow application credential with `cf`.

The old account-owned **Edit Cloudflare Workers** token was created on 2025-06-04 and last used less than two minutes later. Deletion was recommended because of its inactivity, but was not independently verified after the user reported cleanup complete. Its legacy policy included Pages, Browser Run, Workers CI, and zone-route access that `cf` deliberately does not duplicate. The new token is not an exact replacement for every old grant. Dashboard metadata checks do not prove that the local `cf` CLI is using the new secret or that every granted endpoint works.

### Permission choice: speech minimum or broader operator access

**Speech-only minimum, for context:** Account > Workers AI Read + Edit/Write, restricted to this account. Cloudflare's REST setup explicitly asks for both. This also lets `cf` inspect AI models and schemas; it does not authorize Worker, D1, or KV management. It permits other Workers AI inference too, not only Aura-1 or 500 characters, and is not a spending cap. This is not the user's chosen operator scope.

**Confirmed operator goal:** direct management, not inspection-only, for general developer-platform work across this account. The saved policy covers Baton's current services plus R2 and Queues; it is not limited to Baton. No zone permissions are selected. There is no universal “everything in Cloudflare” permission worth granting here.

This is broader than a speech-only token: it can operate Baton's existing Cloudflare services, not just inspect them. Prefer the current Workers role selector where available; use Account permissions for the other products. Dashboard labels may say **Edit** where API references say **Write**.

| Permission                                                  | Why include it                                                                                                                                       | What to understand                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers AI Read + Edit/Write                                | Inspect models and run AI inference, including speech                                                                                                | Inference can incur usage charges.                                                                                                                                                                                          |
| Workers > Admin, at Workers product scope                   | Create, inspect, update, deploy, rename, and delete current and future Workers; manage settings, secrets, versions, and implementing Durable Objects | Product-level **Editor** cannot create/delete Workers. Admin is appropriate for the requested full lifecycle, and can affect production.                                                                                    |
| Workers Tail Read, if using legacy selectors                | Read live Worker logs through supported tail tooling                                                                                                 | Current Workers roles include observability access; legacy Tail Read maps to Metadata Read-Only. Do not duplicate it if the current Admin grant already supplies access. Keep `pnpm tail` for streaming.                    |
| Workers Observability Edit/Write, if using legacy selectors | Query stored Worker logs and traces with `cf observability telemetry query`                                                                          | The endpoint lists legacy **Workers Observability Write**. Current role documentation maps this to Editor; Admin provides higher Workers access. Verify the bounded query after setup, not by adding unrelated permissions. |
| D1 Edit/Write                                               | List databases, query SQL, and manage databases                                                                                                      | Can read personal/session data, change rows, and delete databases. Do not treat a query command as read-only just because it says query.                                                                                    |
| Workers KV Storage Edit/Write                               | Inspect and manage namespaces and stored values                                                                                                      | Can read and overwrite values or delete namespaces.                                                                                                                                                                         |
| Workers R2 Storage Edit/Write                               | Manage R2 resources and objects; confirmed for the reusable operator                                                                                 | Can delete buckets/data and incur charges. This API token is not an S3 access-key pair; S3-compatible tooling has a separate credential format.                                                                             |
| Queues Edit/Write                                           | Manage queues and consumers; confirmed for the reusable operator                                                                                     | Can disrupt delivery or consume messages. This permission is not a delivery safety guarantee or spending cap.                                                                                                               |
| Account Analytics Read                                      | Inspect account usage and analytics                                                                                                                  | Useful for diagnosis; not a spending cap.                                                                                                                                                                                   |
| Account Settings Read                                       | Inspect account metadata                                                                                                                             | No account settings write access.                                                                                                                                                                                           |

**Legacy dashboard fallback:** API references and some token forms still expose Workers Scripts Edit/Write, Workers Tail Read, and Workers Observability Edit/Write instead of the new roles. Cloudflare says these legacy grants still work and have no deprecation date, but its replacement table maps Scripts Edit to **Editor**, not Admin. If the form only offers legacy permissions, use those three for documented script/log operations, then inspect the policy summary and verify how full create/delete rights are represented. Do not claim the token has current product-level Admin rights merely because Scripts Edit is selected. Prefer the account-owned form with the explicit Workers Admin role if available; do not test create/delete permissions by mutating production during setup.

**Durable Objects:** no separate invented "Durable Objects Edit" permission. Access follows the implementing Worker's role. The object-list API lists legacy Workers Scripts Read/Write; Data Studio needs at least Editor on the implementing Worker. Namespace/object enumeration is not a promise that `cf` exposes arbitrary SQL into each private SQLite store. Data Studio is a dashboard capability; Baton's explorer has its own application authentication. D1 permission does not grant access to Durable Object SQLite. Deployments and migrations can change or remove object state, so they remain reviewed writes.

**Workflows:** instance-listing accepts legacy Workers Scripts Read/Write or Workers Tail Read. Instance creation and status mutation explicitly list Workers Scripts Write. The current Workers role mapping replaces Scripts Write/Edit with Editor; use Admin for the broader Worker lifecycle goal and verify Workflow access on the particular endpoint after setup. No separate Workflows permission was established as necessary by these endpoints.

**Bindings are not direct resource access:** deploying a Worker with D1/KV/R2 bindings needs Worker Editor or higher, not those products' own permissions. Direct `cf` D1, KV, and R2 operations need their corresponding grants, which is why the operator policy includes them separately. A Worker you can deploy can itself access its bound data; Worker write access is already a significant data-access power.

**Production warning:** local, staging, and production use the same account. An account-scoped credential is not restricted to `wt-02` because of its filename or name. This recommended token can affect production. Permissions enable operations; they are not instructions or approval for an agent to perform them.

### Optional expansion, not required for Baton today

| Add when needed                                                                | What it enables                                                                         | Trade-off                                                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone > Zone Read, DNS Edit/Write, Workers Routes Edit/Write                    | Discover selected zones, manage DNS records and Worker routes/custom-domain connections | Scope these to named zones, not every zone. DNS or route mistakes can take a site offline. Account ID does not select a zone; pass `--zone` for zone commands. |
| Account > Vectorize Edit/Write, AI Gateway Edit/Write, Browser Run permissions | Vector search, AI proxy/analytics, or browser experiments                               | Add the specific product only when testing it; access does not enable a paid plan or cap its charges.                                                          |
| Email product permissions                                                      | Manage the relevant sending/routing configuration                                       | Match the exact Email Sending or Routing endpoint first; these are different capabilities, not generic email access.                                           |

Do **not** add Account API Tokens Write or User API Tokens Edit: no credential minting or revocation through this token is needed. Also leave out membership/role management, Billing Edit, Account Settings Write, registrar/domain-transfer, and unrelated security/Zero Trust administration. These add escalation, financial, or account-wide disruption risk without helping the current work.

The created operator policy includes R2 and Queues; expand the **same token** deliberately for other needed products. Account ownership does not grant D1, KV, R2, or Queues implicitly. DNS/routes are excluded by choice: current Workers docs require Zone > Workers Routes Write even with Worker access when changing Routes or Custom Domains, so those operations will be blocked. Zone Read helps discovery; DNS Write is needed for direct DNS record management, not generic D1 or AI work. Do not add every zone or unrelated services just for future convenience.

If the dashboard supports editing this token's policy, add scopes there when needed. Policy-editing and whether it preserves the secret must be checked in that form; do not promise that every future expansion avoids replacement. Broad initial scopes reduce future setup friction, but increase the damage possible from a leak. Do not assume D1 Read is a SQL safety sandbox: the query endpoint accepts both Read and Write, which does not establish whether it enforces read-only SQL. Do not probe mutations against production to find out.

### What the pinned `cf` can do

The installed CLI is **1.0.0-beta.12**. Its command search/help/schema confirmed these API surfaces without authenticated calls:

| Task                                     | Command                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| List Workers                             | `cf workers list`                                                                                |
| Query stored Worker logs/traces          | `cf observability telemetry query --body @<query.json>`                                          |
| List Durable Object namespaces / objects | `cf durable-objects namespaces list`; discover the objects-list command for a selected namespace |
| List/query D1                            | `cf d1 list`; `cf d1 query <database-id> --sql 'select 1 as ok'`                                 |
| List KV namespaces                       | `cf kv namespaces list`                                                                          |
| Inspect Workflow instances               | `cf workflows instances list --help` for required workflow selection                             |
| Inspect Aura-1's schema                  | `cf ai get-model-schema --model '@cf/deepgram/aura-1'`                                           |

Stored-log queries require observability to be enabled on the Worker and data to be within retention; Baton's staging/production config already enables observability. Query JSON needs an explicit bounded timeframe and query parameters; it is not a plain grep. `cf logs query` is a separate Log Explorer SQL surface, with separate datasets/availability; do not confuse it with Workers telemetry.

No live Workers tail command was found in this pinned CLI's command search or generated Workers command tree. Keep the existing Wrangler-backed `pnpm tail` commands; do not replace them with `cf tunnels tail`, which streams cloudflared tunnel logs, not Worker logs. Wrangler does not automatically load `.env.cf.local`; the permission enables tail access but the existing tail command's authentication remains separate.

For new tasks, use `cf cli search "<action and resource type>"`, then the discovered command's help and `cf schema` equivalent. Keep search queries anonymous. Preview supported commands with `--dry-run`, review account/zone/resource and payload, then obtain approval before remote writes. CLI support is not a guarantee that every service or API endpoint is exposed or that this token is authorized. In particular, `cf ai run <model> --help` and `--dry-run` with model flags can fetch the schema remotely; use a supplied `--body` to avoid that lookup. The proposed `pnpm tts --dry-run` has a stricter, fully offline contract.

### Token setup record and remaining checks

Steps 1–5 describe the completed dashboard setup, not a request to create another token. Local storage and `cf` preflights remain to be confirmed.

1. Sign in to the Cloudflare dashboard and select the Workers Paid account matching `cloudflare.config.ts`: `87997fc2724b0127effb8e4524989975`.
2. Use **Manage account > Account API tokens > Create Token**, then enter name, permissions/roles, and expiry. Account-owned creation requires Super Administrator or API Token Provisioning capabilities, and you can grant only permissions you hold. If unavailable, use **My Profile > API Tokens > Create Token > Create Custom Token** for the user-owned fallback on the same account. Do not use the Global API Key or the "Create additional tokens" template.
3. Use name `cf`, without a project name or date suffix. Add the confirmed policy above, including R2 and Queues and **Workers Admin at product scope**. Select **Entire Account** within this account, not all accounts. Add **no Zone permissions**. Review the resulting policy summary. The name is descriptive, not a resource restriction; creation time is available in metadata.
4. Select **No expiration**, as ultimately requested. Leave client-IP restrictions empty unless you have a stable public egress IP; changing home/VPN addresses otherwise breaks the CLI. The reviewed setup allowed all IP addresses.
5. The user created the token. Save its one-time secret in the password manager under that name. Record scopes, account, creation time, no-expiration choice, and token ID there—not in env variables. Never paste the secret into chat.
6. Export the secret in the shell profile (`~/.zshrc`) as `CLOUDFLARE_API_TOKEN`, and the account ID as `CLOUDFLARE_ACCOUNT_ID`. Never put either in a file in this repo.
7. Confirm the exported `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are the intended ones, without displaying secrets: process values override `cloudflare.config.ts`.
8. Start with a read-only AI preflight, after confirming that the intended token is nonblank without printing it:

```bash
cf ai get-model-schema --model '@cf/deepgram/aura-1' --dry-run
cf ai get-model-schema --model '@cf/deepgram/aura-1'
```

If you selected the broader operator option, these additional read-only preflights are relevant; omit them for an AI-only token:

```bash
cf workers list --dry-run
cf workers list
cf d1 list
cf kv namespaces list
cf ai get-model-schema --model '@cf/deepgram/aura-1'
```

Success proves access to those operations, not every granted capability or inference. A 403 requires checking the specific permission, resource scope, and membership; a missing CLI permission option is not a reason to grant everything. The first approved speech request will verify inference. The user created the operator token and dashboard metadata confirms its saved policy; the authenticated `cf` preflights above and speech inference have not been executed as part of this review.

9. When the reusable operator role is no longer needed, revoke this named token in the same dashboard token page and clear the local value. Do not revoke it merely because the speech test ends if it is still needed for approved account work. If rotation is needed, replace it deliberately through the dashboard and update the password manager and local file. No second management credential is needed.

### Script secret handling

For a real request, the proposed speech CLI reads `CLOUDFLARE_API_TOKEN` from the process environment with Effect `Config.redacted`, unwrapping only for the Authorization header. It must reject missing, blank, or whitespace-only values without OAuth fallback. This uses the one selected token; if it has operator permissions, a leak exposes those powers too. Redacted configuration does not automatically sanitize a raw header embedded in an HTTP error. Map request-bearing failures to explicit safe fields before logging, and test with a sentinel token in transport errors and server messages. Never include the secret in artifact metadata or browser/deployed app variables. Do not repurpose `CLOUDFLARE_WORKERS_API_TOKEN`, reserved for the admin Durable Object explorer. If this grows into unattended production work, revisit credential separation; it is not part of this experiment.

## Pricing and free allocation

Your $5 Workers Paid plan is sufficient for this experiment. Workers AI has a separate included allocation of **10,000 neurons per day**, resetting at **00:00 UTC**. Paid usage above that allocation costs **$0.011 per 1,000 neurons**. The allocation is shared by Workers AI usage on the account, not reserved for this script or each model. The $5 subscription is not a hard cap on AI charges.

| Model                     | Published neuron rate             | Approximate use of an otherwise unused daily allocation |
| ------------------------- | --------------------------------- | ------------------------------------------------------- |
| Aura-2 English or Spanish | 2,727.27 / 1,000 input characters | 3,667 input characters                                  |
| Aura-1                    | 1,363.64 / 1,000 input characters | 7,333 input characters                                  |
| MeloTTS                   | 18.63 / generated audio minute    | 537 generated audio minutes                             |

These are arithmetic estimates, not guaranteed request counts or measured metering. Actual usage and any billing rounding are authoritative in the Workers AI dashboard.

For a 100-character Aura-1 request, the estimate is about **136 neurons**, or **$0.0015** if the free allocation is already exhausted. Three such requests would use about **409 neurons**, or **$0.0045** at the overage rate. Aura-2 would double those estimates. A short test is inexpensive, but it is not necessarily free if other account activity has used the daily allocation.

The actual fixed sentence above has **85 ASCII characters**, including spaces and punctuation: approximately **116 neurons**, or **$0.001275** per Aura-1 request at the overage rate. These are estimates, not observed charges. For future non-ASCII text, use a documented character-count convention rather than treating JavaScript UTF-16 code units as confirmed billing units.

Before testing, check the Workers AI dashboard's usage. Recommend a local maximum of 500 characters, one request per invocation, no automatic retry, and at most three initial invocations. Three maximum-length Aura-1 requests are estimated at 2,046 neurons, or $0.0225 without any remaining free allowance. The approved short sentence is much smaller. A timeout cannot prove the server did not generate and meter audio; do not automatically resubmit after one.

No account usage or subscription details were queried during research. These limits constrain this experiment, not other clients or a hard account-wide budget.

## Proposed Effect CLI

The model, voice, text, account choice, tolerance for small overages, root temporary-file convention, and broad operator goal are settled. Token creation is complete. Confirm local credential storage, then obtain approval to implement and test offline before the first real request.

Suggested files:

- `cloudflare.config.ts`: checked-in account-only default for ad hoc `cf` API commands; no Worker definition or secrets, no Wrangler migration.
- `scripts/tts.ts`: command entry, fixed text, configuration, HTTP call, and file output. Keep it in one file initially.
- `scripts/tts.test.ts`: mocked HTTP/filesystem tests using Node's built-in test runner; no paid API calls. Keep command startup behind a direct-entry guard so importing the module does not invoke the CLI.
- `package.json`: proposed `tts` script: `node scripts/tts.ts`; proposed `test:tts` script: `node --test scripts/tts.test.ts`. Existing Vitest projects include only integration and browser tests, so putting a test under `scripts/` alone does not make `pnpm test` run it. Run `pnpm test:tts` explicitly and add it to CI if this experiment becomes maintained tooling.
- `.gitignore`: add the accepted root-only `/tmp/` ignore rule during implementation; it has not been installed yet.

The project already has `effect` and `@effect/platform-node` **4.0.0-rc.112**. No extra SDK, `@effect/cli`, `@effect/platform`, TypeScript runner, or Cloudflare package is needed. Follow the existing CLI shape in `scripts/refresh-shopify-playwright-auth.ts`:

- `Command` and `Flag` from `effect/unstable/cli`.
- `Command.make`, `Command.run`, `Effect.gen` or `Effect.fn`, and `NodeRuntime.runMain`.
- `NodeServices.layer` for local platform services, including `FileSystem` and `Path`.
- `HttpClient`, `HttpClientRequest`, and `FetchHttpClient` from `effect/unstable/http`; provide `FetchHttpClient.layer` as well as Node services.
- A redacted configuration value for the token; typed failures for configuration, HTTP status, invalid audio, timeout, and file output.

Recommended initial command surface:

| Option      | Default                                         | Reason                                                                                                                 |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--output`  | `tmp/tts/<UTC-timestamp>-<short-id>/speech.mp3` | One directory per attempt; refuse overwrites                                                                           |
| `--dry-run` | false                                           | Print model, speaker, fixed text, character count, output, and estimated neurons; make no request and require no token |

Keep model, speaker, MP3 encoding, test text, and a 60-second whole-request/body deadline as constants initially. The text is easy to change: edit one `TEST_TEXT` constant and preview with `--dry-run`; no protocol or credential changes are needed. Use an absolute repo-root path derived from the script location, not the shell's current directory, for config and default output. Avoid accepting arbitrary model URLs or exposing credentials as flags. Add model/voice selection only when we actually want to compare voices; validate each model's schema rather than sending one common body to every model. Fail early on missing/blank credentials, invalid account ID, or an existing destination, before inference.

Parse flags before reading credentials. For a real request only, read the token from the process environment. Dry-run must not require the secret and must not initialize any client that performs network work. It may read non-secret account configuration. Validate the 500-character maximum locally and include the account ID in the preview and non-secret result metadata.

Proposed use after implementation:

```bash
pnpm tts --dry-run
pnpm tts
```

### Playback: `afplay` is already installed

`afplay` is Apple's command-line Audio File Play utility, bundled with macOS at `/usr/bin/afplay`. This machine has it: `command -v afplay` returned that path and its `-h` option printed Apple's usage. Its help invocation exits with status 1, which is not evidence that playback is unavailable. No Homebrew package or installation is required.

It plays a local audio file through the normal macOS audio output and keeps the terminal command running until playback ends. Use Ctrl-C to stop. It does not perform synthesis, modify the file, or require an API credential. Actual playback has not been tested because no clip has been generated.

Use the exact path printed by the future CLI:

```bash
afplay "tmp/tts/<attempt>/speech.mp3"
```

Replace `<attempt>` with the generated directory name. `afplay -v 0.5 "path/to/speech.mp3"` sets playback volume; `afplay -t 5 "path/to/speech.mp3"` limits playback to five seconds. Keep playback outside the script: `afplay` is macOS-specific, while other systems can use their existing media player.

Acceptance checks:

1. Dry-run works with an absent credential file, needs no credential, and performs no HTTP call or file write, including when invoked from another working directory.
2. Invalid configuration and an existing output fail before any billable request.
3. A mocked successful MP3 response writes exactly the supplied non-empty bytes.
4. Authentication failures, permission failures, rate limits, server errors, HTTP 200 JSON errors, unexpected MIME types, empty or oversized bodies, interrupted reads, and filesystem write failures never produce a misleading MP3. A concurrent destination creation is not overwritten. Metadata failure must not be reported as inference failure if complete audio was already published.
5. Error output does not reveal a sentinel token, Authorization header, or full request object.
6. Timeouts while waiting for headers and while reading the body abort the transport; timeouts and failures are not retried automatically. Redirects are rejected.
7. The real test creates one file that plays and speaks the intended text. Record model, voice, timing, size, and dashboard usage observations without secrets.

After implementation, run `pnpm fmt`, `pnpm typecheck`, `pnpm lint`, and the focused tests. Research alone does not require typecheck or lint.

## Project-wide temporary work files

Recommend a lowercase repo-root **`tmp/`**, scoped to each worktree, for disposable experiment inputs and outputs. Keep `logs/` for diagnostic logs, not voice files or screencasts. The repo currently has no root temporary-artifact convention; tests sometimes use the operating system's temporary directory for automatic cleanup.

Proposed layout:

```text
tmp/
  tts/<UTC-timestamp>-<short-id>/
    speech.mp3
    metadata.json
  screencasts/<UTC-timestamp>-<short-id>/
    storyboard.json
    capture.webm
    narration.mp3
  video/<UTC-timestamp>-<short-id>/
    ...
```

Secrets and token inventories do not belong in this disposable tree.

| Location            | Advantage                                                                                               | Trade-off                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `tmp/` at repo root | Easy to find, inspect, play, and share paths; one artifact tree per worktree; works for audio and video | Needs a Git ignore rule and deliberate cleanup; large videos consume disk space          |
| Hidden `.tmp/`      | Less visible in file browsers                                                                           | Easier to forget artifacts; no benefit for secrets, since hiding is not security         |
| OS temp directory   | Good for short-lived test scratch; no repo ignore needed                                                | Harder to discover and reuse across experiments; cleanup/lifetime is outside the project |
| Existing `logs/`    | Already ignored                                                                                         | Mixes media assets with server diagnostics; gives cleanup the wrong scope                |

Proposed `.gitignore` addition:

```gitignore
# Disposable local experiment files; keep recipes and findings in scripts/ and docs/.
/tmp/
```

The leading slash ignores only the root artifact tree, not arbitrary nested directories named `tmp`. No placeholder file is needed: Git does not track empty directories. The scripts create their own directories. This artifact rule has not been added; the separate credential ignore rule is already installed.

Rules to adopt with the convention:

- One attempt directory per invocation, named with UTC time and a short random suffix. Do not overwrite previous clips by default.
- Put only disposable artifacts there. Keep repeatable recipes in `scripts/`, findings in `docs/`, and intentional test fixtures in the test tree. Promote an artifact deliberately if it must be kept or committed.
- Save non-secret metadata beside output: model, speaker, input text, timing, size, and request identifier. Use synthetic data; never capture Authorization headers or credentials. Git ignore is not access control or protection from backups.
- No automatic age-based deletion during experiments. Delete only explicitly selected attempt directories after review; media may be needed for a comparison. Do not add a broad cleanup command yet.
- Do not read or clean another worktree's artifact tree. For ephemeral unit-test scratch, continue using OS temp directories with per-test cleanup rather than this manual experiment tree.

## Questions and recommendations

Settled in annotation review:

- Existing Workers Paid account.
- Aura-1 only, with short synthetic test text. No model comparison yet.
- Small overage charges are acceptable; no large or repeated batches.
- The proposed test sentence is fine and can be edited later.
- One manually created token for `cf` management and AI, with only `CLOUDFLARE_API_TOKEN` exported in the shell profile. No token-provisioning workflow or second credential.

Confirmed in the 2026-10-04 discussion:

- Full operator access, not AI-only or inspection-only. Research the actual service grants rather than granting unrelated account administration.
- One reusable account-owned credential named `cf`, created with no expiration and the verified operator policy above. No project/date suffix and no second speech token.
- Root `tmp/` accepted, with the proposed unique-attempt layout and root-only ignore rule. Install the convention during implementation, not as part of this research edit.
- **Token setup first**. Creation is complete; local credential storage and authenticated `cf` preflights remain unverified. Do not implement the speech CLI or send inference without further approval.
- Account-owned operator recommendation accepted; **180-day expiry**, **R2 and Queues included**, and **account services only, no route/custom-domain/DNS grants**.

Questions asked and resolved before token creation:

Config decisions are implemented: account-only `cloudflare.config.ts`. The credential is exported in the shell profile. Wrangler remains authoritative for the app. Use `cf` for selected API operations, not to build or deploy the app.

| Question                                            | Recommendation and context                                                                                                                                              | Alternatives and consequences                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Include R2 and Queues beyond the baseline services? | **Yes, confirmed.** Account > Workers R2 Storage Edit/Write and Queues Edit/Write. Common related services avoid a later scope change for storage or asynchronous work. | R2 grants can delete data and incur charges; Queues grants can disrupt delivery or consume messages. Neither is needed for the speech clip. Leave Vectorize, AI Gateway, Browser Run, Containers, and unrelated products out until needed. |
| Include route/custom-domain or DNS management?      | **No, confirmed: account services only.** Do not add Zone permissions.                                                                                                  | Worker and data-service management works, but route/custom-domain and DNS changes will be blocked. Add named-zone rights later only for an explicit task.                                                                                  |
| Use 180-day expiry or no expiry?                    | **180 days, confirmed.** Account-owned ownership matches the reusable goal, with one password-manager expiry reminder.                                                  | No monthly rotation; a forgotten credential has a bounded lifetime. Revoke immediately if exposed. Expiry does not cap spending. Use the user-owned fallback only if account provisioning is unavailable.                                  |

Do not reopen the settled `luna` voice or test text just to proceed. Store token details and an expiry or periodic-review reminder in the password manager, not extra env keys. If the account-token form exposes only legacy Worker grants, inspect its non-secret policy summary before asserting full lifecycle access.

### Recommended sequence

1. Use the confirmed account-only policy, including R2 and Queues, with account-owned ownership and 180-day expiry. The remaining dashboard-dependent check is whether the form exposes Workers product-level Admin or only legacy grants; inspect the non-secret policy summary if unclear.
2. Manually create the one token with the chosen policy, save it in the password manager, and export it as `CLOUDFLARE_API_TOKEN` in the shell profile. Never send the secret through chat. If already populated, confirm its intended scope and expiry instead of creating a duplicate.
3. With approval, verify the intended credential using read-only service preflights: Worker list, D1 list, KV namespace list, selected AI schema, and a bounded telemetry query. Check the non-secret policy summary for Workers product-level Admin. Read-only success cannot prove create/delete rights; do not mutate production to test them.
4. After token setup, obtain approval to implement the CLI and mocked Node tests. Run `pnpm fmt`, `pnpm typecheck`, `pnpm lint`, `pnpm test:tts`, and credential-free `pnpm tts --dry-run`. Review dashboard usage and the dry-run's account, model, text, output, and estimated cost.
5. Approve and send **one** speech request, then play the exact output path with `afplay`. Record model, voice, end-to-end time, file size, `cf-ray`, playback result, and any visible usage change. Dashboard usage may lag or include other activity; do not attribute a precise per-request charge from an account total.
6. Stop the speech experiment after the playable clip. If the next goal is narration or screencasts, evaluate quality and pronunciation with a representative synthetic script before adding batch generation or app integration. Aura-2's small absolute cost difference should not block that later quality test. The reusable operator token may remain for approved management work; revoke it when that role ends or exposure is suspected, not automatically after one clip.

No speech CLI or inference results exist in this checkout. This review did not establish whether a token has been created outside the checkout.

## Sources

Public documentation checked on 2026-10-03. The 2026-10-04 review rechecked REST setup, pricing, Aura-1 and its output schema, Aura-2 English's input schema, MeloTTS's output schema, account-owned token guidance, programmatic configuration, and the telemetry/D1/Workflow permissions cited below. Other entries remain evidence from the earlier research, not newly executed checks.

- [Workers AI REST setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/): dashboard token creation, account ID, and required Workers AI Read + Edit permissions.
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/): daily allocation, reset time, paid overage, and audio model rates; page last updated 2026-10-01.
- [Aura-2 English](https://developers.cloudflare.com/workers-ai/models/aura-2-en/) and its [input](https://developers.cloudflare.com/workers-ai/models/aura-2-en/schema-input.json) / [output](https://developers.cloudflare.com/workers-ai/models/aura-2-en/schema-output.json) schemas.
- [Aura-2 Spanish](https://developers.cloudflare.com/workers-ai/models/aura-2-es/) and [Aura-1](https://developers.cloudflare.com/workers-ai/models/aura-1/); their current input schemas were checked for voice defaults and fields.
- [MeloTTS](https://developers.cloudflare.com/workers-ai/models/melotts/): different input fields, audio response alternatives, and more precise minute price.
- [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/): custom permissions, account/zone resources, IP restrictions, and TTL.
- [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/): dashboard path, creation-role requirement, and current product compatibility matrix.
- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/): Account/Zone/User permission categories; current page last updated 2026-10-01.
- [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/) and [Durable Objects authorization](https://developers.cloudflare.com/workers/authorization/durable-objects/): granular Worker scope, deployment/route permissions, and inherited Durable Object access.
- Rechecked on 2026-10-04 after the operator clarification: the Workers role page distinguishes Admin from Editor, maps legacy Scripts Edit to Editor, and says binding-resource permissions are separate from direct API access. The Durable Objects role page and [Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/) establish inherited Worker authorization, not a generic `cf` SQL capability.
- [Workflow instance creation](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/create/), [Workflow status mutation](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/subresources/status/methods/edit/), and [Durable Object enumeration](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/): endpoint-specific legacy permission labels rechecked on 2026-10-04. The public permission catalogue confirms R2, Queues, D1, KV, AI, and zone route/DNS groups; no live authorization was tested.
- [Workers telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/): Workers Observability Write requirement.
- [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/) and [Workflow instances API](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/list/): accepted permissions on these specific endpoints.
- [Programmatic configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/): open-beta status and explicit support for account-only exports in API commands; current page checked after the second review, last updated 2026-09-29.
- [Develop, build, and deploy](https://developers.cloudflare.com/cf/projects/): lifecycle/autoconfiguration boundary and warning that automatic configuration ignores existing Wrangler files; local source checked after the second review.

Local references and implementation evidence:

- `refs/cloudflare-docs/src/content/workers-ai-models/{aura-1,aura-2-en,aura-2-es,melotts}.json`: model catalogue entries and schemas.
- `refs/cloudflare-docs/src/content/docs/workers-ai/platform/pricing.mdx` and `get-started/rest-api.mdx`: pricing and REST authentication.
- `refs/cloudflare-docs/src/content/docs/fundamentals/api/get-started/create-token.mdx` and `account-owned-tokens.mdx`: dashboard creation and account-owned/user-owned distinction.
- `refs/cf/packages/cli/src/commands/ai/run/index.ts`: generic inference endpoint, nested `input`, and raw binary output.
- `refs/cf/packages/cli/src/lib/auth-token.ts`: API token/OAuth resolution and disabled Global API Key authentication.
- `refs/cf/packages/cli/src/lib/project-settings.ts` and `src/__tests__/lib/project-settings.test.ts`: account-settings loading independently of Worker configuration.
- `refs/cf/packages/cli/src/lib/dotenv.ts` and `refs/workers-sdk/packages/workers-utils/src/local-env.ts`: supported Cloudflare env keys, mode-specific filenames, and process/file precedence.
- `refs/workers-sdk/packages/vite-plugin-cloudflare/src/plugin-config.ts` and `refs/workers-sdk/packages/wrangler/src/core/register-yargs-command.ts`: opt-in new-configuration paths; `vite.config.ts`, `package.json`, and `test/integration/vitest.config.ts` do not select them.
- Installed `cf/config` import smoke test: `defineConfig({ accountId: "test-account" })` succeeds without a `worker`. This did not create a config file or invoke an API.
- `refs/effect/ai-docs/src/70_cli/10_basics.ts` and `50_http-client/10_basics.ts`: Effect v4 CLI and HTTP client patterns.
- `scripts/refresh-shopify-playwright-auth.ts`, `package.json`, `.env.example`, and `.gitignore`: local CLI conventions, pinned dependencies, separate explorer token, and ignored output locations.
- `vitest.config.ts` and `test/integration/vitest.config.ts`: existing test projects do not discover `scripts/tts.test.ts`; the proposed Node test command must be wired explicitly.
- `wrangler.jsonc`: existing account ID in top-level, staging, and production vars.
- `/usr/bin/afplay -h` and `command -v afplay`: installed macOS playback utility and supported options; no audio was played.
- Installed `cf --version`, semantic `cf cli search`, discovered command help, and `cf schema observability telemetry query`: AI, Workers, telemetry, D1, KV, Durable Objects, Workflows, and DNS command surfaces in beta.12. No authenticated command was executed.

The original research queried Context7 for Cloudflare Workers AI and the pinned Effect version. This review queried Context7 for Workers AI's Aura-1 REST contract and used current public pages and pinned local source as primary evidence. No authenticated Cloudflare tools were called.
