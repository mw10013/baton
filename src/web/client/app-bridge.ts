import type { SAppNavAttributes, SAppWindowAttributes } from "@shopify/app-bridge-types";
import * as Effect from "effect/Effect";
import type { Ref } from "react";

/**
 * App Bridge's own elements for React 19's JSX, which `@shopify/app-bridge-types` declares only
 * on the global `JSX` namespace that React 19 no longer reads. `s-app-nav` is the App nav: App
 * Bridge hoists it into the admin's chrome and its `s-link` children are the nav's items.
 * `s-app-window` is the workflow editor's window.
 *
 * @see https://shopify.dev/docs/api/app-home/app-bridge-web-components/app-nav
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": SAppNavAttributes & { readonly children?: ReactNode };
      "s-app-window": SAppWindowAttributes & { readonly ref?: Ref<SAppWindowElement | null> };
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
