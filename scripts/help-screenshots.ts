#!/usr/bin/env node
/**
 * `pnpm help:screenshots`: retakes the help's pictures against the showcase
 * shop on this checkout's dev server, the spec in `HELP_PICTURES`
 * (`src/lib/helpPictures.ts`) for what each one shows. In order: refuses to
 * start unless the dev server is healthy; readies the store and seeds the
 * showcase; signs in as the showcase's member `ana@example.com` on a
 * 390 × 844 phone at 2x, headless, light theme; shoots every member picture;
 * puts the store back on the development fixture, also when a shot failed;
 * prints what it wrote.
 *
 * Playwright's library API, not `playwright-cli`: the shots are a program a
 * rerun repeats, not a session someone drives. The items are found by their
 * order number, which the showcase fixture gives each order by its place
 * (`orders` in `e2e/showcaseFixture.ts`), so a picture follows its item if the
 * fixture's order changes. One shot writes a Done (Recording your work's third
 * picture); the reseed at the end takes it back.
 *
 * A rerun shoots the same frames but not the same bytes: the seed stamps the
 * clock, so every item page shows the time it ran ("Oct 7, 6:58 PM"). Rerun
 * when a screen changes, not to refresh.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { chromium, type Locator, type Page } from "@playwright/test";
import { Console, Data, Effect } from "effect";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { orders } from "../e2e/showcaseFixture.ts";
import {
  HELP_PICTURES,
  HELP_PICTURES_PATH,
  MEMBER_SCREEN,
  type HelpPictureName,
} from "../src/lib/helpPictures.ts";
import { runCommand } from "./lib/command.ts";

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

const awaitHydration = (page: Page) =>
  page.locator('body[data-hydrated="true"]').waitFor({ state: "attached" });

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

/** Each picture's state, as a function of a signed-in page. Run in this order. */
const SHOTS: readonly {
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

const shootAll = (shop: string, baseURL: string) =>
  Effect.acquireUseRelease(
    attempt("Could not launch Chrome", () =>
      chromium.launch({ channel: "chrome", headless: true }),
    ),
    (browser) =>
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
          await page
            .getByRole("link", { name: "Open your magic link" })
            .click();
          await page.waitForURL(/\/shop\//u);
          await awaitHydration(page);
        });
        const written: string[] = [];
        for (const shot of SHOTS) {
          const file = path.join(
            "public",
            HELP_PICTURES_PATH,
            HELP_PICTURES[shot.name].file,
          );
          yield* attempt(`Could not shoot ${shot.name}`, async () => {
            await shot.take(page, shop);
            await settle(page);
            await mkdir(path.dirname(file), { recursive: true });
            await page.screenshot({ path: file, animations: "disabled" });
          });
          written.push(file);
        }
        return written;
      }),
    (browser) => Effect.promise(() => browser.close()),
  );

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
      [`Wrote ${String(written.length)} pictures:`, ...written].join("\n  "),
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
