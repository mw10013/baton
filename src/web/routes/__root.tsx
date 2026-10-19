import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  useHydrated,
} from "@tanstack/react-router";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { ReactNode } from "react";
import { POLARIS_URL } from "../components/polaris.ts";
import stylesheet from "../styles.css?url";

/**
 * The document every page renders in, and the home of the site-wide UI conventions.
 *
 * Polaris loads in `<head>`, before the body is parsed, so every `s-*` element upgrades as the
 * parser reaches it, a parent before its children. Loaded at body end, it defines its elements
 * into a finished document, existing elements upgrade in define order, and a server-rendered
 * `s-table-row` upgrades before its `s-table` and renders empty. It comes after
 * {@link HeadContent} so a route's own head script, such as App Bridge, which must be the
 * document's first script, stays ahead of it.
 *
 * Copy:
 * - A button or link names its action in one or two words: "Send link", "Sign out",
 *   "Dashboard".
 * - At most one supporting line per heading or field, and it never restates the heading,
 *   label or button.
 * - No developer detail in user-facing text: no error tags, defects, transport or
 *   architecture terms. Say what happened and what to do: "Couldn't reach the server. Try
 *   again."
 * - No placeholder that repeats its label.
 *
 * Until React has hydrated, the server markup is painted but dead: a click does nothing, a form
 * falls through to the browser's own submit, and typed text is dropped. `inert` on `<body>`
 * blocks input for that window, so no control needs its own `disabled` guard. `data-hydrated`
 * marks the end of it; browser tests wait for it after a full page load, because Playwright's
 * actionability checks do not see `inert` and a click before then is lost. {@link useHydrated}
 * is false on the server and on the first client render, so the server markup and the hydration
 * render agree.
 */
function RootDocument({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  return (
    // Polaris adds its theme class (`p-partial-theme-admin-next`) to `<html>` as it loads, before
    // React hydrates; this suppresses only that element's attribute mismatch, not its children's.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script src={POLARIS_URL} />
      </head>
      <body inert={!hydrated} data-hydrated={hydrated ? "" : undefined}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

export const Route = createRootRouteWithContext<{ registry: AtomRegistry.AtomRegistry }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Baton" },
      {
        name: "description",
        content:
          "Baton gives made-to-order Shopify merchants a clear production workflow from order to completion.",
      },
    ],
    links: [{ rel: "stylesheet", href: stylesheet }],
  }),
  notFoundComponent: () => (
    <s-page heading="Page not found" inlineSize="small">
      <s-section accessibilityLabel="Page not found">
        <s-link href="/">Home</s-link>
      </s-section>
    </s-page>
  ),
  shellComponent: RootDocument,
});
