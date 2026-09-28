import { describe, expect, it } from "vitest";

import * as RulesLint from "../../scripts/lib/rules-lint.ts";

/**
 * `scripts/lib/rules-lint.ts` on inline sources. Pure, so it runs in the
 * workers pool like `spec.test.ts`.
 */

const hits = (source: string, tsx = true) =>
  RulesLint.retiredCopyHits(source, tsx).map(({ line }) => line);

describe("a retired word stays off every merchant and member screen", () => {
  it("reads string literals, a sentence ending in run., and the literals inside a template's interpolation", () => {
    const source = [
      'const a = "Cancel run";',
      "const b = `No runs.`;",
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      'const c = `Started ${n} ${n === 1 ? "run" : "runs"} on orders.`;',
      'const d = "That line item is done.";',
      'const e = "Every task is finished.";',
      'const f = "mark done";',
      'const g = "Nothing unclaimed.";',
      'const h = "In progress";',
    ].join("\n");
    expect(hits(source, false)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("reads JSX text on one line, beside an expression, and across lines", () => {
    const source = [
      "<s-text>Cancel run</s-text>",
      "<s-paragraph>Every run is closed.{' '}</s-paragraph>",
      "<s-paragraph>",
      "  {count} runs are open, and",
      "  none of them is run.",
      "</s-paragraph>",
    ].join("\n");
    expect(hits(source)).toEqual([1, 2, 4, 5]);
  });

  it("skips comments, identifiers, paths and query keys", () => {
    const source = [
      "// Cancel run",
      "/* the run",
      " * is done */",
      "{/* Every run */}",
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      'const key = ["shop-runs", run.status, "run-actions-1", `${run}`];',
      // oxlint-disable-next-line no-template-curly-in-string -- source under test, not a template
      "<s-link href={`/work/${runId}`}>",
      "const run = runs.find(isRun);",
    ].join("\n");
    expect(hits(source)).toEqual([]);
  });

  it("staff is a retired word in screen copy", () => {
    const source = [
      'const a = "Unstaffed";',
      "<s-paragraph>",
      "  Add a member to staff the team.",
      "</s-paragraph>",
      "// Shopify staff inside the embedded admin",
    ].join("\n");
    expect(hits(source)).toEqual([1, 3]);
  });

  it("attention is a retired word in screen copy", () => {
    const source = [
      '<s-banner heading="Needs attention" />',
      "<s-paragraph>",
      "  Nothing else needs your attention.",
      "</s-paragraph>",
      "// the derived attention state",
    ].join("\n");
    expect(hits(source)).toEqual([1, 3]);
  });

  it("names the line and its text", () => {
    expect(
      RulesLint.retiredCopyHits('x;\nconst t = "Keep run";', false),
    ).toEqual([{ line: 2, text: 'const t = "Keep run";' }]);
  });
});
