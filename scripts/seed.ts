#!/usr/bin/env node
// oxlint-disable no-console -- a CLI script reports to stdout
/**
 * Posts the development fixture (`e2e/fixture.ts`, which documents the naming
 * and what each row exercises) to `/api/dev/seed` (`src/routes/api.dev.seed.ts`,
 * local-only). The fixture module is shared with Playwright so the shop a
 * developer looks at and the shop a whole-shop spec asserts against are the
 * same data.
 *
 * Requires `pnpm dev` running and the app installed on `SEED_SHOP`: `Member`
 * and `Team` both FK to `ShopSession`, which only OAuth can create.
 */
import process from "node:process";

import { fixture } from "../e2e/fixture.ts";

const shop = process.env.SEED_SHOP ?? "sandbox-shop-01.myshopify.com";
const port = process.env.PORT;
if (!port)
  throw new Error("pnpm seed requires PORT in .env (run via `pnpm seed`).");

const response = await fetch(`http://localhost:${port}/api/dev/seed`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ shop, ...fixture }),
});
if (!response.ok)
  throw new Error(
    `seed failed: ${String(response.status)} ${await response.text()}`,
  );
console.log(
  `seeded ${shop}: members ${String(fixture.members.length)}, teams ${String(fixture.teams.length)}, workflows ${String(fixture.workflows.length)}, orders ${String(fixture.orders.length)}`,
);
