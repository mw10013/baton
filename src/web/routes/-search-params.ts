import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { ListSearch } from "../../domain/shop-work.ts";

/**
 * An optional search key whose unreadable value reads as absent: the value decodes through
 * `schema`, and anything `schema` refuses becomes `undefined`. For a key whose recovery is "drop
 * the filter" (no default to fall back on, absence is the unfiltered list), as `OrdersSearch`'s
 * `after` is.
 *
 * `undefined`, not `Option.none`: the router spreads the validated search over the raw one, so a
 * key the schema leaves out keeps the raw text it failed on, and a key set to `undefined`
 * replaces it. `undefined` is also what the router leaves out of a URL it writes, so the first
 * navigation after a bad link cleans it up.
 */
export const lenientSearchKey = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(
    Schema.UndefinedOr(schema).pipe(Schema.catchDecoding(() => Effect.succeedSome(undefined))),
  );

/**
 * **A bare number in the URL is the search.** The router JSON-encodes every search value, so a
 * search the app writes is `?q="1575"` and comes back a string, but a merchant who types or
 * shares `?q=1575` by hand gets the number 1575 from the parser, which {@link ListSearch} refuses
 * and {@link lenientSearchKey} would then drop as no search: a URL that looked right would open
 * the unfiltered list. A number is read as its digits; everything else is the string it already
 * was. Only the read widens: the app keeps writing the string form.
 */
export const ListSearchParam = Schema.Union([Schema.String, Schema.Number]).pipe(
  Schema.decodeTo(ListSearch, {
    decode: SchemaGetter.transform((value: string | number) => String(value)),
    encode: SchemaGetter.transform((q) => q),
  }),
);
