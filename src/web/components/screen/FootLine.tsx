import type { ReactNode } from "react";

/**
 * One centred sentence of links at a page's foot: the way from a screen to help, "Learn more in
 * <help page heading>." Polaris's footer-help composition, a line rather than a banner or a nav
 * item, so it is there for whoever looks for it and costs the screen nothing.
 *
 * | part      | job                                                       | component  | fixes             | used on                          | never                       |
 * | --------- | --------------------------------------------------------- | ---------- | ----------------- | -------------------------------- | --------------------------- |
 * | foot line | one centred sentence of links at a page's foot: the way to help | `FootLine` | centred; one line | homepage, details, editor, index | a second sentence; a banner |
 */
export function FootLine({ children }: { readonly children: ReactNode }) {
  return (
    <s-stack alignItems="center">
      <s-paragraph>{children}</s-paragraph>
    </s-stack>
  );
}
