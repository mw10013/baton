import { createElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatesAndBadges } from "@/components/help/reference/states-and-badges";
import { WhoCanDoWhat } from "@/components/help/reference/who-can-do-what";
import * as Domain from "@/lib/Domain";
import * as HelpReference from "@/lib/helpReference";
import { STATE_LABEL } from "@/lib/workflowsListStates";

import { RETIRED } from "../../scripts/lib/rules-lint.ts";

/**
 * The two vocabulary reference pages and their data module,
 * `src/lib/helpReference.ts`. The module's `satisfies Record<State, …>`
 * holds the row sets to the states; these tests hold the rendered pages to
 * the label constants, and the module's copy to the retired words. The lint
 * reads the module a line at a time; this test reads each string whole.
 */

/** Every string in a value, however deep. */
const stringsOf = (value: unknown): readonly string[] => {
  if (typeof value === "string") return [value];
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(stringsOf);
  return [];
};

/** Text as `renderToStaticMarkup` escapes it, so an apostrophe in a label still matches. */
const escaped = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

const labelsOf = (record: Record<string, string | null>) =>
  Object.values(record).filter((label): label is string => label !== null);

describe("help reference pages", () => {
  it("every label constant is on its reference page", () => {
    const statesAndBadges = renderToStaticMarkup(
      createElement(StatesAndBadges),
    );
    const whoCanDoWhat = renderToStaticMarkup(createElement(WhoCanDoWhat));
    const expected = [
      {
        markup: statesAndBadges,
        labels: [
          ...labelsOf(Domain.ORDER_POSITION_LABEL),
          ...labelsOf(Domain.ORDER_ISSUE_LABEL),
          ...labelsOf(Domain.RUN_STATE_LABEL),
          Domain.RUN_UNSTARTED_LABEL,
          ...labelsOf(Domain.TASK_STATE_LABEL),
          ...labelsOf(Domain.WORKFLOW_STATE_LABEL),
          ...labelsOf(Domain.WORKFLOW_FAULT_LABEL),
          ...labelsOf(STATE_LABEL),
        ],
      },
      {
        markup: whoCanDoWhat,
        labels: [
          ...Object.values(Domain.VERB_LABEL).flatMap((label) =>
            labelsOf(label),
          ),
          ...labelsOf(Domain.RECORD_VERB_LABEL),
        ],
      },
    ];
    for (const { markup, labels } of expected) {
      const missing = labels.filter(
        (label) => !markup.includes(`<strong>${escaped(label)}</strong>`),
      );
      expect(missing).toEqual([]);
    }
  });

  it("the reference copy is free of the retired words", () => {
    const hits = stringsOf(HelpReference).filter((text) =>
      RETIRED.some((pattern) => pattern.test(text)),
    );
    expect(hits).toEqual([]);
  });
});
