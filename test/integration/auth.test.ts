import { describe, it } from "@effect/vitest";
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils";
import { getSchema } from "better-auth/db";
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Schema } from "effect";
import { afterEach } from "vitest";

import { Auth, magicLinkKvKey } from "@/lib/Auth";
import { D1Primary } from "@/lib/D1Primary";
import { D1Session } from "@/lib/D1Session";
import * as Domain from "@/lib/Domain";
import { Email } from "@/lib/Email";
import { KV } from "@/lib/KV";
import { makeEnvLayer } from "@/lib/LayerEx";
import { Repository } from "@/lib/Repository";

const envLayer = makeEnvLayer(env);
const repositoryLayer = Layer.provideMerge(
  Repository.layerNoDeps,
  Layer.mergeAll(
    D1Session.layer(env.D1),
    Layer.provide(D1Primary.layerNoDeps, envLayer),
    envLayer,
  ),
);
const kvLayer = Layer.provideMerge(KV.layerNoDeps, envLayer);
const emailLayer = Layer.provide(Email.layerNoDeps, envLayer);
const authLayer = Layer.provideMerge(
  Auth.layerNoDeps,
  Layer.mergeAll(kvLayer, repositoryLayer, emailLayer, envLayer),
);
const layer = Layer.mergeAll(authLayer, kvLayer, repositoryLayer);

const run = <A, E>(effect: Effect.Effect<A, E, Auth | KV | Repository>) =>
  effect.pipe(Effect.provide(layer));

const shop = Schema.decodeUnknownSync(Domain.Shop)("member.myshopify.com");
const emailOf = Schema.decodeUnknownSync(Domain.Email);

/**
 * The sign-in gate requires a `Member` row, and `Member.shop` FKs to
 * `ShopSession` — so a member email needs the full install chain seeded.
 */
const seedMember = (email: Domain.Email) =>
  Effect.gen(function* () {
    const repository = yield* Repository;
    yield* repository.upsertShopSession({
      shop,
      shopGid: Schema.decodeUnknownSync(Domain.ShopGid)("gid://shopify/Shop/1"),
      shopAgentId: Schema.decodeUnknownSync(Domain.ShopAgentId)(
        `agent-${shop}`,
      ),
      scope: "read_products",
      accessTokenExpiresAt: null,
      accessToken: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
    yield* repository.addMember({ shop, email });
  });

/**
 * Full magic-link round trip without email: request the link, read the cached
 * URL back from KV, follow it through `auth.handler` (the same code path as
 * the `/api/auth/$` catch-all), and return a `Headers` carrying the session
 * cookies the verify response set.
 */
const signIn = (email: string) =>
  Effect.gen(function* () {
    const auth = yield* Auth;
    const kv = yield* KV;
    yield* auth.signInMagicLink({
      headers: new Headers(),
      email,
      callbackURL: "/login-callback",
    });
    const url = yield* kv.get(magicLinkKvKey(email));
    if (url === null) return yield* Effect.die("magic link not cached in KV");
    const response = yield* auth.handler(
      new Request(url, { redirect: "manual" }),
    );
    strictEqual(response.status, 302);
    const cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    return { headers: new Headers({ cookie }), response };
  });

afterEach(async () => {
  await env.D1.batch([
    env.D1.prepare("delete from User"),
    env.D1.prepare("delete from Verification"),
    env.D1.prepare("delete from Member"),
    env.D1.prepare("delete from ShopSession"),
  ]);
});

/**
 * Sqlite storage classes this migration is allowed to declare per better-auth
 * field type. Dates are ISO-8601 TEXT here (better-auth writes
 * `toISOString()`); its own differ would merely warn about that, so TEXT is
 * accepted alongside the types its sqlite map lists.
 */
const ALLOWED_COLUMN_TYPES: Record<string, readonly string[]> = {
  string: ["TEXT"],
  number: ["INTEGER", "REAL", "BIGINT", "NUMERIC"],
  boolean: ["INTEGER", "BOOLEAN"],
  date: ["TEXT", "DATE", "INTEGER"],
  json: ["TEXT"],
};

describe("auth schema", () => {
  /**
   * Drift check replacing `getMigrations(auth.options)`: that differ's index
   * introspection joins `pragma_index_list(tables.name)` against
   * `sqlite_master` with a dynamic argument, which D1's authorizer rejects
   * (SQLITE_AUTH) — constant-argument pragma table functions are allowed. So
   * this diffs the same ground truth (`getSchema(auth.options)`, which
   * `getMigrations` itself reads) against D1 using constant-arg pragmas:
   * every table, column, and resolved table-level index better-auth expects
   * must exist in the hand-written migration, re-proven on every
   * `better-auth` version bump.
   */
  it.effect(
    "hand-written migration matches better-auth's runtime expectations",
    () =>
      run(
        Effect.gen(function* () {
          const auth = yield* Auth;
          const schema = getSchema(auth.options);
          assertTrue(Object.keys(schema).length > 0);
          for (const [tableName, definition] of Object.entries(schema)) {
            const { results: columns } = yield* Effect.tryPromise(() =>
              env.D1.prepare(
                `select name, type from pragma_table_info('${tableName}')`,
              ).all<{ name: string; type: string }>(),
            );
            const columnTypes = new Map(
              columns.map(({ name, type }) => [name, type.toUpperCase()]),
            );
            assertTrue(columnTypes.has("id"), `${tableName}.id missing`);
            for (const [fieldName, field] of Object.entries(
              definition.fields,
            )) {
              const columnType = columnTypes.get(fieldName);
              assertTrue(
                columnType !== undefined,
                `${tableName}.${fieldName} missing`,
              );
              assertTrue(
                (ALLOWED_COLUMN_TYPES[field.type as string] ?? []).includes(
                  columnType ?? "",
                ),
                `${tableName}.${fieldName}: ${columnType} not valid for ${String(field.type)}`,
              );
            }
            for (const index of definition.indexes ?? []) {
              const { results: indexes } = yield* Effect.tryPromise(() =>
                env.D1.prepare(
                  `select name, "unique" as isUnique from pragma_index_list('${tableName}')`,
                ).all<{ name: string; isUnique: number }>(),
              );
              const found = indexes.find((row) => row.name === index.name);
              assertTrue(
                found !== undefined,
                `${tableName} index ${index.name} missing`,
              );
              strictEqual(found?.isUnique, index.unique ? 1 : 0);
              const { results: indexColumns } = yield* Effect.tryPromise(() =>
                env.D1.prepare(
                  `select name from pragma_index_info('${index.name}')`,
                ).all<{ name: string }>(),
              );
              deepStrictEqual(
                indexColumns.map(({ name }) => name),
                [...index.columns],
              );
            }
          }
        }),
      ),
  );
});

describe("magic-link sign-in", () => {
  it.effect("creates a verified user with a session for a member email", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const email = emailOf("member@example.com");
        yield* seedMember(email);
        const { headers } = yield* signIn(email);
        const sessionContext = yield* auth.getSession(headers);
        assertTrue(Option.isSome(sessionContext));
        const { session, user } = Option.getOrThrow(sessionContext);
        strictEqual(user.email, email);
        strictEqual(user.emailVerified, true);
        strictEqual(user.role, "user");
        strictEqual(user.banned, false);
        strictEqual(session.userId, user.id);
      }),
    ),
  );

  it.effect(
    "blocks first sign-in for an email with no Member row (user.create.before backstop)",
    () =>
      run(
        Effect.gen(function* () {
          const auth = yield* Auth;
          const { headers, response } = yield* signIn("intruder@example.com");
          assertTrue(
            (response.headers.get("location") ?? "").includes("error="),
          );
          const sessionContext = yield* auth.getSession(headers);
          assertTrue(Option.isNone(sessionContext));
          const { results } = yield* Effect.tryPromise(() =>
            env.D1.prepare("select id from User").all(),
          );
          strictEqual(results.length, 0);
        }),
      ),
  );

  it.effect(
    "rejects an expired or invalid token with a redirect to error",
    () =>
      run(
        Effect.gen(function* () {
          const auth = yield* Auth;
          const response = yield* auth.handler(
            new Request(
              "http://localhost/api/auth/magic-link/verify?token=bogus&callbackURL=/login-callback",
              { redirect: "manual" },
            ),
          );
          strictEqual(response.status, 302);
          assertTrue(
            (response.headers.get("location") ?? "").includes("error="),
          );
        }),
      ),
  );

  it.effect("membership revocation removes the shop from listMemberShops", () =>
    run(
      Effect.gen(function* () {
        const repository = yield* Repository;
        const email = emailOf("revoked@example.com");
        yield* seedMember(email);
        deepStrictEqual(yield* repository.listMemberShops(email), [shop]);
        yield* repository.deleteMember({ shop, email });
        deepStrictEqual(yield* repository.listMemberShops(email), []);
      }),
    ),
  );
});
