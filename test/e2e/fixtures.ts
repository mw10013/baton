import { test as base, expect } from "playwright/test";
import type { Browser, Page, WebSocket } from "playwright/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import { DevRpcs } from "../../src/contract/dev.ts";
import { e2eServerURL } from "../../playwright.config.ts";
import { E2E_SHOP, E2eEmail } from "./shop-fixture.ts";
import { signInWithForm } from "./screens.ts";

export type Run = <A, E>(effect: Effect.Effect<A, E, RpcClient.Protocol>) => Promise<A>;

/** The dev client, through the Website's forwarder, as `vp run fixture` reaches the Backend. */
const protocol = (baseURL: string) =>
  RpcClient.layerProtocolHttp({ url: `${baseURL}/api/dev` }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(FetchHttpClient.layer),
  );

/**
 * Waits for the marker `RootDocument` sets once React has attached its handlers. Needed after
 * every full page load before an interaction; {@link test}'s `goto` does it for navigations.
 */
export const awaitHydration = async (page: Page) => {
  await page.locator("body[data-hydrated]").waitFor();
};

/**
 * `backend` runs an Effect against the dev procedures ({@link DevRpcs}) and resolves with its
 * value or rejects with the pretty cause; it is the only place the specs touch Effect. It always
 * talks to {@link e2eServerURL}, never the project's `baseURL`, which in the `embedded` project
 * is the Shopify admin.
 */
export const test = base.extend<{ goto: (path: string) => Promise<void> }, { backend: Run }>({
  backend: [
    // Playwright reads a fixture's dependencies from this pattern, so it must be `{}`, not `_`.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const runtime = ManagedRuntime.make(protocol(e2eServerURL));
      const run: Run = (effect) =>
        runtime.runPromiseExit(effect).then((exit) => {
          if (exit._tag === "Success") return exit.value;
          throw new Error(Cause.pretty(exit.cause));
        });
      await use(run);
      await runtime.dispose();
    },
    { scope: "worker" },
  ],
  /** Navigates and waits for hydration; a click before the marker is lost. */
  goto: async ({ page }, use) => {
    await use(async (path) => {
      await page.goto(path);
      await awaitHydration(page);
    });
  },
});
export { expect };

/** One call against {@link DevRpcs}. */
export const dev = <A, E>(
  f: (
    client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof DevRpcs>, RpcClientError.RpcClientError>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* f(yield* RpcClient.make(DevRpcs));
  }).pipe(Effect.scoped);

/**
 * An `@e2e.test` address of the running test's own, `<name>-<test id>-<retry>`: no other test
 * shares it, and a retry does not reuse the address its failed attempt may have added.
 */
export const testEmail = (name: string): E2eEmail => {
  const { testId, retry } = test.info();
  return Schema.decodeUnknownSync(E2eEmail)(`${name}-${testId}-${retry}@e2e.test`);
};

/** The test's own tail for names and tags: its id and its retry, so a retry adds afresh. */
export const own = () => {
  const { testId, retry } = test.info();
  return `${testId.slice(-8)}${String(retry)}`;
};

/**
 * A member of its own: a {@link testEmail} address added to {@link E2E_SHOP} with `AddToFixture`
 * and signed in through the sign-in form, in a fresh browser context. A test that signs out, is
 * removed or opens several windows uses one, so it never touches the shared member's session or
 * sockets. A `FixtureConflict` fails the test: the address is the test's own, so a clash is a bug.
 */
export const ownMember = async (browser: Browser, backend: Run, name: string) => {
  const email = testEmail(name);
  await backend(
    dev((c) =>
      c.AddToFixture({
        shop: E2E_SHOP,
        fixture: { members: [email], teams: [], workflows: [], orders: [] },
      }),
    ),
  );
  return { email, ...(await signInMember(browser, email)) };
};

/**
 * Signs `email` in through the sign-in form in a fresh browser context and waits for the landing:
 * a member of the e2e store alone lands on its workflows list.
 */
export const signInMember = async (browser: Browser, email: E2eEmail) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await signInWithForm(page, email);
  await page.waitForURL(/\/shop\/[^/]+\/workflows$/u);
  return { context, page };
};

/**
 * Resolves once the next actor socket the page opens has answered a call successfully. The
 * page refetches what it shows (the workflows list) on every connect, and the actor names a
 * socket when it accepts it, so that answer means the actor holds the socket (revocable,
 * displaceable, counted). Start it
 * before the navigation or click that opens the socket, and await it after.
 */
export const nextOpenSocket = (page: Page) =>
  new Promise<void>((resolve) => {
    const onSocket = (socket: WebSocket) => {
      if (!new URL(socket.url()).pathname.startsWith("/api/actor/")) return;
      page.off("websocket", onSocket);
      const onFrame = ({ payload }: { payload: string | Buffer }) => {
        if (typeof payload !== "string" || !payload.includes('"_tag":"Success"')) return;
        socket.off("framereceived", onFrame);
        resolve();
      };
      socket.on("framereceived", onFrame);
    };
    page.on("websocket", onSocket);
  });
