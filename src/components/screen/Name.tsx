/**
 * A capped name (a team, a task, a workflow): printed whole, wrapping at its
 * spaces (the capped-name row of the parts table on `ScreenPart` in
 * `src/lib/Screen.ts`). Baton chose the caps, so the worst case is known: 64
 * characters is two lines at 375px, and showing it whole costs at most one
 * extra line, where an ellipsis would make the reader guess which of two
 * tasks sharing their first 30 characters this is.
 *
 * Fixed words that follow a name (a state, the step) are plain `s-text`
 * after it: a name that wraps cannot push them out of sight.
 */
export function Name({
  children,
  color,
}: {
  readonly children: string;
  readonly color?: "subdued";
}) {
  return color === undefined ? (
    <s-text>{children}</s-text>
  ) : (
    <s-text color={color}>{children}</s-text>
  );
}
