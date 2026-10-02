/**
 * The files whose strings are screen copy, shared by `scripts/rules-lint.ts`
 * (the retired-word check) and `scripts/copy-audit.ts` (the inventory), so
 * the two read the same screens. The vocabulary's screen rule
 * (`src/lib/Domain.ts`) says which: the merchant's and the member's screens,
 * `src/components/`, and the modules that hold their copy. The operator
 * console (`admin.*`), the API routes (`api.*`), and the public home and
 * privacy pages (`index.tsx`, `privacy.tsx`) are not vocabulary screens, and
 * neither is `PlanCache.tsx`, a component only the console renders.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SRC = new URL("../../src/", import.meta.url).pathname;

export const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });

export const copyFiles = (): readonly string[] => [
  ...walk(join(SRC, "routes")).filter(
    (path) =>
      !/\/routes\/(?:admin\.|api\.|index\.tsx$|privacy\.tsx$)/u.test(path) &&
      !path.endsWith("routeTree.gen.ts"),
  ),
  ...walk(join(SRC, "components")).filter(
    (path) => !path.endsWith("PlanCache.tsx"),
  ),
  ...[
    "useMemberRunActions.ts",
    "changeWarning.ts",
    "workflowShared.ts",
    "workflowsListStates.ts",
  ].map((name) => join(SRC, "lib", name)),
];
