import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Deployed,
  ResettableDeployed,
  workerNameOf,
  environmentOf,
  PerDeveloperStage,
  TestFileStage,
  UnknownStage,
} from "../../../src/backend/stage.ts";

const decode = Schema.decodeUnknownSync(PerDeveloperStage);
const encode = Schema.encodeSync(PerDeveloperStage);

describe("stage names", () => {
  for (const [stage, parts] of [
    ["dev-mw", { environment: "dev", user: "mw", checkout: Option.none() }],
    ["dev-mw-wt-01", { environment: "dev", user: "mw", checkout: Option.some(1) }],
    ["test-mw-wt-12", { environment: "test", user: "mw", checkout: Option.some(12) }],
    ["e2e-mw", { environment: "e2e", user: "mw", checkout: Option.none() }],
  ] as const)
    it(`${stage} round-trips`, () => {
      assert.deepStrictEqual(decode(stage), parts);
      assert.strictEqual(encode(parts), stage);
    });

  it.effect("each stage names its environment", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* environmentOf("dev-mw-wt-01"), "dev");
      assert.strictEqual(yield* environmentOf("test-mw"), "test");
      assert.strictEqual(yield* environmentOf("e2e-mw"), "e2e");
      assert.strictEqual(yield* environmentOf("staging"), "staging");
      assert.strictEqual(yield* environmentOf("production"), "production");
      assert.strictEqual(yield* environmentOf("test-mw-shopactor"), "test");
      assert.strictEqual(yield* environmentOf("test-mw-wt-01-socketfacts"), "test");
    }),
  );

  for (const stage of [
    "dev_mw",
    "dev-mw_wt01",
    "live-mw",
    "pr-42",
    "dev-Bad-wt-01",
    "dev-mw-wt-00",
    "dev-mw-wt-100",
    "dev-mw-shopactor",
    "e2e-mw-wt-01-shopactor",
    "test-mw-wt",
    "test-mw-wt-01-wt",
    "test-mw-1shop",
    "test-mw-shop-actor",
    "test-mw-wt-01-shop-actor",
    "test-mw-ShopActor",
  ])
    it.effect(`${stage} is an unknown stage`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(environmentOf(stage));
        assert.deepStrictEqual(exit, Exit.fail(new UnknownStage({ stage })));
      }),
    );
});

describe("test file stages", () => {
  const decodeFile = Schema.decodeUnknownSync(TestFileStage);
  const encodeFile = Schema.encodeSync(TestFileStage);

  for (const [stage, parts] of [
    ["test-mw-shopactor", { user: "mw", checkout: Option.none(), suffix: "shopactor" }],
    ["test-mw-wt-01-fixture", { user: "mw", checkout: Option.some(1), suffix: "fixture" }],
    ["test-mw-auth2", { user: "mw", checkout: Option.none(), suffix: "auth2" }],
  ] as const)
    it(`${stage} round-trips`, () => {
      assert.deepStrictEqual(decodeFile(stage), parts);
      assert.strictEqual(encodeFile(parts), stage);
    });

  for (const stage of ["test-mw", "test-mw-wt-01", "test-mw-wt", "test-mw-9a", "dev-mw-auth"])
    it(`${stage} is not a test file stage`, () =>
      assert.isTrue(Option.isNone(Schema.decodeUnknownOption(TestFileStage)(stage))));
});

describe("deployed environments", () => {
  const isDeployed = Schema.is(Deployed);

  it("accepts staging and production", () => {
    assert.isTrue(isDeployed("staging"));
    assert.isTrue(isDeployed("production"));
  });

  for (const stage of ["dev", "dev-mw", "production-mw"])
    it(`rejects ${stage}`, () => assert.isFalse(isDeployed(stage)));
});

describe("production isolation", () => {
  it("cannot be reset even though it is deployed", () => {
    assert.isTrue(Schema.is(Deployed)("production"));
    assert.isFalse(Schema.is(ResettableDeployed)("production"));
    assert.isTrue(Schema.is(ResettableDeployed)("staging"));
  });
  it("uses distinct stable Worker identities", () => {
    assert.strictEqual(workerNameOf("production", "website"), "baton-website-production");
    assert.strictEqual(workerNameOf("production", "backend"), "baton-backend-production");
    assert.strictEqual(workerNameOf("staging", "website"), "baton-website-staging");
    assert.isUndefined(workerNameOf("dev-mw", "website"));
  });
});
