// Checks and prints the spec: the action matrices in src/lib/Domain.ts (the
// JSDoc on `runActions` and `taskActions`), which the test reads as the spec,
// and the data-model tables on `initializeSchema` in
// src/lib/ShopAgentSchema.ts (the object) and on `D1_TABLES` in
// src/lib/D1Schema.ts (D1).
//
//   node scripts/spec.ts check   parse both action tables, refuse overlapping rows, check the glossary, its screen columns and its Screens table, parse both data-model tables and refuse a pinned title no test carries (exit 1 on any failure)
//   node scripts/spec.ts print   render the parsed rows and how many fixtures each expands to, then the data-model rows

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Result } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { globSync, readdirSync, readFileSync } from "node:fs";

import * as Domain from "../src/lib/Domain.ts";
import * as ActionTable from "./lib/spec.ts";

const DOMAIN = new URL("../src/lib/Domain.ts", import.meta.url).pathname;
const ROUTES = new URL("../src/routes/", import.meta.url).pathname;
const SCHEMA = new URL("../src/lib/ShopAgentSchema.ts", import.meta.url)
  .pathname;
const D1_SCHEMA = new URL("../src/lib/D1Schema.ts", import.meta.url).pathname;
const ROOT = new URL("../", import.meta.url).pathname;
const NAMES: readonly ActionTable.TableName[] = ["runActions", "taskActions"];

const SCREEN_LABELS: ActionTable.ScreenLabels = {
  taskStates: Domain.TASK_STATE_LABEL,
  runStates: Domain.RUN_STATE_LABEL,
  workflowStates: Domain.WORKFLOW_STATE_LABEL,
  productionStates: Domain.PRODUCTION_STATE_LABEL,
  orderIssues: Domain.ORDER_ISSUE_LABEL,
  verbs: Domain.VERB_LABEL,
};

const readSource = Effect.sync(() => readFileSync(DOMAIN, "utf8"));

/** Each data-model table: its symbol, its source, and the table names its `about` may use. */
const readDataModels = Effect.sync(() => {
  const schemaSource = readFileSync(SCHEMA, "utf8");
  const d1Source = readFileSync(D1_SCHEMA, "utf8");
  return [
    {
      source: schemaSource,
      options: {
        symbol: "initializeSchema",
        tables: ActionTable.tablesDeclared(schemaSource),
      },
    },
    {
      source: d1Source,
      options: {
        symbol: "D1_TABLES",
        tables: ActionTable.tablesNamed(d1Source, [
          "D1_TABLES",
          "BETTER_AUTH_TABLES",
        ]),
      },
    },
  ] as const;
});

const readTestSources = Effect.sync(() =>
  Object.fromEntries(
    globSync("test/**/*.test.ts", { cwd: ROOT }).map((file) => [
      file,
      readFileSync(`${ROOT}${file}`, "utf8"),
    ]),
  ),
);

const readRouteFiles = Effect.sync(() =>
  Object.fromEntries(
    readdirSync(ROUTES).map((file) => [
      file,
      readFileSync(`${ROUTES}${file}`, "utf8"),
    ]),
  ),
);

const checkCommand = Command.make(
  "check",
  {},
  Effect.fn(function* () {
    const source = yield* readSource;
    const routeFiles = yield* readRouteFiles;
    const dataModels = yield* readDataModels;
    const testSources = yield* readTestSources;
    const failures = [
      ...NAMES.flatMap((name) =>
        Result.match(ActionTable.parse(source, name), {
          onFailure: (error) => [error.message],
          onSuccess: (rows) =>
            ActionTable.overlaps(name, rows).map(
              ([a, b]) =>
                `${name}, lines ${String(a.line)} and ${String(b.line)}: rows share a fixture`,
            ),
        }),
      ),
      ...ActionTable.checkGlossary(source).map(
        (word) =>
          `Glossary: \`${word}\` does not occur in src/lib/Domain.ts outside the glossary`,
      ),
      ...ActionTable.checkScreenColumns(source, SCREEN_LABELS),
      ...ActionTable.checkScreens(source, routeFiles),
      ...dataModels.flatMap(({ source, options }) =>
        Result.match(ActionTable.parseDataModel(source, options), {
          onFailure: (error) => [error.message],
          onSuccess: (rows) =>
            ActionTable.checkPinned(rows, testSources, options.symbol),
        }),
      ),
    ];
    for (const failure of failures) yield* Console.error(failure);
    if (failures.length > 0)
      yield* new CliError.UserError({
        cause: "spec",
        userMessage: `${String(failures.length)} spec failure(s)`,
      });
  }),
).pipe(
  Command.withDescription(
    "Parse the action tables in Domain.ts, check the glossary, and check the data-model tables in ShopAgentSchema.ts and D1Schema.ts; exit 1 on any failure",
  ),
);

const printCommand = Command.make(
  "print",
  {},
  Effect.fn(function* () {
    const source = yield* readSource;
    for (const name of NAMES) {
      yield* Console.log(name);
      const lines = Result.match(ActionTable.parse(source, name), {
        onFailure: (error) => [error.message],
        onSuccess: (rows) =>
          rows.map(
            (row) =>
              `[${String(ActionTable.expand(name, row, { teamId: "t", blocker: "b" }).length)}] ${ActionTable.renderRow(name, row)}`,
          ),
      });
      for (const line of lines) yield* Console.log(`  ${line}`);
    }
    for (const { source: dataModel, options } of yield* readDataModels) {
      yield* Console.log(options.symbol);
      const rows = Result.match(
        ActionTable.parseDataModel(dataModel, options),
        {
          onFailure: (error) => [error.message],
          onSuccess: (rows) =>
            rows.map(
              (row) =>
                `${row.about}: ${row.rule} [${row.holdsBy}] — ${row.pinnedBy}`,
            ),
        },
      );
      for (const line of rows) yield* Console.log(`  ${line}`);
    }
  }),
).pipe(
  Command.withDescription(
    "Render the parsed action tables and their fixture counts, then the data-model rows",
  ),
);

const specCommand = Command.make("spec").pipe(
  Command.withDescription(
    "The action matrices in src/lib/Domain.ts and the data-model tables in src/lib/ShopAgentSchema.ts and src/lib/D1Schema.ts",
  ),
  Command.withSubcommands([checkCommand, printCommand]),
);

NodeRuntime.runMain(
  specCommand.pipe(
    Command.run({ version: "0.0.0" }),
    Effect.provide(NodeServices.layer),
  ),
);
