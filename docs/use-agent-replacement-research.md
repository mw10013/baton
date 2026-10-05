# Replacing `useAgent` on the tab

Written 2026-10-04. Decision 6 of `docs/publish-subscribe-first-principles-research.md` deferred
one question: once the subscription and the scope were cut, is the `agents` React hook still
earning the client JSDoc it costs? That simplification is implemented and committed. This doc
reads the three client modules (`src/lib/ShopAgentSocketHost.tsx`, `src/lib/ShopAgentContext.tsx`,
`src/lib/useLiveQuery.ts`) paragraph by paragraph, marks each one SDK workaround or Baton rule,
names what the tab needs from a socket, and weighs three ways to get it. Questions for a decision
are at the end, each with a recommendation.

## The short version

- **What the tab needs is small.** One socket per tab to its shop's object, a fresh credential on
  every connect, a typed call over the SDK's RPC frames, `identified` as React state so the
  gates and the banner re-render, a `message` listener for the invalidation, `onSocketClose` for
  the revoke code, and a `reconnect()` the watchdog can call. That is the whole surface the
  consumers touch (`agent.stub.*`, `agent.addEventListener`, `agent.readyState`, `agent.send`,
  `agent.reconnect`, `identified`).
- **Two thirds of the client JSDoc is about the hook, not about Baton.** Of nineteen paragraphs,
  twelve explain `useAgent`: it resolves the credential in render with `use()` and so suspends
  (the private Suspense boundary), it mutates `identified` in place on a stable object (the
  lifted primitive), its socket is published by writing a ref during render (the context getter
  and the `null` window), it caches the token on a timer whose default rotates the socket every
  five minutes (the seven-day `cacheTtl` and its 32-bit ceiling), and it evaluates the query
  during SSR where `idToken()` throws (half of the hydration gating).
- **The SDK ships the same protocol without the hook.** `AgentClient` in `agents/client` is a
  `PartySocket` subclass with the identical `call`/`stub`, pending-call map, default timeout and
  the same timeout message, and the same terminal-close rule. It takes the credential as a
  function partysocket calls on every connect, so there is no cache, no `use()`, and nothing
  evaluated in render. It is already a dependency and already imported by a test.
- **Recommendation: hold an `AgentClient` in React state, created on the client after hydration,
  and own `identified` in a forty-line hook.** The Suspense boundary, the render-nothing host,
  the ref getter, `cacheTtl`, `queryDeps` and the lifted-state paragraphs go. The watchdog,
  keepalive, `withSocketRecovery`, `useLiveQuery`, the gates, the banner and both shells keep
  their code; a handful of sentences that name `useAgent` change their noun. No new dependency.
  Writing the RPC frames by hand on a bare `PartySocket` is the alternative; it saves nothing
  the first option does not and adds a protocol to keep in step with the server.

## What the tab needs from the socket

From the consumers, not from the SDK's feature list. Every site that touches the socket, and
what it touches:

| site                                                           | touches                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `useLiveQuery`                                                 | `identified`, `agent.stub.<read>`, `message` listener, `agent` for the throttle effect's deps |
| `withSocketRecovery`, `reconnectIfSocketStale`                 | `readyState`, `reconnect()`, the timeout rejection's message                                  |
| the watchdog, keepalive and frame-evidence effects in the host | `open`/`message` listeners, `readyState`, `send(ping)`, `reconnect()`                         |
| merchant verbs (eight routes and `WorkflowSwitch`)             | `identified` for `disabled`, `agent.stub.<verb>` through `withSocketRecovery`                 |
| member verbs (`useMemberRunActions`)                           | the same                                                                                      |
| `SocketBanner`                                                 | `identified`                                                                                  |
| `/app` and `/shop/$shop`                                       | mount the provider; `onSocketClose` for `CONNECTION_CLOSE_REVOKED`                            |

What no site touches: the SDK's state sync (`agent.state`, `setState`, `onStateUpdate`), MCP
server state, sub-agents, `basePath`, tool-run events, chat, streaming calls, `connectionError`,
`ready`, `getHttpUrl`, identity-change detection. The object sends `cf_agent_identity` and
`cf_agent_mcp_servers` on connect, `invalidated` on publish, and RPC replies; the tab decodes the
first and the third and ignores the rest.

The requirement, then:

1. One connection at a time per tab, reconnecting on its own after any non-terminal close, with
   the gate's credential fresh on each connect: a merchant's App Bridge token is minted per
   connect because a browser cannot set a header on an upgrade; a member sends nothing.
2. A typed call that resolves with the method's result or rejects with its error, rejects when
   the socket it was sent on closes, and times out as a backstop. A call made while the socket is
   down is sent when it next opens, never twice.
3. `identified` as React state: true after the identity frame, false on close, so `disabled`
   gates, the banner and the first read re-render.
4. The socket object stable for the life of the tab, so the listener effects run once.
5. No connect before hydration (a tokenless attempt would be refused and retried) and no
   `idToken()` during SSR (it throws).

## The client JSDoc, paragraph by paragraph

`W` is an SDK workaround: the paragraph exists because of how `useAgent` behaves and would have
nothing to explain under a client that does not behave that way. `R` is a Baton rule: it would be
written the same way under any client. `R*` is a rule whose wording names the SDK.

### `ShopAgentSocketProvider` (`ShopAgentSocketHost.tsx`)

| #   | paragraph                                                                                  | kind | with `AgentClient`                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | both populations mount this; only the credential differs                                   | R    | unchanged                                                                                                                          |
| 2   | its own Suspense boundary: `useAgent` suspends on every token re-run, blanking the subtree | W    | gone; nothing suspends                                                                                                             |
| 3   | the context value reads the socket through a getter; `null` is part of the contract        | W    | gone; the socket is state, the value re-memoizes when it is created. `null` stays, as "before the effect creates it", one sentence |
| 4   | `identified` reactivity: the hook mutates in place, so it is lifted as a primitive         | W    | becomes the design, one sentence: the hook owns `identified` as state                                                              |
| 5   | `onSocketClose` for the revoke code; the reconnect is the host's                           | R    | unchanged                                                                                                                          |

### `ShopAgentSocketHost` (`ShopAgentSocketHost.tsx`)

| #   | paragraph                                                                                             | kind | with `AgentClient`                                                                   |
| --- | ----------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| 6   | render-nothing host so suspends hit `fallback={null}`                                                 | W    | gone with the component                                                              |
| 7   | publishes `agentRef` during render, before any effect                                                 | W    | gone                                                                                 |
| 8   | revocation: 4000 to 4999 terminal (`isTerminalCloseEvent`), 3401 reconnects                           | R*   | unchanged; `AgentClient` applies the same function                                   |
| 9   | `identified` lifted up, not read down                                                                 | W    | gone                                                                                 |
| 10  | hydration gating: `useAgent` evaluates `query` in render, including SSR, and `idToken()` throws there | W    | gone; the credential is a function partysocket calls at connect time, in the browser |
| 11  | `enabled` gates the socket so the first connect carries the token                                     | R    | shrinks: the effect that creates the socket waits for `hydrated`                     |
| 12  | `cacheTtl` 7d: the 5-minute default rotates the socket; under the 32-bit ceiling; not 0               | W    | gone; there is no cache. `idToken()` runs once per connect attempt                   |
| 13  | `defaultCallTimeout` 20s and why not lower                                                            | R    | unchanged; the option exists on `AgentClient`                                        |
| 14  | three lifecycle effects: evidence, watchdog, keepalive                                                | R    | unchanged                                                                            |
| 15  | standing constraint: no periodic traffic that wakes the object                                        | R    | unchanged                                                                            |

### `ShopAgentContext.tsx`

| #   | paragraph                                                                                               | kind | with `AgentClient`                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16  | `identified` split out because `useAgent` mutates the socket object                                     | W    | one sentence: the host's hook owns it                                                                                                                                                                                   |
| 17  | `agent` is `null` until the host's first render; lazy hydration can render a consumer first             | W    | one sentence: `null` until the effect creates the socket; consumers gate as today                                                                                                                                       |
| 18  | `lastFrameAt`, `STALE_SOCKET_MS`, `SOCKET_KEEPALIVE_MS`, `SOCKET_WATCHDOG_MS`, `reconnectIfSocketStale` | R    | unchanged                                                                                                                                                                                                               |
| 19  | `withSocketRecovery`: pre-flight and backstop                                                           | R*   | unchanged in substance; "useAgent queues the call (`sentOn: null`)" becomes "partysocket buffers the frame and flushes it before `open`"; the regex matches the message `AgentClient` produces, which is byte-identical |

`useLiveQuery`'s last paragraph (agent null until the host commits) and two shell paragraphs
(`app.tsx`: "useAgent's async query cache is auto-invalidated on disconnect; `queryDeps` ties
the cache to the shop"; `shop.$shop.tsx`: a stale sentence that still says the host re-arms the
socket on a 4000-range close) change a noun or a sentence. The vocabulary rows for `socket` and
`identify` on `Domain` keep their symbols.

Twelve of nineteen are workarounds. Nothing in the twelve is a Baton decision; each is a fact
about `useAgent` that the next SDK bump has to be re-checked against (the `react.tsx` it lives in
is 1,115 lines, of which the tab uses the `usePartySocket` wrapper, the identity parse and the
RPC map).

## Why the hook behaves that way, and whether the SDK fixes it

The behaviours are not bugs in the hook. They follow from its design: an async `query` is a
promise resolved with React's `use()` so the URL is known at render; a resolved URL goes into
`usePartySocket`'s memo key so a new token is a new socket; the returned object is the live
`PartySocket`, so `identified` is written onto it. `shouldReconnectOnClose`, the queued-call
map and the address guard were added through 2026 and each makes the hook more robust without
changing the shape. There is no option that makes it not suspend or not cache. The two
behaviours Baton pays most for (render-time `use()` and the rotating cache) are the hook's
reason to exist: it lets a component declare `query: async () => ({ token })` and get a socket
back in the same render.

Partysocket itself never needed that. `PartySocket`'s `query` accepts a function returning a
promise, and `ReconnectingWebSocket._connect` awaits it on every attempt, so a credential
function is evaluated exactly when the socket is about to open and never cached. The hook's
cache exists so the URL can be a memo key; drop the memo and the cache has nothing to do.

## Three ways to get the requirement

### A. Keep `useAgent`

Nothing changes. The twelve paragraphs stay, and stay correct until an SDK bump moves one of the
facts they rest on. The hook's robustness work (queued calls across socket replacement, the
address guard, `awaitingQueryRefresh`) protects a case Baton does not have: its socket options
never change for the life of a mount, so the socket is never replaced except by the token memo,
which is itself the thing the 7-day cache suppresses.

Cost: zero now. Risk: every `agents` upgrade re-validates the Suspense, the ref getter, the
cache ceiling and the in-place mutation; a change in any of them is a white page or a frozen
`disabled` gate, which no unit test catches today (the host has one browser test, for the
close-code rule, and the rest is e2e).

### B. `AgentClient` from `agents/client`, held in React state

`AgentClient` is the SDK's client for non-React callers: `class AgentClient extends PartySocket`
with `call`, `stub` (the same `createStubProxy` and `AgentStub<T>` types), a pending-call map
that rejects transmitted calls on close and keeps buffered ones, `defaultCallTimeout` with the
same message, `onIdentity`, and `isTerminalCloseEvent` through `shouldReconnectOnClose`. Its
options are `PartySocketOptions` minus `party` and `room`, so `query` is partysocket's: a
function called per connect.

The host becomes one hook:

```ts
const [agent, setAgent] = useState<AgentClient<ShopAgent> | null>(null);
const [identified, setIdentified] = useState(false);
useEffect(() => {
  if (!enabled) return;
  const client = new AgentClient<ShopAgent>({
    agent: "shop-agent",
    name: shop,
    host: window.location.host,
    query,
    defaultCallTimeout: 20_000,
    onIdentity: () => setIdentified(true),
  });
  const onClose = (event: CloseEvent) => {
    setIdentified(false);
    onSocketClose?.(event);
  };
  client.addEventListener("close", onClose);
  setAgent(client);
  return () => {
    client.removeEventListener("close", onClose);
    client.close();
    setAgent(null);
    setIdentified(false);
  };
}, [shop, enabled, query, onSocketClose]);
```

The three lifecycle effects move into the same component unchanged, keyed on `agent`. The
context value is `{ agent, identified }` memoized on both; no getter, because the value changes
when the socket exists. `ShopAgentSocket` becomes `AgentClient<ShopAgent>`; the `stub` type is
the same mapped type the hook returns today, so no consumer changes.

Behaviour, point by point against the requirement:

1. Reconnect: partysocket's, with the same backoff as today (the hook delegates to it). The
   credential function runs per attempt, so a reconnect after an edge idle-close carries a fresh
   token with no cache invalidation step. On a refused upgrade (lapsed plan) the browser sees
   1006 and partysocket retries on backoff, as today.
2. Calls: `withSocketRecovery`'s pre-flight calls `reconnect()` then the thunk; `send()` on a
   non-open socket that is reconnecting buffers the frame and flushes it before `open`, and the
   client marks the call transmitted on `open`. Same delivery as the hook's queue, with the
   one difference that the buffer is partysocket's rather than a map in React. The timeout
   message is identical, so the regex in `withSocketRecovery` is untouched.
3. `identified`: `onIdentity` and the close listener set React state. The client also writes
   `identified` onto itself, which nothing reads.
4. Stable object: the effect creates one socket per mount; the deps never change in practice
   (`shop` is the route param, `query` is a `useCallback` on the App Bridge instance, `enabled`
   flips once). If `shop` ever changed under a mounted provider, the effect would close and
   recreate, which is the right answer and the hook's address guard made complicated.
5. SSR and hydration: nothing runs on the server; the effect waits for `enabled` (`useHydrated`).
   The pre-hydration tokenless connect the JSDoc guards against cannot happen.

What is lost against the hook: `connectionError` as React state (unused), the address guard
(one address per mount), transfer of a buffered frame to a replacement socket (no replacement),
and the hook's own tests. React Strict Mode in development runs the effect twice, so a dev page
opens and closes one socket before the one it keeps; `usePartySocket` avoids this with a
reconnect-instead-of-recreate branch, and the cost here is one wasted upgrade on dev only.

Testing improves. `PartySocket` takes a `WebSocket` constructor in its options, so a browser
test can mount the real provider over a fake socket class and pin: `identified` flips true on
the identity frame and false on a close; `onSocketClose` receives the code; no connect before
`enabled`; the keepalive sends the ping when open. Today those are e2e-only.

Cost: `ShopAgentSocketHost.tsx` rewritten (287 lines today, about half that after, most of the
difference JSDoc), `ShopAgentContext.tsx` loses two paragraphs and changes one type, `useLiveQuery.ts` and
the two shells change a sentence each, one browser test added, the existing close-code test
kept. No dependency change. `pnpm spec check` is unaffected: the connection table's tab rows
say "the decision is the SDK's", and it still is.

### C. Bare `PartySocket`, RPC frames by hand

`usePartySocket` or a `PartySocket` in state, with Baton's own `call`: a pending map keyed by
id, `{ type: "rpc", id, method, args }` out, `{ type: "rpc", id, success, result | error }`
in, a timeout, rejection on close, a `Proxy` for the typed stub. `test/integration/agent-socket.ts`
already speaks this protocol by hand for the object's tests, so the shape is known: about eighty
lines plus the types, which could import `AgentStub` from `agents/client` or restate it.

What it buys over B: no import from `agents/client` on the tab; the frames are visible in
Baton's code. What it costs: a second implementation of the SDK's wire protocol to keep in step
with the dispatcher in `index.ts` and the pending-call rules in `client.ts`, which the SDK changed
three times in 2026 (queued calls flushed on open, the address guard, the default timeout; see
`refs/agents/packages/agents/CHANGELOG.md`), and `partysocket` as a direct dependency for the `PartySocket` type, pinned to
the version `agents` pins. The pending-call semantics B gets for free (reject transmitted calls
on close, keep buffered ones, mark transmitted on open) have to be re-derived and re-tested.

Not recommended. The protocol is the SDK's and the SDK exports a client for it; the thing to
remove is the React hook, not the client.

## What stays the same under B

The spec. The cycle table on `InvalidatedMessage`, the sites table on `ShopAgent.publish`, the
events table on `useLiveQuery` and the connection table on `ConnectionRole` describe the object
and the hook's refetch policy; none names the transport hook. The one row that touches the tab's
reconnect ("3401 reconnects, 4403 does not; the decision is the SDK's") is pinned by a test that
calls `isTerminalCloseEvent`, which `AgentClient` uses through `shouldReconnectOnClose` exactly
as the hook does.

The liveness design. Keepalive, watchdog and `withSocketRecovery` read `readyState`, call
`reconnect()` and `send()`, and listen for frames. All four are `PartySocket` members.

The consumers. `agent.stub.<method>` keeps its type; `identified` keeps its meaning; `null` for
`agent` stays in the contract with a shorter reason.

## Questions

Each with a recommendation. All five accepted 2026-10-04 in Plannotator, as recommended; see
Decisions.

1. **Which option?** A keeps `useAgent`, B holds `AgentClient` in state with a Baton hook for
   `identified`, C writes the RPC frames on a bare `PartySocket`.
   **Recommendation: B.** It removes all twelve workaround paragraphs, keeps the SDK's protocol
   code and types, adds no dependency, and makes the host unit-testable over a fake socket. C
   removes the same paragraphs at the price of owning a protocol; A pays the paragraphs forever.

2. **Where is the socket created?** In an effect after hydration (the socket is `null` on the
   server and on the first client render), or in a `useState` initializer with `startClosed` and
   a placeholder host, as `usePartySocket` does, so `agent` is never `null`.
   **Recommendation: the effect.** `null` is already in the contract and every consumer gates on
   `identified`, which implies non-null. A socket object constructed during SSR is a thing to
   explain; a `null` before the browser is not. The getter goes either way.

3. **Does `identified` stay a context field, or do consumers read `agent.identified`?**
   `AgentClient` writes the flag onto itself, so the field could go.
   **Recommendation: it stays as React state in the context.** Reading it off the object is the
   in-place-mutation problem the lifted primitive exists to avoid; the difference under B is that
   the lifting is the design (one hook owns the state) rather than a correction of the SDK, and
   the JSDoc says so in a sentence. The vocabulary row for `identify` names the symbol.

4. **A browser test for the host?** Mount the real provider over a fake `WebSocket` class
   (partysocket's `WebSocket` option) and pin: `identified` true on the identity frame and false
   on close; `onSocketClose` gets the close code; no connect before `enabled`; the ping is sent
   when open.
   **Recommendation: yes, one file, four tests**, beside the existing close-code test. The
   Suspense blanking that motivated the current structure was found in production; under B the
   failure modes are a flag that does not flip or a connect that fires early, and both are
   cheap to pin.

5. **When?** Now, on top of the uncommitted first-principles implementation, or as the next
   change after that is committed.
   **Recommendation: after the commit, as its own change.** Both touch `ShopAgentSocketHost.tsx`
   and the shells' JSDoc; one commit per decision keeps the spec change and the transport change
   separately revertible, and the memory note tracks this as the follow-up either way.

## Decisions

All five decided 2026-10-04 in Plannotator, each as recommended. The first-principles
implementation this builds on is committed, so the work proceeds as its own change.

1. Option B: `AgentClient` from `agents/client`, held in React state, with a Baton hook owning
   `identified`.
2. The socket is created in an effect after hydration; `agent` is `null` before.
3. `identified` stays a context field, as React state the host's hook owns.
4. One browser test file over a fake `WebSocket` class pins the host's four behaviours; the
   close-code test stays.
5. Done as the next change, after the first-principles commit.

Plan: `docs/use-agent-replacement-plan.md`. Implemented 2026-10-04, uncommitted: browser project
10 tests (5 host, 5 hook), `pnpm test` 744, the socket e2e specs 63. Deviations are in the plan.
