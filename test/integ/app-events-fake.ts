import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ShopifyAppEvents, ShopifyAppEventsError } from "../../src/backend/shopify-app-events.ts";
import type { UsageEvent } from "../../src/domain/billing.ts";

const make = Effect.sync(() => {
  const sent: Array<UsageEvent> = [];
  let refusing = false;
  return {
    /**
     * Every event the fake accepted since the last take, oldest first; clears them. `refuse`,
     * when given, sets whether the fake refuses every send from now on.
     */
    takeSent: (refuse: boolean | undefined) =>
      Effect.sync(() => {
        if (refuse !== undefined) refusing = refuse;
        return sent.splice(0);
      }),
    send: (event: UsageEvent) =>
      Effect.suspend(() => {
        if (refusing)
          return Effect.fail(
            new ShopifyAppEventsError({
              message: "App Events request refused: status=400: scripted",
              cause: null,
            }),
          );
        sent.push(event);
        return Effect.void;
      }),
  };
});

/**
 * The App Events API for the test Backend only: it accepts every event and records it, so a
 * test reads what the actor's flush sent (`AppEventsSent`), or refuses every one while a test has
 * said so. One instance per isolate; the actor runs in the test Backend's isolate and captures
 * the Backend's own instance.
 */
export class AppEventsFake extends Context.Service<AppEventsFake, Effect.Success<typeof make>>()(
  "test/AppEventsFake",
) {
  /** The fake, and `ShopifyAppEvents` over it. */
  static readonly layer = Layer.effectContext(
    Effect.map(make, (fake) =>
      Context.make(AppEventsFake, fake).pipe(
        Context.add(ShopifyAppEvents, ShopifyAppEvents.of({ send: fake.send })),
      ),
    ),
  );
}
