// Mirrors the Shopify dev docs into a staging directory for scripts/refs.ts.
//
// shopify.dev serves first-party markdown at every `/docs/**.md` URL (each HTML page
// advertises it via `<link rel="alternate" type="text/markdown">`), which is higher
// fidelity than any HTML-to-markdown conversion -- a crawled copy of the same pages
// loses every fenced code block. So discovery is sitemap-driven and the fetch is the
// `.md` URL directly. The two exceptions:
//
// - Webhook topic pages are client-rendered (a ~300-byte shell, `.md` is a 404), so
//   the topic list is decoded out of the React Router `.data` payload and rendered to
//   markdown here.
// - The `.md` pages reference images by absolute URL, so a post-pass downloads the
//   ones under Shopify's hosts into `_assets/` and rewrites the links, making the ref
//   self-contained.
//
// Ported from mw10013/bang scripts/refs-shopify-docs.ts (see refs/bang), reshaped from
// a standalone CLI into a library for refs.ts and with the image post-pass added.

import { Console, Data, Effect, FileSystem, Path } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import zlib from "node:zlib";

export class ShopifyDocsError extends Data.TaggedError("ShopifyDocsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const ORIGIN = "https://shopify.dev";
/** Webhooks API version the topic pages are pinned to; matches shopify.app.toml. */
export const API_VERSION = "2026-10";
const SITEMAP_URL = `${ORIGIN}/sitemap_standard.xml.gz`;
const USER_AGENT =
  "baton/refs-shopify-docs (+https://github.com/mw10013/baton)";
const CONCURRENCY = 8;

type DocSection = "apps" | "api" | "admin-graphql";
type DiscoveryKind = "sitemap-prefix" | "webhooks-data";

interface SectionSource {
  readonly label: string;
  readonly kind: DiscoveryKind;
  readonly prefix: string;
  readonly namePrefixes?: readonly string[];
}

const SECTION_SOURCES: Record<DocSection, readonly SectionSource[]> = {
  apps: [
    {
      label: "apps-build",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/apps/build`,
    },
    {
      label: "apps-design",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/apps/design`,
    },
    {
      label: "apps-launch",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/apps/launch`,
    },
  ],
  api: [
    {
      label: "api-usage",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/usage`,
    },
    {
      label: "api-app-home",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/app-home`,
    },
    {
      label: "api-polaris",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/polaris`,
    },
    {
      label: "api-shopify-cli",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/shopify-cli`,
    },
    {
      label: "api-partner",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/partner/latest`,
    },
    {
      label: "api-webhooks",
      kind: "webhooks-data",
      prefix: `${ORIGIN}/docs/api/webhooks/${API_VERSION}`,
    },
  ],
  "admin-graphql": [
    {
      label: "admin-graphql",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/admin-graphql/latest`,
      namePrefixes: [
        // "abandoned",
        // "abandonment",
        "access",
        // "analytics",
        "app",
        // "article",
        // "blog",
        "bulkOperation",
        // "carrier",
        // "cart",
        "catalog",
        // "checkoutBranding",
        // "checkoutProfile",
        "collection",
        "company",
        "consent",
        "currentAppInstallation",
        "currentBulkOperation",
        // "currentStaffMember",
        // "customer",
        // "delivery",
        "discount",
        "draftOrder",
        "event",
        "file",
        // "fulfillment",
        // "gift",
        "inventory",
        "job",
        "location",
        "market",
        "media",
        "menu",
        "metafield",
        "metaobject",
        // "order",
        "page",
        // "payment",
        // "pos",
        "price",
        // "privacy",
        "product",
        "publication",
        "publishable",
        "redirect",
        // "refund",
        // "return",
        // "savedSearch",
        // "scriptTag",
        // "segment",
        // "sellingPlan",
        "shop",
        // "staff",
        // "storeCredit",
        "subscription",
        // "tender",
        // "translatable",
        "url",
        "validation",
        "webhook",
        // "webPixel",
      ],
    },
  ],
};

const DEFAULT_SECTIONS = Object.keys(SECTION_SOURCES) as DocSection[];

interface WebhookTopicExampleTab {
  readonly title?: string;
  readonly code?: string;
}

interface WebhookTopicExample {
  readonly title?: string;
  readonly description?: string;
  readonly tabs?: readonly WebhookTopicExampleTab[];
}

interface WebhookTopic {
  readonly name: string;
  readonly description?: string;
  readonly isOptional?: boolean;
  readonly availableOn?: readonly string[];
  readonly relatedResource?: string;
  readonly webhooksNotices?: readonly string[];
  readonly examples?: readonly WebhookTopicExample[];
}

type DocTask =
  | {
      readonly kind: "Markdown";
      readonly section: DocSection;
      readonly docUrl: string;
    }
  | {
      readonly kind: "Webhook";
      readonly section: DocSection;
      readonly docUrl: string;
      readonly content: string;
    };

function canonicalizeDocUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // oxlint-disable-next-line prefer-string-replace-all
  const cleaned = trimmed.replace(/^<|>$/gu, "").replace(/[),.;]+$/u, "");

  let url: URL;
  try {
    url = new URL(cleaned, ORIGIN);
  } catch {
    return null;
  }

  if (url.hostname !== "shopify.dev") return null;
  if (!url.pathname.startsWith("/docs/")) return null;

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\.md$/iu, "").replace(/\.txt$/iu, "");
  url.pathname = url.pathname.replaceAll(/\/{2,}/gu, "/");

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

function isUnderPrefix(url: string, prefix: string): boolean {
  return url === prefix || url.startsWith(`${prefix}/`);
}

function matchesNamePrefixes(
  url: string,
  namePrefixes: readonly string[] | undefined,
  canonicalPrefix: string,
): boolean {
  if (!namePrefixes || url === canonicalPrefix) return true;
  const lastSegment =
    new URL(url).pathname.split("/").pop()?.toLowerCase() ?? "";
  return namePrefixes.some((p) => lastSegment.startsWith(p.toLowerCase()));
}

function collectSitemapUrls(
  sitemapXml: string,
  prefix: string,
  namePrefixes: readonly string[] | undefined,
): Set<string> {
  const canonicalPrefix = canonicalizeDocUrl(prefix);
  if (!canonicalPrefix) {
    throw new Error(`Invalid section prefix ${prefix}`);
  }

  const urls = new Set<string>([canonicalPrefix]);

  for (const match of sitemapXml.matchAll(/<loc>(?<url>[^<]+)<\/loc>/gu)) {
    const canonical = canonicalizeDocUrl(match.groups?.url ?? "");
    if (
      canonical &&
      isUnderPrefix(canonical, canonicalPrefix) &&
      matchesNamePrefixes(canonical, namePrefixes, canonicalPrefix)
    ) {
      urls.add(canonical);
    }
  }

  return urls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeReactRouterData(encoded: unknown): unknown {
  if (!Array.isArray(encoded)) {
    throw new TypeError("Expected React Router data array");
  }

  const decodeValue = (value: unknown, seen: ReadonlySet<number>): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => decodeIndex(entry, seen));
    }

    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key.startsWith("_"))
          .map(([key, entry]) => [
            String(decodeIndex(Number(key.slice(1)), seen)),
            decodeIndex(entry, seen),
          ]),
      );
    }

    return value;
  };

  const decodeIndex = (entry: unknown, seen: ReadonlySet<number>): unknown => {
    if (typeof entry !== "number") {
      return entry;
    }
    if (entry < 0) {
      return undefined;
    }
    if (seen.has(entry)) {
      return undefined;
    }
    return decodeValue(encoded[entry], new Set([...seen, entry]));
  };

  return decodeIndex(0, new Set());
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function readWebhookTopicExamples(
  value: unknown,
): readonly WebhookTopicExample[] | undefined {
  return Array.isArray(value)
    ? value.filter(isRecord).map((example) => ({
        title: readString(example.title),
        description: readString(example.description),
        tabs: Array.isArray(example.tabs)
          ? example.tabs.filter(isRecord).map((tab) => ({
              title: readString(tab.title),
              code: readString(tab.code),
            }))
          : undefined,
      }))
    : undefined;
}

function readWebhookTopics(decoded: unknown): readonly WebhookTopic[] {
  const root = readRecord(decoded, "decoded webhooks data root");
  const landing = readRecord(
    readRecord(root["templated-landing-webhooks"], "webhooks route").data,
    "webhooks route data",
  );
  const topics = readRecord(
    readRecord(landing.eventTopicsTypeDefinitions, "webhooks topic definitions")
      .WebhookTopics,
    "WebhookTopics",
  ).members;

  if (!Array.isArray(topics)) {
    throw new TypeError("Expected WebhookTopics members");
  }

  return topics.filter(isRecord).flatMap((topic) => {
    const name = readString(topic.name);
    return name
      ? [
          {
            name,
            description: readString(topic.description),
            isOptional: readBoolean(topic.isOptional),
            availableOn: readStringArray(topic.availableOn),
            relatedResource: readString(topic.relatedResource),
            webhooksNotices: readStringArray(topic.webhooksNotices),
            examples: readWebhookTopicExamples(topic.examples),
          },
        ]
      : [];
  });
}

function toWebhookTopicDocUrl(docUrl: string, topicName: string): string {
  return `${docUrl}/topics/${topicName}`;
}

function renderWebhookTopicsMarkdown(
  docUrl: string,
  dataUrl: string,
  topics: readonly WebhookTopic[],
): string {
  return `${[
    "---",
    "title: Webhooks",
    "description: The list of all webhook topics you can subscribe to.",
    "api_name: webhooks",
    `source_url: ${docUrl}`,
    `data_url: ${dataUrl}`,
    "---",
    "",
    "# Webhooks",
    "",
    "The list of all webhook topics you can subscribe to.",
    "",
    "## List of topics",
    "",
    ...topics.map(
      (topic) =>
        `- [${topic.name}](${toWebhookTopicDocUrl(docUrl, topic.name)})`,
    ),
  ].join("\n")}\n`;
}

function renderWebhookTopicMarkdown(
  docUrl: string,
  dataUrl: string,
  topic: WebhookTopic,
): string {
  return `${[
    "---",
    `title: ${JSON.stringify(topic.name)}`,
    `description: ${JSON.stringify(topic.description ?? "")}`,
    "api_name: webhooks",
    `source_url: ${docUrl}`,
    `data_url: ${dataUrl}`,
    "---",
    "",
    `# ${topic.name}`,
    "",
    topic.description ?? "",
    "",
    ...(topic.availableOn?.length
      ? [`- Available on: ${topic.availableOn.join(", ")}`]
      : []),
    ...(topic.relatedResource
      ? [`- Related resource: ${topic.relatedResource}`]
      : []),
    ...(topic.isOptional === undefined
      ? []
      : [`- Optional: ${topic.isOptional ? "yes" : "no"}`]),
    ...(topic.webhooksNotices?.length
      ? ["", "## Notices", "", ...topic.webhooksNotices]
      : []),
    ...(topic.examples?.length
      ? [
          "",
          "## Examples",
          "",
          ...topic.examples.flatMap((example) => [
            ...(example.title ? [`### ${example.title}`, ""] : []),
            ...(example.description ? [example.description, ""] : []),
            ...(example.tabs ?? []).flatMap((tab) => [
              ...(tab.title ? [`#### ${tab.title}`, ""] : []),
              "```json",
              tab.code ?? "",
              "```",
              "",
            ]),
          ]),
        ]
      : []),
  ].join("\n")}\n`;
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
    Effect.mapError(
      (cause) => new ShopifyDocsError({ message: `Failed ${url}`, cause }),
    ),
  );

const requestText = (url: string) =>
  request(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.mapError((cause) =>
      cause instanceof ShopifyDocsError
        ? cause
        : new ShopifyDocsError({ message: `Failed ${url}`, cause }),
    ),
  );

const requestBytes = (url: string) =>
  request(url).pipe(
    Effect.flatMap((response) => response.arrayBuffer),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError((cause) =>
      cause instanceof ShopifyDocsError
        ? cause
        : new ShopifyDocsError({ message: `Failed ${url}`, cause }),
    ),
  );

const fetchSitemapXml = requestBytes(SITEMAP_URL).pipe(
  Effect.flatMap((bytes) =>
    Effect.try({
      try: () => zlib.gunzipSync(Buffer.from(bytes)).toString("utf8"),
      catch: (cause) =>
        new ShopifyDocsError({ message: "Failed to gunzip sitemap", cause }),
    }),
  ),
);

function toLocalPath(staging: string, docUrl: string, path: Path.Path): string {
  const { pathname } = new URL(docUrl);
  return path.join(
    staging,
    `${pathname === "/" ? "index" : pathname.slice(1)}.md`,
  );
}

const persist = (localPath: string, content: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      Path.Path.pipe(
        Effect.flatMap((path) =>
          fs
            .makeDirectory(path.dirname(localPath), { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(localPath, content))),
        ),
      ),
    ),
    Effect.mapError(
      (cause) =>
        new ShopifyDocsError({
          message: `Failed to write ${localPath}`,
          cause,
        }),
    ),
  );

const buildSitemapTasks = (
  section: DocSection,
  source: SectionSource,
  sitemapXml: string,
) =>
  Effect.try({
    try: () =>
      [...collectSitemapUrls(sitemapXml, source.prefix, source.namePrefixes)]
        .toSorted()
        .map((docUrl): DocTask => ({ kind: "Markdown", section, docUrl })),
    catch: (cause) =>
      new ShopifyDocsError({
        message: `Failed to collect ${section}/${source.label}`,
        cause,
      }),
  });

const buildWebhookTasks = (section: DocSection, source: SectionSource) =>
  Effect.gen(function* () {
    const canonicalPrefix = canonicalizeDocUrl(source.prefix);
    if (!canonicalPrefix) {
      return yield* Effect.fail(
        new ShopifyDocsError({
          message: `Invalid webhooks data prefix ${source.prefix}`,
        }),
      );
    }
    const dataUrl = `${canonicalPrefix}.data`;
    const raw = yield* requestText(dataUrl);
    const topics = yield* Effect.try({
      try: () => readWebhookTopics(decodeReactRouterData(JSON.parse(raw))),
      catch: (cause) =>
        new ShopifyDocsError({
          message: `Failed to decode webhooks data ${dataUrl}`,
          cause,
        }),
    });
    yield* Console.log(
      `collecting ${section}/${source.label} topics=${String(topics.length)}`,
    );
    return [
      {
        kind: "Webhook",
        section,
        docUrl: canonicalPrefix,
        content: renderWebhookTopicsMarkdown(canonicalPrefix, dataUrl, topics),
      },
      ...topics.map((topic): DocTask => ({
        kind: "Webhook",
        section,
        docUrl: toWebhookTopicDocUrl(canonicalPrefix, topic.name),
        content: renderWebhookTopicMarkdown(canonicalPrefix, dataUrl, topic),
      })),
    ] satisfies readonly DocTask[];
  });

const runTask = (staging: string, task: DocTask) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const content =
      task.kind === "Markdown"
        ? yield* requestText(`${task.docUrl}.md`)
        : task.content;
    yield* persist(toLocalPath(staging, task.docUrl, path), content);
    return task.section;
  }).pipe(
    Effect.catch((error) =>
      Console.error(
        `failed ${task.section} ${task.docUrl}: ${error.message}`,
      ).pipe(Effect.as(null)),
    ),
  );

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

/**
 * Image URLs worth localizing: Shopify's own hosts only, so third-party embeds keep
 * their absolute URL rather than getting fetched from someone else's server.
 */
const IMAGE_URL_RE =
  /https:\/\/(?:shopify\.dev|shopify-assets\.shopifycdn\.com|cdn\.shopify\.com)\/[^\s)"'<>\\]+\.(?:png|jpe?g|gif|svg|webp)/gu;

/**
 * Download the images the fetched markdown references into `_assets/` and rewrite the
 * links relative to each file. The `.md` endpoints reference images absolutely, so
 * without this the ref has no local images at all. A failed download logs and leaves
 * that link absolute -- a missing figure should not fail the whole fetch.
 */
const localizeImages = Effect.fn(function* (staging: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const files = (yield* allFiles(staging)).filter((f) => f.endsWith(".md"));
  const urls = new Set<string>();
  for (const file of files)
    for (const [url] of (yield* fs.readFileString(file)).matchAll(IMAGE_URL_RE))
      urls.add(url);
  if (urls.size === 0) return;

  const assetsDir = path.join(staging, "_assets");
  yield* fs.makeDirectory(assetsDir, { recursive: true });

  // Names are assigned up front (uniqueName mutates its set), then the downloads run
  // concurrently; a failure drops the URL from the map so its links stay absolute.
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const url of urls)
    names.set(
      url,
      uniqueName(
        decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""),
        used,
      ),
    );

  const results = yield* Effect.forEach(
    [...names],
    ([url, name]) =>
      requestBytes(url).pipe(
        Effect.flatMap((bytes) =>
          fs.writeFile(path.join(assetsDir, name), bytes),
        ),
        Effect.as(url),
        Effect.catch((error) =>
          Console.error(`image failed ${url}: ${error.message}`).pipe(
            Effect.andThen(() => {
              names.delete(url);
              return Effect.succeed(null);
            }),
          ),
        ),
      ),
    { concurrency: CONCURRENCY },
  );

  for (const file of files) {
    const before = yield* fs.readFileString(file);
    const after = before.replaceAll(IMAGE_URL_RE, (url) => {
      const name = names.get(url);
      return name === undefined
        ? url
        : path
            .relative(path.dirname(file), path.join(assetsDir, name))
            .replaceAll("\\", "/");
    });
    if (after !== before) yield* fs.writeFileString(file, after);
  }
  yield* Console.log(
    `images: ${String(results.filter((r) => r !== null).length)}/${String(urls.size)} localized to _assets/`,
  );
});

/** Mirror the configured doc sections into `staging` as markdown with local images. */
export const downloadInto = (staging: string) =>
  Effect.gen(function* () {
    const sitemapXml = yield* fetchSitemapXml;

    const tasks: DocTask[] = [];
    const seen = new Set<string>();
    for (const section of DEFAULT_SECTIONS) {
      for (const source of SECTION_SOURCES[section]) {
        const sourceTasks =
          source.kind === "sitemap-prefix"
            ? yield* buildSitemapTasks(section, source, sitemapXml)
            : yield* buildWebhookTasks(section, source);
        yield* Console.log(
          `collecting ${section}/${source.label} urls=${String(sourceTasks.length)}`,
        );
        for (const task of sourceTasks)
          if (!seen.has(task.docUrl)) {
            seen.add(task.docUrl);
            tasks.push(task);
          }
      }
    }

    const results = yield* Effect.forEach(
      tasks,
      (task) => runTask(staging, task),
      {
        concurrency: CONCURRENCY,
      },
    );
    const saved = results.filter((r) => r !== null).length;
    const failed = results.length - saved;
    yield* Console.log(
      `pages: ${String(saved)}/${String(results.length)} saved`,
    );
    yield* localizeImages(staging);
    if (failed > 0) {
      yield* Effect.fail(
        new ShopifyDocsError({
          message: `${String(failed)} page(s) failed to fetch`,
        }),
      );
    }
  }).pipe(Effect.provide(FetchHttpClient.layer));
