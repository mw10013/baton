import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

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
 * and reads an idle atom of its own instead of `atom`; from then on it seeds `atom`'s node with
 * `loaded` (`seed`) and reads it, so the first live render shows what the loader read and the
 * socket only keeps it current. The idle atom stands in before hydration because the layout's
 * socket holder names the socket while it renders at hydration, which changes every socket atom,
 * and a screen already subscribed to one would be updated in the middle of the holder's render
 * (`usePressWaiting` has the same rule for presses).
 *
 * `key` names the node: a new key (a new page or filter) is a new node to seed; a node already
 * there (shown before) is refetched instead. A new `loaded` for the same key refetches the node
 * too: the router renders a page it has shown before with its cached loader answer, then reloads
 * it in the background, so the first `loaded` of a revisit can be stale, and the node seeded from
 * it would keep it until the next notice.
 */
export const useLiveRead = <A, E>(input: {
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>;
  readonly key: string;
  readonly loaded: A;
  readonly seed: (registry: AtomRegistry.AtomRegistry, loaded: A) => void;
}): LiveRead<A> => {
  const hydrated = useHydrated();
  const registry = useContext(RegistryContext);
  const [idle] = useState(() => Atom.make(AsyncResult.initial<A, E>()));
  /** The key and the answer the node was last seeded or refreshed for. */
  const seeded = useRef<{ readonly key: string; readonly loaded: A } | null>(null);
  useMemo(
    () => {
      if (!hydrated) return;
      seeded.current = { key: input.key, loaded: input.loaded };
      input.seed(registry, input.loaded);
    },
    // Once per node shown, so not on `loaded`, which changes with its key: a refresh of the node
    // this render reads would notify it mid-render. The effect below takes a new answer.
    [hydrated, registry, input.key],
  );
  useEffect(() => {
    const last = seeded.current;
    if (last === null || last.key !== input.key || last.loaded === input.loaded) return;
    seeded.current = { key: input.key, loaded: input.loaded };
    input.seed(registry, input.loaded);
  });
  const result = useAtomValue(hydrated ? input.atom : idle);
  return {
    value: Option.getOrElse(AsyncResult.value(result), () => input.loaded),
    failed: AsyncResult.isFailure(result),
    waiting: AsyncResult.isWaiting(result),
  };
};
