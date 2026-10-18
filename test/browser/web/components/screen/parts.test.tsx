import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import "../../../../../src/web/styles.css";
import type { ListSearch } from "../../../../../src/domain/shop-work.ts";
import { ClampedProse } from "../../../../../src/web/components/screen/ClampedProse.tsx";
import { ListSearchField } from "../../../../../src/web/components/screen/ListSearchField.tsx";
import { SearchLine } from "../../../../../src/web/components/screen/SearchLine.tsx";
import { Strip } from "../../../../../src/web/components/screen/Strip.tsx";
import {
  textLimitError,
  textLimitProps,
} from "../../../../../src/web/components/screen/TextLimit.tsx";

describe("ListSearchField", () => {
  it("Enter submits the trimmed search, and an emptied field submits no search at once", async () => {
    const submitted: Array<ListSearch | null> = [];
    const screen = await render(
      <ListSearchField
        value={null}
        placeholder="Search by email"
        onSubmit={(q) => submitted.push(q)}
      />,
    );
    const field = screen.getByRole("searchbox", { name: "Search" });
    await field.fill("  ana  ");
    await expect.poll(() => submitted).toStrictEqual([]);
    field
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await expect.poll(() => submitted).toStrictEqual(["ana"]);
  });

  it("a submit of the search already in the URL is dropped", async () => {
    const submitted: Array<ListSearch | null> = [];
    const screen = await render(
      <ListSearchField
        value={"ana" as ListSearch}
        placeholder="Search by email"
        onSubmit={(q) => submitted.push(q)}
      />,
    );
    const field = screen.getByRole("searchbox", { name: "Search" });
    field
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    await field.fill("");
    await expect.poll(() => submitted).toStrictEqual([null]);
  });
});

describe("SearchLine", () => {
  it("says how many rows match, singular and plural, and Clear search clears", async () => {
    let cleared = 0;
    const one = await render(
      <SearchLine
        count={1}
        noun={["member", "members"]}
        term="ana"
        onClear={() => (cleared += 1)}
      />,
    );
    await expect.element(one.getByText("1 member matches ana")).toBeVisible();
    await one.getByRole("button", { name: "Clear search" }).click();
    expect(cleared).toBe(1);
    const many = await render(
      <SearchLine count={1200} noun={["member", "members"]} term="x" onClear={() => {}} />,
    );
    await expect.element(many.getByText("1,200 members match x")).toBeVisible();
  });
});

describe("TextLimit", () => {
  it("refuses past the cap with the field's own error, and counts down only near it", () => {
    expect(textLimitError("a".repeat(254), 254)).toBeNull();
    expect(textLimitError("a".repeat(255), 254)).toBe("Up to 254 characters");
    expect(textLimitProps("a".repeat(10), 1000)).toStrictEqual({});
    expect(textLimitProps("a".repeat(900), 1000)).toStrictEqual({
      details: "100 characters left",
    });
  });
});

describe("Strip", () => {
  const LABELS = ["Started by you", "Started by others", "Ready", "Blocked", "Done or closed"];

  it("fills the chosen cell, says so to a screen reader, and a press selects its value", async () => {
    const selected: string[] = [];
    const screen = await render(
      <Strip
        cells={LABELS.map((label, index) => ({
          key: label,
          label,
          count: index === 4 ? 1200 : index,
          chosen: index === 2,
          onSelect: () => selected.push(label),
        }))}
      />,
    );
    const cells = [...screen.container.querySelectorAll<HTMLElement>("s-clickable")];
    expect(cells.map((cell) => cell.getAttribute("background"))).toStrictEqual([
      "transparent",
      "transparent",
      "subdued",
      "transparent",
      "transparent",
    ]);
    expect(cells.map((cell) => cell.getAttribute("accessibilityLabel"))).toStrictEqual([
      "Started by you, 0",
      "Started by others, 1",
      "Ready, 2, selected",
      "Blocked, 3",
      "Done or closed, 1,200",
    ]);
    cells[3]?.click();
    await expect.poll(() => selected).toStrictEqual(["Blocked"]);
  });

  it("link cells carry their href and click handler, and none is chosen", async () => {
    const clicked: string[] = [];
    const screen = await render(
      <Strip
        cells={LABELS.map((label, index) => ({
          key: label,
          label,
          count: index,
          href: `/app/orders?show=${String(index)}`,
          onClick: (event: Event) => {
            event.preventDefault();
            clicked.push(label);
          },
        }))}
      />,
    );
    const cells = [...screen.container.querySelectorAll<HTMLElement>("s-clickable")];
    expect(cells.map((cell) => cell.getAttribute("href"))).toStrictEqual(
      LABELS.map((_, index) => `/app/orders?show=${String(index)}`),
    );
    expect(cells.every((cell) => cell.getAttribute("background") === "transparent")).toBe(true);
    expect(cells[0]?.getAttribute("accessibilityLabel")).toBe("Started by you, 0");
    await screen.getByRole("link", { name: "Ready, 2" }).click();
    await expect.poll(() => clicked).toStrictEqual(["Ready"]);
  });
});

describe("ClampedProse", () => {
  it("a text that fits draws no toggle", async () => {
    const screen = await render(<ClampedProse>Waiting on artwork</ClampedProse>);
    await expect.element(screen.getByText("Waiting on artwork")).toBeVisible();
    expect(screen.container.querySelector("s-link")).toBeNull();
  });

  it("a text cut at three lines offers Show more, which uncuts it, then Show less", async () => {
    const screen = await render(
      <div style={{ width: "200px" }}>
        <ClampedProse>{"The crest fills in at this depth. ".repeat(20)}</ClampedProse>
      </div>,
    );
    const paragraph = screen.container.querySelector("s-paragraph");
    await screen.getByText("Show more").click();
    await expect.poll(() => paragraph?.getAttribute("lineClamp") ?? null).toBeNull();
    await screen.getByText("Show less").click();
    await expect.poll(() => paragraph?.getAttribute("lineClamp")).toBe("3");
    await expect.element(screen.getByText("Show more")).toBeVisible();
  });
});
