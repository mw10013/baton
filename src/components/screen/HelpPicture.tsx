import {
  HELP_PICTURES,
  helpPictureSrc,
  MEMBER_SCREEN,
} from "@/lib/helpPictures";

/**
 * One picture in a help page (the screenshot row of the parts table on
 * `ScreenPart` in `src/lib/Screen.ts`), placed by its inventory name
 * (`HELP_PICTURES`) and sized by its kind, so no body picks a file or a
 * width, and no body can place a picture the inventory lacks. A member
 * picture is a whole phone screen and shows at the phone's own width,
 * {@link MEMBER_SCREEN}, centred: at the column's width a 390px screen would
 * be drawn at two and a half times its size, and its text larger than the
 * page's. A merchant picture (the admin's title bar and the app frame, about
 * the column's width already, so it would fill the column and keep its
 * proportions) is not taken yet; its kind joins the inventory when the
 * script can shoot it, and this part then switches on the kind.
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
  return (
    <s-stack alignItems="center">
      <s-box inlineSize={MEMBER_SCREEN.inlineSize} maxInlineSize="100%">
        <s-image
          src={helpPictureSrc(picture)}
          alt={picture.alt}
          inlineSize="fill"
          aspectRatio={MEMBER_SCREEN.aspectRatio}
          objectFit="contain"
        />
      </s-box>
    </s-stack>
  );
}
