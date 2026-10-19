# Stage config runbook

How a deployed stage gets the values another service issues for it, today the staging Shopify app's `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`. Rare, and the order matters.

## How it works

- What goes here: every value another service issues for a deployed stage (the Shopify app's key and secret, its handle and Partner ids, the Partner API token). Values Baton defines (plan and meter handles, entitlements, API versions) live in code.
- The values live in `.env.<stage>` (`.env.staging`) in the main checkout, untracked. Each worktree has a symlink to it, made by `vp run worktree:init`.
- `vp run stage-config --stage <stage>` runs `stacks/stage-config.ts`, a stack with no resources. It reads every declared value from `.env.<stage>` and saves them as the stack's output record for that stage in the Cloudflare state store. Every run writes the whole record. A missing or empty value fails the run by name; a stage that is not deployed (`dev-mw`, `test-mw`) is refused.
- The app stack's deploy on that stage (Workers Builds, on a push to `main`) reads the record and binds the values: the secret as a Worker secret, the key as plain text. Workers Builds never sees `.env.<stage>`.
- A Worker binding is fixed when the Worker is uploaded, so a changed record is live only after the app redeploys.
- Never print the file or `state read` the record: both hold the secret. Check the file by names only: `sed -E 's/=.*/=<hidden>/' .env.staging`.

## Change a value

1. Update `.env.<stage>`. Shopify's values: `shopify app env pull --config <stage> --env-file .env.<stage>`.
2. `vp run stage-config --stage <stage>`.
3. Redeploy the app: push to `main`, or "Retry build" on the last Workers Builds build.

## Add a value

1. Add the field to `StageConfigValues` in `src/backend/stack.ts`, as `Redacted.Redacted<string>` if it is secret (that is what binds it as a Worker secret).
2. Read it in `stacks/stage-config.ts`; the type checker flags the stack until it does. Bind it in the app stack.
3. Add it to `.env.<stage>` and run `vp run stage-config --stage <stage>`.
4. Only then push the code. Pushed first, the Workers Builds deploy fails at plan time on the missing field; that failure is safe (nothing is touched), and a retry after step 3 succeeds.

## Rotate the Shopify secret

1. Start the rotation in Shopify's Dev Dashboard; the old and new secrets are both valid until the old one is revoked.
2. Pull the new values (see "Change a value"), `vp run stage-config --stage <stage>`, and redeploy the app.
3. Once the deploy is live, revoke the old secret.

## Check the record

`vp exec alchemy plan --stage staging` succeeds only if the record exists and has every field; a missing record fails with `InvalidReferenceError` naming `baton-stage-config`.
