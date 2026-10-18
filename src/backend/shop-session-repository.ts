import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ShopKey } from "../contract/shop.ts";
import { AuthDb } from "./resources.ts";

/**
 * A `ShopSession` row: Baton's `ShopSession`, one shop's offline Admin API session. Times are
 * epoch ms. `shopActorId` names the shop's actor; here it is the shop domain, because the actor
 * is addressed by name (`ShopActors.getByName(shop)`), where Baton stored the Agents SDK's id.
 * The three plan columns are a cache that only a plan check writes. `refreshLeaseUntil` is the
 * lease that serializes refresh-token grants for the shop: while it is in the future, one caller
 * is refreshing and the rest wait.
 */
export const ShopSessionRow = Schema.Struct({
  shop: ShopKey,
  shopGid: Schema.String,
  shopActorId: Schema.String,
  scope: Schema.NullOr(Schema.String),
  accessTokenExpiresAt: Schema.NullOr(Schema.Number),
  accessToken: Schema.NullOr(Schema.String),
  refreshToken: Schema.NullOr(Schema.String),
  refreshTokenExpiresAt: Schema.NullOr(Schema.Number),
  refreshLeaseUntil: Schema.NullOr(Schema.Number),
  planHandle: Schema.NullOr(Schema.String),
  planHandleExpiresAt: Schema.NullOr(Schema.Number),
  planBoundaryAt: Schema.NullOr(Schema.Number),
});
export type ShopSessionRow = typeof ShopSessionRow.Type;

/**
 * A row as authentication knows it: everything but the plan columns and the refresh lease, so
 * re-authenticating never disturbs a cached plan or a refresh in flight, and a fresh insert
 * leaves them null, which reads as never fetched and unleased.
 */
export const ShopSessionUpsert = Schema.Struct(
  Struct.omit(ShopSessionRow.fields, [
    "refreshLeaseUntil",
    "planHandle",
    "planHandleExpiresAt",
    "planBoundaryAt",
  ]),
);
export type ShopSessionUpsert = typeof ShopSessionUpsert.Type;

/** The token columns {@link ShopSessionRepository}' `rotateTokens` rewrites, by shop. */
export type ShopSessionTokens = Pick<
  ShopSessionRow,
  "accessToken" | "accessTokenExpiresAt" | "refreshToken" | "refreshTokenExpiresAt"
>;

/** What an `UPDATE … RETURNING shop` answers: the rows it changed. */
const decodeWon = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ shop: ShopKey })));

/** Rows of the `ShopSession` table. A row that does not decode is a broken invariant, so it dies. */
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ShopSessionRow));

const make = <R>(database: SQL.D1DatabaseSource<never, R>) =>
  Effect.gen(function* () {
    const sql = yield* SQL.D1(database);

    const find = Effect.fn("ShopSessionRepository.find")(function* (shop: ShopKey) {
      const [row] = yield* decodeRows(yield* sql`SELECT * FROM ShopSession WHERE shop = ${shop}`);
      return Option.fromUndefinedOr(row);
    }, Effect.orDie);

    /**
     * Baton's `upsertShopSession`. The conflict branch leaves `shopActorId` out of the `SET` list:
     * it never changes after insert, and SQLite rewrites an index for every column named in `SET`,
     * whether its value changed or not, so naming it would rewrite its unique index on every
     * re-exchange, which D1 bills as a written row.
     */
    const upsert = Effect.fn("ShopSessionRepository.upsert")(function* (row: ShopSessionUpsert) {
      yield* sql`INSERT INTO ShopSession (shop, shopGid, shopActorId, scope, accessTokenExpiresAt, accessToken, refreshToken, refreshTokenExpiresAt)
      VALUES (${row.shop}, ${row.shopGid}, ${row.shopActorId}, ${row.scope}, ${row.accessTokenExpiresAt}, ${row.accessToken}, ${row.refreshToken}, ${row.refreshTokenExpiresAt})
      ON CONFLICT (shop) DO UPDATE SET
        shopGid = excluded.shopGid,
        scope = excluded.scope,
        accessTokenExpiresAt = excluded.accessTokenExpiresAt,
        accessToken = excluded.accessToken,
        refreshToken = excluded.refreshToken,
        refreshTokenExpiresAt = excluded.refreshTokenExpiresAt`;
    }, Effect.orDie);

    /**
     * Clears the access token only while it is still `accessToken`, the one that got a 401, so a
     * token a concurrent refresh or exchange stored since is not thrown away.
     */
    const clearAccessToken = Effect.fn("ShopSessionRepository.clearAccessToken")(function* (
      shop: ShopKey,
      accessToken: string,
    ) {
      yield* sql`UPDATE ShopSession SET accessToken = NULL WHERE shop = ${shop} AND accessToken = ${accessToken}`;
    }, Effect.orDie);

    /**
     * A refresh's write: compare-and-swap on `presented`, the refresh token the grant used. It
     * rewrites the four token columns, releases the lease, and answers whether it won. It loses
     * when anything else (an exchange, another refresh) replaced the refresh token first, whose
     * pair is then the live one.
     */
    const rotateTokens = Effect.fn("ShopSessionRepository.rotateTokens")(function* (
      shop: ShopKey,
      presented: string,
      tokens: ShopSessionTokens,
    ) {
      const won = yield* decodeWon(
        yield* sql`UPDATE ShopSession SET
        accessToken = ${tokens.accessToken},
        accessTokenExpiresAt = ${tokens.accessTokenExpiresAt},
        refreshToken = ${tokens.refreshToken},
        refreshTokenExpiresAt = ${tokens.refreshTokenExpiresAt},
        refreshLeaseUntil = NULL
      WHERE shop = ${shop} AND refreshToken = ${presented}
      RETURNING shop`,
      );
      return won.length > 0;
    }, Effect.orDie);

    /** Takes the shop's refresh lease until `until` if none is live at `now`; answers whether it did. */
    const acquireRefreshLease = Effect.fn("ShopSessionRepository.acquireRefreshLease")(function* (
      shop: ShopKey,
      now: number,
      until: number,
    ) {
      const won = yield* decodeWon(
        yield* sql`UPDATE ShopSession SET refreshLeaseUntil = ${until}
      WHERE shop = ${shop} AND (refreshLeaseUntil IS NULL OR refreshLeaseUntil <= ${now})
      RETURNING shop`,
      );
      return won.length > 0;
    }, Effect.orDie);

    /**
     * Releases the lease taken until `until`. Matching on `until` means a holder whose lease
     * lapsed never releases one somebody else took after.
     */
    const releaseRefreshLease = Effect.fn("ShopSessionRepository.releaseRefreshLease")(function* (
      shop: ShopKey,
      until: number,
    ) {
      yield* sql`UPDATE ShopSession SET refreshLeaseUntil = NULL WHERE shop = ${shop} AND refreshLeaseUntil = ${until}`;
    }, Effect.orDie);

    /**
     * Test control's way to age a session: the access token expires at `accessTokenExpiresAt`, and
     * `refreshToken`, when given, replaces the stored one. Test-only in purpose; nothing in the
     * product calls it.
     */
    const expireAccessToken = Effect.fn("ShopSessionRepository.expireAccessToken")(function* (
      shop: ShopKey,
      accessTokenExpiresAt: number,
      refreshToken: string | undefined,
    ) {
      yield* sql`UPDATE ShopSession SET
        accessTokenExpiresAt = ${accessTokenExpiresAt},
        refreshToken = COALESCE(${refreshToken ?? null}, refreshToken)
      WHERE shop = ${shop}`;
    }, Effect.orDie);

    const updateScope = Effect.fn("ShopSessionRepository.updateScope")(function* (
      shop: ShopKey,
      scope: string | null,
    ) {
      yield* sql`UPDATE ShopSession SET scope = ${scope} WHERE shop = ${shop}`;
    }, Effect.orDie);

    const remove = Effect.fn("ShopSessionRepository.remove")(function* (shop: ShopKey) {
      yield* sql`DELETE FROM ShopSession WHERE shop = ${shop}`;
    }, Effect.orDie);

    return {
      find,
      upsert,
      clearAccessToken,
      rotateTokens,
      acquireRefreshLease,
      releaseRefreshLease,
      expireAccessToken,
      updateScope,
      remove,
    };
  });

/**
 * Baton's `ShopSession` repository: one offline Admin API session per installed shop, written by
 * token exchange. The layer is built once at Worker init, as `MembershipRepository`' is.
 */
export class ShopSessionRepository extends Context.Service<
  ShopSessionRepository,
  Effect.Success<ReturnType<typeof make>>
>()("app/ShopSessionRepository") {
  static readonly layer = Layer.effect(
    ShopSessionRepository,
    Effect.flatMap(Cloudflare.D1.QueryDatabase(AuthDb), (d1) => make(d1)),
  );

  /**
   * {@link ShopSessionRepository} over a `D1Database` the caller holds, rather than the bound `AuthDb`. It exists
   * for the unit tests' `node:sqlite` D1 adapter: the `Cloudflare.D1.QueryDatabase` binding
   * resolves `AuthDb` as a resource, which needs Alchemy's `Stack`, absent in a unit test.
   */
  static readonly layerWith = (database: D1Database) =>
    Layer.effect(ShopSessionRepository, make(Effect.succeed(database)));

  /** `ShopSession` rows in memory, for tests. Every write edits the layer's own copy. */
  static readonly layerTest = (seed: ReadonlyArray<ShopSessionRow>) =>
    Layer.sync(ShopSessionRepository, () => {
      const rows = new Map(seed.map((row) => [row.shop, row]));
      const edit = (shop: ShopKey, change: Partial<ShopSessionRow>) =>
        Effect.sync(() => {
          const row = rows.get(shop);
          if (row !== undefined) rows.set(shop, { ...row, ...change });
        });
      return {
        find: (shop: ShopKey) => Effect.sync(() => Option.fromUndefinedOr(rows.get(shop))),
        upsert: (row: ShopSessionUpsert) =>
          Effect.sync(() => {
            const existing = rows.get(row.shop);
            rows.set(
              row.shop,
              existing === undefined
                ? {
                    ...row,
                    refreshLeaseUntil: null,
                    planHandle: null,
                    planHandleExpiresAt: null,
                    planBoundaryAt: null,
                  }
                : { ...existing, ...row, shopActorId: existing.shopActorId },
            );
          }),
        clearAccessToken: (shop: ShopKey, accessToken: string) =>
          Effect.sync(() => {
            const row = rows.get(shop);
            if (row?.accessToken === accessToken) rows.set(shop, { ...row, accessToken: null });
          }),
        rotateTokens: (shop: ShopKey, presented: string, tokens: ShopSessionTokens) =>
          Effect.sync(() => {
            const row = rows.get(shop);
            if (row === undefined || row.refreshToken !== presented) return false;
            rows.set(shop, { ...row, ...tokens, refreshLeaseUntil: null });
            return true;
          }),
        acquireRefreshLease: (shop: ShopKey, now: number, until: number) =>
          Effect.sync(() => {
            const row = rows.get(shop);
            if (row === undefined) return false;
            if (row.refreshLeaseUntil !== null && row.refreshLeaseUntil > now) return false;
            rows.set(shop, { ...row, refreshLeaseUntil: until });
            return true;
          }),
        releaseRefreshLease: (shop: ShopKey, until: number) =>
          Effect.sync(() => {
            const row = rows.get(shop);
            if (row?.refreshLeaseUntil === until)
              rows.set(shop, { ...row, refreshLeaseUntil: null });
          }),
        expireAccessToken: (
          shop: ShopKey,
          accessTokenExpiresAt: number,
          refreshToken: string | undefined,
        ) =>
          edit(shop, {
            accessTokenExpiresAt,
            ...(refreshToken === undefined ? {} : { refreshToken }),
          }),
        updateScope: (shop: ShopKey, scope: string | null) => edit(shop, { scope }),
        remove: (shop: ShopKey) =>
          Effect.sync(() => {
            rows.delete(shop);
          }),
      };
    });
}
