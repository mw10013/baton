# `shopify.web.toml` conflict from `refs/` — research

```
Validation error in shopify.web.toml:
You can only have one "web" configuration file with the backend role in your app.
Conflicting configurations found at:
  /Users/mw/Documents/src/baton/refs/bang/shopify.web.toml
  /Users/mw/Documents/src/baton/shopify.web.toml
```

CLI: **4.7.0**, the current `latest`, installed via the `shopify/shopify` homebrew tap (`brew info shopify-cli` → "Installed (on request)", `/opt/homebrew/bin/shopify`). Nothing is installed globally through npm — keep it that way: an `npx @shopify/cli@<older>` run will auto-run `npm install -g @shopify/cli@latest` behind your back, and `~/.local/bin` precedes `/opt/homebrew/bin` on PATH, so the npm copy silently shadows brew's. (That happened once during this research and was uninstalled.)

`refs/shopify-cli` is pinned to 4.7.0 in `scripts/refs.ts`, i.e. the exact source of the binary on this laptop; every behaviour below was verified by running that binary against this repo, and the excerpts are from the matching source.

## TL;DR

bang _did_ solve this, and the fix is **`web_directories = ["."]` in the app configs that are NOT the active one** (`shopify.app.staging.toml`, `shopify.app.production.toml`) while `shopify.app.toml` stays untouched. That is not a style choice — it is load-bearing, and it is the only reason bang works. Putting `["."]` in the active config (baton's single `shopify.app.toml`) suppresses the error but **loads zero webs**, so `shopify app dev` would start no dev process at all.

baton has only one app config, which is exactly why it can't reproduce bang's fix as-is.

## Mechanism

Two separate steps, and the fix exploits the gap between them.

**1. Discovery is project-wide and uses the union of every app config's `web_directories`.**
`refs/shopify-cli/packages/app/src/cli/models/project/project.ts:66-74`

```ts
const allWebDirs = new Set<string>();
for (const appConfig of appConfigFiles) {
  const dirs = appConfig.content.web_directories;
  if (Array.isArray(dirs))
    for (const dir of dirs) allWebDirs.add(dir as string);
}
const webConfigFiles = await discoverWebFiles(
  directory,
  allWebDirs.size > 0 ? [...allWebDirs] : undefined,
  errors,
);
```

`project.ts:202`:

```ts
const dirs = webDirectories ?? ["**"];
const patterns = dirs.map((dir) => joinPath(directory, dir, WEB_TOML));
patterns.push(`!${joinPath(directory, NODE_MODULES_EXCLUDE)}`);
const paths = await glob(patterns);
```

- `glob` is fast-glob (`cli-kit/src/public/node/fs.ts:580`) with default options → **follows symlinks**, ignores `.gitignore`.
- baton's `refs` is a symlink (`refs -> ../tanstack-cloudflare-effect-shopify-app/refs`) and `refs/bang` is a full checkout of the private `mw10013/bang` app (`scripts/refs.ts:156`) with a root `shopify.web.toml` (`roles = ["frontend","backend"]`).
- With **no** `web_directories` anywhere, the default is `**` → both files found → `validateWebs` errors (`loader.ts:588-598`). Confirmed with fast-glob directly:
  `bang → [bang/shopify.web.toml, bang/refs/bang/..., bang/refs/motio/...]`, `baton → [baton/shopify.web.toml, baton/refs/bang/...]`.
- With **any** app config declaring `["."]`, discovery globs `<root>/./shopify.web.toml` → `joinPath` normalizes → only the root file is discovered. `refs/**` is never seen. **This is what kills the error.**

**2. The active config then filters that list again — and `"."` fails the filter.**
`config-selection.ts:99-113`

```ts
const globPatterns = (configDirs as string[]).map(
  (dir) => `${dir}/shopify.web.toml`,
);
return project.webConfigFiles.filter((file) => {
  const relPath = relativePath(project.directory, file.path).replace(
    /\\/g,
    "/",
  );
  return globPatterns.some((pattern) => matchGlob(relPath, pattern));
});
```

Raw string concat, no `joinPath`. `matchGlob` is minimatch (pinned `9.0.9`, `cli-kit/package.json:149`) and `minimatch("shopify.web.toml", "./shopify.web.toml") === false` (verified on 9.0.9 and 3.1.2). But the filter runs **only when the active config itself declares `web_directories`** — otherwise it returns `project.webConfigFiles` untouched (`config-selection.ts:100-103`).

So: `["."]` in a _sibling_ config narrows discovery; the active config, silent on `web_directories`, keeps everything discovery found. Error gone, web intact.

## Verified behaviour (real CLI runs against this repo)

`shopify app info` prints DIRECTORY COMPONENTS from `app.webs` (`services/info.ts:201`), so an empty section means zero webs loaded. `shopify app build` with a temporary `build = "echo WEB_BUILD_RAN"` in `shopify.web.toml` was used as a second, independent probe. All edits reverted; `git status` clean.

| Setup (CLI 4.7.0)                                                                                              | Conflict error | Web loaded                                                         |
| -------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| baton, no `web_directories`                                                                                    | **yes**        | —                                                                  |
| baton, `web_directories = ["."]` in the only/active config                                                     | no             | **NO** (empty DIRECTORY COMPONENTS; `WEB_BUILD_RAN` never printed) |
| baton, `refs/bang/shopify.web.toml` renamed away                                                               | no             | yes                                                                |
| baton, web toml moved to `web/` + `web_directories = ["web"]`                                                  | no             | yes                                                                |
| **baton + a second config (`shopify.app.staging.toml`) carrying `["."]`, active `shopify.app.toml` untouched** | no             | **yes** — `📂 baton /`                                             |
| bang, `shopify app info` (active = `shopify.app.production.toml`, has `["."]`)                                 | no             | no webs (filter drops it)                                          |
| bang, `shopify app info --config shopify.app.toml` (no `web_directories`)                                      | no             | yes — `📂 bang /` + all extensions                                 |

Repos carrying the trick today: `bang/shopify.app.staging.toml:8`, `bang/shopify.app.production.toml:9`, `motio/shopify.app.staging.toml:9`, `tanstack-cloudflare-effect-shopify-qr/shopify.app.staging.toml:7` — never in a `shopify.app.toml`.

## The `["."]`-in-the-active-config regression

`web_directories` was added in CLI **3.27.0** (`refs/shopify-cli/packages/app/CHANGELOG.md:1988`) and used to work in the obvious way. Bisected with `npx @shopify/cli@<v> app info` on baton with `["."]` in the only config:

| CLI                            | released   | web loaded with `["."]` in the only config |
| ------------------------------ | ---------- | ------------------------------------------ |
| 3.90.0                         | 2026-01-29 | yes                                        |
| 3.92.0                         | 2026-03-11 | yes                                        |
| 3.94.0                         | 2026-04-24 | **no**                                     |
| 3.94.3 / 4.2.0 / 4.5.2 / 4.7.0 | —          | **no**                                     |

The `Project` + `config-selection` layer (which added the second, `joinPath`-less filter) landed between 3.92.0 and 3.94.0. bang was scaffolded 2026-05-02, i.e. already on the broken side — its configs survive only because the `["."]` sits in non-active files.

## Why it keeps coming back in baton

- `bang` has no `optIn` flag in `scripts/refs.ts`, so **`pnpm refs:all` refetches it** and `refs/bang/shopify.web.toml` returns.
- baton's `refs` symlink points at `../tanstack-cloudflare-effect-shopify-app/refs`, which is shared, so the file reappears there too.
- baton has exactly one app config, so there is nowhere to park a non-active `["."]` — the bang shape was never ported over.

## Applied fix

`shopify.app.staging.toml` — a **skeleton** staging config modelled on `refs/bang/shopify.app.staging.toml`, carrying `web_directories = ["."]`. `shopify.app.toml` is untouched.

It rides the union in step 1 (discovery narrows to the repo root, `refs/**` unseen) while the active config stays free of `web_directories`, so step 2's filter never runs.

Deliberately not deployable until staging exists: `client_id = ""` and empty URLs mean `--config staging` is treated as unlinked and stops at `app config link` (verified — it errors in a non-interactive shell and writes nothing), so it cannot push at the wrong app.

Verified after the change: `shopify app info --config shopify.app.toml` → no error, `📂 baton /`; `shopify app build` → `baton-local built!`.

## Other options

1. **Port bang's shape: add `shopify.app.staging.toml` / `shopify.app.production.toml` with `web_directories = ["."]`, leave `shopify.app.toml` alone.** Verified working in baton (table above). Zero changes to the dev layout, matches the sibling repos, and baton is already growing env-aware deploy/tail tooling (`d6169d7`). Caveat: it only holds while the active config stays free of `web_directories`; a `shopify app config link`/`deploy` that writes `web_directories` into `shopify.app.toml` would silently zero out the webs again.
2. **Move `shopify.web.toml` into `web/` and set `web_directories = ["web"]`.** Verified working with a single config and with `refs/bang` present — a real subdirectory passes both discovery and the minimatch filter. Cost: `commands.dev`/`commands.build` run from the config file's directory, so `pnpm dev` needs `--dir ..` (or `cd ..`) and the env plumbing comments move with it.
3. **Don't leave a second app's `shopify.web.toml` under `refs/`** (drop the bang ref, rename it on fetch, or keep refs outside the app root). Effective but the ref is wanted as-is.
4. `web_directories = ["."]` **in the active config** — do not; that is the silent-zero-webs trap.

## Upstream

- [Shopify/cli#6472](https://github.com/shopify/cli/issues/6472) — "CLI shouldn't read all TOML files in the project", same error from git workspaces. Closed by [PR #6529](https://github.com/Shopify/cli/pull/6529) (merged 2025-10-23), which only **improved the error message** (that's the "Conflicting configurations found at:" list we see) — the discovery behaviour was not changed.
- [Shopify/cli#3702](https://github.com/Shopify/cli/issues/3702) — asks for `.gitignore` globs to be honoured during web discovery (sst.dev copying `shopify.web.toml` into `.sst/`). Closed stale, no maintainer fix; reporter's workaround was deleting the offending directory before running the CLI.
- Docs acknowledge the symlink case: `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md:90` — "To explicitly specify the folders where Shopify CLI should look for `shopify.web.toml` files, **and to avoid files being loaded twice due to symlinks**, use the `web_directories` variable". `app-configuration.md:118` documents the field.
- Worth reporting: `webFilesForConfig` should normalize the directory (or match joined paths) so `web_directories = ["."]` in the active config behaves like discovery does, instead of yielding a valid-looking config with zero webs.
