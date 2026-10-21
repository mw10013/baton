/**
 * The review screencast's starting state: an empty Baton, as a reviewer's store has after
 * install, and one product in the store. The take builds the team, the member and the workflow on
 * camera, so none are here.
 *
 * The product already carries the workflow's tag: tagging a product is a Shopify step the
 * reviewer knows, and the take does not film Shopify. The store's open fixture orders stay open
 * in Shopify; Baton never sees them, since the take does not press Sync open orders.
 *
 * Decoded through {@link ShopFixture} at module load, like the dev fixture.
 *
 * @module
 */
import * as Schema from "effect/Schema";

import { fixture } from "./fixture.ts";
import { ShopFixture, type StoreOrder } from "./src/contract/fixture.ts";
import { suggestedTag } from "./src/web/components/workflow-shared.ts";

/** The workflow name the take types into Create workflow. */
export const SCREENCAST_WORKFLOW = "Cutting board";

/**
 * The workflow's tag: the one Create workflow suggests from {@link SCREENCAST_WORKFLOW}, so the
 * take accepts the suggestion as it is.
 */
export const SCREENCAST_TAG = suggestedTag(SCREENCAST_WORKFLOW);

const board = fixture.products.find(({ handle }) => handle === "engraved-cutting-board");
if (board === undefined) throw new Error("the dev fixture has no engraved-cutting-board");

export const screencastFixture: ShopFixture = Schema.decodeUnknownSync(ShopFixture)({
  products: [{ ...board, tags: [SCREENCAST_TAG] }],
  storeOrders: [],
  members: [],
  teams: [],
  workflows: [],
  orders: [],
});

/** The paid order the take places off camera, while Baton's Orders page is on screen. */
export const SCREENCAST_ORDER: StoreOrder = {
  tag: "screencast",
  lines: [{ handle: board.handle, value: "Maple", quantity: 1, properties: {} }],
};
