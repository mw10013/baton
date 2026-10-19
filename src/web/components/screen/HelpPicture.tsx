import {
  HELP_PICTURES,
  helpPictureSrc,
  type HelpPictureName,
  MEMBER_SCREEN,
} from "../help/pictures.ts";

/**
 * The pictures shot so far. Until the screenshot script has written a file, its placement renders
 * nothing rather than a broken image.
 */
const SHOT: ReadonlySet<HelpPictureName> = new Set();

/**
 * One picture in a help page, placed by its inventory name ({@link HELP_PICTURES}) and sized by
 * its kind, so no body picks a file or a width, and no body can place a picture the inventory
 * lacks.
 *
 * A member picture is a whole phone screen and shows at the phone's own width,
 * {@link MEMBER_SCREEN}, centred: at the column's width a 390px screen would be drawn at two and a
 * half times its size, and its text larger than the page's.
 *
 * A merchant picture is the Shopify admin's title bar and the app frame, a modal panel, or the
 * editor window, shot at 2x. It shows at its own CSS width (the width in its inventory
 * `aspectRatio`), capped at the column's, and centred: a page or the window (1056 or 1280 CSS px)
 * fills the column (about 970), while a modal panel (about 760) stays at its size rather than be
 * drawn past 1:1 at 2x. The ratio also lets the column reserve the picture's height before the
 * file loads.
 *
 * No caption, border or annotation: the alt text says what the picture shows, and a highlight is
 * a second thing to keep current.
 *
 * | part       | job                         | component     | fixes                               | used on | never                 |
 * | ---------- | --------------------------- | ------------- | ----------------------------------- | ------- | --------------------- |
 * | screenshot | one help picture, by name   | `HelpPicture` | width by kind; height reserved      | help    | a caption; a highlight |
 */
export function HelpPicture({ name }: { readonly name: HelpPictureName }) {
  if (!SHOT.has(name)) return null;
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
