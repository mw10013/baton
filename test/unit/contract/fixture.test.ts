import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ShopFixtureData } from "../../../src/contract/fixture.ts";
import { TEAM_NAME_MAX_LENGTH } from "../../../src/domain/shop-work.ts";

const decode = Schema.decodeUnknownEffect(ShopFixtureData);

/** A small fixture whose every reference resolves; each test breaks one. */
const valid: typeof ShopFixtureData.Encoded = {
  members: ["ana@example.com", "ben@example.com"],
  teams: [{ name: "Engraving", members: ["ana@example.com"] }],
  workflows: [
    {
      name: "Engrave",
      tag: "engraved",
      tasks: [{ name: "Engrave", team: "Engraving" }],
    },
  ],
  orders: [
    {
      n: 1,
      lineItems: [
        {
          title: "Board",
          quantity: 1,
          tags: ["engraved"],
          workflow: "Engrave",
          progress: { advance: 1, by: "ben@example.com" },
        },
      ],
    },
  ],
};

/** The messages of a decode failure, for asserting which rule refused it. */
const failure = (input: unknown) =>
  decode(input).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

describe("ShopFixtureData", () => {
  it.effect("decodes a fixture whose references resolve, defaulting properties", () =>
    Effect.gen(function* () {
      const data = yield* decode(valid);
      assert.deepStrictEqual(data.orders[0]?.lineItems[0]?.properties, []);
    }),
  );

  it.effect("rejects a team member who is not a fixture member", () =>
    Effect.gen(function* () {
      const message = yield* failure({
        ...valid,
        teams: [{ name: "Engraving", members: ["zed@example.com"] }],
      });
      assert.include(message, "zed@example.com is not a fixture member");
    }),
  );

  it.effect("rejects a team name past TEAM_NAME_MAX_LENGTH, which the screens cannot show", () =>
    Effect.gen(function* () {
      const name = "x".repeat(TEAM_NAME_MAX_LENGTH + 1);
      yield* failure({ ...valid, teams: [{ name, members: [] }], workflows: [], orders: [] });
      const fits = yield* decode({
        ...valid,
        teams: [{ name: "x".repeat(TEAM_NAME_MAX_LENGTH), members: [] }],
        workflows: [],
        orders: [],
      });
      assert.lengthOf(fits.teams[0]?.name ?? "", TEAM_NAME_MAX_LENGTH);
    }),
  );

  it.effect("rejects a task team that is not a fixture team", () =>
    Effect.gen(function* () {
      const message = yield* failure({
        ...valid,
        workflows: [
          { name: "Engrave", tag: "engraved", tasks: [{ name: "Engrave", team: "Nope" }] },
        ],
      });
      assert.include(message, "Nope is not a fixture team");
    }),
  );

  it.effect("rejects an item workflow that is not a fixture workflow", () =>
    Effect.gen(function* () {
      const message = yield* failure({
        ...valid,
        orders: [
          { n: 1, lineItems: [{ title: "Board", quantity: 1, tags: [], workflow: "Nope" }] },
        ],
      });
      assert.include(message, "Nope is not a fixture workflow");
    }),
  );

  it.effect("rejects a duplicate workflow tag", () =>
    Effect.gen(function* () {
      const message = yield* failure({
        ...valid,
        workflows: [
          { name: "Engrave", tag: "engraved", tasks: [{ name: "Engrave", team: "Engraving" }] },
          { name: "Engrave again", tag: "engraved", tasks: [] },
        ],
      });
      assert.include(message, "Two workflows' tags share engraved");
    }),
  );

  it.effect("rejects a `by` who is not a fixture member", () =>
    Effect.gen(function* () {
      const message = yield* failure({
        ...valid,
        orders: [{ n: 1, by: "zed@example.com", lineItems: [] }],
      });
      assert.include(message, "zed@example.com is not a fixture member");
    }),
  );

  it.effect("rejects steps that skip one", () =>
    Effect.gen(function* () {
      const message = yield* failure({
        ...valid,
        workflows: [
          {
            name: "Engrave",
            tag: "engraved",
            tasks: [
              { name: "One", team: "Engraving" },
              { name: "Three", team: "Engraving", step: 3 },
            ],
          },
        ],
      });
      assert.include(message, "Steps must be dense from 1");
    }),
  );

  it.effect("rejects an active workflow with a task that has no team", () =>
    Effect.gen(function* () {
      const message = yield* failure({
        ...valid,
        workflows: [
          {
            name: "Engrave",
            state: "active",
            tag: "engraved",
            tasks: [{ name: "One", team: null }],
          },
        ],
      });
      assert.include(message, "An active workflow needs tasks");
    }),
  );

  it.effect("rejects done beside advance", () =>
    Effect.gen(function* () {
      const message = yield* failure({
        ...valid,
        orders: [{ n: 1, done: true, advance: 1, lineItems: [] }],
      });
      assert.include(message, "done and advance are exclusive");
    }),
  );
});
