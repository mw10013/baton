import { useHydrated } from "@tanstack/react-router";

/**
 * A timestamp in the browser's timezone, e.g. `Jul 12, 10:49 PM`, the year appended only when it
 * differs from the current year. Spaces are non-breaking so the timestamp stays on one line.
 */
const formatDateTime = (value: number) =>
  new Date(value)
    .toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(new Date(value).getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
    })
    .replaceAll(/\s/gu, " ");

/**
 * A timestamp in the viewer's timezone that is safe to server-render.
 *
 * The formatter uses the runtime's timezone and locale. During SSR that runtime is workerd (UTC);
 * in the browser it is the merchant's machine, so a server-rendered timestamp hydrates to
 * different text: React reports a hydration mismatch, throws the SSR tree away and re-renders
 * the whole root on the client, on every load, silently. The server cannot know the viewer's
 * timezone, so the honest SSR output is no text: `null` until hydrated, the real string from the
 * commit onward. Nothing else may change between server and client, which is why this is the
 * only place a formatted timestamp reaches a render.
 */
export function LocalDateTime({ value }: { readonly value: number }) {
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return formatDateTime(value);
}
