import { Effect, Schema } from "effect";

/**
 * An optional search key whose unreadable value reads as absent: the value
 * decodes through `schema`, and anything `schema` refuses becomes `undefined`.
 * For a key whose recovery is "drop the filter" — no default to fall back on,
 * absence is the unfiltered list — this is the `MemberSearch` rule (`shop.$shop.tsx`,
 * "no value of these keys fails") written once.
 *
 * `undefined`, not `Option.none`: the router spreads the validated search over
 * the raw one, so a key the schema leaves out keeps the raw text it failed on,
 * and a key set to `undefined` replaces it. `undefined` is also what the router
 * leaves out of a URL it writes, so the first navigation after a bad link
 * cleans it up.
 */
export const lenientSearchKey = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(
    Schema.UndefinedOr(schema).pipe(
      // oxlint-disable-next-line unicorn/no-useless-undefined -- the value is the point; see above
      Schema.catchDecoding(() => Effect.succeedSome(undefined)),
    ),
  );
