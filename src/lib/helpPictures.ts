/**
 * The help's pictures, one entry per file under `public/assets/help/`:
 * the inventory both sides read. `scripts/help-screenshots.ts` reads it to
 * know what to shoot and where to write it; a page body reads it to place a
 * picture (the screenshot part, `HelpPicture` in `src/components/screen/`),
 * by name, so a body cannot place a picture the inventory lacks. The
 * integration test holds the rest: every entry's file exists, every file is
 * an entry, and every entry is placed by some body.
 *
 * `file` is `<section>/<page>-<n>.png` under `public/assets/help/`, `<n>`
 * the picture's order on the page. `kind` says how it is shot and shown:
 * `member` is the whole phone screen, 390 × 844 CSS px at 2x, shown 390 CSS
 * px wide. Merchant pictures (the admin's title bar and the app frame, shown
 * at the column's width) are not taken yet; their kind joins this one when
 * the script can shoot them.
 *
 * `alt` is 30 to 60 words saying what the picture shows and which control or
 * badge matters, in the screen's words; a picture has no caption.
 */
export type HelpPictureKind = "member";

export interface HelpPicture {
  readonly file: string;
  readonly kind: HelpPictureKind;
  readonly alt: string;
}

/**
 * The phone a member picture is shot on, in CSS px, and the same size as the
 * screenshot part's props: it shows the picture at the phone's own width.
 */
export const MEMBER_SCREEN = {
  width: 390,
  height: 844,
  inlineSize: "390px",
  aspectRatio: "390/844",
} as const;

/** Where the pictures are served from, and written to under `public/`. */
export const HELP_PICTURES_PATH = "/assets/help";

export const HELP_PICTURES = {
  /** The list's default, Started by you, Any team. */
  findingYourWork1: {
    file: "members/finding-your-work-1.png",
    kind: "member",
    alt: "The Workflows list on a phone, signed in as ana@example.com. The strip counts Started by you, Started by others, Ready, Blocked and Done or closed, with Started by you chosen. Under the search field and the Team select, set to Any team, each row shows an order number and item, its task and team, then its workflow and step.",
  },
  /** The Team select set to Engraving, Ready chosen. */
  findingYourWork2: {
    file: "members/finding-your-work-2.png",
    kind: "member",
    alt: "The Workflows list with Ready chosen on the strip and the Team select set to Engraving. The strip counts only Engraving's items. Each row is a task nobody has started yet, such as Engrave, Stamp initials or Engrave crest, with the order number and item above it and the workflow and step below.",
  },
  /** "Nana's kitchen", the maple board between steps: Engrave on Engraving is Ready. */
  recordingYourWork1: {
    file: "members/recording-your-work-1.png",
    kind: "member",
    alt: "An item's page for an engraved cutting board in maple, under its order number. Under the item are its SKU and its engraving text, Nana's kitchen. Below them are the workflow's steps: Cut and sand reads Done, and Engrave on the Engraving team reads Ready, with its instructions and the Start and Done buttons.",
  },
  /** "Grandma Rose", the maple board ana@example.com started: Engrave is Started. */
  recordingYourWork2: {
    file: "members/recording-your-work-2.png",
    kind: "member",
    alt: "An item's page for a maple board to engrave with Grandma Rose. The Engrave task reads Started, with the Engraving team, ana@example.com and the time it was started. Under its instructions are the Done and Put back buttons. The next step, Oil and inspect, waits below.",
  },
  /** "Grandma Rose" after Done on Engrave: the Undo. */
  recordingYourWork3: {
    file: "members/recording-your-work-3.png",
    kind: "member",
    alt: "The same page after Done on the Engrave task. Engrave reads Done, with ana@example.com and the time, and an Undo button under its instructions. The next step's task, Oil and inspect on the Finishing team, now reads Ready.",
  },
  /** "Home sweet home", the walnut board ana@example.com started at Oil and inspect: the Block modal, a reason typed. */
  blocking1: {
    file: "members/blocking-1.png",
    kind: "member",
    alt: "The Block modal open over the page for a walnut cutting board. Its heading asks whether to block the order, the item is named under it, and the Reason field holds a typed reason: the oil is still tacky after a day. At its foot are Cancel and a red Block button.",
  },
  /** "Smith family", the walnut board ana@example.com blocked at Engrave: the banner with Unblock. */
  blocking2: {
    file: "members/blocking-2.png",
    kind: "member",
    alt: "The page for a walnut cutting board, with a red Blocked banner under the item's name. The banner shows the reason as it was typed, that the board has a crack along the grain, then ana@example.com and when, and an Unblock button. The steps below are unchanged.",
  },
} as const satisfies Readonly<Record<string, HelpPicture>>;

export type HelpPictureName = keyof typeof HELP_PICTURES;

/** A picture's URL, as the page serves it. */
export const helpPictureSrc = (picture: HelpPicture) =>
  `${HELP_PICTURES_PATH}/${picture.file}`;
