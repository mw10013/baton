import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  clampRunLimit,
  DEFAULT_WORKFLOWS_LIST_STATE,
  RUN_PAGE,
  TEAM_SEARCH_MAX,
  WorkflowsListState,
} from "../../domain/shop-work.ts";
import { lenientSearchKey, ListSearchParam } from "./-search-params.ts";

/**
 * **The member's context, and most of it travels.** `state`, `team`, `limit` and `q` say which
 * state of the workflows list the member is looking at ({@link WorkflowsListState}), narrowed to
 * which of their teams, how far down it, and what they searched for (`RunQuery`, whose search
 * ignores the state and the team). They live on the member shop layout rather than on the list,
 * and its `retainSearchParams` copies `state`, `team` and `q` onto every link and navigation built
 * under `/shop/$key`, so the bar's way home and the workflow page's Workflows link land on the
 * state, team and search the member chose rather than on the default one. A row's link to the
 * workflow page carries them without the row knowing they exist.
 *
 * **Depth stays with one visit to the list.** `limit` is how far the member pressed Show more,
 * not a choice about what to see, so no link copies it: a list reached by a link starts at
 * {@link RUN_PAGE} rows from the top. The one return that keeps it is the history step back to
 * the list's own entry, which the Workflows link takes when the list opened the workflow page
 * (`fromWorkflowsList`): that entry's URL still holds the depth and the router restores its
 * scroll, so the member lands on the row they opened.
 *
 * Nothing here is a sharing risk: a bench tablet is one member's place, the keys name a screen
 * rather than a person, and the actor narrows every read to the teams on the connection whatever
 * the URL says.
 *
 * **No value of these keys fails.** They ride in a URL a member can edit and can outlive a team
 * they were taken off, so every one decodes to something usable: an unreadable `state` becomes the
 * default, an unreadable `q` reads as no search ({@link lenientSearchKey}), an out-of-range
 * `limit` clamps ({@link clampRunLimit}) and an unreadable one becomes a page, and `team` is
 * carried as plain text, because which ids mean anything is the teams' answer and not this
 * schema's: the Backend resolves it and reads an id the member is not on as Any team. Failing any
 * of them would put the router's error boundary over the whole member area for a typo.
 *
 * **A recovery has to name a value, not drop the key.** Returning `Option.none` from
 * `catchDecoding` reads as "no such key", and the router then hands the route the raw text that
 * failed. Every recovery answers with the default instead. For `team` and `q` the default is
 * `undefined` ({@link lenientSearchKey}), which the router writes as no key: choosing Any team
 * navigates with `team: undefined`, and recovering that to `""` would leave a `?team=` in the URL
 * that reads as Any team but is not its canonical address.
 *
 * The layout's `stripSearchParams` keeps the defaults out of the URL, so `/shop/$key/workflows`
 * with no search stays the canonical way home. An unknown key lands on the default, Started by
 * you.
 */
export const MemberSearch = Schema.Struct({
  state: Schema.optionalKey(
    WorkflowsListState.pipe(
      Schema.catchDecoding(() => Effect.succeedSome(DEFAULT_WORKFLOWS_LIST_STATE)),
    ),
  ),
  team: lenientSearchKey(
    Schema.String.pipe(
      Schema.decode({
        decode: SchemaGetter.transform((team: string) => team.slice(0, TEAM_SEARCH_MAX)),
        encode: SchemaGetter.transform((team: string) => team),
      }),
    ),
  ),
  limit: Schema.optionalKey(
    Schema.Number.pipe(
      Schema.decode({
        decode: SchemaGetter.transform(clampRunLimit),
        encode: SchemaGetter.transform((limit: number) => limit),
      }),
      Schema.catchDecoding(() => Effect.succeedSome(RUN_PAGE)),
    ),
  ),
  q: lenientSearchKey(ListSearchParam),
});
export type MemberSearch = typeof MemberSearch.Type;
