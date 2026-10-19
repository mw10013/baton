import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";
import { backend, requestInfo } from "./backend.ts";
import { embeddedSessionToken } from "./shopify.ts";

/**
 * The App Home's setup facts, for its loader: never live, the guide is read on a load. The token
 * is only verified, never exchanged (`BackendApi.setupFacts`).
 */
export const setupFacts = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(Schema.Struct({ idToken: Schema.optional(Schema.NonEmptyString) })),
  )
  .handler(({ context: { sessionToken, rescueToken } }) =>
    backend().setupFacts(requestInfo(), { sessionToken }).catch(rescueToken),
  );

/**
 * The home page's **Your plan**, for its loader: the plan's included numbers, the usage and the
 * member count, or where an unsubscribed shop goes (`BackendApi.homePlan`). The plan is resolved
 * again on this request, and never named: no tier reaches the browser.
 */
export const homePlan = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(
    Schema.toStandardSchemaV1(Schema.Struct({ idToken: Schema.optional(Schema.NonEmptyString) })),
  )
  .handler(({ context: { sessionToken, rescueToken } }) =>
    backend().homePlan(requestInfo(), { sessionToken }).catch(rescueToken),
  );

/**
 * Tells the Backend the merchant is about to change their plan (`BackendApi.expectPlanChange`):
 * the plan's cache deadline pulled to minutes, then the usage queue sent. The plan selection page
 * lives on `admin.shopify.com`, outside the app's iframe, so the click is a one-way trip: the
 * return leg carries `plan_handle` and forces a revalidation, but it is a redirect that can be
 * lost, and the only other signal is the 24-hour cache. POST: it writes.
 */
export const prepareManagePlan = createServerFn({ method: "POST" })
  .middleware([embeddedSessionToken])
  .handler(({ context: { sessionToken, rescueToken } }) =>
    backend().expectPlanChange(requestInfo(), { sessionToken }).catch(rescueToken),
  );
