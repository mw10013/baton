import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import "../../../../src/web/styles.css";
import type { WorkflowsListPageData } from "../../../../src/contract/workflows-list.ts";
import { Email } from "../../../../src/domain/platform.ts";
import {
  MemberId,
  RUN_PAGE,
  TeamId,
  TeamName,
  type WorkflowsListData,
} from "../../../../src/domain/shop-work.ts";
import { ResourceRow, RowLine } from "../../../../src/web/components/screen/ResourceRow.tsx";
import { ShowMore } from "../../../../src/web/components/screen/ShowMore.tsx";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import WorkflowsListPage, {
  type WorkflowsListPatch,
} from "../../../../src/web/components/WorkflowsListPage.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

describe("ResourceRow", () => {
  it("the row is one link and its menu sits beside it, outside the clickable", async () => {
    const navigated: Array<string> = [];
    const screen = await render(
      <ResourceRow
        head={{ lead: "#1001", title: "Signet ring", trail: "×2" }}
        menu={{
          label: "Actions for #1001",
          disabled: false,
          items: <s-button>Start</s-button>,
        }}
        href="/shop/x/workflows/run-1"
        onNavigate={() => navigated.push("row")}
        accessibilityLabel="Open Signet ring ×2 on #1001"
      >
        <RowLine>Cut</RowLine>
      </ResourceRow>,
    );
    const row = screen.container.querySelector("[data-part=resource-row]");
    const menu = row?.querySelector("s-menu");
    expect(menu).not.toBeNull();
    expect(menu?.closest("s-clickable")).toBeNull();
    expect(row?.querySelector("s-clickable s-button")).not.toBeNull();

    await screen.getByRole("button", { name: "Actions for #1001" }).click();
    expect(navigated).toStrictEqual([]);
    await screen.getByRole("link", { name: "Open Signet ring ×2 on #1001" }).click();
    expect(navigated).toStrictEqual(["row"]);
  });
});

describe("ShowMore", () => {
  it("asks for the next page, or at the deepest read says how to narrow in its place", async () => {
    let pressed = 0;
    const more = await render(
      <ShowMore hidden={30} page={RUN_PAGE} end={null} onShowMore={() => pressed++} />,
    );
    await more.getByRole("button", { name: "Show 25 more of 30" }).click();
    expect(pressed).toBe(1);
    await more.unmount();

    const end = await render(
      <ShowMore
        hidden={3}
        page={RUN_PAGE}
        end="Showing 100 of 103. Search to find the rest."
        onShowMore={() => pressed++}
      />,
    );
    await expect
      .element(end.getByText("Showing 100 of 103. Search to find the rest."))
      .toBeVisible();
    expect(end.container.querySelector("s-button")).toBeNull();
  });
});

const team = (id: string, name: string) => ({
  id: Schema.decodeUnknownSync(TeamId)(id),
  name: Schema.decodeUnknownSync(TeamName)(name),
});

const emptyList = (counts: Partial<WorkflowsListData["counts"]> = {}): WorkflowsListData => ({
  counts: { started_by_you: 0, started_by_others: 0, ready: 0, blocked: 0, done: 0, ...counts },
  items: [],
  recent: [],
  matches: null,
});

const pageData = (
  list: WorkflowsListData,
  teams: WorkflowsListPageData["teams"],
): WorkflowsListPageData => ({
  memberId: Schema.decodeUnknownSync(MemberId)("member-1"),
  memberEmail: Schema.decodeUnknownSync(Email)("m1@m.com"),
  teams,
  query: { state: "started_by_you", team: null, limit: RUN_PAGE, q: null },
  list,
});

const renderList = (data: WorkflowsListPageData, patches: Array<WorkflowsListPatch> = []) =>
  renderInApp(
    <ShopSocket shop={SEED_SHOP} merchantToken={Option.none()}>
      <WorkflowsListPage
        data={data}
        onSearch={(patch) => patches.push(patch)}
        workflowLink={(runId) => ({ href: `/shop/x/workflows/${runId}`, onNavigate: () => {} })}
      />
    </ShopSocket>,
    shopTestRegistry({ MemberListRuns: () => Effect.succeed(data.list) }),
  );

describe("WorkflowsListPage", () => {
  it("the strip names the five states in order, the chosen one selected, and a cell chooses its state", async () => {
    const patches: Array<WorkflowsListPatch> = [];
    const screen = await renderList(
      pageData(emptyList({ ready: 3, done: 1 }), [team("t1", "Cut")]),
      patches,
    );
    for (const name of [
      "Started by you, 0, selected",
      "Started by others, 0",
      "Ready, 3",
      "Blocked, 0",
      "Done or closed, 1",
    ])
      await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Blocked, 0", exact: true }).click();
    expect(patches).toStrictEqual([{ state: "blocked" }]);
  });

  it("an empty state says so and points at Ready when Ready holds work", async () => {
    const patches: Array<WorkflowsListPatch> = [];
    const screen = await renderList(
      pageData(emptyList({ ready: 2 }), [team("t1", "Cut")]),
      patches,
    );
    await expect.element(screen.getByText("Nothing started by you.")).toBeVisible();
    await screen.getByRole("button", { name: "Go to Ready" }).click();
    expect(patches).toStrictEqual([{ state: "ready" }]);
  });

  it("the Team select is there for a member on two or more teams only", async () => {
    const two = await renderList(pageData(emptyList(), [team("t1", "Cut"), team("t2", "Pack")]));
    await expect.element(two.getByRole("combobox", { name: "Team" })).toBeInTheDocument();
    await two.unmount();
    const one = await renderList(pageData(emptyList(), [team("t1", "Cut")]));
    await expect.element(one.getByText("Nothing started by you.")).toBeVisible();
    expect(one.container.querySelector("s-select")).toBeNull();
  });

  it("a member on no team reads that they are not on a team yet, and no strip", async () => {
    const screen = await renderList(pageData(emptyList(), []));
    await expect
      .element(screen.getByText("You’re not on a team yet. Ask the merchant to add you to a team."))
      .toBeVisible();
    expect(screen.container.querySelector("s-clickable")).toBeNull();
  });
});
