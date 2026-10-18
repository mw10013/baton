import { createFileRoute, Outlet } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { OrdersSearch } from "./-orders-search.ts";

/**
 * Layout for the orders pages: the search context ({@link OrdersSearch}) and nothing else.
 * `from-shopify` is a child too; it reads the raw search, so its redirect forwards every
 * parameter intact.
 */
export const Route = createFileRoute("/app/orders")({
  validateSearch: Schema.toStandardSchemaV1(OrdersSearch),
  component: () => <Outlet />,
});
