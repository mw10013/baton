import { deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { describe, it } from "vitest";

import * as WorkflowLayout from "@/lib/WorkflowLayout";

/** `"a1 b1 c2"` → placed steps `a`, `b` in stage 1 and `c` in stage 2, positions in order. */
const layout = (spec: string): WorkflowLayout.Layout =>
  spec.split(" ").map((token, index) => ({
    id: token.slice(0, 1),
    position: index + 1,
    stage: Number(token.slice(1)),
  }));

const shape = (l: WorkflowLayout.Layout) =>
  l.map((p) => `${p.id}${String(p.stage)}`).join(" ");

const ids = (l: WorkflowLayout.Layout) => l.map((p) => p.id).toSorted();

/** How every step other than `id` is partitioned into stages, in stage order. */
const others = (l: WorkflowLayout.Layout, id: string) =>
  WorkflowLayout.stagesOf(l)
    .map((group) =>
      group
        .map((p) => p.id)
        .filter((other) => other !== id)
        .toSorted()
        .join(""),
    )
    .filter((group) => group.length > 0);

const check = (before: WorkflowLayout.Layout, after: WorkflowLayout.Layout) => {
  strictEqual(WorkflowLayout.isValid(after), true, shape(after));
  deepStrictEqual(ids(after), ids(before));
};

describe("WorkflowLayout", () => {
  it("normalize renumbers stages densely and positions from 1", () => {
    const messy: WorkflowLayout.Layout = [
      { id: "a", position: 4, stage: 1 },
      { id: "b", position: 9, stage: 1 },
      { id: "c", position: 12, stage: 3 },
      { id: "d", position: 13, stage: 3 },
      { id: "e", position: 20, stage: 5 },
    ];
    const normalized = WorkflowLayout.normalize(messy);
    strictEqual(shape(normalized), "a1 b1 c2 d2 e3");
    deepStrictEqual(
      normalized.map((p) => p.position),
      [1, 2, 3, 4, 5],
    );
    check(messy, normalized);
  });

  it("append opens a new last stage; appendParallel joins an existing one and shifts later positions", () => {
    const empty = WorkflowLayout.append([], "a");
    strictEqual(shape(empty), "a1");
    const two = WorkflowLayout.append(empty, "b");
    strictEqual(shape(two), "a1 b2");
    const three = WorkflowLayout.append(two, "c");
    strictEqual(shape(three), "a1 b2 c3");
    const parallel = WorkflowLayout.appendParallel(three, 1, "d");
    strictEqual(shape(parallel), "a1 d1 b2 c3");
    strictEqual(WorkflowLayout.isValid(parallel), true);
    deepStrictEqual(ids(parallel), ["a", "b", "c", "d"]);
    strictEqual(
      shape(WorkflowLayout.appendParallel(three, 9, "d")),
      shape(three),
    );
  });

  it("move slides a step past the neighbouring boundary into a stage of its own", () => {
    const linear = layout("a1 b2 c3");
    const soloUp = WorkflowLayout.move(linear, "c", "up");
    strictEqual(shape(soloUp), "a1 c2 b3");
    check(linear, soloUp);

    const soloDown = WorkflowLayout.move(linear, "a", "down");
    strictEqual(shape(soloDown), "b1 a2 c3");
    check(linear, soloDown);

    const start = layout("a1 b2 c2 d3");
    const sharedUp = WorkflowLayout.move(start, "c", "up");
    strictEqual(shape(sharedUp), "a1 c2 b3 d4");
    check(start, sharedUp);

    const sharedDown = WorkflowLayout.move(start, "b", "down");
    strictEqual(shape(sharedDown), "a1 c2 b3 d4");
    check(start, sharedDown);

    // A shared step in stage 1 is not stuck: it moves up into a new stage 1.
    const first = layout("a1 b1 c2");
    const aheadOfMates = WorkflowLayout.move(first, "a", "up");
    strictEqual(shape(aheadOfMates), "a1 b2 c3");
    check(first, aheadOfMates);

    strictEqual(shape(WorkflowLayout.move(linear, "a", "up")), shape(linear));
    strictEqual(shape(WorkflowLayout.move(linear, "c", "down")), shape(linear));
    strictEqual(shape(WorkflowLayout.move(start, "zz", "down")), shape(start));
  });

  it("move never changes which other steps share a stage, and leaves the moved step alone", () => {
    for (const spec of ["a1 b2 c3", "a1 b1 c2 d3", "a1 b2 c2 d2 e3"]) {
      const before = layout(spec);
      for (const p of before)
        for (const direction of ["up", "down"] as const) {
          const after = WorkflowLayout.move(before, p.id, direction);
          const where = `${spec} ${p.id} ${direction}`;
          check(before, after);
          if (shape(after) !== shape(before)) {
            const moved = after.find((q) => q.id === p.id);
            strictEqual(
              after.filter((q) => q.stage === moved?.stage).length,
              1,
              where,
            );
            deepStrictEqual(others(after, p.id), others(before, p.id), where);
          }
        }
    }
  });

  it("join merges a step into the previous stage, last among its members", () => {
    const linear = layout("a1 b2 c3");
    const joined = WorkflowLayout.join(linear, "c");
    strictEqual(shape(joined), "a1 b2 c2");
    check(linear, joined);

    const intoShared = WorkflowLayout.join(layout("a1 b2 c2 d3"), "d");
    strictEqual(shape(intoShared), "a1 b2 c2 d2");

    strictEqual(
      shape(WorkflowLayout.join(layout("a1 b1 c2"), "c")),
      "a1 b1 c1",
    );

    // Mates stay behind.
    const shared = layout("a1 b2 c2");
    const left = WorkflowLayout.join(shared, "c");
    strictEqual(shape(left), "a1 c1 b2");
    check(shared, left);

    strictEqual(shape(WorkflowLayout.join(linear, "a")), shape(linear));
    strictEqual(shape(WorkflowLayout.join(linear, "zz")), shape(linear));

    // Round trip: separate undoes join.
    strictEqual(shape(WorkflowLayout.separate(joined, "c")), shape(linear));
  });

  it("separate is a no-op on a solo step and splits a member off into its own following stage", () => {
    const start = layout("a1 b1 c1 d2");
    strictEqual(shape(WorkflowLayout.separate(start, "d")), shape(start));
    const split = WorkflowLayout.separate(start, "b");
    strictEqual(shape(split), "a1 c1 b2 d3");
    check(start, split);
    // Reordering never merges: `d` moved up lands in a stage of its own.
    const moved = WorkflowLayout.move(split, "d", "up");
    strictEqual(shape(moved), "a1 c1 d2 b3");
    check(start, moved);
    // Joining does merge, and separate puts it back.
    const rejoined = WorkflowLayout.join(split, "d");
    strictEqual(shape(rejoined), "a1 c1 b2 d2");
    strictEqual(shape(WorkflowLayout.separate(rejoined, "d")), shape(split));
  });

  it("remove closes the gap in both positions and stages", () => {
    const start = layout("a1 b2 c3 d3");
    const removed = WorkflowLayout.remove(start, "b");
    strictEqual(shape(removed), "a1 c2 d2");
    deepStrictEqual(
      removed.map((p) => p.position),
      [1, 2, 3],
    );
    strictEqual(WorkflowLayout.isValid(removed), true);
    const fromShared = WorkflowLayout.remove(start, "c");
    strictEqual(shape(fromShared), "a1 b2 d3");
  });

  it("isValid rejects non-dense stages, decreasing stages, and duplicate positions", () => {
    strictEqual(WorkflowLayout.isValid(layout("a1 b1 c2 d3 e3 f3 g4")), true);
    strictEqual(WorkflowLayout.isValid([]), true);
    strictEqual(WorkflowLayout.isValid(layout("a1 b3")), false);
    strictEqual(WorkflowLayout.isValid(layout("a2 b1")), false);
    strictEqual(WorkflowLayout.isValid(layout("a2")), false);
    strictEqual(
      WorkflowLayout.isValid([
        { id: "a", position: 1, stage: 1 },
        { id: "b", position: 1, stage: 1 },
      ]),
      false,
    );
    strictEqual(
      WorkflowLayout.isValid([
        { id: "a", position: 1, stage: 1 },
        { id: "a", position: 2, stage: 1 },
      ]),
      false,
    );
  });

  it("stagesOf groups in stage order, each group in position order", () => {
    deepStrictEqual(
      WorkflowLayout.stagesOf(layout("a1 b1 c2 d3 e3")).map((group) =>
        group.map((p) => p.id),
      ),
      [["a", "b"], ["c"], ["d", "e"]],
    );
  });
});
