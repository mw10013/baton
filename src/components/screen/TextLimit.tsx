import * as Domain from "@/lib/Domain";
import { formatNumber } from "@/lib/format";

/**
 * The text-limit part (the parts table on `ScreenPart`, and the controls
 * table's "a text limit" row on `Control` in `Screen.ts`): how a field with
 * a cap tells the person about it. Free text counts down in its `details`
 * from {@link Domain.noteCountFrom}, "N characters left"; a one-line field
 * shows nothing; both refuse on submit with the field's own error, "Up to N
 * characters". No field sets `maxLength`: Polaris draws an `n/max` counter
 * on an empty field the moment it is set, a rule nobody asked about, and
 * pasted text can pass it anyway, so the write refuses and the field says why
 * (`scripts/lib/rules-lint.ts` refuses `maxLength` outside this directory).
 */

/** The `details` prop while the draft is near its cap, else nothing: spread onto an `s-text-area`. */
export const textLimitProps = (
  value: string,
  maxLength: number,
): { readonly details?: string } =>
  value.length < Domain.noteCountFrom(maxLength)
    ? {}
    : { details: `${formatNumber(maxLength - value.length)} characters left` };

/** The field's `error` for a draft past its cap, or `null`: the submit path sets it before writing. */
export const textLimitError = (
  value: string,
  maxLength: number,
): string | null =>
  value.length > maxLength
    ? `Up to ${formatNumber(maxLength)} characters`
    : null;
