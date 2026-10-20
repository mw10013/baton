import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ShopKey,
  ShopSession,
  ShopSessionRedacted,
  type ShopSessionRedactedPage,
  type ShopSessionUpsert,
} from "../domain/platform.ts";
import { AuthDb } from "./resources.ts";
import { countedD1 } from "./row-counts.ts";

/** The plan cache columns, which only {@link ShopSessionRepository}' plan methods write. */
type PlanCacheColumn = "planHandle" | "planHandleExpiresAt" | "planBoundaryAt";

/** The token columns {@link ShopSessionRepository}' `rotateTokens` rewrites, by shop. */
export type ShopSessionTokens = Pick<
  ShopSession,
  "accessToken" | "accessTokenExpiresAt" | "refreshToken" | "refreshTokenExpiresAt"
>;

/** What an `UPDATE … RETURNING shop` answers: the rows it changed. */
const decodeWon = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ shop: ShopKey })));

/** Rows of the `ShopSession` table. A row that does not decode is a broken invariant, so it dies. */
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ShopSession));

/** Rows of the redacted reads, as {@link decodeRows}. */
const decodeRedactedRows = Schema.decodeUnknownEffect(Schema.Array(ShopSessionRedacted));

/** What {@link ShopSessionRepository}' `getRedactedPage` reads: a keyset page on `shop`, either way. */
export interface RedactedPageInput {
  readonly after?: ShopKey | undefined;
  readonly before?: ShopKey | undefined;
  readonly filter?: string | undefined;
  readonly limit: number;
}

/**
 * Cuts a read of `limit + 1` rows, in the read's own order, into {@link ShopSessionRedactedPage}:
 * the extra row only says another page exists that way. A backward read (`before`) came newest
 * first, so its page is reversed back into `shop` order.
 */
const redactedPage = (
  fetched: ReadonlyArray<ShopSessionRedacted>,
  { after, before, limit }: RedactedPageInput,
): ShopSessionRedactedPage => {
  const overflow = fetched.length > limit;
  const shopSessions =
    before === undefined ? fetched.slice(0, limit) : fetched.slice(0, limit).toReversed();
  return {
    shopSessions,
    limit,
    startCursor: shopSessions[0]?.shop ?? null,
    endCursor: shopSessions.at(-1)?.shop ?? null,
    hasPreviousPage:
      before === undefined ? after !== undefined && shopSessions.length > 0 : overflow,
    hasNextPage: before === undefined ? overflow : shopSessions.length > 0,
  };
};

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

    /**
     * Legacy's `updateShopSessionPlan`: writes the three plan cache columns, and only them.
     *
     * Deliberately its own statement rather than columns folded into
     * `upsert`: D1 bills index B-tree writes as `rows_written`, and
     * `upsert` runs on the hot authentication path where every extra
     * column in a `SET` list is billed on every token re-exchange. Plan
     * revalidation happens on the order of once per shop per day, so it pays
     * for its own narrow update instead of taxing the path that does not.
     */
    const updatePlan = Effect.fn("ShopSessionRepository.updatePlan")(function* (
      plan: Pick<ShopSession, "shop" | PlanCacheColumn>,
    ) {
      yield* sql`
        update ShopSession set
          planHandle = ${plan.planHandle},
          planHandleExpiresAt = ${plan.planHandleExpiresAt},
          planBoundaryAt = ${plan.planBoundaryAt}
        where shop = ${plan.shop}
      `;
    }, Effect.orDie);

    /**
     * Legacy's `shortenShopSessionPlanExpiry`: pulls the plan cache deadline forward to at most
     * `notAfter`, never backward, and never on a never-fetched row.
     *
     * The `min` is what makes it safe to call speculatively: a shop whose app
     * subscription boundary already falls sooner keeps that tighter deadline,
     * and a row that has never been fetched stays "never fetched" rather than
     * acquiring a deadline that would make an absent handle look like a
     * verified absence of any app subscription.
     */
    const shortenPlanExpiry = Effect.fn("ShopSessionRepository.shortenPlanExpiry")(
      function* (input: { readonly shop: ShopKey; readonly notAfter: number }) {
        yield* sql`
        update ShopSession
        set planHandleExpiresAt = min(planHandleExpiresAt, ${input.notAfter})
        where shop = ${input.shop} and planHandleExpiresAt is not null
      `;
      },
      Effect.orDie,
    );

    /**
     * The shops whose cached plan is stale at `now`: never fetched, or past
     * its deadline. The daily check's list (`revalidateStalePlans`). A scan
     * of `ShopSession`, with no index on `planHandleExpiresAt`: the table
     * holds one row per installed shop, and the query runs once a day, so an
     * index would cost a write on every revalidation to save a read nobody
     * waits on.
     */
    const listShopsWithStalePlan = Effect.fn("ShopSessionRepository.listShopsWithStalePlan")(
      function* (now: number) {
        const rows = yield* decodeWon(
          yield* sql`
            select shop from ShopSession
            where planHandleExpiresAt is null or planHandleExpiresAt <= ${now}
            order by shop
          `,
        );
        return rows.map(({ shop }) => shop);
      },
      Effect.orDie,
    );

    /**
     * One shop session row with both tokens projected away in SQL.
     *
     * Deliberately not {@link find} with the fields dropped afterwards: the caller is the admin
     * console, whose answer is serialized to the browser, and the only way a live access token
     * cannot reach that payload is for it never to leave D1. Same projection as
     * {@link getRedactedPage}.
     */
    const findRedacted = Effect.fn("ShopSessionRepository.findRedacted")(function* (shop: ShopKey) {
      const [row] = yield* decodeRedactedRows(
        yield* sql`
          select shop, shopGid, shopActorId, scope, accessTokenExpiresAt, refreshTokenExpiresAt,
            planHandle, planHandleExpiresAt, planBoundaryAt,
            (accessToken is not null) as hasAccessToken,
            (refreshToken is not null) as hasRefreshToken
          from ShopSession
          where shop = ${shop}
        `,
      );
      return Option.fromUndefinedOr(row);
    }, Effect.orDie);

    /**
     * The admin console's list of shops, a page at a time, both ways.
     *
     * The cursor and filter clauses are composed conditionally rather than null-guarded in SQL:
     * a `(? is null or shop > ?)` disjunction defeats the primary-key seek and scans the index
     * from the first row, so the cursor clause must be present only when a cursor is; that is
     * what keeps a page at `limit + 1` rows read instead of every row before the cursor. The
     * filter is a bound-parameter contains-`like`, so `%` and `_` typed into it act as
     * wildcards, accepted for this internal admin search rather than paying for escaping.
     */
    const getRedactedPage = Effect.fn("ShopSessionRepository.getRedactedPage")(function* (
      input: RedactedPageInput,
    ) {
      const cursor = input.before ?? input.after;
      const compare = sql.literal(input.before === undefined ? ">" : "<");
      const clauses = [
        ...(cursor === undefined ? [] : [sql`shop ${compare} ${cursor}`]),
        ...(input.filter ? [sql`shop like ${`%${input.filter}%`}`] : []),
      ];
      const fetched = yield* decodeRedactedRows(
        yield* sql`
          select shop, shopGid, shopActorId, scope, accessTokenExpiresAt, refreshTokenExpiresAt,
            planHandle, planHandleExpiresAt, planBoundaryAt,
            (accessToken is not null) as hasAccessToken,
            (refreshToken is not null) as hasRefreshToken
          from ShopSession
          ${clauses.length > 0 ? sql`where ${sql.and(clauses)}` : sql``}
          order by shop ${sql.literal(input.before === undefined ? "asc" : "desc")}
          limit ${input.limit + 1}
        `,
      );
      return redactedPage(fetched, input);
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
      updatePlan,
      shortenPlanExpiry,
      listShopsWithStalePlan,
      findRedacted,
      getRedactedPage,
      remove,
    };
  });

/** A row as the redacted reads answer it, for {@link ShopSessionRepository.layerTest}. */
const redact = ({
  accessToken,
  refreshToken,
  refreshLeaseUntil: _lease,
  ...row
}: ShopSession): ShopSessionRedacted => ({
  ...row,
  hasAccessToken: accessToken !== null,
  hasRefreshToken: refreshToken !== null,
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
    Cloudflare.D1.QueryDatabase(AuthDb).pipe(
      Effect.flatMap((d1) => countedD1(d1.raw)),
      Effect.flatMap(make),
    ),
  );

  /**
   * {@link ShopSessionRepository} over a `D1Database` the caller holds, rather than the bound `AuthDb`. It exists
   * for the unit tests' `node:sqlite` D1 adapter: the `Cloudflare.D1.QueryDatabase` binding
   * resolves `AuthDb` as a resource, which needs Alchemy's `Stack`, absent in a unit test.
   */
  static readonly layerWith = (database: D1Database) =>
    Layer.effect(ShopSessionRepository, make(Effect.succeed(database)));

  /** `ShopSession` rows in memory, for tests. Every write edits the layer's own copy. */
  static readonly layerTest = (seed: ReadonlyArray<ShopSession>) =>
    Layer.sync(ShopSessionRepository, () => {
      const rows = new Map(seed.map((row) => [row.shop, row]));
      const edit = (shop: ShopKey, change: Partial<ShopSession>) =>
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
        updatePlan: ({ shop, ...plan }: Pick<ShopSession, "shop" | PlanCacheColumn>) =>
          edit(shop, plan),
        shortenPlanExpiry: ({
          shop,
          notAfter,
        }: {
          readonly shop: ShopKey;
          readonly notAfter: number;
        }) =>
          Effect.sync(() => {
            const row = rows.get(shop);
            if (row?.planHandleExpiresAt != null)
              rows.set(shop, {
                ...row,
                planHandleExpiresAt: Math.min(row.planHandleExpiresAt, notAfter),
              });
          }),
        listShopsWithStalePlan: (now: number) =>
          Effect.sync(() =>
            [...rows.values()]
              .filter((row) => row.planHandleExpiresAt === null || row.planHandleExpiresAt <= now)
              .map((row) => row.shop)
              .toSorted(),
          ),
        findRedacted: (shop: ShopKey) =>
          Effect.sync(() => Option.map(Option.fromUndefinedOr(rows.get(shop)), redact)),
        getRedactedPage: (input: RedactedPageInput) =>
          Effect.sync(() => {
            const sorted = [...rows.values()]
              .filter((row) => input.filter === undefined || row.shop.includes(input.filter))
              .toSorted((a, b) => a.shop.localeCompare(b.shop));
            const fetched =
              input.before === undefined
                ? sorted.filter((row) => input.after === undefined || row.shop > input.after)
                : sorted.filter((row) => row.shop < input.before!).toReversed();
            return redactedPage(fetched.slice(0, input.limit + 1).map(redact), input);
          }),
        remove: (shop: ShopKey) =>
          Effect.sync(() => {
            rows.delete(shop);
          }),
      };
    });
}
