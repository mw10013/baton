import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../../src/contract/shop.ts";
import {
  type AppSubscription,
  PlanHandle,
  provisionalCycleStart,
} from "../../src/domain/billing.ts";
import {
  planSelectionExitIframeHref,
  ShopifyPartner,
  ShopifyPartnerError,
} from "../../src/backend/shopify-partner.ts";

/** The pricing page's URL the fake names, for a test to compare against. */
export const fakePlanSelectionUrl = (shop: ShopKey) =>
  `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/u, "")}/charges/baton-test/pricing_plans`;

/** Where the gate sends an unsubscribed shop under the fake. */
export const fakePlanSelectionHref = (shop: ShopKey) =>
  planSelectionExitIframeHref(fakePlanSelectionUrl(shop), shop);

/**
 * One scripted Partner answer for a shop: an app subscription on `handle` (in a billing cycle,
 * or in a trial when `cycleStartAt` is null), none, or a failure to answer.
 */
export const PartnerAnswer = Schema.Union([
  Schema.TaggedStruct("Subscribed", {
    handle: PlanHandle,
    cycleStartAt: Schema.NullOr(Schema.Number),
    boundaryAt: Schema.NullOr(Schema.Number),
  }),
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Failure", { message: Schema.String }),
]);
export type PartnerAnswer = typeof PartnerAnswer.Type;

/** The month around `now`, UTC: the fake's default billing cycle. */
const currentMonth = (now: number) => {
  const start = provisionalCycleStart(now);
  const date = new Date(start);
  return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
};

const make = Effect.sync(() => {
  const answers = new Map<string, PartnerAnswer>();
  const asked: Array<string> = [];

  const activeSubscription = (shopGid: string) =>
    Effect.suspend(() => {
      asked.push(shopGid);
      const { start, end } = currentMonth(Date.now());
      const answer = answers.get(shopGid) ?? {
        _tag: "Subscribed" as const,
        handle: "baton-pro" as const,
        cycleStartAt: start,
        boundaryAt: end,
      };
      return Match.value(answer).pipe(
        Match.tagsExhaustive({
          Subscribed: ({ handle, cycleStartAt, boundaryAt }) =>
            Effect.succeed(Option.some<AppSubscription>({ handle, cycleStartAt, boundaryAt })),
          None: () => Effect.succeed(Option.none<AppSubscription>()),
          Failure: ({ message }) => Effect.fail(new ShopifyPartnerError({ message, cause: null })),
        }),
      );
    });

  return {
    /** Sets `shopGid`'s answer until the next script for it. */
    script: (shopGid: string, answer: PartnerAnswer) =>
      Effect.sync(() => {
        answers.set(shopGid, answer);
      }),
    /** Every shop GID asked about since the last take, oldest first; clears them. */
    takeAsked: Effect.sync(() => asked.splice(0)),
    service: ShopifyPartner.of({ activeSubscription, planSelectionUrl: fakePlanSelectionUrl }),
  };
});

/**
 * The Partner API for the test Backend only. Unscripted, every shop holds `baton-pro` in the
 * current UTC month's billing cycle, so a test that does not exercise the plan passes every gate.
 * `ScriptPartner` sets one shop's answer. One instance per isolate, as `ShopifyFake`.
 */
export class PartnerFake extends Context.Service<PartnerFake, Effect.Success<typeof make>>()(
  "test/PartnerFake",
) {
  /** The fake, and `ShopifyPartner` over it. */
  static readonly layer = Layer.effectContext(
    Effect.map(make, (fake) =>
      Context.make(PartnerFake, fake).pipe(Context.add(ShopifyPartner, fake.service)),
    ),
  );
}
