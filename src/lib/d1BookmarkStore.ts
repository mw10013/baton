/**
 * The D1 read-replica bookmark for this browser tab, sent on the next server-fn
 * request (`x-d1-bookmark`). Safe as a module `let` because it's **client-only**:
 * a browser bundle's module scope is per tab (one user, one shop). On the server
 * a reused isolate would make this cross-tenant — but the only writers are
 * client-only (`src/start.ts` fetch, `src/router.tsx` `hydrate` hook); the
 * server reads its inbound bookmark off the request header in `worker.ts`, never
 * here.
 */
const SENTINELS = new Set(["first-unconstrained", "first-primary"]);

let bookmark = "first-unconstrained";

export const getD1Bookmark = () => bookmark;

/**
 * Advance the held bookmark **monotonically** — never replace a newer bookmark
 * with an older one.
 *
 * The bookmark is a *lower bound* on freshness for the next request, so the
 * holder must only ever move forward. Plain last-writer-wins is unsafe once more
 * than one response can land out of order:
 *
 * - **Concurrent mutations.** A single navigation can fire several server fns at
 *   once; each reads the same starting bookmark and the worker returns a fresh
 *   one per response. The write returns a higher bookmark, a read-only fn a lower
 *   one, and responses resolve in arbitrary order — so a later-resolving *lower*
 *   bookmark would clobber the write's higher one, dropping read-your-writes for
 *   the next request.
 * - **SSR-seed race.** the `hydrate` hook (`src/router.tsx`) seeds the SSR
 *   bookmark on client hydration, which can run *after* an early client server-fn
 *   has already advanced the holder; the (older) seed must not regress it.
 *
 * Ordering is by plain string comparison: D1 bookmarks are fixed-width hex
 * segments (e.g. `00000085-0000024c-00004c6d-…`) "designed to be lexically
 * comparable: a bookmark representing an earlier point in time compares less
 * than one representing a later point" (cloudflare-docs durable-objects
 * sqlite-storage-api / d1 time-travel).
 *
 * The **sentinel guard** is the subtle part. The holder starts at a
 * `"first-*"` sentinel, which begins with `f` and therefore sorts *above* real
 * hex bookmarks (`f` > `0`). A bare `next > bookmark` (the previous
 * `advanceD1Bookmark` bug) would thus reject every first real advance off the
 * sentinel. We check the *current holder* for a sentinel explicitly rather than
 * relying on lexical position. The incoming `next` is never a sentinel: the
 * worker only ever sets `x-d1-bookmark` from `getBookmark()` (`string | null`),
 * a real bookmark or null — so only the holder side needs the sentinel check,
 * and a null/empty `next` is ignored.
 */
export const setD1Bookmark = (next: string | null) => {
  if (!next) return;
  if (SENTINELS.has(bookmark) || next > bookmark) bookmark = next;
};
