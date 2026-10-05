import type * as React from "react";

import { BETWEEN_THINGS } from "./layout";

/**
 * A page whose content is plain text, not cards (the page-body row of the
 * parts table on `ScreenPart` in `src/lib/Screen.ts`): the member's workflow
 * page. A top-level `s-section` is a card whether or not it has a heading,
 * and a page whose item, note and steps are one ticket reads best with the
 * step boxes the only borders. Things are spaced by {@link BETWEEN_THINGS},
 * the spacing sections would give.
 *
 * `.page-body` in `styles.css` is the phone inset: `s-page` insets only its
 * heading on a phone and pads its children half as much, which suits
 * full-width cards and leaves plain text out of line with the heading.
 */
export function PageBody({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="page-body">
      <s-stack gap={BETWEEN_THINGS}>{children}</s-stack>
    </div>
  );
}
