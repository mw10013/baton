/**
 * Formats a timestamp in the browser's timezone, e.g. `Jul 12, 10:49 PM`.
 * The year is appended only when it differs from the current year.
 *
 * Spaces are replaced with non-breaking spaces so the timestamp stays on one
 * line in table columns.
 */
export const formatDateTime = (value: string | number | null | undefined) =>
  value
    ? new Date(value)
        .toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          ...(new Date(value).getFullYear() === new Date().getFullYear()
            ? {}
            : { year: "numeric" }),
        })
        .replaceAll(/\s/gu, "\u00A0")
    : "";

export const formatNumber = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });
