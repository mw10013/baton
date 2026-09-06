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

/** `tags` lives on the item variant only; `null` means "not an item workflow" or nothing at all. */
const tagsOf = (
  workflow: Domain.Workflow | Domain.WorkflowSummary | null | undefined,
): readonly string[] | null =>
  workflow !== null && workflow !== undefined && Domain.isItemWorkflow(workflow)
    ? workflow.tags
    : null;

const name = Schema.decodeUnknownSync(Domain.WorkflowName);
const stepName = Schema.decodeUnknownSync(Domain.StepName);
const tags = Schema.decodeUnknownSync(Domain.ProductTags);
const teamId = Schema.decodeUnknownSync(Domain.TeamId);

const T1 = { id: teamId("t1"), memberCount: 1 };
const T2 = { id: teamId("t2"), memberCount: 1 };
const T3 = { id: teamId("t3"), memberCount: 1 };
const ALL_TEAMS = [T1, T2, T3];

/** The side the editor shows: the draft, which a fresh workflow always has. */
const editable = (found: Option.Option<Domain.WorkflowWithDraft>) => {
  const { draft } = Option.getOrThrow(found);
  if (draft === null) throw new Error("no draft");
  return draft;
};

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
  it("creates, lists with stepCount, rejects a nocase duplicate name, and frees it on delete", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const created = yield* repo.createWorkflow({
          name: name("Engraving"),
          tags: tags(["Engraving", "engrave"]),
        });
        deepStrictEqual<readonly string[]>(
          editable(yield* repo.getWorkflow({ workflowId: created.id })).draft
            .tags,
          ["engraving", "engrave"],
        );
        const dupe = yield* repo
          .createWorkflow({ name: name("engraving"), tags: tags([]) })
          .pipe(Effect.flip);
        strictEqual(dupe._tag, "WorkflowNameTakenError");
        const all = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        strictEqual(all.length, 1);
        strictEqual(all[0]?.stepCount, 0);
        yield* repo.deleteWorkflow({ workflowId: created.id });
        strictEqual(
          (yield* repo.listWorkflows({ teams: ALL_TEAMS })).length,
          0,
        );
        const again = yield* repo.createWorkflow({
          name: name("ENGRAVING"),
          tags: tags([]),
        });
        strictEqual(again.id !== created.id, true);
        const missing = yield* repo
          .deleteWorkflow({ workflowId: created.id })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
      }),
    ));

  it("updateWorkflow renames; updateWorkflowTags retags the draft; distinguishes taken from missing", () =>
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
        });
        strictEqual(updated.name, "A2");
        const retagged = yield* repo.updateWorkflowTags({
          workflowId: a.id,
          tags: tags(["X"]),
        });
        deepStrictEqual<readonly string[]>(retagged.tags, ["x"]);
        strictEqual(retagged.workflowId, updated.id);
        // Tags reach the workflow only through Apply.
        deepStrictEqual(tagsOf(updated), []);
        const taken = yield* repo
          .updateWorkflow({ workflowId: a.id, name: name("b") })
          .pipe(Effect.flip);
        strictEqual(taken._tag, "WorkflowNameTakenError");
        const missing = yield* repo
          .updateWorkflow({ workflowId: "nope", name: name("C") })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
        const missingTags = yield* repo
          .updateWorkflowTags({ workflowId: "nope", tags: tags([]) })
          .pipe(Effect.flip);
        strictEqual(missingTags._tag, "WorkflowNotFoundError");
      }),
    ));

  it("enforces the workflow limit; a delete frees a slot", () =>
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
        const [first] = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        yield* repo.deleteWorkflow({ workflowId: first?.id ?? "" });
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
            editable(d).steps.map((s) => s.name),
          );
        const stages = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) =>
            editable(d).steps.map((s) => s.stage),
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
        const after = editable(
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
            editable(d).steps.map((s) => `${s.name}${String(s.stage)}`),
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

  it("replaceWorkflows seeds an unassigned step off and refuses a fixture the ordinary path could not produce", () =>
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
              name: name("Lost"),
              tags: tags(["lost"]),
              steps: [{ name: stepName("a"), teamId: null }],
            },
            {
              name: name("Order"),
              scope: "order",
              tags: tags([]),
              steps: [{ name: stepName("a"), teamId: teamId("t1") }],
            },
          ],
        });
        deepStrictEqual(
          (yield* repo.listActiveWorkflowDetails())
            .map(({ workflow }) => workflow.name)
            .toSorted(),
          ["Live", "Order"],
        );
        const all = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual(
          all.map((w) => [w.name, w.active, w.needsAttention]),
          [
            ["Live", true, false],
            ["Lost", false, true],
            ["Order", true, false],
          ],
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
        strictEqual(all.length, 3);
        strictEqual(
          (yield* repo.listWorkflows({ teams: ALL_TEAMS })).length,
          3,
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

  it("countStepsByTeam / listStepsOwnedBy span workflows and both sides", () =>
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
        yield* repo.applyDraft({ workflowId: b.id, teams: ALL_TEAMS });
        deepStrictEqual(
          (yield* repo.countStepsByTeam()).map((row) => [
            row.teamId,
            row.workflowSteps,
            row.draftSteps,
            row.openRunSteps,
          ]),
          [
            ["t1", 1, 1, 0],
            ["t2", 0, 1, 0],
          ],
        );
        const owned = yield* repo.listStepsOwnedBy({ teamId: "t1" });
        deepStrictEqual(
          owned.map((o) => [o.workflowName, o.stepName, o.side]),
          [
            ["A", "A1", "draft"],
            ["B", "B1", "workflow"],
          ],
        );
      }),
    ));

  it("allows one order workflow: second refused, delete frees the slot", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const first = yield* repo.createWorkflow({
          name: name("Pack"),
          scope: "order",
        });
        strictEqual(first.scope, "order");
        const second = yield* repo
          .createWorkflow({
            name: name("Ship"),
            scope: "order",
          })
          .pipe(Effect.flip);
        strictEqual(second._tag, "OrderWorkflowExistsError");
        // Item workflows are unaffected by the slot.
        const item = yield* repo.createWorkflow({
          name: name("Engrave"),
          tags: tags(["x"]),
        });
        strictEqual(item.scope, "item");

        yield* repo.deleteWorkflow({ workflowId: first.id });
        const ship = yield* repo.createWorkflow({
          name: name("Ship"),
          scope: "order",
        });
        strictEqual(ship.scope, "order");
        const listed = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual(
          listed.map((w) => [w.name, w.scope]),
          [
            ["Engrave", "item"],
            ["Ship", "order"],
          ],
        );
      }),
    ));

  it("refuses tags on an order workflow on update, and the schema refuses them on any write; scope never changes", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        // Create cannot even be asked for tags on order scope (the input type
        // has no `tags` key); the SQL check is the backstop for a raw write.
        const raw = yield* sql`
          insert into Workflow (id, name, scope, active, tags, createdAt, updatedAt)
          values ('raw', 'Raw', 'order', 0, '["x"]', 0, 0)
        `.pipe(Effect.flip);
        strictEqual(raw._tag, "SqlError");
        const pack = yield* repo.createWorkflow({
          name: name("Pack"),
          scope: "order",
        });
        const retag = yield* repo
          .updateWorkflowTags({ workflowId: pack.id, tags: tags(["x"]) })
          .pipe(Effect.flip);
        strictEqual(retag._tag, "WorkflowRepositoryError");
        // The singleton is a partial unique index, not only the pre-check.
        const rawSecond = yield* sql`
          insert into Workflow (id, name, scope, active, tags, createdAt, updatedAt)
          values ('raw2', 'Raw 2', 'order', 0, '[]', 0, 0)
        `.pipe(Effect.flip);
        strictEqual(rawSecond._tag, "SqlError");
        const renamed = yield* repo.updateWorkflow({
          workflowId: pack.id,
          name: name("Pack & ship"),
        });
        strictEqual(renamed.scope, "order");
        strictEqual(renamed.name, "Pack & ship");
      }),
    ));

  it("deleteWorkflow cascades its draft and steps", () =>
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
        yield* repo.deleteWorkflow({ workflowId: w.id });
        assertNone(yield* repo.getStep({ stepId: s.id }));
        assertNone(yield* repo.getWorkflow({ workflowId: w.id }));
        strictEqual(
          Number((yield* sql`select count(*) as n from WorkflowDraft`)[0]?.n),
          0,
        );
        strictEqual(
          Number(
            (yield* sql`select count(*) as n from WorkflowDraftStep`)[0]?.n,
          ),
          0,
        );
      }),
    ));
});

/** Two draft steps on a fresh workflow, ready to apply. */
const twoSteps = (workflowId: string) =>
  Effect.gen(function* () {
    const repo = yield* WorkflowRepository;
    yield* repo.addStep({ workflowId, name: stepName("Cut"), teamId: T1.id });
    yield* repo.addStep({
      workflowId,
      name: stepName("Finish"),
      teamId: T2.id,
    });
  });

const found = (workflowId: string) =>
  Effect.map(
    WorkflowRepository.pipe(
      Effect.flatMap((repo) => repo.getWorkflow({ workflowId })),
    ),
    Option.getOrThrow,
  );

const stepNames = (steps: readonly { readonly name: string }[]) =>
  steps.map((s) => s.name);

describe("WorkflowRepository workflow and draft", () => {
  it("create → no steps, empty tags, an empty draft, off, not listed for starting; apply refused without steps; discard allowed", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags(["a"]),
        });
        strictEqual(w.active, false);
        deepStrictEqual(tagsOf(w), []);
        const fresh = yield* found(w.id);
        deepStrictEqual(fresh.steps, []);
        deepStrictEqual<readonly string[]>(fresh.draft?.draft.tags ?? [], [
          "a",
        ]);
        deepStrictEqual(fresh.draft?.steps, []);
        deepStrictEqual(yield* repo.listActiveWorkflowDetails(), []);
        const [row] = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual(
          [row?.hasDraft, row?.stepCount, tagsOf(row)],
          [true, 0, []],
        );
        const empty = yield* repo
          .applyDraft({ workflowId: w.id, teams: ALL_TEAMS })
          .pipe(Effect.flip);
        strictEqual(empty._tag, "NoStepsError");
        const on = yield* repo
          .setWorkflowActive({
            workflowId: w.id,
            active: true,
            teams: ALL_TEAMS,
          })
          .pipe(Effect.flip);
        strictEqual(on._tag, "NoStepsError");
        // Discard on a never-applied workflow: zero steps, no draft.
        const discarded = yield* repo.discardDraft({ workflowId: w.id });
        strictEqual(discarded.id, w.id);
        const after = yield* found(w.id);
        strictEqual(after.draft, null);
        deepStrictEqual(after.steps, []);
        const again = yield* repo
          .discardDraft({ workflowId: w.id })
          .pipe(Effect.flip);
        strictEqual(again._tag, "NoDraftError");
      }),
    ));

  it("apply replaces the workflow's tags and steps with the draft's, carries step ids over, and deletes the draft", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags(["a"]),
        });
        yield* twoSteps(w.id);
        const before = yield* found(w.id);
        const draftIds = before.draft?.steps.map((s) => s.id) ?? [];
        const applied = yield* repo.applyDraft({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        deepStrictEqual(tagsOf(applied), ["a"]);
        strictEqual(applied.active, false);
        const after = yield* found(w.id);
        strictEqual(after.draft, null);
        deepStrictEqual(stepNames(after.steps), ["Cut", "Finish"]);
        deepStrictEqual(
          after.steps.map((s) => s.id),
          draftIds,
        );
        const [row] = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual(
          [row?.hasDraft, row?.stepCount, tagsOf(row)],
          [false, 2, ["a"]],
        );
        // Off: still invisible to run creation until turned on.
        deepStrictEqual(yield* repo.listActiveWorkflowDetails(), []);
        yield* repo.setWorkflowActive({
          workflowId: w.id,
          active: true,
          teams: ALL_TEAMS,
        });
        const [detail] = yield* repo.listActiveWorkflowDetails();
        deepStrictEqual(stepNames(detail?.steps ?? []), ["Cut", "Finish"]);
        deepStrictEqual(tagsOf(detail?.workflow), ["a"]);
        // No draft: apply and discard refuse, and so does every step write.
        strictEqual(
          (yield* repo
            .applyDraft({ workflowId: w.id, teams: ALL_TEAMS })
            .pipe(Effect.flip))._tag,
          "NoDraftError",
        );
        strictEqual(
          (yield* repo.discardDraft({ workflowId: w.id }).pipe(Effect.flip))
            ._tag,
          "NoDraftError",
        );
        strictEqual(
          (yield* repo
            .addStep({
              workflowId: w.id,
              name: stepName("Pack"),
              teamId: T3.id,
            })
            .pipe(Effect.flip))._tag,
          "NoDraftError",
        );
        strictEqual(
          (yield* repo
            .updateWorkflowTags({ workflowId: w.id, tags: tags(["b"]) })
            .pipe(Effect.flip))._tag,
          "NoDraftError",
        );
        // A workflow step id is never writable.
        const [first] = after.steps;
        strictEqual(
          (yield* repo
            .removeStep({ stepId: first?.id ?? "" })
            .pipe(Effect.flip))._tag,
          "StepNotFoundError",
        );
        assertNone(yield* repo.getStep({ stepId: first?.id ?? "" }));
      }),
    ));

  it("createDraft copies the workflow's tags and steps under new ids and is idempotent; edits never touch the workflow", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags(["a"]),
        });
        yield* twoSteps(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowActive({
          workflowId: w.id,
          active: true,
          teams: ALL_TEAMS,
        });
        const draft = yield* repo.createDraft({ workflowId: w.id });
        deepStrictEqual<readonly string[]>(draft.tags, ["a"]);
        const again = yield* repo.createDraft({ workflowId: w.id });
        strictEqual(again.createdAt, draft.createdAt);
        const forked = yield* found(w.id);
        deepStrictEqual(stepNames(forked.draft?.steps ?? []), [
          "Cut",
          "Finish",
        ]);
        const workflowIds = forked.steps.map((s) => s.id);
        const draftIds = forked.draft?.steps.map((s) => s.id) ?? [];
        strictEqual(
          draftIds.some((id) => workflowIds.includes(id)),
          false,
        );
        deepStrictEqual(
          forked.draft?.steps.map((s) => [s.position, s.stage, s.teamId]),
          forked.steps.map((s) => [s.position, s.stage, s.teamId]),
        );
        // Every edit lands on the draft; the workflow and what starts runs
        // are untouched.
        const [cut, finish] = draftIds;
        yield* repo.updateStep({
          stepId: cut ?? "",
          name: stepName("Cut2"),
          teamId: T3.id,
          instructions: null,
        });
        yield* repo.moveStep({ stepId: finish ?? "", direction: "up" });
        yield* repo.separateStep({ stepId: finish ?? "" });
        const pack = yield* repo.addStep({
          workflowId: w.id,
          name: stepName("Pack"),
          teamId: T3.id,
        });
        yield* repo.addParallelStep({
          workflowId: w.id,
          stage: pack.stage,
          name: stepName("Label"),
          teamId: T1.id,
        });
        yield* repo.updateWorkflowTags({ workflowId: w.id, tags: tags(["b"]) });
        const edited = yield* found(w.id);
        deepStrictEqual(
          edited.draft?.steps.map((s) => `${s.name}${String(s.stage)}`),
          ["Cut21", "Finish2", "Pack3", "Label3"],
        );
        deepStrictEqual<readonly string[]>(edited.draft?.draft.tags ?? [], [
          "b",
        ]);
        deepStrictEqual(stepNames(edited.steps), ["Cut", "Finish"]);
        deepStrictEqual(tagsOf(edited.workflow), ["a"]);
        const [detail] = yield* repo.listActiveWorkflowDetails();
        deepStrictEqual(stepNames(detail?.steps ?? []), ["Cut", "Finish"]);
        const missing = yield* repo
          .createDraft({ workflowId: "nope" })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
      }),
    ));

  it("apply while on replaces the steps in place and leaves active alone; discard deletes the draft and leaves the workflow", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags(["a"]),
        });
        yield* twoSteps(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowActive({
          workflowId: w.id,
          active: true,
          teams: ALL_TEAMS,
        });
        yield* repo.createDraft({ workflowId: w.id });
        yield* repo.addStep({
          workflowId: w.id,
          name: stepName("Pack"),
          teamId: T3.id,
        });
        yield* repo.updateWorkflowTags({ workflowId: w.id, tags: tags(["b"]) });
        const applied = yield* repo.applyDraft({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        strictEqual(applied.active, true);
        deepStrictEqual(tagsOf(applied), ["b"]);
        const after = yield* found(w.id);
        strictEqual(after.draft, null);
        deepStrictEqual(stepNames(after.steps), ["Cut", "Finish", "Pack"]);
        strictEqual(
          Number(
            (yield* sql`select count(*) as n from WorkflowDraftStep`)[0]?.n,
          ),
          0,
        );

        // Discard: draft and draft steps gone, workflow untouched.
        yield* repo.createDraft({ workflowId: w.id });
        yield* repo.addStep({
          workflowId: w.id,
          name: stepName("Ship"),
          teamId: T3.id,
        });
        yield* repo.updateWorkflowTags({ workflowId: w.id, tags: tags(["c"]) });
        const discarded = yield* repo.discardDraft({ workflowId: w.id });
        deepStrictEqual(tagsOf(discarded), ["b"]);
        strictEqual(discarded.active, true);
        const back = yield* found(w.id);
        strictEqual(back.draft, null);
        deepStrictEqual(stepNames(back.steps), ["Cut", "Finish", "Pack"]);
        strictEqual(
          Number(
            (yield* sql`select count(*) as n from WorkflowDraftStep`)[0]?.n,
          ),
          0,
        );
      }),
    ));

  it("apply refuses an empty draft and an unassigned step, on and off alike; an empty team does not refuse; the workflow keeps its steps", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        yield* twoSteps(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        const check = Effect.gen(function* () {
          yield* repo.createDraft({ workflowId: w.id });
          const orphan = yield* repo
            .applyDraft({ workflowId: w.id, teams: [T1] })
            .pipe(Effect.flip);
          strictEqual(orphan._tag, "StepUnassignedError");
          if (orphan._tag === "StepUnassignedError")
            deepStrictEqual<readonly string[]>(orphan.stepNames, ["Finish"]);
          // A team with nobody on it is a warning, never a refusal.
          const emptyTeams = [T1, { ...T2, memberCount: 0 }];
          yield* repo.applyDraft({ workflowId: w.id, teams: emptyTeams });
          yield* repo.createDraft({ workflowId: w.id });
          const draftSteps = (yield* found(w.id)).draft?.steps ?? [];
          for (const step of draftSteps)
            yield* repo.removeStep({ stepId: step.id });
          const empty = yield* repo
            .applyDraft({ workflowId: w.id, teams: ALL_TEAMS })
            .pipe(Effect.flip);
          strictEqual(empty._tag, "NoStepsError");
          deepStrictEqual(stepNames((yield* found(w.id)).steps), [
            "Cut",
            "Finish",
          ]);
          yield* repo.discardDraft({ workflowId: w.id });
        });
        yield* check;
        yield* repo.setWorkflowActive({
          workflowId: w.id,
          active: true,
          teams: ALL_TEAMS,
        });
        yield* check;
        strictEqual((yield* found(w.id)).workflow.active, true);
      }),
    ));

  it("turn on refused: zero steps, unassigned step, second active order workflow; the draft is never consulted; an empty team allows", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const on = (workflowId: string, teams = ALL_TEAMS) =>
          repo.setWorkflowActive({ workflowId, active: true, teams });
        const empty = yield* repo.createWorkflow({
          name: name("Empty"),
          tags: tags([]),
        });
        strictEqual(
          (yield* on(empty.id).pipe(Effect.flip))._tag,
          "NoStepsError",
        );
        // Draft steps do not count: only the workflow's own do.
        yield* twoSteps(empty.id);
        strictEqual(
          (yield* on(empty.id).pipe(Effect.flip))._tag,
          "NoStepsError",
        );

        const a = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags(["a"]),
        });
        yield* twoSteps(a.id);
        yield* repo.applyDraft({ workflowId: a.id, teams: ALL_TEAMS });
        const orphan = yield* on(a.id, [T1]).pipe(Effect.flip);
        strictEqual(orphan._tag, "StepUnassignedError");
        if (orphan._tag === "StepUnassignedError")
          deepStrictEqual<readonly string[]>(orphan.stepNames, ["Finish"]);
        const onA = yield* on(a.id, [T1, { ...T2, memberCount: 0 }]);
        strictEqual(onA.active, true);
        // A draft on an active workflow changes nothing about the switch.
        yield* repo.createDraft({ workflowId: a.id });
        const off = yield* repo.setWorkflowActive({
          workflowId: a.id,
          active: false,
          teams: ALL_TEAMS,
        });
        strictEqual(off.active, false);
        strictEqual((yield* found(a.id)).draft !== null, true);
        strictEqual((yield* on(a.id)).active, true);

        // A team delete nulls the pointer; turn on is refused until assigned.
        const lost = yield* repo.createWorkflow({
          name: name("Lost"),
          tags: tags(["lost"]),
        });
        yield* twoSteps(lost.id);
        yield* repo.applyDraft({ workflowId: lost.id, teams: ALL_TEAMS });
        yield* repo.unassignTeam({ teamId: T2.id });
        const nulled = yield* on(lost.id).pipe(Effect.flip);
        strictEqual(nulled._tag, "StepUnassignedError");
        if (nulled._tag === "StepUnassignedError")
          deepStrictEqual<readonly string[]>(nulled.stepNames, ["Finish"]);
        deepStrictEqual(
          (yield* found(lost.id)).steps.map((s) => s.teamId),
          [T1.id, null],
        );
      }),
    ));

  it("one active order workflow at a time: turning the second on is refused until the first is off", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const on = (workflowId: string) =>
          repo.setWorkflowActive({
            workflowId,
            active: true,
            teams: ALL_TEAMS,
          });
        const pack = yield* repo.createWorkflow({
          name: name("Pack"),
          scope: "order",
        });
        yield* twoSteps(pack.id);
        yield* repo.applyDraft({ workflowId: pack.id, teams: ALL_TEAMS });
        yield* on(pack.id);
        // The row slot is one per shop; delete frees it, and the next order
        // workflow can be created and turned on at once.
        yield* repo.deleteWorkflow({ workflowId: pack.id });
        const ship = yield* repo.createWorkflow({
          name: name("Ship"),
          scope: "order",
        });
        yield* twoSteps(ship.id);
        yield* repo.applyDraft({ workflowId: ship.id, teams: ALL_TEAMS });
        strictEqual((yield* on(ship.id)).active, true);
        strictEqual(
          (yield* repo
            .createWorkflow({
              name: name("Pack"),
              scope: "order",
            })
            .pipe(Effect.flip))._tag,
          "OrderWorkflowExistsError",
        );
      }),
    ));

  it("countStepsByTeam counts workflow and draft steps; unassignTeam nulls both sides", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tags: tags([]),
        });
        const countT1 = () =>
          Effect.map(
            repo.countStepsByTeam(),
            (rows) => rows.find((row) => row.teamId === T1.id) ?? null,
          );
        yield* twoSteps(w.id);
        deepStrictEqual(
          [(yield* countT1())?.workflowSteps, (yield* countT1())?.draftSteps],
          [0, 1],
        );
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        deepStrictEqual(
          [(yield* countT1())?.workflowSteps, (yield* countT1())?.draftSteps],
          [1, 0],
        );
        yield* repo.createDraft({ workflowId: w.id });
        // Both sides count: the workflow's Cut and the draft's copy.
        deepStrictEqual(
          [(yield* countT1())?.workflowSteps, (yield* countT1())?.draftSteps],
          [1, 1],
        );
        deepStrictEqual(
          (yield* repo.listStepsOwnedBy({ teamId: T1.id })).map((o) => [
            o.stepName,
            o.side,
          ]),
          [
            ["Cut", "workflow"],
            ["Cut", "draft"],
          ],
        );
        yield* repo.unassignTeam({ teamId: T1.id });
        strictEqual(yield* countT1(), null);
        const after = yield* found(w.id);
        deepStrictEqual(
          after.steps.map((s) => s.teamId),
          [null, T2.id],
        );
        deepStrictEqual(
          after.draft?.steps.map((s) => s.teamId),
          [null, T2.id],
        );
        deepStrictEqual(yield* repo.listStepsOwnedBy({ teamId: T1.id }), []);
        // Idempotent: nothing left to null.
        yield* repo.unassignTeam({ teamId: T1.id });
        const [row] = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        strictEqual(row?.needsAttention, true);
        // Assigning a team on the draft, then applying, clears the badge with
        // no other write.
        const [lost] = after.draft?.steps ?? [];
        yield* repo.updateStep({
          stepId: lost?.id ?? "",
          name: stepName("Cut"),
          teamId: T3.id,
          instructions: null,
        });
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        strictEqual(
          (yield* repo.listWorkflows({ teams: ALL_TEAMS }))[0]?.needsAttention,
          false,
        );
        // An empty team is the other attention state, derived the same way.
        strictEqual(
          (yield* repo.listWorkflows({
            teams: [T1, T2, { ...T3, memberCount: 0 }],
          }))[0]?.needsAttention,
          true,
        );
      }),
    ));

  it("seed: active defaults, explicit off, pending draft with its own tags, empty steps as an empty draft, unassigned", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const step = (n: string, teamId: Domain.TeamId) => ({
          name: stepName(n),
          teamId,
        });
        yield* repo.replaceWorkflows({
          workflows: [
            { name: name("On"), tags: tags(["on"]), steps: [step("a", T1.id)] },
            {
              name: name("Off"),
              active: false,
              tags: tags(["off"]),
              steps: [step("a", T1.id)],
            },
            {
              name: name("Pending"),
              tags: tags(["p"]),
              steps: [step("a", T1.id)],
              draft: {
                tags: tags(["p2"]),
                steps: [step("a", T1.id), step("b", T2.id)],
              },
            },
            {
              name: name("Same tags"),
              tags: tags(["s"]),
              steps: [step("a", T1.id)],
              draft: { steps: [step("a", T2.id)] },
            },
            { name: name("Empty"), tags: tags(["e"]), steps: [] },
            {
              name: name("Lost"),
              tags: tags(["g"]),
              steps: [{ name: stepName("a"), teamId: null }],
            },
          ],
        });
        const rows = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual<readonly (readonly unknown[])[]>(
          rows.map((w) => [
            w.name,
            w.active,
            w.hasDraft,
            w.stepCount,
            w.needsAttention,
            tagsOf(w),
          ]),
          [
            ["Empty", false, true, 0, false, ["e"]],
            ["Lost", false, false, 1, true, ["g"]],
            ["Off", false, false, 1, false, ["off"]],
            ["On", true, false, 1, false, ["on"]],
            ["Pending", true, true, 1, false, ["p"]],
            ["Same tags", true, true, 1, false, ["s"]],
          ],
        );
        const pending = rows.find((w) => w.name === "Pending");
        const pendingDetail = yield* found(pending?.id ?? "");
        deepStrictEqual(stepNames(pendingDetail.steps), ["a"]);
        deepStrictEqual(stepNames(pendingDetail.draft?.steps ?? []), [
          "a",
          "b",
        ]);
        deepStrictEqual<readonly string[]>(
          pendingDetail.draft?.draft.tags ?? [],
          ["p2"],
        );
        const same = rows.find((w) => w.name === "Same tags");
        deepStrictEqual<readonly string[]>(
          (yield* found(same?.id ?? "")).draft?.draft.tags ?? [],
          ["s"],
        );
        const empty = rows.find((w) => w.name === "Empty");
        const emptyDetail = yield* found(empty?.id ?? "");
        deepStrictEqual(emptyDetail.steps, []);
        deepStrictEqual(emptyDetail.draft?.steps, []);
        deepStrictEqual(
          (yield* repo.listActiveWorkflowDetails())
            .map(({ workflow }) => workflow.name)
            .toSorted(),
          ["On", "Pending", "Same tags"],
        );
        // An active fixture with no steps is refused.
        strictEqual(
          (yield* repo
            .replaceWorkflows({
              workflows: [
                { name: name("Bad"), active: true, tags: tags([]), steps: [] },
              ],
            })
            .pipe(Effect.flip))._tag,
          "WorkflowRepositoryError",
        );
      }),
    ));
});
