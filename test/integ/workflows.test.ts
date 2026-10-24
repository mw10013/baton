import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import { Rpc, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import { MerchantRpcs, ORDERS_KEY } from "../../src/contract/shop-actor.ts";
import { TeamName } from "../../src/domain/shop-work.ts";
import * as ShopWork from "../../src/domain/shop-work.ts";
import { ShopKey } from "../../src/domain/platform.ts";
import { ShopFixtureData } from "../../src/contract/fixture.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { mintSessionToken } from "../shopify-session-token.ts";
import { addToFixture, editingAt, email, integ, openAs, rawRequestAs } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The merchant's workflow writes end to end on the test stack: each `Merchant…` workflow
 * procedure on a forged merchant socket and the union it answers, the `ORDERS_KEY` notices a
 * second merchant socket receives, and a member refused every one. The run writes and the setup
 * facts are in `runs.test.ts`. Every case writes `SEED_SHOP` under names and tags of its own, but
 * the loader cases, which run in file order on `OTHER_SHOP` (no team, no workflow until they add
 * them). The loaders are reached as the Website's server functions reach them, with a signed
 * merchant token (`ApiWorkflowsPage`, `ApiWorkflowDetail`, `ApiSetupFacts`). The repository's and
 * the application service's rules are unit tests.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("workflows"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const teamName = Schema.decodeUnknownSync(TeamName);
const create = Schema.decodeUnknownSync(ShopWork.CreateWorkflowInput);
const addStep = Schema.decodeUnknownSync(ShopWork.AddStepInput);
const workflowId = Schema.decodeUnknownSync(ShopWork.WorkflowIdInput);
const taskWrite = Schema.decodeUnknownSync(ShopWork.TaskWriteInput);
const setState = Schema.decodeUnknownSync(ShopWork.SetWorkflowStateInput);
const retag = Schema.decodeUnknownSync(ShopWork.UpdateWorkflowTagInput);
const duplicate = Schema.decodeUnknownSync(ShopWork.DuplicateWorkflowInput);
const rename = Schema.decodeUnknownSync(ShopWork.UpdateWorkflowInput);
const updateTask = Schema.decodeUnknownSync(ShopWork.UpdateTaskInput);
const moveTask = Schema.decodeUnknownSync(ShopWork.MoveTaskInput);
const addTask = Schema.decodeUnknownSync(ShopWork.AddTaskInput);

/**
 * A merchant's socket to `SEED_SHOP`, forged past the gate, open in the caller's scope. An HTTP
 * call goes first: the file's first socket to a cold workerd otherwise outlasts the socket's open
 * timeout under the full suite's load.
 */
const merchant = (backendUrl: string) =>
  integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP })).pipe(
    Effect.andThen(openAs(backendUrl, SEED_SHOP, { role: "merchant" })),
  );

type Client = Effect.Success<ReturnType<typeof merchant>>["client"];

/** Creates a workflow, failing the test on any answer but `Ok`. */
const created = (client: Client, name: string, tag: string) =>
  Effect.flatMap(client.MerchantCreateWorkflow(create({ name, tag })), (result) =>
    result._tag === "Ok" ? Effect.succeed(result.workflow) : Effect.die(new Error(result._tag)),
  );

/** A team of the shop, created through the merchant's own procedure. */
const team = (client: Client, name: string) => client.MerchantCreateTeam({ name: teamName(name) });

/** Apply the draft and turn the workflow on, the two writes a fresh workflow needs before it starts. */
const goLive = (client: Client, backendUrl: string, id: string) =>
  Effect.gen(function* () {
    const applied = yield* client.MerchantApplyDraft(yield* editing(backendUrl, id));
    assert.strictEqual(applied._tag, "Ok");
    const on = yield* client.MerchantSetWorkflowState(
      setState({ workflowId: id, state: "active" }),
    );
    assert.strictEqual(on._tag, "Ok");
  });

/** `BackendApi.workflowDetail` for `workflowId` on `shop`, with a signed merchant token. */
const detail = (backendUrl: string, workflowId: string, shop: ShopKey = SEED_SHOP) =>
  Effect.gen(function* () {
    const sessionToken = yield* mintSessionToken({ shop });
    return yield* integ(backendUrl, (c) => c.ApiWorkflowDetail({ sessionToken, workflowId }));
  });

/** {@link editingAt} on `SEED_SHOP`. */
const editing = (backendUrl: string, workflowId: string) =>
  editingAt(backendUrl, SEED_SHOP, workflowId);

/** `count` notices on `received`, each naming `ORDERS_KEY`, and no more queued. */
const noticed = (
  received: Effect.Success<ReturnType<typeof merchant>>["received"],
  count: number,
) =>
  Effect.gen(function* () {
    for (let n = 0; n < count; n += 1) {
      const notice = yield* PubSub.take(received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual<unknown>(notice.invalidated, [ORDERS_KEY]);
    }
  });

test(
  "addStep refuses an unknown team, accepts an existing one",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const engraving = yield* team(client, "Engraving wf-team-check");
      const workflow = yield* created(client, "Engrave wf-team-check", "Engraving wf-team-check");
      const unknown = yield* client.MerchantAddStep(
        addStep({ ...(yield* editing(backendUrl, workflow.id)), name: "Engrave", teamId: "nope" }),
      );
      assert.strictEqual(unknown._tag, "TeamNotFound");
      const fresh = yield* detail(backendUrl, workflow.id);
      assert.strictEqual(fresh?.draftTasks, null);
      assert.deepStrictEqual<unknown>(fresh?.tasks, []);
      assert.strictEqual(fresh?.workflow.tag, "Engraving wf-team-check");
      const ok = yield* client.MerchantAddStep(
        addStep({
          ...(yield* editing(backendUrl, workflow.id)),
          name: "Engrave",
          teamId: engraving.id,
        }),
      );
      assert.strictEqual(ok._tag, "Ok");
      const after = yield* detail(backendUrl, workflow.id);
      assert.deepStrictEqual<unknown>(
        after?.draftTasks?.map((s) => [s.teamName, s.memberCount]),
        [["Engraving wf-team-check", 0]],
      );
      assert.deepStrictEqual<unknown>(
        after?.teams.filter((t) => t.id === engraving.id).map((t) => t.memberCount),
        [0],
      );
    }).pipe(Effect.scoped);
  }),
);

test(
  "applyAndTurnOn promotes the draft and turns the switch on in one call; an empty workflow is refused",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const t = yield* team(client, "T wf-apply-activate");
      const workflow = yield* created(client, "W wf-apply-activate", "w-apply-activate");
      const at = () => editing(backendUrl, workflow.id);
      // Nothing to promote and nothing in force.
      const empty = yield* client.MerchantApplyAndTurnOn(yield* at());
      assert.strictEqual(empty._tag, "NoTasks");
      const task = yield* client.MerchantAddStep(
        addStep({ ...(yield* at()), name: "S", teamId: t.id }),
      );
      assert.strictEqual(task._tag, "Ok");
      const result = yield* client.MerchantApplyAndTurnOn(yield* at());
      if (result._tag !== "Ok") return assert.fail(result._tag);
      assert.strictEqual(ShopWork.workflowIsActive(result.workflow), true);
      // The draft was promoted: no draft is left to apply.
      assert.deepStrictEqual<unknown>(yield* client.MerchantApplyDraft(yield* at()), {
        _tag: "NoDraft",
      });
    }).pipe(Effect.scoped);
  }),
);

test(
  "a task whose team was deleted resolves teamName null; removeWorkflow takes the definition and its draft",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const t = yield* team(client, "T wf-removed");
      const workflow = yield* created(client, "W wf-removed", "w-removed");
      const id = workflowId({ workflowId: workflow.id });
      const at = () => editing(backendUrl, workflow.id);
      const task = yield* client.MerchantAddStep(
        addStep({ ...(yield* at()), name: "S", teamId: t.id }),
      );
      if (task._tag !== "Ok" || task.task === null) return assert.fail(task._tag);
      yield* client.MerchantDeleteTeam({ teamId: t.id });
      const unassigned = yield* detail(backendUrl, workflow.id);
      assert.strictEqual(unassigned?.draftTasks?.[0]?.teamName, null);
      assert.isFalse(unassigned?.teams.some((each) => each.id === t.id));
      // The draft's task lost its team: Turn on names it.
      assert.deepStrictEqual<unknown>(yield* client.MerchantApplyAndTurnOn(yield* at()), {
        _tag: "TaskUnassigned",
        taskNames: ["S"],
      });

      // Names compare exactly: a case variant under a free tag is a second workflow.
      const twin = yield* client.MerchantCreateWorkflow(
        create({ name: "w wf-removed", tag: "dupe-removed" }),
      );
      assert.strictEqual(twin._tag, "Ok");
      // The name itself is refused under its own field.
      assert.deepStrictEqual<unknown>(
        yield* client.MerchantCreateWorkflow(create({ name: "w wf-removed", tag: "free-removed" })),
        { _tag: "NameTaken", name: "w wf-removed" },
      );
      // So is the tag.
      const dupeTag = yield* client.MerchantCreateWorkflow(
        create({ name: "Other wf-removed", tag: " w-removed " }),
      );
      assert.strictEqual(dupeTag._tag, "TagTaken");

      assert.deepStrictEqual<unknown>(yield* client.MerchantDeleteWorkflow(id), {
        _tag: "Deleted",
      });
      assert.deepStrictEqual<unknown>(yield* client.MerchantDeleteWorkflow(id), {
        _tag: "NotFound",
      });
      const removeMissing = yield* client.MerchantRemoveTask(
        taskWrite({ taskId: task.task.id, tasksRevision: (yield* at()).tasksRevision }),
      );
      assert.strictEqual(removeMissing._tag, "NotFound");
      // Its name and tag are free at once.
      const recreated = yield* client.MerchantCreateWorkflow(
        create({ name: "W wf-removed", tag: "w-removed" }),
      );
      assert.strictEqual(recreated._tag, "Ok");
    }).pipe(Effect.scoped);
  }),
);

test(
  "createWorkflow and updateWorkflowTag refuse a tag another workflow holds; the switch never does",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const engraving = yield* team(client, "Engraving wf-tagtaken");
      const build = (name: string, tag: string) =>
        Effect.gen(function* () {
          const workflow = yield* created(client, name, tag);
          yield* client.MerchantAddStep(
            addStep({
              ...(yield* editing(backendUrl, workflow.id)),
              name: "Do it",
              teamId: engraving.id,
            }),
          );
          return workflow;
        });
      const holder = yield* build("Engraving wf-tagtaken", "engraved-tagtaken");
      yield* goLive(client, backendUrl, holder.id);
      const other = yield* build("Rush wf-tagtaken", "rush-tagtaken");
      yield* goLive(client, backendUrl, other.id);

      const taken = {
        _tag: "TagTaken",
        tag: "engraved-tagtaken",
        workflowName: "Engraving wf-tagtaken",
      };
      // Create: refused under the tag field, naming the holder.
      assert.deepStrictEqual<unknown>(
        yield* client.MerchantCreateWorkflow(
          create({ name: "Third wf-tagtaken", tag: " engraved-tagtaken " }),
        ),
        taken,
      );
      // Edit tag: the same refusal on an existing workflow.
      assert.deepStrictEqual<unknown>(
        yield* client.MerchantUpdateWorkflowTag(
          retag({ workflowId: other.id, tag: "engraved-tagtaken" }),
        ),
        taken,
      );
      // Duplicate: the new workflow's own tag.
      assert.deepStrictEqual<unknown>(
        yield* client.MerchantDuplicateWorkflow(
          duplicate({
            workflowId: other.id,
            name: "Rush copy wf-tagtaken",
            tag: "engraved-tagtaken",
          }),
        ),
        taken,
      );

      // The switch and Apply say nothing about tags: both are still on.
      const off = yield* client.MerchantSetWorkflowState(
        setState({ workflowId: other.id, state: "inactive" }),
      );
      assert.strictEqual(off._tag, "Ok");
      const backOn = yield* client.MerchantSetWorkflowState(
        setState({ workflowId: other.id, state: "active" }),
      );
      assert.strictEqual(backOn._tag, "Ok");
      yield* client.MerchantAddStep(
        addStep({ ...(yield* editing(backendUrl, other.id)), name: "Pack", teamId: engraving.id }),
      );
      const applied = yield* client.MerchantApplyDraft(yield* editing(backendUrl, other.id));
      if (applied._tag !== "Ok") return assert.fail(applied._tag);
      assert.strictEqual(applied.workflow.tag, "rush-tagtaken");
    }).pipe(Effect.scoped);
  }),
);

test(
  "the editor's task writes answer Ok on the draft, NotFound for a task or step no draft holds",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const t = yield* team(client, "T wf-task-writes");
      const workflow = yield* created(client, "W wf-task-writes", "w-task-writes");
      const id = workflowId({ workflowId: workflow.id });
      const at = () => editing(backendUrl, workflow.id);
      /** A task write's input as the editor sends it, at the workflow's current revision. */
      const onTask = (taskId: string) =>
        at().pipe(Effect.map(({ tasksRevision }) => taskWrite({ taskId, tasksRevision })));
      const a = yield* client.MerchantAddStep(
        addStep({ ...(yield* at()), name: "A", teamId: t.id }),
      );
      if (a._tag !== "Ok" || a.task === null) return assert.fail(a._tag);
      const b = yield* client.MerchantAddTask(
        addTask({ ...(yield* at()), step: 1, name: "B", teamId: t.id }),
      );
      if (b._tag !== "Ok" || b.task === null) return assert.fail(b._tag);
      assert.strictEqual(
        (yield* client.MerchantAddTask(
          addTask({ ...(yield* at()), step: 9, name: "C", teamId: t.id }),
        ))._tag,
        "NotFound",
      );
      const updated = yield* client.MerchantUpdateTask(
        updateTask({ ...(yield* onTask(a.task.id)), name: "A2", teamId: t.id, instructions: null }),
      );
      if (updated._tag !== "Ok" || updated.task === null) return assert.fail(updated._tag);
      assert.strictEqual(updated.task.name, "A2");
      assert.strictEqual(
        (yield* client.MerchantMoveTask(
          moveTask({ ...(yield* onTask(b.task.id)), direction: "up" }),
        ))._tag,
        "Ok",
      );
      assert.strictEqual((yield* client.MerchantSeparateTask(yield* onTask(a.task.id)))._tag, "Ok");
      assert.strictEqual((yield* client.MerchantJoinTask(yield* onTask(a.task.id)))._tag, "Ok");
      assert.strictEqual((yield* client.MerchantRemoveTask(yield* onTask(b.task.id)))._tag, "Ok");
      assert.strictEqual(
        (yield* client.MerchantRemoveTask(yield* onTask(b.task.id)))._tag,
        "NotFound",
      );
      const renamed = yield* client.MerchantUpdateWorkflow(
        rename({ ...id, name: "W2 wf-task-writes" }),
      );
      if (renamed._tag !== "Ok") return assert.fail(renamed._tag);
      assert.strictEqual(renamed.workflow.name, "W2 wf-task-writes");
      const discarded = yield* client.MerchantDiscardDraft(yield* at());
      assert.strictEqual(discarded._tag, "Ok");
      assert.deepStrictEqual<unknown>(yield* client.MerchantDiscardDraft(yield* at()), {
        _tag: "NoDraft",
      });
      const copy = yield* client.MerchantDuplicateWorkflow(
        duplicate({ ...id, name: "W2 copy wf-task-writes", tag: "w-task-writes-copy" }),
      );
      if (copy._tag !== "Ok") return assert.fail(copy._tag);
      assert.strictEqual(ShopWork.workflowIsActive(copy.workflow), false);
    }).pipe(Effect.scoped);
  }),
);

test(
  "a write sent at a revision another tab moved past answers Changed and writes nothing",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const t = yield* team(client, "T wf-stale-tab");
      const workflow = yield* created(client, "W wf-stale-tab", "w-stale-tab");
      yield* client.MerchantAddStep(
        addStep({ ...(yield* editing(backendUrl, workflow.id)), name: "S", teamId: t.id }),
      );
      // Both tabs read the draft; tab B discards it.
      const read = yield* editing(backendUrl, workflow.id);
      assert.strictEqual((yield* client.MerchantDiscardDraft(read))._tag, "Ok");
      // Tab A, still showing the draft, presses Apply, then Add step.
      assert.deepStrictEqual<unknown>(yield* client.MerchantApplyDraft(read), { _tag: "Changed" });
      assert.deepStrictEqual<unknown>(
        yield* client.MerchantAddStep(addStep({ ...read, name: "T", teamId: t.id })),
        { _tag: "Changed" },
      );
      const after = yield* detail(backendUrl, workflow.id);
      assert.strictEqual(after?.draftTasks, null, "no draft was started under the refused write");
    }).pipe(Effect.scoped);
  }),
);

test(
  "Edit tag and Apply publish to every screen whether or not a run moved",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const t = yield* team(client, "T sites-edit-tag-apply");
      const workflow = yield* created(client, "W sites-edit-tag-apply", "sites-edit-tag-apply");
      const id = workflowId({ workflowId: workflow.id });
      yield* client.MerchantAddStep(
        addStep({ ...(yield* editing(backendUrl, workflow.id)), name: "S", teamId: t.id }),
      );
      yield* goLive(client, backendUrl, workflow.id);
      const screen = yield* merchant(backendUrl);
      yield* screen.client.MerchantWhoAmI();

      // Neither write moves a run: no runs exist yet, and the draft is applied unchanged.
      yield* client.MerchantUpdateWorkflowTag(retag({ ...id, tag: "sites-edit-tag-apply-2" }));
      yield* noticed(screen.received, 1);
      // A task write starts the draft; there is no createDraft procedure.
      yield* client.MerchantAddStep(
        addStep({ ...(yield* editing(backendUrl, workflow.id)), name: "T", teamId: t.id }),
      );
      const applied = yield* client.MerchantApplyDraft(yield* editing(backendUrl, workflow.id));
      assert.strictEqual(applied._tag, "Ok");
      yield* noticed(screen.received, 1);
      assert.strictEqual(yield* PubSub.remaining(screen.received), 0, "no more notices");
    }).pipe(Effect.scoped);
  }),
);

test(
  "turning a workflow on or off, deleting it, or deleting a team publishes to every screen",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const working = yield* team(client, "Working sites-configuration");
      const idle = yield* team(client, "Idle sites-configuration");
      const workflow = yield* created(client, "W sites-configuration", "sites-configuration");
      const id = workflowId({ workflowId: workflow.id });
      yield* client.MerchantAddStep(
        addStep({ ...(yield* editing(backendUrl, workflow.id)), name: "S", teamId: working.id }),
      );
      yield* goLive(client, backendUrl, workflow.id);
      const screen = yield* merchant(backendUrl);
      yield* screen.client.MerchantWhoAmI();

      yield* client.MerchantSetWorkflowState(setState({ ...id, state: "inactive" }));
      yield* noticed(screen.received, 1);
      yield* client.MerchantSetWorkflowState(setState({ ...id, state: "active" }));
      yield* noticed(screen.received, 1);
      const box = yield* created(client, "Box sites-configuration", "box-sites-configuration");
      yield* client.MerchantAddStep(
        addStep({ ...(yield* editing(backendUrl, box.id)), name: "Box", teamId: working.id }),
      );
      const turnedOn = yield* client.MerchantApplyAndTurnOn(yield* editing(backendUrl, box.id));
      assert.strictEqual(turnedOn._tag, "Ok");
      yield* noticed(screen.received, 1);
      yield* client.MerchantDeleteWorkflow(workflowId({ workflowId: box.id }));
      yield* noticed(screen.received, 1);
      yield* client.MerchantDeleteTeam({ teamId: idle.id });
      yield* noticed(screen.received, 1);
      // A second delete answers NotFound and still notifies: it nulls any
      // pointer to a team gone from D1, which the lists show.
      const again = yield* client.MerchantDeleteTeam({ teamId: idle.id });
      assert.strictEqual(again._tag, "NotFound");
      yield* noticed(screen.received, 1);
      assert.strictEqual(yield* PubSub.remaining(screen.received), 0, "no more notices");
    }).pipe(Effect.scoped);
  }),
);

/**
 * The workflow verbs' refusals: Edit tag on a workflow that is not there, Apply with no draft,
 * the switch on a workflow that is not there. The positive half first, so a notice that never ran
 * cannot pass. It is Edit tag, a write that needs no run.
 */
test(
  "a refused call publishes nothing",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* merchant(backendUrl);
      const workflow = yield* created(client, "W sites-refused", "sites-refused");
      const id = workflowId({ workflowId: workflow.id });
      const screen = yield* merchant(backendUrl);
      yield* screen.client.MerchantWhoAmI();

      yield* client.MerchantUpdateWorkflowTag(retag({ ...id, tag: "sites-refused-2" }));
      yield* noticed(screen.received, 1);

      const edited = yield* client.MerchantUpdateWorkflowTag(
        retag({ workflowId: "missing", tag: "x-sites-refused" }),
      );
      assert.strictEqual(edited._tag, "NotFound");
      const applied = yield* client.MerchantApplyDraft(yield* editing(backendUrl, workflow.id));
      assert.strictEqual(applied._tag, "NoDraft");
      const switched = yield* client.MerchantSetWorkflowState(
        setState({ workflowId: "missing", state: "inactive" }),
      );
      assert.strictEqual(switched._tag, "NotFound");
      // A later write's notice is the first one queued: the refusals sent none.
      yield* client.MerchantUpdateWorkflowTag(retag({ ...id, tag: "sites-refused-3" }));
      yield* noticed(screen.received, 1);
      assert.strictEqual(yield* PubSub.remaining(screen.received), 0, "no more notices");
    }).pipe(Effect.scoped);
  }),
);

test(
  "a member is refused every workflow procedure with Forbidden",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const { client } = yield* openAs(backendUrl, SEED_SHOP, {
        role: "member",
        memberId: "member-workflows",
        memberEmail: email("m@workflows.test"),
        teamIds: [],
        userId: "user-workflows",
        sessionId: "session-workflows",
        sessionExpiresAt: Date.now() + 600_000,
      });
      yield* client.MemberWhoAmI();
      const id = workflowId({ workflowId: "any" });
      const editorId = { ...id, tasksRevision: 0 };
      const task = taskWrite({ taskId: "any", tasksRevision: 0 });
      const calls = [
        client.MerchantCreateWorkflow(create({ name: "X", tag: "x" })),
        client.MerchantDuplicateWorkflow(duplicate({ ...id, name: "X", tag: "x" })),
        client.MerchantUpdateWorkflow(rename({ ...id, name: "X" })),
        client.MerchantUpdateWorkflowTag(retag({ ...id, tag: "x" })),
        client.MerchantApplyDraft(editorId),
        client.MerchantDiscardDraft(editorId),
        client.MerchantSetWorkflowState(setState({ ...id, state: "active" })),
        client.MerchantApplyAndTurnOn(editorId),
        client.MerchantDeleteWorkflow(id),
        client.MerchantAddStep(addStep({ ...editorId, name: "X", teamId: "t" })),
        client.MerchantAddTask(addTask({ ...editorId, step: 1, name: "X", teamId: "t" })),
        client.MerchantUpdateTask(
          updateTask({ ...task, name: "X", teamId: "t", instructions: null }),
        ),
        client.MerchantMoveTask(moveTask({ ...task, direction: "up" })),
        client.MerchantSeparateTask(task),
        client.MerchantJoinTask(task),
        client.MerchantRemoveTask(task),
      ];
      assert.strictEqual(calls.length, 16);
      for (const call of calls as ReadonlyArray<Effect.Effect<unknown, unknown>>) {
        const exit = yield* Effect.exit(call);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) assert.include(JSON.stringify(exit.cause), "Forbidden");
      }
    }).pipe(Effect.scoped);
  }),
);

const fixture = Schema.decodeUnknownSync(ShopFixtureData);

test(
  "the workflows index pages by name and a search narrows it",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const names = Array.from(
      { length: 55 },
      (_, index) => `Ring ${String(index).padStart(2, "0")}`,
    );
    const added = yield* addToFixture(
      backendUrl,
      OTHER_SHOP,
      fixture({
        members: [],
        teams: [],
        workflows: [
          ...names.map((name) => ({ name, tag: name, tasks: [] })),
          { name: "Mug glaze", tag: "mug", tasks: [] },
        ],
        orders: [],
      }),
    );
    assert.strictEqual(added.workflows, 56);
    const sessionToken = yield* mintSessionToken({ shop: OTHER_SHOP });
    const page = (after: string | null, q: string | null = null, state: "active" | null = null) =>
      integ(backendUrl, (c) =>
        c.ApiWorkflowsPage({
          sessionToken,
          state,
          q: q === null ? null : Schema.decodeUnknownSync(ShopWork.ListSearch)(q),
          after: after === null ? null : Schema.decodeUnknownSync(ShopWork.WorkflowName)(after),
        }),
      );
    const first = yield* page(null);
    assert.strictEqual(first.workflows.length, 50);
    assert.strictEqual(first.workflows[0]?.name, "Mug glaze");
    assert.strictEqual(first.matches, null);
    if (first.nextCursor === null) return assert.fail("no next page");
    const second = yield* page(first.nextCursor);
    assert.deepStrictEqual(
      second.workflows.map((workflow) => workflow.name),
      names.slice(49),
    );
    assert.strictEqual(second.nextCursor, null);
    // A word prefix of the name, over every page; the state filter is ignored under a search.
    const found = yield* page(null, "glaz");
    assert.deepStrictEqual(
      found.workflows.map((workflow) => workflow.name),
      ["Mug glaze"],
    );
    assert.strictEqual(found.matches, 1);
    assert.strictEqual((yield* page(null, "ring", "active")).matches, 55);
    assert.strictEqual((yield* page(null, null, "active")).workflows.length, 0);
  }),
);

test(
  "the loaders refuse a token signed with another secret and a shop with no ShopSession",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const bad = yield* mintSessionToken({ shop: SEED_SHOP, apiSecret: "other-secret" });
    const uninstalled = yield* mintSessionToken({
      shop: Schema.decodeUnknownSync(ShopKey)("not-installed.myshopify.com"),
    });
    for (const [sessionToken, tag] of [
      [bad, "InvalidSessionToken"],
      [uninstalled, "ShopNotInstalled"],
    ] as const) {
      const calls = [
        integ(backendUrl, (c) =>
          c.ApiWorkflowsPage({ sessionToken, state: null, q: null, after: null }),
        ),
        integ(backendUrl, (c) => c.ApiWorkflowDetail({ sessionToken, workflowId: "any" })),
        integ(backendUrl, (c) => c.ApiSetupFacts({ sessionToken })),
      ] as ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>>;
      for (const call of calls) assert.strictEqual((yield* Effect.flip(call))._tag, tag);
    }
  }),
);

/** A `MerchantCreateWorkflow` exit as the browser's client decodes it off the wire. */
const decodeCreateExit = Schema.decodeUnknownEffect(
  RpcSerialization.json.codecFor(
    Rpc.exitSchema(MerchantRpcs.requests.get("MerchantCreateWorkflow")!),
  ),
);

test(
  "procedure inputs reject excess properties",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP }));
    const send = (payload: unknown) =>
      rawRequestAs(
        backendUrl,
        SEED_SHOP,
        { role: "merchant" },
        {
          tag: "MerchantCreateWorkflow",
          payload,
        },
      );
    // The refusal is a defect on the call's exit; a typed client's call dies with it.
    assert.deepStrictEqual(yield* send({ name: "Strict", tag: "strict", extra: 1 }), {
      _tag: "Failure",
      cause: [{ _tag: "Die", defect: 'Expected no excess property\n  at ["extra"]' }],
    });
    // Nothing was written: the same name and tag are free. The client's own codec reads the answer.
    const created = yield* decodeCreateExit(yield* send({ name: "Strict", tag: "strict" }));
    assert.isTrue(
      Exit.isSuccess(created) &&
        Schema.is(ShopWork.WorkflowResult)(created.value) &&
        created.value._tag === "Ok",
    );
  }),
);
