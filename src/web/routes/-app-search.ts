import { defaultStringifySearch } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What Shopify puts on the App Home's URL, read from the raw search string. The router parses each
 * search value as JSON (`embedded=1` becomes the number `1`) and rewrites the URL when
 * `validateSearch` returns anything else, so the `/app` routes keep the router's search as it is
 * and read the text Shopify sent. Shopify also sends `locale`, `session`, `timestamp` and
 * `hmac`; every redirect and link under `/app` is built from the raw string, so they survive the
 * round trip.
 */
const AppSearch = Schema.Struct({
  shop: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  embedded: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
});
const decodeSearch = Schema.decodeUnknownOption(AppSearch);

/** {@link AppSearch} from a location's `searchStr`; anything that does not decode is empty. */
export const appSearch = (searchStr: string): typeof AppSearch.Type =>
  Option.getOrElse(decodeSearch(Object.fromEntries(new URLSearchParams(searchStr))), () => ({}));

/**
 * The search keys a page under `/app` owns: a list's search and its pages. A link to another page
 * drops them, so a filter never follows the merchant onto a page it does not belong to.
 */
const PAGE_KEYS = ["state", "show", "team", "q", "after", "teamsAfter", "membersAfter"] as const;

/**
 * A link under `/app` to `path`: the raw search Shopify sent (the `/app` guards read it on every
 * navigation, {@link appSearch}), minus every page's own keys, plus `keys` as the page sets them.
 * The keys are written as the router writes a search, so a value that would parse as JSON (a team
 * named "123") comes back the string it was.
 */
export const appHref = (
  path: string,
  searchStr: string,
  keys: Partial<Record<(typeof PAGE_KEYS)[number], string | null | undefined>> = {},
) => {
  const search = new URLSearchParams(searchStr);
  for (const key of PAGE_KEYS) search.delete(key);
  const set = Object.fromEntries(
    Object.entries(keys).filter(([, value]) => value !== null && value !== undefined),
  );
  for (const [key, value] of new URLSearchParams(defaultStringifySearch(set)))
    search.set(key, value);
  const text = search.toString();
  return text === "" ? path : `${path}?${text}`;
};
