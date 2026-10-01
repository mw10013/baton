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
export const formatDateTime = (value: number | null | undefined) =>
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

/**
 * The day alone in the browser's timezone, e.g. `Jul 12`, the year appended
 * only when it differs from the current year. The orders index's Placed
 * column: the index is sorted by the time, so the date is all the column
 * has to say, and a time added 40px to the narrowest column of a table that
 * must fit the admin's content width at a 1024px viewport. Same SSR caveat as
 * `formatDateTime`: render through `LocalDateTime`.
 */
export const formatDate = (value: number) =>
  new Date(value)
    .toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(new Date(value).getFullYear() === new Date().getFullYear()
        ? {}
        : { year: "numeric" }),
    })
    .replaceAll(/\s/gu, " ");

/** Time of day in the browser's timezone, e.g. `3:12 PM`. Same SSR caveat as `formatDateTime`: render through `LocalDateTime`. */
export const formatTime = (value: number) =>
  new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * A Shopify status enum as the admin prints it: `PARTIALLY_REFUNDED` →
 * `Partially refunded`. Shopify's own UI never shows the raw constant.
 */
export const formatStatus = (value: string) =>
  value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");

export const formatNumber = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * Coarse age for a run row's "ordered 3d ago": minutes under an hour,
 * hours under a day, then days. Coarse on purpose — a bench wants "is this
 * from today or last week", not a timestamp, which the workflow page has. Same
 * SSR caveat as `formatDateTime`: `Date.now()` differs between the server
 * render and hydration, so render through `LocalDateTime`.
 */
export const formatRelative = (value: number, now = Date.now()) => {
  const minutes = Math.max(
    0,
    Math.round((now - new Date(value).getTime()) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
};
