import * as Effect from "effect/Effect";

/**
 * The part of App Bridge's `shopify` global the embedded pages call. App Bridge defines it in
 * the embedded App Home only (its script is the `/app` document's first), and in the browser
 * only, so nothing reads it during SSR.
 *
 * @see https://shopify.dev/docs/api/app-home/apis
 */
export interface AppBridge {
  /** A fresh session token for this shop, valid for about a minute. */
  readonly idToken: () => Promise<string>;
  readonly modal: {
    /** Hides the `s-modal` of that id. */
    readonly hide: (id: string) => Promise<void>;
  };
  readonly toast: {
    readonly show: (
      message: string,
      options?: { readonly isError?: boolean; readonly duration?: number },
    ) => void;
  };
}

declare global {
  var shopify: AppBridge;
}

/**
 * App Bridge's own elements, which Polaris' types do not carry. `s-app-nav` is the App nav: App
 * Bridge hoists it into the admin's chrome and its `s-link` children are the nav's items.
 *
 * @see https://shopify.dev/docs/api/app-home/app-bridge-web-components/app-nav
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": { readonly children?: ReactNode };
    }
  }
}

/**
 * A session token minted for each use: the merchant socket's credential on every connect, since a
 * browser cannot set a header on a WebSocket upgrade and a token outlives no reconnect after a
 * minute.
 */
export const mintSessionToken: Effect.Effect<string> = Effect.promise(() =>
  globalThis.shopify.idToken(),
);

/** A toast in the Shopify admin's chrome; `isError` for a press that failed. */
export const toast = (message: string, options?: { readonly isError?: boolean }) =>
  globalThis.shopify.toast.show(message, options);

/** Hides an `s-modal` by its id, as its Cancel button's `--hide` command does. */
export const hideModal = (id: string) => globalThis.shopify.modal.hide(id);
