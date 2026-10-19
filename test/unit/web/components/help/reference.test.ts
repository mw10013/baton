import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import * as Platform from "../../../../../src/domain/platform.ts";
import * as ShopWork from "../../../../../src/domain/shop-work.ts";
import { Limits } from "../../../../../src/web/components/help/reference/limits.tsx";
import { PlansAndBilling } from "../../../../../src/web/components/help/reference/plans-and-billing.tsx";
import { StatesAndBadges } from "../../../../../src/web/components/help/reference/states-and-badges.tsx";
import { WhoCanDoWhat } from "../../../../../src/web/components/help/reference/who-can-do-what.tsx";
import { STATE_LABEL } from "../../../../../src/web/components/workflows-list-states.ts";

/**
 * The reference pages against the domain. The row sets' `satisfies Record<State, …>` holds them
 * to the states; these tests hold the rendered pages to the label constants, and the
 * number-bearing pages to the limits: Limits reads every number from its constant, and Plans and
 * billing prints the two hard limits and no plan number, because a plan's numbers live in the
 * Partner Dashboard and change without a deploy.
 */

const render = (Body: () => ReturnType<typeof StatesAndBadges>) =>
  renderToStaticMarkup(createElement(Body));

/** Text as `renderToStaticMarkup` escapes it, so an apostrophe in a label still matches. */
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

const labelsOf = (record: Record<string, string | null>) =>
  Object.values(record).filter((label): label is string => label !== null);

/** A whole number in text: 50 must not match inside 2,500. */
const wholeNumber = (value: string, flags = "u") =>
  new RegExp(`(?<![\\d,])${value}(?![\\d,])`, flags);

describe("help reference pages", () => {
  it("every label constant is on its reference page", () => {
    const expected = [
      {
        markup: render(StatesAndBadges),
        labels: [
          ...labelsOf(ShopWork.ORDER_POSITION_LABEL),
          ...labelsOf(ShopWork.ORDER_ISSUE_LABEL),
          ...labelsOf(ShopWork.RUN_STATE_LABEL),
          ShopWork.RUN_UNSTARTED_LABEL,
          ...labelsOf(ShopWork.TASK_STATE_LABEL),
          ...labelsOf(ShopWork.WORKFLOW_STATE_LABEL),
          ...labelsOf(ShopWork.WORKFLOW_FAULT_LABEL),
          ...labelsOf(STATE_LABEL),
        ],
      },
      {
        markup: render(WhoCanDoWhat),
        labels: [
          ...Object.values(ShopWork.VERB_LABEL).flatMap((label) => labelsOf(label)),
          ...labelsOf(ShopWork.RECORD_VERB_LABEL),
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

  it("every limit a merchant plans around is on the Limits page", () => {
    const markup = render(Limits);
    const limits = [
      Platform.ShopLimits.maxMembers,
      Platform.ShopLimits.maxOpenOrders,
      Platform.WorkflowLimits.maxWorkflows,
      Platform.ShopLimits.maxTeams,
      Platform.ShopLimits.orderRetentionDays,
    ];
    const missing = limits
      .map(Platform.formatNumber)
      .filter((value) => !wholeNumber(value).test(markup));
    expect(missing).toEqual([]);
  });

  it("Plans and billing prints no plan number", () => {
    // Tags and character references go first: `&#x27;` is an apostrophe, not a number.
    const text = render(PlansAndBilling).replaceAll(/<[^>]*>|&[#\w]+;/gu, " ");
    const hardLimits = [Platform.ShopLimits.maxMembers, Platform.ShopLimits.maxOpenOrders].map(
      Platform.formatNumber,
    );
    for (const limit of hardLimits) expect(text).toContain(limit);
    const rest = hardLimits.reduce(
      (remaining, limit) => remaining.replaceAll(wholeNumber(limit, "gu"), " "),
      text,
    );
    expect(rest).not.toMatch(/\d/u);
  });
});
