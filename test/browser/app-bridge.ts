import type { ShopifyGlobal } from "@shopify/app-bridge-types";

/**
 * Defines App Bridge's `shopify` global, which the embedded document supplies and a test page
 * does not. Only the calls Baton's wrappers make exist, so the stub is cast to the full
 * {@link ShopifyGlobal}.
 */
export const installAppBridge = (
  stub: {
    readonly toast?: (message: string, options?: { readonly isError?: boolean }) => void;
    readonly hide?: (id: string) => void;
  } = {},
) => {
  globalThis.shopify = {
    idToken: () => Promise.resolve("token"),
    modal: {
      hide: (id: string) => {
        stub.hide?.(id);
        return Promise.resolve();
      },
    },
    toast: {
      show: (message: string, options?: { readonly isError?: boolean }) => {
        stub.toast?.(message, options);
        return "toast";
      },
    },
  } as unknown as ShopifyGlobal;
};
