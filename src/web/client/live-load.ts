import { createIsomorphicFn } from "@tanstack/react-start";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";

/** A live read's inner query: the serializable atom a page's `liveQuery` wraps. */
type Query<A, E> = Atom.Atom<AsyncResult.AsyncResult<A, E>>;

const serializableOf = <A, E>(query: Query<A, E>) => {
  if (!Atom.isSerializable(query))
    throw new Error("only a query with a serializationKey is seeded");
  return query[Atom.SerializableTypeId];
};

/**
 * Fills `query`'s node with a value a server function read at `readAt` (epoch milliseconds), as
 * if the query had answered then, and keeps the node (its idle TTL starts now). A node that is
 * already there takes the value too: the registry hands a stored value to every `ensureNode` for
 * its key, and a node with no `initialValueTarget` (an inner query) sets it, valid, with no fetch.
 */
export const seed = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  query: Query<A, E>,
  value: A,
  readAt: number,
) => {
  const { key, encode } = serializableOf(query);
  registry.setSerializable(key, encode(AsyncResult.success(value, { timestamp: readAt })));
  registry.get(query);
};

/**
 * Stores `value` for `query`'s node only when the registry has no node for it, without creating
 * one: the next read of `query` consumes it. Safe inside a render, and idempotent, so React may
 * run it twice: it only stores, and a second run stores the same value.
 */
export const seedIfAbsent = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  query: Query<A, E>,
  value: A,
  readAt: number,
) => {
  const { key, encode } = serializableOf(query);
  if (registry.getNodes().has(key)) return;
  registry.setSerializable(key, encode(AsyncResult.success(value, { timestamp: readAt })));
};

const seedIfAbsentImpl = createIsomorphicFn()
  .client(
    (registry: AtomRegistry.AtomRegistry, query: Query<any, any>, value: unknown, readAt: number) =>
      seedIfAbsent(registry, query, value, readAt),
  )
  .server(() => {});

/** {@link seedIfAbsent} in the browser, nothing on the server: the server's registry never holds a live read. */
export const seedIfAbsentInBrowser = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  query: Query<A, E>,
  value: A,
  readAt: number,
): void => seedIfAbsentImpl(registry, query, value, readAt);

/** The live read inside a loader's answer: the query it seeds, and the value it seeds it with. */
export interface LiveRead<A, E> {
  readonly query: Query<A, E>;
  readonly value: A;
}

/** What every live loader hands {@link liveLoad} and {@link liveLoadAnswer}. */
interface LoaderInput {
  /** The router context's registry. */
  readonly registry: AtomRegistry.AtomRegistry;
}

/** How many {@link reloadFromServer} reloads are running in a registry. */
const serverReloads = Atom.make(0).pipe(Atom.keepAlive);

/** Whether a {@link reloadFromServer} is running, so a live loader reads over HTTP. */
const readsFromServer = (registry: AtomRegistry.AtomRegistry) => registry.get(serverReloads) > 0;

/**
 * `router.invalidate()` for a caller that wants the server's answer, not the registry's (a
 * membership change, a refused socket): every live loader it reruns reads over HTTP and reseeds.
 * A loader's `cause` cannot say this: the router calls a match `stay` whenever the same route
 * holds the same place in the tree, so a filter or a page change is a `stay` too.
 *
 * @see refs/tan-router/packages/router-core/src/router.ts (`matchRoutesInternal`, `previousAt`)
 */
export const reloadFromServer = async (
  registry: AtomRegistry.AtomRegistry,
  router: { readonly invalidate: () => Promise<void> },
) => {
  registry.set(serverReloads, registry.get(serverReloads) + 1);
  try {
    await router.invalidate();
  } finally {
    registry.set(serverReloads, registry.get(serverReloads) - 1);
  }
};

/** A kept node's value, or undefined when there is no node or no value in it. */
const keptValue = <A, E>(registry: AtomRegistry.AtomRegistry, query: Query<A, E>) => {
  const node = registry.getNodes().get(serializableOf(query).key);
  if (node === undefined) return undefined;
  // A kept node a notice marked stale builds here, so its refetch starts now; its last value
  // answers the loader meanwhile, and the screen shows the read as waiting.
  const result: AsyncResult.AsyncResult<A, E> = node.value();
  return AsyncResult.isSuccess(result) ? result : undefined;
};

/** Reads over HTTP and seeds the live read inside the answer, stamped with when it came back. */
const fetchAndSeed = async <Answer, A, E>(
  registry: AtomRegistry.AtomRegistry,
  fetch: () => Promise<Answer>,
  live: (answer: Answer) => LiveRead<A, E>,
) => {
  const answer = await fetch();
  const read = live(answer);
  seed(registry, read.query, read.value, Date.now());
  return answer;
};

const liveLoadImpl = createIsomorphicFn()
  .client(
    (
      input: LoaderInput & { readonly query: Query<any, any>; readonly fetch: () => Promise<any> },
    ) => {
      const kept = readsFromServer(input.registry)
        ? undefined
        : keptValue(input.registry, input.query);
      if (kept !== undefined) return Promise.resolve(kept.value);
      return fetchAndSeed(input.registry, input.fetch, (value) => ({ query: input.query, value }));
    },
  )
  .server((input: { readonly fetch: () => Promise<any> }) => input.fetch());

/**
 * The loader half of a live read; the registry owns its freshness, and the router only asks it.
 * On the server it calls the server function and never touches the registry (the page seeds its
 * node once hydrated, `useLiveRead`). In the browser, a query whose node is kept with a value
 * answers from it, with no request; one the registry has no value for is read over HTTP and
 * seeded, stamped with when the read came back. During a {@link reloadFromServer} it always
 * reads.
 */
export const liveLoad = <A, E>(
  input: LoaderInput & { readonly query: Query<A, E>; readonly fetch: () => Promise<A> },
): Promise<A> =>
  // createIsomorphicFn infers non-generic args, so restore the answer's type here.
  liveLoadImpl(input) as Promise<A>;

/**
 * The last answer each {@link liveLoadAnswer} request had, per registry, and its node's key. An
 * entry answers only while its node is kept, and is dropped once the node is gone.
 */
const lastAnswers = Atom.make(
  () => new Map<string, { readonly answer: unknown; readonly key: string }>(),
).pipe(Atom.keepAlive);

const liveLoadAnswerImpl = createIsomorphicFn()
  .client(async (input: LiveLoadAnswerInput<any, any, any>) => {
    const answers = input.registry.get(lastAnswers);
    const last = answers.get(input.request);
    if (!readsFromServer(input.registry) && last !== undefined) {
      const kept = keptValue(input.registry, input.live(last.answer).query);
      if (kept !== undefined) return input.withValue(last.answer, kept.value);
    }
    const answer = await fetchAndSeed(input.registry, input.fetch, input.live);
    const nodes = input.registry.getNodes();
    for (const [request, entry] of answers) if (!nodes.has(entry.key)) answers.delete(request);
    answers.set(input.request, { answer, key: serializableOf(input.live(answer).query).key });
    return answer;
  })
  .server((input: { readonly fetch: () => Promise<any> }) => input.fetch());

/** What {@link liveLoadAnswer} takes beyond every live loader's input. */
export interface LiveLoadAnswerInput<Answer, A, E> extends LoaderInput {
  /** Names this request among every such loader's, for the answer it gave last. */
  readonly request: string;
  readonly fetch: () => Promise<Answer>;
  readonly live: (answer: Answer) => LiveRead<A, E>;
  /** `answer` with the live read's current `value` in place of the one it was read with. */
  readonly withValue: (answer: Answer, value: A) => Answer;
}

/**
 * {@link liveLoad} for an answer that carries more than its live read, or whose query is only
 * known from the answer: the member's pages, whose answer names the member and their teams, and
 * whose list is keyed by the query the Backend resolved from the URL. The loader cannot learn
 * that query before the fetch, so the last answer for the same request names it, and the rest of
 * that answer comes back with the node's value. A request seen first in this document (the page
 * the server rendered included, whose loader ran on the server) is read over HTTP once.
 */
export const liveLoadAnswer = <Answer, A, E>(
  input: LiveLoadAnswerInput<Answer, A, E>,
): Promise<Answer> =>
  // createIsomorphicFn infers non-generic args, so restore the answer's type here.
  liveLoadAnswerImpl(input) as Promise<Answer>;
