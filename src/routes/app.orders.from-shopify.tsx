import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Where the **Open in Baton** admin link lands
 * (`extensions/baton-order-link`).
 *
 * A static segment, so it never collides with `/app/orders/$orderId` — that
 * route's param is a legacy id, all digits, and `from-shopify` is not.
 *
 * Shopify documents only that an admin link "appends generated URL parameters
 * that identify the store that launched the action and the resource IDs of the
 * currently selected or displayed resource"
 * (`refs/shopify-docs/docs/apps/build/admin/admin-links.md`), never their
 * names. Observed from a dev store on the `admin.order-details.action.link`
 * target: `admin_theme`, `embedded`, `hmac`, `host`, `id`, `id_token`,
 * `locale`, `session`, `shop`, `timestamp`. Only `id` is this route's
 * business; it arrives as a bare number (the REST/legacy id, which is exactly
 * what `/app/orders/$orderId` takes), and a gid is accepted too because the
 * same parameter is a gid on some other targets and taking the last `/`
 * segment costs one line.
 *
 * **Everything else is forwarded verbatim, and that is the whole point of the
 * spread.** The other nine are the embedded-app handshake: App Bridge boots
 * from `shop` and `host`, and `authenticateAdminRequest` reads `id_token`.
 * Redirecting with only `params` drops them, the admin frame renders nothing,
 * and the Worker logs `render-app-bridge-missing-shop-host` with `hasShop:
 * false` — which is what this route did on its first dev-store click. Forward
 * the whole search rather than an allow-list of the three we happen to know
 * about: they are Shopify's parameters, not ours, and an allow-list would
 * silently drop whatever it adds next.
 *
 * The page has nothing to render: `beforeLoad` always redirects, and because
 * the route sits under `app.tsx` the session guard there has already run. A
 * missing or unusable id goes to the orders index rather than a 404 — the
 * merchant came from an order they were looking at, so the list is somewhere
 * to carry on from, and a malformed link is nothing they could act on.
 */
export const Route = createFileRoute("/app/orders/from-shopify")({
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: ({ search }) => {
    const { id, ...embedded } = search;
    const orderId =
      typeof id === "string" || typeof id === "number"
        ? String(id).split("/").at(-1)
        : undefined;
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(
      orderId === undefined || orderId === ""
        ? { to: "/app/orders", search: embedded }
        : {
            to: "/app/orders/$orderId",
            params: { orderId },
            search: embedded,
          },
    );
  },
});
