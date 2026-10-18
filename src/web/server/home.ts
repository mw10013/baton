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
