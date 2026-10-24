import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  type ApplyResult,
  type DiscardResult,
  type TaskResult,
  type TaskWithTeamName,
  Workflow,
  type WorkflowPageData,
} from "../../../../src/domain/shop-work.ts";
import { ShopSocket } from "../../../../src/web/components/ShopSocket.tsx";
import WorkflowEditorPage from "../../../../src/web/components/WorkflowEditorPage.tsx";
import { installAppBridge } from "../../app-bridge.ts";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

const workflow = Schema.decodeUnknownSync(Workflow)({
  id: "wf-1",
  name: "Engraved ring",
  tag: "engraved",
  state: "active",
  updatedAt: 0,
});

const taskOf = (name: string, step: number) =>
  ({
    id: `task-${name}`,
    position: step,
    step,
    name,
    teamId: "team-bench",
    instructions: null,
    teamName: "Bench",
    memberCount: 1,
  }) as unknown as TaskWithTeamName;

/** An applied workflow with a draft that adds Polish: what a stale tab shows after another discarded it. */
const withDraft: WorkflowPageData = {
  workflow,
  tasksRevision: 3,
  tasks: [taskOf("Cut", 1)],
  draftTasks: [taskOf("Cut", 1), taskOf("Polish", 2)],
  teams: [{ id: "team-bench", name: "Bench", memberCount: 1 } as never],
};

/** Modals closed through the element's `hideOverlay`, which is how the editor closes one. */
let hidden: Array<string> = [];

/** Presses a modal's primary action, recording its close: the button that opens it lives in the title bar. */
const pressModal = (container: HTMLElement, id: string) => {
  const modal = container.querySelector<HTMLElement & { hideOverlay?: () => void }>(
    `s-modal#${id}`,
  );
  if (modal === null) throw new Error(`no modal ${id}`);
  modal.hideOverlay = () => hidden.push(id);
  modal.querySelector<HTMLElement>('s-button[slot="primary-action"]')?.click();
};

beforeEach(() => {
  hidden = [];
  sent = [];
  installAppBridge();
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "shopify");
});

/** The revision each write sent, in order. */
let sent: Array<number> = [];

const render = (
  answers: { apply?: ApplyResult; discard?: DiscardResult; move?: TaskResult },
  calls: Array<string>,
  reread: () => Promise<void> = async () => {},
) =>
  renderInApp(
    <ShopSocket shop={SEED_SHOP} merchantToken={Option.some(Effect.succeed("token"))}>
      <WorkflowEditorPage
        detail={withDraft}
        inWindow={false}
        closeLink={{ href: "/app/workflows/wf-1", onClick: (event) => event.preventDefault() }}
        teamsLink={{ href: "/app/teams", onClick: (event) => event.preventDefault() }}
        onChanged={async () => {
          calls.push("changed");
          await reread();
        }}
        onApplied={async () => {
          calls.push("applied");
        }}
        onDeleted={async () => {}}
      />
    </ShopSocket>,
    shopTestRegistry({
      MerchantApplyDraft: ({ tasksRevision }) =>
        Effect.sync(() => {
          sent.push(tasksRevision);
          return answers.apply ?? { _tag: "NoDraft" };
        }),
      MerchantDiscardDraft: ({ tasksRevision }) =>
        Effect.sync(() => {
          sent.push(tasksRevision);
          return answers.discard ?? { _tag: "NoDraft" };
        }),
      MerchantMoveTask: ({ tasksRevision }) =>
        Effect.sync(() => {
          sent.push(tasksRevision);
          return answers.move ?? { _tag: "Ok", task: null };
        }),
    }),
  );

describe("WorkflowEditorPage", () => {
  it("Apply refused because the draft is gone closes the dialog, shows why and re-reads", async () => {
    const calls: Array<string> = [];
    const screen = await render({ apply: { _tag: "NoDraft" } }, calls);
    pressModal(screen.container, "apply-draft");
    await expect.poll(() => calls).toStrictEqual(["changed"]);
    expect(hidden).toStrictEqual(["apply-draft"]);
    await expect.element(screen.getByText("There are no changes to apply.")).toBeVisible();
  });

  it("Apply that succeeds closes the dialog and hands on to the workflow page", async () => {
    const calls: Array<string> = [];
    const screen = await render({ apply: { _tag: "Ok", workflow } }, calls);
    pressModal(screen.container, "apply-draft");
    await expect.poll(() => calls).toStrictEqual(["applied"]);
    expect(hidden).toStrictEqual(["apply-draft"]);
  });

  it("Discard refused because the draft is gone closes the dialog, shows why and re-reads", async () => {
    const calls: Array<string> = [];
    const screen = await render({ discard: { _tag: "NoDraft" } }, calls);
    pressModal(screen.container, "discard-draft");
    await expect.poll(() => calls).toStrictEqual(["changed"]);
    expect(hidden).toStrictEqual(["discard-draft"]);
    await expect.element(screen.getByText("There are no changes to discard.")).toBeVisible();
  });

  it("Apply refused as changed sent the revision on screen, closes the dialog, says so and re-reads", async () => {
    const calls: Array<string> = [];
    const screen = await render({ apply: { _tag: "Changed" } }, calls);
    pressModal(screen.container, "apply-draft");
    await expect.poll(() => calls).toStrictEqual(["changed"]);
    expect(sent).toStrictEqual([3]);
    expect(hidden).toStrictEqual(["apply-draft"]);
    await expect
      .element(
        screen.getByText(
          "This workflow changed since you opened it. Check the steps and try again.",
        ),
      )
      .toBeVisible();
  });

  it("a task write refused as changed says so; the editor stays busy until the re-read lands", async () => {
    const calls: Array<string> = [];
    let landed = () => {};
    const screen = await render({ move: { _tag: "Changed" } }, calls, async () => {
      await new Promise<void>((resolve) => {
        landed = resolve;
      });
    });
    await screen.getByRole("button", { name: "Edit Polish" }).click();
    const earlier = screen.getByRole("button", { name: "Move earlier" });
    await earlier.click();
    await expect.poll(() => calls).toStrictEqual(["changed"]);
    expect(sent).toStrictEqual([3]);
    await expect
      .element(
        screen.getByText(
          "This workflow changed since you opened it. Check the steps and try again.",
        ),
      )
      .toBeVisible();
    await expect.element(earlier).toHaveAttribute("disabled");
    landed();
    await expect.element(earlier).not.toHaveAttribute("disabled");
  });
});
