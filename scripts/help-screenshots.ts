#!/usr/bin/env node
/**
 * `vp run help:screenshots`: retakes the help's pictures against the dev fixture on this
 * checkout's dev server, the spec in `HELP_PICTURES` for what each one shows. In order: refuses to
 * start unless the dev server is healthy (`vp run dev:status`); checks the Shopify admin session
 * the `shopify-admin` e2e setup exports (`storageStatePath`) and exports it again from Chrome
 * when it is older than a day, stopping before the store is touched if that fails; loads the dev
 * fixture; shoots every merchant picture in the Shopify admin, 1280 × 800 at 2x; signs in as the
 * fixture's member `ana@example.com` on a 390 × 844 phone at 2x and shoots every member picture;
 * loads the dev fixture again, also when a shot failed; prints what it wrote, and each merchant
 * picture's clip in CSS px, which is the inventory's `aspectRatio`. Headless and light theme
 * throughout.
 *
 * Playwright's library API, not the Playwright CLI: the shots are a program a rerun repeats, not
 * a session someone drives. The items are found by their order number, which the fixture gives
 * each order by its place, so a picture follows its item if the fixture's order changes. One
 * member shot writes a Done (Starting and finishing tasks' third picture) and the merchant shots
 * create a workflow and a team and delete a team; the closing fixture load takes them back.
 *
 * A merchant picture is one of four shapes ({@link MERCHANT_SHAPES}), and before each one
 * {@link overlapCheck} refuses the shot if a Shopify admin overlay would land in it.
 *
 * A rerun shoots the same frames but not the same bytes: the fixture is placed relative to now, so
 * every item page shows the time it ran. Rerun when a screen changes, not to refresh.
 *
 * `--section <slug>` shoots only the pictures whose `file` starts with `<slug>/`, merchant and
 * member alike, in their array order; without it every picture is shot. The gates, the fixture
 * load and the closing reload run either way, and a slug no picture has is refused. Since a
 * section may run alone, the shots for one section are a block that starts from a bare screen
 * ({@link openScreen} gets there from anywhere) and ends with every modal cancelled and the editor
 * window closed, so the next block starts clean.
 *
 * `--listing` shoots the App Store listing's screenshots instead ({@link LISTING_SHOTS}), into
 * `tmp/listing/` with their alt text, behind the same gates and fixture loads: each desktop shot
 * is the app pane, its title bar included, in a window where the pane is 16:9, at 2x and scaled to
 * 1600 × 900; each mobile shot is a member screen on a 9:16 phone, scaled to 900 × 1600.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  type Browser,
  chromium,
  expect as baseExpect,
  type FrameLocator,
  type Locator,
  type Page,
} from "playwright/test";

import { fixture } from "../fixture.ts";
import { storageStatePath } from "../playwright.config.ts";
import {
  HELP_PICTURES,
  HELP_PICTURES_PATH,
  type HelpPictureName,
  MEMBER_SCREEN,
  MERCHANT_WINDOW,
} from "../src/web/components/help/pictures.ts";
import { clickHoisted, editorFrame, hoistedEnabled } from "../test/e2e/embedded/app.ts";
import { runCommand } from "./lib/command.ts";
import { appFrame, awaitHydration, gotoApp, HIDE_OVERLAYS } from "./lib/embedded-app.ts";
import { applyFixture } from "./lib/fixture.ts";
import {
  altText,
  DESKTOP,
  LISTING_DIR,
  LISTING_SHOTS,
  type ListingShotId,
  MOBILE,
  MOBILE_SCREEN,
} from "./lib/listing-screenshots.ts";
import { measurePane, PANE_VIEWPORT, paneCrop } from "./lib/screencast-take.ts";
import {
  adminSessionFresh,
  CHROME_PROFILE,
  exportShopifyAdminAuth,
} from "./lib/shopify-admin-auth.ts";

class HelpScreenshotsError extends Schema.TaggedError<HelpScreenshotsError>()(
  "HelpScreenshotsError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const MEMBER = "ana@example.com";

/** The `--section <slug>` argument, or `undefined` for every picture. */
const sectionArgument = (args: readonly string[]): string | undefined => {
  const at = args.indexOf("--section");
  return at === -1 ? undefined : (args[at + 1] ?? "");
};

const section = sectionArgument(process.argv.slice(2));
const listing = process.argv.slice(2).includes("--listing");

/** Whether a picture is in this run: in the `--section`, or every one without it. */
const inSection = (name: HelpPictureName) =>
  section === undefined || HELP_PICTURES[name].file.startsWith(`${section}/`);

const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new HelpScreenshotsError({
        message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

/** The fixture order whose one item carries this property value, by its number. */
const orderWith = (value: string): string => {
  const order = fixture.orders.find((each) =>
    each.lineItems.some((item) => item.properties.some((property) => property.value === value)),
  );
  if (order === undefined) throw new Error(`no fixture order has an item with "${value}"`);
  return `#${String(order.n)}`;
};

/** The fixture order with an item of this product in this variant, by its number. */
const orderOf = (title: string, variantTitle: string): string => {
  const order = fixture.orders.find((each) =>
    each.lineItems.some((item) => item.title === title && item.variantTitle === variantTitle),
  );
  if (order === undefined) throw new Error(`no fixture order has a ${title} in ${variantTitle}`);
  return `#${String(order.n)}`;
};

/**
 * Playwright's default of 5 s is short for the tunnel; the e2e config uses 10 s. Only this
 * script's own waits see it: `expect.configure` returns a new instance, so the e2e helpers keep
 * their 5 s.
 */
const expect = baseExpect.configure({ timeout: 10_000 });

/**
 * Wait until a Polaris button accepts clicks: the member screens disable every verb until the
 * socket identifies, and a picture taken before then shows greyed buttons. Reads the element's
 * own `disabled`.
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

/**
 * A client navigation in `scope` has landed: the page with this heading is there and the document
 * is hydrated, then a beat for the loader's data to paint.
 */
const awaitPage = async (scope: Page | FrameLocator, heading: string) => {
  await scope.locator(`s-page[heading="${heading}"]`).first().waitFor();
  await awaitHydration(scope);
};

/** The workflows list, then the item on this order through the search, as a member gets there. */
const openItem = async (page: Page, shop: string, orderName: string) => {
  await page.goto(`/shop/${shop}/workflows`);
  await awaitHydration(page);
  const search = page.getByRole("searchbox", { name: "Search" });
  await search.fill(orderName.slice(1));
  await search.press("Enter");
  await page
    .getByRole("link", { name: new RegExp(`^Open .+ on ${orderName}$`, "u") })
    // An item can be listed twice under a search: open, and in Done or closed for a task done on
    // it in the last day. Both open its page.
    .first()
    .click();
  await awaitPage(page, orderName);
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
      await awaitEnabled(page.getByRole("button", { name: /^Actions for /u }).first());
    },
  },
  {
    name: "findingYourWork2",
    take: async (page) => {
      await page.getByRole("button", { name: /^Ready, [\d,]+(?:, selected)?$/u }).click();
      await page.getByRole("combobox", { name: "Team" }).selectOption({ label: "Engraving" });
      await page.getByRole("button", { name: /^Ready, [\d,]+, selected$/u }).waitFor();
      await page.waitForURL(/team=/u);
      await awaitEnabled(page.getByRole("button", { name: /^Actions for /u }).first());
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
      await awaitEnabled(button(page, "Done"));
      await page.getByRole("button", { name: "Page actions" }).click();
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
 * Marks the admin's own part of a picture (the title bar the page shape found, the editor's
 * window), so the overlap check counts it as the picture rather than as something over it.
 */
const SHOT_MARK = "data-help-shot";

/** Marks an admin box around a frame whose corners are rounded; see {@link SQUARE_CORNERS}. */
const SQUARE_MARK = "data-help-square";

/**
 * Applied only while a merchant picture is shot (Playwright's screenshot `style` reaches into
 * frames and shadow roots). The admin rounds the box that holds the app frame and the title bar,
 * the editor's window and every modal panel, and a clip to any of them would otherwise keep the
 * dark admin background or the dimmed backdrop in its corners, against the help page's white. A
 * modal's panel is its `dialog`; the admin's boxes are found by {@link markRoundedBoxes}, so no
 * Shopify class name is needed.
 */
const SQUARE_CORNERS = `dialog, [${SQUARE_MARK}] { border-radius: 0 !important; }`;

/**
 * Marks every ancestor of the app and editor frames with any rounded corner with
 * {@link SQUARE_MARK}: the admin rounds only the bottom corners of the box around a tall page.
 */
const markRoundedBoxes = (page: Page) =>
  page.evaluate(
    ({ appIframe, editorIframe, mark }) => {
      for (const frame of document.querySelectorAll(`${appIframe}, ${editorIframe}`))
        for (let element = frame.parentElement; element !== null; element = element.parentElement)
          if (
            ["TopLeft", "TopRight", "BottomLeft", "BottomRight"].some(
              (corner) =>
                getComputedStyle(element).getPropertyValue(
                  `border-${corner
                    .replace(/([A-Z])/gu, "-$1")
                    .toLowerCase()
                    .slice(1)}-radius`,
                ) !== "0px",
            )
          )
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
 * A clip on whole CSS px, so the file is exactly twice it and the inventory's `aspectRatio` is
 * two whole numbers: the edges round outward by under 1 px.
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
 * The admin's title bar above the app frame: the outermost ancestor of the element at
 * `(frame.x + 300, 30)` whose width is within 40 px of the frame's, whose top is under 20 px and
 * whose height is under 120 px (the height bound keeps it from climbing to the box that holds
 * both the bar and the frame). Marked with {@link SHOT_MARK}.
 */
const titleBar = async (page: Page, frame: Clip): Promise<Clip> => {
  const bar = await page.evaluate(
    ({ frame, mark }) => {
      for (const marked of document.querySelectorAll(`[${mark}]`)) marked.removeAttribute(mark);
      let element = document.elementFromPoint(frame.x + 300, frame.y - 30);
      let found: Element | null = null;
      while (element !== null && element !== document.body) {
        const rect = element.getBoundingClientRect();
        if (
          Math.abs(rect.width - frame.width) <= 40 &&
          rect.top < frame.y &&
          rect.bottom <= frame.y + 1 &&
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
      "found no title bar above the app frame (an element at the frame's width, just above it)",
    );
  return bar;
};

/**
 * Refuses the shot if something in the admin document would land in it: every element whose
 * computed `position` is `fixed`, `sticky` or `absolute`, visible (a non-zero box, `visibility`
 * not hidden, `opacity` not 0), that is not the app frame, the editor frame or a part marked
 * {@link SHOT_MARK}, nor an ancestor or a descendant of one, and whose box intersects the clip.
 * `absolute` is there because the Sidekick dock is positioned that way and still lands over the
 * frame. Two refinements keep the check from refusing what the picture does not show: the
 * element, or something inside it, must draw within the clip (a fill, an image, a border, a
 * shadow, text), since the admin keeps transparent layers over the frame for toasts and modals;
 * and an element the hit test finds under the picture's own parts at every sampled point of the
 * overlap is covered and passes. An element the hit test never finds (`pointer-events: none`)
 * counts as on top, so a click-through overlay is still refused. An element in an `inert` subtree
 * passes: the admin makes its page inert behind the editor window, which now spans the sidebar,
 * and the hit test never finds inert content, so it would read as on top.
 */
const overlapCheck = async (page: Page, clip: Clip) => {
  const found = await page.evaluate(
    ({ clip, appIframe, editorIframe, mark }) => {
      const kept = [...document.querySelectorAll(`${appIframe}, ${editorIframe}, [${mark}]`)];
      const isKept = (element: Element) =>
        kept.some((each) => element.contains(each) || each.contains(element));
      const intersects = (rect: DOMRect) =>
        Math.min(rect.right, clip.x + clip.width) > Math.max(rect.left, clip.x) &&
        Math.min(rect.bottom, clip.y + clip.height) > Math.max(rect.top, clip.y);
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
              (side) => style.getPropertyValue(`border-${side}-width`) !== "0px",
            ) ||
            ["IMG", "SVG", "CANVAS", "VIDEO", "IFRAME"].includes(element.tagName.toUpperCase()) ||
            [...element.childNodes].some(
              (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
            ))
        );
      };
      /** It or something inside it draws within the clip. */
      const drawsInClip = (element: Element) =>
        [element, ...element.querySelectorAll("*")].some((each) => {
          const rect = each.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && intersects(rect) && paints(each);
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
        return above.length === 0 || above.some((stack) => !stack.some((hit) => isKept(hit)));
      };
      return [...document.querySelectorAll("*")]
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
            element.closest("[inert]") === null &&
            shows(element, rect) &&
            drawsInClip(element)
          );
        })
        .map(
          (element) =>
            `${element.tagName.toLowerCase()}.${(element.getAttribute("class") ?? "").slice(0, 60)}`,
        );
    },
    { clip, appIframe: APP_IFRAME, editorIframe: EDITOR_IFRAME, mark: SHOT_MARK },
  );
  if (found.length > 0)
    throw new Error(`refused: an admin overlay intersects the clip: ${found.join(", ")}`);
};

/**
 * The editor's window: the admin's box that holds the editor frame and the window's title bar
 * with its Close, inset from the window's edges so the admin's sidebar shows beside it. The
 * admin no longer marks it a `dialog`, so it is the nearest ancestor of the frame that holds a
 * button, as `closeEditor` finds the Close. Marked with {@link SHOT_MARK}.
 */
const editorWindow = async (page: Page): Promise<Clip> => {
  const found = await page.evaluate(
    ({ editorIframe, mark }) => {
      for (const marked of document.querySelectorAll(`[${mark}]`)) marked.removeAttribute(mark);
      let element = document.querySelector(editorIframe)?.parentElement ?? null;
      while (element !== null && element.querySelector("button") === null)
        element = element.parentElement;
      if (element === null) return null;
      element.setAttribute(mark, "");
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    },
    { editorIframe: EDITOR_IFRAME, mark: SHOT_MARK },
  );
  if (found === null) throw new Error("found no window around the editor frame");
  return found;
};

/** The open modal's panel inside a frame, in page coordinates. */
const modalPanel = async (frame: FrameLocator) =>
  whole(await box(frame.locator("s-modal dialog[open]").first(), "the open modal"));

/**
 * How far down the frame's document its content reaches, in CSS px: the lowest bottom edge of
 * any element in the body, shadow roots included, since Polaris draws its cards and its text
 * inside them and a slotted element can have no box of its own. Not the document's
 * `scrollHeight`, which is never less than the frame's own height, so a short page would be shot
 * with the window's empty lower half under it.
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

/** Shoots `clip` once the overlap check passes, the admin's rounded corners squared. */
const shoot = async (page: Page, file: string, clip: Clip) => {
  await overlapCheck(page, clip);
  await markRoundedBoxes(page);
  await page.screenshot({ path: file, clip, animations: "disabled", style: SQUARE_CORNERS });
  return clip;
};

/**
 * The four merchant shapes, each a function of the admin page that settles it, runs the overlap
 * check and writes the file, returning the clip in CSS px:
 *
 * - `page`: the title bar and the app frame, down to 20 px under the frame's
 *   {@link contentHeight}. The viewport grows to that when the content is taller than the window
 *   (refused past {@link MAX_PAGE_HEIGHT}) and is put back after; it never shrinks, since in a
 *   shorter window the collapsed Dev Console rises into the frame. The clip runs across the
 *   frame's width.
 * - `modal`: the open `s-modal`'s panel in the app frame, no margin.
 * - `window`: the editor's window ({@link editorWindow}), down to 20 px under the editor frame's
 *   {@link contentHeight}, as the page shape does.
 * - `editor modal`: the open `s-modal`'s panel in the editor frame.
 */
const MERCHANT_SHAPES = {
  page: async (page: Page, file: string): Promise<Clip> => {
    await settle(page);
    const height = await appFrame(page).locator("body").evaluate(contentHeight);
    const before = await box(page.locator(APP_IFRAME), "the app frame");
    const fitted = Math.ceil(before.y + height + 20);
    if (fitted > MAX_PAGE_HEIGHT)
      throw new Error(`the page is ${String(fitted)} CSS px tall, past ${String(MAX_PAGE_HEIGHT)}`);
    await page.setViewportSize({
      width: MERCHANT_WINDOW.width,
      height: Math.max(fitted, MERCHANT_WINDOW.height),
    });
    try {
      await settle(page);
      const frame = await box(page.locator(APP_IFRAME), "the app frame");
      const bar = await titleBar(page, frame);
      return await shoot(
        page,
        file,
        whole({
          x: frame.x,
          y: bar.y,
          width: frame.width,
          height: Math.min(frame.y + frame.height, fitted) - bar.y,
        }),
      );
    } finally {
      await page.setViewportSize(MERCHANT_WINDOW);
    }
  },
  modal: async (page: Page, file: string): Promise<Clip> => {
    await settle(page);
    return shoot(page, file, await modalPanel(appFrame(page)));
  },
  window: async (page: Page, file: string): Promise<Clip> => {
    await settle(page);
    const shell = await editorWindow(page);
    const frame = await box(page.locator(EDITOR_IFRAME), "the editor frame");
    const height = await editorFrame(page).locator("body").evaluate(contentHeight);
    return shoot(
      page,
      file,
      whole({
        ...shell,
        height: Math.min(shell.y + shell.height, frame.y + height + 20) - shell.y,
      }),
    );
  },
  "editor modal": async (page: Page, file: string): Promise<Clip> => {
    await settle(page);
    return shoot(page, file, await modalPanel(editorFrame(page)));
  },
} as const;

type NavScreen = "Orders" | "Workflows" | "Teams" | "Members";

/**
 * The App nav's link to `name`, hoisted into the admin's chrome. Scoped to links into an app
 * (`/apps/` in the href): the admin's own nav has an Orders link too.
 */
const navLink = (page: Page, name: NavScreen) =>
  page.getByRole("link", { name, exact: true }).and(page.locator('a[href*="/apps/"]'));

/**
 * A screen from the App nav, bare (no filter, no search). From a page under the screen's path the
 * nav click would keep the search the orders layout retains, so the click goes through another
 * screen first.
 */
const openScreen = async (page: Page, name: NavScreen) => {
  const screenPath = `/app/${name.toLowerCase()}`;
  const under = (url: URL) =>
    url.pathname.endsWith(screenPath) || url.pathname.includes(`${screenPath}/`);
  if (under(new URL(page.url()))) {
    const other = name === "Orders" ? "Teams" : "Orders";
    await clickHoisted(navLink(page, other));
    await awaitPage(appFrame(page), other);
  }
  await clickHoisted(navLink(page, name));
  await expect(page).toHaveURL((url) => url.pathname.endsWith(screenPath));
  await awaitPage(appFrame(page), name);
};

/** An order's page, by its number, through the orders index's search. */
const openOrder = async (page: Page, orderName: string) => {
  await openScreen(page, "Orders");
  const frame = appFrame(page);
  const search = frame.getByRole("searchbox", { name: "Search" });
  await search.fill(orderName.slice(1));
  await search.press("Enter");
  await frame.getByRole("link", { name: orderName, exact: true }).click();
  await awaitPage(frame, orderName);
};

/** The order Reading an order pictures: three items in three states, a note, an order note. */
const ORDER_PAGE = orderWith("Sam and Priya, 14 October");

const WORKFLOW = "Engraved pen";
const TEAM = "Assembly";

/**
 * A More actions item: the hoisted menu is unreachable, so the hidden in-frame
 * `s-menu#<menu>` button is clicked natively. The workflow page's menu is `workflow-actions`,
 * the team page's `team-actions`.
 */
const clickMenuItemIn = (frame: FrameLocator, menu: string, name: string) =>
  frame.locator(`s-menu#${menu} s-button`, { hasText: name }).evaluate((el) => {
    (el as HTMLElement).click();
  });

/** A More actions item on the workflow page ({@link clickMenuItemIn}). */
const clickMenuItem = (frame: FrameLocator, name: string) =>
  clickMenuItemIn(frame, "workflow-actions", name);

/**
 * Moves the pointer to the app frame's top left corner, inside the frame and on no control. A
 * row link's click leaves the pointer where it pressed, and the next index that puts a row there
 * shows that link hovered (underlined). Moving it out of the frame, to the admin's corner, does
 * not clear the frame's hover; a move inside the frame does.
 */
const parkPointer = async (page: Page) => {
  const frame = await box(page.locator(APP_IFRAME), "the app frame");
  await page.mouse.move(frame.x + 4, frame.y + 4);
};

/**
 * A row link in the frame's index table, then its page, by the page's heading, the pointer parked
 * after. The link is clicked natively: a row at the foot of the window sits in the dead band a
 * page shot's viewport resize leaves behind ({@link openModalBy}), so Playwright's pointer click
 * lands on nothing.
 */
const openRow = async (page: Page, name: string) => {
  const frame = appFrame(page);
  await frame.getByRole("link", { name, exact: true }).evaluate((element) => {
    (element as HTMLElement).click();
  });
  await awaitPage(frame, name);
  await parkPointer(page);
};

/**
 * The named dismiss of the open modal in a frame, returning once no modal is open. Most modals'
 * dismiss is Cancel ({@link cancelModal}); the Cancel workflow modal's is Keep workflow.
 */
const dismissModal = async (frame: FrameLocator, name: string) => {
  // The buttons are the `s-modal`'s slotted children, outside its shadow `dialog`; a hidden
  // modal's are not in the accessibility tree, so the name finds the open one's.
  await frame.getByRole("button", { name, exact: true }).click();
  await expect(frame.locator("s-modal dialog[open]")).toHaveCount(0);
};

/** Cancel in the open modal of a frame ({@link dismissModal}). */
const cancelModal = (frame: FrameLocator) => dismissModal(frame, "Cancel");

/** Cancels the open modal in the app frame, if one is open: a block's guard against the last block's open modal. */
const cancelOpenModal = async (page: Page) => {
  const frame = appFrame(page);
  if ((await frame.locator("s-modal dialog[open]").count()) > 0) await cancelModal(frame);
};

/** An item's card on the order page, by its heading: the item's title and variant, "Wall clock — Oak". */
const itemCard = (frame: FrameLocator, title: string) =>
  frame.locator("s-section").filter({
    has: frame.getByRole("heading", { name: title, exact: true }),
  });

/**
 * Presses a button that opens a modal with a native click, again until the modal's dialog is
 * open. Change workflow and Cancel workflow sit in the Manage drawer near the window's foot, and
 * Playwright's click on them opens nothing once the page has been through a viewport resize (the
 * page shape grows the window for a tall picture and restores it): from then on the admin
 * document receives the pointer events on the iframe and the frame document receives none of
 * them, for every point under about 716 CSS px of the 800 high window, until a full reload. A
 * merchant's browser never emulates a viewport, so it is not affected. A native `click()` on the
 * element does not go through the hit test and opens the modal first time.
 */
const openModalBy = async (control: Locator, modal: Locator) => {
  await expect(async () => {
    await control.evaluate((element) => {
      (element as HTMLElement).click();
    });
    await expect(modal.locator("dialog[open]")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
};

/** A button in the frame, waited for until it accepts clicks. */
const awaitFrameButton = (scope: FrameLocator | Locator, name: string) =>
  expect(scope.getByRole("button", { name, exact: true }).first()).toBeEnabled();

/**
 * Puts the dev fixture back, mid-run: the Orders block deletes the team Packing for its Needs a
 * team pictures, and no later picture may see that.
 */
const loadFixture = applyFixture({ fixture, waitForInstall: false });

/**
 * The editor window's Close, the X the admin draws in the window's title bar, returning once the
 * window's frame is gone. Scoped to the window as `closeEditor` in the e2e helpers is: the Dev
 * Console and Sidekick answer to "Close" too.
 */
const closeEditor = async (page: Page) => {
  await page
    .locator(EDITOR_IFRAME)
    .locator("xpath=ancestor::*[.//button][1]")
    .getByRole("button", { name: "Close", exact: true })
    .evaluate((element) => {
      (element as HTMLElement).click();
    });
  await expect(page.locator(EDITOR_IFRAME)).toHaveCount(0);
};

/** The workflow page's Edit, retried until the editor window opens, then its document hydrated. */
const openEditor = async (page: Page) => {
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await expect(async () => {
    await clickHoisted(edit);
    await expect(page.locator(EDITOR_IFRAME)).toBeAttached({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  const editor = editorFrame(page);
  await editor.locator("s-page[heading]").first().waitFor();
  await awaitHydration(editor);
};

/** A workflow's page from the Workflows list, by its name. */
const openWorkflow = async (page: Page, name: string) => {
  await openScreen(page, "Workflows");
  const frame = appFrame(page);
  await frame.getByRole("link", { name, exact: true }).click();
  await awaitPage(frame, name);
};

/** Each merchant picture's state and shape, as a function of the admin page. Run in this order. */
const MERCHANT_SHOTS: readonly {
  readonly name: HelpPictureName;
  readonly shape: keyof typeof MERCHANT_SHAPES;
  readonly take: (page: Page) => Promise<void>;
  /** Run once the shape has written the file: a write the next block must not see is undone here. */
  readonly after?: typeof loadFixture;
}[] = [
  {
    name: "installing1",
    shape: "page",
    take: async (page) => {
      await gotoApp(page, "app");
      await awaitPage(appFrame(page), "Baton");
      await appFrame(page).getByRole("link", { name: "Help", exact: true }).waitFor();
      await parkPointer(page);
    },
  },
  {
    name: "howBatonWorks1",
    shape: "page",
    take: async (page) => {
      await openOrder(page, orderWith("Grandma Rose"));
      await parkPointer(page);
    },
  },
  {
    name: "firstOrder1",
    shape: "page",
    take: async (page) => {
      await openOrder(page, orderWith("Fresh bread"));
      await parkPointer(page);
    },
  },
  {
    name: "creating1",
    shape: "page",
    take: async (page) => {
      await openScreen(page, "Workflows");
      await appFrame(page).getByRole("link", { name: "Weekend engraving", exact: true }).waitFor();
      await parkPointer(page);
    },
  },
  {
    name: "editing1",
    shape: "window",
    take: async (page) => {
      const frame = appFrame(page);
      await frame.getByRole("link", { name: "Embroider and fold", exact: true }).click();
      await awaitPage(frame, "Embroider and fold");
      await openEditor(page);
      await editorFrame(page).getByText("Sew in care label", { exact: true }).first().waitFor();
    },
  },
  {
    name: "editing2",
    shape: "window",
    take: async (page) => {
      const editor = editorFrame(page);
      await editor.getByRole("button", { name: "Edit Sew in care label", exact: true }).click();
      await editor.getByRole("button", { name: "Move earlier" }).waitFor();
    },
  },
  {
    name: "editing3",
    shape: "editor modal",
    take: async (page) => {
      await clickHoisted(page.getByRole("button", { name: "Apply changes" }));
      await editorFrame(page).getByText("take effect now", { exact: false }).waitFor();
    },
  },
  {
    name: "matching2",
    shape: "modal",
    take: async (page) => {
      await cancelModal(editorFrame(page));
      await closeEditor(page);
      const frame = appFrame(page);
      await frame.getByRole("button", { name: "Edit tag", exact: true }).click();
      await frame.getByText("stop matching until you retag them", { exact: false }).waitFor();
    },
  },
  {
    name: "turningOnAndOff1",
    shape: "modal",
    take: async (page) => {
      await cancelModal(appFrame(page));
      await openWorkflow(page, "Cut, engrave and oil");
      await clickHoisted(page.getByRole("button", { name: "Turn off workflow", exact: true }));
      await appFrame(page)
        .getByText("New orders won't start this workflow.", { exact: false })
        .waitFor();
    },
  },
  {
    name: "managing1",
    shape: "modal",
    take: async (page) => {
      const frame = appFrame(page);
      await cancelModal(frame);
      await clickMenuItem(frame, "Duplicate");
      await expect(frame.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(
        "Cut, engrave and oil copy",
      );
    },
  },
  {
    name: "managing2",
    shape: "modal",
    take: async (page) => {
      const frame = appFrame(page);
      await cancelModal(frame);
      await clickMenuItem(frame, "Delete");
      await frame.getByText("This can't be undone.", { exact: false }).waitFor();
    },
  },
  {
    name: "turningOnAndOff2",
    shape: "page",
    take: async (page) => {
      await cancelModal(appFrame(page));
      await openWorkflow(page, "Frame and glaze");
      await parkPointer(page);
    },
  },
  {
    name: "matching1",
    shape: "page",
    take: async (page) => {
      await openOrder(page, orderOf("Journal and pen gift set", "Black"));
      await parkPointer(page);
    },
  },
  {
    name: "creatingATeam1",
    shape: "page",
    take: async (page) => {
      await openScreen(page, "Teams");
      await appFrame(page).getByRole("link", { name: "Woodshop", exact: true }).waitFor();
      await parkPointer(page);
    },
  },
  {
    name: "creatingATeam2",
    shape: "page",
    take: async (page) => {
      await openRow(page, "Engraving");
      await appFrame(page).getByText("carmen@example.com", { exact: true }).first().waitFor();
    },
  },
  {
    name: "addingAMember1",
    shape: "page",
    take: async (page) => {
      await openScreen(page, "Members");
      await appFrame(page).getByRole("link", { name: "gus@example.com", exact: true }).waitFor();
      await parkPointer(page);
    },
  },
  {
    name: "addingAMember2",
    shape: "modal",
    take: async (page) => {
      await clickHoisted(page.getByRole("button", { name: "Add member", exact: true }));
      await appFrame(page)
        .locator("s-modal#add-member")
        .getByRole("textbox", { name: "Email", exact: true })
        .waitFor();
    },
  },
  {
    name: "addingAMember4",
    shape: "page",
    take: async (page) => {
      const frame = appFrame(page);
      await cancelModal(frame);
      await openRow(page, MEMBER);
      await frame
        .locator("s-table-cell")
        .getByRole("link", { name: "Finishing", exact: true })
        .waitFor();
    },
  },
  {
    name: "addingAMember3",
    shape: "modal",
    take: async (page) => {
      await clickHoisted(page.getByRole("button", { name: "Add to teams", exact: true }));
      await appFrame(page)
        .locator("s-modal#add-member-teams")
        .getByRole("searchbox", { name: "Search teams by name" })
        .waitFor();
    },
  },
  {
    name: "removingAndDeleting1",
    shape: "modal",
    take: async (page) => {
      await cancelModal(appFrame(page));
      await clickHoisted(page.getByRole("button", { name: "Delete member", exact: true }));
      await appFrame(page)
        .locator("s-modal#delete-member")
        .getByText("This can't be undone.", { exact: false })
        .waitFor();
    },
  },
  {
    name: "removingAndDeleting2",
    shape: "modal",
    take: async (page) => {
      const frame = appFrame(page);
      await cancelModal(frame);
      await openScreen(page, "Teams");
      await openRow(page, "Packing");
      await clickMenuItemIn(frame, "team-actions", "Delete");
      const modal = frame.locator("s-modal#delete-team");
      await modal.getByText("This can't be undone.", { exact: false }).waitFor();
      // Delete waits on the socket.
      await expect(modal.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
    },
  },
  {
    name: "ordersList1",
    shape: "page",
    take: async (page) => {
      // The Teams and members block ends on its Delete modal, open.
      await cancelOpenModal(page);
      await openScreen(page, "Orders");
      await expect
        .poll(() =>
          hoistedEnabled(page.getByRole("button", { name: "Sync open orders", exact: true })),
        )
        .toBe(true);
      await appFrame(page).getByRole("link", { name: "#1203", exact: true }).waitFor();
      await parkPointer(page);
    },
  },
  {
    name: "orderPage1",
    shape: "page",
    take: async (page) => {
      await openRow(page, ORDER_PAGE);
      await appFrame(page).getByRole("heading", { name: "Order note", exact: true }).waitFor();
    },
  },
  {
    name: "orderPage2",
    shape: "page",
    take: async (page) => {
      const frame = appFrame(page);
      const card = itemCard(frame, "Engraved cutting board — Walnut");
      await card.getByRole("button", { name: "Manage", exact: true }).click();
      await card.getByText("Cut, engrave and oil workflow", { exact: true }).waitFor();
      // The verbs are disabled until the socket identifies.
      await awaitFrameButton(card, "Done");
      await parkPointer(page);
    },
  },
  {
    name: "attachingAWorkflow1",
    shape: "page",
    take: async (page) => {
      await openOrder(page, orderOf("Gift card", "$50"));
      await parkPointer(page);
      await itemCard(appFrame(page), "Gift card — $50")
        .getByRole("combobox", { name: "Workflow" })
        .waitFor();
    },
  },
  {
    name: "attachingAWorkflow2",
    shape: "modal",
    take: async (page) => {
      await openOrder(page, orderWith("Grandma Rose"));
      await parkPointer(page);
      const frame = appFrame(page);
      const card = itemCard(frame, "Engraved cutting board — Maple");
      await card.getByRole("button", { name: "Manage", exact: true }).click();
      await awaitFrameButton(card, "Change workflow");
      const modal = frame.locator("s-modal#change-workflow");
      await openModalBy(card.getByRole("button", { name: "Change workflow", exact: true }), modal);
      await modal
        .getByRole("combobox", { name: "Workflow" })
        .selectOption({ label: "Clock assembly" });
      await modal.getByText("anyway?", { exact: false }).waitFor();
      await awaitFrameButton(modal, "Change workflow");
    },
  },
  {
    name: "attachingAWorkflow3",
    shape: "modal",
    take: async (page) => {
      const frame = appFrame(page);
      await cancelModal(frame);
      const modal = frame.locator("s-modal#cancel-run");
      const cancelWorkflow = itemCard(frame, "Engraved cutting board — Maple").getByRole("button", {
        name: "Cancel workflow",
        exact: true,
      });
      await openModalBy(cancelWorkflow, modal);
      await modal
        .getByText("Steps already done still show on the order.", { exact: false })
        .waitFor();
      await awaitFrameButton(modal, "Cancel workflow");
    },
  },
  {
    name: "fixingIssues1",
    shape: "page",
    take: async (page) => {
      const frame = appFrame(page);
      await dismissModal(frame, "Keep workflow");
      // The only way an order reads Needs a team: its task's team is deleted.
      await openScreen(page, "Teams");
      await openRow(page, "Packing");
      await clickMenuItemIn(frame, "team-actions", "Delete");
      const modal = frame.locator("s-modal#delete-team");
      await awaitFrameButton(modal, "Delete");
      await modal.getByRole("button", { name: "Delete", exact: true }).click();
      await awaitPage(frame, "Teams");
      await openScreen(page, "Orders");
      await frame.getByRole("combobox", { name: "Show" }).selectOption({ label: "Issues" });
      await expect(page).toHaveURL(/show=issues/u);
      await awaitHydration(frame);
      // Not the gift set: the delete leaves Stamp and bind with a task on no team, so it is no
      // longer eligible, the gift set matches one workflow and Multiple workflows match leaves
      // the list.
      await frame.getByRole("link", { name: orderWith("Smith family"), exact: true }).waitFor();
      await frame.getByText("Needs a team", { exact: true }).first().waitFor();
      await parkPointer(page);
    },
  },
  {
    name: "fixingIssues2",
    shape: "page",
    take: async (page) => {
      await openRow(page, orderWith("Smith family"));
      const banner = appFrame(page).locator('s-banner[heading="Blocked"]');
      await banner.waitFor();
      await awaitFrameButton(banner, "Unblock");
    },
  },
  {
    name: "fixingIssues3",
    shape: "page",
    take: async (page) => {
      await openOrder(page, orderWith("C.O."));
      await parkPointer(page);
      const frame = appFrame(page);
      await frame.getByText("Pack: assign a team.", { exact: true }).waitFor();
      await frame.getByRole("combobox", { name: "Assign team" }).waitFor();
    },
    after: loadFixture,
  },
  {
    name: "firstWorkflow1",
    shape: "modal",
    take: async (page) => {
      // The block before may end on an open modal: a shot is taken after its `take`, so the
      // Cancel falls to the next one.
      await cancelOpenModal(page);
      const frame = appFrame(page);
      await openScreen(page, "Workflows");
      await clickHoisted(page.getByRole("button", { name: "Create workflow" }));
      const tag = frame.getByRole("textbox", { name: "Tag", exact: true });
      await frame.getByRole("textbox", { name: "Name", exact: true }).fill(WORKFLOW);
      // The Tag fills from the name as "engraved pen"; a hyphenated tag is typed, as the
      // fixture's own tags are.
      await expect(tag).toHaveValue("engraved pen");
      await tag.fill("engraved-pen");
      await expect(frame.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    },
  },
  {
    name: "firstWorkflow2",
    shape: "window",
    take: async (page) => {
      await appFrame(page).getByRole("button", { name: "Create", exact: true }).click();
      const editor = editorFrame(page);
      await editor.locator(`s-page[heading="${WORKFLOW}"]`).waitFor();
      await awaitHydration(editor);
      await editor.getByRole("button", { name: "Add step" }).click();
      await editor.getByRole("textbox", { name: "Name", exact: true }).fill("Engrave");
      await editor
        .getByRole("combobox", { name: "Team", exact: true })
        .selectOption({ label: "Engraving" });
      await editor
        .getByRole("textbox", { name: "Instructions" })
        .fill("The text is in the properties. Check the spelling before running the laser.");
      await expect(editor.getByRole("button", { name: "Add step" })).toBeEnabled();
    },
  },
  {
    name: "firstWorkflow3",
    shape: "editor modal",
    take: async (page) => {
      const editor = editorFrame(page);
      await editor.getByRole("button", { name: "Add step" }).click();
      await editor.getByText("Step 1", { exact: true }).waitFor();
      const turnOn = page.getByRole("button", { name: "Turn on workflow", exact: true });
      await expect.poll(() => hoistedEnabled(turnOn)).toBe(true);
      await clickHoisted(turnOn);
      await editor.getByText("starts this workflow on that item", { exact: false }).waitFor();
    },
  },
  {
    name: "firstTeam1",
    shape: "page",
    take: async (page) => {
      await cancelModal(editorFrame(page));
      await closeEditor(page);
      await openScreen(page, "Teams");
      await clickHoisted(page.getByRole("button", { name: "Create team" }));
      const frame = appFrame(page);
      await frame.getByRole("textbox", { name: "Name", exact: true }).fill(TEAM);
      await frame.getByRole("button", { name: "Create", exact: true }).click();
      await awaitPage(frame, TEAM);
      await parkPointer(page);
    },
  },
  {
    name: "firstTeam2",
    shape: "modal",
    take: async (page) => {
      const frame = appFrame(page);
      await frame.getByRole("button", { name: "Add members" }).first().click();
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

const merchantShots = MERCHANT_SHOTS.filter((shot) => inSection(shot.name));
const memberShots = MEMBER_SHOTS.filter((shot) => inSection(shot.name));

const shootMerchant = Effect.fn("shootMerchant")(function* (browser: Browser, appURL: string) {
  if (merchantShots.length === 0) return [];
  const context = yield* attempt("Could not open a Shopify admin page", () =>
    browser.newContext({
      storageState: storageStatePath,
      baseURL: appURL,
      viewport: MERCHANT_WINDOW,
      deviceScaleFactor: 2,
      colorScheme: "light",
    }),
  );
  const page = yield* attempt("Could not open a Shopify admin page", () => context.newPage());
  yield* attempt("Could not open Baton in the Shopify admin", async () => {
    await gotoApp(page, "app/orders").catch((error: unknown) => {
      if (page.url().includes("accounts.shopify.com"))
        throw new Error(
          `the Shopify admin asked for a sign-in: the session in ${storageStatePath} is not accepted. Delete it and rerun to export it again from Chrome.`,
          { cause: error },
        );
      throw error;
    });
    await page.addStyleTag({ content: HIDE_OVERLAYS });
  });
  const written: Written[] = [];
  for (const shot of merchantShots) {
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
    yield* Console.log(`wrote ${file}`);
    if (shot.after !== undefined) yield* shot.after;
  }
  return written;
});

const shootMember = Effect.fn("shootMember")(function* (
  browser: Browser,
  shop: string,
  baseURL: string,
) {
  if (memberShots.length === 0) return [];
  const context = yield* attempt("Could not open a page", () =>
    browser.newContext({
      baseURL,
      viewport: { width: MEMBER_SCREEN.width, height: MEMBER_SCREEN.height },
      deviceScaleFactor: 2,
      colorScheme: "light",
    }),
  );
  const page = yield* attempt("Could not open a page", () => context.newPage());
  yield* attempt(`Could not sign in as ${MEMBER}`, () => signInMember(page));
  const written: Written[] = [];
  for (const shot of memberShots) {
    const file = fileOf(shot.name);
    yield* attempt(`Could not shoot ${shot.name}`, async () => {
      await shot.take(page, shop);
      await settle(page);
      await mkdir(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, animations: "disabled" });
    });
    written.push({ file });
    yield* Console.log(`wrote ${file}`);
  }
  return written;
});

/**
 * Signs `page` in as {@link MEMBER} through the magic link the dev stage shows inline, landing on
 * the member's shop.
 */
const signInMember = async (page: Page) => {
  await page.goto("/sign-in");
  await awaitHydration(page);
  await page.getByLabel("Email").fill(MEMBER);
  await page.getByRole("button", { name: "Send link" }).click();
  await page.getByRole("link", { name: "Open link" }).click();
  await page.waitForURL(/\/shop\//u);
  await awaitHydration(page);
};

/** A member picture's state, from {@link MEMBER_SHOTS}, for a listing shot of the same screen. */
const memberTake = (name: HelpPictureName) => {
  const shot = MEMBER_SHOTS.find((each) => each.name === name);
  if (shot === undefined) throw new Error(`no member picture ${name}`);
  return shot.take;
};

/** Each desktop listing shot's state in the admin. */
const LISTING_DESKTOP: Partial<Record<ListingShotId, (page: Page) => Promise<void>>> = {
  orders: async (page) => {
    await openScreen(page, "Orders");
  },
  orderPage: async (page) => {
    await openOrder(page, ORDER_PAGE);
  },
  workflowPage: async (page) => {
    await openScreen(page, "Workflows");
    await openRow(page, "Cut, engrave and oil");
  },
  workflows: async (page) => {
    await openScreen(page, "Workflows");
  },
  orderSteps: async (page) => {
    await openOrder(page, orderWith("Bon appétit"));
    const frame = appFrame(page);
    await frame.getByRole("button", { name: "Manage" }).first().click();
    await frame.getByRole("button", { name: "Put back", exact: true }).waitFor();
  },
  issues: async (page) => {
    await openScreen(page, "Orders");
    await appFrame(page)
      .getByRole("button", { name: /^Issues, \d+/u })
      .click();
    await appFrame(page).getByText("Blocked", { exact: true }).first().waitFor();
  },
};

/** Each mobile listing shot's state on the member site: the help's member pictures' states. */
const LISTING_MOBILE: Partial<Record<ListingShotId, (page: Page, shop: string) => Promise<void>>> =
  {
    memberList: memberTake("findingYourWork1"),
    memberTask: memberTake("recordingYourWork1"),
    memberBlocked: memberTake("blocking2"),
  };

/** Scales a shot to the listing form's size; its aspect is already the form's. */
const fitTo = (file: string, size: { readonly width: number; readonly height: number }) =>
  runCommand("magick", [
    file,
    "-filter",
    "Lanczos",
    "-resize",
    `${String(size.width)}x${String(size.height)}!`,
    file,
  ]);

const shootListing = Effect.fn("shootListing")(function* (options: {
  readonly shop: string;
  readonly appURL: string;
  readonly siteURL: string;
}) {
  yield* Effect.promise(() => mkdir(LISTING_DIR, { recursive: true }));
  const browser = yield* attempt("Could not launch Chrome", () =>
    chromium.launch({ channel: "chrome", headless: true }),
  );
  const written: Written[] = [];
  try {
    const admin = yield* attempt("Could not open Baton in the Shopify admin", async () => {
      const context = await browser.newContext({
        storageState: storageStatePath,
        baseURL: options.appURL,
        viewport: PANE_VIEWPORT,
        deviceScaleFactor: 2,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await gotoApp(page, "app/orders");
      await page.addStyleTag({ content: HIDE_OVERLAYS });
      return page;
    });
    for (const shot of LISTING_SHOTS.filter(({ kind }) => kind === "desktop")) {
      const take = LISTING_DESKTOP[shot.id];
      const file = path.join(LISTING_DIR, shot.file);
      yield* attempt(`Could not shoot ${shot.id}`, async () => {
        if (take === undefined) throw new Error("no desktop take");
        await take(admin);
        await parkPointer(admin);
        await settle(admin);
        // The pane, title bar included: no Shopify top bar or admin nav, so no Shopify mark.
        // Inset as the feature video is, clear of the pane's rounded corners.
        await shoot(admin, file, paneCrop(await measurePane(admin)));
      });
      yield* fitTo(file, DESKTOP);
      written.push({ file });
      yield* Console.log(`wrote ${file}`);
    }
    const member = yield* attempt(`Could not sign in as ${MEMBER}`, async () => {
      const context = await browser.newContext({
        baseURL: options.siteURL,
        viewport: { width: MOBILE_SCREEN.width, height: MOBILE_SCREEN.height },
        deviceScaleFactor: MOBILE_SCREEN.scale,
        isMobile: true,
        hasTouch: true,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await signInMember(page);
      return page;
    });
    for (const shot of LISTING_SHOTS.filter(({ kind }) => kind === "mobile")) {
      const take = LISTING_MOBILE[shot.id];
      const file = path.join(LISTING_DIR, shot.file);
      yield* attempt(`Could not shoot ${shot.id}`, async () => {
        if (take === undefined) throw new Error("no mobile take");
        await take(member, options.shop);
        await settle(member);
        await member.screenshot({ path: file, animations: "disabled" });
      });
      yield* fitTo(file, MOBILE);
      written.push({ file });
      yield* Console.log(`wrote ${file}`);
    }
  } finally {
    yield* Effect.promise(() => browser.close());
  }
  const alt = path.join(LISTING_DIR, "alt.txt");
  yield* Effect.promise(() => writeFile(alt, altText(LISTING_SHOTS)));
  written.push({ file: alt });
  return written;
});

const shootAll = (options: {
  readonly shop: string;
  readonly appURL: string;
  readonly siteURL: string;
}) =>
  Effect.acquireUseRelease(
    attempt("Could not launch Chrome", () =>
      chromium.launch({ channel: "chrome", headless: true }),
    ),
    (browser) =>
      Effect.gen(function* () {
        const started = Date.now();
        const merchant = yield* shootMerchant(browser, options.appURL);
        yield* Console.log(
          `Merchant pictures took ${String(Math.round((Date.now() - started) / 1000))} s.`,
        );
        const member = yield* shootMember(browser, options.shop, options.siteURL);
        return [...merchant, ...member];
      }),
    (browser) => Effect.promise(() => browser.close()),
  );

const StorageState = Schema.fromJsonString(
  Schema.Struct({
    cookies: Schema.Array(
      Schema.Struct({ name: Schema.String, domain: Schema.String, expires: Schema.Number }),
    ),
  }),
);
const decodeStorageState = Schema.decodeUnknownSync(StorageState);

/**
 * Whether the admin session on disk is still worth using ({@link adminSessionFresh}), read as
 * the `shopify-admin` e2e setup reads it.
 */
const adminSessionValid = (): boolean => {
  try {
    const { cookies } = decodeStorageState(readFileSync(storageStatePath, "utf8"));
    return adminSessionFresh(cookies, statSync(storageStatePath).mtimeMs);
  } catch {
    return false;
  }
};

/** The app's handle, from the `handle = "…"` line of `shopify.app.toml`. */
const appHandle = () => {
  const line = readFileSync("shopify.app.toml", "utf8")
    .split("\n")
    .find((each) => each.startsWith("handle = "));
  return line?.slice('handle = "'.length, -1);
};

const helpScreenshots = Effect.fn("helpScreenshots")(function* () {
  const port = yield* Config.Port("WEBSITE_PORT");
  const store = yield* Config.NonEmptyString("SHOPIFY_DEV_STORE");
  const handle = appHandle();
  if (handle === undefined)
    return yield* new HelpScreenshotsError({
      message: 'shopify.app.toml has no handle = "<app handle>" line',
    });
  if (!listing && merchantShots.length === 0 && memberShots.length === 0)
    return yield* new HelpScreenshotsError({
      message: `No picture's file starts with "${String(section)}/" (--section takes a folder under ${HELP_PICTURES_PATH}).`,
    });
  yield* runCommand("node", ["--env-file=.env", "scripts/dev.ts", "status"]).pipe(
    Effect.mapError(
      (cause) =>
        new HelpScreenshotsError({
          message: "The dev server is not healthy (vp run dev:status); start it with vp run dev.",
          cause,
        }),
    ),
  );
  if (!adminSessionValid()) {
    yield* Console.log(
      `The Shopify admin session in ${storageStatePath} is stale; exporting it again from Chrome (this may ask for the Keychain)…`,
    );
    yield* exportShopifyAdminAuth({ output: storageStatePath, profile: CHROME_PROFILE });
  }
  yield* Console.log("Loading the dev fixture…");
  yield* loadFixture;
  const urls = {
    shop: `${store}.myshopify.com`,
    appURL: `https://admin.shopify.com/store/${store}/apps/${handle}/`,
    siteURL: `http://localhost:${String(port)}`,
  };
  const written = yield* Effect.gen(function* () {
    return listing ? yield* shootListing(urls) : yield* shootAll(urls);
  }).pipe(
    Effect.ensuring(
      Console.log("Loading the dev fixture again…").pipe(Effect.andThen(loadFixture), Effect.orDie),
    ),
  );
  yield* Console.log(
    [
      `Wrote ${String(written.length)} pictures:`,
      ...written.map(({ file, aspectRatio }) =>
        aspectRatio === undefined ? file : `${file}  aspectRatio "${aspectRatio}"`,
      ),
    ].join("\n  "),
  );
});

helpScreenshots().pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
