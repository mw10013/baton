import { createElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Limits } from "@/components/help/reference/limits";
import { PlansAndBilling } from "@/components/help/reference/plans-and-billing";
import * as Domain from "@/lib/Domain";
import { ORDER_SYNC_WINDOW_DAYS } from "@/lib/orderSyncConstants";

/**
 * The two number-bearing reference pages. Limits reads every number from
 * its constant through `Domain.formatNumber`, so a changed constant changes
 * the page; Plans and billing prints none, because a plan's numbers live in
 * the Partner Dashboard and change without a deploy (the home page's rule).
 */
describe("help reference: limits and billing", () => {
  it("every limit is on the Limits page", () => {
    const markup = renderToStaticMarkup(createElement(Limits));
    const limits = [
      Domain.NAME_MAX_LENGTH,
      Domain.TEAM_NAME_MAX_LENGTH,
      Domain.TAG_MAX_LENGTH,
      Domain.TASK_INSTRUCTIONS_MAX_LENGTH,
      Domain.RUN_NOTE_MAX_LENGTH,
      Domain.BLOCK_REASON_MAX_LENGTH,
      Domain.EMAIL_MAX_LENGTH,
      Domain.ShopLimits.maxMembers,
      Domain.ShopLimits.maxConnectionsPerMember,
      Domain.ShopLimits.maxSessionsPerMember,
      Domain.ShopLimits.maxTeams,
      Domain.WorkflowLimits.maxWorkflows,
      Domain.WorkflowLimits.maxTasks,
      Domain.ShopLimits.maxLineItemsPerOrder,
      Domain.ShopLimits.maxOpenOrders,
      ORDER_SYNC_WINDOW_DAYS,
      Domain.ShopLimits.orderRetentionDays,
      Domain.DONE_WINDOW_MS / 3_600_000,
    ];
    const missing = limits
      .map(Domain.formatNumber)
      .filter(
        (value) =>
          !new RegExp(`(?<![\\d,])${value}(?![\\d,])`, "u").test(markup),
      );
    expect(missing).toEqual([]);
    expect(markup).toContain(
      Domain.formatKilobytes(Domain.ShopLimits.maxPropertiesBytesPerItem),
    );
  });

  it("Plans and billing prints no number", () => {
    const markup = renderToStaticMarkup(createElement(PlansAndBilling));
    /** Tags and character references go first: `&#x27;` is an apostrophe, not a number. */
    const text = markup.replaceAll(/<[^>]*>|&[#\w]+;/gu, " ");
    expect(text).not.toMatch(/\d/u);
  });
});
