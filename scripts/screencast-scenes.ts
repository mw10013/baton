/**
 * The review screencast's script: one scene per narration line, in take order. The take starts
 * from `screencastFixture`, an empty Baton, and builds one team, one member and one workflow
 * on camera, then moves one order to Made from the order page. Copy rules: plain words, the
 * glossary's terms, no semicolons.
 *
 * @module
 */
import { SCREENCAST_TAG, SCREENCAST_WORKFLOW } from "../screencast-fixture.ts";
import type { Scene } from "./lib/screencast.ts";

const TEAM = "Woodshop";
const MEMBER = "ana@example.com";
const FIRST_STEP = "Cut and sand";
const SECOND_STEP = "Oil and pack";

export const SCENES: ReadonlyArray<Scene> = [
  {
    id: "intro",
    chapter: { title: "Baton", description: "Testing the merchant flow" },
    say: "This video walks through Baton, which tracks made-to-order work through the steps of a workflow. Baton runs only in the Shopify admin. It has no storefront part, so there is no customer flow to test.",
    act: async () => {},
  },
  {
    id: "home",
    say: "We start on Baton's home page, just after install. The shop has no teams, workflows or orders yet.",
    step: "In the Shopify admin, open Baton from Apps. The home page opens.",
    act: async () => {},
  },
  {
    id: "team",
    chapter: { title: "Team and member" },
    say: `First, create a team. Choose Teams, press Create team, name it ${TEAM}, and press Create.`,
    step: `Choose Teams. Press Create team, enter the name ${TEAM}, and press Create. The ${TEAM} page opens.`,
    act: async ({ nav, press, fill, see }) => {
      await nav("Teams");
      await press("Create team");
      await fill("Name", TEAM);
      await press("Create");
      await see(TEAM);
    },
  },
  {
    id: "member",
    say: "Next, add a member. Choose Members, press Add member, enter their email, and press Add. Baton sends no email.",
    step: `Choose Members. Press Add member, enter ${MEMBER}, and press Add. The member's page opens.`,
    act: async ({ nav, press, fill, see }) => {
      await nav("Members");
      await press("Add member");
      await fill("Email", MEMBER);
      await press("Add");
      await see(MEMBER);
    },
  },
  {
    id: "member-team",
    say: `Then put the member on the team. Open ${TEAM}, press Add members, tick their email, and press Add.`,
    step: `Choose Teams, then ${TEAM}. Press Add members, tick ${MEMBER}, and press Add. ${TEAM} lists the member.`,
    act: async ({ nav, press, tick, see }) => {
      await nav("Teams");
      await press(TEAM);
      await press("Add members");
      await tick(MEMBER);
      await press("Add");
      await see(MEMBER);
    },
  },
  {
    id: "workflow",
    chapter: { title: "Workflow and tag" },
    say: `Now create a workflow. Choose Workflows, press Create workflow, and name it ${SCREENCAST_WORKFLOW}. The tag fills in from the name. Press Create, and the editor opens.`,
    step: `Choose Workflows. Press Create workflow, enter the name ${SCREENCAST_WORKFLOW}, keep the tag "${SCREENCAST_TAG}", and press Create. The editor opens.`,
    act: async ({ nav, press, fill }) => {
      await nav("Workflows");
      await press("Create workflow");
      await fill("Name", SCREENCAST_WORKFLOW);
      await press("Create");
    },
  },
  {
    id: "first-step",
    say: `Add the first step. Name it ${FIRST_STEP}, choose the ${TEAM} team, and press Add step.`,
    step: `Press Add step. Enter ${FIRST_STEP}, choose ${TEAM}, and press Add step.`,
    act: async ({ press, fill, choose, see }) => {
      await press("Add step");
      await fill("Name", FIRST_STEP);
      await choose("Team", TEAM);
      await press("Add step");
      await see(FIRST_STEP);
    },
  },
  {
    id: "second-step",
    say: `Add a second step, ${SECOND_STEP}, also for ${TEAM}. Steps are done in order.`,
    step: `Press Add step again. Enter ${SECOND_STEP}, choose ${TEAM}, and press Add step.`,
    act: async ({ press, fill, choose, see }) => {
      await press("Add step");
      await fill("Name", SECOND_STEP);
      await choose("Team", TEAM);
      await press("Add step");
      await see(SECOND_STEP);
    },
  },
  {
    id: "turn-on",
    say: `Press Turn on workflow, then Turn on, and close the editor. The workflow is now active. It starts on every paid order with a product tagged ${SCREENCAST_TAG}.`,
    step: "Press Turn on workflow, then Turn on. Close the editor. The workflow reads Active.",
    act: async ({ press, see, closeWindow }) => {
      await press("Turn on workflow");
      await press("Turn on");
      await closeWindow();
      await see("Active");
    },
  },
  {
    id: "shopify",
    chapter: { title: "An order arrives" },
    say: `Now, in Shopify, put the tag ${SCREENCAST_TAG} on a product. Then create an order for that product and mark it as paid.`,
    step: `In Shopify, add the tag "${SCREENCAST_TAG}" to a product. Create an order for that product and mark it as paid.`,
    act: async () => {},
  },
  {
    id: "order-arrives",
    say: "Back in Baton, choose Orders, then press Not started. The new order shows up within a few seconds.",
    step: "In Baton, choose Orders and press Not started. The order is listed as Not started.",
    act: async ({ nav, press, placeOrder, see }) => {
      await nav("Orders");
      // An empty Baton shows no status strip: the order's arrival brings it, then Not started.
      const order = await placeOrder();
      await press("Not started");
      await see(order);
    },
  },
  {
    id: "open-order",
    chapter: { title: "Moving the order to Made" },
    say: `Open the order. The item is on step one of two, ${FIRST_STEP}.`,
    step: `Open the order. The item reads Step 1 of 2, ${FIRST_STEP}.`,
    act: async ({ openOrder, see }) => {
      await openOrder();
      await see("Step 1 of 2");
    },
  },
  {
    id: "members-note",
    say: "Members sign in with a link sent to their email, and press Start and Done on their own tasks. The merchant can do the same from the order page.",
    act: async () => {},
  },
  {
    id: "first-done",
    say: `Press Manage, then Done on ${FIRST_STEP}. The item moves to step two, ${SECOND_STEP}.`,
    step: `Press Manage, then Done on ${FIRST_STEP}. The item reads Step 2 of 2.`,
    act: async ({ press, see }) => {
      await press("Manage");
      await press("Done");
      await see("Step 2 of 2");
    },
  },
  {
    id: "second-done",
    say: `Press Done on ${SECOND_STEP}. The page now says every item is done.`,
    step: `Press Done on ${SECOND_STEP}. The page says every item is done.`,
    act: async ({ press, see }) => {
      await press("Done");
      await see("Every item is done");
    },
  },
  {
    id: "outro",
    say: "Back on Orders, press Made, and the order is listed as Made. That is the whole flow: a team, a member, a workflow with its tag, and an order moved to Made.",
    step: "Choose Orders and press Made. The order is listed as Made.",
    act: async ({ nav, press, see, placedOrder }) => {
      await nav("Orders");
      await press("Made");
      await see(placedOrder());
    },
  },
];
