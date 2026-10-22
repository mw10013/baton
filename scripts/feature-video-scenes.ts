/**
 * The listing's feature video: one scene per narration line, in take order, filmed on the dev
 * fixture and cropped to the app pane. It follows one product, the engraved cutting board: its
 * workflow, an order with a board in progress, a blocked board, and a board finished to Made.
 * Copy rules: plain words, the screen's own labels, no semicolons, no claims about results.
 *
 * @module
 */
import type { Card, Scene } from "./lib/screencast.ts";

/** The brand line, word for word on the opening and closing cards and the thumbnail. */
export const BRAND_CARD: Card = {
  _tag: "Title",
  title: "Baton",
  line: "Made-to-order production workflows",
};

/** The member screens the members card shows, from the help's pictures. */
const MEMBER_PHONES: Card = {
  _tag: "Phones",
  files: [
    "members/finding-your-work-1.png",
    "members/recording-your-work-1.png",
    "members/blocking-2.png",
  ],
};

const WORKFLOW = "Cut, engrave and oil";
/** Three items at different steps, the board on Step 2 of 3, and an order note. */
const MIXED_ORDER = "#1235";
/** A board blocked by a member, with the reason. */
const BLOCKED_ORDER = "#1209";
/** One board on its last step, Oil and inspect, started: Done makes the order Made. */
const LAST_STEP_ORDER = "#1242";

export const FEATURE_SCENES: ReadonlyArray<Scene> = [
  {
    id: "intro",
    card: BRAND_CARD,
    say: "Made-to-order shops make each item by hand. Baton keeps track of who is making what, and what comes next.",
    act: async () => {},
  },
  {
    id: "orders",
    say: "Every paid order shows up in Baton with its production status. Not started, Making, Made, and the ones with issues.",
    act: async ({ nav, point, press }) => {
      await nav("Orders");
      await point("Not started");
      await point("Made");
      await press("Making");
    },
  },
  {
    id: "workflow",
    say: "You describe how a product is made once, as a workflow. Each step has tasks for your teams, with the instructions they need.",
    act: async ({ nav, press, see }) => {
      await nav("Workflows");
      await press(WORKFLOW);
      await see("Oil and inspect");
    },
  },
  {
    id: "tag",
    say: "Give the workflow a tag, and put the same tag on your products. A paid order for those products starts the workflow.",
    act: async ({ point }) => {
      await point("Starts when an order contains a product tagged");
    },
  },
  {
    id: "order",
    say: "Open an order to see where each item is. The step it is on, the details the customer chose, and the notes for your team.",
    act: async ({ nav, press, see }) => {
      await nav("Orders");
      await press(MIXED_ORDER);
      await see("Step 2 of 3");
    },
  },
  {
    id: "members",
    card: MEMBER_PHONES,
    say: "Members sign in from a phone or tablet with a link sent to their email. They see their team's tasks, and press Start and Done. When work can't go on, they press Block and say why.",
    act: async () => {},
  },
  {
    id: "issues",
    say: "A blocked item shows up under Issues, with the reason, so you see the problem right away.",
    act: async ({ nav, press, see }) => {
      await nav("Orders");
      await press("Issues");
      await press(BLOCKED_ORDER);
      await see("The board has a crack along the grain");
    },
  },
  {
    id: "made",
    say: "When the last step is done, the order moves to Made.",
    act: async ({ nav, press, see }) => {
      await nav("Orders");
      await press("Making");
      await press(LAST_STEP_ORDER);
      await press("Manage");
      await press("Done");
      await nav("Orders");
      await press("Made");
      await see(LAST_STEP_ORDER);
    },
  },
  {
    id: "outro",
    card: BRAND_CARD,
    say: "Baton. Made-to-order production workflows, in your Shopify admin.",
    act: async () => {},
  },
];
