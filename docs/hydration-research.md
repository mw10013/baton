# Hydration: one boundary, one marker

Research and decision, 2026-09-04. This is how hydration is handled in this
codebase.

## The window

TanStack Start server-renders every route. The browser paints the full page
before the client bundle loads and before `hydrateRoot` commits. During that
window the markup is complete and React-dead: an `onClick` is a no-op, a
`<form onSubmit>` with `preventDefault` falls through to the browser's native
GET submission, and text typed into a controlled input is discarded when React
takes over the value. Playwright cannot tell; its actionability checks are
satisfied by the SSR'd DOM, so an ungated spec fails much later at an
assertion for a result its click never requested.

The only signal for the end of that window is TanStack Router's
`useHydrated()`: a `useSyncExternalStore` whose server snapshot is `false` and
client snapshot is `true`. It is `false` during SSR and the first client
render, `true` from the commit onward, and `true` on the first render of any
component that mounts after hydration. `ClientOnly` is the same hook.

## Principle

The document is inert until React commits. After that, everything works.
`useHydrated()` is used directly from the router, never wrapped and never
renamed. A component reads it only when the inert boundary cannot cover what
it needs, and the JSDoc at that site says why.

## The boundary

`src/routes/__root.tsx` renders the document. The `<body>` carries both the
barrier and the marker:

```tsx
<body inert={!hydrated} data-hydrated={hydrated ? "true" : undefined}>
```

- `inert` blocks pointer, keyboard, focus, and form activation for the whole
  document until the same commit that makes React's listeners live. It applies
  identically to the embedded `/app` iframe and to the non-embedded `/login`,
  `/shop`, and `/admin` surfaces, so no route needs its own wrapper.
- `data-hydrated="true"` is the DOM signal e2e waits on. It sits on the same
  element as `inert`, so the two cannot drift. Written as
  `hydrated ? "true" : undefined` so the attribute is absent pre-hydration; a
  bare boolean would render the truthy string `"false"`. It cannot cause a
  hydration mismatch because it is `undefined` on both the server and the
  first client render.

There are no `disabled={!hydrated}` guards on individual controls. The
boundary makes them redundant, and flashing controls disabled is worse UX
than a page that ignores input for a moment.

Cost, accepted: `inert` also removes the subtree from the accessibility tree
and find-in-page for the duration of hydration. Locally that is well under a
second; over a Cloudflare quick tunnel it has been measured at four to six
seconds.

## The exceptions

Three places read `useHydrated()` for reasons the body boundary cannot serve.
They are the complete list; adding a fourth requires a reason of the same
kind, not "the page isn't ready yet".

1. **Hoisted nav, `src/routes/app.tsx`.** App Bridge lifts `s-app-nav` out of
   the iframe into the admin chrome. That DOM lives in the parent document,
   outside any inert subtree of ours, so a pre-hydration click on a hoisted
   link would fire before the `shopify:navigate` listener exists and bounce
   the iframe. The nav is rendered only once hydrated, so there is nothing to
   hoist until the bridge is wired.
2. **Socket token query, `src/routes/app.tsx`.** `useAgent` evaluates its
   `query` during render, including SSR, and `shopify.idToken()` is a
   browser-only App Bridge API. `enabled: hydrated` and a `hydrated`-gated
   `query` keep it off the server and skip a wasted tokenless connection.
3. **Socket banner, `src/lib/SocketBanner.tsx`.** `identified` is always
   `false` on the server. `ClientOnly` keeps the warning out of the SSR HTML
   so the page does not ship it and then hydrate it away. This is an SSR
   content decision, not an interaction guard.

`src/routes/admin.shops.tsx` also wraps its `s-table` in `ClientOnly`,
undocumented since the initial commit. It is presumed to avoid a Polaris
slot-hoisting mismatch and is left in place pending verification.

Unrelated: the router's `dehydrate`/`hydrate` hooks in `src/router.tsx` carry
the D1 bookmark from SSR to the client. They share a word with this document
and nothing else.

## Playwright

One helper, `awaitHydration`, in `e2e/hydration.ts`:

```ts
export const awaitHydration = (scope: Page | FrameLocator) =>
  scope.locator('body[data-hydrated="true"]').waitFor({ state: "attached" });
```

It takes a `Page` for the non-embedded surfaces and a `FrameLocator` for the
embedded app, so both areas gate on the same selector. Playwright is
inert-blind (`injectedScript.ts` never reads `inert`; its enabled check looks
only at `aria-disabled`; the hit test is geometry), so a click inside an inert
subtree is dispatched and silently swallowed. Waiting on the marker is the only
honest readiness signal.

`gotoApp` in `e2e/app.ts` keeps its tunnel-stall rescue (15s timeout, one
reload, retry) around the same helper, because the embedded app is served
through a quick tunnel where individual Vite module requests can hang. The
member helpers in `e2e/member.ts` use the default timeout; localhost needs no
rescue.
