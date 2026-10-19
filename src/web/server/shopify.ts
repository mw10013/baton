import { redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest, getRequestHeader } from "@tanstack/react-start/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { InvalidSessionToken } from "../../contract/shop.ts";
import { backend, requestInfo, rescue } from "./backend.ts";
import { env } from "./env.server.ts";
import { sessionTokenBounce } from "./shopify-urls.ts";

/** `Authorization: Bearer <token>`, the header App Bridge adds to the embedded page's fetches. */
const Bearer = Schema.TemplateLiteralParser(["Bearer ", Schema.String]);
const decodeBearer = Schema.decodeUnknownOption(Bearer);
const decodeToken = Schema.decodeUnknownOption(Schema.NonEmptyString);

/** A server function's data carrying the document's `id_token`, as `authenticateApp` takes it. */
const IdTokenData = Schema.Struct({ idToken: Schema.NonEmptyString });
const decodeIdTokenData = Schema.decodeUnknownOption(IdTokenData);

/** A server function's data saying the page is Shopify's billing redirect, as `authenticateApp` takes it. */
const BillingRedirectData = Schema.Struct({ billingRedirect: Schema.Literal(true) });
const decodeBillingRedirectData = Schema.decodeUnknownOption(BillingRedirectData);

/** The header App Bridge answers by retrying the request with a fresh session token. */
const RETRY_INVALID_SESSION_HEADER = "X-Shopify-Retry-Invalid-Session-Request";

/** A browser's server-function call, which TanStack Start's client marks; never authentication. */
const isServerFnCall = () => getRequestHeader("x-tsr-serverFn") === "true";

/**
 * What an embedded request gets when its session token is missing or refused: with a bearer,
 * `401` and {@link RETRY_INVALID_SESSION_HEADER}, so App Bridge retries with a fresh token; a
 * browser's server-function call without one, a bare `401` (Baton's guard: there is no document
 * to bounce); a document, the session-token bounce, which reloads the page with a new
 * `id_token`.
 */
const refuse = (bearer: boolean): never => {
  if (bearer)
    throw new Response(null, { status: 401, headers: { [RETRY_INVALID_SESSION_HEADER]: "1" } });
  if (isServerFnCall()) throw new Response(null, { status: 401 });
  const url = new URL(getRequest().url);
  throw redirect({ href: sessionTokenBounce(env.SHOPIFY_APP_URL, url.pathname, url.search) });
};

/**
 * The embedded page's session token, before anything checks it: the bearer App Bridge adds to
 * every same-origin `fetch` from the embedded page, else the `idToken` in the function's data,
 * which is how the document's `id_token` arrives when a guard or loader calls the function
 * in-process during SSR. No token is a refusal ({@link refuse}). `rescueToken` is the handler's
 * catch for a Backend call that answers `InvalidSessionToken`: the same refusal, for the way
 * the token came. A function in context, not an export, so no client bundle reaches
 * {@link refuse}'s server-only imports.
 */
export const embeddedSessionToken = createMiddleware({ type: "function" }).server(
  async ({ next, data }) => {
    const bearer = Option.flatMap(decodeBearer(getRequestHeader("authorization")), ([, token]) =>
      decodeToken(token),
    );
    const sessionToken = Option.orElse(bearer, () =>
      Option.map(decodeIdTokenData(data), ({ idToken }) => idToken),
    );
    if (Option.isNone(sessionToken)) return refuse(Option.isSome(bearer));
    const rescueToken: (error: unknown) => never = rescue(InvalidSessionToken, () =>
      refuse(Option.isSome(bearer)),
    );
    return next({ context: { sessionToken: sessionToken.value, rescueToken } });
  },
);

/**
 * Baton's `ShopifyServerFnMiddleware`: authenticates the embedded admin before a server function
 * runs and puts its shop and plan answer in context (`AdminAuthenticated`: `Subscribed` with the
 * shop and the Manage plan URL, or `Unsubscribed` with where to go). The token comes from
 * {@link embeddedSessionToken}; the Backend verifies and exchanges it, and a refusal is
 * {@link refuse}. `billingRedirect` in the data re-reads the plan at once.
 */
export const shopifyAdmin = createMiddleware({ type: "function" })
  .middleware([embeddedSessionToken])
  .server(async ({ next, context, data }) => {
    const admin = await backend()
      .authenticateAdmin(requestInfo(), {
        sessionToken: context.sessionToken,
        billingRedirect: Option.isSome(decodeBillingRedirectData(data)),
      })
      .catch(context.rescueToken);
    return next({ context: { admin } });
  });

/**
 * `authenticateApp`'s input: the document's `id_token`, absent on a call App Bridge made, and
 * `billingRedirect` when the page is Shopify's billing redirect (its search carries
 * `plan_handle`). Neither names a plan.
 */
const AuthenticateAppInput = Schema.Struct({
  idToken: Schema.optional(Schema.NonEmptyString),
  billingRedirect: Schema.optional(Schema.Boolean),
});

/**
 * The App Home's authenticated admin: its shop, the API key for App Bridge's meta tag and the
 * Manage plan URL; or, for a shop with no app subscription, where `/app` redirects.
 */
export const authenticateApp = createServerFn({ method: "GET" })
  .middleware([shopifyAdmin])
  .validator(Schema.toStandardSchemaV1(AuthenticateAppInput))
  .handler(({ context: { admin } }) =>
    admin._tag === "Unsubscribed"
      ? { _tag: "Unsubscribed" as const, href: admin.href }
      : {
          _tag: "Subscribed" as const,
          shop: admin.shop,
          apiKey: env.SHOPIFY_API_KEY,
          managePlanUrl: admin.managePlanUrl,
        },
  );

/**
 * The app's API key and public URL, from the Website's bindings, for the App Home's guards that
 * run before any token is checked.
 *
 * POST, though it reads nothing: it has no input, so as a GET every call has the same URL, and
 * Chrome holds a GET while another for the same URL is in flight in the browser context,
 * unsent, for up to 20 s. The `/app` guards call it on every client load and navigation, so a
 * frame could sit unhydrated behind one. Chrome never holds a POST.
 */
export const getShopifyApp = createServerFn({ method: "POST" }).handler(() => ({
  apiKey: env.SHOPIFY_API_KEY,
  appUrl: env.SHOPIFY_APP_URL,
}));
