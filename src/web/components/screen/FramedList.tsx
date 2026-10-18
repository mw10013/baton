import { Children, isValidElement, type ReactNode } from "react";
import { BETWEEN_LINES } from "./layout.ts";

/**
 * Entries that make one stop, in one bordered box with a rule between them: the tasks of one step
 * on the member's workflow page and the order page's Manage drawer. One box per step, so a
 * parallel step reads as one stop before its caption is read; the rules separate its tasks the
 * way rules separate a list's rows. Each child is one entry, padded by {@link BETWEEN_LINES}.
 *
 * | part        | job                                                                  | component    | fixes                                         | used on | never            |
 * | ----------- | -------------------------------------------------------------------- | ------------ | --------------------------------------------- | ------- | ---------------- |
 * | framed list | entries that make one stop, in one bordered box with a rule between them | `FramedList` | the border, the rules, `small-300` padding | details | a box per entry  |
 */
export function FramedList({ children }: { readonly children: ReactNode }) {
  return (
    <s-box borderWidth="base" borderRadius="base">
      {Children.toArray(children).map((child, index) => (
        <s-box
          key={(isValidElement(child) ? child.key : null) ?? index}
          padding={BETWEEN_LINES}
          borderWidth={index === 0 ? "none" : "base none none none"}
        >
          {child}
        </s-box>
      ))}
    </s-box>
  );
}
