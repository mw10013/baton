import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useHydrated, useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { useContext, useState } from "react";
import { seedIfAbsentInBrowser } from "../client/live-load.ts";

/** What {@link useLiveRead} answers: the value shown, and the read's own state. */
export interface LiveRead<A> {
  readonly value: A;
  /** The socket's read failed; `value` is the last one it had, or the loader's. */
  readonly failed: boolean;
  /** A refetch is in flight. */
  readonly waiting: boolean;
}

/**
 * A live screen's read, for a screen that keeps one tree from the server's render through
 * hydration (one `s-page` alive): until React has hydrated it is `loaded`, the loader's answer,
 * and reads an idle atom of its own instead of `atom`; from then on it reads `atom`, so the first
 * live render shows what the loader read and the socket only keeps it current. The idle atom
 * stands in before hydration because the layout's socket holder names the socket while it renders
 * at hydration, which changes every socket atom, and a screen already subscribed to one would be
 * updated in the middle of the holder's render (`usePressWaiting` has the same rule for presses).
 *
 * It never refreshes: the loader seeded `query`'s node (`liveLoad`), and notices keep it current.
 * The one seed here is for the page the server rendered, whose loader ran on the server: its node
 * is absent from the browser's registry, so the first render stores `loaded` for it, stamped with
 * the leaf match's `updatedAt` (a live screen is its leaf route's page). That runs in a `useState`
 * initializer, inside a render, which is safe because it only stores a value when no node exists
 * (`seedIfAbsent`), so StrictMode's second run changes nothing.
 */
export const useLiveRead = <A, E>(input: {
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  /** The serializable query `atom` wraps, whose node the loader seeds; none for a read no loader seeds. */
  readonly query?: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  readonly loaded: A;
}): LiveRead<A> => {
  const hydrated = useHydrated();
  const registry = useContext(RegistryContext);
  const router = useRouter({ warn: false });
  const [idle] = useState(() => {
    if (input.query !== undefined)
      seedIfAbsentInBrowser(
        registry,
        input.query,
        input.loaded,
        router?.state.matches.at(-1)?.updatedAt ?? Date.now(),
      );
    return Atom.make(AsyncResult.initial<A, E>());
  });
  const result = useAtomValue(hydrated ? input.atom : idle);
  return {
    value: Option.getOrElse(AsyncResult.value(result), () => input.loaded),
    failed: AsyncResult.isFailure(result),
    waiting: AsyncResult.isWaiting(result),
  };
};
