// Downloads reference sources into refs/, pinned to the versions this workspace
// actually depends on. Each entry names where the pin lives, so a dependency bump
// is the only edit needed -- re-running the fetch picks up the new tag.
//
//   node scripts/refs.ts fetch <name...>   fetch those refs
//   node scripts/refs.ts fetch --all       fetch every ref except the opt-in ones
//   node scripts/refs.ts check             report refs that drifted from the pins (exit 1 if any)
//   node scripts/refs.ts list              same report, without exiting non-zero
//
// Ported from ableton-extension-prelive's scripts/refs.ts, minus its site-crawl and
// Fluid Topics machinery (no baton ref needs a crawl; shopify.dev serves first-party
// markdown -- see docs/refs-tooling-research.md while it lasts, or refs-shopify-docs.ts).

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Path, Result, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
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
  if (!(ref.repo ?? ref.npm))
    return yield* new RefsError({ reason: `${ref.name} needs a repo, an npm package, or shopifyDocs` });
  return yield* downloadInto(staging, ref, target);
});

/** How a ref without a package.json pin gets its content, for the fetch's first line. */
const sourceKind = (ref: Ref) => {
  if (ref.shopifyDocs) return "docs";
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
      url: ref.shopifyDocs ? ShopifyDocs.ORIGIN : undefined,
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
      // No resolved version means a branch, pin, or docs ref, whose target names itself
      // rather than a package.json pin, so age is the only thing left to report.
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
