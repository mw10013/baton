import type * as React from "react";

/**
 * One centred sentence of links at a page's foot (the foot-line row of the
 * parts table on `ScreenPart` in `src/lib/Screen.ts`): the way from a screen
 * to help, "Learn more in <help page heading>." Polaris's footer-help
 * composition, a line rather than a banner or a nav item, so it is there for
 * whoever looks for it and costs the screen nothing. The copy is the `link`
 * slot's foot-line form; the control is the "the way from a screen to help"
 * row of the controls table on `Control`.
 */
export function FootLine({ children }: { readonly children: React.ReactNode }) {
  return (
    <s-stack alignItems="center">
      <s-paragraph>{children}</s-paragraph>
    </s-stack>
  );
}
