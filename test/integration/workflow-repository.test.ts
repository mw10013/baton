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
import { copyName } from "@/lib/workflowShared";

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

const tagOf = (
  workflow: Domain.Workflow | Domain.WorkflowSummary | null | undefined,
): string | null => workflow?.tag ?? null;

const name = Schema.decodeUnknownSync(Domain.WorkflowName);
const stepName = Schema.decodeUnknownSync(Domain.StepName);
const tag = Schema.decodeUnknownSync(Domain.WorkflowTag);
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
  it("WorkflowTag trims and lowercases", () => {
    strictEqual(tag("  Engraving "), "engraving");
  });

  it("WorkflowTag rejects blank and over-long values", () => {
    strictEqual(
      Option.isNone(Schema.decodeUnknownOption(Domain.WorkflowTag)("   ")),
      true,
    );
    strictEqual(
      Option.isNone(
        Schema.decodeUnknownOption(Domain.WorkflowTag)("x".repeat(256)),
      ),
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
  it("creates, lists with stepCount, takes a name another workflow already uses, and deletes", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const created = yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("engraving"),
        });
        const fresh = yield* found(created.id);
        strictEqual(tagOf(fresh.workflow), "engraving");
        strictEqual(fresh.draft, null);
        // The name is a label: the same one under a free tag is a second workflow.
        const twin = yield* repo.createWorkflow({
          name: name("engraving"),
          tag: tag("other"),
        });
        strictEqual(twin.id !== created.id, true);
        strictEqual(
          (yield* repo.listWorkflows({ teams: ALL_TEAMS })).length,
          2,
        );
        yield* repo.deleteWorkflow({ workflowId: twin.id });
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
          tag: tag("engraving"),
        });
        strictEqual(again.id !== created.id, true);
        const missing = yield* repo
          .deleteWorkflow({ workflowId: created.id })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
      }),
    ));

  it("updateWorkflow renames; updateWorkflowTag retags the workflow immediately; distinguishes taken from missing", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const a = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* repo.createWorkflow({ name: name("B"), tag: tag("b") });
        const updated = yield* repo.updateWorkflow({
          workflowId: a.id,
          name: name("A2"),
        });
        strictEqual(updated.name, "A2");
        const retagged = yield* repo.updateWorkflowTag({
          workflowId: a.id,
          tag: tag("X"),
        });
        strictEqual(tagOf(retagged), "x");
        strictEqual(retagged.id, updated.id);
        // Immediate, like the rename: no draft is created for it.
        strictEqual((yield* found(a.id)).draft, null);
        // Re-saving the workflow's own tag is not a collision.
        strictEqual(
          tagOf(
            yield* repo.updateWorkflowTag({ workflowId: a.id, tag: tag("x") }),
          ),
          "x",
        );
        const tagTaken = yield* repo
          .updateWorkflowTag({ workflowId: a.id, tag: tag("B") })
          .pipe(Effect.flip);
        strictEqual(tagTaken._tag, "WorkflowTagTakenError");
        // A rename onto another workflow's name is not a collision.
        strictEqual(
          (yield* repo.updateWorkflow({ workflowId: a.id, name: name("b") }))
            .name,
          "b",
        );
        const missing = yield* repo
          .updateWorkflow({ workflowId: "nope", name: name("C") })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
        const missingTag = yield* repo
          .updateWorkflowTag({ workflowId: "nope", tag: tag("z") })
          .pipe(Effect.flip);
        strictEqual(missingTag._tag, "WorkflowNotFoundError");
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
              tag: tag(`w${String(i)}`),
            }),
          { discard: true },
        );
        const over = yield* repo
          .createWorkflow({ name: name("Over"), tag: tag("over") })
          .pipe(Effect.flip);
        strictEqual(over._tag, "WorkflowLimitError");
        const [first] = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        yield* repo.deleteWorkflow({ workflowId: first?.id ?? "" });
        yield* repo.createWorkflow({ name: name("Over"), tag: tag("over") });
      }),
    ));

  it("add/move/remove keep positions dense and unique; edges are no-ops", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
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
        // A move only reorders: the step slides past the neighbouring stage
        // into one of its own, never joining it. `joinStep` is what merges,
        // and `separateStep` undoes that.
        yield* repo.moveStep({ stepId: s3.id, direction: "up" });
        deepStrictEqual(yield* positions(), ["One", "Three", "Two"]);
        deepStrictEqual(yield* stages(), [1, 2, 3]);
        yield* repo.joinStep({ stepId: s3.id });
        deepStrictEqual(yield* positions(), ["One", "Three", "Two"]);
        deepStrictEqual(yield* stages(), [1, 1, 2]);
        yield* repo.separateStep({ stepId: s3.id });
        deepStrictEqual(yield* stages(), [1, 2, 3]);
        yield* repo.moveStep({ stepId: s1.id, direction: "down" });
        deepStrictEqual(yield* positions(), ["Three", "One", "Two"]);
        deepStrictEqual(yield* stages(), [1, 2, 3]);

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

  it("stages: join merges, move reorders, separate splits, remove closes, addParallelStep shares; unknown stage fails", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
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

        yield* repo.joinStep({ stepId: c.id });
        deepStrictEqual(yield* layout(), ["a1", "b1", "c1", "d2"]);
        // Reordering out of a shared stage leaves the mates together.
        yield* repo.moveStep({ stepId: c.id, direction: "up" });
        deepStrictEqual(yield* layout(), ["c1", "a2", "b2", "d3"]);
        yield* repo.joinStep({ stepId: c.id });
        deepStrictEqual(yield* layout(), ["c1", "a2", "b2", "d3"]);
        yield* repo.moveStep({ stepId: c.id, direction: "down" });
        deepStrictEqual(yield* layout(), ["a1", "b1", "c2", "d3"]);
        yield* repo.joinStep({ stepId: c.id });
        deepStrictEqual(yield* layout(), ["a1", "b1", "c1", "d2"]);

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
              tag: tag("s"),
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
              tag: tag("l"),
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
                tag: tag("bad"),
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
              tag: tag("live"),
              steps: [{ name: stepName("a"), teamId: teamId("t1") }],
            },
            {
              name: name("Lost"),
              tag: tag("lost"),
              steps: [{ name: stepName("a"), teamId: null }],
            },
          ],
        });
        deepStrictEqual(
          (yield* repo.listActiveWorkflowDetails())
            .map(({ workflow }) => workflow.name)
            .toSorted(),
          ["Live"],
        );
        const all = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual(
          all.map((w) => [w.name, Domain.isActive(w), w.needsAttention]),
          [
            ["Live", true, false],
            ["Lost", false, true],
          ],
        );
        const refused = (workflows: Domain.SeedWorkflowsInput["workflows"]) =>
          repo.replaceWorkflows({ workflows }).pipe(Effect.flip);
        strictEqual(
          (yield* refused([
            {
              name: name("Active but empty"),
              active: true,
              tag: tag("x"),
              steps: [],
            },
          ]))._tag,
          "WorkflowRepositoryError",
        );
        // Refusals happen before the transaction: the previous seed survives.
        strictEqual(all.length, 2);
        strictEqual(
          (yield* repo.listWorkflows({ teams: ALL_TEAMS })).length,
          2,
        );
      }),
    ));

  it("updateStep rewrites name and team; enforces the step limit", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
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
          tag: tag("a"),
        });
        const b = yield* repo.createWorkflow({
          name: name("B"),
          tag: tag("b"),
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
        deepStrictEqual(
          (yield* repo.listOwnedSteps()).map((o) => [
            o.teamId,
            o.workflowName,
            o.stepName,
            o.side,
          ]),
          [
            ["t1", "A", "A1", "draft"],
            ["t2", "A", "A2", "draft"],
            ["t1", "B", "B1", "workflow"],
          ],
        );
      }),
    ));

  it("deleteWorkflow cascades its draft and steps", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
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

describe("WorkflowRepository duplicate", () => {
  it("copies the steps and their stages under the given name and tag, lands off with no draft", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("Engraved ring"),
          tag: tag("engraved"),
        });
        yield* twoSteps(w.id);
        const [first] = editable(
          yield* repo.getWorkflow({ workflowId: w.id }),
        ).steps;
        yield* repo.addParallelStep({
          workflowId: w.id,
          stage: first?.stage ?? 1,
          name: stepName("Polish"),
          teamId: T3.id,
        });
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowActive({
          workflowId: w.id,
          active: true,
          teams: ALL_TEAMS,
        });

        const copy = yield* repo.duplicateWorkflow({
          workflowId: w.id,
          name: name("Engraved ring copy"),
          tag: tag("Engraved copy"),
        });
        strictEqual(copy.name, "Engraved ring copy");
        strictEqual(Domain.isActive(copy), false);
        strictEqual(tagOf(copy), "engraved copy");
        const copied = Option.getOrThrow(
          yield* repo.getWorkflow({ workflowId: copy.id }),
        );
        strictEqual(copied.draft, null);
        const source = Option.getOrThrow(
          yield* repo.getWorkflow({ workflowId: w.id }),
        );
        deepStrictEqual(
          copied.steps.map((s) => [s.name, s.stage, s.teamId]),
          source.steps.map((s) => [s.name, s.stage, s.teamId]),
        );
        // New rows, not the source's.
        strictEqual(
          copied.steps.some((s) => source.steps.some((o) => o.id === s.id)),
          false,
        );
        // The source is untouched and still on.
        strictEqual(Domain.isActive(source.workflow), true);
        strictEqual(tagOf(source.workflow), "engraved");

        // The copy's name may repeat the one the first copy took.
        strictEqual(
          (yield* repo.duplicateWorkflow({
            workflowId: w.id,
            name: name("Engraved ring copy"),
            tag: tag("free"),
          })).name,
          "Engraved ring copy",
        );
        const tagTaken = yield* repo
          .duplicateWorkflow({
            workflowId: w.id,
            name: name("Another copy"),
            tag: tag("Engraved"),
          })
          .pipe(Effect.flip);
        strictEqual(tagTaken._tag, "WorkflowTagTakenError");
        if (tagTaken._tag === "WorkflowTagTakenError")
          strictEqual(tagTaken.workflowName, "Engraved ring");
        const missing = yield* repo
          .duplicateWorkflow({
            workflowId: "nope",
            name: name("Ghost"),
            tag: tag("ghost"),
          })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
      }),
    ));
});

/**
 * The tag is the workflow's key: unique across the shop, on or off, and
 * refused where the merchant typed it. Turn on and Apply never see it.
 */
describe("WorkflowRepository tag uniqueness", () => {
  it("createWorkflow refuses a tag another workflow holds, on or off, and names the holder", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const holder = yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("engraved"),
        });
        // Folded on both sides: `Engraved` collides with `engraved`.
        const refused = yield* repo
          .createWorkflow({ name: name("Rush"), tag: tag("Engraved") })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "WorkflowTagTakenError");
        if (refused._tag === "WorkflowTagTakenError") {
          strictEqual(refused.tag, "engraved");
          strictEqual(refused.workflowName, holder.name);
        }
        // Still refused once the holder is on; the rule does not depend on it.
        yield* twoSteps(holder.id);
        yield* repo.applyDraft({ workflowId: holder.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowActive({
          workflowId: holder.id,
          active: true,
          teams: ALL_TEAMS,
        });
        strictEqual(
          (yield* repo
            .createWorkflow({ name: name("Rush"), tag: tag("engraved") })
            .pipe(Effect.flip))._tag,
          "WorkflowTagTakenError",
        );
      }),
    ));

  it("refuses the tag alone: the same name under a free tag goes through", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const holder = yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("engraved"),
        });
        const sameName = yield* repo.createWorkflow({
          name: name("engraving"),
          tag: tag("rush"),
        });
        strictEqual(sameName.name, "engraving");
        const sameTag = yield* repo
          .createWorkflow({ name: name("Rush"), tag: tag("engraved") })
          .pipe(Effect.flip);
        strictEqual(sameTag._tag, "WorkflowTagTakenError");
        // The refusal links to the holder, since its name no longer picks it out.
        if (sameTag._tag === "WorkflowTagTakenError")
          strictEqual(sameTag.workflowId, holder.id);
      }),
    ));

  it("Turn on and Apply ignore tags: two active workflows with different tags coexist", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const live = (workflowName: string, value: string) =>
          Effect.gen(function* () {
            const w = yield* repo.createWorkflow({
              name: name(workflowName),
              tag: tag(value),
            });
            yield* twoSteps(w.id);
            yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
            return yield* repo.setWorkflowActive({
              workflowId: w.id,
              active: true,
              teams: ALL_TEAMS,
            });
          });
        const first = yield* live("Engraving", "engraved");
        const second = yield* live("Rush", "rush");
        strictEqual(Domain.isActive(first), true);
        strictEqual(Domain.isActive(second), true);

        // Apply on an active workflow leaves the tag alone.
        yield* repo.addStep({
          workflowId: second.id,
          name: stepName("Pack"),
          teamId: T3.id,
        });
        const applied = yield* repo.applyDraft({
          workflowId: second.id,
          teams: ALL_TEAMS,
        });
        strictEqual(tagOf(applied), "rush");
        strictEqual(applied.name, "Rush");
      }),
    ));
});

/**
 * The name is a label, not a key: the id identifies a workflow and the tag is
 * the one thing no two may share. Every write that takes a name takes any.
 */
describe("WorkflowRepository names are labels", () => {
  it("two workflows share a name, a rename takes an existing one, and a duplicate keeps the source's", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const first = yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("engraved"),
        });
        const second = yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("rush"),
        });
        strictEqual(second.name, "Engraving");
        strictEqual(first.id !== second.id, true);

        const renamed = yield* repo.updateWorkflow({
          workflowId: second.id,
          name: name("engraving"),
        });
        strictEqual(renamed.name, "engraving");

        yield* twoSteps(first.id);
        const copy = yield* repo.duplicateWorkflow({
          workflowId: first.id,
          name: name("Engraving"),
          tag: tag("third"),
        });
        strictEqual(copy.name, "Engraving");
        strictEqual(
          (yield* repo.listWorkflows({ teams: ALL_TEAMS })).length,
          3,
        );
      }),
    ));
});

/** The editor's Turn on on a never-applied workflow: one call, one transaction. */
describe("WorkflowRepository applyAndActivate", () => {
  it("promotes the draft and turns the switch on; refuses an empty workflow and leaves it off", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("engraved"),
        });

        // Nothing to promote and nothing in force: refused, and still off.
        const empty = yield* repo
          .applyAndActivate({ workflowId: w.id, teams: ALL_TEAMS })
          .pipe(Effect.flip);
        strictEqual(empty._tag, "NoStepsError");
        strictEqual(
          Domain.isActive(
            yield* found(w.id).pipe(Effect.map((detail) => detail.workflow)),
          ),
          false,
        );

        yield* twoSteps(w.id);
        const on = yield* repo.applyAndActivate({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        strictEqual(Domain.isActive(on), true);
        const after = yield* found(w.id);
        strictEqual(after.draft, null);
        deepStrictEqual(stepNames(after.steps), ["Cut", "Finish"]);

        // No draft left: the second call is a plain re-activation.
        const again = yield* repo.applyAndActivate({
          workflowId: w.id,
          activatedAt: 1000,
          teams: ALL_TEAMS,
        });
        strictEqual(again.activatedAt, 1000);
      }),
    ));
});

describe("copyName", () => {
  it("suffixes the name and trims the base to fit the 64-character limit", () => {
    strictEqual(copyName("Engraved ring"), "Engraved ring copy");
    // Names repeat, so the suffix is plain: copying twice offers the same name.
    strictEqual(copyName("Engraved ring copy"), "Engraved ring copy copy");
    const long = "x".repeat(64);
    const copied = copyName(long);
    strictEqual(copied.length, 64);
    strictEqual(copied.endsWith(" copy"), true);
  });
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
  it("create → no steps, its tag, no draft, off, not listed for starting; apply refused without a draft or steps; discard allowed", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        strictEqual(Domain.isActive(w), false);
        strictEqual(tagOf(w), "a");
        const fresh = yield* found(w.id);
        deepStrictEqual(fresh.steps, []);
        strictEqual(fresh.draft, null);
        deepStrictEqual(yield* repo.listActiveWorkflowDetails(), []);
        const [row] = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual(
          [row?.hasDraft, row?.stepCount, tagOf(row)],
          [false, 0, "a"],
        );
        const noDraft = yield* repo
          .applyDraft({ workflowId: w.id, teams: ALL_TEAMS })
          .pipe(Effect.flip);
        strictEqual(noDraft._tag, "NoDraftError");
        // The first change makes the draft; a tag write never does, so this
        // one goes through `createDraft`.
        yield* repo.createDraft({ workflowId: w.id });
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

  it("apply replaces the workflow's steps with the draft's, carries step ids over, and deletes the draft", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoSteps(w.id);
        const before = yield* found(w.id);
        const draftIds = before.draft?.steps.map((s) => s.id) ?? [];
        const applied = yield* repo.applyDraft({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        strictEqual(tagOf(applied), "a");
        strictEqual(Domain.isActive(applied), false);
        const after = yield* found(w.id);
        strictEqual(after.draft, null);
        deepStrictEqual(stepNames(after.steps), ["Cut", "Finish"]);
        deepStrictEqual(
          after.steps.map((s) => s.id),
          draftIds,
        );
        const [row] = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual(
          [row?.hasDraft, row?.stepCount, tagOf(row)],
          [false, 2, "a"],
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
        strictEqual(tagOf(detail?.workflow), "a");
        // No draft: apply and discard refuse. There is nothing to promote or throw away.
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
        // A step write with no draft creates one, as a copy of the workflow.
        yield* repo.addStep({
          workflowId: w.id,
          name: stepName("Pack"),
          teamId: T3.id,
        });
        const lazy = yield* found(w.id);
        deepStrictEqual(stepNames(lazy.draft?.steps ?? []), [
          "Cut",
          "Finish",
          "Pack",
        ]);
        // The workflow itself is untouched until Apply.
        deepStrictEqual(stepNames(lazy.steps), ["Cut", "Finish"]);
        // A tag write lands on the workflow at once and leaves the draft alone.
        yield* repo.updateWorkflowTag({ workflowId: w.id, tag: tag("b") });
        const retagged = yield* found(w.id);
        strictEqual(tagOf(retagged.workflow), "b");
        deepStrictEqual(stepNames(retagged.draft?.steps ?? []), [
          "Cut",
          "Finish",
          "Pack",
        ]);
        // A step id from the live workflow starts the draft and edits its
        // copy; an id neither side carries is still not found.
        const [first] = after.steps;
        yield* repo.updateStep({
          stepId: first?.id ?? "",
          name: stepName("Cut2"),
          teamId: T1.id,
          instructions: null,
        });
        const started = yield* found(w.id);
        deepStrictEqual(stepNames(started.draft?.steps ?? []), [
          "Cut2",
          "Finish",
          "Pack",
        ]);
        deepStrictEqual(stepNames(started.steps), ["Cut", "Finish"]);
        strictEqual(
          (yield* repo.removeStep({ stepId: "nope" }).pipe(Effect.flip))._tag,
          "StepNotFoundError",
        );
        assertNone(yield* repo.getStep({ stepId: "nope" }));
      }),
    ));

  it("createDraft copies the workflow's steps under their own ids and is idempotent; edits never touch the workflow", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoSteps(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowActive({
          workflowId: w.id,
          active: true,
          teams: ALL_TEAMS,
        });
        const draft = yield* repo.createDraft({ workflowId: w.id });
        const again = yield* repo.createDraft({ workflowId: w.id });
        strictEqual(again.createdAt, draft.createdAt);
        const forked = yield* found(w.id);
        deepStrictEqual(stepNames(forked.draft?.steps ?? []), [
          "Cut",
          "Finish",
        ]);
        const workflowIds = forked.steps.map((s) => s.id);
        const draftIds = forked.draft?.steps.map((s) => s.id) ?? [];
        // A step keeps one identity: the draft's copy carries the workflow
        // step's id, which is what lets the editor edit a step it is looking
        // at before any draft exists.
        deepStrictEqual(draftIds, workflowIds);
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
        const edited = yield* found(w.id);
        deepStrictEqual(
          edited.draft?.steps.map((s) => `${s.name}${String(s.stage)}`),
          ["Finish1", "Cut22", "Pack3", "Label3"],
        );
        deepStrictEqual(stepNames(edited.steps), ["Cut", "Finish"]);
        strictEqual(tagOf(edited.workflow), "a");
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
          tag: tag("a"),
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
        // The tag lands on the workflow immediately; Apply does not carry it.
        yield* repo.updateWorkflowTag({ workflowId: w.id, tag: tag("b") });
        const applied = yield* repo.applyDraft({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        strictEqual(Domain.isActive(applied), true);
        strictEqual(tagOf(applied), "b");
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
        const discarded = yield* repo.discardDraft({ workflowId: w.id });
        strictEqual(tagOf(discarded), "b");
        strictEqual(Domain.isActive(discarded), true);
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
          tag: tag("a"),
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
        strictEqual(Domain.isActive((yield* found(w.id)).workflow), true);
      }),
    ));

  it("turn on refused: zero steps, unassigned step; the draft is never consulted; an empty team allows", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const on = (workflowId: string, teams = ALL_TEAMS) =>
          repo.setWorkflowActive({ workflowId, active: true, teams });
        const empty = yield* repo.createWorkflow({
          name: name("Empty"),
          tag: tag("empty"),
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
          tag: tag("a"),
        });
        yield* twoSteps(a.id);
        yield* repo.applyDraft({ workflowId: a.id, teams: ALL_TEAMS });
        const orphan = yield* on(a.id, [T1]).pipe(Effect.flip);
        strictEqual(orphan._tag, "StepUnassignedError");
        if (orphan._tag === "StepUnassignedError")
          deepStrictEqual<readonly string[]>(orphan.stepNames, ["Finish"]);
        const onA = yield* on(a.id, [T1, { ...T2, memberCount: 0 }]);
        strictEqual(Domain.isActive(onA), true);
        // A draft on an active workflow changes nothing about the switch.
        yield* repo.createDraft({ workflowId: a.id });
        const off = yield* repo.setWorkflowActive({
          workflowId: a.id,
          active: false,
          teams: ALL_TEAMS,
        });
        strictEqual(Domain.isActive(off), false);
        strictEqual((yield* found(a.id)).draft !== null, true);
        strictEqual(Domain.isActive(yield* on(a.id)), true);

        // A team delete nulls the pointer; turn on is refused until assigned.
        const lost = yield* repo.createWorkflow({
          name: name("Lost"),
          tag: tag("lost"),
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

  it("turn on writes activatedAt (now, or the date given); off clears it; setWorkflowActivatedAt moves it only while on", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const pack = (yield* repo.createWorkflow({
          name: name("Pack"),
          tag: tag("pack"),
        })).id;
        yield* twoSteps(pack);
        yield* repo.applyDraft({ workflowId: pack, teams: ALL_TEAMS });
        const before = Date.now();
        const on = yield* repo.setWorkflowActive({
          workflowId: pack,
          active: true,
          teams: ALL_TEAMS,
        });
        strictEqual(on.activatedAt !== null && on.activatedAt >= before, true);
        const moved = yield* repo.setWorkflowActivatedAt({
          workflowId: pack,
          activatedAt: 1000,
        });
        strictEqual(moved.activatedAt, 1000);
        // Apply never touches it.
        yield* repo.addStep({
          workflowId: pack,
          name: stepName("Ship"),
          teamId: T3.id,
        });
        const applied = yield* repo.applyDraft({
          workflowId: pack,
          teams: ALL_TEAMS,
        });
        strictEqual(applied.activatedAt, 1000);
        const off = yield* repo.setWorkflowActive({
          workflowId: pack,
          active: false,
          teams: ALL_TEAMS,
        });
        strictEqual(off.activatedAt, null);
        strictEqual(
          (yield* repo
            .setWorkflowActivatedAt({ workflowId: pack, activatedAt: 5 })
            .pipe(Effect.flip))._tag,
          "WorkflowOffError",
        );
        strictEqual(
          (yield* repo
            .setWorkflowActivatedAt({ workflowId: "nope", activatedAt: 5 })
            .pipe(Effect.flip))._tag,
          "WorkflowNotFoundError",
        );
        // Include them: an earlier date on the way on.
        const included = yield* repo.setWorkflowActive({
          workflowId: pack,
          active: true,
          activatedAt: 42,
          teams: ALL_TEAMS,
        });
        strictEqual(included.activatedAt, 42);
      }),
    ));

  it("countStepsByTeam counts workflow and draft steps; unassignTeam nulls both sides", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
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

  it("seed: active defaults, explicit off, pending draft, empty steps with no draft, unassigned, duplicate tag refused", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const step = (n: string, teamId: Domain.TeamId) => ({
          name: stepName(n),
          teamId,
        });
        yield* repo.replaceWorkflows({
          workflows: [
            { name: name("On"), tag: tag("on"), steps: [step("a", T1.id)] },
            {
              name: name("Off"),
              active: false,
              tag: tag("off"),
              steps: [step("a", T1.id)],
            },
            {
              name: name("Pending"),
              tag: tag("p"),
              steps: [step("a", T1.id)],
              draft: { steps: [step("a", T1.id), step("b", T2.id)] },
            },
            {
              name: name("Second draft"),
              tag: tag("s"),
              steps: [step("a", T1.id)],
              draft: { steps: [step("a", T2.id)] },
            },
            { name: name("Empty"), tag: tag("e"), steps: [] },
            {
              name: name("Lost"),
              tag: tag("g"),
              steps: [{ name: stepName("a"), teamId: null }],
            },
          ],
        });
        const rows = yield* repo.listWorkflows({ teams: ALL_TEAMS });
        deepStrictEqual<readonly (readonly unknown[])[]>(
          rows.map((w) => [
            w.name,
            Domain.isActive(w),
            w.hasDraft,
            w.stepCount,
            w.needsAttention,
            tagOf(w),
          ]),
          [
            ["Empty", false, false, 0, false, "e"],
            ["Lost", false, false, 1, true, "g"],
            ["Off", false, false, 1, false, "off"],
            ["On", true, false, 1, false, "on"],
            ["Pending", true, true, 1, false, "p"],
            ["Second draft", true, true, 1, false, "s"],
          ],
        );
        const pending = rows.find((w) => w.name === "Pending");
        const pendingDetail = yield* found(pending?.id ?? "");
        deepStrictEqual(stepNames(pendingDetail.steps), ["a"]);
        deepStrictEqual(stepNames(pendingDetail.draft?.steps ?? []), [
          "a",
          "b",
        ]);
        const empty = rows.find((w) => w.name === "Empty");
        const emptyDetail = yield* found(empty?.id ?? "");
        deepStrictEqual(emptyDetail.steps, []);
        strictEqual(emptyDetail.draft, null);
        deepStrictEqual(
          (yield* repo.listActiveWorkflowDetails())
            .map(({ workflow }) => workflow.name)
            .toSorted(),
          ["On", "Pending", "Second draft"],
        );
        // An active fixture with no steps is refused.
        strictEqual(
          (yield* repo
            .replaceWorkflows({
              workflows: [
                { name: name("Bad"), active: true, tag: tag("bad"), steps: [] },
              ],
            })
            .pipe(Effect.flip))._tag,
          "WorkflowRepositoryError",
        );
        // So is a fixture whose two workflows claim one tag: the unique index
        // would refuse it anyway, naming neither.
        strictEqual(
          (yield* repo
            .replaceWorkflows({
              workflows: [
                { name: name("One"), tag: tag("shared"), steps: [] },
                { name: name("Two"), tag: tag("shared"), steps: [] },
              ],
            })
            .pipe(Effect.flip))._tag,
          "WorkflowRepositoryError",
        );
      }),
    ));
});
