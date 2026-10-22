/**
 * The App Store listing's screenshots: what each shows and its alt text, in upload order.
 * `vp run help:screenshots --listing` shoots them into {@link LISTING_DIR}; the listing form
 * takes them by hand. Desktop shots are the app pane at 1600 × 900, mobile shots the member site
 * at 900 × 1600.
 *
 * @module
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Where the shots go: uploaded by hand, never served, so not under `public/`. */
export const LISTING_DIR = resolve(REPO_ROOT, "tmp/listing");

/** The listing form's limit on a screenshot's alt text. */
export const ALT_LIMIT = 64;

/** The listing form's sizes. */
export const DESKTOP = { width: 1600, height: 900 } as const;
export const MOBILE = { width: 900, height: 1600 } as const;

/**
 * The phone a mobile shot is taken on: 9:16, as the form's size is, and a real phone's (an
 * iPhone 8 Plus), at its own 3x.
 */
export const MOBILE_SCREEN = { width: 414, height: 736, scale: 3 } as const;

export type ListingShotId =
  | "orders"
  | "orderPage"
  | "workflowPage"
  | "workflows"
  | "orderSteps"
  | "issues"
  | "memberList"
  | "memberTask"
  | "memberBlocked";

export interface ListingShot {
  readonly id: ListingShotId;
  readonly kind: "desktop" | "mobile";
  readonly file: string;
  /** In the screen's words, at most {@link ALT_LIMIT} characters. */
  readonly alt: string;
}

export const LISTING_SHOTS: ReadonlyArray<ListingShot> = [
  {
    id: "orders",
    kind: "desktop",
    file: "desktop-1-orders.png",
    alt: "Orders list with counts for Not started, Making and Made",
  },
  {
    id: "orderPage",
    kind: "desktop",
    file: "desktop-2-order-page.png",
    alt: "Order page showing each item's step, details and notes",
  },
  {
    id: "workflowPage",
    kind: "desktop",
    file: "desktop-3-workflow.png",
    alt: "Workflow with its product tag and steps assigned to teams",
  },
  {
    id: "workflows",
    kind: "desktop",
    file: "desktop-4-workflows.png",
    alt: "Workflows list with the product tag each one matches",
  },
  {
    id: "orderSteps",
    kind: "desktop",
    file: "desktop-5-order-steps.png",
    alt: "An item's workflow steps with who did each and when",
  },
  {
    id: "issues",
    kind: "desktop",
    file: "desktop-6-issues.png",
    alt: "Orders with blocked items listed under Issues",
  },
  {
    id: "memberList",
    kind: "mobile",
    file: "mobile-1-workflows.png",
    alt: "A member's tasks on a phone, by order, step and team",
  },
  {
    id: "memberTask",
    kind: "mobile",
    file: "mobile-2-task.png",
    alt: "A task on a phone with its instructions and Start and Done",
  },
  {
    id: "memberBlocked",
    kind: "mobile",
    file: "mobile-3-blocked.png",
    alt: "A blocked item on a phone, with the member's reason",
  },
];

/** The alt text file the run writes beside the shots: one `file: alt` line each. */
export const altText = (shots: ReadonlyArray<ListingShot>) =>
  `${shots.map(({ file, alt }) => `${file}: ${alt}`).join("\n")}\n`;
