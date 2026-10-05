# Replacing `useAgent` on the tab: implementation plan

This plan carries out the decisions in `docs/use-agent-replacement-research.md` (2026-10-04,
one Plannotator pass, all five as recommended). Read that doc first: "What the tab needs from
the socket" is the requirement, the paragraph tables say which JSDoc goes and which stays, option
B is the design, and Decisions holds the five calls. Nothing here is open; where this plan had to
choose something the research did not, the choice is under "Decided at planning time".

One change, in three steps: the host, the sentences elsewhere that name the hook, the tests.
Each step ends with what must be true before the next.

## Before you start

- Read `AGENTS.md` and the JSDoc on: `ShopAgentSocketProvider`, `ShopAgentSocketHost` and
  `SocketQuery` (`src/lib/ShopAgentSocketHost.tsx`, whole file); `ShopAgentContext.tsx` whole;
  the module JSDoc and the last paragraph on `useLiveQuery` (`src/lib/useLiveQuery.ts`); the
  socket paragraphs of `RouteComponent` and `AppRouteContent` in `src/routes/app.tsx` and of
  `RouteComponent` in `src/routes/shop.$shop.tsx`; the nouns table rows `socket`, `connection`,
  `identify` and the close codes on `src/lib/domain/Platform.ts`; `SocketBanner.tsx`;
  `useMemberRunActions.ts`. On the SDK side: `AgentClient`, `AgentClientOptions`,
  `isTerminalCloseEvent`, `createStubProxy`, `AgentStub` in
  `refs/agents/packages/agents/src/client.ts`; `PartySocketOptions` and `getPartyInfo` in
  `refs/partykit/packages/partysocket/src/index.ts`; `Options`, `send`, `reconnect`, `close`,
  `_connect`, `_getNextUrl` and `_handleClose` in `refs/partykit/packages/partysocket/src/ws.ts`.
  On the test side: `test/browser/shop-agent-socket-host.test.ts`,
  `test/browser/use-live-query.test.tsx` (`renderLive`'s stand-in socket), and the four socket
  e2e tests (`grep -l "socket" e2e/*.spec.ts`).
- The rules that matter most here:
  - A rule is stated once. The twelve workaround paragraphs are deleted, not moved; a kept
    paragraph that explained itself by contrast with the hook is rewritten to stand alone.
  - A JSDoc never cites a file under `docs/`. A `refs/` path with a symbol name is fine.
  - The vocabulary's `socket` row names `ShopAgentSocket` and `ShopAgentSocketProvider`, and
    the `identify` row names `identified`. Those three symbols keep their names.
  - `pnpm fmt` after the code; keep every file it touches.

## The decisions

| decision                                                          | step |
| ----------------------------------------------------------------- | ---- |
| 1. `AgentClient` in React state, a Baton hook owns `identified`   | 1    |
| 2. created in an effect after hydration; `agent` is `null` before | 1    |
| 3. `identified` stays a context field                             | 1    |
| 4. a browser test file over a fake `WebSocket` class              | 3    |
| 5. as its own change after the first-principles commit            | done |

## Decided at planning time

1. **The file keeps its name; the component goes.** `src/lib/ShopAgentSocketHost.tsx` still
   hosts the socket, so the module name stands. `ShopAgentSocketHost` the component and
   `SocketQuery`'s "what `useAgent` puts in the query string" wording go; `SocketQuery`'s type is
   unchanged, since partysocket's `query` accepts `() => Promise<Record<string, string | null>>`.
2. **One socket per mount, whatever the callers pass.** The effect's deps are `[shop, enabled]`.
   `query` and `onSocketClose` are read through refs updated every render, and the client's
   `query` option is `() => queryRef.current!()`, so a caller that passes a new function identity
   never recreates the socket, and partysocket still calls the latest function on every connect.
   This replaces the hook's address guard and `queryDeps` with nothing to explain.
3. **The `AgentClient` options.** `agent: "shop-agent"`, `name: shop`, `host:
window.location.host` (partysocket picks `ws` for localhost and `wss` otherwise), `query`
   when the caller passed one, `defaultCallTimeout: 20_000`, `onIdentity: () =>
setIdentified(true)`. Nothing else: no `shouldReconnectOnClose` (the SDK's
   `isTerminalCloseEvent` is the rule and the test pins it), no `startClosed` (the effect wants
   the connect), no `maxRetries`.
4. **The close listener is Baton's.** `client.addEventListener("close", ...)` flips
   `identified` false and calls `onSocketClose`. `AgentClient` also sets `this.identified`
   on itself; nothing reads it, and the JSDoc says so in one sentence.
5. **The context value is state, memoized on `[agent, identified]`.** `agent` is
   `AgentClient<ShopAgent> | null`. The getter and `agentRef` go. The three lifecycle effects
   (frame evidence, watchdog, keepalive) move into `ShopAgentSocketProvider`, each guarded by
   `if (!agent) return`, deps `[agent]`.
6. **Strict Mode.** In development React runs the effect twice, so one socket opens and closes
   before the kept one. Accepted; the JSDoc says so in a sentence. The alternative (a
   reconnect-instead-of-recreate branch like `useStableSocket`) is the complexity the change
   removes.
7. **The browser test injects the fake through `globalThis.WebSocket`**, which partysocket
   falls back to when no `WebSocket` option is passed. No test-only prop on the provider. The
   fake is a class extending `EventTarget` with `readyState`, `send`, `close(code, reason)` and
   a static list of instances; construction sets `CONNECTING` and a microtask sets `OPEN` and
   dispatches `open`; `close` sets `CLOSED` and dispatches a `CloseEvent` with the code. The
   test restores the real `WebSocket` in `afterEach`.
8. **`withSocketRecovery`'s text.** "`useAgent` queues the call (`sentOn: null`), keeps it
   through the reconnect close, and flushes it on open" becomes: "`send()` on a socket that is
   not open buffers the frame and partysocket flushes the buffer before it dispatches `open`
   (`send` in `refs/partykit/packages/partysocket/src/ws.ts`); `AgentClient` keeps a buffered
   call pending through the close and marks it transmitted on `open`". The regex sentence names
   `AgentClient` (`_callImpl` in `refs/agents/packages/agents/src/client.ts`).

## Step 1: the host

### 1.1 `src/lib/ShopAgentContext.tsx`

- `import type { AgentClient } from "agents/client"`; delete the `agents/react` import.
  `export type ShopAgentSocket = AgentClient<ShopAgent>`.
- The context JSDoc becomes: one paragraph on what the value is (one socket per tab, mounted by
  `/app` and `/shop/$shop`); one sentence that `identified` is React state owned by the
  provider's hook, true after the identity frame and false on close, so gates and the banner
  re-render (the client writes a flag onto itself too, which nothing reads); one sentence that
  `agent` is `null` on the server and until the provider's effect creates it after hydration,
  that `identified === true` implies non-null, and that during a reconnect `agent` is the same
  socket while `identified` is `false`. Paragraphs 16 and 17 of the research's table go.
- `lastFrameAt`, the three constants, `reconnectIfSocketStale`: unchanged.
- `withSocketRecovery`: planning decision 8.

### 1.2 `src/lib/ShopAgentSocketHost.tsx`

Rewrite. Imports: `AgentClient` from `agents/client`, React, `Domain`, the context exports.

- `SocketQuery` keeps its type; its JSDoc says what the socket URL carries (merchant `{ token
}` minted per connect because a browser cannot set a header on an upgrade; member nothing, the
  cookie rides the same-origin upgrade) and that partysocket calls the function on every
  connect attempt, so a reconnect carries a fresh token with no cache.
- `ShopAgentSocketProvider({ shop, query, enabled, onSocketClose, children })`:

  ```ts
  const queryRef = React.useRef(query);
  queryRef.current = query;
  const onSocketCloseRef = React.useRef(onSocketClose);
  onSocketCloseRef.current = onSocketClose;
  const [agent, setAgent] = React.useState<ShopAgentSocket | null>(null);
  const [identified, setIdentified] = React.useState(false);
  React.useEffect(() => {
    if (!enabled) return;
    const client = new AgentClient<ShopAgent>({
      agent: "shop-agent",
      name: shop,
      host: window.location.host,
      query: queryRef.current ? () => queryRef.current!() : undefined,
      defaultCallTimeout: 20_000,
      onIdentity: () => setIdentified(true),
    });
    const onClose = (event: CloseEvent) => {
      setIdentified(false);
      onSocketCloseRef.current?.(event);
    };
    client.addEventListener("close", onClose);
    setAgent(client);
    return () => {
      client.removeEventListener("close", onClose);
      client.close();
      setAgent(null);
      setIdentified(false);
    };
  }, [shop, enabled]);
  ```

  Then the three lifecycle effects from today's host, each starting `if (!agent) return;`, and
  the memoized value `{ agent, identified }` into `ShopAgentProvider`. No Suspense, no child
  component.

- The JSDoc keeps, reworded to stand alone: both populations mount this and only the credential
  differs (1); `enabled` is hydration, so no connect happens on the server or before the App
  Bridge token can be minted, and the first connect carries the token (11, shortened);
  `defaultCallTimeout` 20 s and why not lower (13, as is); revocation: 3401 reconnects through
  partysocket's backoff and 4403 is terminal, the SDK's `isTerminalCloseEvent` applied by
  `AgentClient` (8); `onSocketClose` for the revoke code and the reconnect being the socket's
  own (5); the three effects and the standing constraint (14, 15, as is). New sentences: the
  socket is created once per mount in an effect and lives in state so the context value changes
  when it exists; `identified` is this component's state (decision 3); Strict Mode (planning
  decision 6); callers' `query` and `onSocketClose` are read through refs (planning decision 2).
  Deleted: 2, 3, 4, 6, 7, 9, 10, 12.

### 1.3 `src/lib/useLiveQuery.ts`

The last paragraph ("`agent` is `null` until the socket host first commits") becomes: `agent` is
`null` until the provider's effect creates the socket after hydration; `identified` is `false`
whenever it is, so the query is disabled and the effects no-op until the identify flip. The
`read: (stub: ShopAgentSocket["stub"]) => Promise<A>` type is unchanged in text and resolves to
the same mapped type.

### 1.4 Done when

- `pnpm typecheck` green: every `agent.stub.<method>` call in the eight routes,
  `WorkflowSwitch.tsx` and `useMemberRunActions.ts` still types (the stub type is
  `AgentStub<ShopAgent>` either way).
- `grep -rn "useAgent\|agents/react\|cacheTtl\|queryDeps\|agentRef\|Suspense" src/lib` returns
  nothing in the three files.

## Step 2: the sentences elsewhere

- `src/routes/app.tsx`, `RouteComponent` JSDoc: the Auth paragraph's last two sentences
  ("`useAgent`'s async `query` cache is auto-invalidated on disconnect ... `queryDeps: [shop]`
  ties the cache to the active shop") become one: partysocket calls `query` on every connect, so
  each reconnect carries a token minted for it. The fourth paragraph's "which `cacheTtl` below
  stretches to as long as the tab lives" becomes "which the keepalive stretches to as long as
  the tab lives" (`SOCKET_KEEPALIVE_MS`). `AppRouteContent` JSDoc: "(`src/lib/ShopAgentSocketHost.tsx`
  carries the Suspense boundary, `identified`, and lifecycle rationale)" drops "the Suspense
  boundary"; "the same flag the provider passes on to `useAgent`" becomes "the flag the provider
  waits for before it creates the socket".
- `src/routes/shop.$shop.tsx`, `RouteComponent` JSDoc: "`useAgent` evaluates its connection
  during render, including SSR" becomes "the provider creates the socket in an effect after
  hydration; there is no WebSocket on the server". The revoke paragraph's parenthetical ("because
  `agents` treats a 4000-range close as terminal and will not reconnect on its own") is stale
  since 3401 and goes; the sentence reads "The socket comes back on its own: 3401 is not a
  terminal close to the SDK, so partysocket reconnects through the gate".
- `src/lib/domain/Platform.ts`: the close-code JSDoc already says partysocket reconnects; check
  it does not name `useAgent`. The `socket` and `identify` rows keep their symbols.
- Grep `src/`, `test/`, `e2e/`, `scripts/` for `useAgent`, `agents/react`, `cacheTtl`,
  `queryDeps`, `agentRef`, `ShopAgentSocketHost` (the component, not the file) and clear every
  hit. `e2e/app.ts` line 198's "identified and the proxy enabled" is vocabulary, not the hook;
  keep.

### Done when

- The grep returns no hit outside `docs/`.
- `pnpm spec check` green (no table changes expected; the connection table's tab rows are
  unchanged).

## Step 3: the tests

### 3.1 `test/browser/shop-agent-socket-host.test.ts`

Keep "the tab reconnects on 3401 and not on 4403" as is. Add, in the same file (it is the host's
test), the fake `WebSocket` of planning decision 7 and a `mount` helper that renders
`ShopAgentSocketProvider` with `shop: "shop.test"`, a probe child reading `useShopAgent()` into
a ref, and `onSocketClose` as a `vi.fn()`. Four tests:

1. **"no connect before `enabled`"**: mount with `enabled: false`; after a tick the fake has
   zero instances and the probe sees `agent === null`; rerender with `enabled: true`; one
   instance, `agent` non-null, `identified` false.
2. **"identify flips `identified` on the identity frame and off on close"**: mount enabled;
   dispatch a `message` with `{ type: "cf_agent_identity", name: "shop.test", agent:
"shop-agent" }` on the instance; `identified` true; call the fake's `close(1006)`;
   `identified` false and the same `agent` reference.
3. **"`onSocketClose` receives the close code"**: close with `Domain.CONNECTION_CLOSE_REVOKED`;
   the spy was called once with an event whose `code` is 3401.
4. **"the keepalive sends the ping when the socket is open"**: `vi.useFakeTimers()` around the
   mount; advance `SOCKET_KEEPALIVE_MS`; the instance's `send` saw `Domain.SocketKeepalivePing`
   once. If fake timers fight the microtask open, open the fake synchronously in this test.

The e2e that proves the reconnect end to end stays named in the file's JSDoc.

### 3.2 `test/browser/use-live-query.test.tsx`

No change expected: `renderLive`'s stand-in is an `EventTarget` with `identified`, `reconnect`
and `stub`, cast to `ShopAgentSocket`. If the cast fails under `AgentClient<ShopAgent>`, widen
the cast, not the stand-in.

### 3.3 Done when

- `pnpm test:browser`: six hook tests and five host tests pass.
- `pnpm test` green (the integration project does not touch the tab).
- The four socket e2e tests pass headless (`npm run test:e2e -- --grep socket` or the titles:
  "removing a member closes the shop page on their live session", "removing a member from a
  team empties their open workflows list", and the two cross-tab publish tests).
- Headed check on the dev store (`pnpm dev:start`, then `pnpm playwright-cli --headed`): the
  orders index shows no banner within four seconds; Sync open orders is enabled and runs; in
  DevTools, `document.hidden` toggling and a forced `agent.reconnect()` from the console produce
  one reconnect and the banner never appears; the member's workflows list behaves the same.
- `pnpm typecheck`, `pnpm lint`, `pnpm fmt` (keep every file).

## After the steps

- Update the research doc's Decisions with "implemented <date>, uncommitted" and the test
  counts; update the memory note.
- Count the JSDoc paragraphs in the two client files against the research's tables: seven
  kept, twelve gone, and the new sentences from 1.2.

## Deviations and issues

Record here, as you go, anything that did not go as the plan says. One entry per item, in this
form:

- **What the plan said.** The sentence or step, quoted or named.
- **What was found.** The fact that contradicted it, with the file and symbol.
- **The options.** The two or three ways to proceed that were considered.
- **What was done.** The one taken, and why in a sentence.
- **Follow-up.** Whether the research doc, a spec row or this plan needs a change afterwards, or
  nothing.

- **What the plan said.** Planning decision 2: `query` and `onSocketClose` read through refs
  assigned during render; the client's `query` is `() => queryRef.current!()` when the caller
  passed one.
  **What was found.** `pnpm lint` refuses a ref read during render (`react(refs)`) and the
  non-null assertion.
  **The options.** Assign the refs in a layout effect; `React.useEffectEvent` (React 19.2).
  **What was done.** `useEffectEvent` for both: it is the React idiom for a callback an effect
  registers that must see the latest props. A member's `undefined` query becomes `() =>
Promise.resolve({})`, which adds nothing to the URL; the JSDoc says so.
  **Follow-up.** Nothing.
- **What the plan said.** 1.2: the three lifecycle effects each start `if (!agent) return;`.
  **What was found.** That return beside a cleanup return is a `consistent-return` warning, and
  `return undefined` is a `no-useless-undefined` warning; the repo lints warning-free.
  **The options.** Null-tolerant effect bodies; a render-null child holding the effects; a
  disable comment on each.
  **What was done.** Null-tolerant bodies (`agent?.addEventListener`, `if (agent)` in the check,
  `agent?.readyState` in the keepalive): no child, no disables. The creation effect keeps its
  `if (!enabled) return;` with one `consistent-return` disable on its cleanup, and one
  `set-state-in-effect` disable on `setAgent(client)`, each with its reason.
  **Follow-up.** Nothing.
- **What the plan said.** 3.1: add the tests "in the same file", `shop-agent-socket-host.test.ts`.
  **What was found.** Rendering the provider needs JSX (`no-children-prop` refuses
  `createElement` with a `children` prop).
  **The options.** Rename to `.tsx`; keep `.ts` with a disable.
  **What was done.** Renamed to `test/browser/shop-agent-socket-host.test.tsx` (`git mv`); the
  `describe` is now `ShopAgentSocketProvider`, since the component it named is gone. The pinned
  title "the tab reconnects on 3401 and not on 4403" is unchanged.
  **Follow-up.** Nothing.
- **What the plan said.** 3.3: "six hook tests and five host tests".
  **What was found.** `use-live-query.test.tsx` has five tests.
  **What was done.** 10 browser tests pass.
  **Follow-up.** Nothing.
- **What the plan said.** Step 2's grep list.
  **What was found.** Two more hits outside the named files: `test/integration/agent-socket.ts`
  (named `agents/react` and `useAgent` as where the client protocol lives) and a comment in
  `scripts/refs.ts` (partysocket "under `useAgent`").
  **What was done.** Both now name `AgentClient` / `agents/client`.
  **Follow-up.** Nothing.
- **What the plan said.** 3.3: a headed check on the dev store with DevTools.
  **What was found.** Run 2026-10-04 through the Chrome DevTools MCP. Member workflows list
  (`/shop/$shop`, signed in as the e2e member, a `WebSocket` spy injected before load): one
  `shop-agent` socket, identified, no banner. A hidden/visible toggle (emulated through
  `visibilityState` and `visibilitychange`, since the tab sat in its own window) left the socket
  alone, as it should for a fresh one. `agent.reconnect()` from the console: one new socket, the
  old one closed 1000, `identified` false then true within ~50 ms, the same `agent` reference, no
  banner. Merchant orders index inside the admin: no banner, Sync open orders enabled, and a
  click ran `OrdersSyncWorkflow` to `status=complete`.
  **The options.** The merchant's forced reconnect needs a handle inside the cross-origin app
  iframe, which the MCP's script evaluation does not reach.
  **What was done.** Forced reconnect checked on the member page only; the code path is shared.
  **Follow-up.** Nothing.

Known risks to watch for, which become entries if they bite:

1. **`AgentClient`'s generic.** `AgentClient<AgentT, State>` infers `State` from `AgentT`'s
   `state` getter; `ShopAgent` has none, so `State` falls back to `AgentT`. If `stub` types
   differently from today's `AgentStub<ShopAgent>`, pin it: `ShopAgentSocket = AgentClient<ShopAgent, unknown>`.
2. **`host` on the dev tunnel.** Inside the Shopify admin the iframe's `window.location.host` is
   the tunnel host, which is what the hook used through `usePartySocket`'s default. If a connect
   fails locally, compare the URL partysocket builds against the one in today's network tab
   before changing anything.
3. **`onIdentity` firing before `setAgent` commits.** The identity frame arrives after `open`,
   well after the effect's `setAgent`; but if a test sees `identified` true with `agent` null,
   batch the two states into one `useReducer`.
4. **Close after cleanup.** `client.close()` in the cleanup dispatches a `close` the listener was
   just removed from, so `onSocketClose` is not called on unmount. If a shell relies on that, it
   is a bug today too; record it.
5. **The fake and `connectionTimeout`.** Partysocket starts a 4 s connection timer at connect; a
   fake that never opens would trip it. The fake opens on a microtask, so it will not; if a test
   needs a never-opening socket, pass `connectionTimeout` through the fake's constructor
   options or use fake timers.
