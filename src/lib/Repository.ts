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
      });
    }),
  );
}
