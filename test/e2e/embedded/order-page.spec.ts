import type { BrowserContext, FrameLocator, Locator, Page } from "playwright/test";

import { VERB_LABEL } from "../../../src/domain/shop-work.ts";
import { expect, type Run, test, testEmail } from "../fixtures.ts";
import { openApp } from "./app.ts";
import {
  add,
  itemCard,
  listContext,
  openOrder,
  openOrders,
  own,
  ownBase,
  showOpen,
  stripCell,
} from "./orders-screens.ts";

/**
 * The order page inside the Shopify admin: legacy `e2e/orders.spec.ts`'s order page cases, titles
 * unchanged. Each test adds its own team, members, workflows and orders with `AddToFixture`, under
 * names, tags and order numbers of its own, opens its order from the orders index's search, and
 * asserts on nothing it did not add. The item titles are legacy's: a page shows one order.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let frame: FrameLocator;

test.beforeAll(async ({ browser }) => {
  ({ context, page } = await openApp(browser));
});

test.afterAll(async () => {
  await context.close();
});

/** A button inside one item's card, by its exact label. */
const button = (scope: Locator, name: string) => scope.getByRole("button", { name, exact: true });

/** Adds a team per name, each with the test's member, and returns the member. */
const teamsOf = (names: ReadonlyArray<string>, member = testEmail("order")) => ({
  members: [member],
  teams: names.map((name) => ({ name, members: [member] })),
});

/** Adds `parts` and the order `n`, then opens its page. */
const addAndOpen = async (backend: Run, n: number, parts: Record<string, unknown>) => {
  await add(backend, parts);
  frame = await openOrder(page, n);
};

/**
 * The merchant's interventions end to end, against a two-step run: Manage opens, Done records
 * the merchant on the task, Reopen takes it back. Each assertion reads the row's own attribution
 * rather than a toast, because the row is what the next person to look at this order will see.
 */
test("the merchant marks a task done, reopens it, and blocks the run", async ({ backend }) => {
  const id = own();
  const cut = `E2E Manage Cut ${id}`;
  const polish = `E2E Manage Polish ${id}`;
  const n = ownBase() + 1;
  await addAndOpen(backend, n, {
    ...teamsOf([cut, polish]),
    workflows: [
      {
        name: `E2E Manage Cuff ${id}`,
        tag: `e2e-manage-${id}`,
        tasks: [
          { name: "Cut", team: cut },
          { name: "Polish", team: polish },
        ],
      },
    ],
    orders: [{ n, lineItems: [{ title: "E2E Cuff", quantity: 1, tags: [`e2e-manage-${id}`] }] }],
  });

  // Collapsed, the run offers nothing to click but the drawer: every action lives behind Manage.
  await expect(
    frame.getByRole("button", { name: VERB_LABEL.done.merchant, exact: true }),
  ).toBeHidden();
  await frame.getByRole("button", { name: "Manage" }).click();

  // The drawer draws the member page's step cards. A task that has a team shows it as a line,
  // not an open select: a filled field is changed in the Assign team modal, which opens on the
  // current team.
  await expect(frame.getByText("Step 1", { exact: true })).toBeVisible();
  await expect(frame.getByRole("combobox", { name: "Assign team" })).toHaveCount(0);
  const item = itemCard(frame, "E2E Cuff");
  await item.getByRole("button", { name: "Assign team" }).first().click();
  const assign = frame.locator("s-modal#assign-task");
  const team = assign.getByRole("combobox", { name: "Team" });
  await expect(team).toBeVisible();
  await expect(team.locator("option:checked")).toHaveText(cut);
  await assign.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(team).toBeHidden();

  // The badge carries the state; the line under it is the team, then who.
  const doneByYou = frame.getByText(`${cut} · You · `);
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();
  await frame.getByRole("button", { name: VERB_LABEL.done.merchant, exact: true }).first().click();
  await expect(doneByYou).toBeVisible();

  await frame.getByRole("button", { name: "Reopen" }).click();
  await expect(doneByYou).toBeHidden();
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();

  // Both steps done takes the run to done, in merchant words: the now line counts the steps.
  await frame.getByRole("button", { name: VERB_LABEL.done.merchant, exact: true }).first().click();
  await expect(doneByYou).toBeVisible();
  await frame.getByRole("button", { name: VERB_LABEL.done.merchant, exact: true }).first().click();
  await expect(frame.getByText("Done · 2 steps", { exact: true })).toBeVisible();
});

/**
 * Put back from Manage, the merchant's inverse of a worker's Start. There is no merchant Start,
 * so the fixture has the member start the task; Put back returns it to Ready.
 */
test("the merchant puts back a task a member started", async ({ backend }) => {
  const id = own();
  const member = testEmail("putback");
  const cut = `E2E Put Back Cut ${id}`;
  const n = ownBase() + 1;
  await addAndOpen(backend, n, {
    ...teamsOf([cut], member),
    workflows: [
      {
        name: `E2E Put Back Cuff ${id}`,
        tag: `e2e-putback-${id}`,
        tasks: [{ name: "Cut", team: cut }],
      },
    ],
    orders: [
      {
        n,
        started: true,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: [`e2e-putback-${id}`] }],
      },
    ],
  });
  await frame.getByRole("button", { name: "Manage" }).click();

  // The task's line rather than its Started badge: team, who started it, since when.
  await expect(frame.getByText(`${cut} · ${member} · since`)).toBeVisible();
  await frame.getByRole("button", { name: "Put back" }).click();
  await expect(frame.getByText("Ready", { exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "Put back" })).toHaveCount(0);
});

/**
 * Reopen is not offered once a later step has a task started or done, the same rule the worker's
 * Undo obeys, and no screen names the task in the way. Both steps are done, so Cut offers nothing
 * and Polish, the last step, offers Reopen.
 */
test("the merchant cannot reopen a task whose next step is done", async ({ backend }) => {
  const id = own();
  const cut = `E2E Reopen Cut ${id}`;
  const polish = `E2E Reopen Polish ${id}`;
  const n = ownBase() + 1;
  await addAndOpen(backend, n, {
    ...teamsOf([cut, polish]),
    workflows: [
      {
        name: `E2E Reopen Cuff ${id}`,
        tag: `e2e-reopen-${id}`,
        tasks: [
          { name: "Cut", team: cut },
          { name: "Polish", team: polish },
        ],
      },
    ],
    orders: [
      {
        n,
        advance: 2,
        lineItems: [{ title: "E2E Cuff", quantity: 1, tags: [`e2e-reopen-${id}`] }],
      },
    ],
  });
  await frame.getByRole("button", { name: "Manage" }).click();

  await expect(frame.getByText("Can’t reopen", { exact: false })).toHaveCount(0);
  await expect(frame.getByRole("button", { name: "Reopen" })).toHaveCount(1);
});

/**
 * Block from the drawer, then unblock from the red banner the block raises on the card, the
 * `BlockBanner` the member page shows too. The banner offers no Edit reason: a new reason is
 * Unblock, then Block. The now line still says where the run is. Unblock is on the page once, in
 * the banner: the Manage row drops Block while blocked and never repeats Unblock. Nothing in the
 * Manage row is red. The run note is always on the card, blank as its "Edit note" button alone.
 */
test("the merchant blocks a run with a reason, notes the run, and unblocks it", async ({
  backend,
}) => {
  const id = own();
  const bench = `E2E Block Bench ${id}`;
  const n = ownBase() + 1;
  await addAndOpen(backend, n, {
    ...teamsOf([bench]),
    workflows: [
      {
        name: `E2E Block Cuff ${id}`,
        tag: `e2e-block-${id}`,
        tasks: [{ name: "Cut", team: bench }],
      },
    ],
    orders: [{ n, lineItems: [{ title: "E2E Cuff", quantity: 1, tags: [`e2e-block-${id}`] }] }],
  });
  await frame.getByRole("button", { name: "Manage" }).click();
  // No reason field on the card: the only one is in the closed modal.
  await expect(frame.getByRole("textbox", { name: "Reason" })).toBeHidden();
  const item = itemCard(frame, "E2E Cuff");
  await expect(item.locator('s-button[tone="critical"]')).toHaveCount(0);

  const blockModal = frame.locator("s-modal#run-block");
  await frame.getByRole("button", { name: "Block", exact: true }).click();
  await expect(blockModal.getByText(`Block #${String(n)}?`)).toBeVisible();
  await expect(blockModal.getByText("E2E Cuff", { exact: true })).toBeVisible();
  await blockModal.getByRole("textbox", { name: "Reason" }).fill("Out of walnut stock");
  await blockModal.getByRole("button", { name: "Block", exact: true }).click();
  const banner = item.locator('s-banner[heading="Blocked"]');
  await expect(banner).toBeVisible();
  await expect(banner.getByText("Out of walnut stock")).toBeVisible();
  await expect(banner.getByText(/You · /u)).toBeVisible();
  // The banner says why it stopped; the now line still says where.
  await expect(item.getByText("Step 1 of 1 · Cut", { exact: true })).toBeVisible();
  await expect(item.getByRole("button", { name: "Block", exact: true })).toHaveCount(0);
  await expect(item.locator('s-button[tone="critical"]')).toHaveCount(0);

  await expect(banner.getByRole("button", { name: "Edit reason", exact: true })).toHaveCount(0);

  // The blank note is its one button, which names the note.
  await expect(item.getByText("Note", { exact: true })).toHaveCount(0);
  const editNote = item.getByRole("button", { name: "Edit note", exact: true });
  await expect(editNote).toHaveCount(1);
  const noteModal = frame.locator("s-modal#run-note");
  await editNote.click();
  await noteModal.getByRole("textbox", { name: "Note" }).fill("Customer asked for gift wrap");
  await noteModal.getByRole("button", { name: "Save", exact: true }).click();
  await expect(item.getByText("Customer asked for gift wrap")).toBeVisible();
  await expect(editNote).toHaveCount(1);
  await expect(frame.getByRole("button", { name: "Add note", exact: true })).toHaveCount(0);

  const unblock = frame.getByRole("button", { name: "Unblock" });
  await expect(unblock).toHaveCount(1);
  await unblock.click();
  await expect(banner).toHaveCount(0);
  await expect(frame.getByRole("button", { name: "Block", exact: true })).toBeVisible();
});

/**
 * The card's layout, top to bottom: title, then the facts line carrying the live run's badges;
 * the properties, with a null value as an em dash so the key never stands alone; the blocked
 * banner, its reason cut to three lines with Show more when the cut hides text; the now line; the
 * note; and Manage last, directly above the drawer it opens.
 */
test("the order card puts the run's badges on the title line, Manage above its drawer, and cuts a long reason", async ({
  backend,
}) => {
  const id = own();
  const bench = `E2E Card Bench ${id}`;
  const workflow = `E2E Card Board ${id}`;
  const reason = "Waiting on vector artwork from the customer before engraving the crest. "
    .repeat(12)
    .trim();
  const n = ownBase() + 1;
  await addAndOpen(backend, n, {
    ...teamsOf([bench]),
    workflows: [
      { name: workflow, tag: `e2e-card-${id}`, tasks: [{ name: "Engrave", team: bench }] },
    ],
    orders: [
      {
        n,
        blocked: reason,
        lineItems: [
          {
            title: "E2E Board",
            quantity: 1,
            tags: [`e2e-card-${id}`],
            properties: [{ key: "Gift note", value: null }],
          },
        ],
      },
    ],
  });
  const item = itemCard(frame, "E2E Board");
  const banner = item.locator('s-banner[heading="Blocked"]');
  await expect(banner).toBeVisible();

  // The badges share the facts line with "× 1", above the properties.
  const factsLine = item
    .locator("s-stack")
    .filter({ has: frame.getByText("× 1", { exact: true }) })
    .last();
  await expect(factsLine.locator("s-badge", { hasText: "Not started" })).toBeVisible();
  await expect(factsLine.locator("s-badge", { hasText: "Blocked" })).toBeVisible();

  await expect(item.getByText("Gift note", { exact: true })).toBeVisible();
  await expect(item.getByText("—", { exact: true })).toBeVisible();

  // Cut to three lines, then shown whole.
  const text = banner.locator(".prose").first();
  const clamped = await text.boundingBox();
  await banner.getByText("Show more", { exact: true }).click();
  await expect(banner.getByText("Show less", { exact: true })).toBeVisible();
  const whole = await text.boundingBox();
  expect(whole?.height ?? 0).toBeGreaterThan(clamped?.height ?? 0);

  // Manage is below the note and the drawer opens under it.
  const editNote = item.getByRole("button", { name: "Edit note", exact: true });
  const manage = item.getByRole("button", { name: "Manage" });
  const noteBox = await editNote.boundingBox();
  const manageBox = await manage.boundingBox();
  expect(manageBox?.y ?? 0).toBeGreaterThan(noteBox?.y ?? 0);
  await manage.click();
  await expect(item.getByText(`${workflow} workflow`, { exact: true })).toBeVisible();
  // Placed by document order rather than by position: the drawer's header is an `s-heading`
  // inside a subdued panel.
  const drawerFollowsManage = await item.evaluate((section, header) => {
    const toggle = [...section.querySelectorAll("s-button")].find(
      (element) => element.textContent.trim() === "Manage",
    );
    const heading = [...section.querySelectorAll("s-heading")].find(
      (element) => element.textContent === header,
    );
    return (
      toggle !== undefined &&
      heading !== undefined &&
      (toggle.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    );
  }, `${workflow} workflow`);
  expect(drawerFollowsManage).toBe(true);
});

/**
 * One workflow per item, at the two places a merchant meets it. Two active workflows whose tags
 * land on one product is a state the editor refuses to create but the runtime must cope with
 * (a merchant's retagging in Shopify), and the fixture writes it. So: the item matches two,
 * nothing starts, the index shows the order under Issues with the Multiple workflows match badge,
 * and the order page asks. Then the same item is moved to the other workflow through the Change
 * workflow modal, cancelled, and given a fresh workflow from the select at rest.
 */
test("an item matching two workflows waits for the merchant to choose, then changes", async ({
  backend,
}) => {
  const id = own();
  const bench = `E2E Bench ${id}`;
  const engraving = `E2E Engraving ${id}`;
  const rush = `E2E Rush ${id}`;
  const n = ownBase() + 1;
  const name = `#${String(n)}`;
  await add(backend, {
    ...teamsOf([bench]),
    workflows: [
      { name: engraving, tag: `e2e-engraved-${id}`, tasks: [{ name: "Engrave", team: bench }] },
      { name: rush, tag: `e2e-rush-${id}`, tasks: [{ name: "Expedite", team: bench }] },
    ],
    orders: [
      {
        n,
        lineItems: [
          {
            title: "E2E Twice",
            quantity: 1,
            tags: [`e2e-engraved-${id}`, `e2e-rush-${id}`],
          },
        ],
      },
    ],
  });

  frame = await openOrders(page);
  await showOpen(frame);
  // The row's Issues cell says what it is waiting on, and the Issues filter holds it.
  await expect(
    frame
      .locator("s-table-row", { hasText: name })
      .getByText("Multiple workflows match", { exact: true }),
  ).toBeVisible();
  await stripCell(frame, "Issues").click();
  await expect.poll(() => listContext(page).show).toBe("issues");
  await expect(frame.getByRole("link", { name, exact: true })).toBeVisible();

  await frame.getByRole("link", { name, exact: true }).click();
  await expect(frame.locator(`s-page[heading="${name}"]`)).toBeVisible();

  // An item with no run carries the Workflow select at rest, and on a multi-match one it offers
  // every active workflow, the two that matched first. The store holds other tests' workflows,
  // so the count is not pinned; the order is.
  const item = itemCard(frame, "E2E Twice");
  await expect(
    item.getByText("More than one workflow matches this item, so none was started.", {
      exact: true,
    }),
  ).toBeVisible();
  const select = item.getByRole("combobox", { name: "Workflow" });
  const options = select.getByRole("option");
  await expect(options.nth(0)).toHaveText(engraving);
  await expect(options.nth(1)).toHaveText(rush);

  await select.selectOption({ label: engraving });
  await item.getByRole("button", { name: VERB_LABEL.attachWorkflow.merchant, exact: true }).click();

  // The run replaces the ask, and with it the select. The workflow's name heads the drawer.
  const manage = item.getByRole("button", { name: "Manage" });
  await expect(manage).toBeVisible();
  await expect(item.getByText("so none was started", { exact: false })).toHaveCount(0);
  await manage.click();
  await expect(item.getByText(`${engraving} workflow`, { exact: true })).toBeVisible();

  // Change workflow is inside the drawer, and opens a modal holding the select. A run with
  // nothing started loses nothing, so the modal warns of nothing.
  await item.getByRole("button", { name: "Change workflow", exact: true }).click();
  const changeModal = frame.locator("s-modal#change-workflow");
  await changeModal.getByRole("combobox", { name: "Workflow" }).selectOption({ label: rush });
  await expect(changeModal.getByText("will not carry over")).toHaveCount(0);
  await changeModal.getByRole("button", { name: "Change workflow", exact: true }).click();

  // The change replaces the run, so the drawer the old one had open closes with it. The modal
  // hiding is the gate: Manage is on the card in every state.
  await expect(changeModal.getByRole("combobox", { name: "Workflow" })).toBeHidden();
  await expect(manage).toBeVisible();
  await manage.click();
  await expect(item.getByText(`${rush} workflow`, { exact: true })).toBeVisible();
  // The replaced run is gone, not kept beside the new one.
  await expect(item.getByText("Cancelled", { exact: true })).toHaveCount(0);
  await expect(item.getByRole("button", { name: "Manage" })).toHaveCount(1);

  // Cancel workflow asks first, because nothing brings the run back. After it the item's run is
  // Closed, "Cancelled by you", and the Workflow select offers a fresh run.
  await item.getByRole("button", { name: VERB_LABEL.cancel.merchant, exact: true }).click();
  const cancelModal = frame.locator("s-modal#cancel-run");
  await expect(
    cancelModal.getByText("Steps already done still show on the order.", { exact: false }),
  ).toBeVisible();
  await cancelModal.getByRole("button", { name: VERB_LABEL.cancel.merchant, exact: true }).click();
  await expect(item.getByText("Closed", { exact: true })).toBeVisible();
  await expect(item.getByText("Cancelled by you", { exact: false })).toBeVisible();
  await item.getByRole("combobox", { name: "Workflow" }).selectOption({ label: rush });
  await item.getByRole("button", { name: VERB_LABEL.attachWorkflow.merchant, exact: true }).click();
  await expect(item.getByText("Closed", { exact: true })).toHaveCount(0);
  await expect(manage).toBeVisible();

  // And the order has left the issue: one live run, nothing left to choose.
  frame = await openOrders(page);
  await showOpen(frame);
  await expect(
    frame
      .locator("s-table-row", { hasText: name })
      .getByText("Multiple workflows match", { exact: true }),
  ).toHaveCount(0);
  await expect(frame.locator("s-table-row", { hasText: name })).toBeVisible();
});

/**
 * Each order-page state against the controls its action set allows (`runActions`,
 * `taskActions`, `lineItemState`), one order per state, so the table the page is built from is
 * looked at rather than reasoned about.
 */
test("each order-page state draws the controls its action set allows", async ({ backend }) => {
  const id = own();
  const bench = `E2E States ${id}`;
  const workflow = (letter: string) => {
    const name = `E2E State ${letter} ${id}`;
    return {
      name,
      tag: `e2e-state-${letter.toLowerCase()}-${id}`,
      tasks: [
        { name: `${name} one`, team: bench },
        { name: `${name} two`, team: bench },
      ],
    };
  };
  const [a, b, c] = [workflow("A"), workflow("B"), workflow("C")];
  const base = ownBase();
  const n = (k: number) => base + k;
  await add(backend, {
    ...teamsOf([bench]),
    workflows: [a, b, c],
    orders: [
      {
        // the line removed in Shopify under a started run: closed, no buttons
        n: n(1),
        advance: 1,
        after: { lineItems: [{ position: 1, currentQuantity: 0 }] },
        lineItems: [{ title: "E2E Removed", quantity: 1, tags: [a.tag] }],
      },
      {
        // Shopify cancelled the order under a started run
        n: n(2),
        advance: 1,
        after: { cancelled: true },
        lineItems: [{ title: "E2E Closed", quantity: 1, tags: [a.tag] }],
      },
      {
        // done, then the quantity dropped
        n: n(3),
        done: true,
        after: { lineItems: [{ position: 1, currentQuantity: 1 }] },
        lineItems: [{ title: "E2E Resized", quantity: 2, tags: [a.tag] }],
      },
      {
        // blocked before anyone started
        n: n(4),
        blocked: "Waiting on artwork.",
        lineItems: [{ title: "E2E Held", quantity: 1, tags: [a.tag] }],
      },
      {
        // three workflows claim the item
        n: n(5),
        lineItems: [{ title: "E2E Triple", quantity: 1, tags: [a.tag, b.tag, c.tag] }],
      },
      {
        // the merchant cancelled the run
        n: n(6),
        lineItems: [
          {
            title: "E2E Stopped",
            quantity: 1,
            tags: [a.tag],
            progress: { advance: 1, cancelled: true },
          },
        ],
      },
    ],
  });

  /** Through the index's search, which finds a cancelled order as well as an open one. */
  const open = async (k: number, title: string) => {
    frame = await openOrder(page, n(k));
    return itemCard(frame, title);
  };

  // A closed run offers nothing but the note: no Dismiss anywhere, and no Cancel workflow on a
  // closed order.
  const removed = await open(1, "E2E Removed");
  await expect(removed.getByText("Closed", { exact: true })).toBeVisible();
  await expect(
    removed.getByText("Item removed or refunded in Shopify", { exact: false }),
  ).toBeVisible();
  await expect(button(removed, "Dismiss")).toHaveCount(0);
  await button(removed, "Manage").click();
  await expect(button(removed, VERB_LABEL.done.merchant)).toHaveCount(0);
  await expect(button(removed, "Block")).toHaveCount(0);
  await expect(button(removed, "Assign team")).toHaveCount(0);
  await expect(button(removed, VERB_LABEL.cancel.merchant)).toHaveCount(0);

  const closed = await open(2, "E2E Closed");
  await expect(closed.getByText("Closed", { exact: true })).toBeVisible();
  await expect(closed.getByText("Order cancelled in Shopify", { exact: false })).toBeVisible();
  await expect(button(closed, "Dismiss")).toHaveCount(0);
  await button(closed, "Manage").click();
  await expect(button(closed, VERB_LABEL.cancel.merchant)).toHaveCount(0);
  await expect(button(closed, VERB_LABEL.done.merchant)).toHaveCount(0);
  await expect(button(closed, "Reopen")).toHaveCount(0);
  await expect(button(closed, "Assign team")).toHaveCount(0);
  await expect(button(closed, "Block")).toHaveCount(0);
  await expect(button(closed, "Change workflow")).toHaveCount(0);

  const resized = await open(3, "E2E Resized");
  await expect(resized.getByText("Done", { exact: true }).first()).toBeVisible();
  // A done run is never resized: nothing to dismiss.
  await expect(button(resized, "Dismiss")).toHaveCount(0);
  await button(resized, "Manage").click();
  await expect(button(resized, "Reopen")).toBeVisible();
  await expect(button(resized, VERB_LABEL.cancel.merchant)).toHaveCount(0);

  const held = await open(4, "E2E Held");
  await expect(button(held, "Unblock")).toBeVisible();
  await button(held, "Manage").click();
  await expect(button(held, VERB_LABEL.done.merchant)).toHaveCount(0);
  await expect(button(held, "Block")).toHaveCount(0);
  await expect(button(held, "Assign team").first()).toBeVisible();

  const triple = await open(5, "E2E Triple");
  const options = triple.getByRole("combobox", { name: "Workflow" }).getByRole("option");
  await expect(options.nth(0)).toHaveText(a.name);
  await expect(options.nth(1)).toHaveText(b.name);
  await expect(options.nth(2)).toHaveText(c.name);

  const stopped = await open(6, "E2E Stopped");
  await expect(stopped.getByText("Closed", { exact: true })).toBeVisible();
  await expect(stopped.getByText("Cancelled by you", { exact: false })).toBeVisible();
  await expect(stopped.getByRole("combobox", { name: "Workflow" })).toBeVisible();
  // The done step stays on record under Manage, with no buttons.
  await button(stopped, "Manage").click();
  await expect(stopped.getByText(`${a.name} one`)).toBeVisible();
  await expect(button(stopped, "Reopen")).toHaveCount(0);
});
