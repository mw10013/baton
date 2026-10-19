/**
 * The e2e store's data: the shop key of this checkout's e2e store, the small fixture e2e setup
 * loads into it once, and the addresses a spec adds beside it.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { Email } from "../../src/contract/auth.ts";
import type { ShopFixtureData } from "../../src/contract/fixture.ts";
import { ShopKey } from "../../src/domain/platform.ts";
import { TeamName } from "../../src/domain/shop-work.ts";

/** This checkout's e2e store (`SHOPIFY_E2E_STORE`, which the config loads from `.env`). */
export const E2E_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)(
  `${Schema.decodeUnknownSync(Schema.NonEmptyString)(process.env.SHOPIFY_E2E_STORE)}.myshopify.com`,
);

const email = Schema.decodeUnknownSync(Email);

/** A team name a spec adds; one past {@link TeamName}'s cap throws here, before the fixture refuses it. */
export const teamName = Schema.decodeUnknownSync(TeamName);

/** The fixture's member the specs sign in as; on team `ops`. */
export const MEMBER = email("m1@m.com");

/**
 * What e2e setup loads into {@link E2E_SHOP}, replacing whatever a reused server's last run left:
 * members `m1@m.com` and `m2@m.com`, and team `ops` holding `m1@m.com`. Specs assert on these
 * names, so it is its own data, not the dev fixture.
 */
export const e2eFixture: ShopFixtureData = {
  members: [MEMBER, email("m2@m.com")],
  teams: [{ name: teamName("ops"), members: [MEMBER] }],
  workflows: [],
  orders: [],
};

/** An address a spec adds, so it never collides with a fixture member. */
export const E2eEmail = Email.check(
  Schema.isPattern(/@e2e\.test$/u, { message: "Test members use an @e2e.test address." }),
);
export type E2eEmail = typeof E2eEmail.Type;
