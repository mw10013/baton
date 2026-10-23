import { describe, it } from "@effect/vitest";
import { strictEqual } from "@effect/vitest/utils";
import * as Schema from "effect/Schema";
import {
  type Run,
  RunId,
  RunNote,
  type RunTask,
  RunTaskId,
  TaskName,
  TeamName,
  WorkflowName,
} from "../../../../src/domain/shop-work.ts";
import {
  CANCEL_WARNING,
  cancelHeading,
  changeWarning,
} from "../../../../src/web/components/change-warning.ts";

const task = (position: number, state: "open" | "started" | "done"): RunTask => ({
  id: Schema.decodeUnknownSync(RunTaskId)(`t${String(position)}`),
  runId: Schema.decodeUnknownSync(RunId)("r"),
  position,
  step: position,
  name: Schema.decodeUnknownSync(TaskName)(`Task ${String(position)}`),
  teamId: null,
  teamName: Schema.decodeUnknownSync(TeamName)("T"),
  instructions: null,
  startedAt: state === "open" ? null : 1,
  startedByEmail: null,
  startedByRole: null,
  doneAt: state === "done" ? 2 : null,
  doneByEmail: null,
  doneByRole: null,
});

const from = Schema.decodeUnknownSync(WorkflowName)("Engraving");

const runOf = (
  overrides: Partial<Pick<Run, "blockedAt" | "note">> = {},
): Pick<Run, "blockedAt" | "note"> => ({ blockedAt: null, note: null, ...overrides });
const NOTE = Schema.decodeUnknownSync(RunNote)("Use the gold leaf");

describe("changeWarning", () => {
  it("the change warning names the note when the run has one", () => {
    const tasks = [task(1, "done"), task(2, "open")];
    strictEqual(
      changeWarning(from, "Rush", runOf({ note: NOTE }), tasks),
      "Engraving has 1 of 2 steps done. Change to Rush anyway? That work and the note will not carry over.",
    );
    strictEqual(
      changeWarning(from, "Rush", runOf(), tasks),
      "Engraving has 1 of 2 steps done. Change to Rush anyway? That work will not carry over.",
    );
  });

  it("done outranks started", () => {
    strictEqual(
      changeWarning(from, "Rush", runOf(), [task(1, "started"), task(2, "open")]),
      "Engraving has 1 of 2 steps started. Change to Rush anyway? That work will not carry over.",
    );
  });

  it("the change warning names the block when the run is blocked", () => {
    strictEqual(
      changeWarning(from, "Rush", runOf({ blockedAt: 1, note: NOTE }), [
        task(1, "done"),
        task(2, "open"),
      ]),
      "Engraving has 1 of 2 steps done. Change to Rush anyway? That work, the block and the note will not carry over.",
    );
    strictEqual(
      changeWarning(from, "Rush", runOf({ blockedAt: 1 }), [task(1, "started"), task(2, "open")]),
      "Engraving has 1 of 2 steps started. Change to Rush anyway? That work and the block will not carry over.",
    );
  });

  it("a run with nothing started, no block and no note gets no warning", () => {
    strictEqual(changeWarning(from, "Rush", runOf(), [task(1, "open"), task(2, "open")]), "");
  });

  it("a blocked run with nothing started gets the block warning without a progress clause", () => {
    const tasks = [task(1, "open"), task(2, "open")];
    strictEqual(
      changeWarning(from, "Rush", runOf({ blockedAt: 1 }), tasks),
      "Engraving is blocked. Change to Rush anyway? The block will not carry over.",
    );
    strictEqual(
      changeWarning(from, "Rush", runOf({ blockedAt: 1, note: NOTE }), tasks),
      "Engraving is blocked. Change to Rush anyway? The block and the note will not carry over.",
    );
    strictEqual(
      changeWarning(from, "Rush", runOf({ note: NOTE }), tasks),
      "Engraving has a note. Change to Rush anyway? The note will not carry over.",
    );
  });
});

describe("cancelHeading", () => {
  it("the cancel question names the workflow, the item goes in the body; the warning says work stops, done steps still show on the order, and another workflow can be attached", () => {
    strictEqual(cancelHeading(from), "Cancel Engraving?");
    strictEqual(
      CANCEL_WARNING,
      "Work on it stops. Steps already done still show on the order. You can attach another workflow to the item afterwards.",
    );
  });
});
