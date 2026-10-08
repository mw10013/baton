#!/usr/bin/env node
/**
 * `pnpm help:screenshots`: retakes the help's pictures against the showcase
 * shop on this checkout's dev server, the spec in `HELP_PICTURES`
 * (`src/lib/helpPictures.ts`) for what each one shows. In order: refuses to
 * start unless the dev server is healthy; checks the admin session the e2e
 * setup exports (`storageStatePath`) and refreshes it from Chrome when it is
 * older than a day, stopping before the store is touched if that fails;
 * readies the store and seeds the showcase; shoots every merchant picture in
 * the admin, 1280 × 800 at 2x; signs in as the showcase's member
 * `ana@example.com` on a 390 × 844 phone at 2x and shoots every member
 * picture; puts the store back on the development fixture, also when a shot
 * failed; prints what it wrote, and each merchant picture's clip in CSS px,
 * which is the inventory's `aspectRatio`. Headless and light theme
 * throughout.
 *
 * Playwright's library API, not `playwright-cli`: the shots are a program a
 * rerun repeats, not a session someone drives. The items are found by their
 * order number, which the showcase fixture gives each order by its place
 * (`orders` in `e2e/showcaseFixture.ts`), so a picture follows its item if the
 * fixture's order changes. One member shot writes a Done (Recording your
 * work's third picture) and the merchant shots create a workflow and a team;
 * the reseed at the end takes them back.
 *
 * A merchant picture is one of four shapes ({@link MERCHANT_SHAPES}), and
 * before each one {@link overlapCheck} refuses the shot if an admin overlay
 * would land in it.
 *
 * A rerun shoots the same frames but not the same bytes: the seed stamps the
 * clock, so every item page shows the time it ran ("Oct 7, 6:58 PM"). Rerun
 * when a screen changes, not to refresh.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type Browser,
  chromium,
  expect as baseExpect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import { Console, Data, Effect } from "effect";
import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  appFrame,
  clickHoisted,
  editorFrame,
  gotoApp,
  hoistedEnabled,
  openScreen,
} from "../e2e/app.ts";
import { previewUrl } from "../e2e/devStore.ts";
import { awaitHydration, awaitNavigated } from "../e2e/hydration.ts";
import { orders } from "../e2e/showcaseFixture.ts";
import { storageStatePath } from "../playwright.config.ts";
import {
  HELP_PICTURES,
  HELP_PICTURES_PATH,
  MEMBER_SCREEN,
  MERCHANT_WINDOW,
  type HelpPictureName,
} from "../src/lib/helpPictures.ts";
import { runCommand } from "./lib/command.ts";
import {
  adminSessionFresh,
  CHROME_PROFILE,
  refreshShopifyAuth,
} from "./lib/shopify-playwright-auth.ts";

class HelpScreenshotsError extends Data.TaggedError("HelpScreenshotsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const MEMBER = "ana@example.com";

const port = process.env.PORT;
const store = process.env.SHOPIFY_DEV_STORE;

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new HelpScreenshotsError({
        message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

/** The showcase order whose one item carries this property value, by its number. */
const orderWith = (value: string): string => {
  const order = orders.find((each) =>
    each.lineItems.some((item) =>
      (item.properties ?? []).some((property) => property.value === value),
    ),
  );
  if (order === undefined)
    throw new Error(`no showcase order has an item with "${value}"`);
  return `#${String(order.n)}`;
};

/**
 * The runner's default of 5 s is short for the tunnel; the e2e config uses
 * 10 s. Only this script's own waits see it: `expect.configure` returns a new
 * instance, so the helpers from `e2e/app.ts` keep their 5 s.
 */
const expect = baseExpect.configure({ timeout: 10_000 });

/**
 * Wait until a Polaris button accepts clicks: the member screens disable
 * every verb until the socket identifies (`useMemberRunActions`), and a
 * picture taken before then shows greyed buttons. Reads the element's own
 * `disabled`, as `awaitEnabled` in `e2e/member.ts` does.
 */
const awaitEnabled = async (locator: Locator) => {
  await locator.waitFor({ state: "visible" });
  await locator.page().waitForFunction(
    (element) => {
      const control = element?.closest("s-button") ?? element;
      return (
        control !== null &&
        !(control as HTMLButtonElement).disabled &&
        control.getAttribute("aria-disabled") !== "true"
      );
    },
    await locator.elementHandle(),
  );
};

/** Fonts loaded and nothing moving, so two runs shoot the same frame. */
const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
};

const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).first();

/** The workflows list, then the item on this order through the search, as a member gets there. */
const openItem = async (page: Page, shop: string, orderName: string) => {
  await page.goto(`/shop/${shop}/workflows`);
  await awaitHydration(page);
  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill(orderName.slice(1));
  await search.press("Enter");
  await page
    .getByRole("link", { name: new RegExp(`^Open .+ on ${orderName}$`, "u") })
    // An item can be listed twice under a search: open, and in Done or
    // closed for a task done on it in the last day. Both open its page.
    .first()
    .click();
  await page.locator(`s-page[heading="${orderName}"]`).waitFor();
  await awaitHydration(page);
};

/** Each member picture's state, as a function of a signed-in page. Run in this order. */
const MEMBER_SHOTS: readonly {
  readonly name: HelpPictureName;
  readonly take: (page: Page, shop: string) => Promise<void>;
}[] = [
  {
    name: "findingYourWork1",
    take: async (page, shop) => {
      await page.goto(`/shop/${shop}/workflows`);
      await awaitHydration(page);
      await awaitEnabled(
        page.getByRole("button", { name: /^Actions for /u }).first(),
      );
    },
  },
  {
    name: "findingYourWork2",
    take: async (page) => {
      await page
        .getByRole("button", { name: /^Ready, [\d,]+(?:, selected)?$/u })
        .click();
      await page
        .getByRole("combobox", { name: "Team" })
        .selectOption({ label: "Engraving" });
      await page
        .getByRole("button", { name: /^Ready, [\d,]+, selected$/u })
        .waitFor();
      await page.waitForURL(/team=/u);
      await awaitEnabled(
        page.getByRole("button", { name: /^Actions for /u }).first(),
      );
    },
  },
  {
    name: "recordingYourWork1",
    take: async (page, shop) => {
      await openItem(page, shop, orderWith("Nana's kitchen"));
      const start = button(page, "Start");
      await awaitEnabled(start);
      await start.scrollIntoViewIfNeeded();
    },
  },
  {
    name: "recordingYourWork2",
    take: async (page, shop) => {
      await openItem(page, shop, orderWith("Grandma Rose"));
      const putBack = button(page, "Put back");
      await awaitEnabled(putBack);
      await putBack.scrollIntoViewIfNeeded();
    },
  },
  {
    name: "recordingYourWork3",
    take: async (page) => {
      await button(page, "Done").click();
      const undo = button(page, "Undo");
      await awaitEnabled(undo);
      await undo.scrollIntoViewIfNeeded();
    },
  },
  {
    name: "blocking1",
    take: async (page, shop) => {
      await openItem(page, shop, orderWith("Home sweet home"));
      // On a phone `s-page` folds its secondary actions into one menu.
      const pageActions = page.getByRole("button", { name: "Page actions" });
      await awaitEnabled(button(page, "Done"));
      await pageActions.click();
      await page
        .getByRole("menuitem", { name: "Block", exact: true })
        .or(page.getByRole("button", { name: "Block", exact: true }))
        .first()
        .click();
      const reason = page.getByRole("textbox", { name: "Reason" });
      await reason.waitFor({ state: "visible" });
      await reason.fill(
        "The oil is still tacky after a day. Leaving it to cure before the second coat.",
      );
    },
  },
  {
    name: "blocking2",
    take: async (page, shop) => {
      await openItem(page, shop, orderWith("Smith family"));
      await awaitEnabled(button(page, "Unblock"));
    },
  },
];

/** The app's own frame in the admin document, and the editor window's. */
const APP_IFRAME = 'iframe[src*="embedded=1"]:not([src*="chrome=window"])';
const EDITOR_IFRAME = 'iframe[src*="chrome=window"]';

/**
 * The admin overlays a merchant picture must not show: the dev mini console,
 * the Sidekick composer, the Sidekick field around it (its grey banner sits
 * at the foot of the content area, positioned absolutely, not fixed) and the
 * toast viewport. The class stems are
 * Shopify's generated names and change without notice; {@link overlapCheck}
 * is what holds when they do.
 */
const HIDE_OVERLAYS = `[class*="_Composer_"], [class*="_SidekickField_"], [class*="_MiniConsole_"], #admin-next-toast-viewport { visibility: hidden !important; }`;

/**
 * Marks the admin's own part of a picture (the title bar the page shape
 * found, the editor's window), so the overlap check counts it as the
 * picture rather than as something over it.
 */
const SHOT_MARK = "data-help-shot";

/** Marks an admin box around a frame whose corners are rounded; see {@link SQUARE_CORNERS}. */
const SQUARE_MARK = "data-help-square";

/**
 * Applied only while a merchant picture is shot (Playwright's screenshot
 * `style` reaches into frames and shadow roots). The admin rounds the box
 * that holds the app frame and the title bar, the editor's window and every
 * modal panel, and a clip to any of them would otherwise keep the dark admin
 * background or the dimmed backdrop in its corners, against the help page's
 * white. A modal's panel is its `dialog`; the admin's boxes are found by
 * {@link markRoundedBoxes}, so no Shopify class name is needed.
 */
const SQUARE_CORNERS = `dialog, [${SQUARE_MARK}] { border-radius: 0 !important; }`;

/** Marks every rounded ancestor of the app and editor frames with {@link SQUARE_MARK}. */
const markRoundedBoxes = (page: Page) =>
  page.evaluate(
    ({ appIframe, editorIframe, mark }) => {
      for (const frame of document.querySelectorAll(
        `${appIframe}, ${editorIframe}`,
      ))
        for (
          let element = frame.parentElement;
          element !== null;
          element = element.parentElement
        )
          if (getComputedStyle(element).borderTopLeftRadius !== "0px")
            element.setAttribute(mark, "");
    },
    { appIframe: APP_IFRAME, editorIframe: EDITOR_IFRAME, mark: SQUARE_MARK },
  );

/** A merchant page taller than this is refused rather than shot. */
const MAX_PAGE_HEIGHT = 4000;

interface Clip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const box = async (locator: Locator, what: string): Promise<Clip> => {
  const found = await locator.boundingBox();
  if (found === null || found.width === 0 || found.height === 0)
    throw new Error(`${what} has no box`);
  return found;
};

/**
 * A clip on whole CSS px, so the file is exactly twice it and the inventory's
 * `aspectRatio` is two whole numbers: the edges round outward by under 1 px.
 */
const whole = (clip: Clip): Clip => {
  const x = Math.floor(clip.x);
  const y = Math.floor(clip.y);
  return {
    x,
    y,
    width: Math.ceil(clip.x + clip.width) - x,
    height: Math.ceil(clip.y + clip.height) - y,
  };
};

/**
 * The admin's title bar above the app frame: the outermost ancestor of the
 * element at `(frame.x + 300, 30)` whose width is within 40 px of the
 * frame's, whose top is under 20 px and whose height is under 120 px (the
 * height bound keeps it from climbing to the box that holds both the bar and
 * the frame). Marked with {@link SHOT_MARK}.
 */
const titleBar = async (page: Page, frame: Clip): Promise<Clip> => {
  const bar = await page.evaluate(
    ({ frame, mark }) => {
      for (const marked of document.querySelectorAll(`[${mark}]`))
        marked.removeAttribute(mark);
      let element = document.elementFromPoint(frame.x + 300, 30);
      let found: Element | null = null;
      while (element !== null && element !== document.body) {
        const rect = element.getBoundingClientRect();
        if (
          Math.abs(rect.width - frame.width) <= 40 &&
          rect.top < 20 &&
          rect.height < 120
        )
          found = element;
        element = element.parentElement;
      }
      if (found === null) return null;
      found.setAttribute(mark, "");
      const rect = found.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },
    { frame, mark: SHOT_MARK },
  );
  if (bar === null)
    throw new Error(
      "found no title bar above the app frame (an element at the frame's width, top under 20 px)",
    );
  return bar;
};

/**
 * Refuses the shot if something in the admin document would land in it:
 * every element whose computed `position` is `fixed`, `sticky` or
 * `absolute`, visible (a non-zero box, `visibility` not hidden, `opacity`
 * not 0), that is not the app frame, the editor frame or a part marked
 * {@link SHOT_MARK}, nor an ancestor or a descendant of one, and whose box
 * intersects the clip. `absolute` is there because the Sidekick dock is
 * positioned that way and still lands over the frame. Two refinements keep
 * the check from refusing what the picture does not show: the element, or
 * something inside it, must draw within the clip (a fill, an image, a
 * border, a shadow, text), since the admin keeps transparent layers over the
 * frame for toasts and modals; and an element the hit test finds under the
 * picture's own parts at every sampled point of the overlap is covered and
 * passes. An element the hit test never finds (`pointer-events: none`)
 * counts as on top, so a click-through overlay is still refused.
 */
const overlapCheck = async (page: Page, clip: Clip) => {
  const found = await page.evaluate(
    ({ clip, appIframe, editorIframe, mark }) => {
      const kept = [
        ...document.querySelectorAll(
          `${appIframe}, ${editorIframe}, [${mark}]`,
        ),
      ];
      const isKept = (element: Element) =>
        kept.some((each) => element.contains(each) || each.contains(element));
      const intersects = (rect: DOMRect) =>
        Math.min(rect.right, clip.x + clip.width) >
          Math.max(rect.left, clip.x) &&
        Math.min(rect.bottom, clip.y + clip.height) >
          Math.max(rect.top, clip.y);
      /** Draws something of its own: a fill, an image, a border, a shadow, text or a replaced element. */
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the admin document, so it cannot live outside this callback
      const paints = (element: Element) => {
        const style = getComputedStyle(element);
        return (
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          (!/^rgba\(.*,\s*0\)$|^transparent$/u.test(style.backgroundColor) ||
            style.backgroundImage !== "none" ||
            style.boxShadow !== "none" ||
            ["top", "right", "bottom", "left"].some(
              (side) =>
                style.getPropertyValue(`border-${side}-width`) !== "0px",
            ) ||
            ["IMG", "SVG", "CANVAS", "VIDEO", "IFRAME"].includes(
              element.tagName.toUpperCase(),
            ) ||
            [...element.childNodes].some(
              (node) =>
                node.nodeType === Node.TEXT_NODE &&
                (node.textContent ?? "").trim() !== "",
            ))
        );
      };
      /** It or something inside it draws within the clip. */
      const drawsInClip = (element: Element) =>
        [element, ...element.querySelectorAll("*")].some((each) => {
          const rect = each.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            intersects(rect) &&
            paints(each)
          );
        });
      /** On top at some sampled point of the overlap, or never hit at all. */
      const shows = (element: Element, rect: DOMRect) => {
        const left = Math.max(rect.left, clip.x);
        const right = Math.min(rect.right, clip.x + clip.width);
        const top = Math.max(rect.top, clip.y);
        const bottom = Math.min(rect.bottom, clip.y + clip.height);
        if (right <= left || bottom <= top) return false;
        const points = Array.from({ length: 64 }, (_, n) => ({
          x: left + ((right - left) * ((n % 8) + 0.5)) / 8,
          y: top + ((bottom - top) * (Math.floor(n / 8) + 0.5)) / 8,
        }));
        const stacks = points.map(({ x, y }) => {
          const hits = document.elementsFromPoint(x, y);
          const at = hits.findIndex((hit) => element.contains(hit));
          return at === -1 ? undefined : hits.slice(0, at);
        });
        const above = stacks.filter((stack) => stack !== undefined);
        return (
          above.length === 0 ||
          above.some((stack) => !stack.some((hit) => isKept(hit)))
        );
      };
      const reported = [...document.querySelectorAll("*")]
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            ["fixed", "sticky", "absolute"].includes(style.position) &&
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            !isKept(element) &&
            shows(element, rect) &&
            drawsInClip(element)
          );
        })
        .map(
          (element) =>
            `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").slice(0, 60)}`,
        );
      return reported;
    },
    {
      clip,
      appIframe: APP_IFRAME,
      editorIframe: EDITOR_IFRAME,
      mark: SHOT_MARK,
    },
  );
  if (found.length > 0)
    throw new Error(
      `refused: an admin overlay intersects the clip: ${found.join(", ")}`,
    );
};

/**
 * The editor's window: the admin's `dialog` that holds the editor frame and
 * the window's title bar, inset from the window's edges so the admin's
 * sidebar shows beside it. Marked with {@link SHOT_MARK}.
 */
const editorWindow = async (page: Page): Promise<Clip> => {
  const found = await page.evaluate(
    ({ editorIframe, mark }) => {
      for (const marked of document.querySelectorAll(`[${mark}]`))
        marked.removeAttribute(mark);
      const dialog = document.querySelector(editorIframe)?.closest("dialog");
      if (dialog === null || dialog === undefined) return null;
      dialog.setAttribute(mark, "");
      const rect = dialog.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },
    { editorIframe: EDITOR_IFRAME, mark: SHOT_MARK },
  );
  if (found === null)
    throw new Error("found no dialog around the editor frame");
  return found;
};

/** The open modal's panel inside a frame, in page coordinates. */
const modalPanel = async (frame: FrameLocator) =>
  whole(
    await box(frame.locator("s-modal dialog[open]").first(), "the open modal"),
  );

/**
 * How far down the frame's document its content reaches, in CSS px: the
 * lowest bottom edge of any element in the body, shadow roots included,
 * since Polaris draws its cards and its text inside them and a slotted
 * element can have no box of its own. Not the document's `scrollHeight`,
 * which is never less than the frame's own height, so a short page would be
 * shot with the window's empty lower half under it.
 */
const contentHeight = (body: HTMLElement) => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the frame's document, so it cannot live outside this function
  const lowest = (root: Element | ShadowRoot): number =>
    Math.max(
      0,
      ...[...root.querySelectorAll("*")].map((element) => {
        const rect = element.getBoundingClientRect();
        return Math.max(
          rect.width > 0 && rect.height > 0 ? rect.bottom + scrollY : 0,
          element.shadowRoot === null ? 0 : lowest(element.shadowRoot),
        );
      }),
    );
  return lowest(body);
};

/**
 * The four merchant shapes, each a function of the admin page that settles
 * it, runs the overlap check and writes the file, returning the clip in CSS
 * px:
 *
 * - `page`: the title bar and the app frame, down to 20 px under the
 *   frame's {@link contentHeight}. The viewport grows to that when the
 *   content is taller than the window (refused past
 *   {@link MAX_PAGE_HEIGHT}) and is put back after; it never shrinks, since
 *   in a shorter window the collapsed Dev Console rises into the frame. The
 *   clip runs across the frame's width.
 * - `modal`: the open `s-modal`'s panel in the app frame, no margin.
 * - `window`: the editor's window ({@link editorWindow}), down to 20 px under
 *   the editor frame's {@link contentHeight}, as the page shape does.
 * - `editor modal`: the open `s-modal`'s panel in the editor frame.
 */
const MERCHANT_SHAPES = {
  page: async (page: Page, file: string): Promise<Clip> => {
    await settle(page);
    const height = await appFrame(page).locator("body").evaluate(contentHeight);
    const before = await box(page.locator(APP_IFRAME), "the app frame");
    const fitted = Math.ceil(before.y + height + 20);
    if (fitted > MAX_PAGE_HEIGHT)
      throw new Error(
        `the page is ${String(fitted)} CSS px tall, past ${String(MAX_PAGE_HEIGHT)}`,
      );
    await page.setViewportSize({
      width: MERCHANT_WINDOW.width,
      height: Math.max(fitted, MERCHANT_WINDOW.height),
    });
    try {
      await settle(page);
      const frame = await box(page.locator(APP_IFRAME), "the app frame");
      const bar = await titleBar(page, frame);
      const clip = whole({
        x: frame.x,
        y: bar.y,
        width: frame.width,
        height: Math.min(frame.y + frame.height, fitted) - bar.y,
      });
      await overlapCheck(page, clip);
      await markRoundedBoxes(page);
      await page.screenshot({
        path: file,
        clip,
        animations: "disabled",
        style: SQUARE_CORNERS,
      });
      return clip;
    } finally {
      await page.setViewportSize(MERCHANT_WINDOW);
    }
  },
  modal: async (page: Page, file: string): Promise<Clip> => {
    await settle(page);
    const clip = await modalPanel(appFrame(page));
    await overlapCheck(page, clip);
    await markRoundedBoxes(page);
    await page.screenshot({
      path: file,
      clip,
      animations: "disabled",
      style: SQUARE_CORNERS,
    });
    return clip;
  },
  window: async (page: Page, file: string): Promise<Clip> => {
    await settle(page);
    const shell = await editorWindow(page);
    const frame = await box(page.locator(EDITOR_IFRAME), "the editor frame");
    const height = await editorFrame(page)
      .locator("body")
      .evaluate(contentHeight);
    const clip = whole({
      ...shell,
      height: Math.min(shell.y + shell.height, frame.y + height + 20) - shell.y,
    });
    await overlapCheck(page, clip);
    await markRoundedBoxes(page);
    await page.screenshot({
      path: file,
      clip,
      animations: "disabled",
      style: SQUARE_CORNERS,
    });
    return clip;
  },
  "editor modal": async (page: Page, file: string): Promise<Clip> => {
    await settle(page);
    const clip = await modalPanel(editorFrame(page));
    await overlapCheck(page, clip);
    await markRoundedBoxes(page);
    await page.screenshot({
      path: file,
      clip,
      animations: "disabled",
      style: SQUARE_CORNERS,
    });
    return clip;
  },
} as const;

/** An order's page, by its number, through the orders index's search. */
const openOrder = async (page: Page, orderName: string) => {
  await openScreen(page, "Orders");
  const frame = appFrame(page);
  const search = frame.getByRole("searchbox", { name: "Search" });
  await search.fill(orderName.slice(1));
  await search.press("Enter");
  await frame.getByRole("link", { name: orderName, exact: true }).click();
  await frame.locator(`s-page[heading="${orderName}"]`).waitFor();
  await awaitNavigated(frame);
};

const WORKFLOW = "Engraved pen";
const TEAM = "Assembly";

/** Each merchant picture's state and shape, as a function of the admin page. Run in this order. */
const MERCHANT_SHOTS: readonly {
  readonly name: HelpPictureName;
  readonly shape: keyof typeof MERCHANT_SHAPES;
  readonly take: (page: Page) => Promise<void>;
}[] = [
  {
    name: "howBatonWorks1",
    shape: "page",
    take: (page) => openOrder(page, orderWith("Grandma Rose")),
  },
  {
    name: "firstOrder1",
    shape: "page",
    take: (page) => openOrder(page, orderWith("Fresh bread")),
  },
  {
    name: "firstWorkflow1",
    shape: "modal",
    take: async (page) => {
      await openScreen(page, "Workflows");
      await clickHoisted(page.getByRole("button", { name: "Create workflow" }));
      const frame = appFrame(page);
      const tag = frame.getByRole("textbox", { name: "Tag", exact: true });
      await frame
        .getByRole("textbox", { name: "Name", exact: true })
        .fill(WORKFLOW);
      // The Tag fills from the name as "engraved pen"; a hyphenated tag is
      // typed, as the showcase's own tags are.
      await expect(tag).toHaveValue("engraved pen");
      await tag.fill("engraved-pen");
      await expect(
        frame.getByRole("button", { name: "Create", exact: true }),
      ).toBeEnabled();
    },
  },
  {
    name: "firstWorkflow2",
    shape: "window",
    take: async (page) => {
      await appFrame(page)
        .getByRole("button", { name: "Create", exact: true })
        .click();
      const editor = editorFrame(page);
      await editor.locator(`s-page[heading="${WORKFLOW}"]`).waitFor();
      await awaitHydration(editor);
      await editor.getByRole("button", { name: "Add step" }).click();
      await editor
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("Engrave");
      await editor
        .getByRole("combobox", { name: "Team", exact: true })
        .selectOption({ label: "Engraving" });
      await editor
        .getByRole("textbox", { name: "Instructions" })
        .fill(
          "The text is in the properties. Check the spelling before running the laser.",
        );
      await expect(
        editor.getByRole("button", { name: "Add step" }),
      ).toBeEnabled();
    },
  },
  {
    name: "firstWorkflow3",
    shape: "editor modal",
    take: async (page) => {
      const editor = editorFrame(page);
      await editor.getByRole("button", { name: "Add step" }).click();
      await editor.getByText("Step 1", { exact: true }).waitFor();
      const turnOn = page.getByRole("button", {
        name: "Turn on workflow",
        exact: true,
      });
      await expect.poll(() => hoistedEnabled(turnOn)).toBe(true);
      await clickHoisted(turnOn);
      await editor
        .getByText("starts this workflow on that item", { exact: false })
        .waitFor();
    },
  },
  {
    name: "firstTeam1",
    shape: "page",
    take: async (page) => {
      const editor = editorFrame(page);
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await clickHoisted(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Close", exact: true }),
      );
      await expect(page.locator(EDITOR_IFRAME)).toHaveCount(0);
      await openScreen(page, "Teams");
      await clickHoisted(page.getByRole("button", { name: "Create team" }));
      const frame = appFrame(page);
      await frame
        .getByRole("textbox", { name: "Name", exact: true })
        .fill(TEAM);
      await frame.getByRole("button", { name: "Create", exact: true }).click();
      await frame.locator(`s-page[heading="${TEAM}"]`).waitFor();
      await awaitNavigated(frame);
    },
  },
  {
    name: "firstTeam2",
    shape: "modal",
    take: async (page) => {
      const frame = appFrame(page);
      await frame.getByRole("button", { name: "Add members" }).click();
      await frame
        .locator("s-modal#add-team-members")
        .getByRole("searchbox", { name: "Search members by email" })
        .waitFor();
    },
  },
];

/** The file a picture is written to, under `public/`. */
const fileOf = (name: HelpPictureName) =>
  path.join("public", HELP_PICTURES_PATH, HELP_PICTURES[name].file);

/** One line of the run's report: the file, and a merchant clip's size as the inventory's `aspectRatio`. */
interface Written {
  readonly file: string;
  readonly aspectRatio?: string;
}

const shootMerchant = (browser: Browser) =>
  Effect.gen(function* () {
    const context = yield* attempt("Could not open an admin page", () =>
      browser.newContext({
        storageState: storageStatePath,
        baseURL: previewUrl(),
        viewport: MERCHANT_WINDOW,
        deviceScaleFactor: 2,
        colorScheme: "light",
      }),
    );
    const page = yield* attempt("Could not open an admin page", () =>
      context.newPage(),
    );
    yield* attempt("Could not open Baton in the admin", async () => {
      await gotoApp(page, "app/orders").catch((error: unknown) => {
        if (page.url().includes("accounts.shopify.com"))
          throw new Error(
            `the admin asked for a sign-in: the session in ${storageStatePath} is not accepted. Delete it and rerun to export it again from Chrome.`,
            { cause: error },
          );
        throw error;
      });
      await page.addStyleTag({ content: HIDE_OVERLAYS });
    });
    const written: Written[] = [];
    for (const shot of MERCHANT_SHOTS) {
      const file = fileOf(shot.name);
      const clip = yield* attempt(`Could not shoot ${shot.name}`, async () => {
        await shot.take(page);
        await mkdir(path.dirname(file), { recursive: true });
        return MERCHANT_SHAPES[shot.shape](page, file);
      });
      written.push({
        file,
        aspectRatio: `${String(Math.round(clip.width))}/${String(Math.round(clip.height))}`,
      });
    }
    return written;
  });

const shootMember = (browser: Browser, shop: string, baseURL: string) =>
  Effect.gen(function* () {
    const context = yield* attempt("Could not open a page", () =>
      browser.newContext({
        baseURL,
        viewport: {
          width: MEMBER_SCREEN.width,
          height: MEMBER_SCREEN.height,
        },
        deviceScaleFactor: 2,
        colorScheme: "light",
      }),
    );
    const page = yield* attempt("Could not open a page", () =>
      context.newPage(),
    );
    yield* attempt(`Could not sign in as ${MEMBER}`, async () => {
      await page.goto("/login");
      await awaitHydration(page);
      await page.getByLabel("Email").fill(MEMBER);
      await page.getByRole("button", { name: "Send magic link" }).click();
      await page.getByRole("link", { name: "Open your magic link" }).click();
      await page.waitForURL(/\/shop\//u);
      await awaitHydration(page);
    });
    const written: Written[] = [];
    for (const shot of MEMBER_SHOTS) {
      const file = fileOf(shot.name);
      yield* attempt(`Could not shoot ${shot.name}`, async () => {
        await shot.take(page, shop);
        await settle(page);
        await mkdir(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, animations: "disabled" });
      });
      written.push({ file });
    }
    return written;
  });

const shootAll = (shop: string, baseURL: string) =>
  Effect.acquireUseRelease(
    attempt("Could not launch Chrome", () =>
      chromium.launch({ channel: "chrome", headless: true }),
    ),
    (browser) =>
      Effect.gen(function* () {
        const started = Date.now();
        const merchant = yield* shootMerchant(browser);
        yield* Console.log(
          `Merchant pictures took ${String(Math.round((Date.now() - started) / 1000))} s.`,
        );
        const member = yield* shootMember(browser, shop, baseURL);
        return [...merchant, ...member];
      }),
    (browser) => Effect.promise(() => browser.close()),
  );

/**
 * Whether the admin session on disk is still worth using
 * (`adminSessionFresh`), read as `e2e/shopify-admin.setup.ts` reads it.
 */
const adminSessionValid = (): boolean => {
  try {
    const { cookies } = JSON.parse(readFileSync(storageStatePath, "utf8")) as {
      readonly cookies: readonly {
        readonly name: string;
        readonly domain: string;
        readonly expires: number;
      }[];
    };
    return adminSessionFresh(cookies, statSync(storageStatePath).mtimeMs);
  } catch {
    return false;
  }
};

const helpScreenshots = (port: string, store: string) =>
  Effect.gen(function* () {
    const status = yield* runCommand("pnpm", [
      "--silent",
      "dev:status",
      "--json",
    ]);
    const healthy = yield* Effect.try({
      try: () => (JSON.parse(status) as { readonly healthy?: unknown }).healthy,
      catch: (cause) =>
        new HelpScreenshotsError({
          message: "Could not read pnpm dev:status --json",
          cause,
        }),
    });
    if (healthy !== true)
      yield* new HelpScreenshotsError({
        message:
          "The dev server is not healthy (pnpm dev:status); start it with pnpm dev:start.",
      });
    if (!adminSessionValid()) {
      yield* Console.log(
        `The admin session in ${storageStatePath} is stale; exporting it again from Chrome (this may ask for the Keychain)…`,
      );
      yield* refreshShopifyAuth({
        output: storageStatePath,
        profile: CHROME_PROFILE,
      });
    }
    yield* Console.log("Readying the store and seeding the showcase shop…");
    yield* runCommand("pnpm", ["showcase:store"]);
    yield* runCommand("pnpm", ["seed", "--showcase"]);
    const written = yield* shootAll(
      `${store}.myshopify.com`,
      `http://localhost:${port}`,
    ).pipe(
      Effect.ensuring(
        Console.log("Putting the store back on the development fixture…").pipe(
          Effect.andThen(runCommand("pnpm", ["seed"])),
          Effect.orDie,
        ),
      ),
    );
    yield* Console.log(
      [
        `Wrote ${String(written.length)} pictures:`,
        ...written.map(({ file, aspectRatio }) =>
          aspectRatio === undefined
            ? file
            : `${file}  aspectRatio "${aspectRatio}"`,
        ),
      ].join("\n  "),
    );
  });

NodeRuntime.runMain(
  (port === undefined || store === undefined
    ? Effect.fail(
        new HelpScreenshotsError({
          message:
            "pnpm help:screenshots requires PORT and SHOPIFY_DEV_STORE in .env (run via `pnpm help:screenshots`).",
        }),
      )
    : helpScreenshots(port, store)
  ).pipe(Effect.provide(NodeServices.layer)),
);
