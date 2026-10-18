import { useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";

/** What a procedure atom reads as before hydration: nothing pressed. */
const notPressed = Atom.make(AsyncResult.initial<unknown, unknown>());

/**
 * Whether a procedure atom's press is in flight, for a screen that keeps one tree from the
 * server's render through hydration. Before hydration it reads {@link notPressed} instead of
 * the atom: the layout's socket holder names the socket while it renders at hydration, which
 * changes every procedure atom, and a screen already subscribed to one would be updated in the
 * middle of the holder's render.
 */
export const usePressWaiting = (
  atom: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>,
): boolean => AsyncResult.isWaiting(useAtomValue(useHydrated() ? atom : notPressed));
