# Workers AI text-to-speech test

Researched 2026-10-03. The local `cf` account config and blank credential files are now created. The speech CLI remains a proposal. No active credentials were read, tokens created, remote account settings changed, or inference requests sent.

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

The local Cloudflare model catalogue contains four non-deprecated Text-to-Speech entries. Current public pages confirm Aura-2 English and MeloTTS; recheck the account's model list before executing the test.

| Model                    | Input and voice selection                                                                           | Published price                        | Use for this test                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `@cf/deepgram/aura-2-en` | English; `text`; many named speakers, default `luna`                                                | $0.030 / 1,000 input characters        | Possible later upgrade; not part of the first test                    |
| `@cf/deepgram/aura-2-es` | Spanish; `text`; named speakers, default `aquila`                                                   | $0.030 / 1,000 input characters        | Use if the test should be in Spanish                                  |
| `@cf/deepgram/aura-1`    | `text`; named speakers, default `angus`                                                             | $0.015 / 1,000 input characters        | Selected first model; override the default with shared speaker `luna` |
| `@cf/myshell-ai/melotts` | Multilingual; `prompt` and optional `lang`, default `en`; no speaker field in the Workers AI schema | About $0.0002 / generated audio minute | Reference only; not part of the first test                            |

MeloTTS's model page quotes $0.000205 per audio minute; the pricing table rounds this to $0.0002. Its 18.63 neurons/minute corresponds to approximately $0.000205 at the published neuron rate. These are not character prices.

Aura-1 is enough to prove the plumbing. Its schema and Aura-2 English's schema use the same request fields and binary MP3 response. With explicit `speaker: "luna"` and `encoding: "mp3"`, moving this test to Aura-2 English should require changing only the model ID in the endpoint. Voice lists differ, so that is not true for every speaker. Their defaults also differ: Aura-1 defaults to `angus`, Aura-2 English to `luna`.

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
3. Read all bytes within the timeout; reject an empty body.
4. Write the complete file without replacing an existing file by default. Do not leave an apparently valid `.mp3` after a failed request or partial read.
5. Report output path, model, speaker, character count, byte count, elapsed time, and Cloudflare's `cf-ray` header when present. Do not print the token or Authorization header.

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

### What `.env.cf.local` means

We use **`cf --mode cf`** for account operations and AI experiments. It selects the mode-specific env convention:

| Invocation                      | Env-file candidates, lowest to highest file precedence |
| ------------------------------- | ------------------------------------------------------ |
| `pnpm exec cf …` without a mode | `.env`, `.env.local`                                   |
| `pnpm exec cf --mode cf …`      | `.env`, `.env.local`, `.env.cf`, `.env.cf.local`       |

Existing exported process values override file values. `cf` applies only its supported Cloudflare variables, including `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, not every app secret. This is confirmed by `cf`'s dotenv code and the shared env loader. `--mode cf` does **not** mean local simulation or make remote commands safe; it is just the environment mode name.

The `cf` CLI does not load `.env.cf.local` by default. The normal app's Vite development/production modes do not select that file either. The proposed speech script will load it explicitly. Mode selection is not an access-control boundary. Avoid globally exporting the operator credential or putting it in `.env.local`, which ordinary env loading also reads.

Created files:

- `cloudflare.config.ts`: non-secret account default, intended for version control.
- `.env.cf.local`: ignored, owner-only (`600`), containing `CLOUDFLARE_API_TOKEN=` with no value yet.
- `.env.cf.local.example`: blank template with only `CLOUDFLARE_API_TOKEN`. `.gitignore` explicitly ignores the local file and permits the example.

Populate the local file after manually creating the single operator token below. Do not fill in the example. The existing `.env` stays for app development; no second AI credential or extra token metadata variables are needed. Do not add `.env.cf` or copy this credential into staging/production or temporary artifacts.

### Setup verification

- `pnpm fmt`, `pnpm typecheck`, and `pnpm lint` passed after creating the files.
- `pnpm exec cf --mode cf accounts tokens list --dry-run` resolved the expected account ID from the setup and printed the intended GET URL without making the token-list API request.
- `git check-ignore` confirms `.env.cf.local` is ignored and `.env.cf.local.example` is not. The local file has mode `600`.
- Wrangler type generation still used `wrangler.jsonc`. No app configuration, deployment command, or running server was changed.

The dry-run verifies account resolution, not authentication. Fill the blank local token value before authenticated commands; otherwise `cf` may fall back to stored OAuth credentials rather than the intended token.

### One token for account operations and AI

Use **one manually created API token**, stored as `CLOUDFLARE_API_TOKEN` in `.env.cf.local`. The same secret authorizes `cf` commands and the speech REST request. The account ID selects a target; the token's permissions authorize actions. The variable name does not grant permissions. No token manager, second AI token, Global API Key, Deepgram key, or token-creation scripts are needed.

Recommend an **account-owned custom token**, restricted to the existing paid account. Cloudflare's current compatibility matrix supports Workers, Workers AI, Workers Observability, Durable Objects, Workflows, D1, KV, R2, and DNS with account-owned tokens. A user-owned custom token restricted to this same account is a reasonable fallback if your dashboard role cannot create account-owned tokens; it depends on your user retaining access. Do not create both.

### Recommended permissions: a useful operator token

This is broader than a speech-only token: it can operate Baton's existing Cloudflare services, not just inspect them. Add these **Account** permissions when creating the custom token. Dashboard labels may say **Edit** where API references say **Write**.

| Permission                       | Why include it                                                                    | What to understand                                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers AI Read + Edit/Write     | Inspect models and run AI inference, including speech                             | Inference can incur usage charges.                                                                                                                         |
| Workers Scripts Edit/Write       | Inspect and manage Workers, secrets, versions, and deployments; operate Workflows | Can replace or delete deployed code and change secrets. Read access alone would be safer but would not meet the management goal.                           |
| Workers Tail Read                | Read live Worker logs through supported tail tooling                              | Logs can contain sensitive application data. Keep existing `pnpm tail` for streaming.                                                                      |
| Workers Observability Edit/Write | Query stored Workers logs and traces with `cf observability telemetry query`      | The current query endpoint explicitly requires **Workers Observability Write**. Tail Read is not a substitute. This is not a promise of query-only access. |
| D1 Edit/Write                    | List databases, query SQL, and manage databases                                   | Can read personal/session data, change rows, and delete databases. Do not treat a query command as read-only just because it says query.                   |
| Workers KV Storage Edit/Write    | Inspect and manage namespaces and stored values                                   | Can read and overwrite values or delete namespaces.                                                                                                        |
| Account Analytics Read           | Inspect account usage and analytics                                               | Useful for diagnosis; not a spending cap.                                                                                                                  |
| Account Settings Read            | Inspect account metadata                                                          | No account settings write access.                                                                                                                          |

Durable Objects do not require a separate invented "Durable Objects Edit" permission: their access follows the implementing Worker's permissions. Workflows instance-listing accepts Workers Scripts Read/Write or Workers Tail Read; mutation permissions must still be checked on the specific endpoint. Recently introduced granular Workers roles can narrow access to selected Workers, but an account-wide operator token is simpler for the stated goal.

**Production warning:** local, staging, and production use the same account. An account-scoped credential is not restricted to `wt-02` because of its filename or name. This recommended token can affect production. Permissions enable operations; they are not instructions or approval for an agent to perform them.

### Optional expansion, not required for Baton today

| Add when needed                                                                | What it enables                                                                         | Trade-off                                                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zone > Zone Read, DNS Edit/Write, Workers Routes Edit/Write                    | Discover selected zones, manage DNS records and Worker routes/custom-domain connections | Scope these to named zones, not every zone. DNS or route mistakes can take a site offline. Account ID does not select a zone; pass `--zone` for zone commands. |
| Account > Workers R2 Storage Edit/Write                                        | Manage R2 resources for future media storage                                            | Can delete buckets/data and incur storage charges. S3-compatible tooling has its own credential setup; this token is not an S3 access-key pair.                |
| Account > Queues Edit/Write                                                    | Manage queues and consumers                                                             | Changes can disrupt delivery; consuming messages can affect application processing.                                                                            |
| Account > Vectorize Edit/Write, AI Gateway Edit/Write, Browser Run permissions | Vector search, AI proxy/analytics, or browser experiments                               | Add the specific product only when testing it; access does not enable a paid plan or cap its charges.                                                          |
| Email product permissions                                                      | Manage the relevant sending/routing configuration                                       | Match the exact Email Sending or Routing endpoint first; these are different capabilities, not generic email access.                                           |

Do **not** add Account API Tokens Write or User API Tokens Edit: no credential minting or revocation through this token is needed. Also leave out membership/role management, Billing Edit, Account Settings Write, registrar/domain-transfer, and unrelated security/Zero Trust administration. These add escalation, financial, or account-wide disruption risk without helping the current work.

Recommendation: start with the operator table, add DNS/routes only if we will manage them, and expand the **same token** deliberately for new products. "Everything" is not one permission: `cf` covers many APIs, each with its own authorization and plan requirements. If you prefer inspection first, substitute Workers Scripts Read, D1 Read, and KV Read for their write permissions; keep AI Write and Observability Write for inference and stored-log queries. Do not assume D1 Read is a SQL safety sandbox: the query endpoint lists both Read and Write as accepted permissions, so validate its enforcement before relying on that distinction.

### What the pinned `cf` can do

The installed CLI is **1.0.0-beta.12**. Its command search/help/schema confirmed these API surfaces without authenticated calls:

| Task                                     | Command                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| List Workers                             | `pnpm exec cf --mode cf workers list`                                                                                |
| Query stored Worker logs/traces          | `pnpm exec cf --mode cf observability telemetry query --body @<query.json>`                                          |
| List Durable Object namespaces / objects | `pnpm exec cf --mode cf durable-objects namespaces list`; discover the objects-list command for a selected namespace |
| List/query D1                            | `pnpm exec cf --mode cf d1 list`; `pnpm exec cf --mode cf d1 query <database-id> --sql 'select 1 as ok'`             |
| List KV namespaces                       | `pnpm exec cf --mode cf kv namespaces list`                                                                          |
| Inspect Workflow instances               | `pnpm exec cf --mode cf workflows instances list --help` for required workflow selection                             |
| Inspect Aura-1's schema                  | `pnpm exec cf --mode cf ai get-model-schema --model '@cf/deepgram/aura-1'`                                           |

Stored-log queries require observability to be enabled on the Worker and data to be within retention; Baton's staging/production config already enables observability. Query JSON needs an explicit bounded timeframe and query parameters; it is not a plain grep. `cf logs query` is a separate Log Explorer SQL surface, with separate datasets/availability; do not confuse it with Workers telemetry.

No live Workers tail command was found in this pinned CLI's command search or generated Workers command tree. Keep the existing Wrangler-backed `pnpm tail` commands; do not replace them with `cf tunnels tail`, which streams cloudflared tunnel logs, not Worker logs. Wrangler does not automatically load `.env.cf.local`; the permission enables tail access but the existing tail command's authentication remains separate.

For new tasks, use `pnpm exec cf cli search "<action and resource type>"`, then the discovered command's help and `cf schema` equivalent. Keep search queries anonymous. Preview supported commands with `--dry-run`, review account/zone/resource and payload, then obtain approval before remote writes. CLI support is not a guarantee that every service or API endpoint is exposed or that this token is authorized.

### Create the one token: step by step

1. Sign in to the Cloudflare dashboard and select the Workers Paid account matching `cloudflare.config.ts`: `87997fc2724b0127effb8e4524989975`.
2. Go to **Manage account > Account API tokens > Create Token > Create Custom Token**. Account-owned creation requires Super Administrator or API Token Provisioning capabilities. If unavailable, use **My Profile > API Tokens > Create Token > Create Custom Token** for a user-owned token, scoped to the same account. Do not use the Global API Key or the "Create additional tokens" template.
3. Name it `baton-wt-02-cf-operator-<YYYYMMDD>`, using the actual creation date. Add the recommended Account permissions above. Restrict **Account Resources** to this account (where a selector is shown), not all accounts. If adding zone permissions, restrict **Zone Resources** to the specific zones too. Review the resulting policy summary.
4. Set the token's TTL end date to **30 days after creation** for this trial. Omit client-IP restrictions unless you have a stable public egress IP; changing home/VPN addresses otherwise breaks the CLI. An expiry reminder is simpler than extra env metadata.
5. Create it and save the one-time secret in your password manager under that name. Record the chosen scopes, account, creation/expiry, and token ID if shown there—not in env variables. Never paste the secret into chat. Set a reminder before expiry.
6. In a local editor, put the secret in the already-created `.env.cf.local`. Its only required line is:

```dotenv
CLOUDFLARE_API_TOKEN=<the-single-token-secret>
```

Do not modify the example's empty value or add the secret to the app's `.env`. Confirm local protection without printing it:

```bash
chmod 600 .env.cf.local
git check-ignore .env.cf.local
```

7. Use a shell with no stale exported `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`: process values override mode files/config. Check for conflicting overrides without displaying secrets. Always use `--mode cf` for this credential.
8. Start with read-only preflights:

```bash
pnpm exec cf --mode cf workers list --dry-run
pnpm exec cf --mode cf workers list
pnpm exec cf --mode cf d1 list
pnpm exec cf --mode cf kv namespaces list
pnpm exec cf --mode cf ai get-model-schema --model '@cf/deepgram/aura-1'
```

Success proves access to those operations, not every granted capability or inference. A 403 requires checking the specific permission, resource scope, and membership; a missing CLI permission option is not a reason to grant everything. The first approved speech request will verify inference. No authenticated preflight, token creation, or inference has been executed during research. 9. When finished, revoke this named token in the same dashboard token page and clear the local value. To continue after expiry, renew/replace it deliberately through the dashboard and update the password manager and local file. No second management credential is needed.

### Script secret handling

The proposed speech CLI will load `.env.cf.local` and read `CLOUDFLARE_API_TOKEN` with Effect `Config.redacted`, unwrapping only for the Authorization header. This intentionally reuses the operator token; it is simpler, but a leaked speech-test credential would also expose its other powers. Avoid logging headers, whole requests, or request-bearing causes. Never include the secret in artifact metadata or browser/deployed app variables. Do not repurpose `CLOUDFLARE_WORKERS_API_TOKEN`, reserved for the admin Durable Object explorer. If this grows into unattended production work, revisit credential separation; it is not part of this experiment.

## Pricing and free allocation

Your $5 Workers Paid plan is sufficient for this experiment. Workers AI has a separate included allocation of **10,000 neurons per day**, resetting at **00:00 UTC**. Paid usage above that allocation costs **$0.011 per 1,000 neurons**. The allocation is shared by Workers AI usage on the account, not reserved for this script or each model. The $5 subscription is not a hard cap on AI charges.

| Model                     | Published neuron rate             | Approximate use of an otherwise unused daily allocation |
| ------------------------- | --------------------------------- | ------------------------------------------------------- |
| Aura-2 English or Spanish | 2,727.27 / 1,000 input characters | 3,667 input characters                                  |
| Aura-1                    | 1,363.64 / 1,000 input characters | 7,333 input characters                                  |
| MeloTTS                   | 18.63 / generated audio minute    | 537 generated audio minutes                             |

These are arithmetic estimates, not guaranteed request counts or measured metering. Actual usage and any billing rounding are authoritative in the Workers AI dashboard.

For a 100-character Aura-1 request, the estimate is about **136 neurons**, or **$0.0015** if the free allocation is already exhausted. Three such requests would use about **409 neurons**, or **$0.0045** at the overage rate. Aura-2 would double those estimates. A short test is inexpensive, but it is not necessarily free if other account activity has used the daily allocation.

Before testing, check the Workers AI dashboard's usage. Recommend a local maximum of 500 characters, one request per invocation, no automatic retry, and at most three initial invocations. Three maximum-length Aura-1 requests are estimated at 2,046 neurons, or $0.0225 without any remaining free allowance. The approved short sentence is much smaller. A timeout cannot prove the server did not generate and meter audio; do not automatically resubmit after one.

No account usage or subscription details were queried during research. These limits constrain this experiment, not other clients or a hard account-wide budget.

## Proposed Effect CLI

The model, text, account choice, and tolerance for small overages are settled. Confirm the temporary-file convention and complete the manual credential bootstrap before the first real request.

Suggested files:

- `cloudflare.config.ts`: checked-in account-only default for ad hoc `cf` API commands; no Worker definition or secrets, no Wrangler migration.
- `scripts/tts.ts`: command entry, fixed text, configuration, HTTP call, and file output. Keep it in one file initially.
- `scripts/tts.test.ts`: mocked HTTP/filesystem tests; no paid API calls in the test suite.
- `package.json`: proposed `tts` script: `node --env-file=.env.cf.local scripts/tts.ts`.
- `.env.cf.local.example`: existing single-token template; no new app env variables.
- `.gitignore`: add the proposed root-only `/tmp/` ignore rule when the convention is accepted.

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

1. Dry-run needs no credential and performs no HTTP call or file write.
2. Invalid configuration and an existing output fail before any billable request.
3. A mocked successful MP3 response writes exactly the supplied non-empty bytes.
4. Authentication failures, permission failures, rate limits, server errors, HTTP 200 JSON errors, unexpected MIME types, empty bodies, and interrupted reads never produce a misleading MP3.
5. Error output does not reveal a sentinel token, Authorization header, or full request object.
6. Timeouts and failures are not retried automatically.
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
- One manually created token for `cf` management and AI, with only `CLOUDFLARE_API_TOKEN` in `.env.cf.local`. No token-provisioning workflow or second credential.

Remaining decisions:

Config decisions are implemented: account-only `cloudflare.config.ts`, blank `.env.cf.local`, and its single-key example. Wrangler remains authoritative for the app. Use `cf --mode cf` for selected API operations, not to build or deploy the app. The remaining manual step is creating and populating the operator token.

| Question                                                                       | Recommendation                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adopt root `tmp/` and the `/tmp/` ignore rule for disposable experiment files? | Yes. Separate media experiments from `logs/`; organize by experiment and unique attempt. This is not implemented yet.                                                  |
| Which permissions should the one token have?                                   | Start with the operator table above for Baton's existing services; optionally add named-zone DNS/routes. Confirm this production-capable scope before manual creation. |
| Where should token details live?                                               | Your password manager, not extra env keys. Set a reminder before the recommended 30-day expiry; revoke through the dashboard.                                          |
| Which voice should Aura-1 use?                                                 | `luna`, supported by Aura-2 English too, so a later upgrade need not change the body.                                                                                  |

Next: confirm the permission set and artifact convention, manually create the one operator token, implement the small Effect CLI, and generate one clip. No tokens, speech script, or inference results exist yet.

## Sources

Public documentation checked on 2026-10-03:

- [Workers AI REST setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/): dashboard token creation, account ID, and required Workers AI Read + Edit permissions.
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/): daily allocation, reset time, paid overage, and audio model rates; page last updated 2026-10-01.
- [Aura-2 English](https://developers.cloudflare.com/workers-ai/models/aura-2-en/) and its [input](https://developers.cloudflare.com/workers-ai/models/aura-2-en/schema-input.json) / [output](https://developers.cloudflare.com/workers-ai/models/aura-2-en/schema-output.json) schemas.
- [Aura-2 Spanish](https://developers.cloudflare.com/workers-ai/models/aura-2-es/) and [Aura-1](https://developers.cloudflare.com/workers-ai/models/aura-1/); their current input schemas were checked for voice defaults and fields.
- [MeloTTS](https://developers.cloudflare.com/workers-ai/models/melotts/): different input fields, audio response alternatives, and more precise minute price.
- [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/): custom permissions, account/zone resources, IP restrictions, and TTL.
- [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/): dashboard path, creation-role requirement, and current product compatibility matrix.
- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/): Account/Zone/User permission categories; current page last updated 2026-10-01.
- [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/) and [Durable Objects authorization](https://developers.cloudflare.com/workers/authorization/durable-objects/): granular Worker scope, deployment/route permissions, and inherited Durable Object access.
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
- `wrangler.jsonc`: existing account ID in top-level, staging, and production vars.
- `/usr/bin/afplay -h` and `command -v afplay`: installed macOS playback utility and supported options; no audio was played.
- Installed `pnpm exec cf --version`, semantic `cf cli search`, discovered command help, and `cf schema observability telemetry query`: AI, Workers, telemetry, D1, KV, Durable Objects, Workflows, and DNS command surfaces in beta.12. No authenticated command was executed.

Context7 was also queried for Cloudflare Workers AI and the pinned Effect version. No dedicated Cloudflare documentation-search MCP was exposed in this session; the local Cloudflare references and current public pages supplied the primary evidence.
