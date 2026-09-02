import type { SqlError } from "effect/unstable/sql";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";

import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";

/**
 * Failure to map stored rows into domain types — i.e. a `Schema` decode error,
 * the repository's own invariant ("storage gave me bytes I can't turn into a
 * valid domain object"). Signals data corruption or schema drift: a
 * never-retryable, should-never-happen condition.
 *
 * Deliberately distinct from `SqlError.SqlError`, which surfaces raw: query
 * execution is the driver's concern (structured, possibly transient/retryable),
 * whereas storage→domain decoding is this repository's concern, so it gets a
 * named, greppable error. The `cause` carries the underlying decode failure.
 */
export class RepositoryError extends Schema.TaggedError<RepositoryError>()(
  "RepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * The shop already has a team by that name, case-insensitively. Detected by the
 * write returning no row under `or ignore` rather than by matching D1's
 * constraint-violation text, which is neither typed nor stable.
 */
export class TeamNameTakenError extends Schema.TaggedError<TeamNameTakenError>()(
  "TeamNameTakenError",
  { shop: Domain.Shop, name: Domain.TeamName },
) {}

/**
 * No team in this shop is addressable by that id for the attempted write. Also
 * covers an *archived* team on the membership-add path — an archived team is
 * not a place work can be assigned to, so from the caller's side it is not
 * there. Removal never fails this way (see `setTeamMember`).
 */
export class TeamNotFoundError extends Schema.TaggedError<TeamNotFoundError>()(
  "TeamNotFoundError",
  { shop: Domain.Shop, teamId: Domain.TeamId },
) {}

const decodeRepository =
  <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((cause) => new RepositoryError({ message, cause })),
    );

export class Repository extends Context.Service<
  Repository,
  {
    readonly findShopSession: (
      shop: Domain.ShopSession["shop"],
    ) => Effect.Effect<
      Option.Option<Domain.ShopSession>,
      SqlError.SqlError | RepositoryError
    >;
    readonly upsertShopSession: (
      shopSession: Omit<
        Domain.ShopSession,
        "planHandle" | "planHandleExpiresAt"
      >,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly clearShopSessionAccessToken: (
      shop: Domain.ShopSession["shop"],
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly updateShopSessionTokens: (
      shopSession: Pick<
        Domain.ShopSession,
        | "shop"
        | "accessToken"
        | "accessTokenExpiresAt"
        | "refreshToken"
        | "refreshTokenExpiresAt"
      >,
    ) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * Writes the revalidated plan cache entry, and nothing else.
     *
     * Deliberately its own statement rather than columns folded into
     * `upsertShopSession`: D1 bills index B-tree writes as `rows_written`, and
     * `upsertShopSession` runs on the hot authentication path where every extra
     * column in a `SET` list is billed on every token re-exchange. Plan
     * revalidation happens on the order of once per shop per day, so it pays
     * for its own narrow update instead of taxing the path that does not.
     */
    readonly updateShopSessionPlan: (
      shopSession: Pick<
        Domain.ShopSession,
        "shop" | "planHandle" | "planHandleExpiresAt"
      >,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly deleteShopSession: (
      shop: Domain.ShopSession["shop"],
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly updateShopSessionScope: (
      shop: Domain.ShopSession["shop"],
      scope: Domain.ShopSession["scope"],
    ) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * One shop session row with both tokens projected away in SQL.
     *
     * Deliberately not `findShopSession` with the fields dropped afterwards:
     * the caller is a route loader, whose result is serialized to the browser,
     * and the only way a live access token cannot reach that payload is for it
     * never to leave D1. Same projection as {@link getShopSessionRedactedPage}.
     */
    readonly findShopSessionRedacted: (
      shop: Domain.ShopSession["shop"],
    ) => Effect.Effect<
      Option.Option<Domain.ShopSessionRedacted>,
      SqlError.SqlError | RepositoryError
    >;
    readonly getShopSessionRedactedPage: (params: {
      readonly after?: string;
      readonly before?: string;
      readonly filter?: string;
      readonly limit: number;
    }) => Effect.Effect<
      Domain.ShopSessionRedactedPage,
      SqlError.SqlError | RepositoryError
    >;
    /**
     * Anti-joins the given REST object ids against `ShopSession.shopAgentId` and
     * returns the subset with no matching row (the orphans). Ids are passed
     * as one `json_each` JSON-array parameter to stay within D1's 100-bound-param
     * cap. Pure diff: callers decide which ids to pass — the orphan page excludes
     * ids with no stored data, so only storage-billing ids reach the join.
     */
    readonly findOrphanShopAgentIds: (
      ids: readonly string[],
    ) => Effect.Effect<readonly string[], SqlError.SqlError | RepositoryError>;
    readonly listMembers: (
      shop: Domain.Member["shop"],
    ) => Effect.Effect<
      readonly Domain.Member[],
      SqlError.SqlError | RepositoryError
    >;
    readonly addMember: (
      member: Pick<Domain.Member, "shop" | "email">,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly deleteMember: (
      member: Pick<Domain.Member, "shop" | "email">,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly findMember: (
      member: Pick<Domain.Member, "shop" | "email">,
    ) => Effect.Effect<
      Option.Option<Domain.Member>,
      SqlError.SqlError | RepositoryError
    >;
    readonly listMemberShops: (
      email: Domain.Member["email"],
    ) => Effect.Effect<
      readonly Domain.Shop[],
      SqlError.SqlError | RepositoryError
    >;
    readonly listTeams: (params: {
      readonly shop: Domain.Shop;
      readonly includeArchived: boolean;
    }) => Effect.Effect<
      readonly Domain.TeamSummary[],
      SqlError.SqlError | RepositoryError
    >;
    readonly createTeam: (
      team: Pick<Domain.Team, "shop" | "name">,
    ) => Effect.Effect<
      Domain.Team,
      SqlError.SqlError | RepositoryError | TeamNameTakenError
    >;
    readonly renameTeam: (
      team: Pick<Domain.Team, "shop" | "id" | "name">,
    ) => Effect.Effect<
      void,
      | SqlError.SqlError
      | RepositoryError
      | TeamNameTakenError
      | TeamNotFoundError
    >;
    readonly setTeamArchived: (
      team: Pick<Domain.Team, "shop" | "id"> & { readonly archived: boolean },
    ) => Effect.Effect<void, SqlError.SqlError | TeamNotFoundError>;
    readonly findTeamDetail: (
      team: Pick<Domain.Team, "shop" | "id">,
    ) => Effect.Effect<
      Option.Option<Domain.TeamDetail>,
      SqlError.SqlError | RepositoryError
    >;
    readonly setTeamMember: (params: {
      readonly shop: Domain.Shop;
      readonly teamId: Domain.TeamId;
      readonly memberId: Domain.MemberId;
      readonly inTeam: boolean;
    }) => Effect.Effect<void, SqlError.SqlError | TeamNotFoundError>;
    readonly findMemberAccess: (
      member: Pick<Domain.Member, "shop" | "email">,
    ) => Effect.Effect<
      Option.Option<Domain.MemberAccess>,
      SqlError.SqlError | RepositoryError
    >;
  }
>()("Repository") {
  /**
   * Every method names its database path (`D1Session` vs `D1Primary`; the bare
   * `SqlClient` tag is deliberately never provided for D1). `ShopSession`
   * methods run on the per-request session: that is the pre-split behavior the
   * bookmark threading was built around, and its auth-path writes must advance
   * the bookmark. Member methods split by consequence-of-staleness, noted per
   * method.
   */
  static readonly layerNoDeps: Layer.Layer<
    Repository,
    never,
    D1Primary | D1Session
  > = Layer.effect(
    Repository,
    Effect.gen(function* () {
      const sql = yield* D1Session;
      const sqlPrimary = yield* D1Primary;

      const findShopSession = Effect.fn("Repository.findShopSession")(
        function* (shop: Domain.ShopSession["shop"]) {
          const rows =
            yield* sql`select * from ShopSession where shop = ${shop}`;
          if (rows[0] === undefined) return Option.none();
          return Option.some(
            yield* decodeRepository(
              Domain.ShopSession,
              "Invalid ShopSession row",
            )(rows[0]),
          );
        },
      );

      /**
       * The conflict branch deliberately omits `shopAgentId` from the `SET`
       * list. `shopAgentId` is `idFromName(shop)` — deterministic and immutable
       * after insert — so re-assigning it is a no-op value-wise, but SQLite
       * decides which indexes to rewrite by which columns appear in `SET`, not
       * by whether the value changed. Including it would delete and re-insert
       * the `shopAgentId` unique-index entry on every conflict-update.
       *
       * D1 bills index B-tree writes as `rows_written`, and this upsert runs on
       * the hot auth path (every expiring-token re-exchange in
       * `authenticateAdmin`). Measured: keeping `shopAgentId` in `SET` cost 2
       * `rows_written` per re-exchange vs 1 without it.
       *
       * The plan cache columns are absent from both the insert list and the
       * `SET` list for the same billing reason, and the parameter type omits
       * them so that stays true: re-authentication must not disturb a cached
       * plan, and a fresh insert leaves them null, which reads as never
       * fetched. `updateShopSessionPlan` owns those columns.
       */
      const upsertShopSession = Effect.fn("Repository.upsertShopSession")(
        function* (
          shopSession: Omit<
            Domain.ShopSession,
            "planHandle" | "planHandleExpiresAt"
          >,
        ) {
          yield* sql`
          insert into ShopSession (shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, accessToken, refreshToken, refreshTokenExpiresAt)
          values (${shopSession.shop}, ${shopSession.shopGid}, ${shopSession.shopAgentId}, ${shopSession.scope}, ${shopSession.accessTokenExpiresAt}, ${shopSession.accessToken}, ${shopSession.refreshToken}, ${shopSession.refreshTokenExpiresAt})
          on conflict(shop) do update set
            shopGid = excluded.shopGid,
            scope = excluded.scope,
            accessTokenExpiresAt = excluded.accessTokenExpiresAt,
            accessToken = excluded.accessToken,
            refreshToken = excluded.refreshToken,
            refreshTokenExpiresAt = excluded.refreshTokenExpiresAt
        `;
        },
      );

      const clearShopSessionAccessToken = Effect.fn(
        "Repository.clearShopSessionAccessToken",
      )(function* (shop: Domain.ShopSession["shop"]) {
        yield* sql`update ShopSession set accessToken = null where shop = ${shop}`;
      });

      const updateShopSessionTokens = Effect.fn(
        "Repository.updateShopSessionTokens",
      )(function* (
        shopSession: Pick<
          Domain.ShopSession,
          | "shop"
          | "accessToken"
          | "accessTokenExpiresAt"
          | "refreshToken"
          | "refreshTokenExpiresAt"
        >,
      ) {
        yield* sql`
            update ShopSession set
              accessToken = ${shopSession.accessToken},
              accessTokenExpiresAt = ${shopSession.accessTokenExpiresAt},
              refreshToken = ${shopSession.refreshToken},
              refreshTokenExpiresAt = ${shopSession.refreshTokenExpiresAt}
            where shop = ${shopSession.shop}
          `;
      });

      const updateShopSessionPlan = Effect.fn(
        "Repository.updateShopSessionPlan",
      )(function* (
        shopSession: Pick<
          Domain.ShopSession,
          "shop" | "planHandle" | "planHandleExpiresAt"
        >,
      ) {
        yield* sql`
            update ShopSession set
              planHandle = ${shopSession.planHandle},
              planHandleExpiresAt = ${shopSession.planHandleExpiresAt}
            where shop = ${shopSession.shop}
          `;
      });

      const deleteShopSession = Effect.fn("Repository.deleteShopSession")(
        function* (shop: Domain.ShopSession["shop"]) {
          yield* sql`delete from ShopSession where shop = ${shop}`;
        },
      );

      const updateShopSessionScope = Effect.fn(
        "Repository.updateShopSessionScope",
      )(function* (
        shop: Domain.ShopSession["shop"],
        scope: Domain.ShopSession["scope"],
      ) {
        yield* sql`update ShopSession set scope = ${scope} where shop = ${shop}`;
      });

      const findShopSessionRedacted = Effect.fn(
        "Repository.findShopSessionRedacted",
      )(function* (shop: Domain.ShopSession["shop"]) {
        const rows = yield* sql`
          select shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, refreshTokenExpiresAt,
            planHandle, planHandleExpiresAt,
            (accessToken is not null) as hasAccessToken,
            (refreshToken is not null) as hasRefreshToken
          from ShopSession
          where shop = ${shop}
        `;
        if (rows[0] === undefined) return Option.none();
        return Option.some(
          yield* decodeRepository(
            Domain.ShopSessionRedacted,
            "Invalid ShopSession row",
          )(rows[0]),
        );
      });

      /**
       * The cursor and filter clauses are composed conditionally rather than
       * null-guarded in SQL: a `(? is null or shop > ?)` disjunction defeats
       * the primary-key seek and scans the index from the first row, so the
       * cursor clause must be present only when a cursor is — that is what
       * keeps a page at `limit + 1` rows read instead of every row before the
       * cursor. The filter is a bound-parameter contains-`LIKE`, so `%`/`_`
       * typed into it act as wildcards — accepted for this internal admin
       * search rather than paying an escaping story.
       */
      const getShopSessionRedactedPage = Effect.fn(
        "Repository.getShopSessionRedactedPage",
      )(function* (params: {
        readonly after?: string;
        readonly before?: string;
        readonly filter?: string;
        readonly limit: number;
      }) {
        const fetchLimit = params.limit + 1;
        const cursor = params.before ?? params.after;
        const compare = sql.literal(params.before === undefined ? ">" : "<");
        const clauses = [
          ...(cursor === undefined ? [] : [sql`shop ${compare} ${cursor}`]),
          ...(params.filter ? [sql`shop like ${`%${params.filter}%`}`] : []),
        ];
        const rows = yield* sql`
          select shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, refreshTokenExpiresAt,
            planHandle, planHandleExpiresAt,
            (accessToken is not null) as hasAccessToken,
            (refreshToken is not null) as hasRefreshToken
          from ShopSession
          ${clauses.length > 0 ? sql`where ${sql.and(clauses)}` : sql``}
          order by shop ${sql.literal(params.before === undefined ? "asc" : "desc")}
          limit ${fetchLimit}
        `;
        const fetched = yield* decodeRepository(
          Schema.Array(Domain.ShopSessionRedacted),
          "Invalid ShopSession rows",
        )(rows);
        const overflow = fetched.length > params.limit;
        const shopSessions =
          params.before === undefined
            ? fetched.slice(0, params.limit)
            : fetched.slice(0, params.limit).toReversed();
        return {
          shopSessions,
          limit: params.limit,
          startCursor: shopSessions[0]?.shop ?? null,
          endCursor: shopSessions.at(-1)?.shop ?? null,
          hasPreviousPage:
            params.before === undefined
              ? params.after !== undefined && shopSessions.length > 0
              : overflow,
          hasNextPage:
            params.before === undefined ? overflow : shopSessions.length > 0,
        } satisfies Domain.ShopSessionRedactedPage;
      });

      const findOrphanShopAgentIds = Effect.fn(
        "Repository.findOrphanShopAgentIds",
      )(function* (ids: readonly string[]) {
        if (ids.length === 0) return [];
        const rows = yield* sql`
          select je.value as id
          from json_each(${JSON.stringify(ids)}) je
          left join ShopSession s on s.shopAgentId = je.value
          where s.shopAgentId is null
        `;
        return yield* decodeRepository(
          Schema.Array(Schema.Struct({ id: Schema.String })),
          "Invalid orphan id rows",
        )(rows).pipe(Effect.map((decoded) => decoded.map((row) => row.id)));
      });

      /**
       * Reads through `D1Primary`: the embedded members screen re-lists
       * immediately after `addMember`/`deleteMember`, which write through the
       * primary and so never advance the session bookmark — a session read
       * could miss the row just written.
       */
      const listMembers = Effect.fn("Repository.listMembers")(function* (
        shop: Domain.Member["shop"],
      ) {
        const rows =
          yield* sqlPrimary`select * from Member where shop = ${shop} order by createdAt, email`;
        return yield* decodeRepository(
          Schema.Array(Domain.Member),
          "Invalid Member rows",
        )(rows);
      });

      const addMember = Effect.fn("Repository.addMember")(function* (
        member: Pick<Domain.Member, "shop" | "email">,
      ) {
        const createdAt = new Date(
          yield* Clock.currentTimeMillis,
        ).toISOString();
        yield* sqlPrimary`
          insert into Member (id, shop, email, createdAt)
          values (${crypto.randomUUID()}, ${member.shop}, ${member.email}, ${createdAt})
          on conflict (shop, email) do nothing
        `;
      });

      const deleteMember = Effect.fn("Repository.deleteMember")(function* (
        member: Pick<Domain.Member, "shop" | "email">,
      ) {
        yield* sqlPrimary`delete from Member where shop = ${member.shop} and email = ${member.email}`;
      });

      /**
       * Reads through the per-request replica session (`D1Session`): the
       * member-area guard tolerates replica lag — a just-revoked membership may
       * linger for replica-lag seconds, a just-granted one is reachable on
       * retry.
       */
      const findMember = Effect.fn("Repository.findMember")(function* (
        member: Pick<Domain.Member, "shop" | "email">,
      ) {
        const rows =
          yield* sql`select * from Member where shop = ${member.shop} and email = ${member.email}`;
        if (rows[0] === undefined) return Option.none();
        return Option.some(
          yield* decodeRepository(Domain.Member, "Invalid Member row")(rows[0]),
        );
      });

      /**
       * Reads through `D1Primary`: this feeds the magic-link sign-in gate and
       * the `user.create.before` backstop, where a stale-replica miss would
       * wrongly block a just-added member's first login with no visible error.
       */
      const listMemberShops = Effect.fn("Repository.listMemberShops")(
        function* (email: Domain.Member["email"]) {
          const rows =
            yield* sqlPrimary`select shop from Member where email = ${email} order by shop`;
          return yield* decodeRepository(
            Schema.Array(Schema.Struct({ shop: Domain.Shop })),
            "Invalid Member shop rows",
          )(rows).pipe(Effect.map((decoded) => decoded.map((row) => row.shop)));
        },
      );

      /**
       * Reads through `D1Primary` for the same reason {@link listMembers} does:
       * the embedded teams screen re-lists immediately after a primary write.
       * `memberCount` is a correlated subquery rather than a `group by` join so
       * a team with no members still returns a row.
       */
      const listTeams = Effect.fn("Repository.listTeams")(function* (params: {
        readonly shop: Domain.Shop;
        readonly includeArchived: boolean;
      }) {
        const rows = yield* sqlPrimary`
          select t.*, (select count(*) from TeamMember tm where tm.teamId = t.id) as memberCount
          from Team t
          where t.shop = ${params.shop}
          ${params.includeArchived ? sqlPrimary`` : sqlPrimary`and t.archivedAt is null`}
          order by t.archivedAt is not null, t.name collate nocase
        `;
        return yield* decodeRepository(
          Schema.Array(Domain.TeamSummary),
          "Invalid Team rows",
        )(rows);
      });

      /**
       * `insert or ignore ... returning` is the whole conflict check: a fresh
       * uuid makes the name index the only reachable unique constraint, so zero
       * returned rows means exactly "that name is taken" — with no pre-check to
       * race against and no dependence on D1's constraint-violation message
       * text, which is untyped and version-specific. Foreign-key violations are
       * unaffected: SQLite treats `or ignore` as `abort` for those, so an
       * uninstalled shop still fails loudly.
       */
      const createTeam = Effect.fn("Repository.createTeam")(function* (
        team: Pick<Domain.Team, "shop" | "name">,
      ) {
        const createdAt = new Date(
          yield* Clock.currentTimeMillis,
        ).toISOString();
        const rows = yield* sqlPrimary`
          insert or ignore into Team (id, shop, name, createdAt, archivedAt)
          values (${crypto.randomUUID()}, ${team.shop}, ${team.name}, ${createdAt}, null)
          returning id, shop, name, createdAt, archivedAt
        `;
        if (rows[0] === undefined)
          return yield* new TeamNameTakenError({
            shop: team.shop,
            name: team.name,
          });
        return yield* decodeRepository(
          Domain.Team,
          "Invalid Team row",
        )(rows[0]);
      });

      /**
       * `update or ignore` turns a name collision into zero returned rows
       * instead of a `SqlError`, which is what lets both failures share one
       * statement — but it makes "no rows" ambiguous between a missing team and
       * a taken name. The follow-up query disambiguates, and only runs on that
       * failure path.
       */
      const renameTeam = Effect.fn("Repository.renameTeam")(function* (
        team: Pick<Domain.Team, "shop" | "id" | "name">,
      ) {
        const updated = yield* sqlPrimary`
          update or ignore Team set name = ${team.name}
          where id = ${team.id} and shop = ${team.shop}
          returning id
        `;
        if (updated[0] !== undefined) return;
        const rows = yield* sqlPrimary`
          select
            exists(select 1 from Team where shop = ${team.shop} and id = ${team.id}) as teamExists,
            exists(select 1 from Team where shop = ${team.shop} and name = ${team.name} collate nocase and id <> ${team.id}) as nameTaken
        `;
        const { nameTaken } = yield* decodeRepository(
          Schema.Struct({
            teamExists: Schema.Number,
            nameTaken: Schema.Number,
          }),
          "Invalid Team conflict row",
        )(rows[0]);
        yield* nameTaken === 1
          ? new TeamNameTakenError({ shop: team.shop, name: team.name })
          : new TeamNotFoundError({ shop: team.shop, teamId: team.id });
      });

      /**
       * Idempotent in both directions: `coalesce` keeps the original archival
       * instant when archiving an already-archived team, so re-clicking never
       * rewrites when the team stopped being used.
       */
      const setTeamArchived = Effect.fn("Repository.setTeamArchived")(
        function* (
          team: Pick<Domain.Team, "shop" | "id"> & {
            readonly archived: boolean;
          },
        ) {
          const archivedAt = new Date(
            yield* Clock.currentTimeMillis,
          ).toISOString();
          const rows = yield* sqlPrimary`
            update Team set archivedAt = ${
              team.archived
                ? sqlPrimary`coalesce(archivedAt, ${archivedAt})`
                : sqlPrimary`null`
            }
            where id = ${team.id} and shop = ${team.shop}
            returning id
          `;
          if (rows[0] === undefined)
            yield* new TeamNotFoundError({
              shop: team.shop,
              teamId: team.id,
            });
        },
      );

      /**
       * The roster is a left join from `Member`, not from `TeamMember`: the
       * screen toggles membership, so a member who is *not* on the team is as
       * much part of the view as one who is.
       */
      const findTeamDetail = Effect.fn("Repository.findTeamDetail")(function* (
        team: Pick<Domain.Team, "shop" | "id">,
      ) {
        const teamRows =
          yield* sqlPrimary`select * from Team where id = ${team.id} and shop = ${team.shop}`;
        if (teamRows[0] === undefined) return Option.none();
        const memberRows = yield* sqlPrimary`
          select m.*, (tm.teamId is not null) as inTeam
          from Member m
          left join TeamMember tm on tm.memberId = m.id and tm.teamId = ${team.id}
          where m.shop = ${team.shop}
          order by m.createdAt, m.email
        `;
        return Option.some(
          yield* decodeRepository(
            Domain.TeamDetail,
            "Invalid TeamDetail rows",
          )({ team: teamRows[0], members: memberRows }),
        );
      });

      /**
       * The add is an insert-select, so the same-shop invariant is asserted by
       * the join rather than trusted from the caller: a forged
       * `(teamId, memberId)` pair spanning two shops matches no source row and
       * inserts nothing. `archivedAt is null` is part of that filter — an
       * archived team is not somewhere work can be assigned.
       *
       * `on conflict do nothing` makes a repeat add a no-op, which also makes
       * "no rows returned" ambiguous with a genuine miss; the existence check
       * disambiguates, and only runs on that path. Removal is unconditional and
       * cannot fail: un-assigning must stay possible after a team is archived.
       */
      const setTeamMember = Effect.fn("Repository.setTeamMember")(
        function* (params: {
          readonly shop: Domain.Shop;
          readonly teamId: Domain.TeamId;
          readonly memberId: Domain.MemberId;
          readonly inTeam: boolean;
        }) {
          if (!params.inTeam) {
            yield* sqlPrimary`
            delete from TeamMember
            where teamId = ${params.teamId}
              and memberId in (select id from Member where id = ${params.memberId} and shop = ${params.shop})
          `;
            return;
          }
          const createdAt = new Date(
            yield* Clock.currentTimeMillis,
          ).toISOString();
          const inserted = yield* sqlPrimary`
          insert into TeamMember (teamId, memberId, createdAt)
          select t.id, m.id, ${createdAt}
          from Team t join Member m on m.shop = t.shop
          where t.id = ${params.teamId} and t.shop = ${params.shop}
            and m.id = ${params.memberId} and t.archivedAt is null
          on conflict do nothing
          returning teamId
        `;
          if (inserted[0] !== undefined) return;
          const existing =
            yield* sqlPrimary`select 1 as present from TeamMember where teamId = ${params.teamId} and memberId = ${params.memberId}`;
          if (existing[0] === undefined)
            yield* new TeamNotFoundError({
              shop: params.shop,
              teamId: params.teamId,
            });
        },
      );

      /**
       * The member-area guard's single query: membership and the teams it
       * carries in one round trip, through the per-request replica session for
       * the same staleness tolerance as {@link findMember}. The left joins are
       * what make a teamless member decode to `teams: []` rather than to
       * `Option.none()` — no team is a normal state for a member, not a
       * revoked grant. Archived teams are joined away: they scope no work.
       */
      const findMemberAccess = Effect.fn("Repository.findMemberAccess")(
        function* (member: Pick<Domain.Member, "shop" | "email">) {
          const rows = yield* sql`
            select m.id as memberId, t.id as teamId, t.name as teamName
            from Member m
            left join TeamMember tm on tm.memberId = m.id
            left join Team t on t.id = tm.teamId and t.archivedAt is null
            where m.shop = ${member.shop} and m.email = ${member.email}
            order by t.name collate nocase
          `;
          if (rows[0] === undefined) return Option.none();
          const decoded = yield* decodeRepository(
            Schema.Array(
              Schema.Struct({
                memberId: Domain.MemberId,
                teamId: Schema.NullOr(Domain.TeamId),
                teamName: Schema.NullOr(Domain.TeamName),
              }),
            ),
            "Invalid MemberAccess rows",
          )(rows);
          return Option.some({
            shop: member.shop,
            memberId: decoded[0].memberId,
            teams: decoded.flatMap((row) =>
              row.teamId === null || row.teamName === null
                ? []
                : [{ id: row.teamId, name: row.teamName }],
            ),
          } satisfies Domain.MemberAccess);
        },
      );

      return Repository.of({
        findShopSession,
        upsertShopSession,
        clearShopSessionAccessToken,
        updateShopSessionTokens,
        updateShopSessionPlan,
        deleteShopSession,
        updateShopSessionScope,
        findShopSessionRedacted,
        getShopSessionRedactedPage,
        findOrphanShopAgentIds,
        listMembers,
        addMember,
        deleteMember,
        findMember,
        listMemberShops,
        listTeams,
        createTeam,
        renameTeam,
        setTeamArchived,
        findTeamDetail,
        setTeamMember,
        findMemberAccess,
      });
    }),
  );
}
