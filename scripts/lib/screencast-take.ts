/**
 * Recording a screencast's take: the dev store put into the take's starting shop, real Chrome
 * driving the embedded admin, and Playwright's page screencast filming it, one scene at a time,
 * each held for its narration. The dev fixture is loaded again afterwards, also on failure.
 *
 * @module
 */
import { NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type Browser, chromium, type FrameLocator, type Locator, type Page } from "playwright";

import { fixture } from "../../fixture.ts";
import { storageStatePath } from "../../playwright.config.ts";
import { SCREENCAST_ORDER } from "../../screencast-fixture.ts";
import { runCommand } from "./command.ts";
import { appFrame, awaitHydration, gotoApp, HIDE_OVERLAYS } from "./embedded-app.ts";

/** The workflow editor's `s-app-window`, a second embedded frame beside the app's own. */
const editorFrame = (page: Page): FrameLocator => page.frameLocator('iframe[src*="chrome=window"]');
import { applyFixture } from "./fixture.ts";
import {
  durationMs,
  readVoiceIndex,
  type Scene,
  ScreencastError,
  type Take,
  type TakeFiles,
  type TakeSpec,
} from "./screencast.ts";
import { cardHtml } from "./screencast-cards.ts";
import { adminSessionFresh, CHROME_PROFILE, exportShopifyAdminAuth } from "./shopify-admin-auth.ts";
import { createStoreOrder } from "./stores.ts";
import { countCharacters } from "./tts.ts";

/** The browser viewport. The page screencast records CSS pixels, so `build` scales it to 1080p. */
export const VIEWPORT = { width: 1600, height: 900 } as const;
/**
 * The viewport of a `pane` take: the admin's nav (240 px) and top bar (56 px) around a 1280 × 720
 * app pane. The take measures the pane and fails unless it is 16:9, since Shopify can move both.
 */
export const PANE_VIEWPORT = { width: 1520, height: 776 } as const;
export const FPS = 30;
/** The pause after a scene's line and action, before the next scene. */
export const GAP_MS = 600;
/** Per character typed, so typing is watchable. */
export const TYPE_DELAY_MS = 60;
/** The pause after each press or fill, so a viewer sees what changed. */
const BEAT_MS = 500;
/** How long a chapter card shows; the scene's line starts after it. */
const CHAPTER_MS = 2000;
/** How long a lookup waits for a control or a text to appear. */
const FIND_MS = 20_000;
/**
 * A rehearsal's stand-in for a line's length: Aura-2 luna speaks about 13 characters a second
 * (a 61-character sample ran 4.7 s).
 */
const REHEARSAL_MS_PER_CHARACTER = 77;

/** Where a scene started and ended in `raw.webm`, and how long its line runs. */
export const SceneMark = Schema.Struct({
  id: Schema.String,
  startMs: Schema.Number,
  voiceMs: Schema.Number,
  endMs: Schema.Number,
});
export type SceneMark = typeof SceneMark.Type;

/** The part of the recording a `pane` take keeps, in CSS px. */
export const Crop = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type Crop = typeof Crop.Type;

export const SceneIndex = Schema.Struct({
  rehearsal: Schema.Boolean,
  crop: Schema.optionalKey(Crop),
  durationMs: Schema.Number,
  scenes: Schema.Array(SceneMark),
});
export type SceneIndex = typeof SceneIndex.Type;

/** When a scene may end: after its action and its line, whichever is later, plus {@link GAP_MS}. */
export const sceneEnd = (startMs: number, actEndMs: number, voiceMs: number) =>
  Math.max(actEndMs, startMs + voiceMs) + GAP_MS;

const StorageState = Schema.fromJsonString(
  Schema.Struct({
    cookies: Schema.Array(
      Schema.Struct({ name: Schema.String, domain: Schema.String, expires: Schema.Number }),
    ),
  }),
);

const adminSessionValid = (): boolean => {
  try {
    const { cookies } = Schema.decodeUnknownSync(StorageState)(
      readFileSync(storageStatePath, "utf8"),
    );
    return adminSessionFresh(cookies, statSync(storageStatePath).mtimeMs);
  } catch {
    return false;
  }
};

/** The first visible match of each locator, in order, waiting up to {@link FIND_MS}. */
const firstVisible = async (
  what: string,
  candidates: () => ReadonlyArray<Locator>,
): Promise<Locator> => {
  const deadline = Date.now() + FIND_MS;
  while (Date.now() < deadline) {
    for (const candidate of candidates()) {
      const count = await candidate.count();
      for (let index = 0; index < count; index += 1) {
        const match = candidate.nth(index);
        if (await match.isVisible()) return match;
      }
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`not found within ${FIND_MS / 1000} s: ${what}`);
};

/**
 * The {@link Take} helpers over `page`. A control is looked up in the admin's top document (the
 * title bar's hoisted actions), then the editor window, then the app frame, where the app's own
 * `s-modal`s render. Fields are found by role and name, as Polaris labels them.
 */
const makeTake = (page: Page, store: string): Take => {
  const app = (): FrameLocator => appFrame(page);
  const scopes = () => [page, editorFrame(page), app()] as const;
  const beat = () => page.waitForTimeout(BEAT_MS);
  let placed: string | undefined;
  const press = async (name: string) => {
    const target = await firstVisible(`a button or link named ${name}`, () =>
      scopes().flatMap((scope) => [
        scope.getByRole("button", { name, exact: true }),
        scope.getByRole("link", { name, exact: true }),
        // A strip cell is named for its label and its count: "Not started, 0".
        scope.getByRole("button", {
          name: new RegExp(`^${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")},`, "u"),
        }),
      ]),
    );
    // A hoisted title-bar proxy can sit under an `aria-disabled` ancestor that never clears, and
    // Playwright then refuses the click; a native click still reaches it.
    await target.click({ timeout: 3000 }).catch(() =>
      target.evaluate((el) => {
        (el as HTMLElement).click();
      }),
    );
    await beat();
  };
  return {
    page,
    app,
    nav: async (name) => {
      await page
        .getByRole("link", { name, exact: true })
        .and(page.locator('a[href*="/apps/"]'))
        .click();
      await awaitHydration(app(), FIND_MS);
      await beat();
    },
    press,
    fill: async (label, text) => {
      const field = await firstVisible(`a field labelled ${label}`, () =>
        scopes().map((scope) => scope.getByRole("textbox", { name: label, exact: true })),
      );
      await field.click();
      await field.pressSequentially(text, { delay: TYPE_DELAY_MS });
      await beat();
    },
    choose: async (label, option) => {
      const field = await firstVisible(`a select labelled ${label}`, () =>
        scopes().map((scope) => scope.getByRole("combobox", { name: label, exact: true })),
      );
      await field.selectOption({ label: option });
      await beat();
    },
    tick: async (label) => {
      const box = await firstVisible(`a checkbox labelled ${label}`, () =>
        scopes().map((scope) => scope.getByRole("checkbox", { name: label, exact: true })),
      );
      await box.check();
      await beat();
    },
    point: async (text) => {
      const target = await firstVisible(`the text ${text}`, () =>
        [page, editorFrame(page), app()].map((scope) => scope.getByText(text)),
      );
      await target.hover();
      await beat();
    },
    see: async (text) => {
      await firstVisible(`the text ${text}`, () =>
        [page, editorFrame(page), app()].map((scope) => scope.getByText(text)),
      );
    },
    placeOrder: async () => {
      const order = await Effect.runPromise(
        createStoreOrder(store, SCREENCAST_ORDER).pipe(Effect.provide(NodeServices.layer)),
      );
      placed = order.name;
      return order.name;
    },
    closeWindow: async () => {
      // The X in the header the admin draws around an `s-app-window`, scoped to the element that
      // holds the window's iframe: the Dev Console and Sidekick answer to "Close" too.
      await page
        .locator('iframe[src*="chrome=window"]')
        .locator("xpath=ancestor::*[.//button][1]")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page
        .locator('iframe[src*="chrome=window"]')
        .waitFor({ state: "detached", timeout: FIND_MS });
      await awaitHydration(app(), FIND_MS);
      await beat();
    },
    placedOrder: () => {
      if (placed === undefined) throw new Error("placedOrder before placeOrder");
      return placed;
    },
    openOrder: async () => {
      if (placed === undefined) throw new Error("openOrder before placeOrder");
      await press(placed);
    },
  };
};

/**
 * The app pane: right of the admin nav, below the admin's top bar, to the viewport's edges. It
 * holds the app's title bar and its frame.
 */
const measurePane = async (page: Page): Promise<Crop> => {
  const pane = await page.evaluate(() => {
    const nav = document.querySelector("nav")?.getBoundingClientRect();
    const main = document.querySelector("main")?.getBoundingClientRect();
    if (nav === undefined || main === undefined) return undefined;
    const x = Math.round(nav.right);
    const y = Math.round(main.top);
    return { x, y, width: window.innerWidth - x, height: window.innerHeight - y };
  });
  if (pane === undefined) throw new Error("the admin has no nav or main to crop to");
  if (Math.abs(pane.width * 9 - pane.height * 16) > 16)
    throw new Error(
      `the app pane is ${pane.width} × ${pane.height}, not 16:9: the admin's nav or top bar moved`,
    );
  return pane;
};

/**
 * The crop inside the pane: in by 16 px from each side and 9 px from the top and bottom, still
 * 16:9, which clears the admin's rounded corners, drawn dark against its top bar.
 */
export const paneCrop = (pane: Crop): Crop => ({
  x: pane.x + 16,
  y: pane.y + 9,
  width: pane.width - 32,
  height: pane.height - 18,
});

/** The id of the element a card is drawn in, on the admin's top document. */
const CARD_ID = "screencast-card";

/** Draws `html` over `area` of the admin's top document, above everything the admin draws. */
const drawCard = (page: Page, html: string, area: Crop) =>
  page.evaluate(
    ({ id, html, area }) => {
      const card = document.createElement("div");
      card.id = id;
      card.style.cssText = `position:fixed;left:${area.x}px;top:${area.y}px;width:${area.width}px;height:${area.height}px;z-index:2147483647`;
      card.innerHTML = html;
      document.body.appendChild(card);
    },
    { id: CARD_ID, html, area },
  );

const removeCard = (page: Page) =>
  page.evaluate((id) => document.getElementById(id)?.remove(), CARD_ID);

/**
 * Films `scenes` in one take into the take's raw video, and answers each scene's marks and, for a
 * `pane` take, the crop. With `rehearse` a line's length is estimated from its characters, so a
 * take can be checked before any narration is paid for. A failed scene leaves a screenshot beside
 * the video.
 */
const film = async (options: {
  readonly browser: Browser;
  readonly appURL: string;
  readonly store: string;
  readonly scenes: ReadonlyArray<Scene>;
  readonly files: TakeFiles;
  readonly frame: TakeSpec["frame"];
  readonly voiceMs: (scene: Scene) => number;
  readonly log: (line: string) => void;
}): Promise<{ readonly marks: ReadonlyArray<SceneMark>; readonly crop: Crop | undefined }> => {
  const viewport = options.frame === "pane" ? PANE_VIEWPORT : VIEWPORT;
  const context = await options.browser.newContext({
    storageState: storageStatePath,
    viewport,
    baseURL: options.appURL,
  });
  const page = await context.newPage();
  // The admin is one document for the whole take, but a reload would drop the style.
  page.on("load", () => {
    void page.addStyleTag({ content: HIDE_OVERLAYS }).catch(() => null);
  });
  await gotoApp(page, "app");
  await page.addStyleTag({ content: HIDE_OVERLAYS });
  const pane = options.frame === "pane" ? await measurePane(page) : undefined;
  const crop = pane === undefined ? undefined : paneCrop(pane);
  const cardArea = pane ?? { x: 0, y: 0, ...viewport };
  const take = makeTake(page, options.store);
  let first: number | undefined;
  await page.screencast.start({
    path: options.files.raw,
    size: viewport,
    fps: FPS,
    onFrame: ({ timestamp }) => {
      first ??= timestamp;
    },
  });
  const marks: SceneMark[] = [];
  let current = "";
  try {
    await page.screencast.showActions({
      cursor: "pointer",
      duration: 900,
      style: {
        title: "display: none",
        highlight:
          "outline: 2px solid #2c6ecb; border-radius: 8px; background: rgba(44, 110, 203, 0.08)",
      },
    });
    await page.locator("body").hover({
      position: { x: cardArea.x + cardArea.width / 2, y: cardArea.y + cardArea.height / 2 },
    });
    await page.waitForTimeout(800);
    const clock = () => Date.now() - (first ?? Date.now());
    for (const scene of options.scenes) {
      current = scene.id;
      if (scene.chapter !== undefined) {
        await page.screencast.showChapter(scene.chapter.title, {
          ...(scene.chapter.description === undefined
            ? {}
            : { description: scene.chapter.description }),
          duration: CHAPTER_MS,
        });
        await page.waitForTimeout(CHAPTER_MS + 200);
      }
      if (scene.card !== undefined) {
        // Park the cursor in the admin nav, outside a pane take's crop, so it doesn't sit on the card.
        await page.mouse.move(cardArea.x / 2, viewport.height - 20);
        await drawCard(page, cardHtml(scene.card, cardArea), cardArea);
      }
      const startMs = clock();
      const voiceMs = options.voiceMs(scene);
      await scene.act(take);
      const endMs = sceneEnd(startMs, clock(), voiceMs);
      await page.waitForTimeout(Math.max(0, endMs - clock()));
      if (scene.card !== undefined) await removeCard(page);
      marks.push({ id: scene.id, startMs, voiceMs, endMs });
      options.log(
        `scene  ${scene.id}: ${(startMs / 1000).toFixed(1)}–${(endMs / 1000).toFixed(1)} s`,
      );
    }
    await page.waitForTimeout(1000);
    return { marks, crop };
  } catch (error) {
    await page
      .screenshot({ path: resolve(dirname(options.files.raw), `failed-${current}.png`) })
      .catch(() => null);
    throw new Error(
      `scene ${current} failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  } finally {
    await page.screencast.stop().catch(() => null);
    await context.close();
  }
};

/**
 * `vp run screencast record`: gates (dev server healthy, admin session fresh, a current clip for
 * every scene unless rehearsing), then the take between its starting shop and the dev fixture.
 */
export const recordTake = Effect.fn("recordTake")(function* (
  spec: TakeSpec,
  options: { readonly rehearse: boolean; readonly headed: boolean },
) {
  const { scenes, files } = spec;
  const store = yield* Config.NonEmptyString("SHOPIFY_DEV_STORE");
  const handle = yield* Config.NonEmptyString("SHOPIFY_APP_HANDLE");
  yield* runCommand("node", ["--env-file=.env", "scripts/dev.ts", "status"]).pipe(
    Effect.mapError(
      () =>
        new ScreencastError({
          message: "the dev server is not healthy (vp run dev:status); start it with vp run dev",
        }),
    ),
  );
  if (!adminSessionValid()) {
    yield* Console.log(
      `The Shopify admin session in ${storageStatePath} is stale; exporting it again from Chrome (this may ask for the Keychain)…`,
    );
    yield* exportShopifyAdminAuth({ output: storageStatePath, profile: CHROME_PROFILE });
  }
  const voiceMs: (scene: Scene) => number = options.rehearse
    ? (scene) => countCharacters(scene.say) * REHEARSAL_MS_PER_CHARACTER
    : yield* readVoiceIndex(scenes, files).pipe(
        Effect.map(
          (clips) => (scene: Scene) => clips.find(({ id }) => id === scene.id)?.durationMs ?? 0,
        ),
      );

  yield* Console.log(`Putting the dev store into the ${spec.name} take's starting shop…`);
  yield* applyFixture({ fixture: spec.start, waitForInstall: false });
  const { marks, crop } = yield* Effect.acquireUseRelease(
    Effect.promise(() => chromium.launch({ channel: "chrome", headless: !options.headed })),
    (browser) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(files.raw), { recursive: true });
          return film({
            browser,
            appURL: `https://admin.shopify.com/store/${store}/apps/${handle}/`,
            store,
            scenes,
            files,
            frame: spec.frame,
            voiceMs,
            log: (line) => console.log(line),
          });
        },
        catch: (error) =>
          new ScreencastError({ message: error instanceof Error ? error.message : String(error) }),
      }),
    (browser) => Effect.promise(() => browser.close()),
  ).pipe(
    Effect.ensuring(
      Console.log("Loading the dev fixture again…").pipe(
        Effect.andThen(applyFixture({ fixture, waitForInstall: false })),
        Effect.orDie,
      ),
    ),
  );
  const index: SceneIndex = {
    rehearsal: options.rehearse,
    ...(crop === undefined ? {} : { crop }),
    durationMs: yield* durationMs(files.raw),
    scenes: marks,
  };
  yield* Effect.promise(() => writeFile(files.sceneIndex, `${JSON.stringify(index, null, 2)}\n`));
  yield* Console.log(
    `record ok: ${marks.length} scenes, ${(index.durationMs / 1000).toFixed(1)} s${options.rehearse ? " (rehearsal, estimated lines)" : ""}, ${files.raw}`,
  );
  return index;
});
