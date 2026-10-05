import { SqliteClient } from "@effect/sql-sqlite-do";
import { assertNone, deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, it } from "vitest";

import * as Domain from "@/lib/Domain";
import { runShopAgentMigrations } from "@/lib/ShopAgentSchema";
import {
  ON_WORKFLOWS_BY_TAGS,
  TEAM_WORKFLOWS,
  WorkflowRepository,
  type WorkflowWithDraftTasks,
} from "@/lib/WorkflowRepository";
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

/** Every workflow, one page large enough for any test here: `listWorkflows` with no search, no filter and no cursor. */
const listAll = (
  repo: WorkflowRepository["Service"],
  {
    teams,
  }: {
    readonly teams: Parameters<
      WorkflowRepository["Service"]["listWorkflows"]
    >[0]["teams"];
  },
) =>
  repo
    .listWorkflows({ limit: 100, cursor: null, q: null, state: null, teams })
    .pipe(Effect.map(({ workflows }) => workflows));

const tagOf = (
  workflow: Domain.Workflow | Domain.WorkflowSummary | null | undefined,
): string | null => workflow?.tag ?? null;

const name = Schema.decodeUnknownSync(Domain.WorkflowName);
const taskName = Schema.decodeUnknownSync(Domain.TaskName);
const tag = Schema.decodeUnknownSync(Domain.WorkflowTag);
const teamId = Schema.decodeUnknownSync(Domain.TeamId);

const T1 = { id: teamId("t1"), memberCount: 1 };
const T2 = { id: teamId("t2"), memberCount: 1 };
const T3 = { id: teamId("t3"), memberCount: 1 };
const ALL_TEAMS = [T1, T2, T3];

/** The side the editor shows: the draft, which a fresh workflow always has. */
const editable = (found: Option.Option<WorkflowWithDraftTasks>) => {
  const { draftTasks } = Option.getOrThrow(found);
  if (draftTasks === null) throw new Error("no draft");
  return draftTasks;
};

describe("Domain workflow schemas", () => {
  it("WorkflowTag trims and keeps case", () => {
    strictEqual(tag("  Engraving "), "Engraving");
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
        Schema.decodeUnknownOption(Domain.TaskName)("x".repeat(65)),
      ),
      true,
    );
  });
});

describe("WorkflowRepository", () => {
  it("creates, lists with stepCount, takes a case variant of another workflow's name, and deletes", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const created = yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("engraving"),
        });
        const fresh = yield* found(created.id);
        strictEqual(tagOf(fresh.workflow), "engraving");
        strictEqual(fresh.draftTasks, null);
        // Names compare exactly: a case variant under a free tag is a second workflow.
        const twin = yield* repo.createWorkflow({
          name: name("engraving"),
          tag: tag("other"),
        });
        strictEqual(twin.id !== created.id, true);
        strictEqual(
          (yield* listAll(repo, {
            teams: ALL_TEAMS,
          })).length,
          2,
        );
        yield* repo.deleteWorkflow({ workflowId: twin.id });
        const all = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        strictEqual(all.length, 1);
        strictEqual(all[0]?.stepCount, 0);
        yield* repo.deleteWorkflow({ workflowId: created.id });
        strictEqual(
          (yield* listAll(repo, {
            teams: ALL_TEAMS,
          })).length,
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
        strictEqual(tagOf(retagged), "X");
        strictEqual(retagged.id, updated.id);
        // Immediate, like the rename: no draft is created for it.
        strictEqual((yield* found(a.id)).draftTasks, null);
        // Re-saving the workflow's own tag is not a collision.
        strictEqual(
          tagOf(
            yield* repo.updateWorkflowTag({ workflowId: a.id, tag: tag("X") }),
          ),
          "X",
        );
        const tagTaken = yield* repo
          .updateWorkflowTag({ workflowId: a.id, tag: tag("b") })
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

  it("enforces the workflow limit; a delete makes room", () =>
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
        const [first] = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
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
            name: taskName(n),
            teamId: teamId("t1"),
          });
        const s1 = yield* add("One");
        const s2 = yield* add("Two");
        const s3 = yield* add("Three");
        deepStrictEqual([s1.position, s2.position, s3.position], [1, 2, 3]);
        deepStrictEqual([s1.step, s2.step, s3.step], [1, 2, 3]);

        const positions = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) =>
            editable(d).map((s) => s.name),
          );
        const steps = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) =>
            editable(d).map((s) => s.step),
          );

        yield* repo.moveTask({ taskId: s1.id, direction: "up" });
        deepStrictEqual(yield* positions(), ["One", "Two", "Three"]);
        yield* repo.moveTask({ taskId: s3.id, direction: "down" });
        deepStrictEqual(yield* positions(), ["One", "Two", "Three"]);
        // A move only reorders: the task slides past the neighbouring step
        // into one of its own, never joining it. `joinTask` is what merges,
        // and `separateTask` undoes that.
        yield* repo.moveTask({ taskId: s3.id, direction: "up" });
        deepStrictEqual(yield* positions(), ["One", "Three", "Two"]);
        deepStrictEqual(yield* steps(), [1, 2, 3]);
        yield* repo.joinTask({ taskId: s3.id });
        deepStrictEqual(yield* positions(), ["One", "Three", "Two"]);
        deepStrictEqual(yield* steps(), [1, 1, 2]);
        yield* repo.separateTask({ taskId: s3.id });
        deepStrictEqual(yield* steps(), [1, 2, 3]);
        yield* repo.moveTask({ taskId: s1.id, direction: "down" });
        deepStrictEqual(yield* positions(), ["Three", "One", "Two"]);
        deepStrictEqual(yield* steps(), [1, 2, 3]);

        yield* repo.removeTask({ taskId: s1.id });
        const after = editable(yield* repo.getWorkflow({ workflowId: w.id }));
        deepStrictEqual(
          after.map((s) => [s.name, s.position, s.step]),
          [
            ["Three", 1, 1],
            ["Two", 2, 2],
          ],
        );
        const s4 = yield* add("Four");
        strictEqual(s4.position, 3);
        strictEqual(s4.step, 3);

        const missing = yield* repo
          .removeTask({ taskId: s1.id })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "TaskNotFoundError");
      }),
    ));

  it("step is dense from 1 and non-decreasing along position, a step of one task being the linear case", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        // Every editor write goes through editDraft and lands whole through
        // Domain.WorkflowTasks; the decoded list holds the rule after each.
        const holds = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) => {
            const tasks = editable(d);
            strictEqual(Domain.layoutIsValid(tasks), true);
            return tasks.map((t) => `${t.name}${String(t.step)}`);
          });
        const add = (n: string) =>
          repo.addStep({
            workflowId: w.id,
            name: taskName(n),
            teamId: teamId("t1"),
          });
        yield* add("a");
        yield* add("b");
        const c = yield* add("c");
        // Linear: one task per step, steps 1..3.
        deepStrictEqual(yield* holds(), ["a1", "b2", "c3"]);
        yield* repo.joinTask({ taskId: c.id });
        deepStrictEqual(yield* holds(), ["a1", "b2", "c2"]);
        yield* repo.addTask({
          workflowId: w.id,
          step: 1,
          name: taskName("d"),
          teamId: teamId("t1"),
        });
        deepStrictEqual(yield* holds(), ["a1", "d1", "b2", "c2"]);
        yield* repo.removeTask({ taskId: c.id });
        deepStrictEqual(yield* holds(), ["a1", "d1", "b2"]);
      }),
    ));

  it("steps: join merges, move reorders, separate splits, remove closes, addTask shares; unknown step fails", () =>
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
            name: taskName(n),
            teamId: teamId("t1"),
          });
        const layout = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) =>
            editable(d).map((s) => `${s.name}${String(s.step)}`),
          );
        const a = yield* add("a");
        const b = yield* repo.addTask({
          workflowId: w.id,
          step: 1,
          name: taskName("b"),
          teamId: teamId("t2"),
        });
        strictEqual(b.step, 1);
        strictEqual(b.position, 2);
        const c = yield* add("c");
        const d = yield* add("d");
        deepStrictEqual(yield* layout(), ["a1", "b1", "c2", "d3"]);

        yield* repo.joinTask({ taskId: c.id });
        deepStrictEqual(yield* layout(), ["a1", "b1", "c1", "d2"]);
        // Reordering out of a shared step leaves the mates together.
        yield* repo.moveTask({ taskId: c.id, direction: "up" });
        deepStrictEqual(yield* layout(), ["c1", "a2", "b2", "d3"]);
        yield* repo.joinTask({ taskId: c.id });
        deepStrictEqual(yield* layout(), ["c1", "a2", "b2", "d3"]);
        yield* repo.moveTask({ taskId: c.id, direction: "down" });
        deepStrictEqual(yield* layout(), ["a1", "b1", "c2", "d3"]);
        yield* repo.joinTask({ taskId: c.id });
        deepStrictEqual(yield* layout(), ["a1", "b1", "c1", "d2"]);

        yield* repo.separateTask({ taskId: b.id });
        deepStrictEqual(yield* layout(), ["a1", "c1", "b2", "d3"]);
        yield* repo.separateTask({ taskId: b.id });
        deepStrictEqual(yield* layout(), ["a1", "c1", "b2", "d3"]);

        yield* repo.removeTask({ taskId: b.id });
        deepStrictEqual(yield* layout(), ["a1", "c1", "d2"]);

        const e = yield* repo.addTask({
          workflowId: w.id,
          step: 2,
          name: taskName("e"),
          teamId: teamId("t1"),
        });
        strictEqual(e.step, 2);
        deepStrictEqual(yield* layout(), ["a1", "c1", "d2", "e2"]);
        strictEqual(a.id !== d.id, true);

        const noStep = yield* repo
          .addTask({
            workflowId: w.id,
            step: 9,
            name: taskName("x"),
            teamId: teamId("t1"),
          })
          .pipe(Effect.flip);
        strictEqual(noStep._tag, "StepNotFoundError");
        const noWorkflow = yield* repo
          .addTask({
            workflowId: "nope",
            step: 1,
            name: taskName("x"),
            teamId: teamId("t1"),
          })
          .pipe(Effect.flip);
        strictEqual(noWorkflow._tag, "WorkflowNotFoundError");
      }),
    ));

  it("a workflow's stepCount is the number of steps, not tasks", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        yield* repo.replaceWorkflows({
          workflows: [
            {
              name: name("Stepped"),
              tag: tag("s"),
              tasks: [
                { name: taskName("a"), teamId: teamId("t1"), step: 1 },
                { name: taskName("b"), teamId: teamId("t2"), step: 1 },
                { name: taskName("c"), teamId: teamId("t3"), step: 2 },
              ],
            },
          ],
        });
        const [row] = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        strictEqual(row?.stepCount, 2);
      }),
    ));

  it("replaceWorkflows round-trips explicit steps and instructions; rejects an invalid layout", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const instructions = Schema.decodeUnknownSync(Domain.TaskInstructions);
        yield* repo.replaceWorkflows({
          workflows: [
            {
              name: name("Stepped"),
              tag: tag("s"),
              tasks: [
                {
                  name: taskName("a"),
                  teamId: teamId("t1"),
                  step: 1,
                  instructions: instructions("Read the order"),
                },
                { name: taskName("b"), teamId: teamId("t2"), step: 1 },
                { name: taskName("c"), teamId: teamId("t3"), step: 2 },
              ],
            },
            {
              name: name("Linear"),
              tag: tag("l"),
              tasks: [
                { name: taskName("x"), teamId: teamId("t1") },
                { name: taskName("y"), teamId: teamId("t2") },
              ],
            },
          ],
        });
        const [linear, stepped] = yield* onWorkflows;
        deepStrictEqual(
          stepped?.tasks.map((s) => [
            s.name,
            s.position,
            s.step,
            s.instructions,
          ]),
          [
            ["a", 1, 1, "Read the order"],
            ["b", 2, 1, null],
            ["c", 3, 2, null],
          ],
        );
        deepStrictEqual(
          linear?.tasks.map((s) => [s.name, s.step]),
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
                tasks: [
                  { name: taskName("a"), teamId: teamId("t1"), step: 1 },
                  { name: taskName("b"), teamId: teamId("t1"), step: 3 },
                ],
              },
            ],
          })
          .pipe(Effect.flip);
        strictEqual(invalid._tag, "WorkflowRepositoryError");
        strictEqual((yield* onWorkflows).length, 2);
      }),
    ));

  it("replaceWorkflows seeds an unassigned task off and refuses a fixture the ordinary path could not produce", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        yield* repo.replaceWorkflows({
          workflows: [
            {
              name: name("Live"),
              tag: tag("live"),
              tasks: [{ name: taskName("a"), teamId: teamId("t1") }],
            },
            {
              name: name("Lost"),
              tag: tag("lost"),
              tasks: [{ name: taskName("a"), teamId: null }],
            },
          ],
        });
        deepStrictEqual(
          (yield* onWorkflows).map(({ workflow }) => workflow.name).toSorted(),
          ["Live"],
        );
        const all = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        deepStrictEqual(
          all.map((w) => [w.name, Domain.workflowIsOn(w), w.unassigned]),
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
              on: true,
              tag: tag("x"),
              tasks: [],
            },
          ]))._tag,
          "WorkflowRepositoryError",
        );
        // On with a task nobody owns: what `setWorkflowOn` answers
        // `TaskUnassigned` to, and a fixture must not be able to write it.
        strictEqual(
          (yield* refused([
            {
              name: name("Active but unassigned"),
              on: true,
              tag: tag("y"),
              tasks: [{ name: taskName("a"), teamId: null }],
            },
          ]))._tag,
          "WorkflowRepositoryError",
        );
        // The ordinary path's ceilings, which the seed used to skip.
        strictEqual(
          (yield* refused([
            {
              name: name("Too many tasks"),
              tag: tag("z"),
              tasks: Array.from(
                { length: Domain.WorkflowLimits.maxTasks + 1 },
                (_, index) => ({
                  name: taskName(`s${String(index)}`),
                  teamId: teamId("t1"),
                }),
              ),
            },
          ]))._tag,
          "WorkflowRepositoryError",
        );
        strictEqual(
          (yield* refused(
            Array.from(
              { length: Domain.WorkflowLimits.maxWorkflows + 1 },
              (_, index) => ({
                name: name(`W${String(index)}`),
                tag: tag(`w${String(index)}`),
                tasks: [],
              }),
            ),
          ))._tag,
          "WorkflowRepositoryError",
        );
        // Refusals happen before the transaction: the previous seed survives.
        strictEqual(all.length, 2);
        strictEqual(
          (yield* listAll(repo, {
            teams: ALL_TEAMS,
          })).length,
          2,
        );
      }),
    ));

  it("replaceWorkflows returns the id it minted for each workflow", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        // The seed's items point at a workflow by id, and nothing else
        // in this write path hands one back.
        const seeded = yield* repo.replaceWorkflows({
          workflows: [
            {
              name: name("Board"),
              tag: tag("board"),
              tasks: [{ name: taskName("Cut"), teamId: teamId("t1") }],
            },
            { name: name("Sample"), tag: tag("sample"), tasks: [] },
          ],
        });
        deepStrictEqual(
          seeded.map(({ name: workflowName }) => workflowName),
          ["Board", "Sample"],
        );
        const stored = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        deepStrictEqual(
          seeded.map(({ id }) => id).toSorted(),
          stored.map(({ id }) => id).toSorted(),
        );
      }),
    ));

  it("updateTask rewrites name and team; enforces the task limit", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        const s = yield* repo.addStep({
          workflowId: w.id,
          name: taskName("X"),
          teamId: teamId("t1"),
        });
        const updated = yield* repo.updateTask({
          taskId: s.id,
          name: taskName("Y"),
          teamId: teamId("t2"),
          instructions: Schema.decodeUnknownSync(Domain.TaskInstructions)(
            "Mind the grain",
          ),
        });
        strictEqual(updated.name, "Y");
        strictEqual(updated.teamId, "t2");
        strictEqual(updated.instructions, "Mind the grain");
        const cleared = yield* repo.updateTask({
          taskId: s.id,
          name: taskName("Y"),
          teamId: teamId("t2"),
          instructions: null,
        });
        strictEqual(cleared.instructions, null);
        yield* Effect.forEach(
          Array.from(
            { length: Domain.WorkflowLimits.maxTasks - 1 },
            (_, i) => i,
          ),
          (i) =>
            repo.addStep({
              workflowId: w.id,
              name: taskName(`S${String(i)}`),
              teamId: teamId("t1"),
            }),
          { discard: true },
        );
        const over = yield* repo
          .addStep({
            workflowId: w.id,
            name: taskName("Over"),
            teamId: teamId("t1"),
          })
          .pipe(Effect.flip);
        strictEqual(over._tag, "WorkflowLimitError");
        const noWorkflow = yield* repo
          .addStep({
            workflowId: "nope",
            name: taskName("Z"),
            teamId: teamId("t1"),
          })
          .pipe(Effect.flip);
        strictEqual(noWorkflow._tag, "WorkflowNotFoundError");
      }),
    ));

  it("listTeamWorkflows pages by name across workflows and both sides; countTeamWorkflows counts per team", () =>
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
          name: taskName("A1"),
          teamId: teamId("t1"),
        });
        yield* repo.addStep({
          workflowId: a.id,
          name: taskName("A2"),
          teamId: teamId("t2"),
        });
        yield* repo.addStep({
          workflowId: b.id,
          name: taskName("B1"),
          teamId: teamId("t1"),
        });
        yield* repo.applyDraft({ workflowId: b.id, teams: ALL_TEAMS });
        const all = yield* repo.listTeamWorkflows({
          teamId: "t1",
          after: null,
          limit: 10,
        });
        deepStrictEqual(
          all.workflows.map((o) => o.workflowName),
          ["A", "B"],
        );
        strictEqual(all.nextCursor, null);
        const first = yield* repo.listTeamWorkflows({
          teamId: "t1",
          after: null,
          limit: 1,
        });
        deepStrictEqual(
          first.workflows.map((o) => o.workflowName),
          ["A"],
        );
        strictEqual(first.nextCursor, "A");
        const second = yield* repo.listTeamWorkflows({
          teamId: "t1",
          after: first.nextCursor,
          limit: 1,
        });
        deepStrictEqual(
          second.workflows.map((o) => o.workflowName),
          ["B"],
        );
        strictEqual(second.nextCursor, null);
        deepStrictEqual(
          (yield* repo.countTeamWorkflows()).map((o) => [
            o.teamId,
            o.workflowCount,
          ]),
          [
            ["t1", 2],
            ["t2", 1],
          ],
        );
      }),
    ));

  it("deleteWorkflow removes the workflow with its tasks and its draft", () =>
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
          name: taskName("X"),
          teamId: teamId("t1"),
        });
        strictEqual(Option.isSome(yield* repo.getTask({ taskId: s.id })), true);
        yield* repo.deleteWorkflow({ workflowId: w.id });
        assertNone(yield* repo.getTask({ taskId: s.id }));
        assertNone(yield* repo.getWorkflow({ workflowId: w.id }));
        // The tasks and the draft are columns of the row, so nothing of
        // the workflow is left anywhere.
        strictEqual(
          Number((yield* sql`select count(*) as n from Workflow`)[0]?.n),
          0,
        );
      }),
    ));
});

describe("WorkflowRepository workflows index", () => {
  it("the workflows index pages by name and a search narrows it", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const names = Array.from(
          { length: 55 },
          (_, index) => `Ring ${String(index).padStart(2, "0")}`,
        );
        yield* repo.replaceWorkflows({
          workflows: [
            ...names.map((each) => ({
              name: name(each),
              tag: tag(each),
              tasks: [],
            })),
            { name: name("Mug glaze"), tag: tag("mug"), tasks: [] },
          ],
        });
        const page = (
          cursor: Domain.WorkflowName | null,
          q: string | null = null,
        ) =>
          repo.listWorkflows({
            limit: 50,
            cursor,
            q:
              q === null
                ? null
                : Schema.decodeUnknownSync(Domain.ListSearch)(q),
            state: null,
            teams: ALL_TEAMS,
          });
        const first = yield* page(null);
        strictEqual(first.workflows.length, 50);
        strictEqual(first.workflows[0]?.name, "Mug glaze");
        strictEqual(first.matches, null);
        if (first.nextCursor === null) throw new Error("no next page");
        const second = yield* page(first.nextCursor);
        deepStrictEqual(
          second.workflows.map((workflow) => workflow.name),
          names.slice(49),
        );
        strictEqual(second.nextCursor, null);
        // A word prefix of the name, over every page; the state filter is
        // ignored under a search.
        const found = yield* page(null, "glaz");
        deepStrictEqual(
          found.workflows.map((workflow) => workflow.name),
          ["Mug glaze"],
        );
        strictEqual(found.matches, 1);
        strictEqual((yield* page(null, "ring")).matches, 55);
        // Every seeded workflow is off; a search for them under the on filter
        // still finds them.
        const underFilter = yield* repo.listWorkflows({
          limit: 50,
          cursor: null,
          q: Schema.decodeUnknownSync(Domain.ListSearch)("ring"),
          state: "on",
          teams: ALL_TEAMS,
        });
        strictEqual(underFilter.matches, 55);
        strictEqual(
          (yield* repo.listWorkflows({
            limit: 50,
            cursor: null,
            q: null,
            state: "on",
            teams: ALL_TEAMS,
          })).workflows.length,
          0,
        );
      }),
    ));

  it("the run path finds the order's workflows through the index on the tag", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.replaceWorkflows({
          workflows: Array.from({ length: 200 }, (_, index) => ({
            name: name(`W ${String(index)}`),
            tag: tag(`w${String(index)}`),
            tasks: [{ name: taskName("Task"), teamId: teamId("t1") }],
          })),
        });
        const found = yield* repo.listOnWorkflowsByTags({
          tags: ["w7", "w70", "none"],
        });
        deepStrictEqual(
          found.map((detail) => detail.workflow.tag),
          ["w7", "w70"],
        );
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `explain query plan ${ON_WORKFLOWS_BY_TAGS}`,
          [JSON.stringify(["w7"])],
        );
        const details = plan.map((row) => row.detail);
        strictEqual(
          details.some((detail) =>
            detail.startsWith("SEARCH Workflow USING INDEX"),
          ),
          true,
          details.join("\n"),
        );
        strictEqual(
          details.some((detail) => /^SCAN Workflow\b/u.test(detail)),
          false,
          details.join("\n"),
        );
      }),
    ));

  it("the Used by read walks the name index from the cursor, with no sort", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.replaceWorkflows({
          workflows: Array.from({ length: 200 }, (_, index) => ({
            name: name(`W ${String(index).padStart(3, "0")}`),
            tag: tag(`w${String(index)}`),
            tasks: [
              {
                name: taskName("Task"),
                teamId: teamId(index % 2 === 0 ? "t1" : "t2"),
              },
            ],
          })),
        });
        const page = yield* repo.listTeamWorkflows({
          teamId: "t2",
          after: name("W 010"),
          limit: 2,
        });
        deepStrictEqual(
          page.workflows.map((workflow) => workflow.workflowName),
          ["W 011", "W 013"],
        );
        strictEqual(page.nextCursor, "W 013");
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `explain query plan ${TEAM_WORKFLOWS}`,
          ["W 010", "t2", 3],
        );
        const details = plan.map((row) => row.detail);
        strictEqual(
          details.some((detail) =>
            /^SEARCH w USING (?:COVERING )?INDEX .*\(name>\?\)/u.test(detail),
          ),
          true,
          details.join("\n"),
        );
        strictEqual(
          details.some((detail) => detail.includes("TEMP B-TREE")),
          false,
          details.join("\n"),
        );
      }),
    ));
});

describe("WorkflowRepository duplicate", () => {
  it("copies the tasks and their steps under the given name and tag, lands off with no draft", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("Engraved ring"),
          tag: tag("engraved"),
        });
        yield* twoTasks(w.id);
        const [first] = editable(yield* repo.getWorkflow({ workflowId: w.id }));
        yield* repo.addTask({
          workflowId: w.id,
          step: first?.step ?? 1,
          name: taskName("Polish"),
          teamId: T3.id,
        });
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowOn({
          workflowId: w.id,
          on: true,
          teams: ALL_TEAMS,
        });

        const copy = yield* repo.duplicateWorkflow({
          workflowId: w.id,
          name: name("Engraved ring copy"),
          tag: tag("Engraved copy"),
        });
        strictEqual(copy.name, "Engraved ring copy");
        strictEqual(Domain.workflowIsOn(copy), false);
        strictEqual(tagOf(copy), "Engraved copy");
        const copied = Option.getOrThrow(
          yield* repo.getWorkflow({ workflowId: copy.id }),
        );
        strictEqual(copied.draftTasks, null);
        const source = Option.getOrThrow(
          yield* repo.getWorkflow({ workflowId: w.id }),
        );
        deepStrictEqual(
          copied.tasks.map((s) => [s.name, s.step, s.teamId]),
          source.tasks.map((s) => [s.name, s.step, s.teamId]),
        );
        // New rows, not the source's.
        strictEqual(
          copied.tasks.some((s) => source.tasks.some((o) => o.id === s.id)),
          false,
        );
        // The source is untouched and still on.
        strictEqual(Domain.workflowIsOn(source.workflow), true);
        strictEqual(tagOf(source.workflow), "engraved");

        // A second copy under the first copy's name is refused.
        strictEqual(
          (yield* repo
            .duplicateWorkflow({
              workflowId: w.id,
              name: name("Engraved ring copy"),
              tag: tag("free"),
            })
            .pipe(Effect.flip))._tag,
          "WorkflowNameTakenError",
        );
        const tagTaken = yield* repo
          .duplicateWorkflow({
            workflowId: w.id,
            name: name("Another copy"),
            tag: tag("engraved"),
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
        // Exact: `engraved` again collides; `Engraved` is another tag.
        const refused = yield* repo
          .createWorkflow({ name: name("Rush"), tag: tag(" engraved ") })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "WorkflowTagTakenError");
        if (refused._tag === "WorkflowTagTakenError") {
          strictEqual(refused.tag, "engraved");
          strictEqual(refused.workflowName, holder.name);
        }
        // Still refused once the holder is on; the rule does not depend on it.
        yield* twoTasks(holder.id);
        yield* repo.applyDraft({ workflowId: holder.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowOn({
          workflowId: holder.id,
          on: true,
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

  it("refuses the tag alone: a case variant of the name under a free tag goes through", () =>
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
        // The refusal names the holder; its name picks it out.
        if (sameTag._tag === "WorkflowTagTakenError")
          strictEqual(sameTag.workflowName, holder.name);
      }),
    ));

  it("Turn on and Apply ignore tags: two workflows that are on, with different tags, coexist", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const live = (workflowName: string, value: string) =>
          Effect.gen(function* () {
            const w = yield* repo.createWorkflow({
              name: name(workflowName),
              tag: tag(value),
            });
            yield* twoTasks(w.id);
            yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
            return yield* repo.setWorkflowOn({
              workflowId: w.id,
              on: true,
              teams: ALL_TEAMS,
            });
          });
        const first = yield* live("Engraving", "engraved");
        const second = yield* live("Rush", "rush");
        strictEqual(Domain.workflowIsOn(first), true);
        strictEqual(Domain.workflowIsOn(second), true);

        // Apply on a workflow that is on leaves the tag alone.
        yield* repo.addStep({
          workflowId: second.id,
          name: taskName("Pack"),
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
 * The name is unique in the shop, compared exactly, on every write that takes
 * one: members pick a workflow by name alone. The name is checked before the
 * tag, since the dialogs prefill the tag from the name.
 */
describe("WorkflowRepository name uniqueness", () => {
  it("create, rename and duplicate refuse a name another workflow has; a case variant goes through", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const first = yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("engraved"),
        });
        const second = yield* repo.createWorkflow({
          name: name("Rush"),
          tag: tag("rush"),
        });

        const created = yield* repo
          .createWorkflow({ name: name("Engraving"), tag: tag("other") })
          .pipe(Effect.flip);
        strictEqual(created._tag, "WorkflowNameTakenError");

        const renamed = yield* repo
          .updateWorkflow({ workflowId: second.id, name: name("Engraving") })
          .pipe(Effect.flip);
        strictEqual(renamed._tag, "WorkflowNameTakenError");
        // A rename may keep the workflow's own name.
        strictEqual(
          (yield* repo.updateWorkflow({
            workflowId: first.id,
            name: name("Engraving"),
          })).name,
          "Engraving",
        );

        yield* twoTasks(first.id);
        const copied = yield* repo
          .duplicateWorkflow({
            workflowId: first.id,
            name: name("Engraving"),
            tag: tag("third"),
          })
          .pipe(Effect.flip);
        strictEqual(copied._tag, "WorkflowNameTakenError");

        const variant = yield* repo.createWorkflow({
          name: name("engraving"),
          tag: tag("lower"),
        });
        strictEqual(variant.name, "engraving");
        strictEqual(
          (yield* listAll(repo, {
            teams: ALL_TEAMS,
          })).length,
          3,
        );
      }),
    ));

  it("checks the name before the tag", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        yield* repo.createWorkflow({
          name: name("Engraving"),
          tag: tag("engraving"),
        });
        const both = yield* repo
          .createWorkflow({ name: name("Engraving"), tag: tag("engraving") })
          .pipe(Effect.flip);
        strictEqual(both._tag, "WorkflowNameTakenError");
      }),
    ));
});

/** The editor's Turn on on a never-applied workflow: one call, one transaction. */
describe("WorkflowRepository applyAndTurnOn", () => {
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
          .applyAndTurnOn({ workflowId: w.id, teams: ALL_TEAMS })
          .pipe(Effect.flip);
        strictEqual(empty._tag, "NoTasksError");
        strictEqual(
          Domain.workflowIsOn(
            yield* found(w.id).pipe(Effect.map((detail) => detail.workflow)),
          ),
          false,
        );

        yield* twoTasks(w.id);
        const on = yield* repo.applyAndTurnOn({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        strictEqual(Domain.workflowIsOn(on), true);
        const after = yield* found(w.id);
        strictEqual(after.draftTasks, null);
        deepStrictEqual(taskNames(after.tasks), ["Cut", "Finish"]);

        // No draft left: the second call is a plain re-activation.
        const again = yield* repo.applyAndTurnOn({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        strictEqual(again.state, "on");
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

/** Two draft tasks on a fresh workflow, ready to apply. */
const twoTasks = (workflowId: string) =>
  Effect.gen(function* () {
    const repo = yield* WorkflowRepository;
    yield* repo.addStep({ workflowId, name: taskName("Cut"), teamId: T1.id });
    yield* repo.addStep({
      workflowId,
      name: taskName("Finish"),
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

/** Every on workflow with its tasks, found by tag the way reconcile finds them. */
const onWorkflows = Effect.gen(function* () {
  const repo = yield* WorkflowRepository;
  const tags = (yield* listAll(repo, {
    teams: ALL_TEAMS,
  })).map((workflow) => workflow.tag);
  return yield* repo.listOnWorkflowsByTags({ tags });
});

const taskNames = (tasks: readonly { readonly name: string }[]) =>
  tasks.map((s) => s.name);

describe("WorkflowRepository workflow and draft", () => {
  it("a draft is the draftTasks column: null until the first edit, a copy of the tasks at the first edit, null again after Apply and after Discard", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        const column = (workflowId: string) =>
          Effect.map(
            sql<{
              readonly draftTasks: string | null;
            }>`select draftTasks from Workflow where id = ${workflowId}`,
            ([row]) => row?.draftTasks ?? null,
          );
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        strictEqual(yield* column(w.id), null);
        yield* twoTasks(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        strictEqual(yield* column(w.id), null);
        const applied = yield* found(w.id);
        // The first edit copies the tasks whole, then edits the copy.
        yield* repo.addStep({
          workflowId: w.id,
          name: taskName("Pack"),
          teamId: T3.id,
        });
        const drafted = yield* found(w.id);
        deepStrictEqual(drafted.tasks, applied.tasks);
        deepStrictEqual(drafted.draftTasks?.slice(0, 2), applied.tasks);
        strictEqual(drafted.draftTasks?.length, 3);
        yield* repo.discardDraft({ workflowId: w.id });
        strictEqual(yield* column(w.id), null);
        deepStrictEqual((yield* found(w.id)).tasks, applied.tasks);
      }),
    ));

  it("the first editor write on a task the workflow holds creates the draft and edits the same task id", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoTasks(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        const [cut] = (yield* found(w.id)).tasks;
        if (cut === undefined) throw new Error("no task");
        const edited = yield* repo.updateTask({
          taskId: cut.id,
          name: taskName("Cut again"),
          teamId: T2.id,
          instructions: null,
        });
        strictEqual(edited.id, cut.id);
        const after = yield* found(w.id);
        deepStrictEqual(taskNames(after.tasks), ["Cut", "Finish"]);
        deepStrictEqual(taskNames(after.draftTasks ?? []), [
          "Cut again",
          "Finish",
        ]);
        strictEqual(after.draftTasks?.[0]?.id, cut.id);
      }),
    ));

  it("a stored list that violates the step rule is refused on decode", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        // A gap: step 1 then step 3.
        const gap = [1, 3].map((step) => ({
          id: `task-${String(step)}`,
          step,
          name: "Task",
          teamId: null,
          instructions: null,
        }));
        yield* sql`
          update Workflow set tasks = ${JSON.stringify(gap)} where id = ${w.id}
        `;
        const refused = yield* repo
          .getWorkflow({ workflowId: w.id })
          .pipe(Effect.flip);
        strictEqual(refused._tag, "WorkflowRepositoryError");
      }),
    ));

  it("create → no tasks, its tag, no draft, off, not listed for starting; apply refused without a draft or tasks; discard allowed", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        strictEqual(Domain.workflowIsOn(w), false);
        strictEqual(tagOf(w), "a");
        const fresh = yield* found(w.id);
        deepStrictEqual(fresh.tasks, []);
        strictEqual(fresh.draftTasks, null);
        deepStrictEqual(yield* onWorkflows, []);
        const [row] = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        deepStrictEqual([row?.stepCount, tagOf(row)], [0, "a"]);
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
        strictEqual(empty._tag, "NoTasksError");
        const on = yield* repo
          .setWorkflowOn({
            workflowId: w.id,
            on: true,
            teams: ALL_TEAMS,
          })
          .pipe(Effect.flip);
        strictEqual(on._tag, "NoTasksError");
        // Discard on a never-applied workflow: zero tasks, no draft.
        const discarded = yield* repo.discardDraft({ workflowId: w.id });
        strictEqual(discarded.id, w.id);
        const after = yield* found(w.id);
        strictEqual(after.draftTasks, null);
        deepStrictEqual(after.tasks, []);
        const again = yield* repo
          .discardDraft({ workflowId: w.id })
          .pipe(Effect.flip);
        strictEqual(again._tag, "NoDraftError");
      }),
    ));

  it("apply replaces the workflow's tasks with the draft's, carries task ids over, and deletes the draft", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoTasks(w.id);
        const before = yield* found(w.id);
        const draftIds = before.draftTasks?.map((s) => s.id) ?? [];
        const applied = yield* repo.applyDraft({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        strictEqual(tagOf(applied), "a");
        strictEqual(Domain.workflowIsOn(applied), false);
        const after = yield* found(w.id);
        strictEqual(after.draftTasks, null);
        deepStrictEqual(taskNames(after.tasks), ["Cut", "Finish"]);
        deepStrictEqual(
          after.tasks.map((s) => s.id),
          draftIds,
        );
        const [row] = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        deepStrictEqual([row?.stepCount, tagOf(row)], [2, "a"]);
        // Off: still invisible to run creation until turned on.
        deepStrictEqual(yield* onWorkflows, []);
        yield* repo.setWorkflowOn({
          workflowId: w.id,
          on: true,
          teams: ALL_TEAMS,
        });
        const [detail] = yield* onWorkflows;
        deepStrictEqual(taskNames(detail?.tasks ?? []), ["Cut", "Finish"]);
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
        // A task write with no draft creates one, as a copy of the workflow.
        yield* repo.addStep({
          workflowId: w.id,
          name: taskName("Pack"),
          teamId: T3.id,
        });
        const lazy = yield* found(w.id);
        deepStrictEqual(taskNames(lazy.draftTasks ?? []), [
          "Cut",
          "Finish",
          "Pack",
        ]);
        // The workflow itself is untouched until Apply.
        deepStrictEqual(taskNames(lazy.tasks), ["Cut", "Finish"]);
        // A tag write lands on the workflow at once and leaves the draft alone.
        yield* repo.updateWorkflowTag({ workflowId: w.id, tag: tag("b") });
        const retagged = yield* found(w.id);
        strictEqual(tagOf(retagged.workflow), "b");
        deepStrictEqual(taskNames(retagged.draftTasks ?? []), [
          "Cut",
          "Finish",
          "Pack",
        ]);
        // A task id from the live workflow starts the draft and edits its
        // copy; an id neither side carries is still not found.
        const [first] = after.tasks;
        yield* repo.updateTask({
          taskId: first?.id ?? "",
          name: taskName("Cut2"),
          teamId: T1.id,
          instructions: null,
        });
        const started = yield* found(w.id);
        deepStrictEqual(taskNames(started.draftTasks ?? []), [
          "Cut2",
          "Finish",
          "Pack",
        ]);
        deepStrictEqual(taskNames(started.tasks), ["Cut", "Finish"]);
        strictEqual(
          (yield* repo.removeTask({ taskId: "nope" }).pipe(Effect.flip))._tag,
          "TaskNotFoundError",
        );
        assertNone(yield* repo.getTask({ taskId: "nope" }));
      }),
    ));

  it("createDraft copies the workflow's tasks under their own ids and is idempotent; edits never touch the workflow", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoTasks(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowOn({
          workflowId: w.id,
          on: true,
          teams: ALL_TEAMS,
        });
        const draft = yield* repo.createDraft({ workflowId: w.id });
        const again = yield* repo.createDraft({ workflowId: w.id });
        deepStrictEqual(again, draft);
        const forked = yield* found(w.id);
        deepStrictEqual(taskNames(forked.draftTasks ?? []), ["Cut", "Finish"]);
        const workflowIds = forked.tasks.map((s) => s.id);
        const draftIds = forked.draftTasks?.map((s) => s.id) ?? [];
        // A task keeps one identity: the draft's copy carries the workflow
        // task's id, which is what lets the editor edit a task it is looking
        // at before any draft exists.
        deepStrictEqual(draftIds, workflowIds);
        deepStrictEqual(
          forked.draftTasks?.map((s) => [s.position, s.step, s.teamId]),
          forked.tasks.map((s) => [s.position, s.step, s.teamId]),
        );
        // Every edit lands on the draft; the workflow and what creates runs
        // are untouched.
        const [cut, finish] = draftIds;
        yield* repo.updateTask({
          taskId: cut ?? "",
          name: taskName("Cut2"),
          teamId: T3.id,
          instructions: null,
        });
        yield* repo.moveTask({ taskId: finish ?? "", direction: "up" });
        yield* repo.separateTask({ taskId: finish ?? "" });
        const pack = yield* repo.addStep({
          workflowId: w.id,
          name: taskName("Pack"),
          teamId: T3.id,
        });
        yield* repo.addTask({
          workflowId: w.id,
          step: pack.step,
          name: taskName("Label"),
          teamId: T1.id,
        });
        const edited = yield* found(w.id);
        deepStrictEqual(
          edited.draftTasks?.map((s) => `${s.name}${String(s.step)}`),
          ["Finish1", "Cut22", "Pack3", "Label3"],
        );
        deepStrictEqual(taskNames(edited.tasks), ["Cut", "Finish"]);
        strictEqual(tagOf(edited.workflow), "a");
        const [detail] = yield* onWorkflows;
        deepStrictEqual(taskNames(detail?.tasks ?? []), ["Cut", "Finish"]);
        const missing = yield* repo
          .createDraft({ workflowId: "nope" })
          .pipe(Effect.flip);
        strictEqual(missing._tag, "WorkflowNotFoundError");
      }),
    ));

  it("apply while on replaces the tasks in place and leaves the switch alone; discard deletes the draft and leaves the workflow", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoTasks(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        yield* repo.setWorkflowOn({
          workflowId: w.id,
          on: true,
          teams: ALL_TEAMS,
        });
        yield* repo.createDraft({ workflowId: w.id });
        yield* repo.addStep({
          workflowId: w.id,
          name: taskName("Pack"),
          teamId: T3.id,
        });
        // The tag lands on the workflow immediately; Apply does not carry it.
        yield* repo.updateWorkflowTag({ workflowId: w.id, tag: tag("b") });
        const applied = yield* repo.applyDraft({
          workflowId: w.id,
          teams: ALL_TEAMS,
        });
        strictEqual(Domain.workflowIsOn(applied), true);
        strictEqual(tagOf(applied), "b");
        const after = yield* found(w.id);
        strictEqual(after.draftTasks, null);
        deepStrictEqual(taskNames(after.tasks), ["Cut", "Finish", "Pack"]);
        strictEqual(
          Number(
            (yield* sql`select count(*) as n from Workflow where draftTasks is not null`)[0]
              ?.n,
          ),
          0,
        );

        // Discard: draft and draft tasks gone, workflow untouched.
        yield* repo.createDraft({ workflowId: w.id });
        yield* repo.addStep({
          workflowId: w.id,
          name: taskName("Ship"),
          teamId: T3.id,
        });
        const discarded = yield* repo.discardDraft({ workflowId: w.id });
        strictEqual(tagOf(discarded), "b");
        strictEqual(Domain.workflowIsOn(discarded), true);
        const back = yield* found(w.id);
        strictEqual(back.draftTasks, null);
        deepStrictEqual(taskNames(back.tasks), ["Cut", "Finish", "Pack"]);
        strictEqual(
          Number(
            (yield* sql`select count(*) as n from Workflow where draftTasks is not null`)[0]
              ?.n,
          ),
          0,
        );
      }),
    ));

  it("apply refuses an empty draft and an unassigned task, on and off alike; an empty team does not refuse; the workflow keeps its tasks", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoTasks(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        const check = Effect.gen(function* () {
          yield* repo.createDraft({ workflowId: w.id });
          const orphan = yield* repo
            .applyDraft({ workflowId: w.id, teams: [T1] })
            .pipe(Effect.flip);
          strictEqual(orphan._tag, "TaskUnassignedError");
          if (orphan._tag === "TaskUnassignedError")
            deepStrictEqual<readonly string[]>(orphan.taskNames, ["Finish"]);
          // A team with nobody on it is a warning, never a refusal.
          const emptyTeams = [T1, { ...T2, memberCount: 0 }];
          yield* repo.applyDraft({ workflowId: w.id, teams: emptyTeams });
          yield* repo.createDraft({ workflowId: w.id });
          const draftTasks = (yield* found(w.id)).draftTasks ?? [];
          for (const task of draftTasks)
            yield* repo.removeTask({ taskId: task.id });
          const empty = yield* repo
            .applyDraft({ workflowId: w.id, teams: ALL_TEAMS })
            .pipe(Effect.flip);
          strictEqual(empty._tag, "NoTasksError");
          deepStrictEqual(taskNames((yield* found(w.id)).tasks), [
            "Cut",
            "Finish",
          ]);
          yield* repo.discardDraft({ workflowId: w.id });
        });
        yield* check;
        yield* repo.setWorkflowOn({
          workflowId: w.id,
          on: true,
          teams: ALL_TEAMS,
        });
        yield* check;
        strictEqual(Domain.workflowIsOn((yield* found(w.id)).workflow), true);
      }),
    ));

  it("turn on refused: zero tasks, unassigned task; the draft is never consulted; an empty team allows", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const on = (workflowId: string, teams = ALL_TEAMS) =>
          repo.setWorkflowOn({ workflowId, on: true, teams });
        const empty = yield* repo.createWorkflow({
          name: name("Empty"),
          tag: tag("empty"),
        });
        strictEqual(
          (yield* on(empty.id).pipe(Effect.flip))._tag,
          "NoTasksError",
        );
        // Draft tasks do not count: only the workflow's own do.
        yield* twoTasks(empty.id);
        strictEqual(
          (yield* on(empty.id).pipe(Effect.flip))._tag,
          "NoTasksError",
        );

        const a = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoTasks(a.id);
        yield* repo.applyDraft({ workflowId: a.id, teams: ALL_TEAMS });
        const orphan = yield* on(a.id, [T1]).pipe(Effect.flip);
        strictEqual(orphan._tag, "TaskUnassignedError");
        if (orphan._tag === "TaskUnassignedError")
          deepStrictEqual<readonly string[]>(orphan.taskNames, ["Finish"]);
        const onA = yield* on(a.id, [T1, { ...T2, memberCount: 0 }]);
        strictEqual(Domain.workflowIsOn(onA), true);
        // A draft on a workflow that is on changes nothing about the switch.
        yield* repo.createDraft({ workflowId: a.id });
        const off = yield* repo.setWorkflowOn({
          workflowId: a.id,
          on: false,
          teams: ALL_TEAMS,
        });
        strictEqual(Domain.workflowIsOn(off), false);
        strictEqual((yield* found(a.id)).draftTasks !== null, true);
        strictEqual(Domain.workflowIsOn(yield* on(a.id)), true);

        // A team delete nulls the pointer; turn on is refused until assigned.
        const lost = yield* repo.createWorkflow({
          name: name("Lost"),
          tag: tag("lost"),
        });
        yield* twoTasks(lost.id);
        yield* repo.applyDraft({ workflowId: lost.id, teams: ALL_TEAMS });
        yield* repo.unassignTeam({ teamId: T2.id });
        const nulled = yield* on(lost.id).pipe(Effect.flip);
        strictEqual(nulled._tag, "TaskUnassignedError");
        if (nulled._tag === "TaskUnassignedError")
          deepStrictEqual<readonly string[]>(nulled.taskNames, ["Finish"]);
        deepStrictEqual(
          (yield* found(lost.id)).tasks.map((s) => s.teamId),
          [T1.id, null],
        );
      }),
    ));

  it("turn on writes state on; off writes off; Apply never touches it", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const pack = (yield* repo.createWorkflow({
          name: name("Pack"),
          tag: tag("pack"),
        })).id;
        yield* twoTasks(pack);
        yield* repo.applyDraft({ workflowId: pack, teams: ALL_TEAMS });
        const on = yield* repo.setWorkflowOn({
          workflowId: pack,
          on: true,
          teams: ALL_TEAMS,
        });
        strictEqual(on.state, "on");
        yield* repo.addStep({
          workflowId: pack,
          name: taskName("Ship"),
          teamId: T3.id,
        });
        const applied = yield* repo.applyDraft({
          workflowId: pack,
          teams: ALL_TEAMS,
        });
        strictEqual(applied.state, "on");
        const off = yield* repo.setWorkflowOn({
          workflowId: pack,
          on: false,
          teams: ALL_TEAMS,
        });
        strictEqual(off.state, "off");
      }),
    ));

  it("unassignTeam nulls the team on both sides", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const w = yield* repo.createWorkflow({
          name: name("A"),
          tag: tag("a"),
        });
        yield* twoTasks(w.id);
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        yield* repo.createDraft({ workflowId: w.id });
        // One workflow, not one per side: the team is on both.
        deepStrictEqual(
          (yield* repo.listTeamWorkflows({
            teamId: T1.id,
            after: null,
            limit: 10,
          })).workflows.map((o) => o.workflowId),
          [w.id],
        );
        yield* repo.unassignTeam({ teamId: T1.id });
        const after = yield* found(w.id);
        deepStrictEqual(
          after.tasks.map((s) => s.teamId),
          [null, T2.id],
        );
        deepStrictEqual(
          after.draftTasks?.map((s) => s.teamId),
          [null, T2.id],
        );
        deepStrictEqual(
          yield* repo.listTeamWorkflows({
            teamId: T1.id,
            after: null,
            limit: 10,
          }),
          { workflows: [], nextCursor: null },
        );
        // Idempotent: nothing left to null.
        yield* repo.unassignTeam({ teamId: T1.id });
        const [row] = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        strictEqual(row?.unassigned, true);
        // Assigning a team on the draft, then applying, clears unassigned with
        // no other write.
        const [lost] = after.draftTasks ?? [];
        yield* repo.updateTask({
          taskId: lost?.id ?? "",
          name: taskName("Cut"),
          teamId: T3.id,
          instructions: null,
        });
        yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
        strictEqual(
          (yield* listAll(repo, {
            teams: ALL_TEAMS,
          }))[0]?.unassigned,
          false,
        );
        // An empty team is the other badge, emptyTeam, derived the same way.
        const [emptied] = yield* listAll(repo, {
          teams: [T1, T2, { ...T3, memberCount: 0 }],
        });
        deepStrictEqual(
          [emptied?.unassigned, emptied?.emptyTeam],
          [false, true],
        );
      }),
    ));

  it("seed: on defaults, explicit off, pending draft, empty tasks with no draft, unassigned, duplicate tag refused", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const task = (n: string, teamId: Domain.TeamId) => ({
          name: taskName(n),
          teamId,
        });
        yield* repo.replaceWorkflows({
          workflows: [
            { name: name("On"), tag: tag("on"), tasks: [task("a", T1.id)] },
            {
              name: name("Off"),
              on: false,
              tag: tag("off"),
              tasks: [task("a", T1.id)],
            },
            {
              name: name("Pending"),
              tag: tag("p"),
              tasks: [task("a", T1.id)],
              draft: { tasks: [task("a", T1.id), task("b", T2.id)] },
            },
            {
              name: name("Second draft"),
              tag: tag("s"),
              tasks: [task("a", T1.id)],
              draft: { tasks: [task("a", T2.id)] },
            },
            { name: name("Empty"), tag: tag("e"), tasks: [] },
            {
              name: name("Lost"),
              tag: tag("g"),
              tasks: [{ name: taskName("a"), teamId: null }],
            },
          ],
        });
        const rows = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        deepStrictEqual<readonly (readonly unknown[])[]>(
          rows.map((w) => [
            w.name,
            Domain.workflowIsOn(w),
            w.stepCount,
            w.unassigned,
            tagOf(w),
          ]),
          [
            ["Empty", false, 0, false, "e"],
            ["Lost", false, 1, true, "g"],
            ["Off", false, 1, false, "off"],
            ["On", true, 1, false, "on"],
            ["Pending", true, 1, false, "p"],
            ["Second draft", true, 1, false, "s"],
          ],
        );
        const pending = rows.find((w) => w.name === "Pending");
        const pendingDetail = yield* found(pending?.id ?? "");
        deepStrictEqual(taskNames(pendingDetail.tasks), ["a"]);
        deepStrictEqual(taskNames(pendingDetail.draftTasks ?? []), ["a", "b"]);
        const empty = rows.find((w) => w.name === "Empty");
        const emptyDetail = yield* found(empty?.id ?? "");
        deepStrictEqual(emptyDetail.tasks, []);
        strictEqual(emptyDetail.draftTasks, null);
        deepStrictEqual(
          (yield* onWorkflows).map(({ workflow }) => workflow.name).toSorted(),
          ["On", "Pending", "Second draft"],
        );
        // A fixture that is on with no tasks is refused.
        strictEqual(
          (yield* repo
            .replaceWorkflows({
              workflows: [
                { name: name("Bad"), on: true, tag: tag("bad"), tasks: [] },
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
                { name: name("One"), tag: tag("shared"), tasks: [] },
                { name: name("Two"), tag: tag("shared"), tasks: [] },
              ],
            })
            .pipe(Effect.flip))._tag,
          "WorkflowRepositoryError",
        );
      }),
    ));
});
