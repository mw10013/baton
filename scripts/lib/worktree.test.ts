import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimConflicts,
  envDisagreements,
  parseEnv,
  setEnvKeys,
  worktreeEnv,
  worktreeName,
} from "./worktree.ts";

const wt01 = worktreeEnv(1);

void test("one index names everything: wt-NN, port 3800 + index, sandbox-shop-NN", () => {
  assert.equal(worktreeName(1), "wt-01");
  assert.deepEqual(worktreeEnv(0), {
    PORT: "3800",
    BETTER_AUTH_URL: "http://localhost:3800",
    SHOPIFY_DEV_STORE: "sandbox-shop-00",
  });
  assert.deepEqual(worktreeEnv(12), {
    PORT: "3812",
    BETTER_AUTH_URL: "http://localhost:3812",
    SHOPIFY_DEV_STORE: "sandbox-shop-12",
  });
});

void test("BETTER_AUTH_URL follows PORT", () => {
  assert.equal(wt01.BETTER_AUTH_URL, `http://localhost:${wt01.PORT}`);
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
    setEnvKeys(main, wt01),
    [
      "PORT=3801",
      "# Better Auth",
      "BETTER_AUTH_URL=http://localhost:3801",
      "BETTER_AUTH_SECRET=s3cret",
      "SHOPIFY_DEV_STORE=sandbox-shop-01",
      "",
    ].join("\n"),
  );
});

void test("a present .env that disagrees is reported, not rewritten", () => {
  const env = setEnvKeys("", worktreeEnv(2));
  assert.deepEqual(envDisagreements(env, wt01), [
    "PORT is 3802, expected 3801",
    "BETTER_AUTH_URL is http://localhost:3802, expected http://localhost:3801",
    "SHOPIFY_DEV_STORE is sandbox-shop-02, expected sandbox-shop-01",
  ]);
  assert.deepEqual(envDisagreements(setEnvKeys("", wt01), wt01), []);
});

void test("a port or dev store another checkout's .env holds is refused", () => {
  const others = [
    { checkout: "/main", env: setEnvKeys("", worktreeEnv(0)) },
    {
      checkout: "/wt-01-copy",
      env: "PORT=3801\nSHOPIFY_DEV_STORE=elsewhere\n",
    },
  ];
  assert.deepEqual(claimConflicts(others, wt01), [
    "PORT=3801 is already used by /wt-01-copy",
  ]);
  assert.deepEqual(
    claimConflicts(
      [{ checkout: "/main", env: "SHOPIFY_DEV_STORE=sandbox-shop-01\n" }],
      wt01,
    ),
    ["SHOPIFY_DEV_STORE=sandbox-shop-01 is already used by /main"],
  );
});

void test("comments and blank lines are not keys", () => {
  assert.deepEqual(
    [...parseEnv("# PORT=1\n\nPORT=3800\n").entries()],
    [["PORT", "3800"]],
  );
});
