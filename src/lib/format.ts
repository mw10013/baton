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

/**
 * Coarse age for a run row's "ordered 3d ago": minutes under an hour,
 * hours under a day, then days. Coarse on purpose — a bench wants "is this
 * from today or last week", not a timestamp, which the work page has. Same
 * SSR caveat as `formatDateTime`: `Date.now()` differs between the server
 * render and hydration, so render through `LocalDateTime`.
 */
export const formatRelative = (value: string | number, now = Date.now()) => {
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
