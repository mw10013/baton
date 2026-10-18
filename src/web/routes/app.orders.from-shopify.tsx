import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Where the admin link extension's Open in Baton lands, with the order's `id` beside the
 * embedded handshake's parameters (`shop`, `host`, `embedded`, `id_token` and the rest). A static
 * segment, so it never collides with `/app/orders/$orderId`, whose param is a legacy id.
 *
 * `id` arrives as a bare number (the legacy id, which is exactly what the order page takes); a
 * GID is accepted too, by its last `/` segment. Everything else is forwarded verbatim from the raw
 * search: App Bridge boots from it and the `/app` guards read it, and an allow-list would drop
 * whatever Shopify adds next. The `/app` guards have already run, since the route sits under
 * `app.tsx`. A missing or empty id goes to the orders index rather than a 404: the merchant came
 * from an order, so the list is somewhere to carry on from.
 */
export const Route = createFileRoute("/app/orders/from-shopify")({
  beforeLoad: ({ location }) => {
    const search = new URLSearchParams(location.searchStr);
    const orderId = (search.get("id") ?? "").split("/").at(-1) ?? "";
    search.delete("id");
    const rest = search.toString();
    const path = orderId === "" ? "/app/orders" : `/app/orders/${encodeURIComponent(orderId)}`;
    throw redirect({ href: rest === "" ? path : `${path}?${rest}` });
  },
});
