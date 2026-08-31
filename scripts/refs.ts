// Downloads reference sources into refs/, pinned to the versions this workspace
// actually depends on. Each entry names where the pin lives, so a dependency bump
// is the only edit needed -- re-running the fetch picks up the new tag.
//
//   node scripts/refs.ts fetch <name...>   fetch those refs
//   node scripts/refs.ts fetch --all       fetch every ref except the opt-in ones
//   node scripts/refs.ts check             report refs that drifted from the pins (exit 1 if any)
//   node scripts/refs.ts list              same report, without exiting non-zero
//
// Ported from ableton-extension-prelive's scripts/refs.ts, minus its Fluid Topics
// machinery. shopify.dev serves first-party markdown, so that ref fetches `.md` directly
// (refs-shopify-docs.ts); the competitor refs fetch and convert HTML, and one crawls with
// a browser, so a trimmed version of prelive's crawl support lives at the bottom of this
// file.

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Path, Result, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as ShopifyDocs from "./refs-shopify-docs.ts";

interface VersionSource {
  /**
   * Directory holding the package.json that owns the pin, relative to the repo root.
   * `.` for baton's own dependencies; `node_modules/<pkg>` reads the pin out of an
   * installed package, for a transitive dependency this repo does not pin directly
   * (partysocket rides whatever `agents` pins).
   */
  readonly from: string;
  readonly dep: string;
}

interface Ref {
  readonly name: string;
  /** GitHub repo to download from. */
  readonly repo?: string;
  /** npm package whose registry tarball is the source, for packages whose repo layout is not worth mapping. */
  readonly npm?: string;
  /** Tag template for versioned refs; {v} is the resolved version. */
  readonly tag?: string;
  readonly version?: VersionSource;
  /**
   * Literal version pin for a source with no package.json to read (the Shopify CLI is a
   * global tool, not a dependency). Bumping the literal is what marks the copy stale.
   */
  readonly pin?: string;
  /** Branch to track, for refs with no version to align to. */
  readonly branch?: string;
  /** Private repos are fetched through `gh api`, which carries your auth. */
  readonly private?: boolean;
  /** Fetched by scripts/refs-shopify-docs.ts instead of a tarball download. */
  readonly shopifyDocs?: boolean;
  /**
   * A competitor Shopify app's public web presence, fetched by `competitorInto` below.
   * These have no upstream version to pin to, so `refs check` reports only how old the copy is.
   */
  readonly competitor?: Competitor;
  /**
   * Skipped by `fetch --all`, so it has to be named explicitly. For refs whose fetch
   * is slow enough or outward-facing enough that folding it into the bulk command
   * would be a surprise -- a multi-minute fetch of thousands of live pages, say.
   */
  readonly optIn?: boolean;
}

const REFS: readonly Ref[] = [
  {
    name: "effect",
    repo: "Effect-TS/effect",
    tag: "effect@{v}",
    version: { from: ".", dep: "effect" },
  },
  {
    name: "tan-start",
    repo: "TanStack/router",
    tag: "@tanstack/react-start@{v}",
    version: { from: ".", dep: "@tanstack/react-start" },
  },
  {
    name: "tan-router",
    repo: "TanStack/router",
    tag: "@tanstack/react-router@{v}",
    version: { from: ".", dep: "@tanstack/react-router" },
  },
  {
    name: "tan-query",
    repo: "TanStack/query",
    tag: "@tanstack/react-query@{v}",
    version: { from: ".", dep: "@tanstack/react-query" },
  },
  {
    name: "tan-form",
    repo: "TanStack/form",
    tag: "@tanstack/react-form@{v}",
    version: { from: ".", dep: "@tanstack/react-form" },
  },
  {
    name: "vitest",
    repo: "vitest-dev/vitest",
    tag: "v{v}",
    version: { from: ".", dep: "vitest" },
  },
  {
    name: "playwright",
    repo: "microsoft/playwright",
    tag: "v{v}",
    version: { from: ".", dep: "@playwright/test" },
  },
  {
    name: "workers-sdk",
    repo: "cloudflare/workers-sdk",
    tag: "wrangler@{v}",
    version: { from: ".", dep: "wrangler" },
  },
  {
    name: "agents",
    repo: "cloudflare/agents",
    tag: "agents@{v}",
    version: { from: ".", dep: "agents" },
  },
  {
    name: "partysocket",
    // Not a direct dependency: agents pins it exactly, and this ref exists to dig into
    // the transport agents actually runs on, so the pin is read out of the installed
    // agents package and an agents bump moves this ref with it.
    npm: "partysocket",
    version: { from: "node_modules/agents", dep: "partysocket" },
  },
  {
    name: "better-auth",
    repo: "better-auth/better-auth",
    tag: "v{v}",
    version: { from: ".", dep: "better-auth" },
  },
  {
    name: "shopify-app-js",
    repo: "Shopify/shopify-app-js",
    tag: "@shopify/shopify-api@{v}",
    version: { from: ".", dep: "@shopify/shopify-api" },
  },
  {
    name: "shopify-bridge",
    repo: "Shopify/shopify-app-bridge",
    tag: "@shopify/app-bridge-react@{v}",
    version: { from: ".", dep: "@shopify/app-bridge-react" },
  },
  {
    name: "shopify-codegen",
    repo: "Shopify/shopify-app-js",
    tag: "@shopify/api-codegen-preset@{v}",
    version: { from: ".", dep: "@shopify/api-codegen-preset" },
  },
  {
    name: "shopify-cli",
    repo: "Shopify/cli",
    tag: "{v}",
    pin: "4.7.0",
  },
  {
    name: "shopify-app-template",
    repo: "Shopify/shopify-app-template-react-router",
    branch: "main",
  },
  {
    name: "cloudflare-docs",
    repo: "cloudflare/cloudflare-docs",
    branch: "production",
  },
  {
    name: "bang",
    repo: "mw10013/bang",
    branch: "main",
    private: true,
  },
  {
    name: "shopify-docs",
    shopifyDocs: true,
    optIn: true,
  },
  // The five anchor apps from the production-workflow competitor research. Each is fetched
  // and aged on its own; `refs check` reports how long ago each copy was taken.
  {
    name: "route-to-ship",
    competitor: {
      listing: "route-to-ship",
      site: { origin: "https://www.routetoship.com", sitemap: "/sitemap.xml" },
    },
    optIn: true,
  },
  {
    // The only anchor whose site is client-rendered: every path serves the same ~4KB
    // `<div id="root">` shell and the copy lives in one JS bundle, so this is the sole
    // ref that needs the crawler and its Chromium render. Its router declares exactly
    // two routes, `/` and `/privacy`.
    name: "kanbanify",
    competitor: {
      listing: "kanbanify",
      crawl: {
        url: "https://kanbanify.ungari.org/",
        include: String.raw`^https://kanbanify\.ungari\.org/`,
        browser: true,
      },
    },
    optIn: true,
  },
  {
    // Maker's Production View, published by Fleartex. The site publishes no usable
    // sitemap (both sitemap.xml and sitemap-index.xml fall through to the homepage), so
    // the three pages are listed explicitly.
    //
    // Its robots.txt carries `Content-Signal: search=yes, ai-train=no, use=reference` for
    // `User-agent: *`, plus `Disallow: /` for a named list of AI training and answer-engine
    // crawlers. This fetch is none of those: it identifies as `baton/refs-competitors`,
    // takes three pages once, and reads them locally as reference -- the `use=reference`
    // the `*` policy grants. It must never be run under a borrowed crawler token.
    name: "makers-production-view",
    competitor: {
      listing: "maker-production-view",
      site: {
        origin: "https://fleartex.com",
        paths: ["/", "/maker-production-view/support/", "/maker-production-view/privacy/"],
      },
    },
    optIn: true,
  },
  {
    // MakerBatch has no marketing site: `/` is a Next.js 404 marked noindex, because the
    // deployment is the embedded Shopify app itself. `/privacy` is the only page that
    // resolves, and it is where the app's documented scope and infrastructure live.
    name: "makerbatch",
    competitor: {
      listing: "makerbatch",
      site: { origin: "https://makerbatch.vercel.app", paths: ["/privacy"] },
    },
    optIn: true,
  },
  {
    name: "benchcue",
    competitor: {
      listing: "maker-card",
      site: { origin: "https://maker-card.revertcreations.com", sitemap: "/sitemap.xml" },
    },
    optIn: true,
  },
];

const refNames = REFS.map((ref) => ref.name);

/** Name column for `list`/`check`, widened by whichever ref name is longest. */
const NAME_COL = Math.max(...refNames.map((name) => name.length)) + 1;

class RefsError extends Schema.TaggedError<RefsError>()("RefsError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason;
  }
}

/** The `.ref.json` stamp written into each fetched copy. */
const Stamp = Schema.Struct({
  repo: Schema.optional(Schema.String),
  /** npm package name, for refs fetched from the registry. */
  npm: Schema.optional(Schema.String),
  /** Entry URL, for refs fetched from a docs site. */
  url: Schema.optional(Schema.String),
  /** Tag, branch, or version this copy came from. */
  resolved: Schema.String,
  version: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  fetchedAt: Schema.String,
});
const StampJson = Schema.fromJsonString(Stamp, { space: 2 });

/** The slice of a package.json this script reads. */
const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

const repoRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  const here = yield* path.fromFileUrl(new URL(import.meta.url));
  return path.join(path.dirname(here), "..");
});

const readManifest = Effect.fn(function* (manifestPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.mapError(() => new RefsError({ reason: `no package.json at ${manifestPath}` })));
  return yield* Schema.decodeEffect(Manifest)(text);
});

/** A range would make the ref ambiguous -- there is no single tag to fetch. */
const assertExact = (version: string, source: VersionSource) =>
  /^\d/u.test(version)
    ? Effect.succeed(version)
    : new RefsError({
        reason: `${source.dep} in ${source.from} is a range (${version}); pin it exactly`,
      });

/** Resolve a ref's version from whichever manifest owns the pin. */
const resolveVersion = Effect.fn(function* (source: VersionSource) {
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  const manifest = yield* readManifest(path.join(root, source.from, "package.json"));
  const version = manifest.dependencies?.[source.dep] ?? manifest.devDependencies?.[source.dep];
  if (version === undefined)
    return yield* new RefsError({ reason: `${source.dep} is not a dependency of ${source.from}` });
  return yield* assertExact(version, source);
});

interface Resolved {
  readonly ref: Ref;
  /** The tag or branch to fetch, or the version to download. */
  readonly target: string;
  readonly version?: string;
  readonly source?: string;
}

const resolve = Effect.fn(function* (ref: Ref) {
  if (ref.branch) return { ref, target: ref.branch };
  // The Shopify docs pin is the webhooks API version literal in refs-shopify-docs.ts.
  // Leaving `version` unset puts the ref on the age-reported path in `checkRefs`:
  // bumping the literal marks the old copy stale, and until then only its age says
  // anything. Same reasoning for a `pin` ref.
  if (ref.shopifyDocs) return { ref, target: ShopifyDocs.API_VERSION };
  // A competitor snapshot has no upstream version to pin to -- nothing publishes one, and a
  // hand-edited date would only be a note to self wearing a pin's clothing, marking every
  // ref that shared it stale on edit. The target names the source instead, `version` stays
  // unset, and each ref ages independently off its own `fetchedAt`.
  if (ref.competitor) return { ref, target: `${APP_STORE_ORIGIN}/${ref.competitor.listing}` };
  if (ref.pin) return { ref, target: (ref.tag ?? "{v}").replace("{v}", ref.pin) };
  if (!ref.version || !(ref.tag ?? ref.npm))
    return yield* new RefsError({
      reason: `${ref.name} needs a branch, a pin, or a version plus a tag or npm package`,
    });
  const version = yield* resolveVersion(ref.version).pipe(
    Effect.mapError((error) =>
      error instanceof RefsError ? error : new RefsError({ reason: error.message }),
    ),
  );
  return {
    ref,
    // An npm ref has no tag to name the download, so the version is the target itself.
    target: ref.tag?.replace("{v}", version) ?? version,
    version,
    source: `${ref.version.from} ${ref.version.dep}`,
  };
});

const readStamp = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repoRoot;
  const stampPath = path.join(root, "refs", name, ".ref.json");
  return (yield* fs.exists(stampPath))
    ? yield* Schema.decodeEffect(StampJson)(yield* fs.readFileString(stampPath))
    : undefined;
});

/** Download the ref's tarball and extract it into staging. */
const downloadInto = Effect.fn(function* (staging: string, ref: Ref, target: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const tarball = ref.private
    ? ChildProcess.make("gh", ["api", `repos/${ref.repo ?? ""}/tarball/${target}`], {
        stderr: "inherit",
      })
    : // GitHub's archive URLs are namespaced by git ref type, so a branch lives under
      // refs/heads and a tag under refs/tags; using the wrong one is a plain 404. npm
      // registry tarballs carry a `package/` prefix, so the same strip-components works.
      ChildProcess.make(
        "curl",
        [
          "-fsSL",
          ref.npm
            ? `https://registry.npmjs.org/${ref.npm}/-/${ref.npm}-${target}.tgz`
            : `https://github.com/${ref.repo ?? ""}/archive/refs/${ref.branch ? "heads" : "tags"}/${target}.tar.gz`,
        ],
        { stderr: "inherit" },
      );
  // Wire the download into tar by hand rather than with ChildProcess.pipeTo: a
  // pipeline reports only tar's exit code, and tar accepts empty input, so a
  // failed download would look like success. Checking both exit codes is the
  // `pipefail` the old bash pipeline had.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const download = yield* spawner.spawn(tarball);
      const extract = ChildProcess.make("tar", ["-xz", "-C", staging, "--strip-components=1"], {
        stderr: "inherit",
        stdin: download.stdout,
      });
      const tarExit = yield* spawner.exitCode(extract);
      const downloadExit = yield* download.exitCode;
      if (downloadExit !== 0 || tarExit !== 0) {
        yield* new RefsError({
          reason: `download of ${target} failed (exit ${String(downloadExit || tarExit)})`,
        });
      }
    }),
  );
});

/** Fill staging with the ref's content: a docs fetch or a tarball download. */
const fillStaging = Effect.fn(function* (staging: string, ref: Ref, target: string) {
  if (ref.shopifyDocs)
    return yield* ShopifyDocs.downloadInto(staging).pipe(
      Effect.mapError((error) => new RefsError({ reason: error.message })),
    );
  if (ref.competitor) return yield* competitorInto(staging, ref.competitor);
  if (!(ref.repo ?? ref.npm))
    return yield* new RefsError({
      reason: `${ref.name} needs a repo, an npm package, shopifyDocs, or a competitor`,
    });
  return yield* downloadInto(staging, ref, target);
});

// ---------------------------------------------------------------------------
// Competitor site snapshots
// ---------------------------------------------------------------------------

/** Every file under `dir`, walked iteratively so the effect stays non-recursive. */
const allFiles = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const out: string[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    for (const entry of yield* fs
      .readDirectory(current)
      .pipe(Effect.orElseSucceed(() => []))) {
      const full = path.join(current, entry);
      const type = yield* fs.stat(full).pipe(
        Effect.map((s) => s.type),
        Effect.orElseSucceed(() => "Other" as const),
      );
      if (type === "Directory") pending.push(full);
      else out.push(full);
    }
  }
  return out;
});

/** Make `name` unique within `used`, suffixing before the extension. */
const uniqueName = (name: string, used: Set<string>) => {
  let candidate = name;
  for (let n = 2; used.has(candidate); n++)
    candidate = /\./u.test(name)
      ? name.replace(/(?<ext>\.[^.]+)$/u, `-${String(n)}$<ext>`)
      : `${name}-${String(n)}`;
  used.add(candidate);
  return candidate;
};

const APP_STORE_ORIGIN = "https://apps.shopify.com";
/**
 * Self-identifying, and deliberately not any AI crawler's token. Sites in this set
 * publish per-crawler robots policies; borrowing one of those names would misrepresent
 * what is fetching, and the policy that applies here is the site's `User-agent: *` one.
 */
const USER_AGENT = "baton/refs-competitors (+https://github.com/mw10013/baton)";
/** Below refs-shopify-docs.ts's 8: these are small personal servers, not shopify.dev. */
const CONCURRENCY = 4;
const CRAWLER = "siteone-crawler";

/**
 * Chrome to drop from an App Store listing before conversion. The recommended-apps
 * carousel is the load-bearing one: it prints other apps' review counts ("23 total
 * reviews") into a file whose entire purpose is review-count evidence, which is the
 * kind of wrong that reads as right. A selector that stops matching fails silently, so
 * `downloadInto` asserts the carousel is gone rather than trusting the exit code.
 */
const APP_STORE_EXCLUDE = [
  "footer",
  '[data-controller="recommended-apps"]',
] as const;
/** Hosts whose images are worth localizing alongside a page's own. */
const SHOPIFY_ASSET_HOSTS = new Set([
  "cdn.shopify.com",
  "apps.shopify.com",
  "shopify-assets.shopifycdn.com",
]);

/**
 * A site crawled with siteone-crawler rather than fetched a URL at a time, for one whose
 * served HTML has no content in it. `include` is PCRE matched against the whole absolute
 * URL, not the path -- a path-anchored regex matches nothing and the crawl then quietly
 * fetches the entry page alone and exits 0, a failure that looks like success.
 */
interface Crawl {
  readonly url: string;
  readonly include: string;
  /**
   * Render each page in Chromium before converting. Costs roughly 20s per page against
   * ~0.3s for plain HTTP, so it is worth it only when the served HTML is genuinely empty.
   */
  readonly browser?: boolean;
}

interface Competitor {
  /** App Store listing handle: apps.shopify.com/<handle>. */
  readonly listing: string;
  /** Pages served as HTML, fetched by URL and converted locally. */
  readonly site?: {
    readonly origin: string;
    /** Explicit paths, for a site that publishes no usable sitemap. */
    readonly paths?: readonly string[];
    /** Sitemap to enumerate instead, relative to `origin`. */
    readonly sitemap?: string;
  };
  /** Client-rendered site, crawled instead of fetched. */
  readonly crawl?: Crawl;
  /** Extra CSS selectors dropped from this site's pages before conversion. */
  readonly excludeSelector?: readonly string[];
}

const request = (url: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("user-agent", USER_AGENT),
        ),
      ),
    ),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
  );

const requestText = (url: string) =>
  request(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError(() => new RefsError({ reason: `GET ${url} failed` })),
  );

const requestBytes = (url: string) =>
  request(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError(() => new RefsError({ reason: `GET ${url} failed` })),
  );

/** The crawler's converter, run over one HTML file already on disk. */
const htmlToMarkdown = Effect.fn(function* (
  from: string,
  to: string,
  excludeSelector: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exit = yield* spawner.exitCode(
    ChildProcess.make(
      CRAWLER,
      [
        `--html-to-markdown=${from}`,
        `--html-to-markdown-output=${to}`,
        ...excludeSelector.map((s) => `--markdown-exclude-selector=${s}`),
      ],
      // Silenced: this converter reports *success* on stderr, so inheriting it prints a
      // green line per file. The exit code is the signal.
      { stdout: "ignore", stderr: "ignore" },
    ),
  );
  if (exit !== 0) {
    yield* new RefsError({
      reason: `converting ${from} failed (exit ${String(exit)})`,
    });
  }
});

/**
 * Undo the converter's heading mangling: in heading lines only, `_`, `*`, `[` and `]` are
 * each replaced by a bare `\`, so `line_item` exports as `line\item` and `number[]` as
 * `number\\`. (`(`, `)`, `|`, `+` are escaped correctly and their `\` must be left alone.)
 * No crawler flag fixes it -- `--markdown-replace-content` cannot match a literal
 * backslash -- so it is repaired afterwards, using what follows the closing `\` to
 * disambiguate: `\1\` before a space is a type annotation, before a word char an eaten
 * pair. Unconditional, because the mangling is a converter bug rather than a property of
 * any one site.
 */
const repairHeading = (line: string) =>
  line.startsWith("#")
    ? line
        .replaceAll(/\\\\(?<name>\w+)\\\\/gu, "__$<name>__")
        .replaceAll(String.raw`\\`, "[]")
        .replaceAll(
          /\\(?<inner>[^\\|]*[ ,][^\\|]*)\\(?=[ \t]|$)/gu,
          "[$<inner>]",
        )
        .replaceAll(/\\(?<word>\w+)\\(?=[ \t]|$)/gu, "[$<word>]")
        .replaceAll(/\\(?=[A-Za-z0-9])/gu, "_")
        .replaceAll(/\\(?=[ \t]|$)/gu, "_")
    : line;

/**
 * Drop the site-navigation blocks the converter emits as `<details><summary>...</summary>`.
 * They survive every `--markdown-exclude-selector` aimed at them (`header`, `nav`, the
 * navbar's own id each leave the output byte-identical), because the converter wraps nav
 * elements after the selectors have run. Removing them here is what the selectors could
 * not do.
 *
 * Matched on content rather than on the `<summary>` label: the converter names the block
 * from the markup and has been seen to emit both "Menu" and "Links" for the same navbar,
 * so keying on the label silently stops working. Every one of these blocks is App Store
 * chrome carrying `surface_type=navbar` links, and nothing else in this output is a
 * `<details>` block at all.
 */
const stripNavDetails = (markdown: string) =>
  markdown.replaceAll(
    /^<details>\n<summary>[^<]*<\/summary>\n[\s\S]*?<\/details>\n+/gmu,
    (block) => (block.includes("surface_type=navbar") ? "" : block),
  );

const repairMarkdown = Effect.fn(function* (staging: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const file of (yield* allFiles(staging)).filter((f) =>
    f.endsWith(".md"),
  )) {
    const before = yield* fs.readFileString(file);
    const after = stripNavDetails(
      before.split("\n").map(repairHeading).join("\n"),
    );
    if (after !== before) yield* fs.writeFileString(file, after);
  }
});

/**
 * Preflight so a missing binary reads as an install hint rather than a bare ENOENT from
 * the spawner, minutes into a run.
 */
const assertCrawler = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const found = yield* spawner.exitCode(
    ChildProcess.make("which", [CRAWLER], {
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  if (found !== 0) {
    yield* new RefsError({
      reason: `${CRAWLER} is not on PATH -- install it with \`brew install janreges/tap/${CRAWLER}\``,
    });
  }
});

/** Crawl a client-rendered site into markdown, images and all, under `staging`. */
const crawlInto = Effect.fn(function* (
  staging: string,
  crawl: Crawl,
  excludeSelector: readonly string[],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* assertCrawler;
  const exit = yield* spawner.exitCode(
    ChildProcess.make(
      CRAWLER,
      [
        `--url=${crawl.url}`,
        `--include-regex=${crawl.include}`,
        "--regex-filtering-only-for-pages",
        ...(crawl.browser === true
          ? [
              "--browser",
              "--browser-wait=networkidle",
              "--browser-wait-extra=3000",
              // A very tall render viewport is what makes lazy-loaded figures resolve:
              // they carry only `data-src` until they scroll into view, so a normal
              // viewport yields markdown with no `![]()` in it at all.
              "--screenshot-viewport=1600x30000",
              // Consent up front: with no browser installed the crawler otherwise stops
              // on an interactive prompt that a spawned process has no way to answer.
              "--browser-auto-download",
            ]
          : []),
        ...excludeSelector.map((s) => `--markdown-exclude-selector=${s}`),
        `--user-agent=${USER_AGENT}`,
        `--markdown-export-dir=${staging}`,
        "--workers=2",
        "--max-reqs-per-sec=3",
        // Empty paths switch off the audit report, JSON and text dumps, none of which
        // belong in a ref.
        "--output-html-report=",
        "--output-json-file=",
        "--output-text-file=",
      ],
      { stdout: "ignore", stderr: "inherit" },
    ),
  );
  if (exit !== 0) {
    yield* new RefsError({
      reason: `crawl of ${crawl.url} failed (exit ${String(exit)})`,
    });
  }
});

/** `/` -> `index.md`, `/pricing` -> `pricing.md`, `/blog/foo/` -> `blog/foo.md`. */
const toLocalName = (pathname: string) => {
  const trimmed = pathname.replaceAll(/^\/|\/$/gu, "");
  return `${trimmed === "" ? "index" : trimmed}.md`;
};

const sitemapUrls = Effect.fn(function* (origin: string, sitemap: string) {
  const xml = yield* requestText(new URL(sitemap, origin).toString());
  const urls = [...xml.matchAll(/<loc>(?<url>[^<]+)<\/loc>/gu)].flatMap(
    (match) => {
      const raw = match.groups?.url?.trim();
      if (raw === undefined) return [];
      const url = new URL(raw);
      return url.origin === new URL(origin).origin ? [url.toString()] : [];
    },
  );
  if (urls.length === 0)
    return yield* new RefsError({
      reason: `no URLs in sitemap ${sitemap} of ${origin}`,
    });
  return urls.toSorted();
});

/**
 * Fetch one page and convert it, recording where it came from. The HTML is staged beside
 * its markdown and removed after conversion: the converter only reads files on disk, and
 * a ref of raw HTML is not what anyone greps.
 */
const fetchPage = Effect.fn(function* (
  staging: string,
  url: string,
  name: string,
  excludeSelector: readonly string[],
  sources: Map<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(staging, name);
  const html = `${target}.html`;
  yield* fs.makeDirectory(path.dirname(target), { recursive: true });
  yield* fs.writeFileString(html, yield* requestText(url));
  yield* htmlToMarkdown(html, target, excludeSelector);
  yield* fs.remove(html, { force: true });
  yield* fs.writeFileString(
    target,
    `---\nsource_url: ${url}\n---\n\n${(yield* fs.readFileString(target)).trimStart()}`,
  );
  sources.set(target, url);
});

const IMAGE_LINK_RE = /!\[[^\]]*\]\((?<url>[^)\s]+)\)/gu;

/**
 * Download the images the fetched pages reference into `_assets/` and rewrite the links.
 * Unlike the shopify.dev refs these links are mostly root-relative (`/shots/queue.png`),
 * which resolve to nothing locally, so each is resolved against the URL its page came
 * from -- product screenshots are a large part of why these refs exist. Only the page's
 * own host and Shopify's asset hosts are fetched, so a third-party embed keeps its
 * absolute URL rather than getting pulled off someone else's server. A failed download
 * logs and leaves that link alone: a missing figure should not fail the whole fetch.
 */
const localizeImages = Effect.fn(function* (
  staging: string,
  sources: Map<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const wanted = (raw: string | undefined, source: string) => {
    const url =
      raw === undefined || raw.startsWith("data:")
        ? null
        : URL.parse(raw, source);
    return url !== null &&
      url.protocol.startsWith("http") &&
      (url.hostname === new URL(source).hostname ||
        SHOPIFY_ASSET_HOSTS.has(url.hostname))
      ? url.toString()
      : undefined;
  };

  const resolved = new Map<string, string>();
  for (const [file, source] of sources) {
    if (yield* fs.exists(file)) {
      for (const match of (yield* fs.readFileString(file)).matchAll(
        IMAGE_LINK_RE,
      )) {
        const raw = match.groups?.url;
        const url = wanted(raw, source);
        if (raw !== undefined && url !== undefined) resolved.set(raw, url);
      }
    }
  }
  if (resolved.size === 0) return;

  const assetsDir = path.join(staging, "_assets");
  yield* fs.makeDirectory(assetsDir, { recursive: true });

  // Names are assigned up front (uniqueName mutates its set), then the downloads run
  // concurrently; a failure drops the entry so its link is left as it was.
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const [raw, url] of resolved)
    names.set(
      raw,
      uniqueName(
        decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""),
        used,
      ),
    );

  const results = yield* Effect.forEach(
    [...names],
    ([raw, name]) =>
      requestBytes(resolved.get(raw) ?? raw).pipe(
        Effect.flatMap((bytes) =>
          fs.writeFile(path.join(assetsDir, name), bytes),
        ),
        Effect.as(raw),
        Effect.catch((error) =>
          Console.error(`image failed ${raw}: ${error.message}`).pipe(
            Effect.andThen(() => {
              names.delete(raw);
              return Effect.succeed(null);
            }),
          ),
        ),
      ),
    { concurrency: CONCURRENCY },
  );

  for (const file of sources.keys()) {
    const before = yield* fs
      .readFileString(file)
      .pipe(Effect.orElseSucceed(() => ""));
    const after = before.replaceAll(IMAGE_LINK_RE, (link) => {
      const raw =
        /!\[[^\]]*\]\((?<url>[^)\s]+)\)/u.exec(link)?.groups?.url ?? "";
      const name = names.get(raw);
      return name === undefined
        ? link
        : link.replace(
            raw,
            path
              .relative(path.dirname(file), path.join(assetsDir, name))
              .replaceAll("\\", "/"),
          );
    });
    if (after !== before) yield* fs.writeFileString(file, after);
  }
  yield* Console.log(
    `  images: ${String(results.filter((r) => r !== null).length)}/${String(resolved.size)} localized to _assets/`,
  );
});

/** Mirror one competitor's listing, reviews and site into `staging` as markdown. */
const competitorInto = (staging: string, competitor: Competitor) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sources = new Map<string, string>();

    const listing = `${APP_STORE_ORIGIN}/${competitor.listing}`;
    yield* fetchPage(
      staging,
      listing,
      "listing.md",
      APP_STORE_EXCLUDE,
      sources,
    );
    yield* fetchPage(
      staging,
      `${listing}/reviews`,
      "reviews.md",
      APP_STORE_EXCLUDE,
      sources,
    );
    // The carousel selector is the one whose silent rot would corrupt the evidence rather
    // than merely add noise, so it is checked rather than assumed.
    if (
      /\d+ total reviews/u.test(
        yield* fs.readFileString(path.join(staging, "listing.md")),
      )
    ) {
      yield* new RefsError({
        reason: `${competitor.listing}: recommended-apps carousel leaked into listing.md -- the exclude selector no longer matches`,
      });
    }

    if (competitor.site) {
      const { origin, paths, sitemap } = competitor.site;
      const urls = sitemap
        ? yield* sitemapUrls(origin, sitemap)
        : (paths ?? []).map((p) => new URL(p, origin).toString());
      yield* Console.log(
        `  ${new URL(origin).hostname}: ${String(urls.length)} page(s)`,
      );
      yield* Effect.forEach(
        urls,
        (url) =>
          fetchPage(
            staging,
            url,
            toLocalName(new URL(url).pathname),
            competitor.excludeSelector ?? [],
            sources,
          ),
        { concurrency: CONCURRENCY },
      );
    }

    if (competitor.crawl)
      yield* crawlInto(
        staging,
        competitor.crawl,
        competitor.excludeSelector ?? [],
      );

    yield* repairMarkdown(staging);
    yield* localizeImages(staging, sources);
  }).pipe(Effect.provide(FetchHttpClient.layer));

/** Entry URL for the stamp, for the refs fetched from the web rather than a tarball. */
const stampUrl = (ref: Ref) => {
  if (ref.competitor) return `${APP_STORE_ORIGIN}/${ref.competitor.listing}`;
  return ref.shopifyDocs ? ShopifyDocs.ORIGIN : undefined;
};

/** How a ref without a package.json pin gets its content, for the fetch's first line. */
const sourceKind = (ref: Ref) => {
  if (ref.shopifyDocs) return "docs";
  if (ref.competitor) return "snapshot";
  if (ref.npm) return "npm";
  if (ref.branch) return "branch";
  return "pin";
};

const fetchRef = Effect.fn(function* ({ ref, source, target, version }: Resolved) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* repoRoot;

  const label = source ? `${target}  (${source})` : `${target} (${sourceKind(ref)})`;
  yield* Console.log(`${ref.name}: ${label}`);

  // Fill a temp dir first so a failed fetch leaves the existing ref intact.
  const staging = yield* fs.makeTempDirectory({ prefix: `refs-${ref.name}-` });
  yield* Effect.gen(function* () {
    yield* fillStaging(staging, ref, target);

    const stamp = yield* Schema.encodeEffect(StampJson)({
      repo: ref.repo,
      npm: ref.npm,
      url: stampUrl(ref),
      resolved: target,
      version,
      source,
      fetchedAt: new Date().toISOString(),
    });
    yield* fs.writeFileString(path.join(staging, ".ref.json"), `${stamp}\n`);

    const refDir = path.join(root, "refs", ref.name);
    yield* fs.makeDirectory(path.dirname(refDir), { recursive: true });
    yield* fs.remove(refDir, { recursive: true, force: true });
    yield* fs.rename(staging, refDir);
    yield* Console.log(`  -> refs/${ref.name}`);
  }).pipe(
    Effect.onError(() => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/** Print one status line per ref and return how many drifted from their pins. */
const checkRefs = Effect.gen(function* () {
  let stale = 0;
  for (const ref of REFS) {
    const resolved = yield* Effect.result(resolve(ref));
    const stamp = Result.isSuccess(resolved) ? yield* readStamp(ref.name) : undefined;
    if (Result.isFailure(resolved)) {
      yield* Console.log(`${ref.name.padEnd(NAME_COL)} ERROR  ${resolved.failure.message}`);
      stale++;
    } else if (stamp === undefined) {
      yield* Console.log(`${ref.name.padEnd(NAME_COL)} MISSING  want ${resolved.success.target}`);
      stale++;
    } else if (stamp.resolved !== resolved.success.target) {
      yield* Console.log(
        `${ref.name.padEnd(NAME_COL)} STALE  have ${stamp.resolved}  want ${resolved.success.target}`,
      );
      stale++;
    } else if (resolved.success.version === undefined) {
      // No resolved version means a branch, pin, docs, or competitor ref, whose target
      // names itself rather than a package.json pin, so age is all there is to report.
      const days = Math.floor((Date.now() - Date.parse(stamp.fetchedAt)) / 86_400_000);
      yield* Console.log(
        `${ref.name.padEnd(NAME_COL)} ${resolved.success.target}  fetched ${days === 0 ? "today" : `${String(days)}d ago`}`,
      );
    } else {
      yield* Console.log(`${ref.name.padEnd(NAME_COL)} ok  ${resolved.success.version}`);
    }
  }
  return stale;
});

const toUserError = (error: unknown) =>
  new CliError.UserError({
    cause: error,
    userMessage: error instanceof Error ? error.message : String(error),
  });

const fetchCommand = Command.make(
  "fetch",
  {
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Fetch every ref except the opt-in ones"),
      Flag.withDefault(false),
    ),
    names: Argument.choice("name", refNames).pipe(
      Argument.variadic(),
      Argument.withDescription("Refs to fetch"),
    ),
  },
  Effect.fn(function* ({ all, names }) {
    if (!all && names.length === 0) {
      yield* new CliError.UserError({
        cause: "no refs named",
        userMessage: "name refs to fetch, or pass --all",
      });
    }
    const refs = all
      ? REFS.filter((ref) => !ref.optIn)
      : REFS.filter((ref) => names.includes(ref.name));
    const failed: string[] = [];
    for (const ref of refs) {
      // A failed fetch leaves any existing copy in place, so keep going.
      yield* resolve(ref).pipe(
        Effect.flatMap(fetchRef),
        Effect.catch((error) =>
          Effect.gen(function* () {
            failed.push(ref.name);
            yield* Console.error(`${ref.name}: failed -- ${error.message}`);
          }),
        ),
      );
    }
    if (failed.length > 0) {
      yield* new CliError.UserError({
        cause: "fetch failed",
        userMessage: `failed to fetch: ${failed.join(", ")}`,
      });
    }
  }),
).pipe(
  Command.withDescription("Download refs into refs/, pinned to the workspace versions"),
  Command.withExamples([
    { command: "refs fetch tan-router", description: "Fetch one ref" },
    { command: "refs fetch --all", description: "Fetch every ref except the opt-in ones" },
    {
      command: "refs fetch shopify-docs",
      description: "Fetch an opt-in ref (minutes, not seconds)",
    },
  ]),
);

const checkCommand = Command.make(
  "check",
  {},
  Effect.fn(function* () {
    const stale = yield* checkRefs.pipe(Effect.mapError(toUserError));
    if (stale > 0) {
      yield* new CliError.UserError({
        cause: "refs drifted",
        userMessage: `${String(stale)} ref(s) drifted from the pins`,
      });
    }
  }),
).pipe(Command.withDescription("Report refs that drifted from the pins; exit 1 if any"));

const listCommand = Command.make(
  "list",
  {},
  Effect.fn(function* () {
    yield* checkRefs.pipe(Effect.mapError(toUserError));
  }),
).pipe(Command.withDescription("Report the status of every ref"));

const refsCommand = Command.make("refs").pipe(
  Command.withDescription("Manage the pinned reference sources in refs/"),
  Command.withSubcommands([fetchCommand, checkCommand, listCommand]),
);

NodeRuntime.runMain(
  refsCommand.pipe(Command.run({ version: "0.0.0" }), Effect.provide(NodeServices.layer)),
);
