import type { ReactNode } from "react";
import { useNavigateOnClick } from "../navigate.ts";

/** A link from one help page to another, through the router: help is outside the Shopify admin. */
export function HelpLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  const navigate = useNavigateOnClick();
  return <s-link {...navigate(href)}>{children}</s-link>;
}
