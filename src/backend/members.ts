import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import type { Email } from "../contract/auth.ts";
import {
  MemberCeilingError,
  MemberNotFoundError,
  TeamLimitError,
  TeamNameTakenError,
  TeamNotFoundError,
} from "../contract/members.ts";
import { ShopKey } from "../contract/shop.ts";
import { membersAtCeiling } from "../domain/billing.ts";
import { Email as DomainEmail, ShopLimits } from "../domain/platform.ts";
import {
  Member,
  MemberAccess,
  MemberDetail,
  MemberId,
  MemberSummary,
  Team,
  TeamDetail,
  TeamId,
  TeamName,
  TeamSummary,
} from "../domain/shop-work.ts";
import { AuthDb } from "./resources.ts";

/**
 * Decodes stored rows. A row that does not decode is a broken invariant, not a failure a caller
 * handles, so it dies.
 */
const decodeRows =
  <S extends Schema.Top>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(Effect.orDie) as Effect.Effect<S["Type"]>;

const decodeMembers = decodeRows(Schema.Array(Member));
const decodeShops = decodeRows(Schema.Array(Schema.Struct({ shop: ShopKey })));
const decodeIds = decodeRows(Schema.Array(Schema.Struct({ id: Schema.String })));
const decodeEmails = decodeRows(Schema.Array(Schema.Struct({ email: DomainEmail })));
const decodeNames = decodeRows(Schema.Array(Schema.Struct({ name: Schema.String })));
const decodeCount = decodeRows(
  Schema.Tuple([Schema.Struct({ n: Schema.Number })]).pipe(
    Schema.decodeTo(
      Schema.Number,
      SchemaTransformation.transform({ decode: ([{ n }]) => n, encode: (n) => [{ n }] as const }),
    ),
  ),
);

/** The first cell of a `count(*)` read as values. */
const countOf = (rows: ReadonlyArray<ReadonlyArray<unknown>>) => Number(rows[0]?.[0] ?? 0);

/**
 * One page of a merchant table read from D1: the members index, the teams
 * index. Keyset on the column the table is ordered by, which is unique per
 * shop (a member's email, a team's name): `after` is the last value of the
 * page before, `null` for page one, read as `coalesce(after, '')` so the
 * cursor seeks (an `or` on it would scan, and an email or a name is never
 * empty). `q` is a search, matched anywhere in that column, ignoring case;
 * `null` is none.
 */
export interface PageInput<C> {
  readonly shop: ShopKey;
  readonly limit: number;
  readonly after: C | null;
  readonly q: string | null;
}

/**
 * What a {@link PageInput} reads: the rows, the cursor of the next page
 * (`null` on the last), and how many rows the search finds over every page
 * (`null` without a search).
 */
export interface Page<A, C> {
  readonly rows: ReadonlyArray<A>;
  readonly nextCursor: C | null;
  readonly matches: number | null;
}

/**
 * Splits a read of `limit + 1` rows into the page and its next cursor: the
 * extra row only says that another page exists, and the cursor is the last
 * row the page shows.
 */
const toPage = <A, C>(
  rows: ReadonlyArray<A>,
  limit: number,
  cursorOf: (row: A) => C,
): { readonly rows: ReadonlyArray<A>; readonly nextCursor: C | null } => {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    rows: shown,
    nextCursor: rows.length > limit && last !== undefined ? cursorOf(last) : null,
  };
};

/** A member addressed by shop and email, as the merchant and the gate address one. */
export interface MemberEmail {
  readonly shop: ShopKey;
  readonly email: Email;
}

/**
 * One shop's identity rows, as a fixture replaces them: its members, its teams and who is on
 * which, by the ids the caller minted.
 */
export interface ShopIdentity {
  readonly members: ReadonlyArray<{
    readonly id: string;
    readonly email: Email;
    readonly createdAt: number;
  }>;
  readonly teams: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly createdAt: number;
  }>;
  readonly teamMembers: ReadonlyArray<{
    readonly teamId: string;
    readonly memberId: string;
    readonly createdAt: number;
  }>;
}

/** One shop's member emails and team names, each unique in the shop. */
export interface ShopIdentityNames {
  readonly emails: ReadonlyArray<Email>;
  readonly teams: ReadonlyArray<string>;
}

/** The shop's `Member` and `Team` rows after a write. */
export interface ShopIdentityCounts {
  readonly members: number;
  readonly teams: number;
}

/** What `replaceShop` answers: the member ids it replaced, and the shop's rows after it. */
export interface ShopIdentityReplaced {
  readonly priorMemberIds: ReadonlyArray<string>;
  readonly members: number;
  readonly teams: number;
}

const make = <R>(database: SQL.D1DatabaseSource<never, R>) =>
  Effect.gen(function* () {
    const sql = yield* SQL.D1(database);

    /**
     * A deleted member has no row and so no shops: this is the sign-in gate, and a deleted
     * email gets the same no-link response a stranger does.
     */
    const listShopsOf = Effect.fn("Members.listShopsOf")(function* (email: Email) {
      const rows = yield* decodeShops(
        yield* sql`select shop from Member where email = ${email} order by shop`,
      );
      return rows.map((row) => row.shop);
    }, Effect.orDie);

    const findMember = Effect.fn("Members.findMember")(function* (member: MemberEmail) {
      const rows =
        yield* sql`select * from Member where shop = ${member.shop} and email = ${member.email}`;
      if (rows[0] === undefined) return Option.none<Member>();
      return Option.some(yield* decodeRows(Member)(rows[0]));
    }, Effect.orDie);

    /** Every shop's members, for the operator's admin page. */
    const list = Effect.fn("Members.list")(function* () {
      return yield* decodeMembers(
        yield* sql`select id, shop, email, createdAt from Member order by shop, email`,
      );
    }, Effect.orDie);

    /**
     * The members index's read; see {@link Page}. `teamCount` is a correlated subquery, as
     * `memberCount` is on {@link listTeamsPage}, so a member on no team still returns a row.
     */
    const listMembersPage = Effect.fn("Members.listMembersPage")(function* (
      params: PageInput<Email>,
    ) {
      const rows = yield* sql`
        select m.*, (select count(*) from TeamMember tm where tm.memberId = m.id) as teamCount
        from Member m
        where m.shop = ${params.shop}
          and m.email > coalesce(${params.after}, '')
          and (${params.q} is null or instr(m.email, lower(${params.q})) > 0)
        order by m.email
        limit ${params.limit + 1}
      `;
      const decoded = yield* decodeRows(Schema.Array(MemberSummary))(rows);
      const matches =
        params.q === null
          ? null
          : countOf(
              yield* sql`
                select count(*) from Member
                where shop = ${params.shop} and instr(email, lower(${params.q})) > 0
              `.values,
            );
      const page: Page<MemberSummary, Email> = {
        ...toPage(decoded, params.limit, (row) => row.email),
        matches,
      };
      return page;
    }, Effect.orDie);

    const countMembers = (shop: ShopKey) =>
      Effect.map(sql`select count(*) from Member where shop = ${shop}`.values, countOf);

    const countTeams = (shop: ShopKey) =>
      Effect.map(sql`select count(*) from Team where shop = ${shop}`.values, countOf);

    /**
     * Idempotent for the row, and the ceiling ({@link membersAtCeiling}) is applied to *new*
     * members only: adding an email already a member does not consult it, so a shop at or over
     * the ceiling (a lowered constant) can still re-run the same add without being told it is
     * full. Returns the row, new or existing. The id survives a repeat add; the row is re-read
     * after the insert, so a miss is this service's own invariant failure.
     *
     * Count-then-insert as two statements rather than one transaction: D1
     * has no interactive transactions (the driver rejects `withTransaction`),
     * and a batch cannot branch on the count. The race that leaves is two
     * merchants creating at the ceiling in the same instant and both winning —
     * one member over it, on a screen only the shop owner reaches, and billed
     * like any other seat. Buying that back would mean a `count` inside the
     * insert, which neither expresses "already a member is exempt" nor
     * reports which of the two conditions refused.
     */
    const addMember = Effect.fn("Members.addMember")(
      function* (member: MemberEmail) {
        const existing = yield* sql`
        select 1 from Member where shop = ${member.shop} and email = ${member.email}
      `;
        if (existing.length === 0 && membersAtCeiling(yield* countMembers(member.shop)))
          return yield* new MemberCeilingError({
            shop: member.shop,
            limit: ShopLimits.maxMembers,
          });
        const createdAt = yield* Clock.currentTimeMillis;
        yield* sql`
        insert into Member (id, shop, email, createdAt)
        values (${crypto.randomUUID()}, ${member.shop}, ${member.email}, ${createdAt})
        on conflict (shop, email) do nothing
      `;
        const rows =
          yield* sql`select * from Member where shop = ${member.shop} and email = ${member.email}`;
        return yield* decodeRows(Member)(rows[0]);
      },
      Effect.catchTag("SqlError", Effect.die),
    );

    /**
     * The merchant-facing delete: the row goes, `ShopSession` is untouched; what goes with it
     * is the member rows on `D1_TABLES`. Returns the deleted member's id, whose open sockets
     * the caller closes, so a socket carrying the old membership is closed rather than left
     * working until it next reconnects.
     *
     * Existing better-auth sessions are not revoked — the member-area guard
     * ({@link findMemberAccess}) rejects them on the next request. Run history is untouched:
     * the member row on `D1_TABLES` and the snapshot row on the actor's data model.
     */
    const deleteMember = Effect.fn("Members.deleteMember")(
      function* (member: MemberEmail) {
        const rows = yield* sql`
        delete from Member
        where shop = ${member.shop} and email = ${member.email}
        returning id
      `;
        const row = rows[0];
        if (row === undefined)
          return yield* new MemberNotFoundError({ shop: member.shop, member: member.email });
        return yield* decodeRows(MemberId)(row.id);
      },
      Effect.catchTag("SqlError", Effect.die),
    );

    /**
     * The mirror of {@link findTeamDetail}: one page of the member's teams
     * in name order, the count of every team they are on, and the shop's teams they are not
     * on.
     */
    const findMemberDetail = Effect.fn("Members.findMemberDetail")(function* (params: {
      readonly shop: ShopKey;
      readonly id: MemberId;
      readonly teamsAfter: TeamName | null;
      readonly limit: number;
    }) {
      const memberRows =
        yield* sql`select * from Member where id = ${params.id} and shop = ${params.shop}`;
      if (memberRows[0] === undefined) return Option.none<MemberDetail>();
      const teamRows = yield* sql`
        select t.id, t.name
        from TeamMember tm
        join Team t on t.id = tm.teamId
        where tm.memberId = ${params.id} and t.shop = ${params.shop}
          and t.name > coalesce(${params.teamsAfter}, '')
        order by t.name
        limit ${params.limit + 1}
      `;
      const countRows = yield* sql`
        select count(*) as teamCount
        from TeamMember tm join Team t on t.id = tm.teamId
        where tm.memberId = ${params.id} and t.shop = ${params.shop}
      `;
      const candidateRows = yield* sql`
        select t.id, t.name
        from Team t
        where t.shop = ${params.shop}
          and not exists (select 1 from TeamMember tm where tm.teamId = t.id and tm.memberId = ${params.id})
        order by t.name
      `;
      const decoded = yield* decodeRows(
        Schema.Struct({
          member: Member,
          teams: MemberDetail.fields.teams,
          teamCount: Schema.Number,
          candidates: MemberDetail.fields.candidates,
        }),
      )({
        member: memberRows[0],
        teams: teamRows,
        teamCount: countRows[0]?.teamCount,
        candidates: candidateRows,
      });
      const page = toPage(decoded.teams, params.limit, (row) => row.name);
      return Option.some({
        ...decoded,
        teams: page.rows,
        nextCursor: page.nextCursor,
      } satisfies MemberDetail);
    }, Effect.orDie);

    /**
     * The Add to teams dialog's write: one member onto several teams at once; the mirror of
     * {@link addTeamMembers}, one D1 batch for the same atomicity reasons. The member is
     * checked up front because `insert or ignore` cannot tell a missing member from an
     * already-present edge; a team id from another shop matches no source row and is dropped
     * by the join, which holds the cross-shop half of the team row on `D1_TABLES` from this
     * side.
     */
    const addMemberTeams = Effect.fn("Members.addMemberTeams")(
      function* (params: {
        readonly shop: ShopKey;
        readonly memberId: MemberId;
        readonly teamIds: ReadonlyArray<TeamId>;
      }) {
        const member =
          yield* sql`select 1 as present from Member where id = ${params.memberId} and shop = ${params.shop}`;
        if (member[0] === undefined)
          return yield* new MemberNotFoundError({ shop: params.shop, member: params.memberId });
        if (params.teamIds.length === 0) return;
        const createdAt = yield* Clock.currentTimeMillis;
        yield* sql.batch(
          params.teamIds.map(
            (teamId) => sql`
            insert or ignore into TeamMember (teamId, memberId, createdAt)
            select t.id, m.id, ${createdAt}
            from Team t join Member m on m.shop = t.shop
            where t.id = ${teamId} and m.id = ${params.memberId} and t.shop = ${params.shop}
          `,
          ),
        );
      },
      Effect.catchTag("SqlError", Effect.die),
    );

    /**
     * The teams index's read; see {@link Page}. `memberCount` is a correlated subquery rather
     * than a `group by` join so a team with no members still returns a row.
     */
    const listTeamsPage = Effect.fn("Members.listTeamsPage")(function* (
      params: PageInput<TeamName>,
    ) {
      const rows = yield* sql`
        select t.*, (select count(*) from TeamMember tm where tm.teamId = t.id) as memberCount
        from Team t
        where t.shop = ${params.shop}
          and t.name > coalesce(${params.after}, '')
          and (${params.q} is null or instr(lower(t.name), lower(${params.q})) > 0)
        order by t.name
        limit ${params.limit + 1}
      `;
      const decoded = yield* decodeRows(Schema.Array(TeamSummary))(rows);
      const matches =
        params.q === null
          ? null
          : countOf(
              yield* sql`
                select count(*) from Team
                where shop = ${params.shop} and instr(lower(name), lower(${params.q})) > 0
              `.values,
            );
      const page: Page<TeamSummary, TeamName> = {
        ...toPage(decoded, params.limit, (row) => row.name),
        matches,
      };
      return page;
    }, Effect.orDie);

    /**
     * `insert or ignore ... returning` is the whole conflict check: a fresh
     * uuid makes the name index the only reachable unique constraint, so zero
     * returned rows means exactly "that name is taken" — with no pre-check to
     * race against and no dependence on D1's constraint-violation message
     * text, which is untyped and version-specific. Foreign-key violations are
     * unaffected: SQLite treats `or ignore` as `abort` for those, so an
     * uninstalled shop still fails loudly.
     */
    const createTeam = Effect.fn("Members.createTeam")(
      function* (team: { readonly shop: ShopKey; readonly name: TeamName }) {
        // Same count-then-insert shape, and the same accepted race, as `addMember`; a team name
        // is unique per shop, so there is no "already exists" case to exempt.
        if ((yield* countTeams(team.shop)) >= ShopLimits.maxTeams)
          return yield* new TeamLimitError({ shop: team.shop, limit: ShopLimits.maxTeams });
        const createdAt = yield* Clock.currentTimeMillis;
        const rows = yield* sql`
        insert or ignore into Team (id, shop, name, createdAt)
        values (${crypto.randomUUID()}, ${team.shop}, ${team.name}, ${createdAt})
        returning id, shop, name, createdAt
      `;
        if (rows[0] === undefined)
          return yield* new TeamNameTakenError({ shop: team.shop, name: team.name });
        return yield* decodeRows(Team)(rows[0]);
      },
      Effect.catchTag("SqlError", Effect.die),
    );

    /**
     * `update or ignore` turns a name collision into zero returned rows
     * instead of a `SqlError`, which is what lets both failures share one
     * statement — but it makes "no rows" ambiguous between a missing team and
     * a taken name. The follow-up query disambiguates, and only runs on that
     * failure path.
     */
    const renameTeam = Effect.fn("Members.renameTeam")(
      function* (team: { readonly shop: ShopKey; readonly id: TeamId; readonly name: TeamName }) {
        const updated = yield* sql`
        update or ignore Team set name = ${team.name}
        where id = ${team.id} and shop = ${team.shop}
        returning id
      `;
        if (updated[0] !== undefined) return;
        const rows = yield* sql`
        select
          exists(select 1 from Team where shop = ${team.shop} and id = ${team.id}) as teamExists,
          exists(select 1 from Team where shop = ${team.shop} and name = ${team.name} and id <> ${team.id}) as nameTaken
      `;
        const { nameTaken } = yield* decodeRows(
          Schema.Struct({ teamExists: Schema.Number, nameTaken: Schema.Number }),
        )(rows[0]);
        return yield* nameTaken === 1
          ? new TeamNameTakenError({ shop: team.shop, name: team.name })
          : new TeamNotFoundError({ shop: team.shop, teamId: team.id });
      },
      Effect.catchTag("SqlError", Effect.die),
    );

    /**
     * The D1 half of a team delete, the team-delete row on `D1_TABLES`. Returns the members
     * who were on the team, whose open member sockets the actor then closes so they reconnect
     * without it.
     *
     * The team's members are read *before* the delete because `TeamMember` cascades
     * with the row: after the delete there is nothing left to say whose open
     * sockets were scoped to this team, and those connections carry the
     * team in a connect-time snapshot that the delete has just invalidated.
     */
    const deleteTeam = Effect.fn("Members.deleteTeam")(
      function* (team: { readonly shop: ShopKey; readonly id: TeamId }) {
        const memberRows = yield* sql`
        select memberId from TeamMember where teamId = ${team.id}
      `;
        const rows = yield* sql`
        delete from Team
        where id = ${team.id} and shop = ${team.shop}
        returning id
      `;
        if (rows[0] === undefined)
          return yield* new TeamNotFoundError({ shop: team.shop, teamId: team.id });
        return yield* decodeRows(Schema.Array(MemberId))(memberRows.map((row) => row.memberId));
      },
      Effect.catchTag("SqlError", Effect.die),
    );

    /**
     * One page of the team's members in email order, the count of every
     * member on it, and the shop's members who are not on it (the Add
     * members dialog's candidates). The member side is scoped through
     * `Member.shop`, so an edge to another shop's member never shows.
     */
    const findTeamDetail = Effect.fn("Members.findTeamDetail")(function* (params: {
      readonly shop: ShopKey;
      readonly id: TeamId;
      readonly membersAfter: Email | null;
      readonly limit: number;
    }) {
      const teamRows =
        yield* sql`select * from Team where id = ${params.id} and shop = ${params.shop}`;
      if (teamRows[0] === undefined) return Option.none<TeamDetail>();
      const memberRows = yield* sql`
        select m.*
        from TeamMember tm
        join Member m on m.id = tm.memberId
        where tm.teamId = ${params.id} and m.shop = ${params.shop}
          and m.email > coalesce(${params.membersAfter}, '')
        order by m.email
        limit ${params.limit + 1}
      `;
      const countRows = yield* sql`
        select count(*) as memberCount
        from TeamMember tm join Member m on m.id = tm.memberId
        where tm.teamId = ${params.id} and m.shop = ${params.shop}
      `;
      const candidateRows = yield* sql`
        select m.* from Member m
        where m.shop = ${params.shop}
          and not exists (select 1 from TeamMember tm where tm.memberId = m.id and tm.teamId = ${params.id})
        order by m.email
      `;
      const decoded = yield* decodeRows(
        Schema.Struct({
          team: Team,
          members: TeamDetail.fields.members,
          memberCount: Schema.Number,
          candidates: TeamDetail.fields.candidates,
        }),
      )({
        team: teamRows[0],
        members: memberRows,
        memberCount: countRows[0]?.memberCount,
        candidates: candidateRows,
      });
      const page = toPage(decoded.members, params.limit, (row) => row.email);
      return Option.some({
        ...decoded,
        members: page.rows,
        nextCursor: page.nextCursor,
      } satisfies TeamDetail);
    }, Effect.orDie);

    /**
     * The add is an insert-select, so the same-shop invariant is asserted by
     * the join rather than trusted from the caller: a forged
     * `(teamId, memberId)` pair spanning two shops matches no source row and
     * inserts nothing. This is what holds the cross-shop half of the team
     * row on `D1_TABLES`; the database does not.
     *
     * `on conflict do nothing` makes a repeat add a no-op, which also makes
     * "no rows returned" ambiguous with a genuine miss; the existence check
     * disambiguates, and only runs on that path. A miss is
     * `TeamNotFoundError` whichever side is absent: the pair is addressed
     * as one edge, and the member id came from this shop's own members.
     * Removal is unconditional and cannot fail.
     */
    const setTeamMember = Effect.fn("Members.setTeamMember")(
      function* (params: {
        readonly shop: ShopKey;
        readonly teamId: TeamId;
        readonly memberId: MemberId;
        readonly inTeam: boolean;
      }) {
        if (!params.inTeam) {
          yield* sql`
          delete from TeamMember
          where teamId = ${params.teamId}
            and memberId in (select id from Member where id = ${params.memberId} and shop = ${params.shop})
        `;
          return;
        }
        const createdAt = yield* Clock.currentTimeMillis;
        const inserted = yield* sql`
        insert into TeamMember (teamId, memberId, createdAt)
        select t.id, m.id, ${createdAt}
        from Team t join Member m on m.shop = t.shop
        where t.id = ${params.teamId} and t.shop = ${params.shop}
          and m.id = ${params.memberId}
        on conflict do nothing
        returning teamId
      `;
        if (inserted[0] !== undefined) return;
        const existing =
          yield* sql`select 1 as present from TeamMember where teamId = ${params.teamId} and memberId = ${params.memberId}`;
        if (existing[0] !== undefined) return;
        return yield* new TeamNotFoundError({ shop: params.shop, teamId: params.teamId });
      },
      Effect.catchTag("SqlError", Effect.die),
    );

    /**
     * The Add members dialog's write: several members onto one team at once. The batch form
     * of {@link setTeamMember} with `inTeam: true`, one D1
     * batch, not a `withTransaction`: D1 has no interactive transactions
     * (the driver rejects `withTransaction` outright), but `db.batch()` runs
     * its statements in order inside one implicit transaction and rolls all
     * of them back if any fails. Tagged-template statements are lazy, so the
     * array is built without `yield*` and handed over whole. The
     * team is checked up front (as {@link renameTeam} disambiguates) because
     * `insert or ignore` cannot tell a missing team from an already-present
     * edge; a member id from another shop matches no source row and is
     * dropped by the join.
     */
    const addTeamMembers = Effect.fn("Members.addTeamMembers")(
      function* (params: {
        readonly shop: ShopKey;
        readonly teamId: TeamId;
        readonly memberIds: ReadonlyArray<MemberId>;
      }) {
        const team =
          yield* sql`select 1 as present from Team where id = ${params.teamId} and shop = ${params.shop}`;
        if (team[0] === undefined)
          return yield* new TeamNotFoundError({ shop: params.shop, teamId: params.teamId });
        if (params.memberIds.length === 0) return;
        const createdAt = yield* Clock.currentTimeMillis;
        yield* sql.batch(
          params.memberIds.map(
            (memberId) => sql`
            insert or ignore into TeamMember (teamId, memberId, createdAt)
            select t.id, m.id, ${createdAt}
            from Team t join Member m on m.shop = t.shop
            where t.id = ${params.teamId} and m.id = ${memberId} and t.shop = ${params.shop}
          `,
          ),
        );
      },
      Effect.catchTag("SqlError", Effect.die),
    );

    /**
     * The gate's single query: membership and the teams it carries in one round trip. The
     * left joins are what make a teamless member decode to `teams: []` rather than to
     * `Option.none()` — no team is a normal state for a member, not a revoked grant. A
     * deleted member has no row and is `Option.none()`: the gate then refuses exactly as it
     * would a stranger.
     */
    const findMemberAccess = Effect.fn("Members.findMemberAccess")(function* (member: MemberEmail) {
      const rows = yield* sql`
        select m.id as memberId, t.id as teamId, t.name as teamName
        from Member m
        left join TeamMember tm on tm.memberId = m.id
        left join Team t on t.id = tm.teamId
        where m.shop = ${member.shop} and m.email = ${member.email}
        order by t.name
      `;
      if (rows[0] === undefined) return Option.none<MemberAccess>();
      const decoded = yield* decodeRows(
        Schema.NonEmptyArray(
          Schema.Struct({
            memberId: MemberId,
            teamId: Schema.NullOr(TeamId),
            teamName: Schema.NullOr(TeamName),
          }),
        ),
      )(rows);
      return Option.some(
        yield* decodeRows(MemberAccess)({
          shop: member.shop,
          memberId: decoded[0].memberId,
          teams: decoded.flatMap((row) =>
            row.teamId === null || row.teamName === null
              ? []
              : [{ id: row.teamId, name: row.teamName }],
          ),
        }),
      );
    }, Effect.orDie);

    /**
     * Replaces one shop's `Member`, `Team` and `TeamMember` rows with `rows`, in one D1 batch,
     * which is atomic: D1 has no transaction (`withTransaction` dies on it). Deleting the shop's
     * members and teams removes their `TeamMember` edges by cascade. Every insert is its own
     * statement, because a D1 statement binds at most 100 parameters. The batch reads the prior
     * member ids first and counts the shop's rows last, so the answer is what D1 holds, not the
     * input.
     */
    const replaceShop = Effect.fn("Members.replaceShop")(function* (
      shop: ShopKey,
      rows: ShopIdentity,
    ) {
      const results = yield* sql.batch([
        sql`select id from Member where shop = ${shop}`,
        sql`delete from Team where shop = ${shop}`,
        sql`delete from Member where shop = ${shop}`,
        ...rows.members.map(
          (member) =>
            sql`insert into Member (id, shop, email, createdAt) values (${member.id}, ${shop}, ${member.email}, ${member.createdAt})`,
        ),
        ...rows.teams.map(
          (team) =>
            sql`insert into Team (id, shop, name, createdAt) values (${team.id}, ${shop}, ${team.name}, ${team.createdAt})`,
        ),
        ...rows.teamMembers.map(
          (edge) =>
            sql`insert into TeamMember (teamId, memberId, createdAt) values (${edge.teamId}, ${edge.memberId}, ${edge.createdAt})`,
        ),
        sql`select count(*) as n from Member where shop = ${shop}`,
        sql`select count(*) as n from Team where shop = ${shop}`,
      ]);
      const replaced: ShopIdentityReplaced = {
        priorMemberIds: (yield* decodeIds(results[0])).map((row) => row.id),
        members: yield* decodeCount(results.at(-2)),
        teams: yield* decodeCount(results.at(-1)),
      };
      return replaced;
    }, Effect.orDie);

    const identityNames = Effect.fn("Members.identityNames")(function* (shop: ShopKey) {
      const [emails, teams] = yield* sql.batch([
        sql`select email from Member where shop = ${shop}`,
        sql`select name from Team where shop = ${shop}`,
      ]);
      const names: ShopIdentityNames = {
        emails: (yield* decodeEmails(emails)).map((row) => row.email),
        teams: (yield* decodeNames(teams)).map((row) => row.name),
      };
      return names;
    }, Effect.orDie);

    /**
     * Adds `rows` to one shop's `Member`, `Team` and `TeamMember` rows beside what is there:
     * the insert half of {@link replaceShop}, in one batch, counting the shop's rows last. The
     * unique (shop, email) and (shop, name) indexes fail the whole batch on a clash, so a
     * caller reads {@link identityNames} first and treats a clash here as a defect.
     */
    const addToShop = Effect.fn("Members.addToShop")(function* (shop: ShopKey, rows: ShopIdentity) {
      const results = yield* sql.batch([
        ...rows.members.map(
          (member) =>
            sql`insert into Member (id, shop, email, createdAt) values (${member.id}, ${shop}, ${member.email}, ${member.createdAt})`,
        ),
        ...rows.teams.map(
          (team) =>
            sql`insert into Team (id, shop, name, createdAt) values (${team.id}, ${shop}, ${team.name}, ${team.createdAt})`,
        ),
        ...rows.teamMembers.map(
          (edge) =>
            sql`insert into TeamMember (teamId, memberId, createdAt) values (${edge.teamId}, ${edge.memberId}, ${edge.createdAt})`,
        ),
        sql`select count(*) as n from Member where shop = ${shop}`,
        sql`select count(*) as n from Team where shop = ${shop}`,
      ]);
      const counts: ShopIdentityCounts = {
        members: yield* decodeCount(results.at(-2)),
        teams: yield* decodeCount(results.at(-1)),
      };
      return counts;
    }, Effect.orDie);

    return {
      listShopsOf,
      findMember,
      list,
      listMembersPage,
      addMember,
      deleteMember,
      findMemberDetail,
      addMemberTeams,
      listTeamsPage,
      createTeam,
      renameTeam,
      deleteTeam,
      findTeamDetail,
      setTeamMember,
      addTeamMembers,
      findMemberAccess,
      replaceShop,
      identityNames,
      addToShop,
    };
  });

/**
 * Baton's members and teams in D1: who belongs to which shop, the shop's teams and who is on
 * which. The layer is built once at Worker init (and in the shop's actor, which yields the
 * Backend's own instance); `SQL.D1` defers the actual client to the first query of each request
 * and tears it down with the request.
 *
 * Baton's rule: a membership edit is followed by closing the sockets of the members it changed,
 * so a socket opened under the old membership does not outlive it. `Members` holds no socket:
 * the shop's actor makes the merchant's edits and closes the sockets itself, and the fixture's
 * edits revoke through `ShopActors.revoke`.
 */
export class Members extends Context.Service<Members, Effect.Success<ReturnType<typeof make>>>()(
  "app/Members",
) {
  static readonly layer = Layer.effect(
    Members,
    Effect.flatMap(Cloudflare.D1.QueryDatabase(AuthDb), (d1) => make(d1)),
  );

  /** {@link Members} over a `D1Database` the caller holds, rather than the bound `AuthDb`. */
  static readonly layerWith = (database: D1Database) =>
    Layer.effect(Members, make(Effect.succeed(database)));
}
