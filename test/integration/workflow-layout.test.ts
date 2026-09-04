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

  it("move within a stage reorders only; across a boundary adopts the neighbour's stage and closes an emptied one", () => {
    const start = layout("a1 b1 c2 d3");
    const within = WorkflowLayout.move(start, "b", "up");
    strictEqual(shape(within), "b1 a1 c2 d3");
    check(start, within);

    const joined = WorkflowLayout.move(start, "c", "up");
    strictEqual(shape(joined), "a1 c1 b1 d2");
    check(start, joined);

    const down = WorkflowLayout.move(start, "b", "down");
    strictEqual(shape(down), "a1 c2 b2 d3");
    check(start, down);

    strictEqual(shape(WorkflowLayout.move(start, "a", "up")), shape(start));
    strictEqual(shape(WorkflowLayout.move(start, "d", "down")), shape(start));
    strictEqual(shape(WorkflowLayout.move(start, "zz", "down")), shape(start));
  });

  it("separate is a no-op on a solo step and splits a member off into its own following stage", () => {
    const start = layout("a1 b1 c1 d2");
    strictEqual(shape(WorkflowLayout.separate(start, "d")), shape(start));
    const split = WorkflowLayout.separate(start, "b");
    strictEqual(shape(split), "a1 c1 b2 d3");
    check(start, split);
    // Research appendix round trip: a following step moved up rejoins it.
    const rejoined = WorkflowLayout.move(split, "d", "up");
    strictEqual(shape(rejoined), "a1 c1 d2 b2");
    check(start, rejoined);
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
