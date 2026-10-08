import {
  HELP_PICTURES,
  helpPictureSrc,
  MEMBER_SCREEN,
} from "@/lib/helpPictures";

/**
 * One picture in a help page (the screenshot row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`), placed by its inventory name
 * (`HELP_PICTURES`) and sized by its kind, so no body picks a file or a
 * width, and no body can place a picture the inventory lacks.
 *
 * A member picture is a whole phone screen and shows at the phone's own
 * width, {@link MEMBER_SCREEN}, centred: at the column's width a 390px
 * screen would be drawn at two and a half times its size, and its text
 * larger than the page's.
 *
 * A merchant picture is the admin's title bar and the app frame, a modal
 * panel, or the editor window, shot at 2x. It shows at its own CSS width
 * (the width in its inventory `aspectRatio`), capped at the column's, and
 * centred: a page or the window (1056 or 1280 CSS px) fills the column
 * (about 970), while a modal panel (about 760) stays at its size rather than
 * be drawn past 1:1 at 2x. The ratio also lets the column reserve the
 * picture's height before the file loads.
 *
 * No caption, border or annotation: the alt text says what the picture
 * shows, and a highlight is a second thing to keep current.
 */
export function HelpPicture({
  name,
}: {
  readonly name: keyof typeof HELP_PICTURES;
}) {
  const picture = HELP_PICTURES[name];
  const { inlineSize, aspectRatio } =
    picture.kind === "merchant"
      ? {
          // The clip's width in CSS px, the first number of the ratio.
          inlineSize: `${picture.aspectRatio.split("/")[0]}px` as `${number}px`,
          aspectRatio: picture.aspectRatio,
        }
      : MEMBER_SCREEN;
  return (
    <s-stack alignItems="center">
      <s-box inlineSize={inlineSize} maxInlineSize="100%">
        <s-image
          src={helpPictureSrc(picture)}
          alt={picture.alt}
          inlineSize="fill"
          aspectRatio={aspectRatio}
          objectFit="contain"
        />
      </s-box>
    </s-stack>
  );
}
