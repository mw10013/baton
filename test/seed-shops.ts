/**
 * The fake shops of `seed/test.sql`, which the integration tests run against. They are
 * placeholders, not real stores, and exist only on the `test` environment; e2e runs on the real
 * e2e store.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { ShopGid, ShopKey } from "../src/domain/platform.ts";

/** `m1@m.com` and `m2@m.com` are its members, and team `ops` holds `m1@m.com`. */
export const SEED_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)("seed-shop.myshopify.com");

/** {@link SEED_SHOP}'s Admin API id, as its seeded `ShopSession` row holds it. */
export const SEED_SHOP_GID: ShopGid = Schema.decodeUnknownSync(ShopGid)("gid://shopify/Shop/1");

/** `m1@m.com` is its one member. */
export const OTHER_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
