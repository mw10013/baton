import { describe, it } from "@effect/vitest";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ORDERS_KEY } from "../../../../src/contract/shop-actor.ts";
import { ShopKey } from "../../../../src/domain/platform.ts";
import { MembershipRepository } from "../../../../src/backend/membership-repository.ts";
import { syncTransaction } from "../../../../src/backend/shop-actor/transaction.ts";
import {
  makeWorkflowRepository,
  type WorkflowRepository,
} from "../../../../src/backend/shop-actor/workflow-repository.ts";
import { makeWorkflows } from "../../../../src/backend/shop-actor/workflows.ts";
import * as ShopWork from "../../../../src/domain/shop-work.ts";
import { ActorSqliteTest, makeD1Test, QuietLogs, seedD1 } from "../layers.ts";

/**
 * The workflows application service over the actor's repository on a fresh in-memory SQLite,
 * the real `MembershipRepository` on a fresh in-memory D1 holding {@link shop}, and a recording
 * reconcile seam and `notify`: legacy `shop-agent-workflows.test.ts`'s result-mapping cases,
 * titles unchanged (their run halves wait for runs), and the reconcile and notice sites.
 */
const shop = Schema.decodeUnknownSync(ShopKey)("workflows.myshopify.com");

const harness = <A, E>(
  body: (context: {
    readonly workflows: ReturnType<typeof makeWorkflows<never>>;
    readonly repository: WorkflowRepository;
    readonly membership: MembershipRepository["Service"];
    readonly reconciled: Array<readonly [string, string]>;
    readonly notices: Array<ReadonlyArray<string>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const { db, raw } = yield* makeD1Test;
    seedD1(db, { shops: [shop] });
    const membership = yield* MembershipRepository.pipe(
      Effect.provide(MembershipRepository.layerWith(raw)),
    );
    const sql = yield* SqlClient.SqlClient;
    const repository = makeWorkflowRepository(sql, syncTransaction(sql));
    const reconciled: Array<readonly [string, string]> = [];
    const notices: Array<ReadonlyArray<string>> = [];
    const workflows = makeWorkflows({
      repository,
      membershipRepository: membership,
      reconcileAll: (caller, id) =>
        Effect.sync(() => {
          reconciled.push([caller, id]);
        }),
      notify: (invalidated) =>
        Effect.sync(() => {
          notices.push(invalidated);
        }),
      shop,
    });
    return yield* body({ workflows, repository, membership, reconciled, notices });
  }).pipe(Effect.provide(ActorSqliteTest), Effect.provide(QuietLogs));

const teamName = Schema.decodeUnknownSync(ShopWork.TeamName);
const create = Schema.decodeUnknownSync(ShopWork.CreateWorkflowInput);
const addStep = Schema.decodeUnknownSync(ShopWork.AddStepInput);
const addTask = Schema.decodeUnknownSync(ShopWork.AddTaskInput);
const taskId = Schema.decodeUnknownSync(ShopWork.TaskIdInput);
const workflowId = Schema.decodeUnknownSync(ShopWork.WorkflowIdInput);
const setState = Schema.decodeUnknownSync(ShopWork.SetWorkflowStateInput);
const retag = Schema.decodeUnknownSync(ShopWork.UpdateWorkflowTagInput);

/** Creates a workflow, failing the test on any answer but `Ok`. */
const created = (workflows: ReturnType<typeof makeWorkflows<never>>, name: string, tag: string) =>
  Effect.flatMap(workflows.createWorkflow(create({ name, tag })), (result) =>
    result._tag === "Ok" ? Effect.succeed(result.workflow) : Effect.die(new Error(result._tag)),
  );

describe("Workflows", () => {
  it.effect("addTask and separateTask map missing step / task / team to results", () =>
    harness(({ workflows, membership }) =>
      Effect.gen(function* () {
        const team = yield* membership.createTeam({ shop, name: teamName("T") });
        const workflow = yield* created(workflows, "W", "w");
        const id = workflow.id;
        const first = yield* workflows.addStep(
          addStep({
            workflowId: id,
            name: "A",
            teamId: team.id,
            instructions: "  Do it carefully  ",
          }),
        );
        if (first._tag !== "Ok" || first.task === null) throw new Error(first._tag);
        strictEqual(first.task.instructions, "Do it carefully");
        strictEqual(first.task.step, 1);

        const missingStep = yield* workflows.addTask(
          addTask({ workflowId: id, step: 9, name: "B", teamId: team.id }),
        );
        strictEqual(missingStep._tag, "NotFound");
        const inactive = yield* workflows.addTask(
          addTask({ workflowId: id, step: 1, name: "B", teamId: "nope" }),
        );
        strictEqual(inactive._tag, "TeamNotFound");
        const parallel = yield* workflows.addTask(
          addTask({ workflowId: id, step: 1, name: "B", teamId: team.id }),
        );
        if (parallel._tag !== "Ok" || parallel.task === null) throw new Error(parallel._tag);
        strictEqual(parallel.task.step, 1);
        strictEqual(parallel.task.position, 2);

        const separateMissing = yield* workflows.separateTask(taskId({ taskId: "nope" }));
        strictEqual(separateMissing._tag, "NotFound");
        const separated = yield* workflows.separateTask(taskId({ taskId: parallel.task.id }));
        strictEqual(separated._tag, "Ok");
        const detail = yield* workflows.getWorkflowDetail(workflowId({ workflowId: id }));
        deepStrictEqual<unknown>(
          detail?.draftTasks?.map((s) => [s.name, s.step]),
          [
            ["A", 1],
            ["B", 2],
          ],
        );

        const joinMissing = yield* workflows.joinTask(taskId({ taskId: "nope" }));
        strictEqual(joinMissing._tag, "NotFound");
        const joined = yield* workflows.joinTask(taskId({ taskId: parallel.task.id }));
        strictEqual(joined._tag, "Ok");
        const rejoined = yield* workflows.getWorkflowDetail(workflowId({ workflowId: id }));
        deepStrictEqual<unknown>(
          rejoined?.draftTasks?.map((s) => [s.name, s.step]),
          [
            ["A", 1],
            ["B", 1],
          ],
        );
      }),
    ),
  );

  it.effect(
    "createDraft / applyDraft / discardDraft / setWorkflowState / updateWorkflowTag map failures to results",
    () =>
      harness(({ workflows, repository, membership }) =>
        Effect.gen(function* () {
          const team = yield* membership.createTeam({ shop, name: teamName("T") });
          const workflow = yield* created(workflows, "W", "a");
          const id = workflowId({ workflowId: workflow.id });

          // Fresh: no draft yet, so Apply has nothing; turn-on has no tasks.
          deepStrictEqual<unknown>(yield* workflows.applyDraft(id), { _tag: "NoDraft" });
          deepStrictEqual<unknown>(
            yield* workflows.setWorkflowState(setState({ ...id, state: "active" })),
            {
              _tag: "NoTasks",
            },
          );
          // `createDraft` has no procedure; the repository makes the draft here.
          yield* repository.createDraft(id);
          deepStrictEqual<unknown>(yield* workflows.applyDraft(id), { _tag: "NoTasks" });
          deepStrictEqual<unknown>(
            yield* workflows.applyDraft(workflowId({ workflowId: "nope" })),
            {
              _tag: "NotFound",
            },
          );
          // Discard is always allowed: a never-applied workflow keeps zero tasks.
          const discardedEmpty = yield* workflows.discardDraft(id);
          strictEqual(discardedEmpty._tag, "Ok");
          // No draft: the task write makes one rather than refusing.
          const lazy = yield* workflows.addStep(addStep({ ...id, name: "S", teamId: team.id }));
          strictEqual(lazy._tag, "Ok");
          const lazyDetail = yield* workflows.getWorkflowDetail(id);
          strictEqual(lazyDetail?.draftTasks?.length, 1);

          // Immediate: the tag is on the workflow before Apply, and no draft of
          // its own is involved.
          const tagged = yield* workflows.updateWorkflowTag(retag({ ...id, tag: "B" }));
          strictEqual(tagged._tag, "Ok");
          if (tagged._tag === "Ok") strictEqual(tagged.workflow.tag, "B");
          const applied = yield* workflows.applyDraft(id);
          if (applied._tag !== "Ok") throw new Error(applied._tag);
          strictEqual(applied.workflow.tag, "B");
          const detail = yield* workflows.getWorkflowDetail(id);
          strictEqual(detail?.workflow.tag, "B");
          deepStrictEqual<unknown>(
            detail?.tasks.map((s) => [s.name, s.teamName]),
            [["S", "T"]],
          );
          strictEqual(detail?.draftTasks, null);
          deepStrictEqual<unknown>(yield* workflows.applyDraft(id), { _tag: "NoDraft" });
          deepStrictEqual<unknown>(yield* workflows.discardDraft(id), { _tag: "NoDraft" });

          const on = yield* workflows.setWorkflowState(setState({ ...id, state: "active" }));
          strictEqual(on._tag, "Ok");

          // Edit then discard: the tasks go back, and the tag was never in the
          // draft to begin with.
          yield* repository.createDraft(id);
          yield* workflows.updateWorkflowTag(retag({ ...id, tag: "c" }));
          const edited = yield* workflows.getWorkflowDetail(id);
          deepStrictEqual<unknown>(
            edited?.draftTasks?.map((s) => s.name),
            ["S"],
          );
          strictEqual(edited?.workflow.tag, "c");
          const discarded = yield* workflows.discardDraft(id);
          strictEqual(discarded._tag, "Ok");
          const afterDiscard = yield* workflows.getWorkflowDetail(id);
          strictEqual(afterDiscard?.draftTasks, null);
          strictEqual(afterDiscard?.workflow.tag, "c");

          // Team deleted under the workflow's task (the D1 delete, then the pointer half
          // `Membership.deleteTeam` runs): turn-on names the task.
          yield* workflows.setWorkflowState(setState({ ...id, state: "inactive" }));
          yield* membership.deleteTeam({ shop, id: team.id });
          yield* repository.unassignTeam({ teamId: team.id });
          deepStrictEqual<unknown>(
            yield* workflows.setWorkflowState(setState({ ...id, state: "active" })),
            {
              _tag: "TaskUnassigned",
              taskNames: ["S"],
            },
          );
          deepStrictEqual<unknown>(
            yield* workflows.updateWorkflowTag(retag({ workflowId: "nope", tag: "x" })),
            { _tag: "NotFound" },
          );
        }),
      ),
  );

  it.effect(
    "reconcile runs where legacy reconciles: Apply and Edit tag only when active; the switch, Turn on and delete always; nothing else",
    () =>
      harness(({ workflows, membership, reconciled }) =>
        Effect.gen(function* () {
          const team = yield* membership.createTeam({ shop, name: teamName("T") });
          const workflow = yield* created(workflows, "W", "w");
          const id = workflowId({ workflowId: workflow.id });
          yield* workflows.addStep(addStep({ ...id, name: "S", teamId: team.id }));
          yield* workflows.updateWorkflowTag(retag({ ...id, tag: "inactive-tag" }));
          yield* workflows.applyDraft(id);
          deepStrictEqual<unknown>(reconciled, []);

          yield* workflows.setWorkflowState(setState({ ...id, state: "active" }));
          yield* workflows.updateWorkflowTag(retag({ ...id, tag: "active-tag" }));
          yield* workflows.addStep(addStep({ ...id, name: "T", teamId: team.id }));
          yield* workflows.applyDraft(id);
          yield* workflows.setWorkflowState(setState({ ...id, state: "inactive" }));
          yield* workflows.applyAndTurnOn(id);
          yield* workflows.deleteWorkflow(id);
          deepStrictEqual<unknown>(reconciled, [
            ["setWorkflowState", workflow.id],
            ["updateWorkflowTag", workflow.id],
            ["applyDraft", workflow.id],
            ["setWorkflowState", workflow.id],
            ["applyAndTurnOn", workflow.id],
            ["deleteWorkflow", workflow.id],
          ]);

          // A refusal reconciles nothing.
          yield* workflows.deleteWorkflow(id);
          yield* workflows.setWorkflowState(setState({ ...id, state: "active" }));
          strictEqual(reconciled.length, 6);
        }),
      ),
  );

  it.effect("a workflow write notifies the orders key only when it answers Ok, or Deleted", () =>
    harness(({ workflows, membership, notices }) =>
      Effect.gen(function* () {
        const team = yield* membership.createTeam({ shop, name: teamName("T") });
        const workflow = yield* created(workflows, "W", "w");
        const other = yield* created(workflows, "Other", "other");
        const id = workflowId({ workflowId: workflow.id });
        // Refused: nothing written, nothing notified.
        yield* workflows.applyDraft(id);
        yield* workflows.setWorkflowState(setState({ ...id, state: "active" }));
        yield* workflows.applyAndTurnOn(id);
        yield* workflows.updateWorkflowTag(retag({ ...id, tag: "other" }));
        yield* workflows.deleteWorkflow(workflowId({ workflowId: "nope" }));
        // Writes that change no order page's Workflow select notify nothing either.
        yield* workflows.addStep(addStep({ ...id, name: "S", teamId: team.id }));
        yield* workflows.discardDraft(id);
        yield* workflows.addStep(addStep({ ...id, name: "S", teamId: team.id }));
        deepStrictEqual<unknown>(notices, []);

        yield* workflows.updateWorkflowTag(retag({ ...id, tag: "w2" }));
        yield* workflows.applyDraft(id);
        yield* workflows.setWorkflowState(setState({ ...id, state: "active" }));
        yield* workflows.applyAndTurnOn(id);
        yield* workflows.deleteWorkflow(workflowId({ workflowId: other.id }));
        deepStrictEqual<unknown>(notices, [
          [ORDERS_KEY],
          [ORDERS_KEY],
          [ORDERS_KEY],
          [ORDERS_KEY],
          [ORDERS_KEY],
        ]);
      }),
    ),
  );
});
