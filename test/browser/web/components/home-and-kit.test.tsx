import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import "../../../../src/web/styles.css";
import { KitPage } from "../../../../src/web/components/KitPage.tsx";
import {
  SetupGuide,
  type SetupGuideStep,
} from "../../../../src/web/components/screen/SetupGuide.tsx";

const steps = (done: ReadonlyArray<boolean>): readonly SetupGuideStep[] =>
  [
    { key: "a", sentence: "Create a team and add a member", link: { label: "Teams", href: "/a" } },
    {
      key: "b",
      sentence: "Create a workflow and turn it on",
      link: { label: "Workflows", href: "/b" },
    },
    {
      key: "c",
      sentence: "An item gets a workflow",
      body: "New orders arrive as they are placed.",
    },
  ].map((step, index) => ({
    ...step,
    done: done[index] === true,
    state: done[index] === true ? "Done" : "Not done",
  }));

describe("SetupGuide", () => {
  it("shows the count and each step's state; a done step keeps its place and loses its link", async () => {
    const screen = await render(
      <SetupGuide
        heading="Getting started"
        count="1 of 3 done"
        steps={steps([true, false, false])}
      />,
    );
    await expect.element(screen.getByText("1 of 3 done")).toBeVisible();
    await expect.element(screen.getByText("Create a team and add a member")).toBeVisible();
    await expect.element(screen.getByText("New orders arrive as they are placed.")).toBeVisible();
    expect(screen.container.querySelectorAll("s-link")).toHaveLength(1);
    expect(screen.container.querySelector("s-link")?.textContent).toBe("Workflows");
    const states = [
      ...screen.container.querySelectorAll('s-text[accessibilityVisibility="exclusive"]'),
    ].map((el) => el.textContent);
    expect(states).toStrictEqual(["Done", "Not done", "Not done"]);
  });

  it("a step with no link and no help draws no link line", async () => {
    const screen = await render(
      <SetupGuide
        heading="Getting started"
        count="2 of 3 done"
        steps={steps([true, true, false])}
      />,
    );
    expect(screen.container.querySelectorAll("s-link")).toHaveLength(0);
  });
});

describe("KitPage", () => {
  it("renders every part and run piece at both widths without an error", async () => {
    for (const width of ["small", "large"] as const) {
      const screen = await render(<KitPage width={width} />);
      expect(screen.container.querySelector('s-page[heading="Kit"]')).not.toBeNull();
      expect(screen.container.querySelectorAll("s-section").length).toBeGreaterThan(5);
      expect(
        screen.container.querySelectorAll(
          '[accessibilityRole="ordered-list"] > [accessibilityRole="list-item"]',
        ),
      ).toHaveLength(3);
      // The home strip's five link cells, the two resource rows and the two meter tiles.
      expect(screen.container.querySelectorAll("s-clickable[href]")).toHaveLength(9);
      expect(screen.container.querySelectorAll("progress.capacity-meter")).toHaveLength(2);
      expect(screen.container.querySelector('s-banner[heading="Blocked"]')).not.toBeNull();
      expect(screen.container.querySelectorAll("s-modal")).toHaveLength(2);
      await screen.unmount();
    }
  });
});
