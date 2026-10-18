import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import "../../../../../src/web/styles.css";
import type { ListSearch } from "../../../../../src/domain/shop-work.ts";
import { ListSearchField } from "../../../../../src/web/components/screen/ListSearchField.tsx";
import { SearchLine } from "../../../../../src/web/components/screen/SearchLine.tsx";
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
