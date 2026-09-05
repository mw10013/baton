import { SqliteClient } from "@effect/sql-sqlite-do";
import { assertNone, deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { runShopAgentMigrations } from "@/lib/ShopAgent";
import { WorkflowRepository } from "@/lib/WorkflowRepository";

const runInRepository = <A, E>(
  program: Effect.Effect<A, E, WorkflowRepository | SqlClient.SqlClient>,
): Promise<A> =>
  runInDurableObject(
    env.TEST_SQL_DO.get(env.TEST_SQL_DO.idFromName(crypto.randomUUID())),
    (_instance, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* runShopAgentMigrations;
          return yield* program;
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              WorkflowRepository.layer,
              SqliteClient.layer({ storage: state.storage }),
            ),
          ),
        ),
      ),
  );

const name = Schema.decodeUnknownSync(Domain.WorkflowName);
const stepName = Schema.decodeUnknownSync(Domain.StepName);
const tags = Schema.decodeUnknownSync(Domain.ProductTags);
const teamId = Schema.decodeUnknownSync(Domain.TeamId);

describe("Domain workflow schemas", () => {
  it("ProductTags trims, lowercases, dedupes, and drops blanks", () => {
    deepStrictEqual<readonly string[]>(
      tags([" Engraving", "engraving", "", "Wood "]),
      ["engraving", "wood"],
    );
  });

  it("ProductTags rejects more than the tag limit", () => {
    const over = Array.from(
      { length: Domain.WorkflowLimits.maxTags + 1 },
      (_, i) => String(i),
    );
    strictEqual(
      Option.isNone(Schema.decodeUnknownOption(Domain.ProductTags)(over)),
      true,
    );
  });

  it("names trim and reject empty or over-long values", () => {
    strictEqual(name("  Engrave  "), "Engrave");
    strictEqual(
      Option.isNone(Schema.decodeUnknownOption(Domain.WorkflowName)("   ")),
      true,
    );
    strictEqual(
      Option.isNone(
        Schema.decodeUnknownOption(Domain.StepName)("x".repeat(65)),
      ),
      true,
    );
  });
});

describe("WorkflowRepository", () => {
  it("creates, lists with stepCount, and rejects a nocase duplicate name even when archived", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const created = yield* repo.createWorkflow({
          name: name("Engraving"),
          tags: tags(["Engraving", "engrave"]),
        });
        deepStrictEqual<readonly string[]>(created.tags, [
          "engraving",
          "engrave",
        ]);
        const dupe = yield* repo
          .createWorkflow({ name: name("engraving"), tags: tags([]) })
          .pipe(Effect.flip);
        strictEqual(dupe._tag, "WorkflowNameTakenError");
        yield* repo.setWorkflowArchived({
          workflowId: created.id,
          archived: true,
        });
        const stillTaken = yield* repo
          .createWorkflow({ name: name("ENGRAVING"), tags: tags([]) })
          .pipe(Effect.flip);
        strictEqual(stillTaken._tag, "WorkflowNameTakenError");
        strictEqual(
          (yield* repo.listWorkflows({ includeArchived: false })).length,
          0,
        );
        const all = yield* repo.listWorkflows({ includeArchived: true });
        strictEqual(all.length, 1);
        strictEqual(all[0]?.stepCount, 0);
        strictEqual(all[0]?.archivedAt !== null, true);
      }),
    ));

  it("updateWorkflow renames and retags; distinguishes taken from missing", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const a = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        yield* repo.createWorkflow({ name: name("B"), tags: tags([]) });
        const updated = yield* repo.updateWorkflow({
          workflowId: a.id,
          name: name("A2"),
          tags: tags(["X"]),
        });
        strictEqual(updated.name, "A2");
        deepStrictEqual<readonly string[]>(updated.tags, ["x"]);
        const taken = yield* repo
          .updateWorkflow({ workflowId: a.id, name: name("b"), tags: tags([]) })
          .pipe(Effect.flip);
        strictEqual(taken._tag, "WorkflowNameTakenError");
        const missing = yield* repo
          .updateWorkflow({
            workflowId: "nope",
            name: name("C"),
            tags: tags([]),
          })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
      }),
    ));

  it("archive is idempotent and keeps the first archivedAt; restore clears it", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        const first = yield* repo.setWorkflowArchived({
          workflowId: w.id,
          archived: true,
        });
        const second = yield* repo.setWorkflowArchived({
          workflowId: w.id,
          archived: true,
        });
        strictEqual(second.archivedAt, first.archivedAt);
        const restored = yield* repo.setWorkflowArchived({
          workflowId: w.id,
          archived: false,
        });
        strictEqual(restored.archivedAt, null);
        const missing = yield* repo
          .setWorkflowArchived({ workflowId: "nope", archived: true })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
      }),
    ));

  it("enforces the workflow limit over active rows only", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        yield* Effect.forEach(
          Array.from(
            { length: Domain.WorkflowLimits.maxWorkflows },
            (_, i) => i,
          ),
          (i) =>
            repo.createWorkflow({
              name: name(`W${String(i)}`),
              tags: tags([]),
            }),
          { discard: true },
        );
        const over = yield* repo
          .createWorkflow({ name: name("Over"), tags: tags([]) })
          .pipe(Effect.flip);
        strictEqual(over._tag, "WorkflowLimitError");
        const [first] = yield* repo.listWorkflows({ includeArchived: false });
        yield* repo.setWorkflowArchived({
          workflowId: first?.id ?? "",
          archived: true,
        });
        yield* repo.createWorkflow({ name: name("Over"), tags: tags([]) });
      }),
    ));

  it("add/move/remove keep positions dense and unique; edges are no-ops", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        const add = (n: string) =>
          repo.addStep({
            workflowId: w.id,
            name: stepName(n),
            teamId: teamId("t1"),
          });
        const s1 = yield* add("One");
        const s2 = yield* add("Two");
        const s3 = yield* add("Three");
        deepStrictEqual([s1.position, s2.position, s3.position], [1, 2, 3]);
        deepStrictEqual([s1.stage, s2.stage, s3.stage], [1, 2, 3]);

        const positions = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) =>
            Option.getOrThrow(d).steps.map((s) => s.name),
          );
        const stages = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) =>
            Option.getOrThrow(d).steps.map((s) => s.stage),
          );

        yield* repo.moveStep({ stepId: s1.id, direction: "up" });
        deepStrictEqual(yield* positions(), ["One", "Two", "Three"]);
        yield* repo.moveStep({ stepId: s3.id, direction: "down" });
        deepStrictEqual(yield* positions(), ["One", "Two", "Three"]);
        // Linear steps are each their own stage, so a move joins the
        // neighbour's stage and separate restores the boundary.
        yield* repo.moveStep({ stepId: s3.id, direction: "up" });
        deepStrictEqual(yield* positions(), ["One", "Three", "Two"]);
        deepStrictEqual(yield* stages(), [1, 2, 2]);
        yield* repo.separateStep({ stepId: s2.id });
        deepStrictEqual(yield* stages(), [1, 2, 3]);
        yield* repo.moveStep({ stepId: s1.id, direction: "down" });
        deepStrictEqual(yield* positions(), ["Three", "One", "Two"]);
        deepStrictEqual(yield* stages(), [1, 1, 2]);

        yield* repo.removeStep({ stepId: s1.id });
        const after = Option.getOrThrow(
          yield* repo.getWorkflow({ workflowId: w.id }),
        ).steps;
        deepStrictEqual(
          after.map((s) => [s.name, s.position, s.stage]),
          [
            ["Three", 1, 1],
            ["Two", 2, 2],
          ],
        );
        const s4 = yield* add("Four");
        strictEqual(s4.position, 3);
        strictEqual(s4.stage, 3);

        const missing = yield* repo
          .removeStep({ stepId: s1.id })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "StepNotFoundError");
      }),
    ));

  it("stages: move joins, separate splits, remove closes, addParallelStep shares; unknown stage fails", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        const add = (n: string) =>
          repo.addStep({
            workflowId: w.id,
            name: stepName(n),
            teamId: teamId("t1"),
          });
        const layout = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) =>
            Option.getOrThrow(d).steps.map(
              (s) => `${s.name}${String(s.stage)}`,
            ),
          );
        const a = yield* add("a");
        const b = yield* repo.addParallelStep({
          workflowId: w.id,
          stage: 1,
          name: stepName("b"),
          teamId: teamId("t2"),
        });
        strictEqual(b.stage, 1);
        strictEqual(b.position, 2);
        const c = yield* add("c");
        const d = yield* add("d");
        deepStrictEqual(yield* layout(), ["a1", "b1", "c2", "d3"]);

        yield* repo.moveStep({ stepId: c.id, direction: "up" });
        deepStrictEqual(yield* layout(), ["a1", "c1", "b1", "d2"]);

        yield* repo.separateStep({ stepId: b.id });
        deepStrictEqual(yield* layout(), ["a1", "c1", "b2", "d3"]);
        yield* repo.separateStep({ stepId: b.id });
        deepStrictEqual(yield* layout(), ["a1", "c1", "b2", "d3"]);

        yield* repo.removeStep({ stepId: b.id });
        deepStrictEqual(yield* layout(), ["a1", "c1", "d2"]);

        const e = yield* repo.addParallelStep({
          workflowId: w.id,
          stage: 2,
          name: stepName("e"),
          teamId: teamId("t1"),
        });
        strictEqual(e.stage, 2);
        deepStrictEqual(yield* layout(), ["a1", "c1", "d2", "e2"]);
        strictEqual(a.id !== d.id, true);

        const noStage = yield* repo
          .addParallelStep({
            workflowId: w.id,
            stage: 9,
            name: stepName("x"),
            teamId: teamId("t1"),
          })
          .pipe(Effect.flip);
        strictEqual(noStage._tag, "StageNotFoundError");
        const noWorkflow = yield* repo
          .addParallelStep({
            workflowId: "nope",
            stage: 1,
            name: stepName("x"),
            teamId: teamId("t1"),
          })
          .pipe(Effect.flip);
        strictEqual(noWorkflow._tag, "WorkflowNotFoundError");
      }),
    ));

  it("replaceWorkflows round-trips explicit stages and instructions; rejects an invalid layout", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const instructions = Schema.decodeUnknownSync(Domain.StepInstructions);
        yield* repo.replaceWorkflows({
          workflows: [
            {
              name: name("Staged"),
              tags: tags(["s"]),
              steps: [
                {
                  name: stepName("a"),
                  teamId: teamId("t1"),
                  stage: 1,
                  instructions: instructions("Read the order"),
                },
                { name: stepName("b"), teamId: teamId("t2"), stage: 1 },
                { name: stepName("c"), teamId: teamId("t3"), stage: 2 },
              ],
            },
            {
              name: name("Linear"),
              tags: tags(["l"]),
              steps: [
                { name: stepName("x"), teamId: teamId("t1") },
                { name: stepName("y"), teamId: teamId("t2") },
              ],
            },
          ],
        });
        const [linear, staged] = yield* repo.listActiveWorkflowDetails();
        deepStrictEqual(
          staged?.steps.map((s) => [
            s.name,
            s.position,
            s.stage,
            s.instructions,
          ]),
          [
            ["a", 1, 1, "Read the order"],
            ["b", 2, 1, null],
            ["c", 3, 2, null],
          ],
        );
        deepStrictEqual(
          linear?.steps.map((s) => [s.name, s.stage]),
          [
            ["x", 1],
            ["y", 2],
          ],
        );
        const invalid = yield* repo
          .replaceWorkflows({
            workflows: [
              {
                name: name("Bad"),
                tags: tags([]),
                steps: [
                  { name: stepName("a"), teamId: teamId("t1"), stage: 1 },
                  { name: stepName("b"), teamId: teamId("t1"), stage: 3 },
                ],
              },
            ],
          })
          .pipe(Effect.flip);
        strictEqual(invalid._tag, "WorkflowRepositoryError");
        strictEqual((yield* repo.listActiveWorkflowDetails()).length, 2);
      }),
    ));

  it("replaceWorkflows seeds archived rows and refuses a fixture the ordinary path could not produce", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        yield* repo.replaceWorkflows({
          workflows: [
            {
              name: name("Live"),
              tags: tags(["live"]),
              steps: [{ name: stepName("a"), teamId: teamId("t1") }],
            },
            {
              name: name("Gone"),
              archived: true,
              tags: tags(["gone"]),
              steps: [{ name: stepName("a"), teamId: teamId("t1") }],
            },
            {
              name: name("Order"),
              scope: "order",
              tags: tags([]),
              steps: [{ name: stepName("a"), teamId: teamId("t1") }],
            },
            {
              name: name("Old order"),
              scope: "order",
              archived: true,
              tags: tags([]),
              steps: [],
            },
          ],
        });
        deepStrictEqual(
          (yield* repo.listActiveWorkflowDetails())
            .map(({ workflow }) => workflow.name)
            .toSorted(),
          ["Live", "Order"],
        );
        const all = yield* repo.listWorkflows({ includeArchived: true });
        deepStrictEqual(
          all
            .filter((w) => w.archivedAt !== null)
            .map((w) => w.name)
            .toSorted(),
          ["Gone", "Old order"],
        );
        const refused = (workflows: Domain.SeedWorkflowsInput["workflows"]) =>
          repo.replaceWorkflows({ workflows }).pipe(Effect.flip);
        strictEqual(
          (yield* refused([
            {
              name: name("Tagged order"),
              scope: "order",
              tags: tags(["x"]),
              steps: [],
            },
          ]))._tag,
          "WorkflowRepositoryError",
        );
        strictEqual(
          (yield* refused([
            { name: name("O1"), scope: "order", tags: tags([]), steps: [] },
            { name: name("O2"), scope: "order", tags: tags([]), steps: [] },
          ]))._tag,
          "WorkflowRepositoryError",
        );
        // Refusals happen before the transaction: the previous seed survives.
        strictEqual(all.length, 4);
        strictEqual(
          (yield* repo.listWorkflows({ includeArchived: true })).length,
          4,
        );
      }),
    ));

  it("updateStep rewrites name and team; enforces the step limit", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        const s = yield* repo.addStep({
          workflowId: w.id,
          name: stepName("X"),
          teamId: teamId("t1"),
        });
        const updated = yield* repo.updateStep({
          stepId: s.id,
          name: stepName("Y"),
          teamId: teamId("t2"),
          instructions: Schema.decodeUnknownSync(Domain.StepInstructions)(
            "Mind the grain",
          ),
        });
        strictEqual(updated.name, "Y");
        strictEqual(updated.teamId, "t2");
        strictEqual(updated.instructions, "Mind the grain");
        const cleared = yield* repo.updateStep({
          stepId: s.id,
          name: stepName("Y"),
          teamId: teamId("t2"),
          instructions: null,
        });
        strictEqual(cleared.instructions, null);
        yield* Effect.forEach(
          Array.from(
            { length: Domain.WorkflowLimits.maxSteps - 1 },
            (_, i) => i,
          ),
          (i) =>
            repo.addStep({
              workflowId: w.id,
              name: stepName(`S${String(i)}`),
              teamId: teamId("t1"),
            }),
          { discard: true },
        );
        const over = yield* repo
          .addStep({
            workflowId: w.id,
            name: stepName("Over"),
            teamId: teamId("t1"),
          })
          .pipe(Effect.flip);
        strictEqual(over._tag, "WorkflowLimitError");
        const noWorkflow = yield* repo
          .addStep({
            workflowId: "nope",
            name: stepName("Z"),
            teamId: teamId("t1"),
          })
          .pipe(Effect.flip);
        strictEqual(noWorkflow._tag, "WorkflowNotFoundError");
      }),
    ));

  it("countStepsOwnedBy / listStepsOwnedBy span workflows, including archived ones", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const a = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        const b = yield* repo.createWorkflow({
          name: name("B"),
          tags: tags([]),
        });
        yield* repo.addStep({
          workflowId: a.id,
          name: stepName("A1"),
          teamId: teamId("t1"),
        });
        yield* repo.addStep({
          workflowId: a.id,
          name: stepName("A2"),
          teamId: teamId("t2"),
        });
        yield* repo.addStep({
          workflowId: b.id,
          name: stepName("B1"),
          teamId: teamId("t1"),
        });
        yield* repo.setWorkflowArchived({ workflowId: b.id, archived: true });
        strictEqual(yield* repo.countStepsOwnedBy({ teamId: "t1" }), 2);
        strictEqual(yield* repo.countStepsOwnedBy({ teamId: "none" }), 0);
        const owned = yield* repo.listStepsOwnedBy({ teamId: "t1" });
        deepStrictEqual(
          owned.map((o) => [o.workflowName, o.stepName, o.workflowArchived]),
          [
            ["A", "A1", false],
            ["B", "B1", true],
          ],
        );
      }),
    ));

  it("allows one active order workflow: second refused, archive frees the slot, restore into an occupied slot refused", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const first = yield* repo.createWorkflow({
          name: name("Pack"),
          scope: "order",
          tags: tags([]),
        });
        strictEqual(first.scope, "order");
        const second = yield* repo
          .createWorkflow({
            name: name("Ship"),
            scope: "order",
            tags: tags([]),
          })
          .pipe(Effect.flip);
        strictEqual(second._tag, "OrderWorkflowExistsError");
        // Item workflows are unaffected by the slot.
        const item = yield* repo.createWorkflow({
          name: name("Engrave"),
          tags: tags(["x"]),
        });
        strictEqual(item.scope, "item");

        yield* repo.setWorkflowArchived({
          workflowId: first.id,
          archived: true,
        });
        const ship = yield* repo.createWorkflow({
          name: name("Ship"),
          scope: "order",
          tags: tags([]),
        });
        strictEqual(ship.scope, "order");
        const restore = yield* repo
          .setWorkflowArchived({ workflowId: first.id, archived: false })
          .pipe(Effect.flip);
        strictEqual(restore._tag, "OrderWorkflowExistsError");
        // Re-archiving and restoring the holder itself is fine.
        yield* repo.setWorkflowArchived({
          workflowId: ship.id,
          archived: true,
        });
        const restored = yield* repo.setWorkflowArchived({
          workflowId: ship.id,
          archived: false,
        });
        strictEqual(restored.archivedAt, null);
        const listed = yield* repo.listWorkflows({ includeArchived: true });
        deepStrictEqual(
          listed.map((w) => [w.name, w.scope]),
          [
            ["Engrave", "item"],
            ["Ship", "order"],
            ["Pack", "order"],
          ],
        );
      }),
    ));

  it("refuses tags on an order workflow on create and update; scope never changes", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const tagged = yield* repo
          .createWorkflow({
            name: name("Pack"),
            scope: "order",
            tags: tags(["x"]),
          })
          .pipe(Effect.flip);
        strictEqual(tagged._tag, "WorkflowRepositoryError");
        const pack = yield* repo.createWorkflow({
          name: name("Pack"),
          scope: "order",
          tags: tags([]),
        });
        const retag = yield* repo
          .updateWorkflow({
            workflowId: pack.id,
            name: name("Pack"),
            tags: tags(["x"]),
          })
          .pipe(Effect.flip);
        strictEqual(retag._tag, "WorkflowRepositoryError");
        const renamed = yield* repo.updateWorkflow({
          workflowId: pack.id,
          name: name("Pack & ship"),
          tags: tags([]),
        });
        strictEqual(renamed.scope, "order");
        strictEqual(renamed.name, "Pack & ship");
      }),
    ));

  it("deleting a workflow cascades its steps", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        const s = yield* repo.addStep({
          workflowId: w.id,
          name: stepName("X"),
          teamId: teamId("t1"),
        });
        strictEqual(Option.isSome(yield* repo.getStep({ stepId: s.id })), true);
        yield* sql`delete from Workflow where id = ${w.id}`;
        assertNone(yield* repo.getStep({ stepId: s.id }));
        assertNone(yield* repo.getWorkflow({ workflowId: w.id }));
      }),
    ));
});
