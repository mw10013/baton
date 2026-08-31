import type * as ShopifyApi from "@shopify/shopify-api";

import { D1Client } from "@effect/sql-d1";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-do";
import { Agent, callable, getCurrentAgent, type Connection } from "agents";
import {
  Clock,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
  type SchemaAST,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";

import { CounterRepository } from "@/lib/CounterRepository";
import { CurrentShopifySession } from "@/lib/CurrentShopifySession";
import * as Domain from "@/lib/Domain";
import {
  causeToErrorMessage,
  makeEnvLayer,
  makeLoggerLayer,
} from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";
import { Shopify } from "@/lib/Shopify";
import { ShopifyAdmin } from "@/lib/ShopifyAdmin";

class ShopAgentNotifyError extends Schema.TaggedError<ShopAgentNotifyError>()(
  "ShopAgentNotifyError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Scaffolding shared by every decoding ShopAgent RPC method: decode the wire
 * input against `schema`, hand the decoded value to the business `handler`,
 * and wrap both under `Effect.withLogSpan(name)`.
 *
 * Data-last and curried:
 * `callableEffect(name, schema, options?)(handler)(input)` — a method body is
 * just `this.runEffect(callableEffect(...)(businessHandler)(input))`.
 *
 * `options` passes through to `Schema.decodeUnknownEffect`, which accepts
 * `ParseOptions` at decoder creation. Browser-reachable input decodes strict
 * (`{ onExcessProperty: "error" }`); trusted server-to-server input can decode
 * lax.
 *
 * A decode failure escapes as `SchemaError`, becoming a thrown fault at the
 * `runEffect` seam.
 */
const callableEffect =
  <A>(
    name: string,
    schema: Schema.ConstraintDecoder<A>,
    options?: SchemaAST.ParseOptions,
  ) =>
  <B, E, R>(handler: (input: A) => Effect.Effect<B, E, R>) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(
      schema,
      options,
    )(input).pipe(Effect.flatMap(handler), Effect.withLogSpan(name));

/**
 * The Durable Object's private SQLite schema, versioned through
 * `SqliteMigrator` rather than a bare `create table if not exists` block, so
 * the second migration has somewhere to go.
 *
 * `Counter` is the skeleton's demo domain — see {@link CounterRepository}. The
 * `check (id = 1)` primary key with a seeded row makes "exactly one row per
 * shop" a schema fact; the seed is `insert or ignore` so re-running the
 * migration on an existing object is a no-op.
 */
const initializeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    create table if not exists Counter (
      id integer primary key check (id = 1),
      count integer not null check (count >= 0),
      updatedAt integer
    )
  `;
  yield* sql`
    insert or ignore into Counter (id, count, updatedAt) values (1, 0, null)
  `;
});

export const runShopAgentMigrations = SqliteMigrator.run({
  loader: SqliteMigrator.fromRecord({
    "1_initialize schema": initializeSchema,
  }),
}).pipe(
  Effect.tapCause((cause) =>
    Effect.logError(
      `ShopAgent migrations failed: ${causeToErrorMessage(cause)}`,
    ),
  ),
  Effect.asVoid,
);

/**
 * Two SQL stores coexist. `Repository` runs over D1 (shared, sessions);
 * `CounterRepository` runs over the DO's private SQLite (`ctx.storage`,
 * per-shop). Both `D1Client.layer` and `SqliteClient.layer` export a
 * `SqlClient` tag, so ordering matters: the SQLite `provideMerge` comes
 * **after** the D1 `repositoryLayer`, making the ambient `SqlClient` resolve to
 * SQLite. That is what `runShopAgentMigrations` (which requests `SqlClient`
 * directly) needs. Each repository closes over its own client at layer-build
 * time, so the ambient tag only governs the migration.
 */
const makeRunEffect = (env: Env, storage: DurableObjectStorage) => {
  const envLayer = makeEnvLayer(env);
  const repositoryLayer = Layer.provideMerge(
    Repository.layerNoDeps,
    Layer.merge(D1Client.layer({ db: env.D1 }), envLayer),
  );
  const shopifyLayer = Layer.provideMerge(Shopify.layerNoDeps, repositoryLayer);
  const durableRepositoryLayer = CounterRepository.layer.pipe(
    Layer.provideMerge(SqliteClient.layer({ storage })),
  );
  const layer = Layer.mergeAll(
    makeLoggerLayer(env),
    repositoryLayer,
    shopifyLayer,
    durableRepositoryLayer,
    FetchHttpClient.layer,
  );
  const runtime = ManagedRuntime.make(layer);
  return async <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layer>>,
  ): Promise<A> => {
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    throw new Error(causeToErrorMessage(exit.cause));
  };
};

/**
 * `ShopifyAdmin` is the one stack {@link makeRunEffect} cannot hold.
 * `ShopifyAdmin.layerNoDeps` closes over a concrete session at build time, and
 * `ManagedRuntime` memoizes what it builds — so a runtime-level `ShopifyAdmin`
 * would pin whichever offline token was live when the Durable Object was
 * constructed and keep using it after `Shopify.refreshSessionIfExpired` had
 * rotated it, on an instance that lives for hours. Built per call instead, from
 * the session `ensureSession` just returned. `Shopify` and `Env`, the stack's
 * other requirements, are ambient and resolve from the runtime.
 */
const shopifyAdminLayer = (session: ShopifyApi.Session) =>
  Layer.provide(
    ShopifyAdmin.layerNoDeps,
    Layer.succeed(CurrentShopifySession, session),
  );

const shopInfoQuery = `#graphql
  query ShopInfo {
    shop {
      name
      myshopifyDomain
    }
  }`;

const ShopInfoResponse = Schema.Struct({ shop: Domain.ShopInfo });

/**
 * Per-shop Durable Object concurrency relies on the platform rather than an
 * application lock. Durable Objects run one synchronous JavaScript turn at a time;
 * `SqlStorage.exec()` is synchronous, and Cloudflare input gates protect the
 * Promise-based `storage.transaction()` used by Effect's SQLite adapter. Once a
 * transaction completes, connection attachment updates and WebSocket sends below
 * are synchronous in the resumed turn. `blockConcurrencyWhile()` is therefore only
 * needed for constructor migrations. Revisit this only if a state transition starts
 * awaiting non-storage I/O such as `fetch()`.
 *
 * The object is addressed by shop domain (`env.SHOP_AGENT.getByName(shop)`), so
 * `this.name` is the shop and no method takes one.
 */
export class ShopAgent extends Agent {
  declare private readonly runEffect: ReturnType<typeof makeRunEffect>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        Domain.SocketKeepalivePing,
        Domain.SocketKeepalivePong,
      ),
    );
    this.runEffect = makeRunEffect(env, ctx.storage);
    void ctx.blockConcurrencyWhile(() =>
      this.runEffect(runShopAgentMigrations),
    );
  }

  private connectionState(
    connection: Connection,
  ): Domain.ConnectionState | null {
    return Option.getOrNull(
      Schema.decodeUnknownOption(Domain.ConnectionAttachment)(
        connection.state,
        { onExcessProperty: "error" },
      ),
    );
  }

  private connections() {
    return Effect.try({
      try: () => [...this.getConnections()],
      catch: (cause) =>
        new ShopAgentNotifyError({ message: "getConnections failed", cause }),
    });
  }

  private notifyConnection(connection: Connection) {
    return Effect.try({
      try: () => {
        if (this.connectionState(connection))
          connection.send(
            JSON.stringify({
              type: "invalidated",
            } satisfies Domain.InvalidatedMessage),
          );
      },
      catch: (cause) =>
        new ShopAgentNotifyError({ message: "invalidated send failed", cause }),
    }).pipe(
      Effect.ignore({
        log: "Debug",
        message: `ShopAgent.notifyConnection: shop=${this.name}`,
      }),
    );
  }

  /**
   * Invalidations are best-effort hints, never the new value: SQLite stays
   * authoritative and an attaching tab refetches, so a dropped push costs a
   * stale render until the next activation rather than a lost write. That is
   * why a send failure is swallowed here instead of failing the mutation that
   * triggered it.
   */
  private notifyChanged() {
    return this.connections().pipe(
      Effect.flatMap((connections) =>
        Effect.forEach(
          connections,
          (connection) => this.notifyConnection(connection),
          { discard: true },
        ),
      ),
      Effect.ignore({
        log: "Debug",
        message: `ShopAgent.notifyChanged: shop=${this.name}`,
      }),
    );
  }

  /**
   * Subscribes the calling connection to invalidations and returns the current
   * value, in one round trip so a tab cannot miss a change between reading and
   * attaching.
   *
   * The `sessionToken` is minted per route mount and stored on the connection
   * so {@link deactivate} from an unmounted previous mount — the `/app` socket
   * is shared across route changes — cannot detach the mount that replaced it.
   */
  @callable()
  activate(input: Domain.SessionTokenInput): Promise<Domain.Counter> {
    const shop = this.name;
    return this.runEffect(
      callableEffect("ShopAgent.activate", Domain.SessionTokenInput, {
        onExcessProperty: "error",
      })(({ sessionToken }) =>
        Effect.gen(function* () {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (connection) connection.setState({ sessionToken });
          yield* Effect.logDebug(`ShopAgent.activate: shop=${shop}`).pipe(
            Effect.annotateLogs({ shop }),
          );
          return yield* (yield* CounterRepository).get();
        }),
      )(input),
    );
  }

  @callable()
  deactivate(input: Domain.SessionTokenInput): Promise<void> {
    return this.runEffect(
      callableEffect("ShopAgent.deactivate", Domain.SessionTokenInput, {
        onExcessProperty: "error",
      })(({ sessionToken }) =>
        Effect.sync(() => {
          const { connection } = getCurrentAgent<ShopAgent>();
          if (
            connection &&
            this.connectionState(connection)?.sessionToken === sessionToken
          )
            connection.setState(null);
        }),
      )(input),
    );
  }

  /**
   * The demo write: browser → WebSocket RPC → SQLite → broadcast. Every open
   * tab for this shop refetches, including the one that clicked.
   *
   * Browser-reachable and taking no arguments, which is the point: nothing a
   * tab can name reaches storage. A real mutation that must respect a plan
   * ceiling takes the ceiling as a required argument resolved from D1 by the
   * Worker, and is therefore reachable only through `ShopAgentClient` from a
   * server function — never `@callable()`.
   */
  @callable()
  bump(): Promise<Domain.Counter> {
    const shop = this.name;
    const notifyChanged = () => this.notifyChanged();
    return this.runEffect(
      Effect.gen(function* () {
        const counter = yield* (yield* CounterRepository).bump(
          yield* Clock.currentTimeMillis,
        );
        yield* Effect.logInfo(
          `ShopAgent.bump: shop=${shop} count=${String(counter.count)}`,
        ).pipe(Effect.annotateLogs({ shop, count: counter.count }));
        yield* notifyChanged();
        return counter;
      }).pipe(Effect.withLogSpan("ShopAgent.bump")),
    );
  }

  /**
   * Reads the shop back out of the Shopify Admin API from inside the object,
   * using the offline session `ensureSession` resolves (and refreshes) from D1.
   *
   * Not `@callable()`: it spends a Shopify API call, so it stays on the
   * `ShopAgentClient` path where the Worker has already authenticated the
   * request.
   */
  getShopInfo(): Promise<Domain.ShopInfo> {
    const name = this.name;
    return this.runEffect(
      Effect.gen(function* () {
        const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(name);
        const session = yield* (yield* Shopify).ensureSession(shop);
        const { shop: info } = yield* ShopifyAdmin.pipe(
          Effect.flatMap((admin) =>
            admin.graphqlDecode(ShopInfoResponse, shopInfoQuery),
          ),
          Effect.provide(shopifyAdminLayer(session)),
        );
        return info;
      }).pipe(Effect.withLogSpan("ShopAgent.getShopInfo")),
    );
  }

  getCounter(): Promise<Domain.Counter> {
    return this.runEffect(
      CounterRepository.pipe(
        Effect.flatMap((repository) => repository.get()),
        Effect.withLogSpan("ShopAgent.getCounter"),
      ),
    );
  }

  /**
   * Everything the admin drill-down reads out of this object, in one RPC.
   * Counters and stored rows only — the plan-derived ceilings they are
   * displayed against live in D1 and are attached by the route.
   */
  getAdminSnapshot(): Promise<Domain.AdminShopAgentSnapshot> {
    return this.runEffect(
      Effect.gen(function* () {
        return {
          counter: yield* (yield* CounterRepository).get(),
        } satisfies Domain.AdminShopAgentSnapshot;
      }).pipe(Effect.withLogSpan("ShopAgent.getAdminSnapshot")),
    );
  }
}
