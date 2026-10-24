import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import "../../../../src/web/styles.css";
import type { BlockReason, RunNote } from "../../../../src/domain/shop-work.ts";
import { type RunStepTask, RunSteps } from "../../../../src/web/components/RunSteps.tsx";
import { BlockModal, RunNoteModal } from "../../../../src/web/components/RunTextModals.tsx";

const AT = Date.UTC(2026, 8, 21, 15, 52);

const taskOf = (
  id: string,
  step: number,
  name: string,
  overrides: Partial<Record<keyof RunStepTask, unknown>> = {},
) =>
  ({
    id,
    runId: "run-1",
    position: Number(id.slice(1)),
    step,
    name,
    teamId: "team-1",
    teamName: "Jewelry",
    instructions: null,
    startedAt: null,
    startedByEmail: null,
    startedByRole: null,
    doneAt: null,
    doneByEmail: null,
    doneByRole: null,
    current: false,
    ...overrides,
  }) as unknown as RunStepTask;

const TASKS = [
  taskOf("t1", 1, "Cast", {
    startedAt: AT,
    startedByRole: "member",
    startedByEmail: "lead@m.com",
    doneAt: AT,
    doneByRole: "merchant",
  }),
  taskOf("t2", 2, "Polish", {
    startedAt: AT,
    startedByRole: "member",
    startedByEmail: "m2@m.com",
    current: true,
    instructions: "Mirror finish",
  }),
  taskOf("t3", 2, "Engrave", { current: true }),
  taskOf("t4", 3, "Pack", { teamName: "Shipping" }),
];

/** Each task card's heading, badge and subdued line, in order. */
const cards = (container: HTMLElement) =>
  [...container.querySelectorAll("s-heading")].map((heading) => {
    const card = heading.parentElement?.parentElement;
    return {
      name: heading.textContent,
      badge: card?.querySelector("s-badge")?.textContent ?? null,
      line: card?.querySelector('s-text[color="subdued"]')?.textContent ?? null,
    };
  });

describe("RunSteps", () => {
  it("captions each step, badges every state but waiting, and names the actor by viewer", async () => {
    const screen = await render(
      <RunSteps tasks={TASKS} viewer="merchant" showInstructions renderActions={() => null} />,
    );
    await expect.element(screen.getByText("Step 1")).toBeVisible();
    await expect.element(screen.getByText("Step 3")).toBeVisible();
    expect(screen.container.querySelectorAll('[accessibilityRole="list-item"]')).toHaveLength(3);
    const drawn = cards(screen.container);
    expect(drawn.map(({ name, badge }) => [name, badge])).toStrictEqual([
      ["Cast", "Done"],
      ["Polish", "Started"],
      ["Engrave", "Ready"],
      ["Pack", null],
    ]);
    expect(drawn[0]?.line).toMatch(/^Jewelry · You · Sep 21/u);
    expect(drawn[1]?.line).toMatch(/^Jewelry · m2@m\.com · since \d/u);
    expect(drawn[2]?.line).toBe("Jewelry");
    expect(drawn[3]?.line).toBe("Shipping");
    await expect.element(screen.getByText("Mirror finish")).toBeVisible();
  });

  it("names the merchant to a member, and leaves instructions out when asked", async () => {
    const screen = await render(
      <RunSteps
        tasks={TASKS}
        viewer="member"
        showInstructions={false}
        renderActions={() => null}
      />,
    );
    expect(cards(screen.container)[0]?.line).toMatch(/^Jewelry · Merchant · /u);
    expect(screen.container.textContent).not.toContain("Mirror finish");
  });

  it("draws each task's actions from the slot, and no row where the slot returns null", async () => {
    const screen = await render(
      <RunSteps
        tasks={TASKS}
        viewer="member"
        showInstructions={false}
        renderActions={(task) => (task.current ? <s-button>{`Done ${task.name}`}</s-button> : null)}
      />,
    );
    const buttons = [...screen.container.querySelectorAll("s-button")].map((b) => b.textContent);
    expect(buttons).toStrictEqual(["Done Polish", "Done Engrave"]);
  });
});

type Modal = HTMLElement & { dirty?: boolean; showOverlay: () => void };

const modalOf = (container: HTMLElement, id: string) =>
  container.querySelector<Modal>(`s-modal#${id}`)!;

const primaryOf = (modal: Modal) =>
  modal.querySelector<HTMLElement & { disabled: boolean }>('s-button[slot="primary-action"]')!;

const fieldOf = (modal: Modal) =>
  modal.querySelector<HTMLElement & { error?: string; details?: string }>("s-text-area")!;

const isOpen = (modal: Modal) => modal.shadowRoot?.querySelector("dialog")?.open === true;

/**
 * Opens the modal and waits for `aftershow`, which places the caret: typing before it lands lets
 * the caret move between a `fill`'s select and its insert, and the text is appended.
 */
const open = async (modal: Modal) => {
  const shown = new Promise((resolve) => {
    modal.addEventListener("aftershow", resolve, { once: true });
  });
  modal.showOverlay();
  await shown;
};

describe("RunNoteModal", () => {
  it("opens on the saved note, is dirty and saveable only once changed, and saves the trimmed note", async () => {
    const saved: Array<RunNote | null> = [];
    const screen = await render(
      <RunNoteModal
        id="note"
        note="Rush"
        pending={false}
        onSave={(note) => {
          saved.push(note);
          return Promise.resolve(null);
        }}
      />,
    );
    const modal = modalOf(screen.container, "note");
    await open(modal);
    await expect.poll(() => isOpen(modal)).toBe(true);
    const field = screen.getByRole("textbox", { name: "Note" });
    await expect.element(field).toHaveValue("Rush");
    expect(primaryOf(modal).disabled).toBe(true);
    expect(modal.dirty).toBeUndefined();
    await field.fill("  Rush, gift wrap  ");
    await expect.element(field).toHaveValue("  Rush, gift wrap  ");
    await expect.poll(() => modal.dirty).toBe(true);
    expect(primaryOf(modal).disabled).toBe(false);
    primaryOf(modal).click();
    await expect.poll(() => saved).toStrictEqual(["Rush, gift wrap"]);
    await expect.poll(() => isOpen(modal)).toBe(false);
    expect("dirty" in modal).toBe(false);
  });

  it("a blank note saves as null, which clears it", async () => {
    const saved: Array<RunNote | null> = [];
    const screen = await render(
      <RunNoteModal
        id="note"
        note="Rush"
        pending={false}
        onSave={(note) => {
          saved.push(note);
          return Promise.resolve(null);
        }}
      />,
    );
    const modal = modalOf(screen.container, "note");
    await open(modal);
    await screen.getByRole("textbox", { name: "Note" }).fill("   ");
    primaryOf(modal).click();
    await expect.poll(() => saved).toStrictEqual([null]);
  });

  it("refuses a note past its cap with the field's own error, and counts down near it", async () => {
    let calls = 0;
    const screen = await render(
      <RunNoteModal
        id="note"
        note={null}
        pending={false}
        onSave={() => {
          calls += 1;
          return Promise.resolve(null);
        }}
      />,
    );
    const modal = modalOf(screen.container, "note");
    await open(modal);
    const field = screen.getByRole("textbox", { name: "Note" });
    await field.fill("x".repeat(1900));
    await expect.poll(() => fieldOf(modal).details).toBe("100 characters left");
    await field.fill("x".repeat(2001));
    primaryOf(modal).click();
    await expect.poll(() => fieldOf(modal).error).toBe("Up to 2,000 characters");
    expect(calls).toBe(0);
    expect(isOpen(modal)).toBe(true);
  });

  it("shows a refused write's message under the field and stays open; typing clears it", async () => {
    const screen = await render(
      <RunNoteModal
        id="note"
        note={null}
        pending={false}
        onSave={() => Promise.resolve("This workflow no longer exists")}
      />,
    );
    const modal = modalOf(screen.container, "note");
    await open(modal);
    const field = screen.getByRole("textbox", { name: "Note" });
    await field.fill("Rush");
    primaryOf(modal).click();
    await expect.poll(() => fieldOf(modal).error).toBe("This workflow no longer exists");
    expect(isOpen(modal)).toBe(true);
    expect(modal.dirty).toBe(true);
    await field.fill("Rush order");
    await expect.poll(() => fieldOf(modal).error ?? "").toBe("");
  });
});

describe("BlockModal", () => {
  const run = {
    orderName: "#1008",
    lineItemTitle: "Signet ring",
    variantTitle: "Gold",
    quantity: 2,
  };

  it("asks about the order, names the item, and blocks with no reason as null", async () => {
    const reasons: Array<BlockReason | null> = [];
    const screen = await render(
      <BlockModal
        id="block"
        run={run}
        pending={false}
        onBlock={(reason) => {
          reasons.push(reason);
          return Promise.resolve(null);
        }}
      />,
    );
    const modal = modalOf(screen.container, "block");
    expect(modal.getAttribute("heading")).toBe("Block #1008?");
    await open(modal);
    await expect.element(screen.getByText("Signet ring · Gold ×2")).toBeVisible();
    expect(primaryOf(modal).disabled).toBe(false);
    expect(primaryOf(modal).textContent).toBe("Block");
    primaryOf(modal).click();
    await expect.poll(() => reasons).toStrictEqual([null]);
    await expect.poll(() => isOpen(modal)).toBe(false);
  });

  it("is dirty once a reason is typed, refuses one past its cap, and shows a refusal", async () => {
    const reasons: Array<BlockReason | null> = [];
    const screen = await render(
      <BlockModal
        id="block"
        run={run}
        pending={false}
        onBlock={(reason) => {
          reasons.push(reason);
          return Promise.resolve("The workflow changed on another screen");
        }}
      />,
    );
    const modal = modalOf(screen.container, "block");
    await open(modal);
    const field = screen.getByRole("textbox", { name: "Reason" });
    await field.fill("y".repeat(1001));
    await expect.poll(() => modal.dirty).toBe(true);
    primaryOf(modal).click();
    await expect.poll(() => fieldOf(modal).error).toBe("Up to 1,000 characters");
    expect(reasons).toStrictEqual([]);
    await field.fill(" Waiting on artwork ");
    primaryOf(modal).click();
    await expect.poll(() => fieldOf(modal).error).toBe("The workflow changed on another screen");
    expect(reasons).toStrictEqual(["Waiting on artwork"]);
    expect(isOpen(modal)).toBe(true);
  });
});
