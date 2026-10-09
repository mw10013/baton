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
 * the picture's order on the page where it was first taken; another page may
 * place the same picture. `kind` says how it is shot and shown:
 *
 * - `member`: the whole phone screen, {@link MEMBER_SCREEN} at 2x, signed in
 *   as a showcase member, and shown 390 CSS px wide and centred.
 * - `merchant`: shot in the admin in {@link MERCHANT_WINDOW} at 2x, as one of
 *   four shapes the entry's comment names: `page` (the admin's title bar and
 *   the app frame, down to the page's content), `modal` (a modal's panel in
 *   the app frame), `window` (the workflow editor's window) or `editor
 *   modal` (a modal's panel in the editor). Shown at its own width capped at
 *   the column's, so a page or the window fills the column and a modal keeps
 *   its size. Its `aspectRatio` is the clip's size.
 *
 * `alt` is 30 to 60 words saying what the picture shows and which control or
 * badge matters, in the screen's words; a picture has no caption.
 */
export type HelpPictureKind = "member" | "merchant";

export interface HelpPicture {
  readonly file: string;
  readonly kind: HelpPictureKind;
  readonly alt: string;
  /**
   * A merchant picture's clip in CSS px as `<width>/<height>`, set from the
   * script's output; the part passes it to `s-image` so the column reserves
   * the height before the file loads, and the integration test holds it equal
   * to the file. A member picture is {@link MEMBER_SCREEN} and carries none.
   */
  readonly aspectRatio?: string;
}

/** The window a merchant picture is shot in, in CSS px, at 2x. */
export const MERCHANT_WINDOW = { width: 1280, height: 800 } as const;

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
  /** The home page on the showcase shop: setup done, so no Getting started; the Orders strip, then Usage and capacity. Shape: page. */
  installing1: {
    file: "getting-started/installing-1.png",
    kind: "merchant",
    aspectRatio: "1056/508",
    alt: "Baton's home page. The Orders card counts No workflow, Not started, Making, Made and Issues, each a link to the Orders page. Below it, Usage and capacity shows the Orders this billing cycle and Members tiles, each a number against what the plan includes with a bar under it, and the Manage plan button.",
  },
  /** #1206, the maple board "Grandma Rose" at Engrave, the second of three steps. Shape: page. */
  howBatonWorks1: {
    file: "getting-started/how-baton-works-1.png",
    kind: "merchant",
    aspectRatio: "1056/374",
    alt: "The order page for order 1206, with Sync from Shopify and View in Shopify in the title bar. Its one item, an engraved cutting board in maple with the engraving text Grandma Rose, carries a Making badge and reads Step 2 of 3, Engrave. Edit note and Manage sit under it. Order details shows it paid and unfulfilled.",
  },
  /** The Create workflow modal with Name typed and the Tag typed over its filled value. Shape: modal. */
  firstWorkflow1: {
    file: "getting-started/first-workflow-1.png",
    kind: "merchant",
    aspectRatio: "620/286",
    alt: "The Create workflow modal. The Name field holds Engraved pen and the Tag field holds engraved-pen, with the line under it saying to put this tag, in Shopify, on the products the workflow should build. At the foot are Cancel and the Create button, ready to press.",
  },
  /** The editor on the new workflow with the New step form filled. Shape: window. */
  firstWorkflow2: {
    file: "getting-started/first-workflow-2.png",
    kind: "merchant",
    aspectRatio: "1212/466",
    alt: "The workflow editor for Engraved pen, a window of its own with a Draft badge and a greyed Turn on workflow button in its title bar. The New step form is filled: Name reads Engrave, Team is set to Engraving, and Instructions say to check the spelling before running the laser. Add step and Cancel sit under it.",
  },
  /** After Add step, the Turn on modal in the editor. Shape: editor modal. */
  firstWorkflow3: {
    file: "getting-started/first-workflow-3.png",
    kind: "merchant",
    aspectRatio: "620/158",
    alt: "The modal that opens from Turn on workflow in the editor. Its heading asks whether to turn on Engraved pen, and its sentence says every open order with an item tagged engraved-pen starts this workflow on that item. At the foot are Cancel and the Turn on button.",
  },
  /** The team page right after Create team. Shape: page. */
  firstTeam1: {
    file: "getting-started/first-team-1.png",
    kind: "merchant",
    aspectRatio: "1056/302",
    alt: "The page for the new team Assembly, with More actions and Add members in its title bar. The Members section says nobody is on this team yet, so its tasks wait until a member joins, with a second Add members button. The Details section shows zero members and when the team was created.",
  },
  /** The Add members modal: the search field and the seven showcase members. Shape: modal. */
  firstTeam2: {
    file: "getting-started/first-team-2.png",
    kind: "merchant",
    aspectRatio: "620/386",
    alt: "The Add members to Assembly modal. A search field by email sits above a checkbox for every member, from ana@example.com to gus@example.com, none ticked yet. At the foot are Cancel and the Add button, greyed until an email is ticked.",
  },
  /** #1210, the maple board "Fresh bread", done: the banner with Fulfill in Shopify. Shape: page. */
  firstOrder1: {
    file: "getting-started/first-order-1.png",
    kind: "merchant",
    aspectRatio: "1056/442",
    alt: "The order page for order 1210. A banner with a green check says every item is done, with a Fulfill in Shopify link. The one item, an engraved cutting board in maple with the engraving text Fresh bread, carries a Done badge and reads Done, 3 steps. Order details shows it paid and unfulfilled.",
  },
  /** The Workflows page with the showcase's eight workflows: Frame and glaze reads Inactive, Weekend engraving reads Active and Team has no members. Shape: page. */
  creating1: {
    file: "workflows/creating-1.png",
    kind: "merchant",
    aspectRatio: "1056/518",
    alt: "The Workflows page with Create workflow in its title bar. All, Active and Inactive sit beside a search field by name. The table lists eight workflows with their Status, Tag, Steps and Updated. Every one reads Active but Frame and glaze, which reads Inactive, and Weekend engraving also reads Team has no members.",
  },
  /** The editor on Embroider and fold, which has a draft: Draft, More actions, Discard changes and Apply changes in the title bar, three steps on the canvas, nothing selected. Shape: window. */
  editing1: {
    file: "workflows/editing-1.png",
    kind: "merchant",
    aspectRatio: "1212/680",
    alt: "The workflow editor for Embroider and fold, a window of its own with a Draft badge and More actions, Discard changes and Apply changes in its title bar. Three steps run in order: Embroider name and Sew in care label on Textiles, then Fold and wrap on Finishing, each with its instructions. Add step sits under them.",
  },
  /** The editor with Sew in care label selected: the Step panel beside the canvas, with Join the previous step since the task is alone in its step. Shape: window. */
  editing2: {
    file: "workflows/editing-2.png",
    kind: "merchant",
    aspectRatio: "1212/714",
    alt: "The same editor with Sew in care label selected, its card shaded and Add task under it. The Step panel beside the canvas shows Name, Team set to Textiles and Instructions, then Move earlier, Move later and Join the previous step, and Delete and Save at its foot.",
  },
  /** The Apply changes modal in the editor of an active workflow. Shape: editor modal. */
  editing3: {
    file: "workflows/editing-3.png",
    kind: "merchant",
    aspectRatio: "620/178",
    alt: "The modal that opens from Apply changes in the editor. Its heading is Apply changes?, and its sentence says the workflow is active, so the changes take effect now, and items already on it keep the tasks they started with. At the foot are Cancel and the Apply button.",
  },
  /** #1211, the Black gift set order that two workflows match: the sentence and the Workflow select, closed. Shape: page. */
  matching1: {
    file: "workflows/matching-1.png",
    kind: "merchant",
    aspectRatio: "1056/292",
    alt: "The order page for order 1211. Its one item, a journal and pen gift set in black, has a sentence saying more than one workflow matches this item, so none was started. Under it the Workflow select reads Choose workflow, with a greyed Attach button beside it. Order details shows it paid and unfulfilled.",
  },
  /** The Edit tag modal on Embroider and fold's page, the tag as it is. Shape: modal. */
  matching2: {
    file: "workflows/matching-2.png",
    kind: "merchant",
    aspectRatio: "620/250",
    alt: "The Edit tag modal. Its paragraph says to put this tag, in Shopify, on the products the workflow should build, and that products that still have the old tag stop matching until you retag them. The Tag field holds embroidered-blanket. At the foot are Cancel and a greyed Save, since nothing has changed.",
  },
  /** The Turn off workflow modal on Cut, engrave and oil's page. Shape: modal. */
  turningOnAndOff1: {
    file: "workflows/turning-on-and-off-1.png",
    kind: "merchant",
    aspectRatio: "620/158",
    alt: "The modal that opens from Turn off workflow on a workflow's page. Its heading is Turn off workflow?, and its sentence says new orders won't start this workflow and items already on it keep going. At the foot are Cancel and the Turn off button, which turns the workflow off.",
  },
  /** The page for Frame and glaze, the showcase's inactive workflow. Shape: page. */
  turningOnAndOff2: {
    file: "workflows/turning-on-and-off-2.png",
    kind: "merchant",
    aspectRatio: "1056/632",
    alt: "The workflow page for Frame and glaze, with an Inactive badge beside its name and Edit, More actions and Turn on workflow in the title bar. The Tag card says it starts when an order contains a product tagged photo-frame, with Edit tag. Two steps follow: Cut mat on Woodshop, then Glaze and fit on Finishing.",
  },
  /** The Duplicate workflow modal on Cut, engrave and oil's page, the Name and the Tag as they fill. Shape: modal. */
  managing1: {
    file: "workflows/managing-1.png",
    kind: "merchant",
    aspectRatio: "620/286",
    alt: "The Duplicate workflow modal. The Name field holds Cut, engrave and oil copy, and the Tag field holds the same words in lowercase with the comma dropped, with the line under it saying to put this tag, in Shopify, on the products the workflow should build. At the foot are Cancel and the Duplicate button.",
  },
  /** The Delete modal on Cut, engrave and oil's page. Shape: modal. */
  managing2: {
    file: "workflows/managing-2.png",
    kind: "merchant",
    aspectRatio: "620/158",
    alt: "The modal that opens from Delete under More actions on the page for Cut, engrave and oil. Its heading asks Delete Cut, engrave and oil?, and its two sentences say items already on it keep going and this can't be undone. At the foot are Cancel and a red Delete button.",
  },
  /** The Teams page with the showcase's eight teams in name order and their member counts: Weekend crew reads No members and 0. Shape: page. */
  creatingATeam1: {
    file: "teams-and-members/creating-a-team-1.png",
    kind: "merchant",
    aspectRatio: "1056/490",
    alt: "The Teams page with Create team in its title bar and a Search by name field. The table has the columns Team and Members and lists eight teams, from Engraving with 3 members to Woodshop with 2. Weekend crew has 0 members and a No members badge beside its name.",
  },
  /** Engraving's team page: ana, ben and carmen with Remove on each row, More actions and Add members in the title bar, the Details aside. Shape: page. */
  creatingATeam2: {
    file: "teams-and-members/creating-a-team-2.png",
    kind: "merchant",
    aspectRatio: "1056/355",
    alt: "The page for the team Engraving, with More actions and Add members in its title bar. The Members table lists ana@example.com, ben@example.com and carmen@example.com, each with a Remove button at the end of its row. Beside it, Details shows Members 3 and the date the team was created.",
  },
  /** The Members page with the showcase's seven members by email and how many teams each is on. Shape: page. */
  addingAMember1: {
    file: "teams-and-members/adding-a-member-1.png",
    kind: "merchant",
    aspectRatio: "1056/453",
    alt: "The Members page with Add member in its title bar and a Search by email field. The table has the columns Email and Teams and lists seven members, from ana@example.com to gus@example.com. Five are on 2 teams and two are on 1, so no row reads No teams.",
  },
  /** The Add member modal: the Email field empty, its line about signing in, Cancel and Add. Shape: modal. */
  addingAMember2: {
    file: "teams-and-members/adding-a-member-2.png",
    kind: "merchant",
    aspectRatio: "620/214",
    alt: "The Add member modal. Its one field is Email, marked required and empty, and under it the line reads They sign in with this email. No Shopify account needed. At the foot are Cancel and the Add button.",
  },
  /** The Add to teams modal on ana@example.com's page: the Search by name field and the six teams she is not on, none ticked, Add greyed. Shape: modal. */
  addingAMember3: {
    file: "teams-and-members/adding-a-member-3.png",
    kind: "merchant",
    aspectRatio: "620/358",
    alt: "The Add to teams modal on the page for ana@example.com. A Search by name field sits above a checkbox for each of the six teams she is not on: Jewelry, Leather, Packing, Textiles, Weekend crew and Woodshop, none ticked. At the foot are Cancel and the Add button, greyed.",
  },
  /** ana@example.com's member page: Engraving and Finishing with Remove on each row, Delete member and Add to teams in the title bar, the Details aside. Shape: page. */
  addingAMember4: {
    file: "teams-and-members/adding-a-member-4.png",
    kind: "merchant",
    aspectRatio: "1056/310",
    alt: "The page for the member ana@example.com, with Delete member and Add to teams in its title bar. The Teams table lists Engraving and Finishing, each with a Remove button at the end of its row. Beside it, Details shows her email and the date she was added.",
  },
  /** The Delete member modal on ana@example.com's page: the sentence names the email. Shape: modal. */
  removingAndDeleting1: {
    file: "teams-and-members/removing-and-deleting-1.png",
    kind: "merchant",
    aspectRatio: "620/158",
    alt: "The modal that opens from Delete member on the page for ana@example.com. Its heading asks Delete member?, and its sentence asks Delete ana@example.com? and says this can't be undone. At the foot are Cancel and a red Delete button.",
  },
  /** The Delete modal from More actions on Packing's page, its Delete enabled once the socket identified. Shape: modal. */
  removingAndDeleting2: {
    file: "teams-and-members/removing-and-deleting-2.png",
    kind: "merchant",
    aspectRatio: "620/158",
    alt: "The modal that opens from Delete under More actions on the page for the team Packing. Its heading asks Delete Packing?, and its one sentence says this can't be undone. At the foot are Cancel and a red Delete button.",
  },
  /** The Orders page as it opens on the showcase: Making chosen, its 24 orders on one page, no pager. Shape: page. */
  ordersList1: {
    file: "orders/orders-list-1.png",
    kind: "merchant",
    aspectRatio: "1056/1356",
    alt: "The Orders page with Sync open orders in the title bar. The strip counts No workflow, Not started, Making, Made and Issues, with Making chosen. Below it sit the Show select, the search field and the Team select. Each row shows the order number, date placed, Paid and Making badges, any issue, the item count and a Shopify icon.",
  },
  /** Order #1235: a started walnut board with a note, a done journal, a wall clock not started, and the Order note and Order details asides. Shape: page. */
  orderPage1: {
    file: "orders/order-page-1.png",
    kind: "merchant",
    aspectRatio: "1056/876",
    alt: "The page for order 1235, with Sync from Shopify and View in Shopify in the title bar. Three item cards, each with properties, Edit note and Manage: a walnut cutting board marked Making, with its step and a note, a leather journal marked Done, and a wall clock marked Not started. Order note and Order details sit beside them.",
  },
  /** #1235 with Manage open on the walnut board: the workflow's three steps and the drawer's buttons. Shape: page. */
  orderPage2: {
    file: "orders/order-page-2.png",
    kind: "merchant",
    aspectRatio: "1056/1365",
    alt: "The same order page with Manage open under the walnut cutting board. The drawer is headed Cut, engrave and oil workflow and lists each step: Cut and sand Done by ben@example.com, Engrave Started by ana@example.com with Done, Put back and Assign team, and Oil and inspect waiting. At its foot are Block, Cancel workflow and Change workflow.",
  },
  /** Order #1218, a gift card no workflow matches: the Workflow select at rest. Shape: page. */
  attachingAWorkflow1: {
    file: "orders/attaching-a-workflow-1.png",
    kind: "merchant",
    aspectRatio: "1056/266",
    alt: "The page for order 1218. Its one item, a $50 gift card, has no workflow and no badge. Under it the Workflow select reads Choose workflow, with a greyed Attach button beside it until a workflow is chosen. Order details shows the date placed, a Paid badge and Unfulfilled.",
  },
  /** The Change workflow modal on #1206 (Grandma Rose) with Clock assembly chosen, the warning shown. Shape: modal. */
  attachingAWorkflow2: {
    file: "orders/attaching-a-workflow-2.png",
    kind: "merchant",
    aspectRatio: "620/250",
    alt: "The modal that opens from Change workflow under Manage. Its heading asks Change workflow?, the Workflow select reads Clock assembly, and the sentence under it says Cut, engrave and oil has 1 of 3 steps done and that work will not carry over. At the foot are Cancel and a red Change workflow button.",
  },
  /** The Cancel workflow modal on #1206. Shape: modal. */
  attachingAWorkflow3: {
    file: "orders/attaching-a-workflow-3.png",
    kind: "merchant",
    aspectRatio: "620/204",
    alt: "The modal that opens from Cancel workflow under Manage. Its heading asks Cancel Cut, engrave and oil?, the line under it names the item, and the sentence says work on it stops, steps already done stay on record and another workflow can be attached afterwards. At the foot are Keep workflow and a red Cancel workflow button.",
  },
  /** The Orders page with Show set to Issues after Packing is deleted: eight Needs a team, two Blocked; Multiple workflows match is gone (the delete leaves Stamp and bind ineligible). Shape: page. */
  fixingIssues1: {
    file: "orders/fixing-issues-1.png",
    kind: "merchant",
    aspectRatio: "1056/730",
    alt: "The Orders page with Issues chosen on the strip and in the Show select. Each row's Issues cell carries a red badge: Needs a team on the eight leather journal orders whose Pack task lost its team, and Blocked on two orders. The Status column still reads Making or Not started.",
  },
  /** Order #1209: the Blocked badge, and the banner with ana@example.com's reason and Unblock. Shape: page. */
  fixingIssues2: {
    file: "orders/fixing-issues-2.png",
    kind: "merchant",
    aspectRatio: "1056/506",
    alt: "The page for order 1209. Its walnut cutting board carries a Making badge and a red Blocked badge. A red banner headed Blocked holds the reason, that the board has a crack along the grain and a new blank was asked for, then ana@example.com and when, and an Unblock button. The step line reads Step 2 of 3, Engrave.",
  },
  /** Order #1234 after Packing is deleted: the Pack task needs a team. Shape: page. */
  fixingIssues3: {
    file: "orders/fixing-issues-3.png",
    kind: "merchant",
    aspectRatio: "1056/438",
    alt: "The page for order 1234. Its black leather journal carries a Making badge and reads Step 4 of 4, Pack. Under Edit note a line says Pack: assign a team, with an Assign team select and a greyed Assign button until a team is chosen. There is no Needs a team badge on this page.",
  },
} as const satisfies Readonly<Record<string, HelpPicture>>;

export type HelpPictureName = keyof typeof HELP_PICTURES;

/** A picture's URL, as the page serves it. */
export const helpPictureSrc = (picture: HelpPicture) =>
  `${HELP_PICTURES_PATH}/${picture.file}`;
