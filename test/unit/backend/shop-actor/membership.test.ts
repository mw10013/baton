import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import { Email, ShopKey } from "../../../../src/domain/platform.ts";
import { MemberId, TeamId, TeamName } from "../../../../src/domain/shop-work.ts";
import { MembershipRepository } from "../../../../src/backend/membership-repository.ts";
import { makeMembership } from "../../../../src/backend/shop-actor/membership.ts";
import { syncTransaction } from "../../../../src/backend/shop-actor/transaction.ts";
import { makeWorkflowRepository } from "../../../../src/backend/shop-actor/workflow-repository.ts";
import { makeWorkflows } from "../../../../src/backend/shop-actor/workflows.ts";
import { ORDERS_KEY } from "../../../../src/contract/shop-actor.ts";
import * as ShopWork from "../../../../src/domain/shop-work.ts";
import { ActorSqliteTest, makeD1Test, QuietLogs, seedD1 } from "../layers.ts";
import { type AtCurrentRevision, atCurrentRevision } from "./current-revision.ts";

const shop = Schema.decodeUnknownSync(ShopKey)("membership.myshopify.com");
const email = Schema.decodeUnknownSync(Email);
const teamName = Schema.decodeUnknownSync(TeamName);

/**
 * A {@link makeMembership} over the real `MembershipRepository` on a fresh in-memory D1 holding
 * `shop`, the actor's workflow repository on {@link ActorSqliteTest}, a recording `revoke` (each
 * call's member ids, in order), reconcile seam and `notify`. `workflows` is the workflows
 * application service over the same stores, for arranging and reading back workflows.
 */
const harness = Effect.gen(function* () {
  const { db, raw } = yield* makeD1Test;
  seedD1(db, { shops: [shop] });
  const membershipRepository = yield* MembershipRepository.pipe(
    Effect.provide(MembershipRepository.layerWith(raw)),
  );
  const sql = yield* SqlClient.SqlClient;
  const workflowRepository = makeWorkflowRepository(sql, syncTransaction(sql));
  const revoked: Array<ReadonlyArray<MemberId>> = [];
  const reconciled: Array<readonly [string, string]> = [];
  const notices: Array<ReadonlyArray<string>> = [];
  const reconcileAll = (caller: string, id: string) =>
    Effect.sync(() => {
      reconciled.push([caller, id]);
    });
  const notify = (invalidated: ReadonlyArray<string>) =>
    Effect.sync(() => {
      notices.push(invalidated);
    });
  const membership = makeMembership({
    membershipRepository,
    workflowRepository,
    reconcileAll,
    notify,
    revoke: (memberIds) =>
      Effect.sync(() => {
        revoked.push(memberIds);
        return memberIds.length;
      }),
    shop,
  });
  const editorWrites = makeWorkflows({
    repository: workflowRepository,
    membershipRepository,
    reconcileAll: () => Effect.void,
    notify: () => Effect.void,
    shop,
  });
  const workflows = atCurrentRevision(editorWrites, workflowRepository);
  return { membership, membershipRepository, workflows, revoked, reconciled, notices };
});

const addStep = Schema.decodeUnknownSync(
  ShopWork.AddStepInput.mapFields(Struct.omit(["tasksRevision"])),
);
const state = (workflowId: string, value: ShopWork.WorkflowState) =>
  Schema.decodeUnknownSync(ShopWork.SetWorkflowStateInput)({ workflowId, state: value });

/** The workflows index's first page, unfiltered, large enough for every test here. */
const ALL_WORKFLOWS = { limit: 100, cursor: null, q: null, state: null };

/** A fresh workflow's id; any answer but `Ok` fails the test. */
const createdWorkflow = (workflows: AtCurrentRevision<ReturnType<typeof makeWorkflows<never>>>) =>
  workflows
    .createWorkflow(Schema.decodeUnknownSync(ShopWork.CreateWorkflowInput)({ name: "W", tag: "w" }))
    .pipe(
      Effect.flatMap((result) =>
        result._tag === "Ok" ? Effect.succeed(result.workflow.id) : Effect.die(result._tag),
      ),
    );

/** Apply the draft and turn the workflow on, the two writes a fresh workflow needs before it starts. */
const goLive = (
  workflows: AtCurrentRevision<ReturnType<typeof makeWorkflows<never>>>,
  workflowId: string,
) =>
  Effect.gen(function* () {
    assert.strictEqual((yield* workflows.applyDraft({ workflowId }))._tag, "Ok");
    assert.strictEqual((yield* workflows.setWorkflowState(state(workflowId, "active")))._tag, "Ok");
  });

describe("Membership", () => {
  it.effect("adding a member, creating a team and renaming it revoke nobody", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      const member = yield* membership.addMember({ email: email("new@membership.test") });
      assert.strictEqual(member.email, "new@membership.test");
      const team = yield* membership.createTeam({ name: teamName("Cut") });
      yield* membership.renameTeam({ teamId: team.id, name: teamName("Cutting") });
      assert.deepStrictEqual<unknown>(revoked, []);
    }).pipe(Effect.provide(QuietLogs), Effect.provide(ActorSqliteTest)),
  );

  it.effect("each membership write revokes exactly the members it changed", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      const a = yield* membership.addMember({ email: email("a@membership.test") });
      const b = yield* membership.addMember({ email: email("b@membership.test") });
      const cut = yield* membership.createTeam({ name: teamName("Cut") });
      const sew = yield* membership.createTeam({ name: teamName("Sew") });
      yield* membership.addMemberTeams({ memberId: a.id, teamIds: [cut.id, sew.id] });
      yield* membership.setTeamMember({ teamId: sew.id, memberId: a.id, inTeam: false });
      yield* membership.addTeamMembers({ teamId: cut.id, memberIds: [b.id] });
      yield* membership.deleteMember({ email: b.email });
      assert.deepStrictEqual<unknown>(revoked, [[a.id], [a.id], [b.id], [b.id]]);
    }).pipe(Effect.provide(QuietLogs), Effect.provide(ActorSqliteTest)),
  );

  it.effect("deleteTeam revokes everyone who was on the team, read before the delete", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      const a = yield* membership.addMember({ email: email("a@membership.test") });
      const b = yield* membership.addMember({ email: email("b@membership.test") });
      yield* membership.addMember({ email: email("off@membership.test") });
      const team = yield* membership.createTeam({ name: teamName("Cut") });
      yield* membership.addTeamMembers({ teamId: team.id, memberIds: [a.id, b.id] });
      revoked.length = 0;
      assert.deepStrictEqual<unknown>(yield* membership.deleteTeam({ teamId: team.id }), {
        _tag: "Deleted",
      });
      assert.deepStrictEqual<unknown>(
        revoked.map((ids) => [...ids].sort()),
        [[a.id, b.id].sort()],
      );
    }).pipe(Effect.provide(QuietLogs), Effect.provide(ActorSqliteTest)),
  );

  it.effect("deleteTeam of an unknown id is NotFound and revokes none", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      assert.deepStrictEqual<unknown>(
        yield* membership.deleteTeam({ teamId: Schema.decodeUnknownSync(TeamId)("team-unknown") }),
        { _tag: "NotFound" },
      );
      assert.deepStrictEqual<unknown>(revoked, []);
    }).pipe(Effect.provide(QuietLogs), Effect.provide(ActorSqliteTest)),
  );

  it.effect("a refusal writes nothing and revokes none", () =>
    Effect.gen(function* () {
      const { membership, revoked } = yield* harness;
      const member = yield* membership.addMember({ email: email("a@membership.test") });
      const team = yield* membership.createTeam({ name: teamName("Cut") });
      const unknownTeam = Schema.decodeUnknownSync(TeamId)("team-unknown");
      const failures = [
        yield* membership
          .deleteMember({ email: email("nobody@membership.test") })
          .pipe(Effect.flip),
        yield* membership
          .addMemberTeams({
            memberId: Schema.decodeUnknownSync(MemberId)("member-unknown"),
            teamIds: [team.id],
          })
          .pipe(Effect.flip),
        yield* membership
          .setTeamMember({ teamId: unknownTeam, memberId: member.id, inTeam: true })
          .pipe(Effect.flip),
        yield* membership
          .addTeamMembers({ teamId: unknownTeam, memberIds: [member.id] })
          .pipe(Effect.flip),
        yield* membership.createTeam({ name: teamName("Cut") }).pipe(Effect.flip),
        yield* membership
          .renameTeam({ teamId: unknownTeam, name: teamName("Sew") })
          .pipe(Effect.flip),
      ];
      assert.deepStrictEqual<unknown>(
        failures.map((failure) => failure._tag),
        [
          "MemberNotFoundError",
          "MemberNotFoundError",
          "TeamNotFoundError",
          "TeamNotFoundError",
          "TeamNameTakenError",
          "TeamNotFoundError",
        ],
      );
      assert.deepStrictEqual<unknown>(revoked, []);
    }).pipe(Effect.provide(QuietLogs), Effect.provide(ActorSqliteTest)),
  );
  it.effect("the next team delete nulls pointers to a team that is already gone", () =>
    Effect.gen(function* () {
      const { membership, membershipRepository, workflows } = yield* harness;
      const a = yield* membership.createTeam({ name: teamName("A") });
      const b = yield* membership.createTeam({ name: teamName("B") });
      const c = yield* membership.createTeam({ name: teamName("C") });
      const workflowId = yield* createdWorkflow(workflows);
      for (const [name, team] of [
        ["S", a],
        ["T", b],
        ["U", c],
      ] as const)
        yield* workflows.addStep(addStep({ workflowId, name, teamId: team.id }));
      yield* goLive(workflows, workflowId);
      yield* workflows.addStep(addStep({ workflowId, name: "V", teamId: c.id }));
      // A's delete went half way: its row is gone and its pointers are not.
      yield* membershipRepository.deleteTeam({ shop, id: a.id });
      assert.deepStrictEqual<unknown>(yield* membership.deleteTeam({ teamId: b.id }), {
        _tag: "Deleted",
      });
      const detail = yield* workflows.getWorkflowDetail({ workflowId });
      assert.deepStrictEqual<unknown>(
        detail?.tasks.map((s) => s.teamId),
        [null, null, c.id],
      );
      assert.deepStrictEqual<unknown>(
        detail?.draftTasks?.map((s) => s.teamId),
        [null, null, c.id, c.id],
      );
    }).pipe(Effect.provide(QuietLogs), Effect.provide(ActorSqliteTest)),
  );

  it.effect(
    "deleteTeam nulls every task pointer, D1 first; a dangling id reads as unassigned and a retry repairs it",
    () =>
      Effect.gen(function* () {
        const { membership, membershipRepository, workflows, reconciled, notices } = yield* harness;
        const a = yield* membership.createTeam({ name: teamName("A") });
        const b = yield* membership.createTeam({ name: teamName("B") });
        const workflowId = yield* createdWorkflow(workflows);
        const id = { workflowId };
        yield* workflows.addStep(addStep({ workflowId, name: "S", teamId: a.id }));
        yield* workflows.addStep(addStep({ workflowId, name: "T", teamId: b.id }));
        yield* goLive(workflows, workflowId);
        yield* workflows.addStep(addStep({ workflowId, name: "U", teamId: b.id }));

        assert.deepStrictEqual<unknown>(yield* membership.deleteTeam({ teamId: a.id }), {
          _tag: "Deleted",
        });
        assert.isFalse((yield* membershipRepository.listTeams(shop)).some((t) => t.id === a.id));
        const detail = yield* workflows.getWorkflowDetail(id);
        assert.deepStrictEqual<unknown>(
          detail?.tasks.map((s) => [s.name, s.teamId, s.teamName]),
          [
            ["S", null, null],
            ["T", b.id, "B"],
          ],
        );
        assert.deepStrictEqual<unknown>(
          detail?.draftTasks?.map((s) => s.teamId),
          [null, b.id, b.id],
        );
        assert.deepStrictEqual<unknown>(
          detail?.teams.map((t) => t.name),
          ["B"],
        );
        // Off stays off; turning back on names the unassigned task.
        yield* workflows.setWorkflowState(state(workflowId, "inactive"));
        assert.deepStrictEqual<unknown>(
          yield* workflows.setWorkflowState(state(workflowId, "active")),
          {
            _tag: "TaskUnassigned",
            taskNames: ["S"],
          },
        );
        assert.deepStrictEqual<unknown>(yield* workflows.applyDraft(id), {
          _tag: "TaskUnassigned",
          taskNames: ["S"],
        });
        const {
          workflows: [summary],
        } = yield* workflows.listWorkflows(ALL_WORKFLOWS);
        assert.strictEqual(summary?.unassigned, true);

        // The D1 half succeeded and the object half did not: every read treats
        // the dangling id as unassigned, and a retry nulls it for real.
        yield* membershipRepository.deleteTeam({ shop, id: b.id });
        const dangling = yield* workflows.getWorkflowDetail(id);
        assert.deepStrictEqual<unknown>(
          dangling?.tasks.map((s) => [s.teamId, s.teamName]),
          [
            [null, null],
            [b.id, null],
          ],
        );
        assert.deepStrictEqual<unknown>(
          yield* workflows.setWorkflowState(state(workflowId, "active")),
          {
            _tag: "TaskUnassigned",
            taskNames: ["S", "T"],
          },
        );
        assert.deepStrictEqual<unknown>(yield* membership.deleteTeam({ teamId: b.id }), {
          _tag: "NotFound",
        });
        const repaired = yield* workflows.getWorkflowDetail(id);
        assert.deepStrictEqual<unknown>(
          repaired?.tasks.map((s) => s.teamId),
          [null, null],
        );

        // Assigning a team on the draft and applying clears unassigned.
        const c = yield* membership.createTeam({ name: teamName("C") });
        for (const task of repaired?.draftTasks ?? [])
          yield* workflows.updateTask({
            taskId: task.id,
            name: task.name,
            teamId: c.id,
            instructions: null,
          });
        assert.strictEqual((yield* workflows.applyDraft(id))._tag, "Ok");
        // Turn on is allowed again; emptyTeam shows because C has nobody on it,
        // which is a warning, never a refusal.
        assert.strictEqual(
          (yield* workflows.setWorkflowState(state(workflowId, "active")))._tag,
          "Ok",
        );
        const {
          workflows: [cleared],
        } = yield* workflows.listWorkflows(ALL_WORKFLOWS);
        assert.strictEqual(cleared?.unassigned, false);
        assert.strictEqual(cleared?.emptyTeam, true);
        assert.deepStrictEqual<unknown>(
          yield* membership.deleteTeam({ teamId: Schema.decodeUnknownSync(TeamId)("nope") }),
          { _tag: "NotFound" },
        );
        // Every delete reconciled and notified, both answers alike.
        assert.deepStrictEqual<unknown>(reconciled, [
          ["deleteTeam", a.id],
          ["deleteTeam", b.id],
          ["deleteTeam", "nope"],
        ]);
        assert.deepStrictEqual<unknown>(notices, [[ORDERS_KEY], [ORDERS_KEY], [ORDERS_KEY]]);
      }).pipe(Effect.provide(QuietLogs), Effect.provide(ActorSqliteTest)),
  );
});
