# Dependency patches runbook

What our pnpm patches are, and what to do when one blows up on an upgrade.

## How patching works

- A patch is a recorded diff that pnpm applies to a package every time it installs it: locally, in CI, in a new worktree. Nothing under `node_modules` is edited by hand, and nothing is lost on reinstall.
- The diff lives in `patches/<package>@<version>.patch`. `patchedDependencies` in `pnpm-workspace.yaml` maps the package to it, keyed by **exact version**. `pnpm-lock.yaml` records the patch's hash; it is generated, not edited.
- Because the key is an exact version, a patch never silently applies to a different release. Upgrading the package leaves the patch matching nothing, and the install fails with an error naming the patch, until it is carried forward (below).

## Current patches

One patch file per package; `patches/alchemy@2.0.0-beta.81.patch` carries three changes, each retired on its own, and `patches/@alchemy.run__cloudflare-runtime@2.0.0-beta.81.patch` one.

### `alchemy@2.0.0-beta.81`: export `RpcWebSocket`

- **What it changes:** Alchemy's `package.json`. It adds one entry to the `exports` map, copied from the `./Cloudflare/RpcWebSocketClient` entry beside it:

  ```json
  "./Cloudflare/RpcWebSocket": {
    "types": "./lib/Cloudflare/Workers/RpcWebSocket.d.ts",
    "bun": "./src/Cloudflare/Workers/RpcWebSocket.ts",
    "default": "./lib/Cloudflare/Workers/RpcWebSocket.js"
  },
  ```

- **Why:** the Backend's actor socket (`src/backend/actor-socket.ts`) builds on Alchemy's server-side WebSocket RPC transport. Alchemy ships that file but leaves it out of `exports`, so it cannot be imported by name. Without the patch, the only way in is a relative path into `node_modules`, which breaks quietly, at bundle time, whenever Alchemy moves the file.
- **Retire it when:** Alchemy exports `./Cloudflare/RpcWebSocket` (or the same module under another public path) itself.

### `alchemy@2.0.0-beta.81`: local `precreate` of a self-bound Durable Object

- **What it changes:** `LocalWorkerProvider`'s `precreate`, in both `src/Cloudflare/Workers/LocalWorkerProvider.ts` and the `lib/…/LocalWorkerProvider.js` Node loads. For a `durable_object_namespace` binding, the namespace id was `` `${binding.scriptName}-${binding.className}` ``; it now uses the Worker's own `name` when `scriptName` is absent, not a string yet, or the Worker's own name, as `resolveConfig` in the same file already does:

  ```ts
  const host =
    typeof binding.scriptName === "string" && binding.scriptName !== name
      ? binding.scriptName
      : name;
  durableObjectNamespaces[binding.className] =
    binding.namespaceId ?? encodeURIComponent(`${host}-${binding.className}`);
  ```

- **Why:** the orders sync Workflow binds the shop's actor by identity, `ShopActor.from(<the Backend>)` (`ShopActors.layerFrom`), because the actor yields the Workflow. That binding's `scriptName` is the Backend's own `workerName`, an `Output` that cannot resolve while the Backend itself is being precreated, and the template string threw `Cannot coerce Output<…workerName> to a string via JS coercion` on every fresh local stack (each integ file, the e2e server, a first `alchemy dev`). Only the local provider; the deployed provider is separate code.
- **Retire it when:** Alchemy's `LocalWorkerProvider.precreate` no longer interpolates an unresolved `scriptName` for a self binding (an upstream issue was requested when the hunk landed; link it here once filed). Check: drop the hunk, then a fresh integ file (`vp test test/integ/orders-sync.test.ts`) deploys.

### `alchemy@2.0.0-beta.81`: a digits-only bound value reads back as a number

- **What it changes:** the runtime branch of the `Config` interceptor that `Platform.ts` installs around a Worker's init, in both `src/Platform.ts` and the `lib/Platform.js` Node loads. It used `ctx.get(key)`'s value whenever it was truthy; it now uses it only when it is `Redacted` (the marker the interceptor binds at plan time), or when the ambient provider has no node for the key, and otherwise returns the ambient provider's node:

  ```ts
  const value = yield * ctx.get<Redacted.Redacted<string>>(key);
  if (Redacted.isRedacted(value)) return ConfigProvider.makeValue(Redacted.value(value));
  if (value && node === undefined) return ConfigProvider.makeValue(value);
  ```

- **Why:** a Worker's `env` prop (`worker.bind(name, { env })`) stores a plain string verbatim and binds it as `plain_text`, locally (`RuntimeBindings.ts`, `Text.local`) and on Cloudflare (`WorkerProvider.ts`, `appendAlchemyAndEnvBindings`), so the Worker's env holds the string `"2798461"`. `ctx.get` (`WorkerRuntimeContext.ts`) reads it through `unpackEnvValue`, which `JSON.parse`s it into the number `2798461`, and the interceptor handed that to `Config.String`, which refuses it ("Expected string"). Only values `packEnvValue` wrote are safe to unpack; a verbatim string is not. The Backend's `ShopifyPartner` binding (the Partner organization and app ids) died on it during init. The ambient provider (`reifyBoundConfigProvider`) already reads the same env without reinterpreting it. Real Cloudflare hands a `plain_text` binding to the Worker as a string too, so this is not local-only: staging would fail the same way unpatched.
- **Upstream issue to file** (alchemy-run/alchemy, then link it here):

  > **A digits-only `env` string reaches `Config.String` as a number during Worker init.** `Worker.bind(name, { env: { ORG_ID: "2798461" } })` stores the string verbatim (`plain_text`, not `packEnvValue`d). During init, the `Config` interceptor in `Platform.ts` (runtime phase) resolves the key through `ctx.get`, whose `unpackEnvValue` `JSON.parse`s `"2798461"` into `2798461`, then `ConfigProvider.makeValue(2798461)`; `Config.String("ORG_ID")` fails with "Expected string". The same happens to `"true"`, `"null"` or any JSON-shaped string bound verbatim. Inside a request handler the read succeeds, because `reifyBoundConfigProvider` only JSON-parses a string that starts with `"`. Suggested fix: in the interceptor's runtime branch, use `ctx.get`'s value only when it is `Redacted` (the plan-time marker), and otherwise return the ambient provider's node. Seen on `2.0.0-beta.81`, still in `main`.

- **Retire it when:** the interceptor no longer turns a verbatim env string into a non-string. Check: drop the hunk, then `vp test --project integ` (the test stage binds the Partner ids as `"1"`) or a fresh `vp run dev`; unpatched, the Backend's init dies with `ShopifyPartner: SchemaError(Expected string …)`.

### `@alchemy.run/cloudflare-runtime@2.0.0-beta.81`: the dev proxy truncates `Connection: close` responses

- **What it changes:** `WorkerProxy`'s relay, in both `src/core/proxy/WorkerProxy.ts` and the `dist/core/node/proxy/WorkerProxy.mjs` Node loads. When the upstream (workerd) socket closes cleanly, the client socket is now `end`ed, not `destroy`ed:

  ```ts
  upstream.on("close", (hadError) => (hadError ? socket.destroy() : socket.end()));
  ```

- **Why:** `alchemy dev` serves each Worker's public port (the e2e server's `WEBSITE_PORT + 100`) through this byte pipe. A request sent with `Connection: close` has workerd close the upstream right after the last byte, while the pipe may still hold part of the body unwritten to the client. `destroy` drops it, so a large response (Vite's 780 KB `Effect` chunk) arrives short of its `Content-Length`. The Shopify CLI's proxy in front sends every request with `Connection: close` and, on that short upstream, never ends its own response, so the app frame waits forever on one module and never hydrates. That was the embedded e2e hydration flake.
- **Retire it when:** Alchemy's `WorkerProxy` no longer destroys the client on a clean upstream close (still there in `2.0.0-beta.83`; an upstream issue is owed, link it here once filed). Check: drop the patch, start `vp run e2e:start`, then fetch a large prebundled dep from `127.0.0.1:<e2e port>` with `Connection: close` a few thousand times. Unpatched, a few in a thousand come back short.

## Upgrading a patched package

Example for Alchemy; the same steps work for any patched package.

1. **Drop the old patch.** Remove the `alchemy@…` line from `patchedDependencies` in `pnpm-workspace.yaml`, and delete its file in `patches/`. If `patchedDependencies` is now empty, remove the key.
2. **Upgrade.** `vp add -E alchemy@<version>`, with the `@alchemy.run/*` packages at the same version.
3. **Check whether each change is still needed.** Look for `"./Cloudflare/RpcWebSocket"` in `node_modules/alchemy/package.json`, read `precreate` in `node_modules/alchemy/lib/Cloudflare/Workers/LocalWorkerProvider.js` and the interceptor's runtime branch in `node_modules/alchemy/lib/Platform.js`, and read the upstream `close` handler in `node_modules/@alchemy.run/cloudflare-runtime/dist/core/node/proxy/WorkerProxy.mjs` (the runtime's patch is re-created the same way, `vp pm patch @alchemy.run/cloudflare-runtime@<version>`). A change Alchemy now makes itself is retired; if all are, skip to step 6.
4. **Check the transport still exists.** `node_modules/alchemy/lib/Cloudflare/Workers/RpcWebSocket.js` and its `.d.ts`. If they moved or were renamed, find the module that `RpcDurableObject` imports its transport from, and point the new entry there.
5. **Re-create the patch.**

   ```sh
   vp pm patch alchemy@<version> -- --edit-dir /tmp/alchemy-patch
   # add the exports entry above to /tmp/alchemy-patch/package.json
   # make the precreate change above in src/ and lib/ LocalWorkerProvider
   # make the interceptor change above in src/Platform.ts and lib/Platform.js
   vp pm patch-commit /tmp/alchemy-patch
   ```

   `patch-commit` writes `patches/alchemy@<version>.patch`, adds it to `patchedDependencies` and reinstalls.

6. **Verify.**

   ```sh
   vp check
   vp test --project integ   # drives the actor socket in workerd; each file is a fresh local stack
   ```

   If the patch was retired, the import in `src/backend/actor-socket.ts` stays `alchemy/Cloudflare/RpcWebSocket` (or moves to Alchemy's new public path), and its comment about `patches/` goes.

Commit `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `patches/` together.

## Troubleshooting and rollback

- **Install fails naming a patch:** the version moved under it. Follow "Upgrading a patched package".
- **Install fails because the patch does not apply:** the patched file changed within the same version string, which should not happen for a published release. Re-create the patch (step 5).
- **Type check fails on `alchemy/Cloudflare/RpcWebSocket`:** the patch is missing or did not apply. Check `patchedDependencies`, then run `vp install`.
- **Undo a patch entirely:** remove it from `patchedDependencies`, delete its file, `vp install`. For Alchemy, without the `precreate` change every fresh local stack fails to deploy while `ShopActors.layerFrom` binds the actor by `from`; and the import in `src/backend/actor-socket.ts` must fall back to the relative path `../../node_modules/alchemy/lib/Cloudflare/Workers/RpcWebSocket.js`.
