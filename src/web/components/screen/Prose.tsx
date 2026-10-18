import type { ReactNode } from "react";

/**
 * Free text exactly as a person typed it, on its home: a run note, a block reason, task
 * instructions, an order note. `.prose` in `styles.css` keeps the line breaks and says why. A
 * wrapper rather than a class on the Polaris element because `class` is not in these components'
 * JSX props; `white-space` inherits, so the text inside is governed either way.
 *
 * | part      | job                                                  | component | fixes                                       | used on                          | never                   |
 * | --------- | ---------------------------------------------------- | --------- | ------------------------------------------- | -------------------------------- | ----------------------- |
 * | free text | a block reason, a note, task instructions, an order note | `Prose`   | on its home: `Prose`, line breaks kept      | index, details, homepage, editor | collapsed line breaks   |
 */
export function Prose({
  children,
  color,
}: {
  readonly children: ReactNode;
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
