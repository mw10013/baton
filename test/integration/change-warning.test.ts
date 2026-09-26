import { strictEqual } from "@effect/vitest/utils";
import { Schema } from "effect";
import { describe, it } from "vitest";

import {
  CANCEL_WARNING,
  cancelHeading,
  changeWarning,
} from "@/lib/changeWarning";
import * as Domain from "@/lib/Domain";

const task = (
  position: number,
  state: "open" | "started" | "done",
): Domain.RunTask => ({
  id: Schema.decodeUnknownSync(Domain.RunTaskId)(`t${String(position)}`),
  runId: Schema.decodeUnknownSync(Domain.RunId)("r"),
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
  doneAt: state === "done" ? 2 : null,
  doneBy: null,
  doneByEmail: null,
  doneByRole: null,
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

describe("cancelHeading", () => {
  it("the cancel question names the workflow and the item; the warning says work stops, done steps stay on record, and another workflow can be attached", () => {
    strictEqual(
      cancelHeading(from, "Leather journal — A5"),
      "Cancel Engraving on Leather journal — A5?",
    );
    strictEqual(
      CANCEL_WARNING,
      "Work on it stops. Steps already done stay on record. You can attach another workflow to the item afterwards.",
    );
  });
});
