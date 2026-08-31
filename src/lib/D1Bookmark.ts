import { Context, Effect } from "effect";

/**
 * Per-request access to the D1 read-replica bookmark — `current` reads the
 * latest bookmark off the request's `withSession` (provided by `worker.ts`).
 * Exists only to feed the SSR seed: the router `dehydrate` hook (`src/router.tsx`)
 * reads it via a server fn and the `hydrate` hook seeds the client holder
 * (`d1BookmarkStore`) so each load starts consistent with what SSR read. The
 * server-fn response header path uses the `d1Session` directly in `worker.ts`,
 * not this service.
 *
 * `static current` is the single-yield accessor (`yield* D1Bookmark.current`)
 * over the instance field of the same name.
 */
export class D1Bookmark extends Context.Service<
  D1Bookmark,
  { readonly current: Effect.Effect<string | null> }
>()("D1Bookmark") {
  static readonly current: Effect.Effect<string | null, never, D1Bookmark> =
    D1Bookmark.pipe(Effect.flatMap((self) => self.current));
}
