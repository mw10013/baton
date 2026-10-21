# Baton verification map

The maintained source for verifying what a merchant sees in Baton's embedded app. Read this index, then use the feature file as the recipe. `V` is `.claude/skills/verify-baton/verify.sh`, run from the checkout root.

## Baseline preconditions

- The dev server is healthy and the dev store holds the dev fixture: a made-to-order gift workshop with seven members (`ana@example.com` to `gus@example.com`), eight teams (`Woodshop`, `Engraving`, `Leather`, `Jewelry`, `Textiles`, `Finishing`, `Packing`, `Weekend crew`), eight workflows and orders numbered from `#1201`.
- `V doctor` exits 0, and `V start <run-id>` has opened the run.
- Never drive a checkout that another agent is driving. One run per checkout.

## Driving conventions

- Start each recipe from `V goto <path>`, not from wherever the last one ended.
- Target by role and accessible name, always with `exact: true`. Never use snapshot refs.
- In-frame controls go through `V in`. The App nav, the hoisted title bar and toasts belong to the admin's page: `V top` or `V app` with `page`.
- Create only under names of your own (`Verify <run-id> …`). Restore anything you change on fixture data before `V stop`.
- Never use `/api/dev/*`, `vp run fixture` or `vp run db:reset` as a step. They rewrite the store and are not a merchant's path.

## Proof and skip reporting

- `V proof <name>` after each action that changes state, and again from a second view (reload, reopen from the list).
- Assert each result with `V app '… .waitFor() …'` and report what it returned.
- `log.md` in the run folder records each step. Hand over the folder path with the result.
- Report a journey the store cannot support (missing fixture data, a lapsed plan) as failed, with the unmet precondition. Never verify one entry point and report another.

## Feature entry contract

Each file has an H1, a paragraph on what the merchant sees, then four H2s in order: `Sub-features` (short IDs), `How to get to it (user POV)`, `Driving it with verify.sh` (starting with `Preconditions:`), and `Gotchas`.

## Features

- [Teams](./teams.md): create, duplicate name, search, add and remove members, rename, delete. Proved end to end on 2026-10-21 (run `t2`).
- [App Home](./home.md): the setup guide, the Orders strip and the capacity meters.
- [Orders index](./orders.md): the strip, Show and Team filters, search, paging, sync.
- [Order page](./order-page.md): per-item runs, Manage, Done and Reopen, Block and Unblock, notes.
- [Workflows](./workflows.md): state filter, search, the workflow page, Edit tag, Create workflow into the editor window.

Only Teams has been driven with these exact commands. The others come from the e2e suite's locators (`test/e2e/embedded/`). Fix the recipe in place the first time one fails, and mark the feature as proved here.

Not yet mapped: Members (`app/members`), the member persona's screens (`/shop/<key>`), billing and plans, the admin console (`/admin`), and public help (`/help`).
