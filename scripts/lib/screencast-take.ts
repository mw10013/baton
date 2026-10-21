/**
 * Recording the review screencast's take: the dev store put into `screencastFixture`, real Chrome
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
import { resolve } from "node:path";
import { type Browser, chromium, type FrameLocator, type Locator, type Page } from "playwright";

import { fixture } from "../../fixture.ts";
import { storageStatePath } from "../../playwright.config.ts";
import { SCREENCAST_ORDER, screencastFixture } from "../../screencast-fixture.ts";
import { runCommand } from "./command.ts";
import { appFrame, awaitHydration, gotoApp, HIDE_OVERLAYS } from "./embedded-app.ts";

/** The workflow editor's `s-app-window`, a second embedded frame beside the app's own. */
const editorFrame = (page: Page): FrameLocator => page.frameLocator('iframe[src*="chrome=window"]');
import { applyFixture } from "./fixture.ts";
import {
  durationMs,
  readVoiceIndex,
  type Scene,
  SCREENCAST_DIR,
  ScreencastError,
  type Take,
} from "./screencast.ts";
import { adminSessionFresh, CHROME_PROFILE, exportShopifyAdminAuth } from "./shopify-admin-auth.ts";
import { createStoreOrder } from "./stores.ts";
import { countCharacters } from "./tts.ts";

/** The browser viewport. The page screencast records CSS pixels, so `build` scales it to 1080p. */
export const VIEWPORT = { width: 1600, height: 900 } as const;
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

export const RAW_VIDEO = resolve(SCREENCAST_DIR, "raw.webm");
export const SCENE_INDEX = resolve(SCREENCAST_DIR, "scenes.json");

/** Where a scene started and ended in `raw.webm`, and how long its line runs. */
export const SceneMark = Schema.Struct({
  id: Schema.String,
  startMs: Schema.Number,
  voiceMs: Schema.Number,
  endMs: Schema.Number,
});
export type SceneMark = typeof SceneMark.Type;

export const SceneIndex = Schema.Struct({
  rehearsal: Schema.Boolean,
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
 * Films `scenes` in one take into {@link RAW_VIDEO} and writes {@link SCENE_INDEX}. With
 * `rehearse` a line's length is estimated from its characters, so a take can be checked before
 * any narration is paid for. A failed scene leaves a screenshot beside the video.
 */
const film = async (options: {
  readonly browser: Browser;
  readonly appURL: string;
  readonly store: string;
  readonly scenes: ReadonlyArray<Scene>;
  readonly voiceMs: (scene: Scene) => number;
  readonly log: (line: string) => void;
}): Promise<ReadonlyArray<SceneMark>> => {
  const context = await options.browser.newContext({
    storageState: storageStatePath,
    viewport: VIEWPORT,
    baseURL: options.appURL,
  });
  const page = await context.newPage();
  // The admin is one document for the whole take, but a reload would drop the style.
  page.on("load", () => {
    void page.addStyleTag({ content: HIDE_OVERLAYS }).catch(() => null);
  });
  await gotoApp(page, "app");
  await page.addStyleTag({ content: HIDE_OVERLAYS });
  const take = makeTake(page, options.store);
  let first: number | undefined;
  await page.screencast.start({
    path: RAW_VIDEO,
    size: VIEWPORT,
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
    await page
      .locator("body")
      .hover({ position: { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 } });
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
      const startMs = clock();
      const voiceMs = options.voiceMs(scene);
      await scene.act(take);
      const endMs = sceneEnd(startMs, clock(), voiceMs);
      await page.waitForTimeout(Math.max(0, endMs - clock()));
      marks.push({ id: scene.id, startMs, voiceMs, endMs });
      options.log(
        `scene  ${scene.id}: ${(startMs / 1000).toFixed(1)}–${(endMs / 1000).toFixed(1)} s`,
      );
    }
    await page.waitForTimeout(1000);
    return marks;
  } catch (error) {
    await page
      .screenshot({ path: resolve(SCREENCAST_DIR, `failed-${current}.png`) })
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
 * every scene unless rehearsing), then the take between the screencast fixture and the dev
 * fixture.
 */
export const recordTake = Effect.fn("recordTake")(function* (
  scenes: ReadonlyArray<Scene>,
  options: { readonly rehearse: boolean; readonly headed: boolean },
) {
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
    : yield* readVoiceIndex(scenes).pipe(
        Effect.map(
          (clips) => (scene: Scene) => clips.find(({ id }) => id === scene.id)?.durationMs ?? 0,
        ),
      );

  yield* Console.log("Putting the dev store into the screencast's starting state…");
  yield* applyFixture({ fixture: screencastFixture, waitForInstall: false });
  const marks = yield* Effect.acquireUseRelease(
    Effect.promise(() => chromium.launch({ channel: "chrome", headless: !options.headed })),
    (browser) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(SCREENCAST_DIR, { recursive: true });
          return film({
            browser,
            appURL: `https://admin.shopify.com/store/${store}/apps/${handle}/`,
            store,
            scenes,
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
    durationMs: yield* durationMs(RAW_VIDEO),
    scenes: marks,
  };
  yield* Effect.promise(() => writeFile(SCENE_INDEX, `${JSON.stringify(index, null, 2)}\n`));
  yield* Console.log(
    `record ok: ${marks.length} scenes, ${(index.durationMs / 1000).toFixed(1)} s${options.rehearse ? " (rehearsal, estimated lines)" : ""}, ${RAW_VIDEO}`,
  );
  return index;
});
