import { cloudflare } from "@cloudflare/vite-plugin";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import agents from "agents/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

import packageJson from "./package.json" with { type: "json" };

/**
 * Vite's `server.allowedHosts` expects hostnames (no scheme/path).
 * Shopify CLI tunnels rotate hostnames on each `shopify app dev` run, and may provide
 * either bare hosts or full URLs through `HOST`/`APP_URL`/`SHOPIFY_APP_URL`.
 *
 * This helper normalizes both shapes to a hostname and safely ignores invalid values.
 */
const parseAllowedHost = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const normalized =
    value.startsWith("http://") || value.startsWith("https://")
      ? value
      : `https://${value}`;
  return URL.canParse(normalized) ? new URL(normalized).hostname : undefined;
};

/**
 * Keep local and tunnel preview hosts accepted by Vite's host check.
 * Without this, Shopify preview requests can fail with:
 * `Blocked request. This host (....trycloudflare.com) is not allowed.`
 */
const allowedHosts = [
  "localhost",
  "127.0.0.1",
  ".trycloudflare.com",
  parseAllowedHost(process.env.HOST),
  parseAllowedHost(process.env.APP_URL),
  parseAllowedHost(process.env.SHOPIFY_APP_URL),
].flatMap((host) => (host ? [host] : []));

const config = defineConfig({
  define: {
    // `VITE_` marks this as safe client-visible build metadata.
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(packageJson.version),
  },
  server: {
    /**
     * Bind IPv4 explicitly. Vite defaults `server.host` to `localhost` and sets
     * `dns.setDefaultResultOrder("verbatim")`, so on macOS `localhost` resolves to
     * `::1` first and Vite ends up listening on IPv6 only.
     *
     * Shopify CLI's dev proxy dials `127.0.0.1`. Node's Happy Eyeballs usually
     * recovers, but under a burst of parallel requests (the full reload that
     * follows a dependency re-optimization) some connections lose that race and
     * the module 404s as:
     * `Error forwarding web request: connect ECONNREFUSED 127.0.0.1:3800`.
     *
     * The proxy is the only client that reaches Vite directly, so IPv4-only is
     * enough; use `true` (0.0.0.0 + ::) if LAN access is ever needed --
     * `allowedHosts` still guards the host check either way.
     */
    host: "127.0.0.1",
    /**
     * Fail when `PORT` is taken instead of moving to the next free port: the
     * Shopify CLI proxy keeps dialing `PORT` (it passes it in as
     * `BACKEND_PORT`), so a silent move serves the app on a port nothing
     * reaches. Two checkouts (git worktrees) given the same `PORT` then fail
     * loudly at startup.
     */
    strictPort: true,
    allowedHosts,
    /**
     * Keep the watcher out of `refs/`, the downloaded library source that the
     * app never imports. Vite clears its tsconfig cache and sends a full reload
     * for every `tsconfig.json` the watcher reports added, and in the main
     * checkout (where `refs/` is a real directory, not a symlink) the crawl
     * reported over a hundred of them at startup. Each reload invalidated the
     * module graph mid-request, and SSR failed with two React copies
     * (`Cannot read properties of null (reading 'useEffect')`).
     */
    watch: { ignored: ["**/refs/**"] },
  },
  // `vite-tsconfig-paths` should cover `@/*`, but Vite's dependency scan / SSR pre-bundling
  // doesn't always apply that resolver. This explicit alias ensures `@/…` imports resolve
  // consistently during optimizeDeps and SSR module execution.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", import.meta.url)),
    },
  },
  build: {
    rolldownOptions: {
      external: ["node:stream", "node:stream/web", "node:async_hooks"],
    },
  },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart({
      /**
       * No server package reaches the client environment. TanStack Start
       * checks every import under `src/` in dev at request time and in build
       * after tree-shaking; `Auth.ts` and `Repository.ts` carry the
       * `server-only` marker, and the `better-auth` and `kysely` specifiers
       * are denied outright. `error` rather than the default `mock` in dev,
       * because a mocked module and a one-line warning are invisible to an
       * agent while the app keeps working on a Proxy. Even so, in dev the
       * document still serves with 200: the failure is the client module
       * request, so the page never hydrates and the log carries the trace.
       * The leak this pins was
       * a module-level guard beside a route's middleware that kept `Auth`
       * alive in the client build: 730 extra script modules and about 0.65 s
       * per document load in dev, and better-auth with Kysely in the
       * production bundle (see `requireAdmin`).
       *
       * No Vitest test pins this rule: the build tool checks it itself on
       * every dev request and every `pnpm build`, and a test that ran a Vite
       * build would cost more than it pins.
       *
       * See refs/tan-start/docs/start/framework/react/guide/import-protection.md.
       */
      importProtection: {
        behavior: "error",
        client: { specifiers: [/^better-auth(?:\/|$)/u, /^kysely(?:\/|$)/u] },
      },
    }),
    viteReact(),
    agents(),
  ],
});

export default config;
