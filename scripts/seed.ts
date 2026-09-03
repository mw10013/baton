#!/usr/bin/env node
// oxlint-disable no-console -- a CLI script reports to stdout
/**
 * Posts the development fixture to `/api/dev/seed` (`src/routes/api.dev.seed.ts`,
 * local-only). Everything derives from `i` in 1..6 so any row on any screen
 * reads back to its seed entry by eye:
 *
 * - member `m{i}@m.com` is the sole member of `Team {i}`
 * - `Workflow {i}` carries tag `workflow-{i}` and two steps, `Step 1` owned by
 *   `Team {i}` and `Step 2` by `Team {i % 6 + 1}`
 *
 * The step wrap is the point: every team then owns two steps across two
 * different workflows, so no queue is single-workflow and every hand-off
 * crosses a team boundary.
 *
 * Definitions only. Workflows produce runs when a synced order's line item
 * carries a matching product tag, so seeing a populated queue still needs
 * sandbox products tagged `workflow-{i}` (or a manual attach) — deliberately
 * out of scope here.
 *
 * Requires `pnpm dev` running and the app installed on `SEED_SHOP`: `Member`
 * and `Team` both FK to `ShopSession`, which only OAuth can create.
 */
import process from "node:process";

const COUNT = 6;
const shop = process.env.SEED_SHOP ?? "sandbox-shop-01.myshopify.com";
const port = process.env.PORT;
if (!port)
  throw new Error("pnpm seed requires PORT in .env (run via `pnpm seed`).");

const teamName = (i: number) => `Team ${String(i)}`;
const wrap = (i: number) => (i % COUNT) + 1;
const range = Array.from({ length: COUNT }, (_, offset) => offset + 1);

const body = {
  shop,
  members: range.map((i) => `m${String(i)}@m.com`),
  teams: range.map((i) => ({
    name: teamName(i),
    members: [`m${String(i)}@m.com`],
  })),
  workflows: range.map((i) => ({
    name: `Workflow ${String(i)}`,
    tags: [`workflow-${String(i)}`],
    steps: [
      { name: "Step 1", team: teamName(i) },
      { name: "Step 2", team: teamName(wrap(i)) },
    ],
  })),
};

const response = await fetch(`http://localhost:${port}/api/dev/seed`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
if (!response.ok)
  throw new Error(
    `seed failed: ${String(response.status)} ${await response.text()}`,
  );
console.log(
  `seeded ${shop}: ${String(COUNT)} members, ${String(COUNT)} teams, ${String(COUNT)} workflows`,
);
