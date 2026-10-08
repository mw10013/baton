import { retainSearchParams } from "@tanstack/react-router";
import { Effect, Schema, SchemaGetter } from "effect";

import * as Domain from "@/lib/Domain";

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

/**
 * **A bare order number in the URL is the search.** The router JSON-encodes
 * every search value, so a search the app writes is `?q="1575"` and comes
 * back a string, but a merchant who types or shares `?q=1575` by hand gets
 * the number 1575 from the parser, which `Domain.ListSearch` refuses and
 * {@link lenientSearchKey} would then drop as no search: a URL that looked
 * right would open the unfiltered list. A number is read as its digits;
 * everything else is the string it already was. Only the read widens: the
 * app keeps writing the string form, and `q` is the one key a person would
 * type, since a position is a word and a team or cursor is an id. The
 * member's `MemberSearch` (`shop.$shop.tsx`) reads `q` with this too.
 */
export const ListSearchParam = Schema.Union([
  Schema.String,
  Schema.Number,
]).pipe(
  Schema.decodeTo(Domain.ListSearch, {
    // oxlint-disable-next-line unicorn/prefer-native-coercion-functions -- bare `String` is typed `(value?: any) => string` and loses the union
    decode: SchemaGetter.transform((value: string | number) => String(value)),
    encode: SchemaGetter.transform((q) => q),
  }),
);

/**
 * **A section's filters stay in the section.** `retainSearchParams` copies
 * the listed keys from the current search into every navigation under the
 * layout, whatever page the navigation comes from, and the orders and the
 * workflows layouts share the keys `q` and `after`: a merchant who searched
 * an order by number, opened it and pressed Workflows in the nav found the
 * workflows list filtered to that number ("No workflow matches 1210"). The
 * router's middleware sees the searches, not the pages, so this reads the
 * page the navigation leaves from the browser (`window.location`, still the
 * old location while the next one is built) and retains only when it is
 * under `path`. On the server there is no navigation to retain into: the
 * first render reads the URL as it is.
 */
export const retainSearchParamsUnder = <TSearchSchema extends object>(
  path: string,
  keys: readonly (keyof TSearchSchema)[],
) => {
  const retain = retainSearchParams<TSearchSchema>([...keys]);
  return (context: Parameters<typeof retain>[0]) =>
    typeof window !== "undefined" && window.location.pathname.startsWith(path)
      ? retain(context)
      : context.next(context.search);
};
