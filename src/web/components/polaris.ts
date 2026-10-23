/**
 * The Polaris web components bundle every page loads, and the only place its URL is written.
 *
 * Pinned to the 2.0 line, with `@shopify/polaris-types` pinned to the matching `2.0.*` exactly:
 * Shopify publishes each minor line at its own URL, so moving to another one changes this
 * constant and the types package together. Outside
 * the embedded App Home no App Bridge loads beside it, so Polaris renders its standalone "Admin
 * Next" look, light only. The `polaris` ref snapshots the bundle from this same URL.
 *
 * @see https://shopify.dev/docs/api/app-home/v2.0/web-components
 */
export const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris-2.0.js";

/** Shopify's CDN, which both bundles load from; the App Home preconnects to it. */
export const CDN_URL = "https://cdn.shopify.com";

/**
 * App Bridge, which the embedded App Home loads as its document's first script, as the Shopify admin
 * requires. Unversioned: Shopify serves the current App Bridge at this one URL.
 *
 * @see https://shopify.dev/docs/api/app-home/latest/app-bridge-web-components
 */
export const APP_BRIDGE_URL = "https://cdn.shopify.com/shopifycloud/app-bridge.js";
