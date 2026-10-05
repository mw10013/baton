/**
 * The way back to the list a page was opened from (the back-link row of the
 * parts table on `ScreenPart` in `src/lib/Screen.ts`): a tertiary button with
 * a back arrow, named for the list (`label`, a `link` slot, `CopySlot`), on
 * its own line between the top bar and `s-page`. Hidden in print
 * (`.print-hide`): a printed page is a job ticket.
 *
 * `.member-back` in `styles.css` lines it up with `s-page inlineSize="small"`'s
 * column and gives back the button's own inner padding, so the arrow, not its
 * hit area, sits on the column's edge.
 *
 * `href` is a real link, so open-in-new-tab works; `onNavigate` is what an
 * ordinary tap does instead, which the screen decides (a history step back,
 * or a navigation).
 */
export function BackLink({
  label,
  href,
  onNavigate,
}: {
  readonly label: string;
  readonly href: string;
  readonly onNavigate: () => void;
}) {
  return (
    <div className="member-back print-hide">
      <s-button
        variant="tertiary"
        icon="arrow-left"
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onNavigate();
        }}
      >
        {label}
      </s-button>
    </div>
  );
}
