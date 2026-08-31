import type { SqlError } from "effect/unstable/sql";

import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

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

const decodeRepository =
  <A>(schema: Schema.ConstraintDecoder<A>, message: string) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((cause) => new RepositoryError({ message, cause })),
    );

export class Repository extends Context.Service<
  Repository,
  {
    readonly findSessionByShop: (
      shop: Domain.Session["shop"],
    ) => Effect.Effect<
      Option.Option<Domain.Session>,
      SqlError.SqlError | RepositoryError
    >;
    readonly upsertSession: (
      session: Omit<Domain.Session, "planHandle" | "planHandleExpiresAt">,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly clearSessionAccessToken: (
      shop: Domain.Session["shop"],
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly updateSessionTokens: (
      session: Pick<
        Domain.Session,
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
     * `upsertSession`: D1 bills index B-tree writes as `rows_written`, and
     * `upsertSession` runs on the hot authentication path where every extra
     * column in a `SET` list is billed on every token re-exchange. Plan
     * revalidation happens on the order of once per shop per day, so it pays
     * for its own narrow update instead of taxing the path that does not.
     */
    readonly updateSessionPlan: (
      session: Pick<
        Domain.Session,
        "shop" | "planHandle" | "planHandleExpiresAt"
      >,
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly deleteSessionByShop: (
      shop: Domain.Session["shop"],
    ) => Effect.Effect<void, SqlError.SqlError>;
    readonly updateSessionScope: (
      shop: Domain.Session["shop"],
      scope: Domain.Session["scope"],
    ) => Effect.Effect<void, SqlError.SqlError>;
    /**
     * One session row with both tokens projected away in SQL.
     *
     * Deliberately not `findSessionByShop` with the fields dropped afterwards:
     * the caller is a route loader, whose result is serialized to the browser,
     * and the only way a live access token cannot reach that payload is for it
     * never to leave D1. Same projection as {@link getSessionRedactedPage}.
     */
    readonly findSessionRedactedByShop: (
      shop: Domain.Session["shop"],
    ) => Effect.Effect<
      Option.Option<Domain.SessionRedacted>,
      SqlError.SqlError | RepositoryError
    >;
    readonly getSessionRedactedPage: (params: {
      readonly after?: string;
      readonly before?: string;
      readonly filter?: string;
      readonly limit: number;
    }) => Effect.Effect<
      Domain.SessionRedactedPage,
      SqlError.SqlError | RepositoryError
    >;
    /**
     * Anti-joins the given REST object ids against `Session.shopAgentId` and
     * returns the subset with no matching session (the orphans). Ids are passed
     * as one `json_each` JSON-array parameter to stay within D1's 100-bound-param
     * cap. Pure diff: callers decide which ids to pass — the orphan page excludes
     * ids with no stored data, so only storage-billing ids reach the join.
     */
    readonly findOrphanShopAgentIds: (
      ids: readonly string[],
    ) => Effect.Effect<readonly string[], SqlError.SqlError | RepositoryError>;
  }
>()("Repository") {
  static readonly layerNoDeps: Layer.Layer<
    Repository,
    never,
    SqlClient.SqlClient
  > = Layer.effect(
    Repository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const findSessionByShop = Effect.fn("Repository.findSessionByShop")(
        function* (shop: Domain.Session["shop"]) {
          const rows = yield* sql`select * from Session where shop = ${shop}`;
          if (rows[0] === undefined) return Option.none();
          return Option.some(
            yield* decodeRepository(
              Domain.Session,
              "Invalid Session row",
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
       * fetched. `updateSessionPlan` owns those columns.
       */
      const upsertSession = Effect.fn("Repository.upsertSession")(function* (
        session: Omit<Domain.Session, "planHandle" | "planHandleExpiresAt">,
      ) {
        yield* sql`
          insert into Session (shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, accessToken, refreshToken, refreshTokenExpiresAt)
          values (${session.shop}, ${session.shopGid}, ${session.shopAgentId}, ${session.scope}, ${session.accessTokenExpiresAt}, ${session.accessToken}, ${session.refreshToken}, ${session.refreshTokenExpiresAt})
          on conflict(shop) do update set
            shopGid = excluded.shopGid,
            scope = excluded.scope,
            accessTokenExpiresAt = excluded.accessTokenExpiresAt,
            accessToken = excluded.accessToken,
            refreshToken = excluded.refreshToken,
            refreshTokenExpiresAt = excluded.refreshTokenExpiresAt
        `;
      });

      const clearSessionAccessToken = Effect.fn(
        "Repository.clearSessionAccessToken",
      )(function* (shop: Domain.Session["shop"]) {
        yield* sql`update Session set accessToken = null where shop = ${shop}`;
      });

      const updateSessionTokens = Effect.fn("Repository.updateSessionTokens")(
        function* (
          session: Pick<
            Domain.Session,
            | "shop"
            | "accessToken"
            | "accessTokenExpiresAt"
            | "refreshToken"
            | "refreshTokenExpiresAt"
          >,
        ) {
          yield* sql`
            update Session set
              accessToken = ${session.accessToken},
              accessTokenExpiresAt = ${session.accessTokenExpiresAt},
              refreshToken = ${session.refreshToken},
              refreshTokenExpiresAt = ${session.refreshTokenExpiresAt}
            where shop = ${session.shop}
          `;
        },
      );

      const updateSessionPlan = Effect.fn("Repository.updateSessionPlan")(
        function* (
          session: Pick<
            Domain.Session,
            "shop" | "planHandle" | "planHandleExpiresAt"
          >,
        ) {
          yield* sql`
            update Session set
              planHandle = ${session.planHandle},
              planHandleExpiresAt = ${session.planHandleExpiresAt}
            where shop = ${session.shop}
          `;
        },
      );

      const deleteSessionByShop = Effect.fn("Repository.deleteSessionByShop")(
        function* (shop: Domain.Session["shop"]) {
          yield* sql`delete from Session where shop = ${shop}`;
        },
      );

      const updateSessionScope = Effect.fn("Repository.updateSessionScope")(
        function* (
          shop: Domain.Session["shop"],
          scope: Domain.Session["scope"],
        ) {
          yield* sql`update Session set scope = ${scope} where shop = ${shop}`;
        },
      );

      const findSessionRedactedByShop = Effect.fn(
        "Repository.findSessionRedactedByShop",
      )(function* (shop: Domain.Session["shop"]) {
        const rows = yield* sql`
          select shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, refreshTokenExpiresAt,
            planHandle, planHandleExpiresAt,
            (accessToken is not null) as hasAccessToken,
            (refreshToken is not null) as hasRefreshToken
          from Session
          where shop = ${shop}
        `;
        if (rows[0] === undefined) return Option.none();
        return Option.some(
          yield* decodeRepository(
            Domain.SessionRedacted,
            "Invalid Session row",
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
      const getSessionRedactedPage = Effect.fn(
        "Repository.getSessionRedactedPage",
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
          from Session
          ${clauses.length > 0 ? sql`where ${sql.and(clauses)}` : sql``}
          order by shop ${sql.literal(params.before === undefined ? "asc" : "desc")}
          limit ${fetchLimit}
        `;
        const fetched = yield* decodeRepository(
          Schema.Array(Domain.SessionRedacted),
          "Invalid Session rows",
        )(rows);
        const overflow = fetched.length > params.limit;
        const sessions =
          params.before === undefined
            ? fetched.slice(0, params.limit)
            : fetched.slice(0, params.limit).toReversed();
        return {
          sessions,
          limit: params.limit,
          startCursor: sessions[0]?.shop ?? null,
          endCursor: sessions.at(-1)?.shop ?? null,
          hasPreviousPage:
            params.before === undefined
              ? params.after !== undefined && sessions.length > 0
              : overflow,
          hasNextPage:
            params.before === undefined ? overflow : sessions.length > 0,
        } satisfies Domain.SessionRedactedPage;
      });

      const findOrphanShopAgentIds = Effect.fn(
        "Repository.findOrphanShopAgentIds",
      )(function* (ids: readonly string[]) {
        if (ids.length === 0) return [];
        const rows = yield* sql`
          select je.value as id
          from json_each(${JSON.stringify(ids)}) je
          left join Session s on s.shopAgentId = je.value
          where s.shopAgentId is null
        `;
        return yield* decodeRepository(
          Schema.Array(Schema.Struct({ id: Schema.String })),
          "Invalid orphan id rows",
        )(rows).pipe(Effect.map((decoded) => decoded.map((row) => row.id)));
      });

      return Repository.of({
        findSessionByShop,
        upsertSession,
        clearSessionAccessToken,
        updateSessionTokens,
        updateSessionPlan,
        deleteSessionByShop,
        updateSessionScope,
        findSessionRedactedByShop,
        getSessionRedactedPage,
        findOrphanShopAgentIds,
      });
    }),
  );
}
