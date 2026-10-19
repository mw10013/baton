/**
 * The billing answers that cross the Backend binding: the `/app` gate's, the home page's
 * **Your plan**, the orders index's usage and Manage plan. None carries the shop's plan or
 * handle: the browser never names its own tier.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { ShopUsage } from "../domain/billing.ts";
import { AdminSession } from "./shop.ts";

const sessionToken = Schema.NonEmptyString;

/**
 * The shop holds no app subscription on a plan Baton knows: a verified absence, never a failure
 * to ask. `href` is the plan selection page through `/auth/exit-iframe`, where the browser goes.
 */
export class PlanUnsubscribed extends Schema.TaggedError<PlanUnsubscribed>()("PlanUnsubscribed", {
  href: Schema.String,
}) {}

/**
 * The shop the caller may open has no app subscription: the gate's 402, as `BackendApi.shopAccess`
 * and the member loaders answer it. The member layout sends the member to Subscription
 * inactive; the merchant layout never meets it, because `/app`'s guard redirects first.
 */
export class PaymentRequired extends Schema.TaggedError<PaymentRequired>()("PaymentRequired", {}) {}

/**
 * `authenticateAdmin`'s answer: the admin's shop and its Manage plan URL (the pricing page), or
 * where an unsubscribed shop goes. A plan that could not be read fails the call instead.
 */
export const AdminAuthenticated = Schema.Union([
  Schema.TaggedStruct("Subscribed", { ...AdminSession.fields, managePlanUrl: Schema.String }),
  Schema.TaggedStruct("Unsubscribed", { href: Schema.String }),
]);
export type AdminAuthenticated = typeof AdminAuthenticated.Type;

/** `BackendApi.homePlan`'s, `BackendApi.usage`'s and `BackendApi.expectPlanChange`'s input: the session token alone. */
export const PlanRequest = Schema.Struct({ sessionToken });
export type PlanRequest = typeof PlanRequest.Type;

/** What a plan includes, as the home page's meters read it: `Entitlements` in Billing. */
export const EntitlementsData = Schema.Struct({
  ordersPerCycle: Schema.Number,
  membersIncluded: Schema.Number,
});

/**
 * The home page's **Your plan**, its first render: the plan's included numbers (compared on the
 * screen, never named), the actor's usage and the D1 member count; or where an unsubscribed shop
 * goes, when the plan lapsed between the `/app` gate and this read.
 */
export const HomePlan = Schema.Union([
  Schema.TaggedStruct("Subscribed", {
    entitlements: EntitlementsData,
    usage: ShopUsage,
    memberCount: Schema.Number,
  }),
  Schema.TaggedStruct("Unsubscribed", { href: Schema.String }),
]);
export type HomePlan = typeof HomePlan.Type;
