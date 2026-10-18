import { describe, it } from "@effect/vitest";
import { assertNone, deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ACTIVE_WORKFLOWS_BY_TAGS,
  makeWorkflowRepository,
  type WorkflowRepository as Repository,
  type WorkflowWithDraftTasks,
} from "../../../../src/backend/shop-actor/workflow-repository.ts";
import { syncTransaction } from "../../../../src/backend/shop-actor/transaction.ts";
import * as Platform from "../../../../src/domain/platform.ts";
import * as ShopWork from "../../../../src/domain/shop-work.ts";
import { ActorSqliteTest } from "../layers.ts";

/**
 * The actor's workflow repository over a fresh in-memory SQLite migrated by the actor's own
 * schema: legacy `workflow-repository.test.ts`'s cases, titles and describe names unchanged, but
 * the `replaceWorkflows` and seed cases (not ported; the fixture's own tests pin what they did)
 * and `copyName` (with the web helper). The cases that arranged rows through `replaceWorkflows`
 * write them with {@link insertWorkflows}.
 */
class WorkflowRepository extends Context.Service<WorkflowRepository, Repository>()(
  "test/WorkflowRepository",
) {}

const WorkflowRepositoryTest = Layer.effect(
  WorkflowRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return makeWorkflowRepository(sql, syncTransaction(sql));
  }),
).pipe(Layer.provideMerge(ActorSqliteTest));

const runInRepository = <A, E>(
  program: Effect.Effect<A, E, WorkflowRepository | SqlClient.SqlClient>,
) => program.pipe(Effect.provide(WorkflowRepositoryTest));

/**
 * `Workflow` rows written straight to SQL, as legacy's `replaceWorkflows` seeded them: a task
 * with no `step` follows the previous one, every task gets a new id, and a workflow is active
 * when it has tasks and every one has a team.
 */
const insertWorkflows = (
  workflows: ReadonlyArray<{
    readonly name: string;
    readonly tag: string;
    readonly tasks: ReadonlyArray<{
      readonly name: string;
      readonly teamId: string | null;
      readonly step?: number;
    }>;
  }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const workflow of workflows) {
      const tasks = workflow.tasks.reduce<
        ReadonlyArray<{
          id: string;
          step: number;
          name: string;
          teamId: string | null;
          instructions: null;
        }>
      >(
        (acc, task, index) => [
          ...acc,
          {
            id: crypto.randomUUID(),
            step: task.step ?? (acc[index - 1]?.step ?? 0) + 1,
            name: task.name,
            teamId: task.teamId,
            instructions: null,
          },
        ],
        [],
      );
      const state =
        tasks.length > 0 && tasks.every((task) => task.teamId !== null) ? "active" : "inactive";
      yield* sql`
        insert into Workflow (id, name, tag, state, updatedAt, tasks)
        values (${crypto.randomUUID()}, ${workflow.name}, ${workflow.tag}, ${state}, 0, ${JSON.stringify(tasks)})
      `;
    }
  });

/** Every workflow, one page large enough for any test here: `listWorkflows` with no search, no filter and no cursor. */
const listAll = (
  repo: WorkflowRepository["Service"],
  {
    teams,
  }: {
    readonly teams: Parameters<WorkflowRepository["Service"]["listWorkflows"]>[0]["teams"];
  },
) =>
  repo
    .listWorkflows({ limit: 100, cursor: null, q: null, state: null, teams })
    .pipe(Effect.map(({ workflows }) => workflows));

const tagOf = (
  workflow: ShopWork.Workflow | ShopWork.WorkflowSummary | null | undefined,
): string | null => workflow?.tag ?? null;

const name = Schema.decodeUnknownSync(ShopWork.WorkflowName);
const taskName = Schema.decodeUnknownSync(ShopWork.TaskName);
const tag = Schema.decodeUnknownSync(ShopWork.WorkflowTag);
const teamId = Schema.decodeUnknownSync(ShopWork.TeamId);

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

describe("WorkflowRepository", () => {
  it.effect(
    "creates, lists with stepCount, takes a case variant of another workflow's name, and deletes",
    () =>
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
          const missing = yield* repo.deleteWorkflow({ workflowId: created.id }).pipe(Effect.flip);
          strictEqual(missing._tag, "WorkflowNotFoundError");
        }),
      ),
  );

  it.effect(
    "updateWorkflow renames; updateWorkflowTag retags the workflow immediately; distinguishes taken from missing",
    () =>
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
            tagOf(yield* repo.updateWorkflowTag({ workflowId: a.id, tag: tag("X") })),
            "X",
          );
          const tagTaken = yield* repo
            .updateWorkflowTag({ workflowId: a.id, tag: tag("b") })
            .pipe(Effect.flip);
          strictEqual(tagTaken._tag, "WorkflowTagTakenError");
          // A rename onto another workflow's name is not a collision.
          strictEqual(
            (yield* repo.updateWorkflow({ workflowId: a.id, name: name("b") })).name,
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
      ),
  );

  it.effect("enforces the workflow limit; a delete makes room", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        yield* Effect.forEach(
          Array.from({ length: Platform.WorkflowLimits.maxWorkflows }, (_, i) => i),
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
    ),
  );

  it.effect("add/move/remove keep positions dense and unique; edges are no-ops", () =>
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
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) => editable(d).map((s) => s.name));
        const steps = () =>
          Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) => editable(d).map((s) => s.step));

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

        const missing = yield* repo.removeTask({ taskId: s1.id }).pipe(Effect.flip);
        strictEqual(missing._tag, "TaskNotFoundError");
      }),
    ),
  );

  it.effect(
    "step is dense from 1 and non-decreasing along position, a step of one task being the linear case",
    () =>
      runInRepository(
        Effect.gen(function* () {
          const repo = yield* WorkflowRepository;
          const w = yield* repo.createWorkflow({
            name: name("A"),
            tag: tag("a"),
          });
          // Every editor write goes through editDraft and lands whole through
          // ShopWork.WorkflowTasks; the decoded list holds the rule after each.
          const holds = () =>
            Effect.map(repo.getWorkflow({ workflowId: w.id }), (d) => {
              const tasks = editable(d);
              strictEqual(ShopWork.layoutIsValid(tasks), true);
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
      ),
  );

  it.effect(
    "steps: join merges, move reorders, separate splits, remove closes, addTask shares; unknown step fails",
    () =>
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
      ),
  );

  it.effect("a workflow's stepCount is the number of steps, not tasks", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        yield* insertWorkflows([
          {
            name: name("Stepped"),
            tag: tag("s"),
            tasks: [
              { name: taskName("a"), teamId: teamId("t1"), step: 1 },
              { name: taskName("b"), teamId: teamId("t2"), step: 1 },
              { name: taskName("c"), teamId: teamId("t3"), step: 2 },
            ],
          },
        ]);
        const [row] = yield* listAll(repo, {
          teams: ALL_TEAMS,
        });
        strictEqual(row?.stepCount, 2);
      }),
    ),
  );

  it.effect("updateTask rewrites name and team; enforces the task limit", () =>
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
          instructions: Schema.decodeUnknownSync(ShopWork.TaskInstructions)("Mind the grain"),
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
          Array.from({ length: Platform.WorkflowLimits.maxTasks - 1 }, (_, i) => i),
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
    ),
  );

  it.effect("deleteWorkflow removes the workflow with its tasks and its draft", () =>
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
        strictEqual(Number((yield* sql`select count(*) as n from Workflow`)[0]?.n), 0);
      }),
    ),
  );
});

describe("WorkflowRepository workflows index", () => {
  it.effect("the workflows index pages by name and a search narrows it", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const names = Array.from(
          { length: 55 },
          (_, index) => `Ring ${String(index).padStart(2, "0")}`,
        );
        yield* insertWorkflows([
          ...names.map((each) => ({
            name: name(each),
            tag: tag(each),
            tasks: [],
          })),
          { name: name("Mug glaze"), tag: tag("mug"), tasks: [] },
        ]);
        const page = (cursor: ShopWork.WorkflowName | null, q: string | null = null) =>
          repo.listWorkflows({
            limit: 50,
            cursor,
            q: q === null ? null : Schema.decodeUnknownSync(ShopWork.ListSearch)(q),
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
        // Every seeded workflow is inactive; a search for them under the Active filter
        // still finds them.
        const underFilter = yield* repo.listWorkflows({
          limit: 50,
          cursor: null,
          q: Schema.decodeUnknownSync(ShopWork.ListSearch)("ring"),
          state: "active",
          teams: ALL_TEAMS,
        });
        strictEqual(underFilter.matches, 55);
        strictEqual(
          (yield* repo.listWorkflows({
            limit: 50,
            cursor: null,
            q: null,
            state: "active",
            teams: ALL_TEAMS,
          })).workflows.length,
          0,
        );
      }),
    ),
  );

  it.effect("the run path finds the order's workflows through the index on the tag", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const sql = yield* SqlClient.SqlClient;
        yield* insertWorkflows(
          Array.from({ length: 200 }, (_, index) => ({
            name: name(`W ${String(index)}`),
            tag: tag(`w${String(index)}`),
            tasks: [{ name: taskName("Task"), teamId: teamId("t1") }],
          })),
        );
        const found = yield* repo.listActiveWorkflowsByTags({
          tags: ["w7", "w70", "none"],
        });
        deepStrictEqual(
          found.map((detail) => detail.workflow.tag),
          ["w7", "w70"],
        );
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `explain query plan ${ACTIVE_WORKFLOWS_BY_TAGS}`,
          [JSON.stringify(["w7"])],
        );
        const details = plan.map((row) => row.detail);
        strictEqual(
          details.some((detail) => detail.startsWith("SEARCH Workflow USING INDEX")),
          true,
          details.join("\n"),
        );
        strictEqual(
          details.some((detail) => /^SCAN Workflow\b/u.test(detail)),
          false,
          details.join("\n"),
        );
      }),
    ),
  );
});

describe("WorkflowRepository duplicate", () => {
  it.effect(
    "copies the tasks and their steps under the given name and tag, lands inactive with no draft",
    () =>
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
          yield* repo.setWorkflowState({
            workflowId: w.id,
            state: "active",
            teams: ALL_TEAMS,
          });

          const copy = yield* repo.duplicateWorkflow({
            workflowId: w.id,
            name: name("Engraved ring copy"),
            tag: tag("Engraved copy"),
          });
          strictEqual(copy.name, "Engraved ring copy");
          strictEqual(ShopWork.workflowIsActive(copy), false);
          strictEqual(tagOf(copy), "Engraved copy");
          const copied = Option.getOrThrow(yield* repo.getWorkflow({ workflowId: copy.id }));
          strictEqual(copied.draftTasks, null);
          const source = Option.getOrThrow(yield* repo.getWorkflow({ workflowId: w.id }));
          deepStrictEqual(
            copied.tasks.map((s) => [s.name, s.step, s.teamId]),
            source.tasks.map((s) => [s.name, s.step, s.teamId]),
          );
          // New rows, not the source's.
          strictEqual(
            copied.tasks.some((s) => source.tasks.some((o) => o.id === s.id)),
            false,
          );
          // The source is untouched and still active.
          strictEqual(ShopWork.workflowIsActive(source.workflow), true);
          strictEqual(tagOf(source.workflow), "engraved");

          // A second duplicate under the first one's name is refused.
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
      ),
  );
});

/**
 * The tag is the workflow's key: unique across the shop, active or inactive, and
 * refused where the merchant typed it. Turn on and Apply never see it.
 */
describe("WorkflowRepository tag uniqueness", () => {
  it.effect(
    "createWorkflow refuses a tag another workflow holds, active or inactive, and names the holder",
    () =>
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
          // Still refused once the holder is active; the rule does not depend on it.
          yield* twoTasks(holder.id);
          yield* repo.applyDraft({ workflowId: holder.id, teams: ALL_TEAMS });
          yield* repo.setWorkflowState({
            workflowId: holder.id,
            state: "active",
            teams: ALL_TEAMS,
          });
          strictEqual(
            (yield* repo
              .createWorkflow({ name: name("Rush"), tag: tag("engraved") })
              .pipe(Effect.flip))._tag,
            "WorkflowTagTakenError",
          );
        }),
      ),
  );

  it.effect("refuses the tag alone: a case variant of the name under a free tag goes through", () =>
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
    ),
  );

  it.effect(
    "Turn on and Apply ignore tags: two active workflows, with different tags, coexist",
    () =>
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
              return yield* repo.setWorkflowState({
                workflowId: w.id,
                state: "active",
                teams: ALL_TEAMS,
              });
            });
          const first = yield* live("Engraving", "engraved");
          const second = yield* live("Rush", "rush");
          strictEqual(ShopWork.workflowIsActive(first), true);
          strictEqual(ShopWork.workflowIsActive(second), true);

          // Apply on an active workflow leaves the tag alone.
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
      ),
  );
});

/**
 * The name is unique in the shop, compared exactly, on every write that takes
 * one: members pick a workflow by name alone. The name is checked before the
 * tag, since the dialogs prefill the tag from the name.
 */
describe("WorkflowRepository name uniqueness", () => {
  it.effect(
    "create, rename and duplicate refuse a name another workflow has; a case variant goes through",
    () =>
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
      ),
  );

  it.effect("checks the name before the tag", () =>
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
    ),
  );
});

/** The editor's Turn on on a never-applied workflow: one call, one transaction. */
describe("WorkflowRepository applyAndTurnOn", () => {
  it.effect(
    "promotes the draft and turns the switch on; refuses an empty workflow and leaves it inactive",
    () =>
      runInRepository(
        Effect.gen(function* () {
          const repo = yield* WorkflowRepository;
          const w = yield* repo.createWorkflow({
            name: name("Engraving"),
            tag: tag("engraved"),
          });

          // Nothing to promote and nothing in force: refused, and still inactive.
          const empty = yield* repo
            .applyAndTurnOn({ workflowId: w.id, teams: ALL_TEAMS })
            .pipe(Effect.flip);
          strictEqual(empty._tag, "NoTasksError");
          strictEqual(
            ShopWork.workflowIsActive(
              yield* found(w.id).pipe(Effect.map((detail) => detail.workflow)),
            ),
            false,
          );

          yield* twoTasks(w.id);
          const on = yield* repo.applyAndTurnOn({
            workflowId: w.id,
            teams: ALL_TEAMS,
          });
          strictEqual(ShopWork.workflowIsActive(on), true);
          const after = yield* found(w.id);
          strictEqual(after.draftTasks, null);
          deepStrictEqual(taskNames(after.tasks), ["Cut", "Finish"]);

          // No draft left: the second call is a plain re-activation.
          const again = yield* repo.applyAndTurnOn({
            workflowId: w.id,
            teams: ALL_TEAMS,
          });
          strictEqual(again.state, "active");
        }),
      ),
  );
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
    WorkflowRepository.pipe(Effect.flatMap((repo) => repo.getWorkflow({ workflowId }))),
    Option.getOrThrow,
  );

/** Every active workflow with its tasks, found by tag the way reconcile finds them. */
const activeWorkflows = Effect.gen(function* () {
  const repo = yield* WorkflowRepository;
  const tags = (yield* listAll(repo, {
    teams: ALL_TEAMS,
  })).map((workflow) => workflow.tag);
  return yield* repo.listActiveWorkflowsByTags({ tags });
});

const taskNames = (tasks: readonly { readonly name: string }[]) => tasks.map((s) => s.name);

describe("WorkflowRepository workflow and draft", () => {
  it.effect(
    "a draft is the draftTasks column: null until the first edit, a copy of the tasks at the first edit, null again after Apply and after Discard",
    () =>
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
      ),
  );

  it.effect(
    "the first editor write on a task the workflow holds creates the draft and edits the same task id",
    () =>
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
          deepStrictEqual(taskNames(after.draftTasks ?? []), ["Cut again", "Finish"]);
          strictEqual(after.draftTasks?.[0]?.id, cut.id);
        }),
      ),
  );

  it.effect("a stored list that violates the step rule is refused on decode", () =>
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
        const refused = yield* repo.getWorkflow({ workflowId: w.id }).pipe(Effect.flip);
        strictEqual(refused._tag, "WorkflowRepositoryError");
      }),
    ),
  );

  it.effect(
    "create → no tasks, its tag, no draft, inactive, not listed for starting; apply refused without a draft or tasks; discard allowed",
    () =>
      runInRepository(
        Effect.gen(function* () {
          const repo = yield* WorkflowRepository;
          const w = yield* repo.createWorkflow({
            name: name("A"),
            tag: tag("a"),
          });
          strictEqual(ShopWork.workflowIsActive(w), false);
          strictEqual(tagOf(w), "a");
          const fresh = yield* found(w.id);
          deepStrictEqual(fresh.tasks, []);
          strictEqual(fresh.draftTasks, null);
          deepStrictEqual(yield* activeWorkflows, []);
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
            .setWorkflowState({
              workflowId: w.id,
              state: "active",
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
          const again = yield* repo.discardDraft({ workflowId: w.id }).pipe(Effect.flip);
          strictEqual(again._tag, "NoDraftError");
        }),
      ),
  );

  it.effect(
    "apply replaces the workflow's tasks with the draft's, carries task ids over, and deletes the draft",
    () =>
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
          strictEqual(ShopWork.workflowIsActive(applied), false);
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
          // Inactive: still invisible to run creation until turned on.
          deepStrictEqual(yield* activeWorkflows, []);
          yield* repo.setWorkflowState({
            workflowId: w.id,
            state: "active",
            teams: ALL_TEAMS,
          });
          const [detail] = yield* activeWorkflows;
          deepStrictEqual(taskNames(detail?.tasks ?? []), ["Cut", "Finish"]);
          strictEqual(tagOf(detail?.workflow), "a");
          // No draft: apply and discard refuse. There is nothing to promote or throw away.
          strictEqual(
            (yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS }).pipe(Effect.flip))._tag,
            "NoDraftError",
          );
          strictEqual(
            (yield* repo.discardDraft({ workflowId: w.id }).pipe(Effect.flip))._tag,
            "NoDraftError",
          );
          // A task write with no draft creates one, as a copy of the workflow.
          yield* repo.addStep({
            workflowId: w.id,
            name: taskName("Pack"),
            teamId: T3.id,
          });
          const lazy = yield* found(w.id);
          deepStrictEqual(taskNames(lazy.draftTasks ?? []), ["Cut", "Finish", "Pack"]);
          // The workflow itself is untouched until Apply.
          deepStrictEqual(taskNames(lazy.tasks), ["Cut", "Finish"]);
          // A tag write lands on the workflow at once and leaves the draft alone.
          yield* repo.updateWorkflowTag({ workflowId: w.id, tag: tag("b") });
          const retagged = yield* found(w.id);
          strictEqual(tagOf(retagged.workflow), "b");
          deepStrictEqual(taskNames(retagged.draftTasks ?? []), ["Cut", "Finish", "Pack"]);
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
          deepStrictEqual(taskNames(started.draftTasks ?? []), ["Cut2", "Finish", "Pack"]);
          deepStrictEqual(taskNames(started.tasks), ["Cut", "Finish"]);
          strictEqual(
            (yield* repo.removeTask({ taskId: "nope" }).pipe(Effect.flip))._tag,
            "TaskNotFoundError",
          );
          assertNone(yield* repo.getTask({ taskId: "nope" }));
        }),
      ),
  );

  it.effect(
    "createDraft copies the workflow's tasks under their own ids and is idempotent; edits never touch the workflow",
    () =>
      runInRepository(
        Effect.gen(function* () {
          const repo = yield* WorkflowRepository;
          const w = yield* repo.createWorkflow({
            name: name("A"),
            tag: tag("a"),
          });
          yield* twoTasks(w.id);
          yield* repo.applyDraft({ workflowId: w.id, teams: ALL_TEAMS });
          yield* repo.setWorkflowState({
            workflowId: w.id,
            state: "active",
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
          const [detail] = yield* activeWorkflows;
          deepStrictEqual(taskNames(detail?.tasks ?? []), ["Cut", "Finish"]);
          const missing = yield* repo.createDraft({ workflowId: "nope" }).pipe(Effect.flip);
          strictEqual(missing._tag, "WorkflowNotFoundError");
        }),
      ),
  );

  it.effect(
    "apply while active replaces the tasks in place and leaves the switch alone; discard deletes the draft and leaves the workflow",
    () =>
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
          yield* repo.setWorkflowState({
            workflowId: w.id,
            state: "active",
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
          strictEqual(ShopWork.workflowIsActive(applied), true);
          strictEqual(tagOf(applied), "b");
          const after = yield* found(w.id);
          strictEqual(after.draftTasks, null);
          deepStrictEqual(taskNames(after.tasks), ["Cut", "Finish", "Pack"]);
          strictEqual(
            Number(
              (yield* sql`select count(*) as n from Workflow where draftTasks is not null`)[0]?.n,
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
          strictEqual(ShopWork.workflowIsActive(discarded), true);
          const back = yield* found(w.id);
          strictEqual(back.draftTasks, null);
          deepStrictEqual(taskNames(back.tasks), ["Cut", "Finish", "Pack"]);
          strictEqual(
            Number(
              (yield* sql`select count(*) as n from Workflow where draftTasks is not null`)[0]?.n,
            ),
            0,
          );
        }),
      ),
  );

  it.effect(
    "apply refuses an empty draft and an unassigned task, active and inactive alike; an empty team does not refuse; the workflow keeps its tasks",
    () =>
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
            for (const task of draftTasks) yield* repo.removeTask({ taskId: task.id });
            const empty = yield* repo
              .applyDraft({ workflowId: w.id, teams: ALL_TEAMS })
              .pipe(Effect.flip);
            strictEqual(empty._tag, "NoTasksError");
            deepStrictEqual(taskNames((yield* found(w.id)).tasks), ["Cut", "Finish"]);
            yield* repo.discardDraft({ workflowId: w.id });
          });
          yield* check;
          yield* repo.setWorkflowState({
            workflowId: w.id,
            state: "active",
            teams: ALL_TEAMS,
          });
          yield* check;
          strictEqual(ShopWork.workflowIsActive((yield* found(w.id)).workflow), true);
        }),
      ),
  );

  it.effect(
    "turn on refused: zero tasks, unassigned task; the draft is never consulted; an empty team allows",
    () =>
      runInRepository(
        Effect.gen(function* () {
          const repo = yield* WorkflowRepository;
          const on = (workflowId: string, teams = ALL_TEAMS) =>
            repo.setWorkflowState({ workflowId, state: "active", teams });
          const empty = yield* repo.createWorkflow({
            name: name("Empty"),
            tag: tag("empty"),
          });
          strictEqual((yield* on(empty.id).pipe(Effect.flip))._tag, "NoTasksError");
          // Draft tasks do not count: only the workflow's own do.
          yield* twoTasks(empty.id);
          strictEqual((yield* on(empty.id).pipe(Effect.flip))._tag, "NoTasksError");

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
          strictEqual(ShopWork.workflowIsActive(onA), true);
          // A draft on an active workflow changes nothing about the switch.
          yield* repo.createDraft({ workflowId: a.id });
          const off = yield* repo.setWorkflowState({
            workflowId: a.id,
            state: "inactive",
            teams: ALL_TEAMS,
          });
          strictEqual(ShopWork.workflowIsActive(off), false);
          strictEqual((yield* found(a.id)).draftTasks !== null, true);
          strictEqual(ShopWork.workflowIsActive(yield* on(a.id)), true);

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
      ),
  );

  it.effect("turn on writes active; turn off writes inactive; Apply never touches it", () =>
    runInRepository(
      Effect.gen(function* () {
        const repo = yield* WorkflowRepository;
        const pack = (yield* repo.createWorkflow({
          name: name("Pack"),
          tag: tag("pack"),
        })).id;
        yield* twoTasks(pack);
        yield* repo.applyDraft({ workflowId: pack, teams: ALL_TEAMS });
        const on = yield* repo.setWorkflowState({
          workflowId: pack,
          state: "active",
          teams: ALL_TEAMS,
        });
        strictEqual(on.state, "active");
        yield* repo.addStep({
          workflowId: pack,
          name: taskName("Ship"),
          teamId: T3.id,
        });
        const applied = yield* repo.applyDraft({
          workflowId: pack,
          teams: ALL_TEAMS,
        });
        strictEqual(applied.state, "active");
        const off = yield* repo.setWorkflowState({
          workflowId: pack,
          state: "inactive",
          teams: ALL_TEAMS,
        });
        strictEqual(off.state, "inactive");
      }),
    ),
  );

  it.effect("unassignTeam nulls the team on both sides", () =>
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
        deepStrictEqual([emptied?.unassigned, emptied?.emptyTeam], [false, true]);
      }),
    ),
  );
});

/** Legacy `data-model.test.ts`'s workflow row, title unchanged: the `unique`s under the repository. */
describe("data model", () => {
  it.effect(
    "a workflow is identified by its tag and by its name; no two workflows share either; the name is compared exactly",
    () =>
      runInRepository(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const insert = (id: string, name: string, tag: string) => sql`
          insert into Workflow (id, name, tag, state, updatedAt)
          values (${id}, ${name}, ${tag}, 'inactive', 0)
        `;
          const count = (table: string) =>
            sql`select count(*) from ${sql(table)}`.values.pipe(
              Effect.map((rows) => Number(rows[0]?.[0] ?? 0)),
            );
          yield* insert("w1", "Mugs", "mug");
          const sameTag = yield* Effect.flip(insert("w2", "Cups", "mug"));
          strictEqual(sameTag._tag, "SqlError");
          const sameName = yield* Effect.flip(insert("w3", "Mugs", "cup"));
          strictEqual(sameName._tag, "SqlError");
          yield* insert("w4", "mugs", "cup");
          // The tag is compared exactly too: `Mug` is another tag than `mug`.
          yield* insert("w5", "Cups", "Mug");
          strictEqual(yield* count("Workflow"), 3);
          strictEqual(Schema.decodeUnknownSync(ShopWork.WorkflowTag)(" Mug "), "Mug");
        }),
      ),
  );
});
