/**
 * The data model of D1, the store every shop shares, as rules. The same
 * spec as {@link initializeSchema} in `ShopAgentSchema.ts`, with the same
 * columns, vocabulary and test convention: the table says what is true of
 * the data, never which index makes it true, and `migrations/0001_init.sql`
 * conforms to it. `pnpm spec check` parses it and refuses a title no test
 * carries and a row pinned by "(none yet)"; a structural change starts at
 * the row, then the migration and the write paths, then the pinned test.
 *
 * D1 is where identity lives: shops, members ({@link Domain.Member}), teams
 * ({@link Domain.Team}) and sign-in. Work lives in each shop's Durable
 * Object, which points into D1 by id and never the other way. No foreign key
 * crosses the two stores, so a cross-store rule has a half on each side: the
 * object's table says what a dangling pointer means ("points to a D1 row;
 * dangling reads as null"); this table says what a delete here does and in
 * what order ("deletes here first, then nulls every object pointer"),
 * because D1 is where the delete starts. The two sentences link to each
 * other and neither restates the other.
 *
 * The value is the app-owned tables, which one test checks against
 * `sqlite_master` after the migrations run, so a migration that adds a
 * table nobody wrote a row for fails. Better-auth's tables are
 * {@link BETTER_AUTH_TABLES}.
 *
 * | about     | rule                                                                                                                                                                                                 | holds by   | pinned by                                                                                                                                                                   |
 * | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | shop      | a shop is identified by its domain and has exactly one object; the object id is set once and never rewritten; a renamed domain is a new shop, and the old row and object are removed by hand         | schema+app | a shop is identified by its domain and has exactly one object                                                                                                               |
 * | shop      | uninstall deletes the shop row, its members and teams go with it, and destroys the object whole; a reinstall is a new shop with nothing; `shop/redact` does nothing more                             | schema+app | uninstall deletes the shop row, its members and teams, and destroys the object                                                                                              |
 * | shop      | the merchant is the admin session, not a member; a member row never stands for the merchant, and run history records a merchant act with the role and no email                                       | app        | a merchant act is recorded on the task with the role and no email, and no member row stands for the merchant                                                                |
 * | shop      | the plan cache is stored, never derived; only revalidation writes it and re-authentication never touches it                                                                                          | app        | updateShopSessionPlan rewrites only the plan cache fields                                                                                                                   |
 * | shop      | every installed shop re-reads its plan at least once a day, whether or not anyone opens the app                                                                                                      | app        | the daily check re-reads every shop whose cached plan is stale, and only those                                                                                              |
 * | member    | a member is identified by shop and email; the email is stored lowercase and trimmed                                                                                                                  | schema     | a member is identified by shop and email; the email is stored lowercase and trimmed                                                                                         |
 * | member    | a member has exactly one shop and goes with it                                                                                                                                                       | schema     | deleteShopSession cascades that shop's members only                                                                                                                         |
 * | member    | a member is on zero or more teams; delete a member and they leave their teams; nothing else structural points at a member                                                                            | schema     | delete a member and they leave their teams; nothing else structural points at a member                                                                                      |
 * | member    | no history: re-adding a deleted email mints a new id; run history keeps the old email as a snapshot in the object                                                                                    | app        | addMember after deleteMember mints a new id                                                                                                                                 |
 * | member    | a member's access is the row: no role, no state; a merchant pauses nobody, only removes them; sign-in identity is the email                                                                          | app        | findMemberAccess is none for a deleted member                                                                                                                               |
 * | member    | a member is matched to a signed-in user by email at sign-in and at no other time; nothing points from a member to a user or back; a member's email never changes, so a change is a delete and an add | app        | a member is matched to a user by email at sign-in and nothing points between them                                                                                           |
 * | team      | a team is identified by its name within a shop, compared exactly; the name is trimmed and non-empty                                                                                                  | schema     | a team is identified by its name within a shop, compared exactly; the name is trimmed and non-empty                                                                         |
 * | team      | a team has exactly one shop and goes with it                                                                                                                                                         | schema     | deleteShopSession cascades that shop's teams                                                                                                                                |
 * | team      | a team has zero or more members; a membership is one row per team and member, no history; a team never crosses shops                                                                                 | schema+app | setTeamMember refuses cross-shop pairs                                                                                                                                      |
 * | team      | a team delete goes to D1 first, then nulls every object pointer; the next team delete for the shop nulls pointers to any team that is gone                                                           | app        | deleteTeam nulls every task pointer, D1 first; a dangling id reads as unassigned and a retry repairs it; the next team delete nulls pointers to a team that is already gone |
 * | `User`    | better-auth's tables are better-auth's: a session and an account go with their user; a role is one of a closed set                                                                                   | schema     | hand-written migration matches better-auth's runtime expectations                                                                                                           |
 * | `Session` | expired sessions and verifications are swept on the sign-in path, never read                                                                                                                         | app        | sweeps expired Session and Verification rows on the way out                                                                                                                 |
 *
 * "A shop has exactly one object" is `schema+app`: the database refuses a
 * second shop with the same object id, but "set once and never rewritten"
 * is `upsertShopSession` leaving the object id out of its update.
 *
 * "A team never crosses shops" is `schema+app`, not `schema`: an edge
 * points at a `Member.id` and a `Team.id` that each belong to one shop, but
 * nothing in the database compares the two shops, so a raw cross-shop edge
 * inserts; `setTeamMember` and `setMemberTeams` scope both sides through
 * the shop. A trigger would make it `schema` and is not worth a migration
 * at the current member count.
 *
 * The uninstall webhook is the one teardown point: a destroy that fails is
 * retried by Shopify's webhook retries, and past those is cleaned up by hand
 * from the orphan page.
 *
 * The other half of each cross-store row is on {@link initializeSchema}.
 */
export const D1_TABLES = [
  "ShopSession",
  "Member",
  "Team",
  "TeamMember",
] as const;
export type D1Table = (typeof D1_TABLES)[number];

/** Better-auth's tables, owned by better-auth; the drift test in `auth.test.ts` pins their shape. */
export const BETTER_AUTH_TABLES = [
  "UserRole",
  "User",
  "Session",
  "Account",
  "Verification",
] as const;
