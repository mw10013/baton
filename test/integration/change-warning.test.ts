import { strictEqual } from "@effect/vitest/utils";
import { Schema } from "effect";
import { describe, it } from "vitest";

import { cancelWarning, changeWarning } from "@/lib/changeWarning";
import * as Domain from "@/lib/Domain";

const task = (
  position: number,
  state: "open" | "started" | "done",
): Domain.WorkflowRunTask => ({
  id: Schema.decodeUnknownSync(Domain.WorkflowRunTaskId)(
    `t${String(position)}`,
  ),
  runId: Schema.decodeUnknownSync(Domain.WorkflowRunId)("r"),
  position,
  step: position,
  name: Schema.decodeUnknownSync(Domain.TaskName)(`Task ${String(position)}`),
  teamId: null,
  teamName: Schema.decodeUnknownSync(Domain.TeamName)("T"),
  instructions: null,
  startedAt: state === "open" ? null : 1,
  startedBy: null,
  startedByEmail: null,
  startedByRole: null,
  completedAt: state === "done" ? 2 : null,
  completedBy: null,
  completedByEmail: null,
  completedByRole: null,
  reopenedAt: null,
  reopenedByRole: null,
  reopenedByEmail: null,
});

const from = Schema.decodeUnknownSync(Domain.WorkflowName)("Engraving");

describe("changeWarning", () => {
  it("the change warning names the note when the run has one", () => {
    const tasks = [task(1, "done"), task(2, "open")];
    strictEqual(
      changeWarning(from, "Rush", tasks, true),
      "Engraving has 1 of 2 steps done. Change to Rush anyway? That work and the note will not carry over.",
    );
    strictEqual(
      changeWarning(from, "Rush", tasks, false),
      "Engraving has 1 of 2 steps done. Change to Rush anyway? That work will not carry over.",
    );
  });

  it("done outranks started", () => {
    strictEqual(
      changeWarning(from, "Rush", [task(1, "started"), task(2, "open")], false),
      "Engraving has 1 of 2 steps started. Change to Rush anyway? That work will not carry over.",
    );
  });
});

describe("cancelWarning", () => {
  it("the cancel warning says work stops, finished steps stay on record, and another workflow can start", () => {
    strictEqual(
      cancelWarning(from, "Leather journal — A5"),
      "Cancel the Engraving run on Leather journal — A5? Work on it stops. Steps already done stay on record. You can start another workflow on the item afterwards.",
    );
  });
});
