import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { useContext, useState } from "react";

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

/**
 * Presses on keyed mutation atoms (one atom per item, run or task, as `syncOrderAtom` is), for a
 * screen with a press per row that keeps one tree through hydration: a hook per row's atom would
 * need a component per row swapped in at hydration. `press` sets the atom and answers its `Exit`
 * once settled, as `useAtomSet`'s `promiseExit` mode does; nothing subscribes before a press, so
 * the socket is never touched before hydration. `busy` is true before hydration (nothing
 * presses yet) and while any press is in flight.
 */
export const useKeyedPresses = () => {
  const registry = useContext(RegistryContext);
  const hydrated = useHydrated();
  const [inFlight, setInFlight] = useState(0);
  const press = async <W, A, E>(
    atom: Atom.Writable<AsyncResult.AsyncResult<A, E>, W>,
    value: W,
  ): Promise<Exit.Exit<A, E>> => {
    setInFlight((n) => n + 1);
    try {
      registry.set(atom, value);
      return await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
      );
    } finally {
      setInFlight((n) => n - 1);
    }
  };
  return { busy: !hydrated || inFlight > 0, inFlight: inFlight > 0, press };
};
