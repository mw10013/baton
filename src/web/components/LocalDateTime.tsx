import { useHydrated } from "@tanstack/react-router";

/** The year option, only when `value` falls in a year other than the current one. */
const yearUnlessCurrent = (value: number) =>
  new Date(value).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" as const };

/**
 * A timestamp in the browser's timezone, e.g. `Jul 12, 10:49 PM`. Spaces are non-breaking so the
 * timestamp stays on one line.
 */
const formatDateTime = (value: number) =>
  new Date(value)
    .toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...yearUnlessCurrent(value),
    })
    .replaceAll(/\s/gu, "\u00A0");

/**
 * The day alone, e.g. `Jul 12`: the orders index's Placed column. The index is sorted by the
 * time, so the date is all the column has to say, and a time added 40px to the narrowest column
 * of a table that must fit the admin's content width at a 1024px viewport.
 */
const formatDate = (value: number) =>
  new Date(value)
    .toLocaleDateString(undefined, { month: "short", day: "numeric", ...yearUnlessCurrent(value) })
    .replaceAll(/\s/gu, "\u00A0");

/** Time of day, e.g. `3:12 PM`. */
const formatTime = (value: number) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * Coarse age, "3d ago": minutes under an hour, hours under a day, then days. Coarse on purpose:
 * a bench wants "is this from today or last week", not a timestamp, which the workflow page has.
 */
const formatRelative = (value: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - value) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
};

/**
 * A timestamp in the viewer's timezone that is safe to server-render.
 *
 * The formatters use the runtime's timezone and locale, and `relative` reads the clock. During
 * SSR that runtime is workerd (UTC); in the browser it is the merchant's machine, so a
 * server-rendered timestamp hydrates to different text: React reports a hydration mismatch,
 * throws the SSR tree away and re-renders the whole root on the client, on every load, silently.
 * The server cannot know the viewer's timezone, so the honest SSR output is no text: `null` until
 * hydrated, the real string from the commit onward. Nothing else may change between server and
 * client, which is why this is the only place a formatted timestamp reaches a render, and why
 * the formatters are private to it. The year is appended only when it differs from the current
 * year.
 */
export function LocalDateTime({
  value,
  format = "dateTime",
}: {
  readonly value: number;
  /**
   * `date` is the day alone (the orders index's Placed column); `time` the clock-only form
   * ("… · since 3:12 PM"); `relative` the coarse age ("ordered 3d ago", "3h ago").
   */
  readonly format?: "dateTime" | "date" | "time" | "relative";
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  if (format === "date") return formatDate(value);
  if (format === "time") return formatTime(value);
  if (format === "relative") return formatRelative(value, Date.now());
  return formatDateTime(value);
}
