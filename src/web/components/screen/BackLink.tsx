import { opensElsewhere, useNavigateOnClick } from "../navigate.ts";

/**
 * The way back to the page this one was opened from, on its own line between the top bar and
 * `s-page`: a tertiary button with a back arrow, named for the target page's heading. Not
 * `s-page`'s `breadcrumb-actions` slot, which a phone folds into a "…" menu beside the heading.
 *
 * `href` is where the link goes when opened in a new tab, and on a plain click unless
 * `onNavigate` is given: a page that knows the entry before it is its target (the member's
 * workflow page opened from the workflows list) steps back in history there instead, so the list
 * comes back at its depth and scroll. A click with a modifier key is left to the browser.
 *
 * `.back-link` in `styles.css` lines it up with the column of `s-page inlineSize="small"`.
 */
export function BackLink({
  label,
  href,
  onNavigate,
}: {
  readonly label: string;
  readonly href: string;
  readonly onNavigate?: () => void;
}) {
  const navigate = useNavigateOnClick();
  const link =
    onNavigate === undefined
      ? navigate(href)
      : {
          href,
          onClick: (event: Event) => {
            if (opensElsewhere(event)) return;
            event.preventDefault();
            onNavigate();
          },
        };
  return (
    <div className="back-link">
      <s-button variant="tertiary" icon="arrow-left" {...link}>
        {label}
      </s-button>
    </div>
  );
}
