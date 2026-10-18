import { defineConfig, loadEnv } from "vite-plus";
import type { OxlintOverride } from "vite-plus/lint";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import cloudflare from "@alchemy.run/cloudflare-runtime/vite";
import { playwright } from "vite-plus/test/browser-playwright";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { webEnvironmentSync } from "./scripts/lib/web.ts";

const websitePort = (mode: string) => {
  const port = loadEnv(mode, process.cwd(), "WEBSITE_").WEBSITE_PORT;
  if (!port) throw new Error("WEBSITE_PORT is not set");
  return Number(port);
};

/** This checkout's stage of `environment`, as `scripts/stage.ts` prints it. */
const stageOf = (environment: "test") =>
  Schema.decodeUnknownSync(Schema.Trim)(
    execFileSync("node", ["scripts/stage.ts", environment], { encoding: "utf8" }),
  );

/**
 * Vite's dependency cache, one per server: the dev and e2e servers run in one checkout at once,
 * and a re-optimization by one deletes files the other has loaded (every SSR request then 500s).
 */
const viteCacheDir = () => `node_modules/.vite/${webEnvironmentSync()}`;

const HttpUrl = Schema.String.check(Schema.isPattern(/^https?:\/\//u)).pipe(
  Schema.decodeTo(Schema.URLFromString),
);

/** A URL from an `http(s)://` URL or a bare host, which is read as `https://<host>`. */
const UrlOrHost = Schema.Union([
  HttpUrl,
  Schema.String.pipe(
    Schema.decodeTo(
      HttpUrl,
      SchemaTransformation.transform({
        decode: (host) => `https://${host}`,
        encode: (url) => url.slice("https://".length),
      }),
    ),
  ),
]);

/**
 * Hosts Vite's host check admits. Alchemy's proxy forwards the client's `Host` header untouched,
 * so a page loaded through Shopify CLI's tunnel arrives with the tunnel's hostname, which changes
 * every `shopify app dev` run. `APP_URL` is the tunnel the CLI injected into this run's
 * environment; the CLI may hand it as a URL or a bare host.
 */
const allowedHosts = () => [
  "localhost",
  "127.0.0.1",
  ".trycloudflare.com",
  ...Option.toArray(
    Schema.decodeUnknownOption(UrlOrHost)(process.env.APP_URL).pipe(
      Option.map((url) => url.hostname),
    ),
  ),
];

const browserStub = (file: string) =>
  fileURLToPath(new URL(`test/browser/stubs/${file}`, import.meta.url));

/**
 * `@tanstack/react-start`, replaced for the browser project: browser code calls its
 * `createIsomorphicFn`, which the TanStack Start compiler splits in the app, and that plugin
 * stops Vitest's browser runner from starting. An exact pattern, because a string key would
 * also capture `@tanstack/react-start/server`.
 */
const browserStubs = [{ find: /^@tanstack\/react-start$/, replacement: browserStub("start.ts") }];

/**
 * Effect is consumed one module at a time: `import * as Effect from "effect/Effect"`. The root
 * barrel drags all 160 modules through Vite dev and the Worker bundle.
 */
const effectBarrel = {
  name: "effect",
  message: 'Import Effect modules by path: import * as Effect from "effect/Effect".',
};

/**
 * Keeps `files` from importing the `forbidden` runtime directories under `src/`, which would put
 * one Worker's code in another's bundle. Only `contract/` is shared. An override replaces the
 * base `no-restricted-imports` options, so it carries {@link effectBarrel} again.
 */
const runtimeBoundary = (
  files: string,
  forbidden: ReadonlyArray<string>,
  message: string,
  options: { allowTypeImports?: boolean } = {},
): OxlintOverride => ({
  files: [files],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [effectBarrel],
        patterns: [{ group: forbidden.map((dir) => `**/${dir}/**`), message, ...options }],
      },
    ],
  },
});

/**
 * Keeps `src/domain/` below everything else: a context file imports only `effect` and the sibling
 * context files its `may import` cell on the domain's map names, never a runtime directory.
 * `siblings` are the context files `files` may not import. When two overrides match a file, the
 * later one's options replace the earlier's, so a per-file override repeats the directory group,
 * and each carries {@link effectBarrel} as {@link runtimeBoundary} does.
 */
const domainBoundary = (files: string, siblings: ReadonlyArray<string> = []): OxlintOverride => ({
  files: [files],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: [effectBarrel],
        patterns: [
          {
            group: ["**/backend/**", "**/web/**", "**/contract/**"],
            message: "The domain imports only `effect` and its own context files.",
          },
          ...(siblings.length === 0
            ? []
            : [
                {
                  group: siblings.map((file) => `./${file}`),
                  message: "A context file imports only what its `may import` cell names.",
                },
              ]),
        ],
      },
    ],
  },
});

export default defineConfig(({ command, mode, isPreview }) => {
  if (
    command === "serve" &&
    isPreview === false &&
    process.env.VITEST !== "true" &&
    process.env.VP_RUN !== "1"
  ) {
    throw new Error("Use `vp run dev` to start the project dev server.");
  }

  return {
    plugins:
      mode === "test"
        ? []
        : [
            // Alchemy injects this same plugin on deploy/dev; never instantiate it twice.
            process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED === "1"
              ? null
              : cloudflare({
                  compatibilityDate: "2026-07-01",
                  compatibilityFlags: ["nodejs_compat"],
                }),
            tanstackStart({ srcDirectory: "src/web" }),
            react(),
          ],
    cacheDir: command === "serve" ? viteCacheDir() : undefined,
    // Alchemy overrides this with an internal port behind its public proxy.
    server:
      command === "serve"
        ? { port: websitePort(mode), strictPort: true, allowedHosts: allowedHosts() }
        : undefined,
    test: {
      passWithNoTests: true,
      projects: [
        { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
        {
          // Components and hooks in Chromium. The directory picks the runtime, and the unit and
          // browser globs must not overlap because `vitest/browser` throws in Node.
          plugins: [react()],
          resolve: { alias: browserStubs },
          optimizeDeps: {
            include: [
              "react/jsx-dev-runtime",
              "effect/SchemaGetter",
              "effect/Struct",
              "effect/DateTime",
              "effect/Cause",
              "effect/Exit",
            ],
          },
          test: {
            name: "browser",
            include: ["test/browser/**/*.test.{ts,tsx}"],
            setupFiles: ["test/browser/setup.ts"],
            browser: {
              enabled: true,
              provider: playwright(),
              headless: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
        {
          // Deploys the Backend in workerd through alchemy/Test. Files run in parallel, each on
          // its own stage (`fileStage` in test/integ/), one workerd each. ALCHEMY_DEV is read by
          // the Worker's init at plan, so the test process must set it. ALCHEMY_TEST_STAGE is
          // the checkout's `test` stage, which each file's stage extends; it is spawned only
          // under test, so `vp build` and `vp run dev` do not run the script.
          test: {
            name: "integ",
            include: ["test/integ/**/*.test.ts"],
            env:
              mode === "test"
                ? { ALCHEMY_DEV: "1", ALCHEMY_TEST_STAGE: stageOf("test") }
                : { ALCHEMY_DEV: "1" },
            // alchemy/Test/Vitest registers its sidecar cleanup after the file's afterAll hooks
            // and expects them to run in that order; Vitest's default runs them in reverse, so
            // `destroy` would wait on a sidecar already closed.
            sequence: { hooks: "list" },
            testTimeout: 30_000,
            hookTimeout: 120_000,
            fileParallelism: true,
            pool: "forks",
          },
        },
      ],
    },
    fmt: { ignorePatterns: ["src/web/routeTree.gen.ts", "AGENTS.md", "refs/**"] },
    lint: {
      ignorePatterns: ["refs/**"],
      jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
      rules: {
        "vite-plus/prefer-vite-plus-imports": "error",
        "no-restricted-imports": ["error", { paths: [effectBarrel] }],
      },
      overrides: [
        runtimeBoundary("src/contract/**", ["backend", "web"], "The contract imports only itself."),
        runtimeBoundary(
          "src/web/**",
          ["backend"],
          "The Website bundle never carries Backend code; use `import type`.",
          { allowTypeImports: true },
        ),
        runtimeBoundary("src/backend/**", ["web"], "The Backend never imports the Website."),
        domainBoundary("src/domain/**"),
        domainBoundary("src/domain/platform.ts", ["orders.ts", "shop-work.ts", "billing.ts"]),
        domainBoundary("src/domain/orders.ts", ["shop-work.ts", "billing.ts"]),
        domainBoundary("src/domain/shop-work.ts", ["billing.ts"]),
        domainBoundary("src/domain/billing.ts", ["shop-work.ts"]),
        domainBoundary("src/domain/workflow-layout.ts", ["platform.ts", "orders.ts", "billing.ts"]),
      ],
      options: { typeAware: true, typeCheck: true },
    },
  };
});
