# Production release runbook

Production is the `production` stage: the Website `baton-website-production`, serving https://baton.mw10013.com, and the private Backend `baton-backend-production`. Workers Builds watches branch `production` on the Website and runs `pnpm exec vp exec alchemy deploy --stage production --yes`. That one build deploys both Workers and applies any new D1 migrations. Staging is built the same way from `main`.

Production holds merchants' data. Never force-push `production`, run `vp run cloud:reset` against it, or destroy its Workers: the Backend owns the shops' Durable Object storage.

## Every release must run on the data the previous release left

A rollback runs older code against current data, and no rollback undoes a migration. D1 migrations (`migrations/`) apply on deploy, and actor migrations (`migrations` in `src/backend/shop-actor.ts`) apply when each shop's actor wakes. Both only go forward.

- Never edit an applied migration. Append a new one.
- Make schema changes additive: add tables and columns the previous release ignores. Drop or rename only in a later release, once no deployed code reads the old shape.
- Adding or removing a Durable Object class blocks Cloudflare rollback past that release. Treat such a release as a fix-forward-only release.

## Promote

1. Land the change on `main` and push. Wait for the staging build to succeed and check staging.
2. Read the diff since the last promotion for migrations and Durable Object class changes (see the previous section):

   ```sh
   git fetch origin
   git log --stat origin/production..origin/main
   ```

3. Fast-forward `production` to the checked revision:

   ```sh
   git push origin <sha>:production
   ```

   Git refuses a push that is not a fast-forward. If it refuses, stop: `production` has moved independently.

4. Watch the build: Cloudflare dashboard › Workers & Pages › `baton-website-production` › Deployments. It ends with `Success: Deploy command completed`. The `cf` Builds API has refused the CLI token before, so use the dashboard.
5. Check the release (below).

## Roll back

Choose by urgency. Both leave data as it is.

**Fix the code, then promote (default).** Run `git revert <sha>` on `main`, push, check staging, and promote as above. `production` keeps moving forward, so the next promotion needs nothing special.

**Cloudflare rollback (when production is broken now).** In the dashboard, open each Worker's Deployments, and on the version to return to choose ⋯ › Rollback. Roll back the Website and the Backend to the versions one build deployed together; match them by deployment time. Cloudflare refuses a rollback across a Durable Object class change or across a changed or deleted D1, KV or R2 resource. It keeps current bindings and data.

A Cloudflare rollback leaves `production` pointing at the bad revision, and the next build from it redeploys the bad code. Follow it with a revert on `main` and a promotion before anything else is pushed to `production`.

Never move `production` backwards with a force push. The build would deploy the old code, but every later promotion from `main` would then fail to fast-forward.

**Shopify app configuration** (`shopify.app.production.toml` and the `baton-order-link` extension) is not part of this build. The owner releases it with Shopify CLI, and it rolls back separately: Dev Dashboard › the app › Versions › the earlier version › Release.

## Check a release or rollback

- https://baton.mw10013.com loads, and Baton opens in `mw10013-production-shop-00`'s admin.
- No warnings or errors since the deploy: `cf o11y telemetry query` on `cloudflare-workers`, with `$metadata.service` filtered to `baton-website-production` and then `baton-backend-production`.
- If the release touched orders, workflows or billing, repeat the matching part of the development-store smoke test.
