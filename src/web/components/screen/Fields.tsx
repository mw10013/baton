import type { ReactNode } from "react";
import { BETWEEN_THINGS } from "./layout.ts";

/**
 * A form's fields, stacked: a modal's or a card's text fields, selects and checkboxes. Spaced by
 * {@link BETWEEN_THINGS}: each field is a thing with its own label, help and error, and
 * `small-300` ran one field's error into the next field's label.
 *
 * | part   | job                      | component | fixes                                                                    | used on                | never               |
 * | ------ | ------------------------ | --------- | ------------------------------------------------------------------------ | ---------------------- | ------------------- |
 * | fields | a form's fields, stacked | `Fields`  | `base` between fields, so one field's error never runs into the next label | index, details, editor | a field beside a field |
 */
export function Fields({ children }: { readonly children: ReactNode }) {
  return <s-stack gap={BETWEEN_THINGS}>{children}</s-stack>;
}
