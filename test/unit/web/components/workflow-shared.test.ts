import { describe, it } from "@effect/vitest";
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import {
  applyBlocker,
  copyName,
  suggestedTag,
  tagCommaError,
  turnOnBlocker,
  unassignedLine,
} from "../../../../src/web/components/workflow-shared.ts";
import type { TaskWithTeamName } from "../../../../src/domain/shop-work.ts";

/** Legacy `workflow-repository.test.ts`'s `copyName` case, title unchanged, and the screens' other helpers. */
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

const task = (name: string, teamName: string | null) =>
  ({
    id: name,
    position: 1,
    step: 1,
    name,
    teamId: teamName,
    instructions: null,
    teamName,
    memberCount: 1,
  }) as unknown as TaskWithTeamName;

describe("workflow screen helpers", () => {
  it("a suggested tag is the name trimmed, lowercased and without commas; a comma is the tag field's error", () => {
    strictEqual(suggestedTag("  Rings, Engraved "), "rings engraved");
    strictEqual(tagCommaError("a,b"), "A tag can't have a comma.");
    strictEqual(tagCommaError("ab"), null);
  });

  it("Turn on and Apply are blocked by no tasks or an unassigned task, named in the banner line", () => {
    deepStrictEqual<unknown>(turnOnBlocker([]), { _tag: "NoTasks" });
    deepStrictEqual<unknown>(applyBlocker([task("Cut", "Bench"), task("Stamp", null)]), {
      _tag: "TaskUnassigned",
      taskNames: ["Stamp"],
    });
    strictEqual(turnOnBlocker([task("Cut", "Bench")]), null);
    strictEqual(
      unassignedLine([task("Stamp", null)]),
      "No team on Stamp. Assign one before you apply.",
    );
    strictEqual(unassignedLine([task("Cut", "Bench")]), null);
  });
});
