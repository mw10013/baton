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
 * - `Necklace` (tag `necklace`) exercises stages: two steps share stage 1
 *   (Teams 1 and 2), then Team 3, then Team 1 again, with instructions on
 *   the first — the fixture for trying Start / Done / "together with" by hand.
 * - `Pack & ship` is the one order workflow (`scope: "order"`, no tags): QC
 *   then Pack, both owned by a `Packing` team with its own member
 *   `packing@m.com`. It starts on an order once every item run is finished.
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

const PACKING_TEAM = "Packing";
const PACKING_MEMBER = "packing@m.com";

const body = {
  shop,
  members: [...range.map((i) => `m${String(i)}@m.com`), PACKING_MEMBER],
  teams: [
    ...range.map((i) => ({
      name: teamName(i),
      members: [`m${String(i)}@m.com`],
    })),
    { name: PACKING_TEAM, members: [PACKING_MEMBER] },
  ],
  workflows: [
    ...range.map((i) => ({
      name: `Workflow ${String(i)}`,
      tags: [`workflow-${String(i)}`],
      steps: [
        { name: "Step 1", team: teamName(i) },
        { name: "Step 2", team: teamName(wrap(i)) },
      ],
    })),
    {
      name: "Necklace",
      tags: ["necklace"],
      steps: [
        {
          name: "Prepare artwork",
          team: teamName(1),
          stage: 1,
          instructions:
            "Export artwork at 300 dpi, check spelling against the order.",
        },
        { name: "Pick materials", team: teamName(2), stage: 1 },
        { name: "Produce", team: teamName(3), stage: 2 },
        { name: "Inspect", team: teamName(1), stage: 3 },
      ],
    },
    {
      name: "Pack & ship",
      scope: "order",
      tags: [],
      steps: [
        { name: "QC", team: PACKING_TEAM },
        { name: "Pack", team: PACKING_TEAM },
      ],
    },
  ],
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
  `seeded ${shop}: ${String(COUNT + 1)} members, ${String(COUNT + 1)} teams, ${String(COUNT + 2)} workflows`,
);
