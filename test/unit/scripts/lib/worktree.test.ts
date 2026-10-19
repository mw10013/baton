import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  devStoreName,
  devStoreOf,
  e2eStoreName,
  e2eStoreOf,
  envChanges,
  StoreName,
  storeNameOf,
  worktreeEnv,
} from "../../../../scripts/lib/worktree.ts";

const decode = Schema.decodeUnknownOption(StoreName);

describe("StoreName", () => {
  for (const environment of ["dev", "e2e", "staging", "production"] as const)
    for (const index of [0, 9]) {
      it(`round-trips ${environment} ${String(index)}`, () => {
        const name = storeNameOf(environment, index);
        assert.strictEqual(name, `mw10013-${environment}-shop-0${String(index)}`);
        assert.deepStrictEqual(decode(name), Option.some({ environment, index }));
      });
    }

  for (const name of [
    "dev-shop-00",
    "sandbox-shop-00",
    "mw10013-test-shop-00",
    "mw10013-dev-shop-0",
    "mw10013-dev-shop-100",
  ])
    it(`rejects ${name}`, () => {
      assert.isTrue(Option.isNone(decode(name)));
    });

  it("names a checkout's dev and e2e stores", () => {
    assert.strictEqual(devStoreName(1), "mw10013-dev-shop-01");
    assert.strictEqual(e2eStoreName(12), "mw10013-e2e-shop-12");
  });
});

describe("store keys in .env text", () => {
  const env = "WEBSITE_PORT=3900\nSHOPIFY_DEV_STORE=mw10013-dev-shop-00\n";

  it.effect("reads the dev store and finds no e2e store", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* devStoreOf(env), Option.some("mw10013-dev-shop-00"));
      assert.deepStrictEqual(yield* e2eStoreOf(env), Option.none());
    }),
  );

  it.effect("rejects a store of the old scheme, and one of another environment", () =>
    Effect.gen(function* () {
      for (const text of [
        "SHOPIFY_DEV_STORE=sandbox-shop-00\n",
        "SHOPIFY_DEV_STORE=mw10013-e2e-shop-00\n",
      ])
        assert.isTrue((yield* Effect.exit(devStoreOf(text)))._tag === "Failure");
    }),
  );
});

describe("worktreeEnv", () => {
  const own = { port: 3901, store: "mw10013-dev-shop-01", e2eStore: "mw10013-e2e-shop-01" };
  const main =
    "WEBSITE_PORT=3900\nSHOPIFY_DEV_STORE=mw10013-dev-shop-00\nSHOPIFY_E2E_STORE=mw10013-e2e-shop-00\n# a note\nTOKEN=abc\n";

  it("is the main checkout's .env with this worktree's three keys", () => {
    assert.strictEqual(
      worktreeEnv(main, own),
      "WEBSITE_PORT=3901\nSHOPIFY_DEV_STORE=mw10013-dev-shop-01\nSHOPIFY_E2E_STORE=mw10013-e2e-shop-01\n# a note\nTOKEN=abc\n",
    );
  });

  it("adds a store key the main checkout lacks", () => {
    assert.include(
      worktreeEnv("WEBSITE_PORT=3900\n", own),
      "SHOPIFY_E2E_STORE=mw10013-e2e-shop-01",
    );
  });
});

describe("envChanges", () => {
  it("names the keys added, changed and removed, never their values", () => {
    assert.deepStrictEqual(envChanges("A=1\nB=2\nC=3\n", "A=1\nB=9\nD=4\n"), {
      added: ["D"],
      changed: ["B"],
      removed: ["C"],
    });
  });
});
