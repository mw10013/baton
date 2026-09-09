/**
 * Formats a timestamp in the browser's timezone, e.g. `Jul 12, 10:49 PM`.
 * The year is appended only when it differs from the current year.
 *
 * Never call this from a server-rendered branch: SSR runs in UTC and the
 * browser in the viewer's timezone, so the text differs and React throws the
 * SSR tree away. Render it through `LocalDateTime`
 * (`src/components/LocalDateTime.tsx`), which waits for hydration.
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

/** Time of day in the browser's timezone, e.g. `3:12 PM`. Same SSR caveat as `formatDateTime`: render through `LocalDateTime`. */
export const formatTime = (value: string | number) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

export const formatNumber = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });
