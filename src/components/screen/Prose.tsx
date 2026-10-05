import type * as React from "react";

/**
 * Free text exactly as a person typed it, on its home (the free-text row of
 * the parts table on `ScreenPart` in `src/lib/Screen.ts`): a run note, a
 * block reason, task instructions, an order note. `.prose` in `styles.css`
 * keeps the line breaks and says why. A wrapper rather than a class on the
 * Polaris element because `class` is not in these components' JSX props;
 * `white-space` inherits, so the text inside is governed either way.
 */
export function Prose({
  children,
  color,
}: {
  readonly children: React.ReactNode;
  readonly color?: "subdued";
}) {
  return (
    <div className="prose">
      {color === undefined ? (
        <s-paragraph>{children}</s-paragraph>
      ) : (
        <s-text color={color}>{children}</s-text>
      )}
    </div>
  );
}
