import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ShopifyAppEvents } from "../../src/backend/shopify-app-events.ts";
import type { UsageEvent } from "../../src/domain/billing.ts";

const make = Effect.sync(() => {
  const sent: Array<UsageEvent> = [];
  return {
    /** Every event the fake accepted since the last take, oldest first; clears them. */
    takeSent: Effect.sync(() => sent.splice(0)),
    send: (event: UsageEvent) =>
      Effect.sync(() => {
        sent.push(event);
      }),
  };
});

/**
 * The App Events API for the test Backend only: it accepts every event and records it, so a
 * test reads what the actor's flush sent (`AppEventsSent`). One instance per isolate; the actor
 * runs in the test Backend's isolate and captures the Backend's own instance. Refusals are the
 * unit tests', over `makeUsageRepository` with a refusing stub.
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
