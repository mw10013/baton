import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimConflicts,
  envDisagreements,
  parseEnv,
  setEnvKeys,
  slotEnv,
} from "./worktree.ts";

const slot02 = slotEnv(3801, "sandbox-shop-02");

void test("BETTER_AUTH_URL follows PORT", () => {
  assert.equal(slot02.BETTER_AUTH_URL, "http://localhost:3801");
});

void test("setting a key replaces its line in place and keeps every other line", () => {
  const main = [
    "PORT=3800",
    "# Better Auth",
    "BETTER_AUTH_URL=http://localhost:3800",
    "BETTER_AUTH_SECRET=s3cret",
    "",
  ].join("\n");
  assert.equal(
    setEnvKeys(main, slot02),
    [
      "PORT=3801",
      "# Better Auth",
      "BETTER_AUTH_URL=http://localhost:3801",
      "BETTER_AUTH_SECRET=s3cret",
      "SHOPIFY_DEV_STORE=sandbox-shop-02",
      "",
    ].join("\n"),
  );
});

void test("a present .env that disagrees is reported, not rewritten", () => {
  const env = setEnvKeys("PORT=3800\n", slotEnv(3802, "sandbox-shop-02"));
  assert.deepEqual(envDisagreements(env, slot02), [
    "PORT is 3802, expected 3801",
    "BETTER_AUTH_URL is http://localhost:3802, expected http://localhost:3801",
  ]);
  assert.deepEqual(envDisagreements(setEnvKeys("", slot02), slot02), []);
});

void test("a port or dev store another checkout's .env holds is refused", () => {
  const others = [
    {
      checkout: "/main",
      env: setEnvKeys("", slotEnv(3800, "sandbox-shop-01")),
    },
    {
      checkout: "/wt-03",
      env: setEnvKeys("", slotEnv(3801, "sandbox-shop-03")),
    },
  ];
  assert.deepEqual(claimConflicts(others, slot02), [
    "PORT=3801 is already used by /wt-03",
  ]);
  assert.deepEqual(claimConflicts(others, slotEnv(3802, "sandbox-shop-01")), [
    "SHOPIFY_DEV_STORE=sandbox-shop-01 is already used by /main",
  ]);
});

void test("comments and blank lines are not keys", () => {
  assert.deepEqual(
    [...parseEnv("# PORT=1\n\nPORT=3800\n").entries()],
    [["PORT", "3800"]],
  );
});
