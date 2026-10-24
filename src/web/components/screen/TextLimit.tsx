import { formatNumber } from "../../../domain/platform.ts";
import { noteCountFrom } from "../../../domain/shop-work.ts";

/**
 * The text-limit part: how a field with a cap tells the person about it. Free text counts down
 * in its `details` from {@link noteCountFrom}, "N characters left", then "N characters over"
 * past the cap; a one-line field shows
 * nothing; both refuse on submit with the field's own error, "Up to N characters". No field sets
 * `maxLength`: Polaris draws an `n/max` counter on an empty field the moment it is set, a rule
 * nobody asked about, and pasted text can pass it anyway, so the write refuses and the field
 * says why.
 *
 * | part       | job                                                      | component   | fixes                                                                         | used on                | never                                    |
 * | ---------- | -------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- | ---------------------- | ---------------------------------------- |
 * | text limit | the countdown and the submit error of a field with a cap | `TextLimit` | nothing; props only: `details` from `noteCountFrom`, the error "Up to N characters" | index, details, editor | `maxLength`; a counter on an empty field |
 */

/** The `details` prop while the draft is near or past its cap, else nothing: spread onto an `s-text-area`. */
export const textLimitProps = (value: string, maxLength: number): { readonly details?: string } =>
  value.length < noteCountFrom(maxLength)
    ? {}
    : value.length > maxLength
      ? { details: `${formatNumber(value.length - maxLength)} characters over` }
      : { details: `${formatNumber(maxLength - value.length)} characters left` };

/** The field's `error` for a draft past its cap, or `null`: the submit path sets it before writing. */
export const textLimitError = (value: string, maxLength: number): string | null =>
  value.length > maxLength ? `Up to ${formatNumber(maxLength)} characters` : null;
