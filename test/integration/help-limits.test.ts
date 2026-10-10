import { createElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Limits } from "@/components/help/reference/limits";
import { PlansAndBilling } from "@/components/help/reference/plans-and-billing";
import * as Domain from "@/lib/Domain";

/**
 * The two number-bearing reference pages. Limits reads every number from
 * its constant through `Domain.formatNumber`, so a changed constant changes
 * the page. Plans and billing prints the two hard limits and no plan number,
 * because a plan's numbers live in the Partner Dashboard and change without
 * a deploy (the home page's rule).
 */
describe("help reference: limits and billing", () => {
  it("every limit a merchant plans around is on the Limits page", () => {
    const markup = renderToStaticMarkup(createElement(Limits));
    const limits = [
      Domain.ShopLimits.maxMembers,
      Domain.ShopLimits.maxOpenOrders,
      Domain.WorkflowLimits.maxWorkflows,
      Domain.ShopLimits.maxTeams,
      Domain.ShopLimits.orderRetentionDays,
    ];
    const missing = limits
      .map(Domain.formatNumber)
      .filter(
        (value) =>
          !new RegExp(`(?<![\\d,])${value}(?![\\d,])`, "u").test(markup),
      );
    expect(missing).toEqual([]);
  });

  it("Plans and billing prints no plan number", () => {
    const markup = renderToStaticMarkup(createElement(PlansAndBilling));
    /** Tags and character references go first: `&#x27;` is an apostrophe, not a number. */
    const text = markup.replaceAll(/<[^>]*>|&[#\w]+;/gu, " ");
    const hardLimits = [
      Domain.ShopLimits.maxMembers,
      Domain.ShopLimits.maxOpenOrders,
    ].map(Domain.formatNumber);
    for (const limit of hardLimits) expect(text).toContain(limit);
    /** Whole numbers only: 50 must not match inside 2,500. */
    const rest = hardLimits.reduce(
      (remaining, limit) =>
        remaining.replaceAll(
          new RegExp(`(?<![\\d,])${limit}(?![\\d,])`, "gu"),
          " ",
        ),
      text,
    );
    expect(rest).not.toMatch(/\d/u);
  });
});
