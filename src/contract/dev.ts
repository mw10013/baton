/**
 * The dev door: what a developer's script and the tests may do to a stage that a product user
 * may not. Anything named `Dev*` or served under `/api/dev` is dev and test machinery, and
 * nothing else is.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";
import { Email } from "./auth.ts";
import { FixtureConflict, FixtureCounts, ShopFixtureData, ShopNotInstalled } from "./fixture.ts";
import { ShopKey } from "../domain/platform.ts";

/**
 * The part of a stored Shopify session a caller may read. It has no field for the access or the
 * refresh token, so no handler can return one.
 */
export const ShopSessionView = Schema.Struct({
  shopGid: Schema.String,
  scope: Schema.NullOr(Schema.String),
  accessTokenExpiresAt: Schema.NullOr(Schema.Number),
  refreshTokenExpiresAt: Schema.NullOr(Schema.Number),
  refreshLeaseUntil: Schema.NullOr(Schema.Number),
});
export type ShopSessionView = typeof ShopSessionView.Type;

/**
 * The dev procedures. The Backend serves them on `/api/dev` only with the `DEV_ENDPOINT`
 * binding, which the stack binds on `dev`, `test` and `e2e` and never on a deployed stage;
 * without it the path is 404, the answer for an unknown path.
 *
 * - `LoadFixture` replaces one installed shop's members, teams, workflows and orders with
 *   `fixture`'s, and touches nothing else: not the shop's session, not another shop, not Better
 *   Auth. It is for setup: `vp run fixture`, `db:reset`, and e2e setup, once.
 * - `AddToFixture` adds `fixture`'s rows to an installed shop beside what is there, and revokes
 *   nothing. It fails with {@link FixtureConflict}, writing nothing, when a member email, team
 *   name, workflow name, workflow tag or order number is already in the shop. Payload references
 *   resolve within the payload, so a team is added only with its own members.
 *
 *   It is how e2e stays parallel on one shared shop: e2e setup loads the fixture once; a spec
 *   adds its own data, under names derived from its test id, and asserts only on that data; no
 *   spec replaces the fixture or asserts on every row.
 * - `RemoveMember` removes a member, then revokes the member's sockets on that shop's actor and
 *   answers how many it closed.
 * - `RemoveOrder` deletes one stored order (by its GID) with its items from an installed shop's
 *   actor, and answers whether there was one. It is how an e2e spec takes a real order off the
 *   orders screen so that only a sync can bring it back.
 * - `GetShopSession` reads a shop's stored session as {@link ShopSessionView}, or null when the
 *   shop has none.
 * - `ExpireShopSession` ages a shop's stored session: the access token expires a second ago, so
 *   the next Admin call refreshes it. `invalidate` also replaces the refresh token with one
 *   Shopify will reject, which kills the session until an exchange.
 */
export const DevRpcs = RpcGroup.make(
  Rpc.make("LoadFixture", {
    payload: { shop: ShopKey, fixture: ShopFixtureData },
    success: FixtureCounts,
    error: ShopNotInstalled,
  }),
  Rpc.make("AddToFixture", {
    payload: { shop: ShopKey, fixture: ShopFixtureData },
    success: FixtureCounts,
    error: Schema.Union([ShopNotInstalled, FixtureConflict]),
  }),
  Rpc.make("RemoveMember", {
    payload: { shop: ShopKey, email: Email },
    success: Schema.Struct({ removed: Schema.Boolean, closed: Schema.Int }),
  }),
  Rpc.make("RemoveOrder", {
    payload: { shop: ShopKey, orderId: Schema.NonEmptyString },
    success: Schema.Struct({ removed: Schema.Boolean }),
    error: ShopNotInstalled,
  }),
  Rpc.make("GetShopSession", {
    payload: { shop: ShopKey },
    success: Schema.NullOr(ShopSessionView),
  }),
  Rpc.make("ExpireShopSession", {
    payload: { shop: ShopKey, refreshToken: Schema.Literals(["keep", "invalidate"]) },
    success: Schema.Struct({}),
  }),
);
