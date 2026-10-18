import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * A page whose content is plain text, not cards: the member's workflow page. A top-level
 * `s-section` is a card whether or not it has a heading, and a page whose item, note and steps
 * are one ticket reads best with the step boxes the only borders. Things are spaced by
 * {@link BETWEEN_THINGS}, the spacing sections would give.
 *
 * `.page-body` in `styles.css` is the phone inset: `s-page` insets only its heading on a phone
 * and pads its children half as much, which suits full-width cards and leaves plain text out of
 * line with the heading.
 *
 * | part      | job                                                                   | component  | fixes                                                                        | used on | never                       |
 * | --------- | --------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- | ------- | --------------------------- |
 * | page body | a page of plain content rather than cards: the member's workflow page | `PageBody` | `base` between things; the phone inset that lines text up with the heading | details | a card around the content   |
 */
export function PageBody({ children }: { readonly children: ReactNode }) {
  return (
    <div className="page-body">
      <s-stack gap={BETWEEN_THINGS}>{children}</s-stack>
    </div>
  );
}
