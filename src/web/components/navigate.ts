import { useRouter } from "@tanstack/react-router";

const MODIFIERS = ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const;

/**
 * Whether a click carries a modifier key, which asks the browser to open the link elsewhere (a
 * new tab or window): a client navigation leaves it to the browser. Polaris types the event as
 * `Event`; React hands its synthetic mouse event, so the keys are read by name rather than
 * through `instanceof MouseEvent`.
 */
export const opensElsewhere = (event: Event) =>
  MODIFIERS.some((key) => key in event && Reflect.get(event, key) === true);

/**
 * `href` and an `onClick` for an `s-link` or `s-button` that should navigate client-side.
 * Outside the Shopify admin nothing intercepts the anchor Polaris renders, so an `href` alone is
 * a full document load. The `href` keeps open-in-new-tab working; a click with a modifier key is
 * left to the browser.
 */
export const useNavigateOnClick = () => {
  const router = useRouter();
  return (href: string) => ({
    href,
    onClick: (event: Event) => {
      if (opensElsewhere(event)) return;
      event.preventDefault();
      void router.navigate({ href });
    },
  });
};
