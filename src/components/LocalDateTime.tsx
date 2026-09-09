import { useHydrated } from "@tanstack/react-router";

import { formatDateTime, formatTime } from "@/lib/format";

/**
 * A timestamp in the viewer's timezone that is safe to server-render.
 *
 * `formatDateTime` formats with the runtime's timezone and locale. During SSR
 * that runtime is workerd (UTC); in the browser it is the merchant's machine
 * (e.g. America/New_York). Every route that server-rendered a formatted
 * timestamp from loader data therefore hydrated to different text: React 19
 * reports "Hydration failed because the server rendered text didn't match the
 * client", throws the SSR tree away, and re-renders the whole root on the
 * client — on every load, silently (measured 2026-09-09 over the embedded
 * tunnel: SSR `Sep 8, 9:23 PM`, browser `Sep 8, 5:23 PM`). That discarded tree
 * is what the earlier "blank Updated column in s-table" symptom was, and why a
 * `ClientOnly` around `s-table` appeared to fix it.
 *
 * The server cannot know the viewer's timezone, so the honest SSR output is no
 * text: render `null` until `useHydrated()` and the real string from the
 * commit onward. The page is `inert` until that same commit (`__root.tsx`), so
 * the timestamp appears at the moment the page becomes interactive and nothing
 * is lost. Nothing else may change between server and client, which is why
 * this is the only place `formatDateTime`/`formatTime` reach a render.
 * Toasts and other post-hydration strings may keep calling the formatters
 * directly.
 */
export function LocalDateTime({
  value,
  format = "dateTime",
}: {
  readonly value: string | number;
  /** `time` is the queue's "In progress since 3:12 PM" form. */
  readonly format?: "dateTime" | "time";
}) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return format === "time" ? formatTime(value) : formatDateTime(value);
}
