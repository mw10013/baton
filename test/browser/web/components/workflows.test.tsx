import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  type SwitchResult,
  type TaskWithTeamName,
  Workflow,
  type WorkflowResult,
  type WorkflowTag as Tag,
} from "../../../../src/domain/shop-work.ts";
import { SelectableCard } from "../../../../src/web/components/screen/SelectableCard.tsx";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import { WorkflowSwitch } from "../../../../src/web/components/WorkflowSwitch.tsx";
import { WorkflowTag } from "../../../../src/web/components/WorkflowTag.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

const workflowOf = (state: "active" | "inactive") =>
  Schema.decodeUnknownSync(Workflow)({
    id: "wf-1",
    name: "Engraved ring",
    tag: "engraved",
    state,
    updatedAt: 0,
  });

const taskOf = (name: string, teamName: string | null) =>
  ({
    id: `task-${name}`,
    position: 1,
    step: 1,
    name,
    teamId: teamName === null ? null : `team-${teamName}`,
    instructions: null,
    teamName,
    memberCount: 1,
  }) as unknown as TaskWithTeamName;

/** Presses a modal's primary action: the button that opens it lives in the title bar. */
const pressModal = (container: HTMLElement, id: string) =>
  container
    .querySelector(`s-modal#${id}`)
    ?.querySelector<HTMLElement>('s-button[slot="primary-action"]')
    ?.click();

describe("SelectableCard", () => {
  it("says whether it is chosen through aria-pressed, and a press selects", async () => {
    let selected = 0;
    const screen = await render(
      <SelectableCard
        selected={false}
        accessibilityLabel="Edit Cut"
        onSelect={() => (selected += 1)}
      >
        Cut
      </SelectableCard>,
    );
    const card = screen.container.querySelector<HTMLElement>("s-clickable");
    expect(card?.getAttribute("aria-pressed")).not.toBe("true");
    card?.click();
    await expect.poll(() => selected).toBe(1);
    const chosen = await render(
      <SelectableCard selected accessibilityLabel="Edit Cut" onSelect={() => {}}>
        Cut
      </SelectableCard>,
    );
    expect(chosen.container.querySelector("s-clickable")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});

describe("WorkflowSwitch", () => {
  const renderSwitch = (
    state: "active" | "inactive",
    tasks: ReadonlyArray<TaskWithTeamName>,
    answer: SwitchResult,
    calls: Array<string>,
    messages: Array<string | null>,
    appliesFirst = false,
  ) =>
    renderInApp(
      <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
        <WorkflowSwitch
          workflow={workflowOf(state)}
          tasks={tasks}
          turnOnBody="Every open order starts this workflow."
          slot="primary-action"
          appliesFirst={appliesFirst ? { tasksRevision: 3 } : undefined}
          onChanged={async () => {
            calls.push("changed");
          }}
          onMessage={(message) => messages.push(message)}
        />
      </ShopSocket>,
      shopTestRegistry({
        MerchantSetWorkflowState: ({ state: next }) =>
          Effect.sync(() => {
            calls.push(`SetWorkflowState ${next}`);
            return answer;
          }),
        MerchantApplyAndTurnOn: () =>
          Effect.sync(() => {
            calls.push("ApplyAndTurnOn");
            return answer;
          }),
      }),
    );

  it("an inactive workflow with no tasks offers Turn on workflow disabled", async () => {
    const screen = await renderSwitch("inactive", [], { _tag: "NoTasks" }, [], []);
    await expect
      .element(screen.getByRole("button", { name: "Turn on workflow" }))
      .toHaveAttribute("disabled");
  });

  it("an inactive workflow whose tasks all have a team offers Turn on workflow enabled", async () => {
    const screen = await renderSwitch(
      "inactive",
      [taskOf("Cut", "Bench")],
      { _tag: "NoTasks" },
      [],
      [],
    );
    await expect
      .element(screen.getByRole("button", { name: "Turn on workflow" }))
      .not.toHaveAttribute("disabled");
  });

  it("an active workflow offers Turn off workflow; Turn off writes inactive and re-reads", async () => {
    const calls: Array<string> = [];
    const messages: Array<string | null> = [];
    const screen = await renderSwitch(
      "active",
      [taskOf("Cut", "Bench")],
      { _tag: "Ok", workflow: workflowOf("inactive") },
      calls,
      messages,
    );
    await expect.element(screen.getByRole("button", { name: "Turn off workflow" })).toBeVisible();
    pressModal(screen.container, "turn-off-workflow");
    await expect.poll(() => calls).toStrictEqual(["SetWorkflowState inactive", "changed"]);
    expect(messages).toStrictEqual([null]);
  });

  it("Turn on refused for an unassigned task names it; a never-applied workflow applies first", async () => {
    const calls: Array<string> = [];
    const messages: Array<string | null> = [];
    const screen = await renderSwitch(
      "inactive",
      [taskOf("Cut", "Bench")],
      { _tag: "TaskUnassigned", taskNames: ["Cut"] as never },
      calls,
      messages,
      true,
    );
    pressModal(screen.container, "turn-on-workflow");
    await expect.poll(() => calls).toStrictEqual(["ApplyAndTurnOn", "changed"]);
    expect(messages).toStrictEqual(["Assign a team to Cut."]);
  });
});

describe("WorkflowTag", () => {
  const renderTag = (answer: WorkflowResult, saved: Array<string>) =>
    render(
      <WorkflowTag
        tag="engraved"
        disabled={false}
        onSave={async (tag: Tag) => {
          saved.push(tag);
          return answer;
        }}
      />,
    );

  it("Edit tag opens with the tag, and a tag another workflow holds is refused under the field", async () => {
    const saved: Array<string> = [];
    const screen = await renderTag(
      { _tag: "TagTaken", tag: "rush" as Tag, workflowName: "Rush" as never },
      saved,
    );
    await screen.getByRole("button", { name: "Edit tag" }).click();
    const field = screen.getByRole("textbox", { name: "Tag" });
    await expect.element(field).toHaveValue("engraved");
    await field.fill("rush");
    await screen.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => saved).toStrictEqual(["rush"]);
    await expect
      .element(screen.getByText("“rush” is already Rush's tag. Choose another."))
      .toBeVisible();
  });

  it("a comma is refused before any write", async () => {
    const saved: Array<string> = [];
    const screen = await renderTag({ _tag: "NotFound" }, saved);
    await screen.getByRole("button", { name: "Edit tag" }).click();
    await screen.getByRole("textbox", { name: "Tag" }).fill("a, b");
    await screen.getByRole("button", { name: "Save" }).click();
    await expect.element(screen.getByText("A tag can't have a comma.")).toBeVisible();
    expect(saved).toStrictEqual([]);
  });
});
